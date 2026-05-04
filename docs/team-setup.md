# 팀원 설정 가이드 — SG-ClawWatch 데모 실행

`hjdoh/dev` 브랜치를 pull한 후 아래 순서대로 진행하세요.

---

## 사전 요구사항

| 항목 | 확인 방법 |
|------|----------|
| Node.js 18+ | `node -v` |
| Python 3.10+ | `python3 --version` |
| OpenClaw CLI | `openclaw --version` |
| Ollama | `ollama --version` |
| glm-4.7-flash 모델 | `ollama list` → `glm-4.7-flash:latest` 확인 |

모델이 없으면:
```bash
ollama pull glm-4.7-flash
```

---

## 1단계 — 브랜치 받기

```bash
git fetch origin
git checkout hjdoh/dev
git pull origin hjdoh/dev
```

---

## 2단계 — Python 의존성 설치

저장소 루트에서 실행합니다.

```bash
# Mac/Linux/WSL
python3 -m venv .venv
source .venv/bin/activate
pip install -r scripts/requirements.txt
```

```powershell
# Windows PowerShell
python -m venv .venv
.\.venv\Scripts\Activate.ps1
pip install -r scripts\requirements.txt
```

---

## 3단계 — OpenClaw 워크스페이스 초기 설정 (최초 1회)

**Mac/Linux/WSL 터미널**에서 실행합니다.

```bash
bash scripts/setup-workspace.sh
```

이 스크립트가 자동으로 처리합니다:
- `~/.openclaw/workspace/.env` — S2 시나리오에서 유출되는 mock 자격증명 생성
- `~/.openclaw/workspace/mock-targets/readme_s2.md` — S2 prompt injection README 복사
- `ai-image-toolkit` 플러그인 설치 — S1 악성 플러그인 공급망 시나리오용

> **Windows 사용자**: WSL 터미널을 열어서 실행하세요.  
> `wsl bash scripts/setup-workspace.sh` 로도 실행 가능합니다.

---

## 4단계 — OpenClaw 게이트웨이 설정

`~/.openclaw/openclaw.json`의 agents 섹션에서 모델이 `glm-4.7-flash:latest`로 설정되어 있는지 확인합니다.

```bash
# 현재 모델 확인
cat ~/.openclaw/openclaw.json | python3 -c "import json,sys; d=json.load(sys.stdin); print(d.get('agents',{}).get('defaults',{}).get('model',{}))"
```

설정이 안 되어 있다면:
```bash
openclaw config set agents.defaults.model.primary ollama/glm-4.7-flash:latest
```

---

## 5단계 — OpenClaw 게이트웨이 시작

**Mac/Linux/WSL 터미널**에서 실행합니다.

```bash
openclaw gateway start
```

게이트웨이가 시작되면 WebSocket URL(`ws://127.0.0.1:18789`)과 토큰이 출력됩니다.

> **Windows 사용자**: WSL 터미널에서 실행하세요.

---

## 6단계 — 대시보드 실행

**Windows/Mac 터미널** 새 창에서 실행합니다.

```bash
cd security-viz
npm install        # 최초 1회
npm run dev
```

브라우저에서 `http://localhost:5173` 접속합니다.

---

## 7단계 — 대시보드 연결

브라우저에서:

1. 좌측 사이드바의 **WEBSOCKET URL** 입력란에 `ws://127.0.0.1:18789` 입력
2. **GATEWAY TOKEN** 입력란에 게이트웨이 시작 시 출력된 토큰 붙여넣기
3. **Connect** 버튼 클릭 → `Subscribed` 표시 확인
4. **Sentinel 수집** 아래 **Sentinel 시작** 버튼 클릭

---

## 8단계 — 시나리오 실행

상단 **시나리오** 탭으로 이동합니다.

### S1: 악성 플러그인 공급망 공격

1. `플러그인 설치` 버튼 클릭 (이미 설치돼 있으면 생략)
2. `S1 실행` 버튼 클릭
3. 실행 흐름에서 `ai_image_gen` 도구 호출 확인
4. 우상단 `CRITICAL` / `S1 성공` 뱃지 확인

### S2: Data Leakage (Prompt Injection)

> S1 실행 직후 실행하세요 (tool-calling context 활용).

1. `S2 실행` 버튼 클릭
2. 실행 흐름에서 `read` 도구가 두 번 호출되는 것 확인
   - 1차: `readme_s2.md` 읽기
   - 2차: `.env` 읽기 (prompt injection에 의해 유도됨)
3. 우상단 `DATA LEAK` / `S2 성공` 뱃지 확인

---

## 9단계 — Sentinel 탐지 확인

상단 **Sentinel 탐지** 탭에서:

- `지금 즉시 검사` 버튼 클릭
- S1/S2 관련 탐지 항목 확인
  - S1: 플러그인 등록, 도구 호출, 자격증명 노출 탐지
  - S2: `.env` 접근, 자격증명 유출, prompt injection 마커 탐지

---

## 문제 해결

| 증상 | 해결 방법 |
|------|----------|
| S1 실행 후 "직접 응답 (툴 호출 없음)" | S1은 세션을 자동 리셋합니다. 한 번 더 실행해보세요 |
| S2가 .env를 읽지 않음 | S1을 먼저 실행한 후 S2를 실행하세요 |
| Sentinel 한글 깨짐 | `npm run dev` 재시작 (PYTHONUTF8=1 적용 필요) |
| `python3` 없음 (Windows) | WSL 터미널 사용 또는 `python` 명령으로 시도 |
| Sentinel `9009` 오류 | `.venv/Scripts/python.exe` 확인, venv 재생성 필요 |

---

## 참고

- 게이트웨이 토큰은 `~/.openclaw/openclaw.json`의 `gateway.auth.token`에서 확인 가능
- `readme_s2.md`는 시나리오 실행 전 자동 복원되므로 수동 복원 불필요
- 상세 구조는 [docs/sentinel.md](sentinel.md) 참고
