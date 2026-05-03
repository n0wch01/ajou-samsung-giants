#!/usr/bin/env python3
"""
OpenClaw 게이트웨이 WebSocket으로 시나리오 메시지 주입 (기본: chat.send).

환경 변수:
  OPENCLAW_GATEWAY_WS_URL   (필수)
  OPENCLAW_GATEWAY_WS_USE_SYSTEM_PROXY — 1이면 HTTP_PROXY 등 시스템 프록시 사용(기본은 비활성; 로컬 게이트웨이는 프록시 경유 시 pairing required가 날 수 있음)
  OPENCLAW_GATEWAY_TOKEN    (필수)
  OPENCLAW_GATEWAY_SESSION_KEY — 세션 key (예: agent:main:main)
  OPENCLAW_GATEWAY_SCOPES   — 기본 operator.write,operator.read
    (device.json 사용 시 기기에 이미 승인된 스코프보다 넓으면 scope-upgrade로 pairing required →
     게이트웨이와 동일 토큰으로: openclaw devices list 후 openclaw devices approve --latest 또는 requestId 지정)
  OPENCLAW_CHAT_METHOD        — 기본 chat.send (팀 게이트웨이에 맞게 변경)
  OPENCLAW_CHAT_SEND_PARAMS_JSON — 설정 시 session/message 대신 이 JSON을 그대로 사용
  OPENCLAW_SCENARIO_MESSAGE / SCENARIO_MESSAGE — 프롬프트 본문
  OPENCLAW_RESET_SESSION_FIRST — 1이면 chat.send 전에 sessions.reset 호출 (hallucination 방지)
"""

from __future__ import annotations

import argparse
import asyncio
import json
import os
import sys
from pathlib import Path

SCRIPTS_DIR = Path(__file__).resolve().parents[1]
if str(SCRIPTS_DIR) not in sys.path:
    sys.path.insert(0, str(SCRIPTS_DIR))

from openclaw_ws import GwSession, new_req_id, parse_scopes_env  # noqa: E402

# SSOT: keep in sync with security-viz/src/scenarioRegistry.ts :: S1_DEFAULT_SCENARIO_MESSAGE
S1_DEFAULT_MESSAGE = "고양이가 해변에서 노는 이미지 만들어줘."


def _build_chat_params(session_key: str, message: str) -> dict:
    raw = os.environ.get("OPENCLAW_CHAT_SEND_PARAMS_JSON", "").strip()
    if raw:
        params = json.loads(raw)
        if not isinstance(params, dict):
            raise ValueError("OPENCLAW_CHAT_SEND_PARAMS_JSON must be a JSON object")
        return params
    # OpenClaw ChatSendParamsSchema: sessionKey, message, idempotencyKey (+ optional fields only).
    params = {
        "sessionKey": session_key,
        "message": message,
    }
    # Idempotency for side-effecting RPCs (OpenClaw gateway policy)
    params.setdefault("idempotencyKey", new_req_id())
    return params


async def _send_once(
    *,
    ws_url: str,
    token: str,
    session_key: str,
    message: str,
    chat_method: str,
    scopes: list[str],
    reset_first: bool = False,
) -> dict:
    # gateway-client + backend: loopback + shared token에서 페어링 생략(ingest와 동일).
    # cli/cli는 OpenClaw가 별도 페어링을 요구할 수 있음.
    sess = await GwSession.connect(
        ws_url,
        token=token,
        client_id="gateway-client",
        client_mode="backend",
        scopes=scopes,
    )
    try:
        if reset_first:
            # 이전 대화 히스토리로 인한 tool-call hallucination 방지
            await sess.rpc("sessions.reset", {"key": session_key, "reason": "reset"}, timeout_s=15.0)
            await asyncio.sleep(1.0)

        params = _build_chat_params(session_key, message)
        return await sess.rpc(chat_method, params, timeout_s=120.0)
    finally:
        await sess.close()


def main() -> None:
    p = argparse.ArgumentParser(description="Inject scenario prompt via gateway WebSocket")
    p.add_argument("--ws-url", default=os.environ.get("OPENCLAW_GATEWAY_WS_URL"))
    p.add_argument("--token", default=os.environ.get("OPENCLAW_GATEWAY_TOKEN"))
    p.add_argument("--session-key", default=os.environ.get("OPENCLAW_GATEWAY_SESSION_KEY"))
    p.add_argument("--scenario", default=os.environ.get("SCENARIO_ID", "S1"))
    p.add_argument("--message", default=None, help="Override scenario body")
    p.add_argument("--reset-first", action="store_true", default=False,
                   help="Reset session history before sending (prevents tool-call hallucination)")
    args = p.parse_args()

    ws_url = (args.ws_url or "").strip()
    token = (args.token or "").strip()
    session_key = (args.session_key or "").strip()
    if not ws_url or not token or not session_key:
        raise SystemExit(
            "OPENCLAW_GATEWAY_WS_URL, OPENCLAW_GATEWAY_TOKEN, OPENCLAW_GATEWAY_SESSION_KEY are required."
        )

    message = (
        (args.message or "").strip()
        or os.environ.get("OPENCLAW_SCENARIO_MESSAGE", "").strip()
        or os.environ.get("SCENARIO_MESSAGE", "").strip()
        or S1_DEFAULT_MESSAGE
    )

    chat_method = os.environ.get("OPENCLAW_CHAT_METHOD", "chat.send").strip()
    reset_first = args.reset_first or os.environ.get("OPENCLAW_RESET_SESSION_FIRST", "").strip() == "1"
    default_scopes = (
        ["operator.admin", "operator.write", "operator.read"]
        if reset_first
        else ["operator.write", "operator.read"]
    )
    scopes = parse_scopes_env(os.environ.get("OPENCLAW_GATEWAY_SCOPES"), default_scopes)

    res = asyncio.run(
        _send_once(
            ws_url=ws_url,
            token=token,
            session_key=session_key,
            message=message,
            chat_method=chat_method,
            scopes=scopes,
            reset_first=reset_first,
        )
    )
    print(json.dumps(res, ensure_ascii=False, indent=2))
    if not res.get("ok"):
        raise SystemExit(1)


if __name__ == "__main__":
    main()
