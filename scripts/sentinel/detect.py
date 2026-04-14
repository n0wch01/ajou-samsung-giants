"""
Sentinel Detect - 호출 빈도 기반 위협 탐지

ingest에서 수신한 tool_call 이벤트를 슬라이딩 윈도우로 분석하여
API Abuse / DoS 패턴(반복 호출, 무한 루프)을 탐지한다.
"""

import time
from collections import defaultdict, deque
from dataclasses import dataclass, field
from pathlib import Path

import yaml


@dataclass
class Detection:
    """탐지 결과."""
    rule_id: str
    severity: str
    tool: str
    count: int
    window: int
    threshold: int
    message: str
    timestamp: float = field(default_factory=time.time)


class RateLimitDetector:
    """슬라이딩 윈도우 기반 호출 빈도 탐지기."""

    def __init__(self, rules_dir: Path):
        self.rules = self._load_rules(rules_dir)
        # tool별 호출 타임스탬프 큐
        self._call_windows: dict[str, deque] = defaultdict(deque)
        # 동일 인자 연속 호출 추적
        self._consecutive_tracker: dict[str, list] = defaultdict(list)
        self._detection_callbacks = []

    def on_detection(self, callback):
        """탐지 발생 시 콜백 등록. callback(Detection) 형태."""
        self._detection_callbacks.append(callback)

    def _load_rules(self, rules_dir: Path) -> list[dict]:
        """YAML 규칙 파일 로드."""
        rules = []
        if not rules_dir.exists():
            print(f"[detect] 규칙 디렉토리 없음: {rules_dir}")
            return rules
        for f in rules_dir.glob("*.yaml"):
            with open(f) as fh:
                rule = yaml.safe_load(fh)
                rules.append(rule)
                print(f"[detect] 규칙 로드: {rule['rule_id']} ({rule['name']})")
        return rules

    def check(self, event: dict) -> Detection | None:
        """이벤트를 분석하여 탐지 규칙에 해당하는지 확인."""
        if event.get("kind") != "tool_call":
            return None

        tool = event["tool"]
        now = time.time()
        args_key = str(event.get("args", {}))

        for rule in self.rules:
            conditions = rule.get("conditions", {})
            window_sec = conditions.get("window_seconds", 30)
            max_calls = conditions.get("max_calls", 10)
            max_identical = conditions.get("max_identical_consecutive", 5)
            warning_threshold = rule.get("actions", {}).get("on_warning", {}).get("threshold", 7)

            # 1) 슬라이딩 윈도우 빈도 체크
            window = self._call_windows[tool]
            window.append(now)

            # 윈도우 밖의 오래된 항목 제거
            while window and window[0] < now - window_sec:
                window.popleft()

            count = len(window)

            # 경고 단계
            if count >= warning_threshold and count < max_calls:
                msg = rule["actions"]["on_warning"]["message"].format(
                    count=count, window=window_sec
                )
                print(f"[detect] WARNING: {msg}")

            # 임계값 초과 → 탐지
            if count >= max_calls:
                detection = Detection(
                    rule_id=rule["rule_id"],
                    severity=rule.get("severity", "high"),
                    tool=tool,
                    count=count,
                    window=window_sec,
                    threshold=max_calls,
                    message=rule["actions"]["on_trigger"]["message"].format(
                        tool=tool, window=window_sec, count=count, max=max_calls
                    ),
                )
                for cb in self._detection_callbacks:
                    cb(detection)
                return detection

            # 2) 동일 인자 연속 호출 체크 (루프 탐지)
            consecutive = self._consecutive_tracker[tool]
            if consecutive and consecutive[-1] == args_key:
                consecutive.append(args_key)
            else:
                self._consecutive_tracker[tool] = [args_key]
                consecutive = self._consecutive_tracker[tool]

            if len(consecutive) >= max_identical:
                detection = Detection(
                    rule_id=rule["rule_id"] + "-loop",
                    severity="critical",
                    tool=tool,
                    count=len(consecutive),
                    window=0,
                    threshold=max_identical,
                    message=f"루프 탐지: {tool}이 동일 인자로 {len(consecutive)}회 연속 호출됨",
                )
                for cb in self._detection_callbacks:
                    cb(detection)
                return detection

        return None

    def reset(self):
        """탐지 상태 초기화."""
        self._call_windows.clear()
        self._consecutive_tracker.clear()
