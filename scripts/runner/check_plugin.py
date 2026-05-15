#!/usr/bin/env python3
"""
tools.catalog를 조회해서 시나리오에 필요한 플러그인 도구가 설치됐는지 확인합니다.

환경 변수:
  OPENCLAW_GATEWAY_WS_URL  (필수)
  OPENCLAW_GATEWAY_TOKEN   (필수)
  CHECK_TOOL_NAMES         쉼표로 구분된 확인할 도구 이름 목록
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

from openclaw_ws import GwSession  # noqa: E402

DEFAULT_S1_TOOLS = ["ai_image_gen", "ai_model_check"]


def _extract_tool_names(obj: object) -> set[str]:
    found: set[str] = set()

    def walk(x: object) -> None:
        if isinstance(x, dict):
            for key in ("name", "toolName", "id", "fullName"):
                v = x.get(key)
                if isinstance(v, str) and v.strip():
                    found.add(v.strip())
            for v in x.values():
                walk(v)
        elif isinstance(x, list):
            for item in x:
                walk(item)

    walk(obj)
    return found


async def _check(ws_url: str, token: str, tool_names: list[str]) -> dict:
    try:
        sess = await GwSession.connect(
            ws_url,
            token=token,
            client_id="gateway-client",
            client_mode="backend",
            scopes=["operator.read"],
        )
        try:
            result = await sess.rpc("tools.catalog", {}, timeout_s=15.0)
        finally:
            await sess.close()

        all_tools = _extract_tool_names(result)
        found = [t for t in tool_names if t in all_tools]
        missing = [t for t in tool_names if t not in all_tools]

        return {
            "ok": True,
            "installed": len(missing) == 0,
            "foundTools": found,
            "missingTools": missing,
        }
    except Exception as e:
        return {"ok": False, "installed": False, "message": str(e), "foundTools": [], "missingTools": tool_names}


def main() -> None:
    ws_url = os.environ.get("OPENCLAW_GATEWAY_WS_URL", "").strip()
    token = os.environ.get("OPENCLAW_GATEWAY_TOKEN", "").strip()

    if not ws_url or not token:
        print(json.dumps({"ok": False, "message": "OPENCLAW_GATEWAY_WS_URL, OPENCLAW_GATEWAY_TOKEN required"}))
        sys.exit(1)

    raw = os.environ.get("CHECK_TOOL_NAMES", "").strip()
    tool_names = [t.strip() for t in raw.split(",") if t.strip()] if raw else DEFAULT_S1_TOOLS

    result = asyncio.run(_check(ws_url, token, tool_names))
    print(json.dumps(result, ensure_ascii=False))
    if not result.get("ok") or not result.get("installed"):
        sys.exit(1)


if __name__ == "__main__":
    main()
