# End to End AI Agent 보안 가시화 (COONTEC Co., Ltd.)

<p align="center">
  <img src="photo/chitoclaw1.png" alt="치토와 치토클로 — 야구장 액션 비주얼" width="49%" />
  <img src="photo/chitoclaw2.png" alt="치토와 치토클로 — 키 프레젠트 비주얼" width="49%" />
</p>

---

## 목차

1. [OpenClaw (대상 에이전트)](#openclaw-대상-에이전트)
2. [문서와 SSOT](#문서와-ssot)
3. [빠른 시작](#빠른-시작)
4. [팀원 실행 가이드](#팀원-실행-가이드)
5. [구성 요약](#구성-요약)
6. [테스트](#테스트)

---

## OpenClaw (대상 에이전트)

🦞 Personal AI Assistant · [github.com/openclaw/openclaw](https://github.com/openclaw/openclaw)

OpenClaw는 LLM을 기반으로 실제 작업을 수행하는 오픈소스 AI Autonomous Agent입니다.

| 영역 | 설명 |
|------|------|
| 추론·의사결정 | 다양한 LLM을 활용합니다. |
| 도구 실행 | LLM이 선택한 **tool**로 셸 명령, API 호출 등을 자동 수행합니다. |
| 메모리 | 실행 행동이 **Memory**에 쌓여 **컨텍스트**를 유지하고, 장기·복잡 작업을 이어 갑니다. |

에이전트가 툴로 작업을 진행하기 때문에, **오판이나 악의적 지시**로 인해 시스템 손상·보안 위협이 생길 수 있습니다. 이 저장소는 OpenClaw 게이트웨이를 대상으로 **추적(trace)·규칙 기반 탐지(findings)·읽기 전용 가시화**를 묶은 보안 데모/MVP입니다.

---

## 문서와 SSOT

| 문서 | 용도 |
|------|------|
| [docs/test-bed-dgx-spark.md](docs/test-bed-dgx-spark.md) | **NVIDIA DGX Spark** 등에서 게이트웨이 연결·검증 |
| [docs/sentinel.md](docs/sentinel.md) | Python Sentinel 정책, 오탐, `sessions.abort` 가드 |
| [docs/goals.md](docs/goals.md) | 목표·범위 |
| [docs/troubleshooting.md](docs/troubleshooting.md) | 자주 막히는 지점 |

시나리오 카피는 UI와 러너가 맞춥니다: `security-viz/src/scenarioRegistry.ts` ↔ `scripts/runner/send_scenario.py` (`S1_DEFAULT_MESSAGE` 주석 참고).

---

## 빠른 시작

1. **Python (Sentinel / runner)**  
   [scripts/README.md](scripts/README.md) — venv, `pip install -r scripts/requirements.txt`, `PYTHONPATH=scripts` 로 `ingest` / `detect` / `respond` / `send_scenario` 실행.

2. **대시보드 (security-viz)**  
   저장소 루트에서 `./run-viz.sh` 를 쓰면 (선택) `OPENCLAW_GATEWAY_WS_URL`·토큰이 있을 때 ingest와 Vite dev를 함께 띄웁니다. 수동으로는 `cd security-viz && npm install && npm run dev` 후 브라우저에서 연결·토큰 입력.
   S1 시나리오 카드의 `플러그인 설치` 버튼은 `workspace-utils` 설치 뒤 `plugins.allow`/`plugins.entries`를 보정하고 `openclaw gateway restart`까지 자동 수행합니다. `플러그인 제거`는 확장 디렉터리와 `entries`/`installs`/`allow`에서 해당 id를 함께 정리합니다.
   규칙 검증은 상단 `Sentinel 탐지` 탭에서 실행합니다. (Sentinel ingest는 `run-viz.sh`·터미널에서 `ingest.py`로 병행 가능.)

3. **S1 랩 플러그인**  
   [mock-malicious-plugin/README.md](mock-malicious-plugin/README.md) — 공급망 시나리오용 **랩 전용** 목업 플러그인입니다.

---

## 팀원 실행 가이드

> `dev` 브랜치 기준. 아래 순서대로 따라하면 S1·S2·S3 시나리오를 전부 실행할 수 있습니다.

### 1. 브랜치 받기

```bash
git fetch origin
git checkout dev
git pull origin dev
```

### 2. Python 의존성 설치 (최초 1회)

```bash
# 프로젝트 루트에서
pip install websockets cryptography

# 또는 venv를 사용하는 경우
python -m venv .venv
# Windows
.venv\Scripts\activate
# macOS / Linux
source .venv/bin/activate

pip install -r scripts/requirements.txt
```

### 3. OpenClaw 게이트웨이 시작

```bash
openclaw gateway start
```

> 이미 실행 중이라면 `openclaw gateway restart` 로 재시작합니다.

### 4. Gateway Token 발급

```bash
openclaw gateway token
```

출력된 토큰을 복사해 둡니다.

### 5. Vite 개발 서버 시작

```bash
cd security-viz
npm install   # 최초 1회
npm run dev
```

브라우저에서 **http://localhost:5173** 접속.

> 이미 다른 Vite 프로세스가 켜져 있으면 포트가 5174로 올라갑니다.  
> 중복 방지를 위해 재시작 전 기존 터미널에서 `Ctrl+C`로 종료하세요.

### 6. 브라우저에서 연결 설정

왼쪽 **CONNECTION PANEL** 에 아래 값을 입력하고 **Connect** 클릭:

| 항목 | 값 |
|------|----|
| WebSocket URL | `ws://127.0.0.1:18789` |
| Session Key | `agent:main:main` |
| Gateway Token | 4번에서 발급한 토큰 |

GATEWAY STATUS가 **Live Monitoring** 으로 바뀌면 준비 완료.

### 7. 시나리오 실행

**시나리오 실행** 탭에서 S1·S2·S3 카드의 **시나리오 실행** 버튼을 누릅니다.

| 시나리오 | 설명 | 비고 |
|----------|------|------|
| S1 | 악성 플러그인 공급망 공격 | 첫 실행 시 플러그인 자동 설치 |
| S2 | README Prompt Injection 데이터 유출 | — |
| S3 | API Abuse / Denial of Wallet | Guardrail ON/OFF 고급 옵션 참고 |

### 주의사항

- **정책 검사** 탭의 `정책 설정 확인` / `도구 목록 확인` 은 `~/.openclaw/identity/device.json` 이 있어야 동작합니다 (OpenClaw CLI 설치 후 페어링 완료 상태).
- `vite-plugin-sentinel.ts` 를 수정했다면 `npm run dev` 를 재시작해야 반영됩니다.

---

## 구성 요약

### 시나리오

- 디렉터리: `scenarios/`
- 카탈로그: [scenarios/catalog.yaml](scenarios/catalog.yaml)

### Python `scripts/`

| 구성요소 | 역할 |
|----------|------|
| `scripts/openclaw_ws.py` | 게이트웨이 WebSocket 클라이언트 (`connect`, RPC, 이벤트) |
| `scripts/sentinel/ingest.py` | 구독·정규화·append-only `data/trace.jsonl`, `tools.effective` / `tools.catalog` 스냅샷 |
| `scripts/sentinel/detect.py` | `rules/*.yaml`, trace, 베이스라인 diff → findings JSON |
| `scripts/sentinel/respond.py` | 알림·`findings-latest.json`, 조건부 `sessions.abort` |
| `scripts/runner/send_scenario.py` | `OPENCLAW_GATEWAY_*` 로 접속해 `chat.send` 등 시나리오 주입 |
| `scripts/runner/toggle_guardrail.py`, `check_plugin.py` | 러너 보조 스크립트 ([runner/README.md](scripts/runner/README.md)) |
| `scripts/requirements.txt` | `websockets`, PyYAML, `httpx`, `cryptography`, `pytest` |

### `security-viz/`

React/Vite: 게이트웨이 **읽기 전용** 구독, 타임라인·단계 패널, Sentinel findings 폴링·SSE.

- S1 시나리오 메시지 옵션은 단일 `권장 기본`만 사용합니다(툴 호출 경로 이탈 감소 목적).
- 실행 흐름 패널은 S1에서 `ai_image_gen` 호출 여부를 기준으로 성공 시에만 `S1 성공` 배지를 표시합니다.

---

## 테스트

```bash
cd security-viz && npm test
```

```bash
cd /path/to/SG
python3 -m venv .venv && source .venv/bin/activate   # Windows: .venv\Scripts\activate
pip install -r scripts/requirements.txt
PYTHONPATH=scripts python -m pytest scripts/tests -q
```
