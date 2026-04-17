#!/usr/bin/env bash
# Run security-viz + local findings API (port 8787) for SG development.
set -euo pipefail

ROOT="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)"
cd "$ROOT"

if ! command -v python3 >/dev/null 2>&1; then
  echo "run-security-viz.sh: python3 is required (for port 8787 findings server)." >&2
  exit 1
fi
if ! command -v npm >/dev/null 2>&1; then
  echo "run-security-viz.sh: npm is required." >&2
  exit 1
fi

PIDS=()
cleanup() {
  local p
  for p in "${PIDS[@]:-}"; do
    kill "$p" 2>/dev/null || true
  done
}
trap cleanup EXIT INT TERM HUP

echo "[run-security-viz] starting findings dev server on 127.0.0.1:8787 …" >&2
python3 "$ROOT/scripts/sentinel/findings_dev_server.py" --host 127.0.0.1 --port 8787 &
PIDS+=("$!")

cd "$ROOT/security-viz"
if [[ ! -d node_modules ]]; then
  echo "[run-security-viz] npm install (first run) …" >&2
  npm install
fi

echo "[run-security-viz] starting Vite (Ctrl+C stops findings server too) …" >&2
npm run dev
