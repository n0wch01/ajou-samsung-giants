#!/usr/bin/env bash
# OpenClaw 워크스페이스 초기 설정 스크립트 (Mac/Linux/WSL 공통)
# 사용법: bash scripts/setup-workspace.sh
set -e

REPO_ROOT="$(cd "$(dirname "${BASH_SOURCE[0]}")/.." && pwd)"
WORKSPACE="$HOME/.openclaw/workspace"

echo "=== SG-ClawWatch 워크스페이스 설정 ==="
echo "REPO: $REPO_ROOT"
echo "WORKSPACE: $WORKSPACE"
echo ""

# 1. mock-targets 디렉토리 생성 및 파일 복사
echo "[1/3] mock-targets 설정..."
mkdir -p "$WORKSPACE/mock-targets"
cp "$REPO_ROOT/mock-targets/readme_s2.md"  "$WORKSPACE/mock-targets/readme_s2.md"
echo "  ✓ readme_s2.md 복사 완료"

# 2. workspace 루트 .env (S2 시나리오에서 유출되는 mock 자격증명)
if [ ! -f "$WORKSPACE/.env" ]; then
    cp "$REPO_ROOT/mock-targets/workspace.env" "$WORKSPACE/.env"
    echo "  ✓ .env (mock 자격증명) 생성 완료"
else
    echo "  - .env 이미 존재, 건너뜀"
fi

# 3. ai-image-toolkit 플러그인 설치 (S1 시나리오)
echo "[2/3] ai-image-toolkit 플러그인 설치..."
PLUGIN_DIR="$REPO_ROOT/mock-malicious-plugin"
if [ -d "$PLUGIN_DIR" ]; then
    openclaw plugins install "$PLUGIN_DIR" 2>/dev/null && \
        echo "  ✓ ai-image-toolkit 설치 완료" || \
        echo "  ! 플러그인 설치 실패 (이미 설치됐거나 게이트웨이가 실행 중이지 않을 수 있음)"

    # 플러그인 기여 툴(ai_image_gen, ai_model_check)을 에이전트 effective 툴셋에 노출.
    # 기본 "coding" 프로파일은 코어 툴만 allow하므로 그대로 두면 플러그인 툴이 제외되어 S1에서 에이전트가 인식하지 못한다.
    # tools.profile=full(전체 노출)로 바꾸는 대신, tools.alsoAllow로 "이 플러그인 툴만" 프로파일 위에 병합한다(최소 노출 원칙).
    # 외부 플러그인을 더 노출하려면 이 배열에 해당 툴 ID를 추가하면 된다. (게이트웨이 재시작 시 적용됨)
    openclaw config set tools.alsoAllow '["ai_image_gen","ai_model_check"]' --strict-json 2>/dev/null && \
        echo "  ✓ tools.alsoAllow에 ai_image_gen, ai_model_check 추가 (플러그인 툴 노출)" || \
        echo "  ! tools.alsoAllow 설정 실패 — 수동: openclaw config set tools.alsoAllow '[\"ai_image_gen\",\"ai_model_check\"]' --strict-json"
else
    echo "  ! mock-malicious-plugin 디렉토리를 찾을 수 없음: $PLUGIN_DIR"
fi

# 4. Python 의존성
echo "[3/3] Python 의존성 설치..."
if [ -f "$REPO_ROOT/requirements.txt" ]; then
    pip install -r "$REPO_ROOT/requirements.txt" -q && echo "  ✓ pip install 완료"
fi

echo ""
echo "=== 설정 완료 ==="
echo ""
echo "다음 단계:"
echo "  1. openclaw gateway start    (WSL/터미널에서)"
echo "  2. cd security-viz && npm install && npm run dev"
echo "  3. 브라우저에서 http://localhost:5173 접속"
