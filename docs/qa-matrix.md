# QA 매트릭스 (Phase 1)

S1 시나리오를 **추론 백엔드 DGX Spark**에 고정하고, **Guardrail**과 **Direct** 두 프리셋으로 각각 한 번씩 실행해 관측이 계획과 일치하는지 확인한다. S2/S3는 `../scenarios/catalog.yaml`에서 `planned`이므로, 활성화 시 아래 표에 **열·행을 추가**한다.

## 매트릭스

| 시나리오 | 모드 | 추론 | 주입 방식 | 산출물(필수) | 비고 |
|----------|------|------|-----------|----------------|------|
| S1 | Guardrail | DGX Spark | 수동 채팅 **또는** `python scripts/runner/send_scenario.py` | `tools.*` 덤프, `trace.jsonl`, 위험 격자 기록 | 차단·승인 대기 기대 |
| S1 | Direct | DGX Spark | 동일 | 동일 | **운영 금지**; 랩에서만 |

## 실행 체크리스트 (셀마다)

1. [ ] [test-bed-dgx-spark.md](test-bed-dgx-spark.md) 검증 커맨드로 DGX·게이트웨이 추론 경로 확인.
2. [ ] `openclaw plugins install ./mock-malicious-plugin` (SG 루트) 후 게이트웨이 재시작.
3. [ ] 모드에 맞는 OpenClaw 설정(Guardrail/Direct) 적용·스냅샷 저장.
4. [ ] 고정 프롬프트 실행(수동 또는 runner).
5. [ ] [../runbooks/pipeline-stages.md](../runbooks/pipeline-stages.md) 5단계에 따라 로그·위험 요약 작성.
6. [ ] [../runbooks/risk-rubric.md](../runbooks/risk-rubric.md) KPI(S1) 숫자 채움.

## 감사·로그 최소 세트

| 파일/스트림 | 목적 |
|-------------|------|
| `tools.catalog` / `tools.effective` JSON 덤프 | 플러그인 툴 증분 |
| `scripts/sentinel/data/trace.jsonl` (또는 팀 경로) | WS 정규화 타임라인 |
| `detect` / `respond` 콘솔·파일 출력 | 규칙 id·타임스탬프 |

## S2/S3 확장 가이드

- `catalog.yaml`에서 해당 시나리오를 `active`로 바꾸고 MD SSOT를 추가한다.
- 본 표에 행을 추가하고, [risk-rubric.md](../runbooks/risk-rubric.md)에 KPI 표를 확장한다.
- `python -m scripts.validate_scenario_md`가 CI에서 통과해야 한다.
