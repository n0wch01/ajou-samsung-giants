# Sentinel (Phase 1)

Python **Sentinel**는 OpenClaw 게이트웨이 WebSocket을 구독해 **행위 추적(`ingest`) → 선언적 탐지(`detect`) → 대응(`respond`)** 순으로 동작한다. 코어 OpenClaw 소스는 수정하지 않으며, 관측·경고·(선택) 연산자 RPC만 다룬다. 가상환경·`PYTHONPATH`는 [../scripts/README.md](../scripts/README.md)를 본다.

## 구성 요소

| 스크립트 | 역할 |
|----------|------|
| `scripts/sentinel/ingest.py` | WS 연결, 세션 이벤트 구독, `tools.effective` / `tools.catalog` 스냅샷, **append-only** `data/trace.jsonl` |
| `scripts/sentinel/detect.py` | `rules/*.yaml` + `trace.jsonl` + (선택) **베이스라인** 대비 `tools.effective` diff |
| `scripts/sentinel/respond.py` | findings 알림, `data/findings-latest.json` 기록(security-viz 연동), 선택 웹훅, **선택** `sessions.abort` |

## 환경 변수 (공통)

- `OPENCLAW_GATEWAY_WS_URL` — 게이트웨이 WebSocket URL (예: `ws://127.0.0.1:18789`).
- `OPENCLAW_GATEWAY_TOKEN` — 연결 `connect` 시 `auth.token`.
- `OPENCLAW_GATEWAY_SESSION_KEY` — `sessions.messages.subscribe` 및 러너 `chat.send` 등에 사용하는 세션 식별자.
- `OPENCLAW_GATEWAY_SCOPES` — 쉼표 구분 스코프. ingest 기본 `operator.read`, 러너 기본 `operator.write,operator.read`.
- **`OPENCLAW_DEVICE_IDENTITY_PATH`** (선택) — OpenClaw CLI와 동일한 `identity/device.json`(PEM 키) 경로. Python `openclaw_ws`가 `connect`에 **`device` v3 서명**을 붙여 게이트웨이가 스코프를 비우지 않게 한다. 미설정이면 `$OPENCLAW_STATE_DIR/identity/device.json` → `~/.openclaw/identity/device.json` → `~/.clawdbot/identity/device.json` 순으로 존재하는 파일을 자동 사용한다. **없으면** 공유 토큰만으로 연결되어 `sessions.messages.subscribe`에서 `missing scope: operator.read`가 날 수 있다.
- `OPENCLAW_GATEWAY_DEVICE_FAMILY` (선택) — `connect`의 `client.deviceFamily` 및 서명 페이로드에 쓸 문자열.

## 오탐(false positive)과 운영 주의

- 규칙은 **정규식·스냅샷 diff** 기반이라 랩 로그·플러그인 이름·프롬프트에 따라 쉽게 울린다. **탐지 = 자동 악성 판정이 아니다.**
- `trace.jsonl`에 **민감 인자**가 포함될 수 있다. 기본은 원문 프레임을 남긴다(`SENTINEL_TRACE_INCLUDE_RAW=0`으로 요약만 저장 가능).
- `tools.effective` diff는 **베이스라인 JSON**(`SENTINEL_BASELINE_TOOLS_PATH`)이 팀의 “정상 설치”와 일치해야 한다. 의도적으로 플러그인을 추가했다면 베이스라인을 갱신한다.

## 연산자 가드: `sessions.abort` (선택 RPC)

기본적으로 **호출하지 않는다.** 다음을 **모두** 만족할 때만 `respond.py`가 `sessions.abort` RPC를 시도한다.

1. `SENTINEL_ENABLE_SESSIONS_ABORT=1`
2. `SENTINEL_SESSIONS_ABORT_CONFIRM`이 **현재 세션 key 문자열과 바이트 단위로 동일** (`OPENCLAW_GATEWAY_SESSION_KEY`와 같은 값을 권장)
3. `SENTINEL_OPERATOR_BREAK_GLASS_ACK`가 정확히 다음 문자열:  
   `I_UNDERSTAND_FALSE_POSITIVE_STOP`
4. 탐지 결과 중 최고 심각도가 `SENTINEL_ABORT_MIN_SEVERITY` 이상 (기본 `critical`)

추가로 `OPENCLAW_GATEWAY_WS_URL`·`OPENCLAW_GATEWAY_TOKEN`이 설정되어 있어야 하며, `SENTINEL_ABORT_GATEWAY_SCOPES`로 abort에 필요한 스코프(기본 `operator.admin,operator.write,operator.read`)를 조정할 수 있다.

**운영 권고:** 오탐으로 세션을 끊으면 사용자 작업이 중단된다. 먼저 알림·런북·승인 흐름만 사용하고, 자동 중단은 별도 변경 관리 절차 하에서만 켠다.

## security-viz 연동

`respond.py`는 기본적으로 `scripts/sentinel/data/findings-latest.json`에 다음 형태를 쓴다.

```json
{
  "findings": [
    {
      "id": "…",
      "ruleId": "…",
      "severity": "high",
      "title": "…",
      "message": "…",
      "recommendedAction": "…",
      "timestamp": "…"
    }
  ]
}
```

개발 서버에서 viz가 `/findings` 등으로 이 파일을 제공하도록 프록시를 두거나, `SENTINEL_FINDINGS_WEBHOOK_URL`로 소형 HTTP 서비스에 POST한다.

## 파이프라인 예시

```bash
export OPENCLAW_GATEWAY_WS_URL="ws://127.0.0.1:18789"
export OPENCLAW_GATEWAY_TOKEN="***"
export OPENCLAW_GATEWAY_SESSION_KEY="agent:main"

PYTHONPATH=. python scripts/sentinel/ingest.py --duration-s 120 --trace-path scripts/sentinel/data/trace.jsonl
PYTHONPATH=. python scripts/sentinel/detect.py \
  --trace scripts/sentinel/data/trace.jsonl \
  --baseline scripts/sentinel/data/baseline-tools-effective.example.json \
  --out scripts/sentinel/data/findings-detect.json
PYTHONPATH=. python scripts/sentinel/respond.py --input scripts/sentinel/data/findings-detect.json
```

## 러너와의 관계

`scripts/runner/send_scenario.py`는 동일 게이트웨이에 **쓰기 RPC**(`chat.send` 기본)로 시나리오 프롬프트를 넣는다. ingest는 **읽기 위주**로 같은 세션을 구독할 수 있다(동시 WS 클라이언트 허용 정책은 게이트웨이 설정을 따름).
