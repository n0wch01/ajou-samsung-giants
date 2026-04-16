# Runner

시나리오 재현을 위해 게이트웨이 WebSocket으로 **`chat.send`(기본)** 등 메시지를 주입한다. 수동 채팅과 동일한 이벤트가 나오도록 프롬프트·세션 key를 고정한다.

## 환경 변수

- `OPENCLAW_GATEWAY_WS_URL`, `OPENCLAW_GATEWAY_TOKEN`, `OPENCLAW_GATEWAY_SESSION_KEY` — 필수
- `OPENCLAW_GATEWAY_SCOPES` — 기본 `operator.write,operator.read`
- `OPENCLAW_CHAT_METHOD` — 기본 `chat.send` (게이트웨이 버전에 맞게 조정)
- `OPENCLAW_CHAT_SEND_PARAMS_JSON` — 설정 시 `chat.send` params 전체를 직접 지정(JSON 객체)
- `OPENCLAW_SCENARIO_MESSAGE` / `SCENARIO_MESSAGE` — 프롬프트 본문(미설정 시 S1용 기본 문구)

## 실행

```bash
PYTHONPATH=scripts python scripts/runner/send_scenario.py --session-key agent:main
```
