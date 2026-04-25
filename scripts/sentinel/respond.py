#!/usr/bin/env python3
"""
Sentinel Respond — findings JSON → alert / viz / webhook / (선택) sessions.abort

환경 변수:
  OPENCLAW_GATEWAY_WS_URL          (sessions.abort 사용 시 필수)
  OPENCLAW_GATEWAY_TOKEN           (sessions.abort 사용 시 필수)
  OPENCLAW_GATEWAY_SESSION_KEY     (sessions.abort 사용 시 필수)

  sessions.abort 4중 안전장치 — 아래 네 조건을 모두 충족해야 실행:
  SENTINEL_ENABLE_SESSIONS_ABORT=1
  SENTINEL_SESSIONS_ABORT_CONFIRM=<SESSION_KEY 와 동일한 값>
  SENTINEL_OPERATOR_BREAK_GLASS_ACK=I_UNDERSTAND_FALSE_POSITIVE_STOP
  SENTINEL_ABORT_MIN_SEVERITY=high  (기본값, 이상 severity 부터 abort)

  SENTINEL_VIZ_OUT_PATH            — (선택) viz JSON 저장 경로
  SENTINEL_FINDINGS_WEBHOOK_URL    — (선택) findings를 POST할 URL
"""
from __future__ import annotations

import argparse
import asyncio
import json
import os
import sys
import time
from pathlib import Path
from typing import Any

SCRIPTS_DIR = Path(__file__).resolve().parents[1]
if str(SCRIPTS_DIR) not in sys.path:
    sys.path.insert(0, str(SCRIPTS_DIR))

from openclaw_ws import GwSession  # noqa: E402

_SEVERITY_ORDER = ["info", "low", "medium", "high", "critical"]


def _severity_rank(s: str) -> int:
    try:
        return _SEVERITY_ORDER.index(s.lower())
    except ValueError:
        return 0


def _load_findings(path: Path) -> dict[str, Any]:
    data = json.loads(path.read_text(encoding="utf-8"))
    if not isinstance(data, dict) or "findings" not in data:
        raise ValueError(f"findings JSON 형식 오류: {path}")
    return data


def _alert_stderr(report: dict[str, Any]) -> None:
    findings = report.get("findings", [])
    if not findings:
        print("[respond] findings 없음 — 탐지 없음", file=sys.stderr)
        return
    print(f"[respond] === {len(findings)}개 finding ===", file=sys.stderr)
    for f in findings:
        sev = f.get("severity", "?").upper()
        rid = f.get("ruleId", "?")
        title = f.get("title", "")
        msg = f.get("message", "")
        print(f"  [{sev}] {rid}: {title}", file=sys.stderr)
        if msg:
            print(f"    {msg}", file=sys.stderr)
        rec = f.get("recommendedAction", "")
        if rec:
            print(f"    → {rec}", file=sys.stderr)


def _write_viz_file(report: dict[str, Any], out: Path) -> None:
    out.parent.mkdir(parents=True, exist_ok=True)
    out.write_text(json.dumps(report, ensure_ascii=False, indent=2), encoding="utf-8")
    print(f"[respond] viz → {out}", file=sys.stderr)


def _maybe_webhook(report: dict[str, Any]) -> None:
    url = os.environ.get("SENTINEL_FINDINGS_WEBHOOK_URL", "").strip()
    if not url:
        return
    try:
        import httpx
    except ImportError:
        print("[respond] httpx 없음 — webhook 건너뜀 (pip install httpx)", file=sys.stderr)
        return

    body = json.dumps(report, ensure_ascii=False).encode("utf-8")
    for attempt, delay in enumerate([0, 2, 4]):
        if delay:
            time.sleep(delay)
        try:
            r = httpx.post(
                url,
                content=body,
                headers={"Content-Type": "application/json"},
                timeout=30.0,
            )
            if r.status_code < 300:
                print(f"[respond] webhook OK ({r.status_code})", file=sys.stderr)
                return
            print(f"[respond] webhook {r.status_code} (attempt {attempt + 1})", file=sys.stderr)
        except Exception as e:
            print(f"[respond] webhook 오류 (attempt {attempt + 1}): {e}", file=sys.stderr)
    print("[respond] webhook 전송 실패 (3회 시도)", file=sys.stderr)


async def _maybe_sessions_abort(findings: list[dict[str, Any]]) -> None:
    """
    4중 안전장치를 모두 통과해야 sessions.abort 실행.

    탐지 = 자동 악성 판정이 아니다. 오탐 위험이 있으므로 운영자가
    명시적으로 네 환경변수를 설정해야만 abort가 활성화된다.
    """
    if os.environ.get("SENTINEL_ENABLE_SESSIONS_ABORT") != "1":
        return

    ws_url = os.environ.get("OPENCLAW_GATEWAY_WS_URL", "").strip()
    token = os.environ.get("OPENCLAW_GATEWAY_TOKEN", "").strip()
    session_key = os.environ.get("OPENCLAW_GATEWAY_SESSION_KEY", "").strip()
    abort_confirm = os.environ.get("SENTINEL_SESSIONS_ABORT_CONFIRM", "").strip()
    break_glass = os.environ.get("SENTINEL_OPERATOR_BREAK_GLASS_ACK", "").strip()
    min_severity = os.environ.get("SENTINEL_ABORT_MIN_SEVERITY", "high").strip()

    if not session_key:
        print("[respond] OPENCLAW_GATEWAY_SESSION_KEY 미설정 — abort 건너뜀", file=sys.stderr)
        return
    if abort_confirm != session_key:
        print("[respond] SENTINEL_SESSIONS_ABORT_CONFIRM ≠ SESSION_KEY — abort 건너뜀", file=sys.stderr)
        return
    if break_glass != "I_UNDERSTAND_FALSE_POSITIVE_STOP":
        print("[respond] SENTINEL_OPERATOR_BREAK_GLASS_ACK 미설정 — abort 건너뜀", file=sys.stderr)
        return

    min_rank = _severity_rank(min_severity)
    worst = max(findings, key=lambda f: _severity_rank(f.get("severity", "info")), default=None)
    if not worst or _severity_rank(worst.get("severity", "info")) < min_rank:
        print(f"[respond] 최고 severity < {min_severity} — abort 건너뜀", file=sys.stderr)
        return

    if not ws_url or not token:
        print("[respond] WS URL/TOKEN 미설정 — abort 건너뜀", file=sys.stderr)
        return

    print(f"[respond] sessions.abort 실행: {session_key}", file=sys.stderr)
    try:
        sess = await GwSession.connect(
            ws_url, token=token, scopes=["operator.read", "operator.write"]
        )
        try:
            res = await sess.rpc("sessions.abort", {"sessionKey": session_key}, timeout_s=30.0)
            if res.get("ok"):
                print("[respond] sessions.abort 성공", file=sys.stderr)
            else:
                print(f"[respond] sessions.abort 실패: {res.get('error')}", file=sys.stderr)
        finally:
            await sess.close()
    except Exception as e:
        print(f"[respond] sessions.abort 예외: {e}", file=sys.stderr)


def run_respond(report: dict[str, Any], viz_out: Path | None = None) -> None:
    """findings report를 처리한다. run_scenario.py에서 직접 호출 가능."""
    _alert_stderr(report)
    if viz_out:
        _write_viz_file(report, viz_out)
    _maybe_webhook(report)
    findings = report.get("findings", [])
    if findings:
        asyncio.run(_maybe_sessions_abort(findings))


def main() -> None:
    p = argparse.ArgumentParser(description="Sentinel respond: findings → alert/viz/abort")
    p.add_argument("--input", default=None, help="findings JSON 파일 경로")
    p.add_argument("--out", default=None, help="viz JSON 저장 경로")
    p.add_argument("--stdin", action="store_true", help="stdin에서 findings JSON 읽기")
    args = p.parse_args()

    if args.stdin:
        report = json.loads(sys.stdin.read())
    elif args.input:
        report = _load_findings(Path(args.input))
    else:
        findings_env = os.environ.get("SENTINEL_FINDINGS_PATH", "")
        findings_path = (
            Path(findings_env)
            if findings_env
            else Path(__file__).resolve().parent / "data" / "findings.json"
        )
        report = _load_findings(findings_path)

    viz_out_str = args.out or os.environ.get("SENTINEL_VIZ_OUT_PATH", "")
    viz_out = Path(viz_out_str) if viz_out_str else None

    run_respond(report, viz_out)


if __name__ == "__main__":
    main()
