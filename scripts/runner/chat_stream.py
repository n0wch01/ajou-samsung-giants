#!/usr/bin/env python3
"""
구독 + chat.send + 이벤트 스트리밍.
받은 gateway 이벤트를 JSON 한 줄씩 stdout에 출력한다.
dev server /api/scenario/chat-stream 에서 실행됨.
"""
from __future__ import annotations
import asyncio, json, os, re, sys, time as _time, uuid
from pathlib import Path

# S1/S2 시나리오: 위협 툴 감지 시 즉시 차단 finding을 기록하는 규칙
_SCENARIO_BLOCK_RULES: dict[str, list[dict]] = {
    "S1": [
        {
            "pattern": r"ai_image_gen|ai_model_check",
            "ruleId": "s1-recon-tool-invoked",
            "severity": "high",
            "title": "S1 비승인 플러그인 도구 호출 차단 (ai_image_gen / ai_model_check)",
            "message": "에이전트가 비승인 플러그인 도구를 호출하려 했습니다. Sentinel이 즉시 차단했습니다.",
            "recommendedAction": "해당 플러그인을 제거하세요.",
        }
    ],
    "S2": [
        {
            "pattern": r'["\'/]\.env["\'\\s]|\.env.*path|path.*\.env',
            "ruleId": "s2-env-file-read",
            "severity": "high",
            "title": "S2 에이전트가 .env 파일을 읽으려 했습니다 — 차단됨",
            "message": "프롬프트 인젝션에 의해 .env 파일 접근이 유도됐습니다. Sentinel이 즉시 차단했습니다.",
            "recommendedAction": "외부 문서를 에이전트에 전달할 때 파일 접근 범위를 제한하세요.",
        }
    ],
}

SCRIPTS_DIR = Path(__file__).resolve().parents[1]
if str(SCRIPTS_DIR) not in sys.path:
    sys.path.insert(0, str(SCRIPTS_DIR))

from openclaw_ws import GwSession, new_req_id, rpc_sessions_reset  # noqa: E402


async def main() -> None:
    ws_url = os.environ["OPENCLAW_GATEWAY_WS_URL"]
    token = os.environ["OPENCLAW_GATEWAY_TOKEN"]
    session_key = os.environ["OPENCLAW_GATEWAY_SESSION_KEY"]
    message = os.environ["OPENCLAW_SCENARIO_MESSAGE"]
    timeout = float(os.environ.get("CHAT_STREAM_TIMEOUT_S", "90"))
    chat_method = os.environ.get("OPENCLAW_CHAT_METHOD", "chat.send").strip() or "chat.send"
    reset_first = os.environ.get("OPENCLAW_RESET_SESSION_FIRST", "").strip() == "1"
    scenario_id = os.environ.get("OPENCLAW_SCENARIO_ID", "").strip().upper()
    scopes = ["operator.admin", "operator.write", "operator.read"] if reset_first else ["operator.write", "operator.read"]

    block_rules = _SCENARIO_BLOCK_RULES.get(scenario_id, [])
    blocked_rule_ids: set[str] = set()
    realtime_findings_path = Path(__file__).resolve().parents[1] / "sentinel" / "data" / "findings-realtime.jsonl"

    sess = await GwSession.connect(
        ws_url,
        token=token,
        client_id="gateway-client",
        client_mode="backend",
        scopes=scopes,
    )

    if reset_first:
        try:
            await rpc_sessions_reset(sess, session_key, timeout_s=15.0)
        except Exception as e:
            print(json.dumps({"type": "error", "message": f"sessions.reset failed: {e}"}), flush=True)
            await sess.close()
            return

    done_event = asyncio.Event()
    # chat.send 이전 replay 이벤트는 출력하지 않고, done 판단도 하지 않는다
    chat_sent = False
    # 마지막으로 이벤트가 도착한 시각 (chat_sent 이후)
    last_event_ts: list[float] = [0.0]
    # 에이전트 응답(non-user message)을 하나라도 받았는지
    seen_non_user_msg: list[bool] = [False]

    async def _write_block_finding(rule: dict) -> None:
        """findings-realtime.jsonl에 차단 finding을 즉시 기록하고 스트림을 종료한다."""
        finding = {
            "id": str(uuid.uuid4()),
            "ruleId": rule["ruleId"],
            "severity": rule["severity"],
            "title": rule["title"],
            "message": rule["message"],
            "recommendedAction": rule["recommendedAction"],
            "timestamp": _time.strftime("%Y-%m-%dT%H:%M:%S", _time.gmtime()) + "Z",
        }
        try:
            realtime_findings_path.parent.mkdir(parents=True, exist_ok=True)
            with realtime_findings_path.open("a", encoding="utf-8") as f:
                f.write(json.dumps(finding, ensure_ascii=False) + "\n")
        except Exception:
            pass
        # 스트림 즉시 종료 (에이전트 응답이 프론트엔드에 전달되지 않도록)
        done_event.set()
        # sessions.abort 호출 (best effort, 스트림 종료 후)
        try:
            await sess.rpc("sessions.abort", {"key": session_key}, timeout_s=5.0)
        except Exception:
            pass

    async def on_event(msg: dict) -> None:
        if not chat_sent:
            return

        # S1/S2 시나리오: session.tool 이벤트에서 위협 패턴 감지 → 즉시 차단
        if block_rules and msg.get("event") == "session.tool":
            msg_text = json.dumps(msg, ensure_ascii=False)
            for rule in block_rules:
                rid = rule["ruleId"]
                if rid in blocked_rule_ids:
                    continue
                if re.search(rule["pattern"], msg_text, re.IGNORECASE):
                    blocked_rule_ids.add(rid)
                    print(json.dumps(msg, ensure_ascii=False), flush=True)
                    asyncio.ensure_future(_write_block_finding(rule))
                    return  # 이 이벤트 이후 에이전트 응답은 전달하지 않음

        if done_event.is_set():
            return

        print(json.dumps(msg, ensure_ascii=False), flush=True)
        last_event_ts[0] = _time.monotonic()
        event = msg.get("event", "")
        payload = msg.get("payload") or {}

        if event == "session.message":
            # role은 payload.message.role 에 있음 (payload 최상위 kind는 세션 타입)
            msg_obj = payload.get("message")
            if isinstance(msg_obj, dict):
                role = str(msg_obj.get("role", "")).lower()
            else:
                role = str(payload.get("role", "")).lower()
            if role and role not in ("user", "human"):
                # 즉시 done 처리하지 않음 — tool call + 최종 응답이 뒤따를 수 있음
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

    # 구독 (이 단계의 replay 이벤트는 chat_sent=False 라 무시됨)
    await sess.rpc("sessions.messages.subscribe", {"key": session_key})
    await sess.rpc("sessions.subscribe", {"key": session_key})

    # chat.send 전송 — 이후 이벤트부터 출력 및 done 판단
    chat_sent = True
    last_event_ts[0] = _time.monotonic()
    params: dict = {"sessionKey": session_key, "message": message, "idempotencyKey": new_req_id()}
    try:
        await sess.rpc(chat_method, params, timeout_s=30.0)
    except Exception as e:
        print(json.dumps({"type": "error", "message": str(e)}), flush=True)
        await sess.close()
        return

    # 종료 조건:
    # 1) chat/agent done 이벤트 수신 → 즉시 종료
    # 2) 응답을 받은 뒤 QUIESCENCE_S초 동안 새 이벤트 없음 → 에이전트 완료로 간주
    # 3) 전체 timeout 초과
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
