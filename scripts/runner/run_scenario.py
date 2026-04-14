#!/usr/bin/env python3
"""
Scenario Runner - 시나리오 기반 OpenClaw 보안 테스트 실행기

시나리오 YAML을 읽고 → OpenClaw에 프롬프트 전송 → sentinel로 모니터링 →
위협 탐지 시 Agent 중단 → 결과 저장까지 전체 파이프라인을 실행한다.

사용법:
  python run_scenario.py --scenario ../../scenarios/s3-api-abuse.yaml
  python run_scenario.py --scenario ../../scenarios/s3-api-abuse.yaml --timeout 60
"""

import argparse
import asyncio
import json
import os
import sys
from pathlib import Path

import yaml

# sentinel 모듈 경로 추가
sys.path.insert(0, str(Path(__file__).parent.parent / "sentinel"))
from ingest import EventIngest
from detect import RateLimitDetector, Detection
from respond import Responder


def _load_gateway_token() -> str:
    """게이트웨이 auth 토큰 로드 (환경변수 > OpenClaw 설정 파일)."""
    env_token = os.environ.get("OPENCLAW_GATEWAY_TOKEN")
    if env_token:
        return env_token
    config_path = Path.home() / ".openclaw" / "openclaw.json"
    if config_path.exists():
        with open(config_path) as f:
            cfg = json.load(f)
        token = cfg.get("gateway", {}).get("auth", {}).get("token")
        if token:
            return token
    raise RuntimeError(
        "게이트웨이 토큰을 찾을 수 없습니다. "
        "OPENCLAW_GATEWAY_TOKEN 환경변수를 설정하거나 openclaw configure를 실행하세요."
    )


GATEWAY_WS_URL = os.environ.get("OPENCLAW_GATEWAY_URL", "ws://127.0.0.1:18789")
GATEWAY_AUTH_TOKEN = _load_gateway_token()


async def run_scenario(scenario_path: str, timeout: int = 120):
    """시나리오를 실행하고 결과를 반환."""

    # 1) 시나리오 로드
    scenario_file = Path(scenario_path)
    if not scenario_file.exists():
        print(f"[runner] 시나리오 파일 없음: {scenario_file}")
        sys.exit(1)

    with open(scenario_file) as f:
        scenario = yaml.safe_load(f)

    scenario_id = scenario["scenario_id"]
    input_prompt = scenario["input_prompt"]
    print(f"\n{'='*60}")
    print(f"[runner] 시나리오: {scenario['name']}")
    print(f"[runner] ID: {scenario_id}")
    print(f"[runner] 위협 유형: {scenario['threat_type']}")
    print(f"[runner] 타임아웃: {timeout}초")
    print(f"{'='*60}\n")

    # 2) sentinel 컴포넌트 초기화
    project_root = Path(__file__).parent.parent.parent
    trace_dir = project_root / "runs" / "traces"
    runs_dir = project_root / "runs"
    rules_dir = Path(__file__).parent.parent / "sentinel" / "rules"

    ingest = EventIngest(GATEWAY_WS_URL, GATEWAY_AUTH_TOKEN, trace_dir)
    detector = RateLimitDetector(rules_dir)
    responder = Responder(ingest, runs_dir)

    detection_triggered = False
    session_key = None

    def on_event(event):
        """이벤트 수신 콜백: 기록 + 탐지."""
        nonlocal detection_triggered
        responder.record_event(event)

        if event["kind"] == "tool_call":
            tool = event["tool"]
            phase = event.get("phase", "")
            print(f"  [tool] {tool} (phase: {phase})")

        result = detector.check(event)
        if result and not detection_triggered:
            detection_triggered = True
            responder.record_detection(result)
            asyncio.get_event_loop().create_task(
                responder.abort_session(ingest.session_key, result)
            )

    ingest.on_event(on_event)

    try:
        # 3) 게이트웨이 연결
        print("[runner] 게이트웨이 연결 중...")
        await ingest.connect()

        # 4) 기존 메인 세션 사용
        session_key = "agent:main:main"
        print(f"[runner] 세션 사용: {session_key}")

        # 5) 세션 이벤트 구독
        await ingest.subscribe_session(session_key)

        # 6) 프롬프트 전송 (chat.send 사용)
        print(f"[runner] 프롬프트 전송: {input_prompt[:80]}...")
        import uuid as _uuid
        send_result = await ingest._send_req("chat.send", {
            "sessionKey": session_key,
            "idempotencyKey": str(_uuid.uuid4()),
            "message": input_prompt,
        })
        if not send_result.get("ok"):
            print(f"[runner] 프롬프트 전송 실패: {send_result.get('error', {})}")
            await ingest.close()
            sys.exit(1)
        print("[runner] 프롬프트 전송 완료, 모니터링 시작...\n")

        # 7) 이벤트 수신 + 타임아웃
        try:
            await asyncio.wait_for(ingest.listen(), timeout=timeout)
        except asyncio.TimeoutError:
            print(f"\n[runner] 타임아웃 ({timeout}초) 도달")
        except websockets.exceptions.ConnectionClosedOK:
            print("\n[runner] WS 연결 정상 종료")
        except websockets.exceptions.ConnectionClosedError:
            print("\n[runner] WS 연결 끊김")

    except Exception as e:
        print(f"\n[runner] 오류: {e}")
        import traceback
        traceback.print_exc()

    finally:
        await ingest.close()

    # 8) 판정
    if detection_triggered and responder.aborted:
        verdict = "BLOCKED"
        verdict_reason = responder.detections[0]["message"] + " → sentinel이 세션을 중단함."
    elif detection_triggered and not responder.aborted:
        verdict = "FAIL"
        verdict_reason = "탐지는 발생했으나 세션 중단에 실패함."
    else:
        verdict = "PASS"
        verdict_reason = "모든 탐지 규칙 미발화. 도구 호출이 정상 범위 내."

    # 9) 결과 저장
    result = responder.save_result(scenario_id, session_key, verdict, verdict_reason)

    # 10) 요약 출력
    print(f"\n{'='*60}")
    print(f"  실행 결과 요약")
    print(f"{'='*60}")
    print(f"  Run ID     : {result['run_id']}")
    print(f"  Scenario   : {scenario_id}")
    print(f"  Tool Calls : {result['total_tool_calls']}")
    print(f"  Detections : {len(result['detections'])}")
    print(f"  Action     : {result['action_taken']}")
    print(f"  Verdict    : {verdict}")
    print(f"  Reason     : {verdict_reason}")
    print(f"{'='*60}\n")

    return result


def main():
    parser = argparse.ArgumentParser(description="OpenClaw 보안 시나리오 실행기")
    parser.add_argument(
        "--scenario", required=True,
        help="시나리오 YAML 파일 경로",
    )
    parser.add_argument(
        "--timeout", type=int, default=120,
        help="실행 타임아웃 (초, 기본: 120)",
    )
    args = parser.parse_args()

    asyncio.run(run_scenario(args.scenario, args.timeout))


if __name__ == "__main__":
    main()
