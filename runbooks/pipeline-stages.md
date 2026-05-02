---
kind: runbook
runbook_id: pipeline-stages
title: 관측 파이프라인 5단계 (Phase 1)
---

# 관측 파이프라인 5단계

OpenClaw 게이트웨이가 제공하는 **WebSocket 이벤트**와 팀이 정한 **설정 스냅샷**만으로 S1을 검증한다. 코어 포크 수정 없이, Sentinel·수동 로그로 증거를 남긴다.

## 1. 의도 및 입력

- **시나리오:** [../scenarios/s1-plugin-supply-chain.md](../scenarios/s1-plugin-supply-chain.md) (S1).
- **모드:** [Guardrail vs Direct](../docs/guardrail-vs-direct.md) 중 하나를 명시한다. Direct는 **운영 금지**·랩 전용이다.
- **추론:** [../docs/test-bed-dgx-spark.md](../docs/test-bed-dgx-spark.md)에 따라 **DGX Spark** 엔드포인트·모델 id를 사용한다.
- **입력:** 고정 프롬프트(수동 채팅 또는 [../scripts/runner/send_scenario.py](../scripts/runner/send_scenario.py))를 런북 실행 기록에 붙인다.

## 2. 가드레일 검사

- 실행 전·후 `config.get` 등 **허용 스냅샷**을 저장한다(비밀 값은 마스킹).
- **Guardrail 기대:** 플러그인 툴이 `tools.effective`에서 제외되거나, 호출 시 승인 대기·거부가 난다.
- **Direct 기대(교육용):** 플러그인 툴이 effective에 노출될 수 있음을 문서화하고, 동일 입력과 대비한다.

## 3. 도구 수명주기

- 설치 전후 `tools.catalog` / `tools.effective`를 덤프해 `source: plugin`·`pluginId`·툴 이름 증분을 캡처한다.
- 세션 중 `session.tool` 페이로드(이름, 인자 메타, 승인 상태)를 JSONL 등으로 남긴다. 게이트웨이가 노출하지 않는 필드는 “미노출”로 표기한다.

## 4. 로그 수집

| 산출물 | 용도 |
|--------|------|
| 게이트웨이 WS 캡처(선택) | 원시 이벤트 재생 |
| `scripts/sentinel/ingest.py` → `trace.jsonl` | 정규화된 타임라인 |
| `scripts/sentinel/detect.py` / `respond.py` | 규칙 발화·알림(옵션 RPC는 정책에 따름) |

체크리스트: 타임스탬프, 세션 id, 시나리오 id(S1), 모드(Guardrail/Direct), 모델 id(문서 placeholder만).

## 5. 위험 요약

- [risk-rubric.md](risk-rubric.md)의 **Likelihood×Impact** 격자와 **STRIDE** 태그로 요약한다.
- **S1 KPI 예시:** (a) 플러그인 툴 신규 등록 건수, (b) 미승인 `session.tool` 호출 시도 건수, (c) 차단/승인 대기로 인한 중단 건수.
- 차단·거부가 있었다면 **사유 문자열**(게이트웨이가 제공할 때)을 인용한다.

## 참고

- 목표·범위: [../docs/goals.md](../docs/goals.md)
- QA 매트릭스: [../docs/qa-matrix.md](../docs/qa-matrix.md)
