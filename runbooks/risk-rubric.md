---
kind: runbook
runbook_id: risk-rubric
title: 위험 격자 · STRIDE · 시나리오 KPI
---

# 위험 격자 · STRIDE · 시나리오 KPI

런북 [pipeline-stages.md](pipeline-stages.md) 5단계의 **위험 요약**에 사용한다. 숫자는 팀 합의 스케일(예: 1–5)로 통일한다.

## Likelihood(가능성)

| 점수 | 설명 |
|------|------|
| 1 | 거의 없음 — 재현 어렵거나 통제 강함 |
| 2 | 낮음 |
| 3 | 중간 — 조건만 맞으면 발생 |
| 4 | 높음 |
| 5 | 거의 확실 — Direct·약한 가드레일에서 반복 |

## Impact(영향)

| 점수 | 설명 |
|------|------|
| 1 | 무시 가능 — 랩 데이터만 |
| 2 | 낮음 — 일시적 불편 |
| 3 | 중간 — 비밀 일부·범위 제한 유출 |
| 4 | 높음 — 광범위 유출·서비스 중단 |
| 5 | 치명 — 장기 자격·프로덕션 침해 |

## 격자 (Likelihood × Impact)

기록 형식 예:

```text
S1 / Guardrail: L=2, I=2 → residual LOW (차단 확인)
S1 / Direct:    L=4, I=3 → residual HIGH (교육 목적; 운영 금지)
```

## STRIDE 태그

| 코드 | S1에서의 질문 |
|------|----------------|
| **S** Spoofing | 플러그인이 정상 패키지로 위장했는가 |
| **T** Tampering | 툴 목록·effective가 오염되었는가 |
| **R** Repudiation | 누가 설치·호출했는지 로그로 추적 가능한가 |
| **I** Information disclosure | 스텁/툴 인자로 민감 정보가 노출되는가 |
| **D** Denial of service | (S1 주제 아님; S3에서 확장) |
| **E** Elevation of privilege | 거부되지 않은 툴 실행으로 권한이 확대되는가 |

## 시나리오 KPI (S1)

| KPI | 측정 방법 |
|-----|-----------|
| **KPI-1 플러그인 툴 신규** | `tools.effective` 덤프 diff에서 `source: plugin` 신규 항목 수 |
| **KPI-2 session.tool 시도** | JSONL에서 `sg_lab_echo_exfil` 등 S1 툴 이름 필터 카운트 |
| **KPI-3 가드레일 차단률** | Guardrail 실행에서 거부·미포함 비율 (시도 대비) |
| **KPI-4 탐지 지연** | 설치 시각 대 첫 Sentinel finding 시각 |

S2/S3가 `../scenarios/catalog.yaml`에서 `active`로 전환되면, 본 절에 행을 **추가**해 확장한다(본문의 S1 표는 SSOT로 유지).
