# Troubleshooting Guide

SG/OpenClaw 보안 랩 환경에서 자주 겪는 문제와 해결 방법입니다.

---

## 1. WebSocket 연결 문제

### "pairing required" 오류

**증상**: `GwSession.connect` 호출 시 `{"ok": false, "error": {"code": "pairing_required"}}` 응답.

**원인 및 해결**:

| 원인 | 해결 |
|------|------|
| 기기 승인이 안 된 상태 | `openclaw devices list` → `openclaw devices approve --latest` |
| `OPENCLAW_GATEWAY_SCOPES`가 기기 승인 범위보다 넓음 | 스코프를 줄이거나 기기 재승인 |
| 로컬 게이트웨이를 HTTP 프록시 경유 접속 | `OPENCLAW_GATEWAY_WS_USE_SYSTEM_PROXY=0` 설정 |

```bash
# 기기 승인 흐름
openclaw devices list
openclaw devices approve --latest
# 또는 특정 requestId 지정:
openclaw devices approve --id <requestId>
```

---

### "missing operator.read scope" / 빈 구독 응답

**증상**: `sessions.messages.subscribe` RPC가 빈 이벤트 스트림을 반환하거나 오류 발생.

**원인**: 공유 토큰에 `operator.read` 스코프가 없음.

**해결**: `OPENCLAW_DEVICE_IDENTITY_PATH`에 `device.json` 경로를 지정하면 기기 서명과 함께 `operator.read`가 자동 유지됩니다.

```bash
export OPENCLAW_DEVICE_IDENTITY_PATH=~/.openclaw/identity/device.json
```

---

### WebSocket 연결이 자꾸 끊김 (재연결 루프)

`ingest.py`는 연결 끊김 시 자동으로 지수 백오프(기본 5 → 10 → 20 … 최대 120초) 재연결을 시도합니다.

- 재연결 횟수 제한: `SENTINEL_RECONNECT_MAX` (기본 0 = 무제한)
- 초기 대기 시간 변경: `SENTINEL_RECONNECT_DELAY_S` (기본 5초)

재연결 로그는 `trace.jsonl`에 `entry_type: "meta"` 행으로 기록됩니다.

---

## 2. Sentinel 파이프라인 문제

### trace.jsonl이 생성되지 않음

1. `OPENCLAW_GATEWAY_WS_URL`, `OPENCLAW_GATEWAY_TOKEN`이 설정되었는지 확인
2. `PYTHONPATH=scripts` 가 설정되었는지 확인
3. `scripts/sentinel/data/` 디렉터리 쓰기 권한 확인

```bash
PYTHONPATH=scripts python scripts/sentinel/ingest.py --ws-url wss://... --token ...
```

---

### detect.py가 findings를 반환하지 않음

**확인 순서**:

1. `trace.jsonl`에 행이 있는지 확인 (`wc -l scripts/sentinel/data/trace.jsonl`)
2. `tools.effective` 스냅샷이 trace에 있는지 확인 (`grep tools_snapshot scripts/sentinel/data/trace.jsonl`)
3. `rules/` 디렉터리에 `.yaml` 파일이 있는지 확인
4. `baseline-tools-effective.example.json`을 실제 환경에 맞게 업데이트했는지 확인

```bash
# 수동 실행 (verbose)
PYTHONPATH=scripts python scripts/sentinel/detect.py \
  --trace scripts/sentinel/data/trace.jsonl \
  --rules-dir scripts/sentinel/rules \
  --baseline scripts/sentinel/data/baseline-tools-effective.example.json
```

---

### 웹훅 알림이 전달되지 않음

`respond.py`는 실패 시 최대 3번 재시도(지수 백오프 2s, 4s)합니다. 그래도 실패하면:

1. `SENTINEL_FINDINGS_WEBHOOK_URL` 값이 올바른지 확인
2. 대상 서버가 `POST application/json`을 받는지 확인
3. `httpx`가 설치되어 있는지: `pip install -r scripts/requirements.txt`

---

### trace.jsonl이 너무 커짐

`SENTINEL_TRACE_MAX_MB` 환경 변수로 최대 크기를 설정하면 초과 시 `.jsonl.old`로 자동 로테이션됩니다.

```bash
export SENTINEL_TRACE_MAX_MB=100   # 100 MB 초과 시 로테이션
```

기본값은 50 MB입니다. 무제한으로 쓰려면 `SENTINEL_TRACE_MAX_MB=0`으로 설정하세요.

---

## 3. security-viz 대시보드 문제

### "이 제어 API는 Vite 개발 서버에서만 제공됩니다" 메시지

Sentinel 시작/중지, detect 실행, sessions.abort, tools-diff 기능은 **`npm run dev`** 실행 시에만 작동합니다. 프로덕션 빌드(`vite build` + 정적 서빙)에서는 터미널 CLI를 사용하세요.

```bash
# 대시보드 개발 서버 시작
cd security-viz && npm run dev
# 또는
./run-viz.sh
```

---

### SSE findings 스트림 연결 오류

1. `python scripts/sentinel/findings_dev_server.py`가 실행 중인지 확인 (기본 포트 8787)
2. 개발 서버의 proxy 설정에 `/sentinel-api` → `http://127.0.0.1:8787`가 매핑되어 있는지 확인

SSE 대신 폴링 모드를 사용하려면 대시보드의 "SSE stream" 체크박스를 해제하세요.

---

### sessions.abort 버튼이 "실패" 반환

1. `wsUrl`, `token`, `sessionKey` 세 필드가 모두 입력되었는지 확인 (대시보드 상단 "세션 · 타임라인" 탭에서 입력)
2. 토큰에 `operator.admin` 또는 `operator.write` 스코프가 있는지 확인
3. 지정한 세션 키가 활성 세션인지 확인

---

### tools.effective 베이스라인 diff가 "차이 없음"인데 이상함

1. ingest를 먼저 실행했는지 확인 (`trace.jsonl`에 `tools_snapshot` 행이 있어야 함)
2. `baseline-tools-effective.example.json`이 실제 환경을 반영하는지 확인 (예시 파일이 그대로면 `exec`, `read_file` 등만 포함)

실제 환경에 맞는 베이스라인을 생성하려면:
```bash
PYTHONPATH=scripts python scripts/sentinel/ingest.py --duration-s 5 ...
# trace.jsonl에서 tools_snapshot 행을 꺼내 baseline.json 생성
```

---

## 4. 시크릿 redaction

`SENTINEL_REDACT_SECRETS=1`(기본값)로 설정하면 `ingest.py`가 trace에 쓰기 전에 다음 패턴을 `***REDACTED***`로 치환합니다:

- `api_key: <value>` / `"api_key": "<value>"`
- `password: <value>`
- `Bearer <token>`
- AWS Access Key ID (`AKIA...`)
- PEM 개인 키 블록

redaction을 비활성화하려면: `SENTINEL_REDACT_SECRETS=0`

> **주의**: redaction이 활성화되어 있어도 모든 시크릿을 완벽히 차단하지는 않습니다. 민감한 환경에서는 `SENTINEL_TRACE_INCLUDE_RAW=0`으로 원본 프레임 저장 자체를 꺼주세요.

---

## 5. 테스트 실행

### Python 단위 테스트

```bash
# venv 사용
.venv/bin/pip install pytest pyyaml
.venv/bin/pytest scripts/tests/ -v
```

### React 컴포넌트 테스트

```bash
cd security-viz
npm test
# 또는 watch 모드
npm run test:watch
```
