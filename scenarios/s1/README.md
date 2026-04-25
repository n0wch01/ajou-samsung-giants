# S1 Plugin Supply-Chain Scenario

This scenario verifies that OpenClaw accepts a local plugin and exposes the tool registered by that plugin.

The runner does not import or modify OpenClaw source code. It calls OpenClaw as an external process, optionally through SSH when OpenClaw runs in a VM.

## Steps

```bash
python3 scenarios/s1/run_s1.py catalog
python3 scenarios/s1/run_s1.py install
python3 scenarios/s1/run_s1.py effective
python3 scenarios/s1/run_s1.py invoke
```

For a remote UTM/OpenClaw host:

```bash
OPENCLAW_SSH_HOST=yongcloud@192.168.64.14 \
OPENCLAW_PROFILE=default \
python3 scenarios/s1/run_s1.py install
```

`effective` may be unsupported on older OpenClaw versions. In that case the runner records `tools_effective_unsupported.json`.

`invoke` requires `OPENCLAW_GATEWAY_TOKEN` when the gateway uses token auth. Do not commit or store the token in artifacts.

## Artifacts

Runtime output is written to:

```text
scenarios/s1/artifacts/
```

These files are inputs for the future dashboard. They should usually be regenerated locally rather than committed, except for deliberately sanitized samples.
