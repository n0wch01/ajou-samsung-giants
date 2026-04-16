# Runner

시나리오 재현을 위해 게이트웨이 WebSocket으로 **`chat.send` 등 메시지를 주입**한다. 수동 채팅과 동일한 이벤트가 나오도록 프롬프트·세션 id를 고정한다.

- 환경 변수 예: `OPENCLAW_GATEWAY_WS_URL`, `OPENCLAW_GATEWAY_TOKEN`(팀 표준에 맞출 것)
- `send_scenario.py` — S1 등 카탈로그 기준 시나리오 한 번 실행
