"""
Sentinel Respond - 위협 탐지 시 Agent 중단 및 결과 기록

detect에서 탐지가 발생하면 sessions.abort RPC를 호출하여 Agent를 중단하고,
실행 결과를 JSON 파일로 저장한다.
"""

import json
import uuid
from datetime import datetime, timezone
from pathlib import Path

from detect import Detection


class Responder:
    """탐지 결과에 따라 Agent를 중단하고 결과를 기록."""

    def __init__(self, ingest, runs_dir: Path):
        self.ingest = ingest  # EventIngest 인스턴스 (RPC 전송용)
        self.runs_dir = runs_dir
        self.runs_dir.mkdir(parents=True, exist_ok=True)

        self.run_id = f"run-{datetime.now().strftime('%Y%m%d-%H%M%S')}-{uuid.uuid4().hex[:6]}"
        self.events = []
        self.detections = []
        self.aborted = False
        self.started_at = datetime.now(timezone.utc).isoformat()

    def record_event(self, event: dict):
        """이벤트를 실행 기록에 추가."""
        self.events.append(event)

    def record_detection(self, detection: Detection):
        """탐지 결과를 기록."""
        self.detections.append({
            "rule_id": detection.rule_id,
            "severity": detection.severity,
            "tool": detection.tool,
            "count": detection.count,
            "window": detection.window,
            "threshold": detection.threshold,
            "message": detection.message,
            "timestamp": datetime.fromtimestamp(
                detection.timestamp, tz=timezone.utc
            ).isoformat(),
        })

    async def abort_session(self, session_key: str, detection: Detection):
        """sessions.abort RPC로 Agent를 중단."""
        if self.aborted:
            return

        print(f"\n[respond] === AGENT 중단 ===")
        print(f"[respond] 사유: {detection.message}")
        print(f"[respond] 규칙: {detection.rule_id} (severity: {detection.severity})")

        try:
            result = await self.ingest._send_req(
                "sessions.abort",
                {"sessionKey": session_key},
            )
            self.aborted = True
            if result.get("ok"):
                print(f"[respond] sessions.abort 성공")
            else:
                print(f"[respond] sessions.abort 실패: {result.get('error', 'unknown')}")
        except Exception as e:
            print(f"[respond] sessions.abort 예외: {e}")

    def save_result(self, scenario_id: str, session_key: str, verdict: str, verdict_reason: str):
        """실행 결과를 JSON 파일로 저장."""
        tools_called = [
            e for e in self.events if e.get("kind") == "tool_call"
        ]

        result = {
            "run_id": self.run_id,
            "scenario_id": scenario_id,
            "session_key": session_key,
            "started_at": self.started_at,
            "ended_at": datetime.now(timezone.utc).isoformat(),
            "model": "ollama/deepseek-r1:1.5b",
            "tools_called": [
                {
                    "tool": e["tool"],
                    "timestamp": e["timestamp"],
                    "args": e.get("args", {}),
                    "is_error": e.get("is_error", False),
                }
                for e in tools_called
            ],
            "total_tool_calls": len(tools_called),
            "detections": self.detections,
            "action_taken": "sessions.abort" if self.aborted else "none",
            "verdict": verdict,
            "verdict_reason": verdict_reason,
            "events_total": len(self.events),
        }

        result_file = self.runs_dir / f"{self.run_id}.json"
        with open(result_file, "w") as f:
            json.dump(result, f, indent=2, ensure_ascii=False)

        print(f"\n[respond] 결과 저장: {result_file}")
        print(f"[respond] verdict: {verdict}")
        print(f"[respond] reason: {verdict_reason}")
        print(f"[respond] tool 호출 횟수: {len(tools_called)}")

        return result
