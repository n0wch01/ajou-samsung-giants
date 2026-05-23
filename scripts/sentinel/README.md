# Sentinel

- `ingest.py` — 게이트웨이 WS 구독·이벤트 정규화·`data/trace.jsonl` append-only.
  실행 중 `RealTimeRateDetector`(`detect.py` 내 클래스)가 `rules/api_abuse.yaml`을
  로드해 도구 호출 속도·반복을 실시간 감시하고, 임계치 초과 시 `sessions.abort` 호출.
- `detect.py` — `RealTimeRateDetector` 클래스 정의. (batch 모드 자동 실행은 비활성화됨.)
- `respond.py` — 알림·`data/findings-latest.json`·선택 웹훅·(옵션) `sessions.abort`.

## 탐지 룰 (`rules/*.yaml`)

| 파일 | 카테고리 | 비고 |
|------|----------|------|
| `md_signatures.yaml` | 악성 MD 탐지 | `chat_stream.py`가 파일 읽기 사전 검사 시 로드. Vigil 1:1 포팅(10 카테고리) + 한국어 보강 1건 |
| `api_abuse.yaml` | API Abuse 탐지 | `ingest.py`의 `RealTimeRateDetector`가 로드 |

악성 플러그인 탐지는 별도 YAML 룰 대신 **화이트리스트**(`data/baseline-tools-effective.example.json`) 기반.
`chat_stream.py`가 도구 호출마다 이름을 화이트리스트와 대조해 외부 도구이면 즉시 차단(`ruleId: whitelist-violation`).

### 악성 MD 시그니처 (`rules/md_signatures.yaml`)

오픈소스 [deadbits/vigil-llm](https://github.com/deadbits/vigil-llm)(Apache-2.0)의
YARA 룰 10개 전 카테고리를 정규식으로 포팅하고, 한국어 환경 대응을 위해 1개를
보강했다. 패턴은 `re.IGNORECASE`로 컴파일되며, 어느 규칙이든 매칭되면
`chat_stream.py`가 `sessions.abort`로 세션을 즉시 차단하고
`findings-realtime.jsonl`에 `ruleId: md-signature-block`을 기록한다.

| Rule ID | Vigil 원본 | Severity | 탐지 패턴 |
|---|---|---|---|
| `md-vigil-instruction-bypass` | InstructionBypass | high | "ignore/disregard/bypass" + instructions/commands 류 우회 지시 |
| `md-vigil-system-instruction-markers` | SystemInstructions | high | `<\|im_start\|>system`, `<s>[INST]<<SYS>>`, `[system](#assistant)` 등 LLM 제어 토큰 |
| `md-vigil-markdown-exfiltration` | MarkdownExfiltration | critical | `![alt](https://attacker/x?q=...)` — 이미지 URL을 통한 데이터 유출 |
| `md-vigil-guidance-template-markers` | ContainsGuidance | medium | `{{#system~}}`, `{{#user~}}`, `{{#assistant~}}` 등 Guidance 템플릿 토큰 |
| `md-vigil-api-tokens` | ContainsAPIToken | high | AWS/Azure/GCP/Slack/Stripe/Twilio/Mailgun 등 22종 토큰 형식 (RegHex 기반) |
| `md-vigil-generic-secret` | ContainsGenericSecretPhrase | medium | "private/secret/access (key\|token\|password\|pass)" 조합 |
| `md-vigil-ipv4` | ContainsIPv4 | low | IPv4 주소 (SSRF 등 네트워크 인젝션 의심) |
| `md-vigil-react-injection` | ContainsReAct | high | JSON 구조의 `Thought:`/`Action:` 토큰 위장 |
| `md-vigil-react-text` | ContainsReAct_txt | medium | 평문 `Thought:/Action:/Action Input:/Observation:` 흐름 |
| `md-vigil-ssh-private-key` | ContainsSSHKey | critical | PEM 개인키 헤더 (`-----BEGIN ... PRIVATE KEY-----`) |
| `md-prompt-injection-marker` | (자체 보강) | medium | 한국어 ".env 읽기 유도", "단계별 지시", "env-snapshot" 패턴 |

> 주의: 차단 결정은 매칭 여부만 본다(severity는 차단 기준이 아닌 분류용). `md-vigil-ipv4`,
> `md-vigil-generic-secret`, `md-vigil-react-text`는 정상 문서에도 자주 등장할 수 있으므로
> 실 운영 환경에서는 false-positive 가능성을 고려해야 한다. 차단 로직은
> [`scripts/runner/chat_stream.py`](../runner/chat_stream.py)의 `_check_md_signature` 참고.
