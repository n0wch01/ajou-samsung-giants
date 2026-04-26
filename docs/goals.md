# 목표: OpenClaw 보안 가시화(“백신” 비유)

이 저장소(SG)의 Phase 1 목표는 **예방·완화·경고·재현**을 한 세트로 묶어, 사용자가 OpenClaw를 더 안전하게 쓰도록 돕는 것이다. 여기서 **“백신”**은 치료제가 아니라 **면역 설계**에 가깝다.

| 역할 | 무엇을 막거나 줄이는가 |
|------|------------------------|
| **예방** | 가드레일·샌드박스·최소 권한으로 공격 표면을 줄인다. |
| **완화** | 툴 승인·거부·비밀 노출 최소화로 피해를 제한한다. |
| **경고** | 게이트웨이 WebSocket 이벤트·Sentinel 규칙으로 이상 징후를 빨리 드러낸다. |
| **재현** | 시나리오(S1)·런북·로그 스키마로 같은 조건에서 다시 검증할 수 있게 한다. |

## OpenClaw 코어·포크

- **OpenClaw 업스트림 소스는 수정하지 않는다.** 툴 허용/샌드박스 **집행**은 OpenClaw 설정과 운영 정책이 담당한다.
- SG는 **관측·문서·Python Sentinel·runner·(후속) 대시보드**로 가시화와 절차를 쌓는다.

## Guardrail vs Direct

두 모드의 정의와 문서화 책임은 [guardrail-vs-direct.md](guardrail-vs-direct.md)가 SSOT다. 시나리오·런북에서는 각 실행마다 어떤 모드인지 명시하고, Direct 모드는 **운영 금지(교육·통제된 랩 전용)** 경고를 함께 적는다.

## 관련 문서

- 시나리오 S1: [../scenarios/s1-plugin-supply-chain.md](../scenarios/s1-plugin-supply-chain.md)
- 테스트 베드(DGX Spark + 게이트웨이): [test-bed-dgx-spark.md](test-bed-dgx-spark.md)
- QA 매트릭스: [qa-matrix.md](qa-matrix.md)
