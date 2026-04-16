# Sentinel

- `ingest.py` — 게이트웨이 WS 구독·이벤트 정규화·`data/trace.jsonl` append
- `detect.py` — `rules/*.yaml` 및 스냅샷 diff
- `respond.py` — 탐지 후 알림·(옵션) `sessions.abort` 등 연산자 RPC; 오탐 방지 가드는 `docs/sentinel.md`에 정의
