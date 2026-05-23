#!/usr/bin/env python3
"""
config.get 또는 tools.catalog를 게이트웨이에서 조회합니다.

환경 변수:
  OPENCLAW_GATEWAY_WS_URL  (필수)
  OPENCLAW_GATEWAY_TOKEN   (필수)
  POLICY_METHOD            config.get | tools.catalog (기본: config.get)
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

from openclaw_ws import GwSession, MissingGatewayEnvError, load_gateway_env  # noqa: E402


async def _query(ws_url: str, token: str, method: str) -> dict:
    try:
        sess = await GwSession.connect(
            ws_url,
            token=token,
            client_id="gateway-client",
            client_mode="backend",
            scopes=["operator.read"],
        )
        try:
            result = await sess.rpc(method, {}, timeout_s=15.0)
        finally:
            await sess.close()

        if not isinstance(result, dict):
            return {"ok": False, "message": "invalid gateway rpc response"}
        if not result.get("ok"):
            err = result.get("error") or {}
            if isinstance(err, dict):
                msg = err.get("message") or err.get("code") or json.dumps(err, ensure_ascii=False)
            else:
                msg = str(err)
            return {"ok": False, "message": str(msg)}

        # 게이트웨이 v3: res 프레임 전체가 아니라 비즈니스 payload만 넘긴다.
        # (UI는 tools.catalog 의 groups 등 최상위 필드를 기대함)
        return {"ok": True, "payload": result.get("payload")}
    except Exception as e:
        return {"ok": False, "message": str(e)}


def main() -> None:
    try:
        env = load_gateway_env()
    except MissingGatewayEnvError as e:
        print(json.dumps({"ok": False, "message": f"{', '.join(e.missing)} required"}))
        sys.exit(1)

    method = os.environ.get("POLICY_METHOD", "config.get").strip()
    if method not in ("config.get", "tools.catalog"):
        print(json.dumps({"ok": False, "message": f"unsupported method: {method}"}))
        sys.exit(1)

    result = asyncio.run(_query(env.ws_url, env.token, method))
    print(json.dumps(result, ensure_ascii=False))
    if not result.get("ok"):
        sys.exit(1)


if __name__ == "__main__":
    main()
