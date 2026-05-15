# Sentinel

- `ingest.py` — 게이트웨이 WS 구독·이벤트 정규화·`data/trace.jsonl` append-only
- `detect.py` — `rules/*.yaml`, `trace.jsonl`, `tools.effective` 베이스라인 diff → findings JSON
- `respond.py` — 탐지 후 stderr 알림·`data/findings-latest.json`(viz)·선택 웹훅·(옵션) `sessions.abort`

## 탐지 룰 (`rules/*.yaml`)

| 파일 | 시나리오 | 룰 개수 | 비고 |
|------|----------|---------|------|
| `s1_supply_chain.yaml` | S1 악성 플러그인 | 11 | tools.effective 베이스라인 diff 기반 |
| `s2_data_leakage.yaml` | S2 프롬프트 인젝션 | 9 | 자체 5 + Vigil 포팅 4 |
| `s3_api_abuse.yaml` | S3 API Abuse | 3 | rate-limit / loop-detect |

S2의 일반 프롬프트 인젝션 패턴(우회 지시, 시스템 토큰, markdown 데이터 유출, Guidance 토큰)은
오픈소스 [deadbits/vigil-llm](https://github.com/deadbits/vigil-llm)(Apache-2.0)의 YARA 룰을
정규식으로 포팅한 것이다. `s2_data_leakage.yaml`의 `s2-vigil-*` ID로 식별된다.
