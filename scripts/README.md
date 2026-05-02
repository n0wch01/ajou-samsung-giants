# SG `scripts/` — Sentinel · Runner

Phase 1 Python 도구 모음. 가상환경은 **저장소 루트** 또는 `scripts/` 근처 한 곳에 두면 된다.

## 가상환경

```bash
cd /path/to/SG
python3 -m venv .venv
source .venv/bin/activate
pip install -r scripts/requirements.txt
```

Windows PowerShell:

```powershell
python -m venv .venv
.\.venv\Scripts\Activate.ps1
pip install -r scripts\requirements.txt
```

## 게이트웨이 인증(Sentinel / runner)

공유 토큰(`OPENCLAW_GATEWAY_TOKEN`)만 쓰면 OpenClaw 게이트웨이가 **디바이스 신원 없이** 연결한 클라이언트의 `scopes`를 비울 수 있어, `sessions.messages.subscribe` 등이 `missing scope: operator.read`로 실패한다. **해결:** OpenClaw CLI가 쓰는 **`device.json`**을 두고(보통 `~/.openclaw/identity/device.json`), `OPENCLAW_DEVICE_IDENTITY_PATH`로 경로를 주거나 기본 탐색에 맡기면 `openclaw_ws`가 `connect`에 `device` 블록을 넣는다. `pip install -r scripts/requirements.txt`에 `cryptography`가 포함된다.

## 실행 방법

모든 스크립트는 `scripts/` 디렉터리를 `PYTHONPATH`에 올려 `openclaw_ws` 공용 모듈을 찾는다.

```bash
export PYTHONPATH=/path/to/SG/scripts
python /path/to/SG/scripts/sentinel/ingest.py --help
python /path/to/SG/scripts/sentinel/detect.py --help
python /path/to/SG/scripts/sentinel/respond.py --help
python /path/to/SG/scripts/runner/send_scenario.py --help
```

또는 SG 루트에서:

```bash
PYTHONPATH=scripts python scripts/runner/send_scenario.py --session-key agent:main
```

## 문서

- Sentinel 정책·오탐·`sessions.abort` 가드: [../docs/sentinel.md](../docs/sentinel.md)
- DGX Spark 테스트 베드: [../docs/test-bed-dgx-spark.md](../docs/test-bed-dgx-spark.md)
- 러너 개요: [runner/README.md](runner/README.md)
- Sentinel 모듈 개요: [sentinel/README.md](sentinel/README.md)

## 산출물 경로

| 경로 | 설명 |
|------|------|
| `scripts/sentinel/data/trace.jsonl` | ingest append-only 로그(gitignore) |
| `scripts/sentinel/data/findings-*.json` | detect/respond 산출(gitignore 대상) |
| `scripts/sentinel/data/baseline-tools-effective.example.json` | 베이스라인 예시(커밋됨) |
