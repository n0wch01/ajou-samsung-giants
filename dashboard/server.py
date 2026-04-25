import json
import os
import shlex
import subprocess
import sys
import time
from http.server import BaseHTTPRequestHandler, ThreadingHTTPServer
from pathlib import Path
from typing import Any

sys.path.insert(0, str(Path(__file__).resolve().parent))

import app


HOST = os.getenv("DASHBOARD_HOST", "127.0.0.1")
PORT = int(os.getenv("DASHBOARD_PORT", "8765"))
OPENCLAW_BIN = os.getenv("OPENCLAW_BIN", "openclaw")
OPENCLAW_PROFILE = os.getenv("OPENCLAW_PROFILE", "s1-lab")
OPENCLAW_SSH_HOST = os.getenv("OPENCLAW_SSH_HOST")
OPENCLAW_SSH_OPTS = os.getenv("OPENCLAW_SSH_OPTS", "")
GATEWAY_TIMEOUT_MS = os.getenv("DASHBOARD_GATEWAY_TIMEOUT_MS", "30000")
CHAT_WAIT_TIMEOUT_MS = int(os.getenv("DASHBOARD_CHAT_WAIT_TIMEOUT_MS", "60000"))
S1_ARTIFACT_DIR = app.SCENARIOS_DIR / "s1" / "artifacts"


def run_command(command: list[str]) -> subprocess.CompletedProcess[str]:
    return subprocess.run(command, text=True, capture_output=True, check=False)


def wrap_ssh(command: list[str]) -> list[str]:
    if not OPENCLAW_SSH_HOST:
        return command
    remote_command = " ".join(shlex.quote(part) for part in command)
    return ["ssh", *shlex.split(OPENCLAW_SSH_OPTS), OPENCLAW_SSH_HOST, remote_command]


def gateway_call(method: str, params: dict[str, Any]) -> Any:
    command = [
        OPENCLAW_BIN,
        "--profile",
        OPENCLAW_PROFILE,
        "--no-color",
        "gateway",
        "call",
        method,
        "--params",
        json.dumps(params, ensure_ascii=False),
        "--timeout",
        GATEWAY_TIMEOUT_MS,
        "--json",
    ]
    result = run_command(wrap_ssh(command))
    if result.returncode != 0:
        raise RuntimeError((result.stderr or result.stdout).strip())
    try:
        return json.loads(result.stdout)
    except json.JSONDecodeError as exc:
        raise RuntimeError(f"OpenClaw returned non-JSON output: {result.stdout}") from exc


def ensure_s1_catalog_artifact() -> None:
    """Show baseline tools even before the S1 install step is run."""
    install_artifacts = [
        S1_ARTIFACT_DIR / "catalog_before_install.json",
        S1_ARTIFACT_DIR / "catalog_after_install.json",
        S1_ARTIFACT_DIR / "plugin_tools_added.json",
    ]
    if any(path.exists() for path in install_artifacts):
        return

    catalog_path = S1_ARTIFACT_DIR / "catalog_before.json"
    if catalog_path.exists():
        return

    try:
        catalog = gateway_call("tools.catalog", {})
    except Exception:
        return

    S1_ARTIFACT_DIR.mkdir(parents=True, exist_ok=True)
    catalog_path.write_text(
        json.dumps(catalog, ensure_ascii=False, indent=2) + "\n",
        encoding="utf-8",
    )


def send_chat(message: str) -> Any:
    run_id = f"dashboard-{int(time.time() * 1000)}"
    params = {
        "sessionKey": "main",
        "message": message,
        "deliver": False,
        "idempotencyKey": run_id,
    }
    sent = gateway_call("chat.send", params)

    wait_result = None
    history = None
    reply = None
    try:
        wait_result = gateway_call("agent.wait", {"runId": run_id, "timeoutMs": CHAT_WAIT_TIMEOUT_MS})
        history = gateway_call("chat.history", {"sessionKey": "main", "limit": 20})
        reply = latest_assistant_text(history)
    except Exception as exc:
        wait_result = {"status": "history_unavailable", "error": str(exc)}

    return {
        "runId": run_id,
        "send": sent,
        "wait": wait_result,
        "reply": reply,
        "history": history,
    }


def latest_assistant_text(history: Any) -> str | None:
    messages = history.get("messages") if isinstance(history, dict) else None
    if not isinstance(messages, list):
        return None

    for message in reversed(messages):
        if not isinstance(message, dict):
            continue
        role = message.get("role") or message.get("type")
        if role not in {"assistant", "agent"}:
            continue
        text = collect_text(message)
        if text.strip():
            return text.strip()
    return None


def collect_text(value: Any) -> str:
    if isinstance(value, str):
        return value
    if isinstance(value, list):
        return " ".join(collect_text(item) for item in value)
    if isinstance(value, dict):
        parts = []
        for key in ("text", "content", "message", "value"):
            if key in value:
                parts.append(collect_text(value[key]))
        return " ".join(part for part in parts if part)
    return ""


class DashboardHandler(BaseHTTPRequestHandler):
    def send_json(self, status: int, payload: dict[str, Any]) -> None:
        body = json.dumps(payload, ensure_ascii=False, indent=2).encode("utf-8")
        self.send_response(status)
        self.send_header("Content-Type", "application/json; charset=utf-8")
        self.send_header("Content-Length", str(len(body)))
        self.end_headers()
        self.wfile.write(body)

    def do_GET(self) -> None:
        if self.path not in {"/", "/index.html"}:
            self.send_error(404)
            return
        ensure_s1_catalog_artifact()
        body = app.build_report().encode("utf-8")
        self.send_response(200)
        self.send_header("Content-Type", "text/html; charset=utf-8")
        self.send_header("Content-Length", str(len(body)))
        self.end_headers()
        self.wfile.write(body)

    def do_POST(self) -> None:
        if self.path != "/api/chat":
            self.send_error(404)
            return

        length = int(self.headers.get("Content-Length", "0"))
        raw = self.rfile.read(length)
        try:
            payload = json.loads(raw.decode("utf-8"))
        except json.JSONDecodeError:
            self.send_json(400, {"ok": False, "error": "Invalid JSON body"})
            return

        message = payload.get("message")
        if not isinstance(message, str) or not message.strip():
            self.send_json(400, {"ok": False, "error": "message is required"})
            return

        try:
            response = send_chat(message.strip())
        except Exception as exc:
            self.send_json(500, {"ok": False, "error": str(exc)})
            return

        self.send_json(200, {"ok": True, "response": response})

    def log_message(self, format: str, *args: Any) -> None:
        return


def main() -> None:
    server = ThreadingHTTPServer((HOST, PORT), DashboardHandler)
    print(f"SG-ClawWatch dashboard: http://{HOST}:{PORT}")
    print("Press Ctrl+C to stop.")
    server.serve_forever()


if __name__ == "__main__":
    main()
