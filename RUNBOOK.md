# AI AGENT Security 실행 가이드

이 문서는 S1 악성 플러그인 시나리오와 대시보드를 실행하는 방법을 정리합니다.

## 1. 시작 위치

모든 명령어는 Mac의 VSCode 터미널에서 실행합니다.

```bash
cd /Users/wooyongun/Desktop/paran_dev/ajou-samsung-giants
```

UTM에 직접 들어가서 `python3 scenarios/s1/run_s1.py`를 실행하면 안 됩니다.  
Python 실행기는 Mac에 있고, 내부에서 SSH로 UTM의 OpenClaw를 조작합니다.

## 2. 공통 환경변수

```bash
export OPENCLAW_SSH_HOST="yongcloud@192.168.64.14"
export OPENCLAW_PROFILE="default"
```

## 3. 대시보드 확실히 끄기

대시보드를 켠 터미널이 보이면 `Ctrl + C`를 누르면 됩니다.

다시 켤 때 아래처럼 `Address already in use`가 나오면 이미 `8765` 포트를 쓰는 대시보드 서버가 켜져 있다는 뜻입니다.

```text
OSError: [Errno 48] Address already in use
```

이 경우 아래 명령으로 기존 서버의 PID를 찾습니다.

```bash
lsof -nP -iTCP:8765 -sTCP:LISTEN
```

출력 예시:

```text
COMMAND   PID      USER   FD   TYPE   DEVICE SIZE/OFF NODE NAME
Python  76200 wooyongun    5u  IPv4        0      0t0  TCP 127.0.0.1:8765 (LISTEN)
```

출력에 보이는 `PID`를 사용해서 끕니다.

```bash
kill <PID>
```

예를 들어 PID가 `76200`이면:

```bash
kill 76200
```

그래도 안 꺼지면 강제로 종료합니다.

```bash
kill -9 <PID>
```

꺼졌는지 확인:

```bash
curl -sS --max-time 2 http://127.0.0.1:8765
```

연결 실패가 나오면 꺼진 것입니다.

## 4. 대시보드 확실히 켜기

Mac 터미널에서 실행합니다.

```bash
cd /Users/wooyongun/Desktop/paran_dev/ajou-samsung-giants
export OPENCLAW_SSH_HOST="yongcloud@192.168.64.14"
export OPENCLAW_PROFILE="default"
python3 dashboard/server.py
```

브라우저에서 엽니다.

```text
http://127.0.0.1:8765
```

서버를 켠 터미널은 계속 켜둡니다. 끄려면 `Ctrl+C`를 누릅니다.

대시보드는 처음 열릴 때 OpenClaw의 `tools.catalog`를 자동으로 호출합니다.  
따라서 악성 플러그인을 설치하지 않아도 원래 있는 기본 도구 목록이 먼저 보입니다.

## 5. 기본 도구만 보기

악성 플러그인을 설치하지 않고 기본 도구만 보고 싶으면 대시보드만 켜면 됩니다.

```bash
cd /Users/wooyongun/Desktop/paran_dev/ajou-samsung-giants
export OPENCLAW_SSH_HOST="yongcloud@192.168.64.14"
export OPENCLAW_PROFILE="default"
python3 dashboard/server.py
```

브라우저:

```text
http://127.0.0.1:8765
```

대시보드 서버가 자동으로 아래 파일을 생성합니다.

```text
scenarios/s1/artifacts/catalog_before.json
```

설치 전 도구 목록에 `read`, `write`, `edit`, `exec` 같은 기본 도구가 보이면 정상입니다.

수동으로 기본 catalog만 다시 만들고 싶을 때는 아래 명령을 사용합니다.

```bash
python3 scenarios/s1/run_s1.py catalog
```

## 6. S1 악성 플러그인 테스트하기

악성 플러그인을 설치하고, 설치 전/설치 후 도구 목록 변화를 확인합니다.

```bash
cd /Users/wooyongun/Desktop/paran_dev/ajou-samsung-giants
export OPENCLAW_SSH_HOST="yongcloud@192.168.64.14"
export OPENCLAW_PROFILE="default"
python3 scenarios/s1/run_s1.py install
```

성공하면 아래 파일에 새로 추가된 도구가 기록됩니다.

```text
scenarios/s1/artifacts/plugin_tools_added.json
```

성공 기준:

```text
s1_shadow_config_probe
```

대시보드에서는 다음을 확인합니다.

- S1 카드 선택
- 설치 전 도구 목록 확인
- 설치 후 도구 목록 확인
- `s1_shadow_config_probe`가 설치 후 목록에 새로 등장하는지 확인
- 프롬프트 창에서 OpenClaw와 대화

## 7. 테스트 결과 초기화하기

대시보드는 이전 테스트 결과 artifact를 읽습니다.  
플러그인을 삭제했는데 화면에 계속 보이면 artifact를 삭제합니다.

```bash
cd /Users/wooyongun/Desktop/paran_dev/ajou-samsung-giants
rm -f scenarios/s1/artifacts/*.json
```

그 후 기본 도구만 다시 보고 싶으면:

```bash
python3 dashboard/server.py
```

악성 플러그인 테스트를 다시 하고 싶으면:

```bash
python3 scenarios/s1/run_s1.py install
```

## 8. OpenClaw에서 플러그인 삭제하기

UTM 안의 OpenClaw에서 S1 플러그인을 지우고 싶을 때만 실행합니다.

```bash
ssh yongcloud@192.168.64.14
```

UTM 안에서:

```bash
rm -rf ~/.openclaw/extensions/s1-search-enhanced-v2
rm -rf ~/.openclaw-s1-lab/extensions/s1-search-enhanced-v2
rm -rf /tmp/openclaw-s1
```

config 기록까지 지우려면:

```bash
python3 - <<'PY'
import json
from pathlib import Path

for path in [
    Path.home() / ".openclaw" / "openclaw.json",
    Path.home() / ".openclaw-s1-lab" / "openclaw.json",
]:
    if not path.exists():
        continue

    cfg = json.loads(path.read_text())
    plugins = cfg.get("plugins", {})

    for section in ["entries", "installs"]:
        values = plugins.get(section)
        if isinstance(values, dict):
            for key in list(values):
                if key.startswith("s1-search-enhanced"):
                    values.pop(key, None)

    path.write_text(json.dumps(cfg, ensure_ascii=False, indent=2) + "\n")
PY
```

gateway 재시작:

```bash
openclaw --profile default gateway restart
exit
```

## 9. 자주 나는 오류

### Address already in use

이미 대시보드 서버가 켜져 있는 상태입니다.

그냥 브라우저에서 열면 됩니다.

```text
http://127.0.0.1:8765
```

강제로 다시 켜고 싶으면:

```bash
lsof -nP -iTCP:8765 -sTCP:LISTEN
kill <PID>
python3 dashboard/server.py
```

### 플러그인을 지웠는데 대시보드에 계속 보임

대시보드는 이전 테스트 결과 artifact를 읽습니다.  
화면에서 결과를 지우려면 Mac에서 artifact를 삭제합니다.

```bash
rm -f scenarios/s1/artifacts/*.json
```

그 후 기본 도구만 다시 보고 싶으면:

```bash
python3 scenarios/s1/run_s1.py catalog
```

### UTM에서 run_s1.py를 실행했을 때 파일이 없다고 나옴

정상입니다. `run_s1.py`는 Mac 프로젝트 폴더에 있습니다.  
UTM이 아니라 Mac 터미널에서 실행해야 합니다.

## 10. 시연용 한 줄 설명

이 시나리오는 정상 플러그인처럼 보이는 로컬 플러그인이 OpenClaw에 설치된 뒤, AI Agent가 사용할 수 있는 도구 목록에 `s1_shadow_config_probe`라는 새 도구를 추가하는 과정을 가시화합니다.
