#!/usr/bin/env python3
"""
게이트웨이 WebSocket 구독 → 이벤트 정규화 → append-only trace.jsonl.
S3(API Abuse) 실시간 탐지를 위한 이벤트 콜백도 함께 제공한다.

환경 변수:
  OPENCLAW_GATEWAY_WS_URL   (필수)
  OPENCLAW_GATEWAY_TOKEN    (필수)
  OPENCLAW_GATEWAY_SESSION_KEY — sessions.messages.subscribe용 세션 key
  OPENCLAW_GATEWAY_SCOPES   — 쉼표 구분, 기본 operator.read
  OPENCLAW_DEVICE_IDENTITY_PATH — (선택) OpenClaw CLI device.json 경로.
    미설정 시 ~/.openclaw/identity/device.json 등 순으로 탐색.
  SENTINEL_TRACE_PATH       — 기본 <sentinel>/data/trace.jsonl
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

SCRIPTS_DIR = Path(__file__).resolve().parents[1]
if str(SCRIPTS_DIR) not in sys.path:
    sys.path.insert(0, str(SCRIPTS_DIR))

from openclaw_ws import GwSession, parse_scopes_env, wall_time_ms  # noqa: E402


# 민감 정보 패턴 — trace 기록 전 리댁션
_SECRET_PATTERNS: list[re.Pattern[str]] = [
    re.compile(r'(?i)(api[_-]?key\s*[:=]\s*|"api[_-]?key"\s*:\s*")[^\s"\'\\]{8,}'),
    re.compile(r'(?i)(password\s*[:=]\s*)[^\s"\']{4,}'),
    re.compile(r'(?i)(bearer\s+)[A-Za-z0-9\-._~+/]{20,}'),
    re.compile(r'AKIA[0-9A-Z]{16}'),
    re.compile(
        r'-----BEGIN (?:RSA |OPENSSH |)PRIVATE KEY-----.*?-----END (?:RSA |OPENSSH |)PRIVATE KEY-----',
        re.DOTALL,
    ),
]


def _redact_secrets(text: str) -> str:
    for pat in _SECRET_PATTERNS:
        if pat.groups:
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


def _default_trace_path() -> Path:
    return Path(__file__).resolve().parent / "data" / "trace.jsonl"


def _truthy(name: str, default: bool = False) -> bool:
    v = os.environ.get(name)
    if v is None:
        return default
    return v.strip().lower() in ("1", "true", "yes", "on")


def _normalize_gateway_event(frame: dict[str, Any]) -> dict[str, Any]:
    """게이트웨이 이벤트를 타임라인 표준 형식으로 정규화."""
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
    if event == "session.tool" or event.startswith("session.tool."):
        summary["kind"] = "session.tool"
    elif event == "session.message":
        summary["kind"] = "session.message"
    elif event == "chat" or event.startswith("chat."):
        summary["kind"] = "chat"
    elif "approval" in event.lower():
        summary["kind"] = "approval"
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


def _extract_tool_names(obj: Any) -> list[str]:
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
    seen: set[str] = set()
    uniq: list[str] = []
    for n in out:
        if n not in seen:
            seen.add(n)
            uniq.append(n)
    return uniq


class EventIngest:
    """
    게이트웨이 WS 이벤트를 수집하여 콜백으로 전달하고 JSONL로 저장.
    S3 실시간 탐지 파이프라인(run_scenario.py)과 독립 실행 모드 모두 지원.
    """

    def __init__(
        self,
        ws_url: str,
        auth_token: str,
        trace_path: Path,
        *,
        include_raw: bool = True,
        redact: bool = True,
        max_mb: float = 50.0,
        device_identity_path: str | None = None,
    ):
        self.ws_url = ws_url
        self.auth_token = auth_token
        self.trace_path = trace_path
        self.include_raw = include_raw
        self.redact = redact
        self.max_mb = max_mb
        self.device_identity_path = device_identity_path

        self.trace_path.parent.mkdir(parents=True, exist_ok=True)

        self._session: GwSession | None = None
        self.session_key: str = ""
        self.connected: bool = False
        self._event_callbacks: list = []

    # ── 공개 API ──────────────────────────────────────────────────────────

    def on_event(self, callback) -> None:
        """실시간 이벤트 콜백 등록. callback(normalized_event: dict) 형태."""
        self._event_callbacks.append(callback)

    async def connect(self, scopes: list[str] | None = None) -> None:
        """게이트웨이에 연결하고 인증."""
        scope_list = scopes or parse_scopes_env(
            os.environ.get("OPENCLAW_GATEWAY_SCOPES"), ["operator.read"]
        )
        if "operator.read" not in scope_list:
            scope_list = ["operator.read", *scope_list]

        self._session = await GwSession.connect(
            self.ws_url,
            token=self.auth_token,
            scopes=scope_list,
            device_identity_path=self.device_identity_path,
        )
        self.connected = True
        self._append_meta(f"sentinel ingest connected (ws={self.ws_url[:60]})")
        print(f"[ingest] 게이트웨이 연결 성공", file=sys.stderr)

    async def subscribe_session(self, session_key: str) -> None:
        """특정 세션의 이벤트 수신 구독."""
        self.session_key = session_key
        res = await self._session.rpc(
            "sessions.messages.subscribe", {"key": session_key}, timeout_s=60.0
        )
        self._append_trace_record(
            _trace_record(
                entry_type="rpc_result",
                frame={
                    "type": "res",
                    "ok": res.get("ok"),
                    "error": res.get("error"),
                },
                rpc_method="sessions.messages.subscribe",
                session_key=session_key,
                include_raw=self.include_raw,
            )
        )
        if not res.get("ok"):
            raise RuntimeError(
                f"sessions.messages.subscribe 실패: {res.get('error')}"
            )
        print(f"[ingest] 세션 구독: {session_key}", file=sys.stderr)

    async def snapshot_tools(self, session_key: str = "") -> None:
        """tools.effective / tools.catalog RPC 스냅샷을 trace에 기록."""
        for method in ("tools.effective", "tools.catalog"):
            try:
                params = {"sessionKey": session_key} if method == "tools.effective" and session_key else {}
                res = await self._session.rpc(method, params, timeout_s=60.0)
                names = _extract_tool_names(res.get("payload"))
                self._append_trace_record({
                    "trace_version": 1,
                    "ts_ms": wall_time_ms(),
                    "entry_type": "tools_snapshot",
                    "rpc_method": method,
                    "session_key": session_key or None,
                    "normalized": {"kind": "tools_snapshot", "method": method},
                    **({"raw_frame": res} if self.include_raw else {}),
                    "payload_summary": {
                        "tool_name_count": len(names),
                        "tool_names": names[:500],
                    },
                })
            except Exception as e:
                self._append_meta(f"{method} snapshot failed: {e}")

    async def listen(self) -> None:
        """이벤트 수신 루프 (GwSession 내부 reader와 병행)."""
        print("[ingest] 이벤트 수신 대기 중...", file=sys.stderr)

        async def _on_event(msg: dict[str, Any]) -> None:
            rec = _trace_record(
                entry_type="gateway_event",
                frame=msg,
                session_key=self.session_key or None,
                include_raw=self.include_raw,
            )
            rec = _maybe_redact(rec, self.redact)
            self._append_trace_record(rec)

            normalized = _normalize_gateway_event(msg)
            for cb in self._event_callbacks:
                cb(normalized)

        self._session.on_event(_on_event)

        # 루프가 종료될 때까지 대기
        try:
            while True:
                await asyncio.sleep(3600.0)
        except asyncio.CancelledError:
            pass

    async def rpc(self, method: str, params: dict | None = None) -> dict:
        """내부 RPC 호출 (respond.py의 sessions.abort 등에서 사용)."""
        return await self._session.rpc(method, params or {}, timeout_s=60.0)

    async def close(self) -> None:
        if self._session:
            await self._session.close()
            self._append_meta("sentinel ingest stop")
            print("[ingest] WS 연결 종료", file=sys.stderr)
            self._session = None
            self.connected = False

    # ── 내부 헬퍼 ─────────────────────────────────────────────────────────

    def _append_trace_record(self, rec: dict[str, Any]) -> None:
        _rotate_trace_if_needed(self.trace_path, self.max_mb)
        line = json.dumps(rec, ensure_ascii=False)
        with self.trace_path.open("a", encoding="utf-8") as f:
            f.write(line + "\n")
            f.flush()

    def _append_meta(self, msg: str) -> None:
        self._append_trace_record({
            "trace_version": 1,
            "ts_ms": wall_time_ms(),
            "entry_type": "meta",
            "message": msg,
            "session_key": self.session_key or None,
        })


# ── 독립 실행 모드 ────────────────────────────────────────────────────────

async def _run_ingest_standalone(args: argparse.Namespace) -> None:
    ws_url = args.ws_url or os.environ.get("OPENCLAW_GATEWAY_WS_URL", "")
    token = args.token or os.environ.get("OPENCLAW_GATEWAY_TOKEN", "")
    session_key = args.session_key or os.environ.get("OPENCLAW_GATEWAY_SESSION_KEY", "")
    if not ws_url or not token:
        raise SystemExit(
            "OPENCLAW_GATEWAY_WS_URL 과 OPENCLAW_GATEWAY_TOKEN 이 필요합니다."
        )
    trace_path = Path(
        args.trace_path
        or os.environ.get("SENTINEL_TRACE_PATH")
        or str(_default_trace_path())
    )
    include_raw = _truthy("SENTINEL_TRACE_INCLUDE_RAW", default=True)
    redact = _truthy("SENTINEL_REDACT_SECRETS", default=True)
    max_mb = float(os.environ.get("SENTINEL_TRACE_MAX_MB") or "50")

    ingest = EventIngest(
        ws_url, token, trace_path,
        include_raw=include_raw,
        redact=redact,
        max_mb=max_mb,
        device_identity_path=args.device_identity_path,
    )
    await ingest.connect()
    if session_key.strip():
        await ingest.subscribe_session(session_key.strip())
    if not args.no_tools_snapshot:
        await ingest.snapshot_tools(session_key.strip())

    task = asyncio.create_task(ingest.listen())
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
    finally:
        await ingest.close()


def main() -> None:
    p = argparse.ArgumentParser(description="Sentinel ingest → trace.jsonl")
    p.add_argument("--ws-url", default=None)
    p.add_argument("--token", default=None)
    p.add_argument("--session-key", default=None)
    p.add_argument("--device-identity-path", default=None)
    p.add_argument("--trace-path", default=None)
    p.add_argument("--duration-s", type=float, default=0.0)
    p.add_argument("--no-tools-snapshot", action="store_true")
    args = p.parse_args()
    try:
        asyncio.run(_run_ingest_standalone(args))
    except KeyboardInterrupt:
        pass


if __name__ == "__main__":
    main()
