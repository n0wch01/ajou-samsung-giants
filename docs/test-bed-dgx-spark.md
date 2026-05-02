# 테스트 베드: NVIDIA DGX Spark + OpenClaw 게이트웨이

추론(LLM)은 **NVIDIA DGX Spark**에서 제공하는 **호환 HTTP API**(팀 표준은 대개 OpenAI Chat Completions 호환)를 사용하고, OpenClaw 게이트웨이·CLI가 그 엔드포인트를 **프로바이더**로 바라보게 구성한다. S1 시나리오는 이 조합을 **표준**으로 한다.

## 전제

- DGX Spark 쪽에서 모델이 기동되어 있고, 팀이 승인한 **베이스 URL**로 요청할 수 있다.
- OpenClaw 게이트웨이가 동일 네트워크(또는 VPN)에서 DGX에 도달할 수 있다.
- 비밀 값은 **문서에 평문으로 적지 않는다.** 아래는 이름·placeholder만 쓴다.

## 구성 변수(팀 내부 SSOT)

아래 이름은 예시다. 실제 키는 OpenClaw 설정 파일·비밀 저장소에만 둔다.

| 항목 | 설명 | 예시(비밀 아님) |
|------|------|------------------|
| **Base URL** | Chat Completions 등 상위 경로까지 포함한 HTTP(S) 루트 | `https://dgx-spark.example.com:8443/v1` |
| **모델 id** | 서빙 스택에 등록된 모델 식별자 | `team-llama3-70b-instruct` |
| **인증** | API 키·mTLS·사내 토큰 등 팀 표준 | 환경 변수 `OPENCLAW_DGX_API_KEY` 등(값은 문서화하지 않음) |

OpenClaw 쪽에는 위 베이스 URL·모델 id·인증을 **프로바이더 설정**에 맞게 넣는다. 정확한 키 경로는 사용 중인 OpenClaw 버전의 “로컬/원격 모델·게이트웨이” 문서를 따른다(예: [OpenClaw local models](https://docs.openclaw.ai/gateway/local-models) — 원격 OpenAI 호환 엔드포인트에도 동일하게 매핑).

## 연결 검증(커맨드)

**1) 엔드포인트 가용성(OpenAI 호환 예시)**

```bash
export DGX_BASE_URL="https://YOUR-DGX-HOST:PORT/v1"
export DGX_API_KEY="***"   # 팀 비밀 — 쉘 히스토리 주의

curl -sS "${DGX_BASE_URL}/models" \
  -H "Authorization: Bearer ${DGX_API_KEY}" | head
```

**2) 최소 채팅 완성 한 건**

```bash
curl -sS "${DGX_BASE_URL}/chat/completions" \
  -H "Authorization: Bearer ${DGX_API_KEY}" \
  -H "Content-Type: application/json" \
  -d '{
    "model": "YOUR_MODEL_ID",
    "messages": [{"role": "user", "content": "ping: reply ok"}],
    "max_tokens": 16
  }'
```

응답에 `choices[0].message.content`가 오면 추론 경로는 정상이다.

**3) OpenClaw 게이트웨이 관점**

- 게이트웨이 기동 후, 설정에 적은 모델 id로 **단발 메시지**(CLI 또는 UI)를 보내 응답이 오는지 확인한다.
- S1용 플러그인 설치 전후로 `tools.catalog` / `tools.effective`를 덤프해 플러그인 출처 툴 증분을 본다([../scenarios/s1-plugin-supply-chain.md](../scenarios/s1-plugin-supply-chain.md)).

## S1 권장 순서

1. DGX 엔드포인트·모델 id·키를 OpenClaw에 반영한다.
2. 위 (1)(2)로 DGX 단독 검증 → (3)으로 게이트웨이 검증.
3. SG 루트에서 `openclaw plugins install ./mock-malicious-plugin` 후 카탈로그 덤프.
4. Guardrail 또는 Direct 프리셋([guardrail-vs-direct.md](guardrail-vs-direct.md))으로 고정 프롬프트를 실행하고, `session.tool`·Sentinel `trace.jsonl`을 수집한다.

## 보안

- URL·토큰·인증서는 **커밋·스크린샷·채팅 로그에 넣지 않는다.**
- Direct 모드는 **운영 금지**; 격리된 랩에서만 사용한다.
