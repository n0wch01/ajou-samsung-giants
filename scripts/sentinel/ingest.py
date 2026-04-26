#!/usr/bin/env python3
"""
게이트웨이 WebSocket 구독 → 이벤트 정규화 → append-only trace.jsonl.

환경 변수:
  OPENCLAW_GATEWAY_WS_URL   (필수)
  OPENCLAW_GATEWAY_TOKEN    (필수)
  OPENCLAW_GATEWAY_SESSION_KEY — sessions.messages.subscribe용 세션 key
  OPENCLAW_GATEWAY_SCOPES   — 쉼표 구분, 기본 operator.read
  OPENCLAW_DEVICE_IDENTITY_PATH — (선택) OpenClaw CLI ``device.json`` 경로. 미설정 시
    ``$OPENCLAW_STATE_DIR/identity/device.json``, ``~/.openclaw/identity/device.json``,
    ``~/.clawdbot/identity/device.json`` 순으로 탐색. 있으면 connect에 device 서명을 넣어
    ``operator.read`` 스코프가 유지된다(공유 토큰만 쓸 때의 missing scope 방지).
  OPENCLAW_GATEWAY_DEVICE_FAMILY — (선택) connect ``client.deviceFamily`` 및 서명 페이로드
  SENTINEL_TRACE_PATH       — 기본 <repo>/scripts/sentinel/data/trace.jsonl
  SENTINEL_TRACE_MAX_MB     — trace.jsonl 최대 크기(MB). 초과 시 .old로 로테이션. 기본 50
  SENTINEL_TRACE_INCLUDE_RAW — 1이면 원본 gateway frame 포함(용량 큼)
  SENTINEL_REDACT_SECRETS   — 0이면 redaction 비활성. 기본 1(활성)
  SENTINEL_RECONNECT_MAX    — WS 재연결 최대 횟수. 0=무제한. 기본 0
  SENTINEL_RECONNECT_DELAY_S — 재연결 초기 대기(초). 지수 백오프 적용. 기본 5
"""

from __future__ import annotations

import argparse
import asyncio
import json
import os
import re
import sys
import time
from pathlib import Path
from typing import Any

# Patterns that look like secrets — redacted before writing to trace
_SECRET_PATTERNS: list[re.Pattern[str]] = [
    # matches both YAML/config (api_key: value) and JSON ("api_key": "value") formats
    re.compile(r'(?i)(api[_-]?key\s*[:=]\s*|"api[_-]?key"\s*:\s*")[^\s"\'\\]{8,}'),
    re.compile(r'(?i)(password\s*[:=]\s*)[^\s"\']{4,}'),
    re.compile(r'(?i)(bearer\s+)[A-Za-z0-9\-._~+/]{20,}'),
    re.compile(r'AKIA[0-9A-Z]{16}'),
    re.compile(r'-----BEGIN (?:RSA |OPENSSH |)PRIVATE KEY-----.*?-----END (?:RSA |OPENSSH |)PRIVATE KEY-----', re.DOTALL),
]


def _redact_secrets(text: str) -> str:
    for pat in _SECRET_PATTERNS:
        if pat.groups:
            # Replace only the non-prefix part (keep group 1, redact the rest)
            text = pat.sub(lambda m: m.group(1) + "***REDACTED***", text)
        else:
            text = pat.sub("***REDACTED***", text)
    return text


def _maybe_redact(obj: Any, redact: bool) -> Any:
    if not redact:
        return obj
    serialized = json.dumps(obj, ensure_ascii=False)
    redacted = _redact_secrets(serialized)
    if redacted == serialized:
        return obj
    try:
        return json.loads(redacted)
    except json.JSONDecodeError:
        return obj


def _rotate_trace_if_needed(trace_path: Path, max_mb: float) -> None:
    if max_mb <= 0:
        return
    try:
        size_mb = trace_path.stat().st_size / (1024 * 1024)
    except FileNotFoundError:
        return
    if size_mb >= max_mb:
        old_path = trace_path.with_suffix(".jsonl.old")
        trace_path.rename(old_path)
        print(
            f"[sentinel-ingest] trace rotated ({size_mb:.1f} MB >= {max_mb} MB) → {old_path}",
            file=sys.stderr,
        )

SCRIPTS_DIR = Path(__file__).resolve().parents[1]
if str(SCRIPTS_DIR) not in sys.path:
    sys.path.insert(0, str(SCRIPTS_DIR))

from openclaw_ws import GwSession, parse_scopes_env, wall_time_ms  # noqa: E402


def _ingest_gateway_scopes() -> list[str]:
    """subscribe / tools.* RPCs need operator.read; merge if env omitted it."""
    scopes = parse_scopes_env(
        os.environ.get("OPENCLAW_GATEWAY_SCOPES"), ["operator.read"]
    )
    if "operator.read" not in scopes:
        return ["operator.read", *scopes]
    return scopes


def _repo_root() -> Path:
    return Path(__file__).resolve().parents[2]


def _default_trace_path() -> Path:
    return Path(__file__).resolve().parent / "data" / "trace.jsonl"


def _truthy(name: str, default: bool = False) -> bool:
    v = os.environ.get(name)
    if v is None:
        return default
    return v.strip().lower() in ("1", "true", "yes", "on")


def _normalize_gateway_event(frame: dict[str, Any]) -> dict[str, Any]:
    """UI 타임라인과 유사한 요약(민감 필드는 그대로 둠 — 랩 전용)."""
    if frame.get("type") != "event":
        return {"kind": "non-event"}
    event = str(frame.get("event") or "")
    payload = frame.get("payload")
    summary: dict[str, Any] = {"event": event, "seq": frame.get("seq")}
    if isinstance(payload, dict):
        role = payload.get("role")
        if isinstance(role, str):
            summary["role"] = role
        for key in ("name", "tool", "toolName", "status", "phase", "state"):
            v = payload.get(key)
            if isinstance(v, str):
                summary[key] = v
        text = payload.get("text") or payload.get("content") or payload.get("message")
        if isinstance(text, str):
            summary["text_preview"] = text[:400]
    if "approval" in event.lower():
        summary["kind"] = "approval"
    elif event == "session.tool" or event.startswith("session.tool."):
        summary["kind"] = "session.tool"
    elif event == "session.message":
        summary["kind"] = "session.message"
    elif event == "chat" or event.startswith("chat."):
        summary["kind"] = "chat"
    else:
        summary["kind"] = "other"
    return summary


def _trace_record(
    *,
    entry_type: str,
    frame: dict[str, Any] | None = None,
    rpc_method: str | None = None,
    session_key: str | None = None,
    include_raw: bool,
) -> dict[str, Any]:
    rec: dict[str, Any] = {
        "trace_version": 1,
        "ts_ms": wall_time_ms(),
        "entry_type": entry_type,
        "session_key": session_key,
    }
    if rpc_method:
        rec["rpc_method"] = rpc_method
    if frame is not None:
        if frame.get("type") == "event":
            rec["event_name"] = frame.get("event")
            rec["normalized"] = _normalize_gateway_event(frame)
        elif frame.get("type") == "res":
            rec["rpc_ok"] = frame.get("ok")
            err = frame.get("error")
            if err:
                rec["rpc_error"] = err
            rec["normalized"] = {"kind": "rpc_result", "ok": frame.get("ok")}
        if include_raw:
            rec["raw_frame"] = frame
    return rec


async def _run_ingest_once(
    *,
    ws_url: str,
    token: str,
    session_key: str,
    trace_path: Path,
    scopes: list[str],
    include_raw: bool,
    redact: bool,
    max_mb: float,
    snapshot_tools: bool,
    device_identity_path: str | None = None,
) -> None:
    """Single WS connection lifetime. Raises on terminal errors; caller handles reconnect."""
    trace_path.parent.mkdir(parents=True, exist_ok=True)

    def append_line(obj: dict[str, Any]) -> None:
        _rotate_trace_if_needed(trace_path, max_mb)
        obj = _maybe_redact(obj, redact)
        line = json.dumps(obj, ensure_ascii=False)
        with trace_path.open("a", encoding="utf-8") as f:
            f.write(line + "\n")
            f.flush()

    session = await GwSession.connect(
        ws_url, token=token, scopes=scopes, device_identity_path=device_identity_path
    )

    async def on_event(msg: dict[str, Any]) -> None:
        append_line(
            _trace_record(
                entry_type="gateway_event",
                frame=msg,
                session_key=session_key or None,
                include_raw=include_raw,
            )
        )

    session.on_event(on_event)

    if session_key:
        res = await session.rpc(
            "sessions.messages.subscribe", {"key": session_key}, timeout_s=60.0
        )
        append_line(
            _trace_record(
                entry_type="rpc_result",
                frame=res,
                rpc_method="sessions.messages.subscribe",
                session_key=session_key,
                include_raw=include_raw,
            )
        )
        if not res.get("ok"):
            await session.close()
            raise RuntimeError(f"sessions.messages.subscribe failed: {res.get('error')}")

    if snapshot_tools:
        for method in ("tools.effective", "tools.catalog"):
            try:
                params = {"sessionKey": session_key} if method == "tools.effective" and session_key else {}
                res = await session.rpc(method, params, timeout_s=60.0)
                synthetic = {
                    "type": "res",
                    "id": "ingest-synthetic",
                    "ok": res.get("ok"),
                    "payload": res.get("payload"),
                    "error": res.get("error"),
                }
                append_line(
                    {
                        "trace_version": 1,
                        "ts_ms": wall_time_ms(),
                        "entry_type": "tools_snapshot",
                        "rpc_method": method,
                        "session_key": session_key or None,
                        "normalized": {"kind": "tools_snapshot", "method": method},
                        **({"raw_frame": synthetic} if include_raw else {}),
                        "payload_summary": _payload_tool_count(res.get("payload")),
                    }
                )
            except Exception as e:
                append_line(
                    {
                        "trace_version": 1,
                        "ts_ms": wall_time_ms(),
                        "entry_type": "meta",
                        "message": f"{method} failed: {e}",
                    }
                )

    try:
        while True:
            await asyncio.sleep(3600.0)
    except asyncio.CancelledError:
        pass
    finally:
        await session.close()


async def _run_ingest(
    *,
    ws_url: str,
    token: str,
    session_key: str,
    trace_path: Path,
    scopes: list[str],
    include_raw: bool,
    redact: bool,
    max_mb: float,
    snapshot_tools: bool,
    device_identity_path: str | None = None,
    reconnect_max: int = 0,
    reconnect_delay_s: float = 5.0,
) -> None:
    """Reconnect loop around _run_ingest_once."""
    trace_path.parent.mkdir(parents=True, exist_ok=True)

    def meta_line(msg: str) -> None:
        line = json.dumps(
            {"trace_version": 1, "ts_ms": wall_time_ms(), "entry_type": "meta", "message": msg,
             "session_key": session_key or None},
            ensure_ascii=False,
        )
        with trace_path.open("a", encoding="utf-8") as f:
            f.write(line + "\n")
            f.flush()

    meta_line(f"sentinel ingest start (ws_url_host={ws_url.split('@')[-1][:120]})")

    attempt = 0
    delay = reconnect_delay_s
    while True:
        try:
            await _run_ingest_once(
                ws_url=ws_url,
                token=token,
                session_key=session_key,
                trace_path=trace_path,
                scopes=scopes,
                include_raw=include_raw,
                redact=redact,
                max_mb=max_mb,
                snapshot_tools=snapshot_tools,
                device_identity_path=device_identity_path,
            )
            break  # clean CancelledError exit
        except asyncio.CancelledError:
            break
        except Exception as exc:
            attempt += 1
            if reconnect_max > 0 and attempt >= reconnect_max:
                meta_line(f"sentinel ingest fatal after {attempt} attempt(s): {exc}")
                print(f"[sentinel-ingest] giving up after {attempt} attempt(s): {exc}", file=sys.stderr)
                raise
            print(
                f"[sentinel-ingest] connection lost (attempt {attempt}): {exc} — reconnecting in {delay:.0f}s",
                file=sys.stderr,
            )
            meta_line(f"connection lost (attempt {attempt}): {exc} — reconnecting in {delay:.0f}s")
            try:
                await asyncio.sleep(delay)
            except asyncio.CancelledError:
                break
            delay = min(delay * 2, 120.0)  # cap at 2 minutes

    meta_line("sentinel ingest stop")


def _payload_tool_count(payload: Any, *, cap: int = 500) -> dict[str, Any]:
    names = _extract_tool_names(payload)
    return {"tool_name_count": len(names), "tool_names": names[:cap]}


def _extract_tool_names(obj: Any) -> list[str]:
    """tools.effective / catalog 응답 형태가 버전마다 달라질 수 있어 보수적으로 수집."""
    out: list[str] = []

    def walk(x: Any) -> None:
        if isinstance(x, dict):
            for k in ("name", "tool", "toolName", "id", "fullName"):
                v = x.get(k)
                if isinstance(v, str) and v.strip():
                    out.append(v.strip())
            for v in x.values():
                walk(v)
        elif isinstance(x, list):
            for v in x:
                walk(v)

    walk(obj)
    # de-dupe preserving order
    seen: set[str] = set()
    uniq: list[str] = []
    for n in out:
        if n not in seen:
            seen.add(n)
            uniq.append(n)
    return uniq


async def _async_main(args: argparse.Namespace) -> None:
    ws_url = args.ws_url or os.environ.get("OPENCLAW_GATEWAY_WS_URL")
    token = args.token or os.environ.get("OPENCLAW_GATEWAY_TOKEN")
    session_key = args.session_key or os.environ.get("OPENCLAW_GATEWAY_SESSION_KEY", "")
    if not ws_url or not token:
        raise SystemExit(
            "OPENCLAW_GATEWAY_WS_URL and OPENCLAW_GATEWAY_TOKEN are required (or pass CLI flags)."
        )
    trace_path = Path(
        args.trace_path
        or os.environ.get("SENTINEL_TRACE_PATH")
        or str(_default_trace_path())
    )
    scopes = _ingest_gateway_scopes()
    include_raw = args.include_raw if args.include_raw is not None else _truthy(
        "SENTINEL_TRACE_INCLUDE_RAW", default=True
    )
    redact = _truthy("SENTINEL_REDACT_SECRETS", default=True)
    try:
        max_mb = float(os.environ.get("SENTINEL_TRACE_MAX_MB") or "50")
    except ValueError:
        max_mb = 50.0
    try:
        reconnect_max = int(os.environ.get("SENTINEL_RECONNECT_MAX") or "0")
    except ValueError:
        reconnect_max = 0
    try:
        reconnect_delay_s = float(os.environ.get("SENTINEL_RECONNECT_DELAY_S") or "5")
    except ValueError:
        reconnect_delay_s = 5.0

    task = asyncio.create_task(
        _run_ingest(
            ws_url=ws_url,
            token=token,
            session_key=session_key.strip(),
            trace_path=trace_path,
            scopes=scopes,
            include_raw=include_raw,
            redact=redact,
            max_mb=max_mb,
            snapshot_tools=not args.no_tools_snapshot,
            device_identity_path=args.device_identity_path,
            reconnect_max=reconnect_max,
            reconnect_delay_s=reconnect_delay_s,
        )
    )
    try:
        if args.duration_s and args.duration_s > 0:
            await asyncio.wait_for(task, timeout=args.duration_s)
        else:
            await task
    except asyncio.TimeoutError:
        task.cancel()
        try:
            await task
        except asyncio.CancelledError:
            pass


def main() -> None:
    p = argparse.ArgumentParser(description="Sentinel ingest → trace.jsonl")
    p.add_argument("--ws-url", default=None, help="Override OPENCLAW_GATEWAY_WS_URL")
    p.add_argument("--token", default=None, help="Override OPENCLAW_GATEWAY_TOKEN")
    p.add_argument("--session-key", default=None, help="Override OPENCLAW_GATEWAY_SESSION_KEY")
    p.add_argument(
        "--device-identity-path",
        default=None,
        help="Override OPENCLAW_DEVICE_IDENTITY_PATH (OpenClaw identity/device.json).",
    )
    p.add_argument("--trace-path", default=None, help="Override SENTINEL_TRACE_PATH")
    p.add_argument(
        "--duration-s",
        type=float,
        default=0.0,
        help="Stop after N seconds (0 = run until interrupted).",
    )
    p.add_argument(
        "--no-tools-snapshot",
        action="store_true",
        help="Skip tools.effective / tools.catalog RPC snapshots at start.",
    )
    p.add_argument(
        "--include-raw",
        dest="include_raw",
        action="store_true",
        default=None,
        help="Include raw gateway frames in trace (default: env or true).",
    )
    p.add_argument(
        "--omit-raw",
        dest="include_raw",
        action="store_false",
        help="Strip raw_frame from trace lines.",
    )
    args = p.parse_args()
    _ = _repo_root()
    try:
        asyncio.run(_async_main(args))
    except KeyboardInterrupt:
        pass


if __name__ == "__main__":
    main()
