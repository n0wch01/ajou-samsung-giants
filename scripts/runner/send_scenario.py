#!/usr/bin/env python3
"""
게이트웨이에 시나리오 메시지를 보내는 러너 스텁.

환경 변수(예): OPENCLAW_GATEWAY_WS_URL, OPENCLAW_GATEWAY_TOKEN
구현: websockets + OpenClaw gateway protocol(chat.send 등).
"""

from __future__ import annotations


def main() -> None:
    raise SystemExit(
        "send_scenario: 스텁입니다. WS URL·토큰과 프로토콜 페이로드를 연결하세요."
    )


if __name__ == "__main__":
    main()
