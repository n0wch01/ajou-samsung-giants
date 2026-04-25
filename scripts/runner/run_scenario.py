#!/usr/bin/env python3
"""
Scenario Runner — 시나리오 YAML → OpenClaw 실행 → sentinel 탐지 → 결과 저장

파이프라인:
  1. 게이트웨이 연결 + 세션 구독
  2. 툴 스냅샷 기록 (trace.jsonl)
  3. 시나리오 프롬프트 전송 (chat.send)
  4. [실시간] RealTimeRateDetector로 이벤트 모니터링 → 탐지 시 sessions.abort
  5. 타임아웃 후 [배치] detect.py로 trace.jsonl 재분석
  6. findings JSON 저장 + respond.py로 최종 출력

사용법:
  python run_scenario.py --scenario ../../scenarios/s3-api-abuse.yaml
  python run_scenario.py --scenario ../../scenarios/s3-api-abuse.yaml --timeout 60
"""
from __future__ import annotations

import argparse
import asyncio
import json
import os
import sys
import uuid
from datetime import datetime, timezone
from pathlib import Path

import yaml

# sentinel + scripts 경로 추가
_SCRIPTS_DIR = Path(__file__).resolve().parents[1]
_SENTINEL_DIR = _SCRIPTS_DIR / "sentinel"
for _p in (_SCRIPTS_DIR, _SENTINEL_DIR):
    if str(_p) not in sys.path:
        sys.path.insert(0, str(_p))

from ingest import EventIngest, _default_trace_path  # noqa: E402
from detect import RealTimeRateDetector, run_detect, _load_yaml_rules  # noqa: E402
from respond import run_respond  # noqa: E402


def _load_gateway_config() -> tuple[str, str]:
    """(ws_url, token) — 환경변수 우선, 없으면 ~/.openclaw/openclaw.json 참조."""
    ws_url = os.environ.get("OPENCLAW_GATEWAY_WS_URL", "ws://127.0.0.1:18789")
    token = os.environ.get("OPENCLAW_GATEWAY_TOKEN", "")
    if not token:
        config_path = Path.home() / ".openclaw" / "openclaw.json"
        if config_path.exists():
            cfg = json.loads(config_path.read_text())
            token = cfg.get("gateway", {}).get("auth", {}).get("token", "")
    if not token:
        raise RuntimeError(
            "게이트웨이 토큰을 찾을 수 없습니다. "
            "OPENCLAW_GATEWAY_TOKEN 환경변수를 설정하거나 openclaw configure를 실행하세요."
        )
    return ws_url, token


async def run_scenario(scenario_path: str, timeout: int = 120) -> dict:
    """시나리오를 실행하고 결과 dict를 반환."""

    # ── 1) 시나리오 로드 ───────────────────────────────────────────────────
    scenario_file = Path(scenario_path)
    if not scenario_file.exists():
        print(f"[runner] 시나리오 파일 없음: {scenario_file}", file=sys.stderr)
        sys.exit(1)

    scenario = yaml.safe_load(scenario_file.read_text(encoding="utf-8"))
    scenario_id = scenario["scenario_id"]
    input_prompt = scenario["input_prompt"]

    print(f"\n{'=' * 60}")
    print(f"[runner] 시나리오: {scenario['name']}")
    print(f"[runner] ID      : {scenario_id}")
    print(f"[runner] 위협    : {scenario['threat_type']}")
    print(f"[runner] 타임아웃: {timeout}초")
    print(f"{'=' * 60}\n")

    # ── 2) 경로 설정 ──────────────────────────────────────────────────────
    project_root = Path(__file__).resolve().parents[2]
    runs_dir = project_root / "runs"
    runs_dir.mkdir(parents=True, exist_ok=True)

    trace_path = Path(
        os.environ.get("SENTINEL_TRACE_PATH")
        or str(_default_trace_path())
    )
    rules_dir = _SENTINEL_DIR / "rules"
    findings_path = runs_dir / f"findings-{scenario_id}.json"

    ws_url, token = _load_gateway_config()

    # ── 3) sentinel 컴포넌트 초기화 ───────────────────────────────────────
    ingest = EventIngest(
        ws_url,
        token,
        trace_path,
        include_raw=True,
        redact=True,
    )

    rules = _load_yaml_rules(rules_dir)
    rt_detector = RealTimeRateDetector(rules)

    run_id = f"run-{datetime.now().strftime('%Y%m%d-%H%M%S')}-{uuid.uuid4().hex[:6]}"
    started_at = datetime.now(timezone.utc).isoformat()
    rt_findings: list[dict] = []
    abort_triggered = False
    session_key = os.environ.get("OPENCLAW_GATEWAY_SESSION_KEY", "agent:main:main")

    def on_event(normalized: dict) -> None:
        nonlocal abort_triggered
        kind = normalized.get("kind", "")
        tool = normalized.get("name") or normalized.get("tool") or normalized.get("toolName")
        if kind == "session.tool" and tool:
            phase = normalized.get("phase", "")
            print(f"  [tool] {tool}  phase={phase}", file=sys.stderr)

        new_findings = rt_detector.process(normalized)
        if new_findings and not abort_triggered:
            abort_triggered = True
            rt_findings.extend(new_findings)
            for f in new_findings:
                print(f"\n[runner] 탐지: [{f['severity'].upper()}] {f['ruleId']} — {f['message']}", file=sys.stderr)
            asyncio.get_event_loop().create_task(
                ingest.rpc("sessions.abort", {"sessionKey": session_key})
            )
            print("[runner] sessions.abort 요청 전송", file=sys.stderr)

    ingest.on_event(on_event)

    try:
        # ── 4) 연결 + 구독 + 스냅샷 ─────────────────────────────────────
        print("[runner] 게이트웨이 연결 중...", file=sys.stderr)
        await ingest.connect()
        await ingest.subscribe_session(session_key)
        await ingest.snapshot_tools(session_key)

        # ── 5) 프롬프트 전송 ─────────────────────────────────────────────
        print(f"[runner] 프롬프트 전송: {input_prompt[:80]}...", file=sys.stderr)
        send_result = await ingest.rpc("chat.send", {
            "sessionKey": session_key,
            "idempotencyKey": str(uuid.uuid4()),
            "message": input_prompt,
        })
        if not send_result.get("ok"):
            print(f"[runner] 프롬프트 전송 실패: {send_result.get('error', {})}", file=sys.stderr)
            await ingest.close()
            sys.exit(1)
        print("[runner] 프롬프트 전송 완료 — 모니터링 시작\n", file=sys.stderr)

        # ── 6) 이벤트 수신 루프 + 타임아웃 ──────────────────────────────
        listen_task = asyncio.create_task(ingest.listen())
        try:
            await asyncio.wait_for(listen_task, timeout=timeout)
        except asyncio.TimeoutError:
            print(f"\n[runner] 타임아웃 ({timeout}초) 도달", file=sys.stderr)
            listen_task.cancel()
            try:
                await listen_task
            except asyncio.CancelledError:
                pass

    except Exception as e:
        import traceback
        print(f"\n[runner] 오류: {e}", file=sys.stderr)
        traceback.print_exc()

    finally:
        await ingest.close()

    # ── 7) 배치 detect — trace.jsonl 재분석 ─────────────────────────────
    print("\n[runner] 배치 detect 실행 중...", file=sys.stderr)
    batch_report = run_detect(trace_path, rules_dir)
    # 실시간 탐지 결과를 배치 report에 병합 (중복 제거: ruleId 기준)
    existing_rule_ids = {f["ruleId"] for f in batch_report["findings"]}
    for f in rt_findings:
        if f["ruleId"] not in existing_rule_ids:
            batch_report["findings"].append(f)
    findings_path.write_text(json.dumps(batch_report, ensure_ascii=False, indent=2), encoding="utf-8")
    print(f"[runner] findings → {findings_path}", file=sys.stderr)

    # ── 8) respond — alert 출력 ──────────────────────────────────────────
    viz_out_str = os.environ.get("SENTINEL_VIZ_OUT_PATH", "")
    run_respond(batch_report, Path(viz_out_str) if viz_out_str else None)

    # ── 9) 판정 ──────────────────────────────────────────────────────────
    all_findings = batch_report.get("findings", [])
    if abort_triggered:
        verdict = "BLOCKED"
        verdict_reason = rt_findings[0]["message"] + " → sentinel이 세션을 중단함."
    elif all_findings:
        verdict = "DETECTED"
        verdict_reason = f"{len(all_findings)}개 finding 탐지됨 (실시간 abort 미발동)."
    else:
        verdict = "PASS"
        verdict_reason = "모든 탐지 규칙 미발화. 도구 호출이 정상 범위 내."

    # ── 10) 실행 결과 저장 ────────────────────────────────────────────────
    result = {
        "run_id": run_id,
        "scenario_id": scenario_id,
        "session_key": session_key,
        "started_at": started_at,
        "ended_at": datetime.now(timezone.utc).isoformat(),
        "findings_count": len(all_findings),
        "findings_path": str(findings_path),
        "abort_triggered": abort_triggered,
        "verdict": verdict,
        "verdict_reason": verdict_reason,
    }

    result_file = runs_dir / f"{run_id}.json"
    result_file.write_text(json.dumps(result, ensure_ascii=False, indent=2), encoding="utf-8")

    print(f"\n{'=' * 60}")
    print(f"  실행 결과 요약")
    print(f"{'=' * 60}")
    print(f"  Run ID   : {run_id}")
    print(f"  Scenario : {scenario_id}")
    print(f"  Findings : {len(all_findings)}")
    print(f"  Abort    : {abort_triggered}")
    print(f"  Verdict  : {verdict}")
    print(f"  Reason   : {verdict_reason}")
    print(f"{'=' * 60}\n")

    return result


def main() -> None:
    p = argparse.ArgumentParser(description="OpenClaw S3 보안 시나리오 실행기")
    p.add_argument("--scenario", required=True, help="시나리오 YAML 파일 경로")
    p.add_argument("--timeout", type=int, default=120, help="실행 타임아웃 (초, 기본: 120)")
    p.add_argument("--session-key", default=None, help="게이트웨이 세션 key (기본: agent:main:main)")
    args = p.parse_args()

    if args.session_key:
        os.environ["OPENCLAW_GATEWAY_SESSION_KEY"] = args.session_key

    try:
        asyncio.run(run_scenario(args.scenario, args.timeout))
    except KeyboardInterrupt:
        pass


if __name__ == "__main__":
    main()
