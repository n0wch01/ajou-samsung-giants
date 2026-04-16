#!/usr/bin/env python3
"""
탐지 결과(findings JSON) 이후 알림·파일 기록·(선택) HTTP POST·(선택) sessions.abort.

기본: stderr 로그 + security-viz가 읽을 수 있는 findings JSON 파일.
sessions.abort 는 다중 환경 변수 확인 없이는 절대 호출하지 않는다.
"""

from __future__ import annotations

import argparse
import asyncio
import json
import os
import sys
from pathlib import Path
from typing import Any

SCRIPTS_DIR = Path(__file__).resolve().parents[1]
if str(SCRIPTS_DIR) not in sys.path:
    sys.path.insert(0, str(SCRIPTS_DIR))

from openclaw_ws import GwSession, parse_scopes_env  # noqa: E402


def _default_findings_path() -> Path:
    return Path(__file__).resolve().parent / "data" / "findings-latest.json"


def _default_findings_in() -> Path:
    return Path(__file__).resolve().parent / "data" / "findings-detect.json"


def _load_findings(path: Path) -> dict[str, Any]:
    data = json.loads(path.read_text(encoding="utf-8"))
    if not isinstance(data, dict):
        raise ValueError("findings file must be a JSON object")
    return data


def _severity_rank(s: str) -> int:
    order = ["info", "low", "medium", "high", "critical"]
    try:
        return order.index(s)
    except ValueError:
        return 0


def _alert_stderr(report: dict[str, Any]) -> None:
    findings = report.get("findings")
    if not isinstance(findings, list) or not findings:
        print("[sentinel-respond] no findings — nothing to alert.", file=sys.stderr)
        return
    print(f"[sentinel-respond] {len(findings)} finding(s)", file=sys.stderr)
    for f in findings:
        if not isinstance(f, dict):
            continue
        sev = f.get("severity", "?")
        rid = f.get("ruleId", "?")
        title = f.get("title", "")
        msg = f.get("message", "")
        print(f"  [{sev}] {rid}: {title}\n    {msg}", file=sys.stderr)


def _write_viz_file(report: dict[str, Any], out: Path) -> None:
    out.parent.mkdir(parents=True, exist_ok=True)
    # security-viz useFindings accepts { findings: [...] } or bare array
    payload = {"findings": report.get("findings", [])}
    if isinstance(report.get("meta"), dict):
        payload["meta"] = report["meta"]
    out.write_text(json.dumps(payload, ensure_ascii=False, indent=2) + "\n", encoding="utf-8")


def _maybe_webhook(report: dict[str, Any]) -> None:
    url = os.environ.get("SENTINEL_FINDINGS_WEBHOOK_URL", "").strip()
    if not url:
        return
    try:
        import httpx
    except ImportError:
        print("[sentinel-respond] httpx missing; pip install -r scripts/requirements.txt", file=sys.stderr)
        return
    try:
        r = httpx.post(url, json=report, timeout=30.0)
        r.raise_for_status()
        print(f"[sentinel-respond] webhook ok {r.status_code}", file=sys.stderr)
    except Exception as e:
        print(f"[sentinel-respond] webhook failed: {e}", file=sys.stderr)


async def _maybe_sessions_abort(findings: list[dict[str, Any]]) -> None:
    if os.environ.get("SENTINEL_ENABLE_SESSIONS_ABORT", "").strip() != "1":
        return
    session_key = os.environ.get("OPENCLAW_GATEWAY_SESSION_KEY", "").strip()
    if not session_key:
        print("[sentinel-respond] sessions.abort skipped: OPENCLAW_GATEWAY_SESSION_KEY empty.", file=sys.stderr)
        return
    if os.environ.get("SENTINEL_SESSIONS_ABORT_CONFIRM", "").strip() != session_key:
        print(
            "[sentinel-respond] sessions.abort skipped: SENTINEL_SESSIONS_ABORT_CONFIRM must equal the session key.",
            file=sys.stderr,
        )
        return
    ack = os.environ.get("SENTINEL_OPERATOR_BREAK_GLASS_ACK", "").strip()
    if ack != "I_UNDERSTAND_FALSE_POSITIVE_STOP":
        print(
            "[sentinel-respond] sessions.abort skipped: set SENTINEL_OPERATOR_BREAK_GLASS_ACK to the documented phrase.",
            file=sys.stderr,
        )
        return
    min_sev = os.environ.get("SENTINEL_ABORT_MIN_SEVERITY", "critical")
    min_rank = _severity_rank(min_sev)
    worst = "info"
    for f in findings:
        if isinstance(f, dict) and isinstance(f.get("severity"), str):
            s = f["severity"]
            if _severity_rank(s) > _severity_rank(worst):
                worst = s
    if _severity_rank(worst) < min_rank:
        print(
            f"[sentinel-respond] sessions.abort skipped: worst severity {worst} < {min_sev}.",
            file=sys.stderr,
        )
        return

    ws_url = os.environ.get("OPENCLAW_GATEWAY_WS_URL", "").strip()
    token = os.environ.get("OPENCLAW_GATEWAY_TOKEN", "").strip()
    if not ws_url or not token:
        print("[sentinel-respond] sessions.abort skipped: gateway URL/token missing.", file=sys.stderr)
        return

    scopes = parse_scopes_env(
        os.environ.get("SENTINEL_ABORT_GATEWAY_SCOPES"),
        ["operator.admin", "operator.write", "operator.read"],
    )
    print(
        "[sentinel-respond] invoking sessions.abort (operator break-glass path engaged).",
        file=sys.stderr,
    )
    sess = await GwSession.connect(
        ws_url,
        token=token,
        client_id="sg-sentinel-respond-abort",
        scopes=scopes,
    )
    try:
        params: dict[str, Any] = {"key": session_key}
        # Some builds accept sessionKey; harmless extra keys are stripped server-side.
        params["sessionKey"] = session_key
        res = await sess.rpc("sessions.abort", params, timeout_s=60.0)
        if not res.get("ok"):
            print(f"[sentinel-respond] sessions.abort error: {res.get('error')}", file=sys.stderr)
        else:
            print("[sentinel-respond] sessions.abort ok.", file=sys.stderr)
    finally:
        await sess.close()


def main() -> None:
    p = argparse.ArgumentParser(description="Sentinel respond — alerts + viz file + optional abort")
    p.add_argument(
        "--input",
        type=Path,
        default=_default_findings_in(),
        help="Findings JSON (detect output). Override path or set via stdin with -",
    )
    p.add_argument(
        "--out",
        type=Path,
        default=Path(os.environ.get("SENTINEL_FINDINGS_OUT") or str(_default_findings_path())),
        help="Output path for security-viz consumption.",
    )
    p.add_argument(
        "--stdin",
        action="store_true",
        help="Read findings JSON from stdin instead of --input.",
    )
    args = p.parse_args()

    if args.stdin:
        report = json.loads(sys.stdin.read())
    else:
        if not args.input.is_file():
            raise SystemExit(f"findings input not found: {args.input} (run detect --out first)")
        report = _load_findings(args.input)

    if not isinstance(report.get("findings"), list):
        raise SystemExit("invalid findings document: missing 'findings' array")

    _alert_stderr(report)
    _write_viz_file(report, args.out)
    print(f"[sentinel-respond] wrote {args.out}", file=sys.stderr)
    _maybe_webhook(report)

    findings = [f for f in report["findings"] if isinstance(f, dict)]
    asyncio.run(_maybe_sessions_abort(findings))


if __name__ == "__main__":
    main()
