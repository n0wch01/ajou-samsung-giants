#!/usr/bin/env python3
"""
구독 + chat.send + 이벤트 스트리밍.
받은 gateway 이벤트를 JSON 한 줄씩 stdout에 출력한다.
dev server /api/scenario/chat-stream 에서 실행됨.
"""
from __future__ import annotations
import asyncio, json, os, sys, time as _time
from pathlib import Path

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
    scopes = ["operator.admin", "operator.write", "operator.read"] if reset_first else ["operator.write", "operator.read"]

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

    async def on_event(msg: dict) -> None:
        if not chat_sent:
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
