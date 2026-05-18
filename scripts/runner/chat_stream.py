#!/usr/bin/env python3
"""
구독 + chat.send + 이벤트 스트리밍.
받은 gateway 이벤트를 JSON 한 줄씩 stdout에 출력한다.
dev server /api/scenario/chat-stream 에서 실행됨.

탐지 로직 (시나리오 ID와 무관하게 항상 동작):
  - 악성 플러그인 탐지: tool 호출이 화이트리스트(baseline-tools-effective.example.json)에
    없으면 즉시 차단 + finding(ruleId="whitelist-violation").
  - 악성 MD 탐지: 파일 읽기 도구가 .md 파일을 읽으려 하면 Sentinel이 독립적으로
    파일을 읽고 Vigil 시그니처(md_signatures.yaml의 룰)와 매칭.
    high/critical/medium 일치 시 즉시 차단 + finding(ruleId="md-signature-block").
    low 일치 시 finding(ruleId="md-signature-warn") + 스트림 경고만 (차단 없음).
"""
from __future__ import annotations
import asyncio, json, os, re, sys, time as _time, uuid
from dataclasses import dataclass
from pathlib import Path
from typing import Any

SCRIPTS_DIR = Path(__file__).resolve().parents[1]
if str(SCRIPTS_DIR) not in sys.path:
    sys.path.insert(0, str(SCRIPTS_DIR))

from openclaw_ws import GwSession, new_req_id, rpc_sessions_reset  # noqa: E402

REPO_ROOT = SCRIPTS_DIR.parent
SENTINEL_DATA_DIR = SCRIPTS_DIR / "sentinel" / "data"
SENTINEL_RULES_DIR = SCRIPTS_DIR / "sentinel" / "rules"
WHITELIST_PATH = SENTINEL_DATA_DIR / "baseline-tools-effective.example.json"
MD_SIGNATURES_PATH = SENTINEL_RULES_DIR / "md_signatures.yaml"

# 파일 읽기 계열 도구 이름 패턴
_READ_TOOL_PATTERN = re.compile(r"^(read|read_file|fs[._]read|file[._]read|cat|view)$", re.IGNORECASE)


@dataclass(frozen=True)
class MdSignatureRule:
    id: str
    pattern: re.Pattern[str]
    severity: str
    title: str
    message: str
    recommended_action: str


def _load_whitelist() -> set[str]:
    """화이트리스트(baseline tool names) 로드. 파일 없으면 빈 set."""
    try:
        with WHITELIST_PATH.open("r", encoding="utf-8") as f:
            data = json.load(f)
        names = data.get("tool_names")
        if isinstance(names, list):
            return {str(n) for n in names if n}
    except Exception:
        pass
    return set()


def _load_md_signatures() -> list[MdSignatureRule]:
    """md_signatures.yaml 규칙을 로드한다."""
    sigs: list[MdSignatureRule] = []
    try:
        import yaml  # type: ignore
        with MD_SIGNATURES_PATH.open("r", encoding="utf-8") as f:
            data = yaml.safe_load(f) or {}
        for rule in data.get("rules", []):
            rid = str(rule.get("id") or "")
            if not rid:
                continue
            match = rule.get("match") or {}
            pat = match.get("pattern")
            if not pat:
                continue
            try:
                sigs.append(MdSignatureRule(
                    id=rid,
                    pattern=re.compile(str(pat), re.IGNORECASE),
                    severity=str(rule.get("severity") or "medium").lower(),
                    title=str(rule.get("title") or rid),
                    message=str(rule.get("message") or ""),
                    recommended_action=str(rule.get("recommendedAction") or ""),
                ))
            except re.error:
                continue
    except Exception:
        pass
    return sigs


def _deep_find(obj: Any, keys: tuple[str, ...], max_depth: int = 6) -> Any:
    """payload에서 주어진 키 중 하나에 해당하는 첫 값을 재귀적으로 찾는다."""
    if max_depth <= 0:
        return None
    if isinstance(obj, dict):
        for k in keys:
            if k in obj and obj[k] is not None:
                return obj[k]
        for v in obj.values():
            r = _deep_find(v, keys, max_depth - 1)
            if r is not None:
                return r
    elif isinstance(obj, list):
        for v in obj:
            r = _deep_find(v, keys, max_depth - 1)
            if r is not None:
                return r
    return None


def _extract_tool_name(payload: dict) -> str:
    """session.tool 이벤트 payload에서 도구 이름 추출."""
    val = _deep_find(payload, ("name", "toolName", "tool_name", "tool"))
    return str(val).strip() if val else ""


def _extract_file_path_from_args(payload: dict) -> str:
    """tool 인자에서 파일 경로 후보를 추출. path/file/filename/filepath 키 중 첫 값."""
    args = _deep_find(payload, ("args", "input", "arguments", "parameters", "params"))
    if not args:
        return ""
    if isinstance(args, str):
        # args가 JSON 문자열일 수도 있음
        try:
            args = json.loads(args)
        except Exception:
            return ""
    val = _deep_find(args, ("path", "file", "filename", "filepath", "file_path"))
    return str(val).strip() if val else ""


def _resolve_md_path(raw_path: str) -> Path | None:
    """파일 경로를 절대 경로로 해석. 상대 경로면 REPO_ROOT 기준."""
    if not raw_path:
        return None
    try:
        p = Path(raw_path)
        if not p.is_absolute():
            p = REPO_ROOT / p
        p = p.resolve()
        if not p.is_file():
            return None
        return p
    except Exception:
        return None


async def main() -> None:
    ws_url = os.environ["OPENCLAW_GATEWAY_WS_URL"]
    token = os.environ["OPENCLAW_GATEWAY_TOKEN"]
    session_key = os.environ["OPENCLAW_GATEWAY_SESSION_KEY"]
    message = os.environ["OPENCLAW_SCENARIO_MESSAGE"]
    timeout = float(os.environ.get("CHAT_STREAM_TIMEOUT_S", "90"))
    chat_method = os.environ.get("OPENCLAW_CHAT_METHOD", "chat.send").strip() or "chat.send"
    # 페어링 디바이스가 갖고 있지 않은 스코프를 요청하면 연결이 거부된다.
    # OPENCLAW_GATEWAY_SCOPES 환경변수가 있으면 그대로 사용, 없으면 안전 기본값.
    reset_first = os.environ.get("OPENCLAW_RESET_SESSION_FIRST", "").strip() == "1"
    request_admin = os.environ.get("OPENCLAW_REQUEST_ADMIN_SCOPE", "").strip() == "1"
    scopes_env = os.environ.get("OPENCLAW_GATEWAY_SCOPES", "").strip()
    if scopes_env:
        scopes = [s.strip() for s in scopes_env.split(",") if s.strip()]
    else:
        scopes = ["operator.admin", "operator.write", "operator.read"] if request_admin else ["operator.write", "operator.read"]

    whitelist = _load_whitelist()
    md_signatures = _load_md_signatures()
    blocked_once = False  # 한 세션에서 차단은 한 번만
    warned_md_keys: set[tuple[str, str]] = set()  # (rule_id, file_path) — low 경고 중복 방지
    realtime_findings_path = SENTINEL_DATA_DIR / "findings-realtime.jsonl"

    sess = await GwSession.connect(
        ws_url,
        token=token,
        client_id="gateway-client",
        client_mode="backend",
        scopes=scopes,
    )

    if reset_first and request_admin:
        try:
            await rpc_sessions_reset(sess, session_key, timeout_s=15.0)
        except Exception as e:
            # reset 실패는 치명적이지 않음 — 경고만 출력하고 chat.send 진행.
            print(json.dumps({"type": "warn", "message": f"sessions.reset skipped: {e}"}), flush=True)
    elif reset_first:
        # admin 스코프 없이는 reset 불가 — 알리기만 하고 계속 진행
        print(json.dumps({"type": "info", "message": "sessions.reset skipped (operator.admin scope not requested)"}), flush=True)

    done_event = asyncio.Event()
    chat_sent = False
    last_event_ts: list[float] = [0.0]
    seen_non_user_msg: list[bool] = [False]

    async def _append_finding(rule_id: str, severity: str, title: str, message: str, recommended: str) -> None:
        """findings-realtime.jsonl에 finding만 기록한다 (세션 abort 없음)."""
        finding = {
            "id": str(uuid.uuid4()),
            "ruleId": rule_id,
            "severity": severity,
            "title": title,
            "message": message,
            "recommendedAction": recommended,
            "timestamp": _time.strftime("%Y-%m-%dT%H:%M:%S", _time.gmtime()) + "Z",
        }
        try:
            realtime_findings_path.parent.mkdir(parents=True, exist_ok=True)
            with realtime_findings_path.open("a", encoding="utf-8") as f:
                f.write(json.dumps(finding, ensure_ascii=False) + "\n")
        except Exception:
            pass

    async def _write_block_finding(rule_id: str, severity: str, title: str, message: str, recommended: str) -> None:
        """findings-realtime.jsonl에 차단 finding을 즉시 기록하고 스트림을 종료한다."""
        await _append_finding(rule_id, severity, title, message, recommended)
        done_event.set()
        try:
            await sess.rpc("sessions.abort", {"key": session_key}, timeout_s=5.0)
        except Exception:
            pass

    def _check_md_signature(file_path: Path) -> MdSignatureRule | None:
        """파일 내용에 Vigil 시그니처가 일치하면 해당 규칙 반환, 아니면 None."""
        if not md_signatures:
            return None
        try:
            content = file_path.read_text(encoding="utf-8", errors="replace")
        except Exception:
            return None
        for rule in md_signatures:
            if rule.pattern.search(content):
                return rule
        return None

    async def on_event(msg: dict) -> None:
        nonlocal blocked_once
        if not chat_sent:
            return

        if not blocked_once and msg.get("event") == "session.tool":
            payload = msg.get("payload") or {}
            tool_name = _extract_tool_name(payload)

            # ① 악성 플러그인 탐지 — 화이트리스트 외 도구 호출
            if whitelist and tool_name and tool_name not in whitelist:
                blocked_once = True
                print(json.dumps(msg, ensure_ascii=False), flush=True)
                asyncio.ensure_future(_write_block_finding(
                    rule_id="whitelist-violation",
                    severity="high",
                    title="악성 플러그인 탐지 — 화이트리스트 외 도구 호출 차단",
                    message=f"화이트리스트에 없는 도구 '{tool_name}' 호출이 차단되었습니다.",
                    recommended="해당 플러그인을 제거하거나, 신뢰할 수 있는 도구라면 화이트리스트에 추가하세요.",
                ))
                return

            # ② 악성 MD 탐지 — 읽기 도구가 .md 파일을 읽으려 할 때 시그니처 사전 검사
            if md_signatures and tool_name and _READ_TOOL_PATTERN.match(tool_name):
                raw_path = _extract_file_path_from_args(payload)
                if raw_path.lower().endswith(".md"):
                    resolved = _resolve_md_path(raw_path)
                    if resolved is not None:
                        matched = _check_md_signature(resolved)
                        if matched:
                            if matched.severity == "low":
                                warn_key = (matched.id, raw_path)
                                if warn_key not in warned_md_keys:
                                    warned_md_keys.add(warn_key)
                                    print(json.dumps({
                                        "type": "warn",
                                        "ruleId": matched.id,
                                        "file": raw_path,
                                        "message": (
                                            f"파일 '{raw_path}'에서 시그니처 '{matched.id}' "
                                            f"(severity={matched.severity}) 감지 — 경고만, 차단 없음."
                                        ),
                                    }, ensure_ascii=False), flush=True)
                                    asyncio.ensure_future(_append_finding(
                                        rule_id="md-signature-warn",
                                        severity=matched.severity,
                                        title=matched.title,
                                        message=(
                                            f"파일 '{raw_path}'에서 시그니처 '{matched.id}' "
                                            f"감지 (low — 경고만, 차단 없음)."
                                        ),
                                        recommended=matched.recommended_action
                                        or "해당 IP·네트워크 참조가 의도된 것인지 검토하세요.",
                                    ))
                            else:
                                blocked_once = True
                                print(json.dumps(msg, ensure_ascii=False), flush=True)
                                asyncio.ensure_future(_write_block_finding(
                                    rule_id="md-signature-block",
                                    severity=matched.severity,
                                    title=matched.title,
                                    message=(
                                        f"파일 '{raw_path}'에서 인젝션 시그니처 "
                                        f"'{matched.id}' 감지로 차단되었습니다."
                                    ),
                                    recommended=matched.recommended_action
                                    or "신뢰할 수 없는 마크다운 문서를 에이전트에 전달하지 마세요.",
                                ))
                                return

        if done_event.is_set():
            return

        print(json.dumps(msg, ensure_ascii=False), flush=True)
        last_event_ts[0] = _time.monotonic()
        event = msg.get("event", "")
        payload = msg.get("payload") or {}

        if event == "session.message":
            msg_obj = payload.get("message")
            if isinstance(msg_obj, dict):
                role = str(msg_obj.get("role", "")).lower()
            else:
                role = str(payload.get("role", "")).lower()
            if role and role not in ("user", "human"):
                seen_non_user_msg[0] = True

        elif event == "chat":
            state = str(payload.get("state", "")).lower()
            if state in ("final", "done", "complete", "completed"):
                done_event.set()

        elif event == "agent":
            typ = str(
                payload.get("type", "") or payload.get("kind", "") or payload.get("status", "")
            ).lower()
            if typ in ("done", "completed", "final", "end", "stopped"):
                done_event.set()

    sess.on_event(on_event)

    await sess.rpc("sessions.messages.subscribe", {"key": session_key})
    await sess.rpc("sessions.subscribe", {"key": session_key})

    chat_sent = True
    last_event_ts[0] = _time.monotonic()
    params: dict = {"sessionKey": session_key, "message": message, "idempotencyKey": new_req_id()}
    try:
        await sess.rpc(chat_method, params, timeout_s=30.0)
    except Exception as e:
        print(json.dumps({"type": "error", "message": str(e)}), flush=True)
        await sess.close()
        return

    QUIESCENCE_S = 6.0
    deadline = _time.monotonic() + timeout
    while True:
        if done_event.is_set():
            break
        now = _time.monotonic()
        if now >= deadline:
            break
        if seen_non_user_msg[0] and (now - last_event_ts[0]) >= QUIESCENCE_S:
            break
        await asyncio.sleep(0.3)

    await asyncio.sleep(0.5)
    await sess.close()
    print(json.dumps({"type": "done"}), flush=True)


if __name__ == "__main__":
    asyncio.run(main())
