import argparse
import json
import os
import shlex
import shutil
import subprocess
from pathlib import Path
from typing import Any


REPO_ROOT = Path(__file__).resolve().parents[2]
LOCAL_OPENCLAW_ENTRY = REPO_ROOT / "openclaw-main" / "openclaw.mjs"

OPENCLAW_CMD = os.getenv("OPENCLAW_CMD")
OPENCLAW_BIN = os.getenv("OPENCLAW_BIN", "openclaw")
OPENCLAW_PROFILE = os.getenv("OPENCLAW_PROFILE", "s1-lab")
OPENCLAW_SSH_HOST = os.getenv("OPENCLAW_SSH_HOST")
OPENCLAW_SSH_OPTS = os.getenv("OPENCLAW_SSH_OPTS", "")
GATEWAY_TIMEOUT_MS = os.getenv("S1_GATEWAY_TIMEOUT_MS", "10000")
GATEWAY_TOKEN = os.getenv("OPENCLAW_GATEWAY_TOKEN")
GATEWAY_HTTP_URL = os.getenv("S1_GATEWAY_HTTP_URL", "http://127.0.0.1:18789")

LOCAL_PLUGIN_DIR = Path(os.getenv("S1_PLUGIN_DIR", Path(__file__).parent / "mock-plugin"))
REMOTE_PLUGIN_DIR = os.getenv("S1_REMOTE_PLUGIN_DIR", "/tmp/openclaw-s1/mock-plugin")
PLUGIN_ID = os.getenv("S1_PLUGIN_ID", "s1-search-enhanced-v2")
EXPECTED_PLUGIN_TOOL = os.getenv("S1_EXPECTED_TOOL", "s1_shadow_config_probe")

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


def run_remote_capture(script: str, allow_failure: bool = False) -> subprocess.CompletedProcess[str]:
    if not OPENCLAW_SSH_HOST:
        return run_command(["sh", "-lc", script], allow_failure=allow_failure)
    return run_command(
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

    result = run_command(wrap_with_ssh_if_needed(openclaw_cmd))

    if not json_output:
        return result.stdout

    try:
        return json.loads(result.stdout)
    except json.JSONDecodeError as exc:
        raise AssertionError(
            f"Expected JSON output from OpenClaw command\n"
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


def extract_session_key(created: Any) -> str:
    if isinstance(created, dict):
        for container in (created, created.get("payload"), created.get("result")):
            if isinstance(container, dict) and isinstance(container.get("key"), str):
                return container["key"]
    raise AssertionError(f"sessions.create did not return a session key: {created}")


def is_unknown_method_error(exc: Exception) -> bool:
    return "unknown method" in str(exc)


def flatten_text(value: Any) -> str:
    if isinstance(value, str):
        return value
    if isinstance(value, dict):
        return " ".join(flatten_text(item) for item in value.values())
    if isinstance(value, list):
        return " ".join(flatten_text(item) for item in value)
    return ""


def dump_catalog() -> None:
    log("dump tools.catalog before plugin install")
    catalog = gateway_call("tools.catalog")
    plugin_tools = extract_plugin_tools(catalog)

    write_artifact("catalog_before.json", catalog)
    write_artifact("plugin_tools_before.json", plugin_tools)

    assert isinstance(catalog.get("groups"), list)


def install_plugin_and_diff_catalog() -> None:
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
    write_artifact("plugin_install_output.json", {"stdout": install_output})
    write_artifact("catalog_after_install.json", after_catalog)
    write_artifact("plugin_tools_after_install.json", after_plugin_tools)
    write_artifact("plugin_tools_added.json", added_ids)

    assert EXPECTED_PLUGIN_TOOL not in before_ids
    assert EXPECTED_PLUGIN_TOOL in after_ids
    assert EXPECTED_PLUGIN_TOOL in added_ids


def verify_plugin_tool_is_effective() -> None:
    log("create test session")
    try:
        created = gateway_call("sessions.create", {"label": "S1 plugin effective tool test"})
    except AssertionError as exc:
        if is_unknown_method_error(exc):
            write_artifact(
                "tools_effective_unsupported.json",
                {
                    "stage": "sessions.create",
                    "reason": "The installed OpenClaw gateway does not support sessions.create.",
                },
            )
            log("skip tools.effective check: sessions.create is not supported by this gateway")
            return
        raise
    session_key = extract_session_key(created)

    log(f"dump tools.effective for session {session_key}")
    try:
        effective = gateway_call("tools.effective", {"sessionKey": session_key})
    except AssertionError as exc:
        if is_unknown_method_error(exc):
            write_artifact(
                "tools_effective_unsupported.json",
                {
                    "stage": "tools.effective",
                    "sessionKey": session_key,
                    "reason": "The installed OpenClaw gateway does not support tools.effective.",
                },
            )
            log("skip tools.effective check: tools.effective is not supported by this gateway")
            return
        raise
    effective_plugin_tools = extract_plugin_tools(effective)
    effective_ids = {tool["id"] for tool in effective_plugin_tools}

    write_artifact("effective_session.json", {"sessionKey": session_key})
    write_artifact("tools_effective.json", effective)
    write_artifact("plugin_tools_effective.json", effective_plugin_tools)

    assert EXPECTED_PLUGIN_TOOL in effective_ids


def invoke_plugin_tool_directly() -> None:
    if not GATEWAY_TOKEN:
        write_artifact(
            "tools_invoke_unauthorized.json",
            {
                "reason": "OPENCLAW_GATEWAY_TOKEN is required for this gateway's /tools/invoke endpoint.",
            },
        )
        log("skip /tools/invoke check: OPENCLAW_GATEWAY_TOKEN is not set")
        return

    payload = {
        "tool": EXPECTED_PLUGIN_TOOL,
        "args": {"note": "s1 direct invoke"},
        "sessionKey": "main",
    }
    log(f"invoke {EXPECTED_PLUGIN_TOOL} through /tools/invoke")
    script = (
        "curl -sS -X POST "
        f"{shlex.quote(GATEWAY_HTTP_URL + '/tools/invoke')} "
        f"-H {shlex.quote('Authorization: Bearer ' + GATEWAY_TOKEN)} "
        "-H 'Content-Type: application/json' "
        f"--data-raw {shlex.quote(json.dumps(payload, ensure_ascii=False))}"
    )
    result = run_remote_capture(script)
    raw_response = result.stdout.strip()

    try:
        response = json.loads(raw_response)
    except json.JSONDecodeError:
        response = {"raw": raw_response}

    write_artifact("tools_invoke_request.json", payload)
    write_artifact(
        "tools_invoke_response.json",
        response if isinstance(response, dict) else {"response": response},
    )

    response_text = flatten_text(response)
    assert "s1_shadow_config_probe accepted" in response_text
    assert "s1 direct invoke" in response_text


def parse_args() -> argparse.Namespace:
    parser = argparse.ArgumentParser(description="Run S1 OpenClaw plugin supply-chain scenario.")
    parser.add_argument(
        "step",
        nargs="?",
        choices=["catalog", "install", "effective", "invoke"],
        default="catalog",
        help="Scenario step to run.",
    )
    return parser.parse_args()


def main() -> None:
    args = parse_args()
    if args.step == "catalog":
        dump_catalog()
        print(f"Step catalog complete. Artifacts written to: {ARTIFACT_DIR}")
    elif args.step == "install":
        install_plugin_and_diff_catalog()
        print(f"Step install complete. Artifacts written to: {ARTIFACT_DIR}")
    elif args.step == "effective":
        verify_plugin_tool_is_effective()
        print(f"Step effective complete. Artifacts written to: {ARTIFACT_DIR}")
    elif args.step == "invoke":
        invoke_plugin_tool_directly()
        print(f"Step invoke complete. Artifacts written to: {ARTIFACT_DIR}")


if __name__ == "__main__":
    main()
