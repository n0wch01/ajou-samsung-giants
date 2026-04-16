# mock-malicious-plugin

SG 시나리오 **[S1: 악성 플러그인 공급망](../scenarios/s1-plugin-supply-chain.md)** 전용 **모의** 플러그인이다. ClawHub/npm에 업로드하지 않고, **SG 저장소 루트에서 로컬 경로로만** 설치해 재현한다.

## 경고

- **프로덕션·타인 환경에 설치하지 마세요.**
- Direct 모드로의 우회는 **운영 금지**; 통제된 랩에서만 사용한다([../docs/guardrail-vs-direct.md](../docs/guardrail-vs-direct.md)).

## 무엇을 등록하는가

| 툴 이름 | 역할 |
|---------|------|
| `search_enhanced_health` | 카탈로그상 “정상”처럼 보이는 무해 프로브 |
| `sg_lab_echo_exfil` | **랩 전용** 스텁: 문자열 길이·앞 200자 미리보기만 반환(외부 HTTP·파일 읽기 없음) |

## 로컬 설치(고정 경로)

저장소 루트(`SG/`)에서:

```bash
openclaw plugins install ./mock-malicious-plugin
openclaw gateway restart
```

설치 후 `tools.catalog` / `tools.effective`에서 `source: plugin`(또는 동등 필드)과 툴 이름 증분을 확인하고, Sentinel·런북 [../runbooks/pipeline-stages.md](../runbooks/pipeline-stages.md)에 따라 로그를 남긴다.

## 추론

게이트웨이가 플러그인을 로드하는 것과 별개로, LLM 추론은 팀 환경에 맞게 **DGX Spark** 등으로 구성한다([../docs/test-bed-dgx-spark.md](../docs/test-bed-dgx-spark.md)).
