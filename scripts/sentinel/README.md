# Sentinel

- `ingest.py` — 게이트웨이 WS 구독·이벤트 정규화·`data/trace.jsonl` append-only.
  실행 중 `RealTimeRateDetector`(`detect.py` 내 클래스)가 `rules/api_abuse.yaml`을
  로드해 도구 호출 속도·반복을 실시간 감시하고, 임계치 초과 시 `sessions.abort` 호출.
- `detect.py` — `RealTimeRateDetector` 클래스 정의. (batch 모드 자동 실행은 비활성화됨.)
- `respond.py` — 알림·`data/findings-latest.json`·선택 웹훅·(옵션) `sessions.abort`.

## 탐지 룰 (`rules/*.yaml`)

| 파일 | 카테고리 | 비고 |
|------|----------|------|
| `md_signatures.yaml` | 악성 MD 탐지 | `chat_stream.py`가 파일 읽기 사전 검사 시 로드. Vigil 포팅 규칙 |
| `api_abuse.yaml` | API Abuse 탐지 | `ingest.py`의 `RealTimeRateDetector`가 로드 |

악성 플러그인 탐지는 별도 YAML 룰 대신 **화이트리스트**(`data/baseline-tools-effective.example.json`) 기반.
`chat_stream.py`가 도구 호출마다 이름을 화이트리스트와 대조해 외부 도구이면 즉시 차단(`ruleId: whitelist-violation`).

악성 MD 탐지 룰은 오픈소스 [deadbits/vigil-llm](https://github.com/deadbits/vigil-llm)(Apache-2.0)의
YARA 룰을 정규식으로 포팅한 것이다.
