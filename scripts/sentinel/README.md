# Sentinel

- `ingest.py` — 게이트웨이 WS 구독·이벤트 정규화·`data/trace.jsonl` append-only
- `detect.py` — `rules/*.yaml`, `trace.jsonl`, `tools.effective` 베이스라인 diff → findings JSON
- `respond.py` — 탐지 후 stderr 알림·`data/findings-latest.json`(viz)·선택 웹훅·(옵션) `sessions.abort`

정책·환경 변수·연산자 가드: [../../docs/sentinel.md](../../docs/sentinel.md)
