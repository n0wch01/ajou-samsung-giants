#!/usr/bin/env python3
"""
가드레일(gateway.tools.deny)을 켜거나 끕니다.

환경 변수:
  OPENCLAW_GATEWAY_WS_URL  (필수)
  OPENCLAW_GATEWAY_TOKEN   (필수)
  GUARDRAIL_ACTION         "on" | "off" | "status"  (기본: "status")
  GUARDRAIL_TOOL_NAMES     쉼표 구분 도구 이름 (기본: S1 도구 목록)
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

DEFAULT_DENY_TOOLS = ["util_workspace_scan", "util_data_relay", "util_env_summary"]


def _extract_deny_list(cfg: object) -> list[str]:
    """config.get 결과에서 gateway.tools.deny 배열을 추출합니다."""
    if not isinstance(cfg, dict):
        return []
    gw = cfg.get("gateway") or {}
    if not isinstance(gw, dict):
        return []
    tools = gw.get("tools") or {}
    if not isinstance(tools, dict):
        return []
    deny = tools.get("deny") or []
    if isinstance(deny, list):
        return [str(d) for d in deny if d]
    return []


async def _run(ws_url: str, token: str, action: str, tool_names: list[str]) -> dict:
    try:
        sess = await GwSession.connect(
            ws_url,
            token=token,
            client_id="gateway-client",
            client_mode="backend",
            scopes=["operator.admin"],
        )
        try:
            cfg_result = await sess.rpc("config.get", {}, timeout_s=10.0)
            current_deny = _extract_deny_list(cfg_result)
            base_hash: str | None = None
            if isinstance(cfg_result, dict):
                base_hash = cfg_result.get("_hash") or cfg_result.get("hash") or None

            if action == "status":
                return {
                    "ok": True,
                    "action": "status",
                    "denyList": current_deny,
                    "guardrailActive": len(current_deny) > 0,
                }

            new_deny = tool_names if action == "on" else []
            patch_payload: dict = {
                "raw": json.dumps({"gateway": {"tools": {"deny": new_deny}}}),
            }
            if base_hash:
                patch_payload["baseHash"] = base_hash

            patch_result = await sess.rpc("config.patch", patch_payload, timeout_s=15.0)

            return {
                "ok": True,
                "action": action,
                "denyList": new_deny,
                "guardrailActive": len(new_deny) > 0,
                "patchResult": patch_result,
            }
        finally:
            await sess.close()
    except Exception as e:
        return {"ok": False, "message": str(e)}


def main() -> None:
    ws_url = os.environ.get("OPENCLAW_GATEWAY_WS_URL", "").strip()
    token = os.environ.get("OPENCLAW_GATEWAY_TOKEN", "").strip()

    if not ws_url or not token:
        print(json.dumps({"ok": False, "message": "OPENCLAW_GATEWAY_WS_URL, OPENCLAW_GATEWAY_TOKEN required"}))
        sys.exit(1)

    action = os.environ.get("GUARDRAIL_ACTION", "status").strip().lower()
    if action not in ("on", "off", "status"):
        print(json.dumps({"ok": False, "message": f"GUARDRAIL_ACTION must be 'on', 'off', or 'status', got: {action!r}"}))
        sys.exit(1)

    raw = os.environ.get("GUARDRAIL_TOOL_NAMES", "").strip()
    tool_names = [t.strip() for t in raw.split(",") if t.strip()] if raw else DEFAULT_DENY_TOOLS

    result = asyncio.run(_run(ws_url, token, action, tool_names))
    print(json.dumps(result, ensure_ascii=False))
    if not result.get("ok"):
        sys.exit(1)


if __name__ == "__main__":
    main()
