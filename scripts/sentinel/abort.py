#!/usr/bin/env python3
"""
sessions.abort 직접 호출 — 대시보드 긴급 중단 버튼용.

환경 변수:
  OPENCLAW_GATEWAY_WS_URL   (필수)
  OPENCLAW_GATEWAY_TOKEN    (필수)
  OPENCLAW_GATEWAY_SESSION_KEY (필수)
  OPENCLAW_GATEWAY_SCOPES   — 기본 operator.admin,operator.write,operator.read
"""

from __future__ import annotations

import asyncio
import json
import os
import sys
from pathlib import Path

SCRIPTS_DIR = Path(__file__).resolve().parents[1]
if str(SCRIPTS_DIR) not in sys.path:
    sys.path.insert(0, str(SCRIPTS_DIR))

from openclaw_ws import GwSession, MissingGatewayEnvError, load_gateway_env, parse_scopes_env  # noqa: E402


async def _abort(ws_url: str, token: str, session_key: str, scopes: list[str]) -> dict:
    sess = await GwSession.connect(ws_url, token=token, scopes=scopes)
    try:
        params = {"key": session_key, "sessionKey": session_key}
        return await sess.rpc("sessions.abort", params, timeout_s=60.0)
    finally:
        await sess.close()


def main() -> None:
    try:
        env = load_gateway_env(require_session=True)
    except MissingGatewayEnvError as e:
        raise SystemExit(", ".join(e.missing) + " are required.") from None

    scopes = parse_scopes_env(
        os.environ.get("OPENCLAW_GATEWAY_SCOPES"),
        ["operator.admin", "operator.write", "operator.read"],
    )
    res = asyncio.run(_abort(env.ws_url, env.token, env.session_key, scopes))
    print(json.dumps(res, ensure_ascii=False, indent=2))
    if not res.get("ok"):
        raise SystemExit(1)


if __name__ == "__main__":
    main()
