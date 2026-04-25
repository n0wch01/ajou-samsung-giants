import json
import os
import shlex
import shutil
import subprocess
from pathlib import Path
from typing import Any


REPO_ROOT = Path(__file__).resolve().parents[1]
LOCAL_OPENCLAW_ENTRY = REPO_ROOT / "openclaw-main" / "openclaw.mjs"

OPENCLAW_CMD = os.getenv("OPENCLAW_CMD")
OPENCLAW_BIN = os.getenv("OPENCLAW_BIN", "openclaw")
OPENCLAW_PROFILE = os.getenv("OPENCLAW_PROFILE", "s1-lab")
OPENCLAW_SSH_HOST = os.getenv("OPENCLAW_SSH_HOST")
OPENCLAW_SSH_OPTS = os.getenv("OPENCLAW_SSH_OPTS", "")
GATEWAY_TIMEOUT_MS = os.getenv("S1_GATEWAY_TIMEOUT_MS", "10000")

ARTIFACT_DIR = Path(os.getenv("S1_ARTIFACT_DIR", Path(__file__).parent / "artifacts"))
ARTIFACT_DIR.mkdir(parents=True, exist_ok=True)


def resolve_openclaw_cmd(remote: bool = False) -> list[str]:
    if OPENCLAW_CMD:
        return shlex.split(OPENCLAW_CMD)
    if remote:
        return [OPENCLAW_BIN]
    if shutil.which(OPENCLAW_BIN):
        return [OPENCLAW_BIN]
    if LOCAL_OPENCLAW_ENTRY.exists():
        return ["node", str(LOCAL_OPENCLAW_ENTRY)]
    return [OPENCLAW_BIN]


def wrap_with_ssh_if_needed(cmd: list[str]) -> list[str]:
    if not OPENCLAW_SSH_HOST:
        return cmd

    remote_cmd = " ".join(shlex.quote(part) for part in cmd)
    return ["ssh", *shlex.split(OPENCLAW_SSH_OPTS), OPENCLAW_SSH_HOST, remote_cmd]


def run_openclaw(*args: str, json_output: bool = False) -> Any:
    """Run OpenClaw as an external CLI, without importing OpenClaw internals."""
    openclaw_cmd = [
        *resolve_openclaw_cmd(remote=bool(OPENCLAW_SSH_HOST)),
        "--profile",
        OPENCLAW_PROFILE,
        "--no-color",
        *args,
    ]

    if json_output:
        openclaw_cmd.append("--json")

    cmd = wrap_with_ssh_if_needed(openclaw_cmd)

    try:
        result = subprocess.run(
            cmd,
            text=True,
            capture_output=True,
            check=False,
        )
    except FileNotFoundError as exc:
        raise AssertionError(
            "OpenClaw CLI not found. Set OPENCLAW_BIN to an executable path "
            'or OPENCLAW_CMD to a full command such as "node openclaw-main/openclaw.mjs". '
            "For UTM, set OPENCLAW_SSH_HOST so commands run inside the VM."
        ) from exc

    if result.returncode != 0:
        raise AssertionError(
            f"Command failed: {' '.join(cmd)}\n"
            f"STDOUT:\n{result.stdout}\n"
            f"STDERR:\n{result.stderr}"
        )

    if not json_output:
        return result.stdout

    try:
        return json.loads(result.stdout)
    except json.JSONDecodeError as exc:
        raise AssertionError(
            f"Expected JSON output from: {' '.join(cmd)}\n"
            f"STDOUT:\n{result.stdout}\n"
            f"STDERR:\n{result.stderr}"
        ) from exc


def gateway_call(method: str, params: dict[str, Any] | None = None) -> Any:
    response = run_openclaw(
        "gateway",
        "call",
        method,
        "--params",
        json.dumps(params or {}, ensure_ascii=False),
        "--timeout",
        GATEWAY_TIMEOUT_MS,
        json_output=True,
    )

    if isinstance(response, dict) and response.get("ok") is False:
        raise AssertionError(f"Gateway call failed: {method}: {response}")

    if isinstance(response, dict):
        return response.get("payload", response.get("result", response))

    return response


def write_artifact(name: str, data: Any) -> Path:
    path = ARTIFACT_DIR / name
    path.write_text(json.dumps(data, ensure_ascii=False, indent=2) + "\n", encoding="utf-8")
    return path


def extract_plugin_tools(snapshot: dict[str, Any]) -> list[dict[str, Any]]:
    tools: list[dict[str, Any]] = []

    for group in snapshot.get("groups", []):
        if not isinstance(group, dict):
            continue
        for tool in group.get("tools", []):
            if not isinstance(tool, dict):
                continue
            if tool.get("source") != "plugin":
                continue
            tools.append(
                {
                    "id": tool.get("id"),
                    "label": tool.get("label"),
                    "pluginId": tool.get("pluginId") or group.get("pluginId"),
                    "groupId": group.get("id"),
                    "source": tool.get("source"),
                }
            )

    return tools


def test_step1_dump_tools_catalog_before_plugin_install() -> None:
    catalog = gateway_call("tools.catalog")
    plugin_tools = extract_plugin_tools(catalog)

    write_artifact("catalog_before.json", catalog)
    write_artifact("plugin_tools_before.json", plugin_tools)

    assert isinstance(catalog.get("groups"), list)


if __name__ == "__main__":
    test_step1_dump_tools_catalog_before_plugin_install()
    print(f"Step 1 complete. Artifacts written to: {ARTIFACT_DIR}")
