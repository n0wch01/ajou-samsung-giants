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
LOCAL_PLUGIN_DIR = Path(os.getenv("S1_PLUGIN_DIR", REPO_ROOT / "mock-malicious-plugin"))
REMOTE_PLUGIN_DIR = os.getenv("S1_REMOTE_PLUGIN_DIR", "/tmp/openclaw-s1/mock-malicious-plugin")
PLUGIN_ID = os.getenv("S1_PLUGIN_ID", "s1-search-enhanced-v2")
EXPECTED_PLUGIN_TOOL = os.getenv("S1_EXPECTED_TOOL", "s1_shadow_config_probe")
RUN_INSTALL_STEP = os.getenv("S1_RUN_INSTALL") == "1"

ARTIFACT_DIR = Path(os.getenv("S1_ARTIFACT_DIR", Path(__file__).parent / "artifacts"))
ARTIFACT_DIR.mkdir(parents=True, exist_ok=True)


def log(message: str) -> None:
    print(f"[s1] {message}", flush=True)


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


def run_command(cmd: list[str], allow_failure: bool = False) -> subprocess.CompletedProcess[str]:
    try:
        result = subprocess.run(
            cmd,
            text=True,
            capture_output=True,
            check=False,
        )
    except FileNotFoundError as exc:
        raise AssertionError(f"Command not found: {cmd[0]}") from exc

    if result.returncode != 0 and not allow_failure:
        raise AssertionError(
            f"Command failed: {' '.join(cmd)}\n"
            f"STDOUT:\n{result.stdout}\n"
            f"STDERR:\n{result.stderr}"
        )

    return result


def run_remote_shell(script: str, allow_failure: bool = False) -> None:
    if not OPENCLAW_SSH_HOST:
        return
    run_command(
        ["ssh", *shlex.split(OPENCLAW_SSH_OPTS), OPENCLAW_SSH_HOST, script],
        allow_failure=allow_failure,
    )


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

    result = run_command(cmd)

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


def sync_plugin_to_remote_if_needed() -> str:
    if not LOCAL_PLUGIN_DIR.exists():
        raise AssertionError(f"Plugin directory does not exist: {LOCAL_PLUGIN_DIR}")

    if not OPENCLAW_SSH_HOST:
        return str(LOCAL_PLUGIN_DIR)

    remote_parent = str(Path(REMOTE_PLUGIN_DIR).parent)
    log(f"clean remote plugin copy: {REMOTE_PLUGIN_DIR}")
    run_remote_shell(
        "rm -rf "
        f"{shlex.quote(REMOTE_PLUGIN_DIR)} "
        f"&& mkdir -p {shlex.quote(remote_parent)}"
    )
    log(f"copy plugin to {OPENCLAW_SSH_HOST}:{remote_parent}/")
    run_command(
        [
            "scp",
            "-r",
            *shlex.split(OPENCLAW_SSH_OPTS),
            str(LOCAL_PLUGIN_DIR),
            f"{OPENCLAW_SSH_HOST}:{remote_parent}/",
        ]
    )
    return REMOTE_PLUGIN_DIR


def remove_prior_test_install_if_needed() -> None:
    if not OPENCLAW_SSH_HOST:
        return
    # Only remove the current test id. Older failed experiments are intentionally
    # left alone so this harness does not mutate unrelated OpenClaw state.
    log(f"clear prior test install files: {PLUGIN_ID}")
    run_remote_shell(f"rm -rf ~/.openclaw/extensions/{shlex.quote(PLUGIN_ID)}")


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
    log("dump tools.catalog before plugin install")
    catalog = gateway_call("tools.catalog")
    plugin_tools = extract_plugin_tools(catalog)

    write_artifact("catalog_before.json", catalog)
    write_artifact("plugin_tools_before.json", plugin_tools)

    assert isinstance(catalog.get("groups"), list)


def test_step2_install_local_plugin_and_diff_catalog() -> None:
    log("dump tools.catalog before install")
    before_catalog = gateway_call("tools.catalog")
    before_plugin_tools = extract_plugin_tools(before_catalog)
    before_ids = {tool["id"] for tool in before_plugin_tools}

    remove_prior_test_install_if_needed()
    plugin_path = sync_plugin_to_remote_if_needed()
    log(f"install plugin from {plugin_path}")
    install_output = run_openclaw("plugins", "install", plugin_path)
    log("restart gateway")
    run_openclaw("gateway", "restart")

    log("dump tools.catalog after install")
    after_catalog = gateway_call("tools.catalog")
    after_plugin_tools = extract_plugin_tools(after_catalog)
    after_ids = {tool["id"] for tool in after_plugin_tools}
    added_ids = sorted(after_ids - before_ids)

    write_artifact("catalog_before_install.json", before_catalog)
    write_artifact("plugin_tools_before_install.json", before_plugin_tools)
    write_artifact("plugin_install_output.txt.json", {"stdout": install_output})
    write_artifact("catalog_after_install.json", after_catalog)
    write_artifact("plugin_tools_after_install.json", after_plugin_tools)
    write_artifact("plugin_tools_added.json", added_ids)

    assert EXPECTED_PLUGIN_TOOL not in before_ids
    assert EXPECTED_PLUGIN_TOOL in after_ids
    assert EXPECTED_PLUGIN_TOOL in added_ids


if __name__ == "__main__":
    if RUN_INSTALL_STEP:
        test_step2_install_local_plugin_and_diff_catalog()
        print(f"Step 2 complete. Artifacts written to: {ARTIFACT_DIR}")
    else:
        test_step1_dump_tools_catalog_before_plugin_install()
        print(f"Step 1 complete. Artifacts written to: {ARTIFACT_DIR}")
