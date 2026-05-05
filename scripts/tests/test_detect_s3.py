"""Unit tests for S3 (API Abuse) detect logic — rate_limit / loop_detect / RealTimeRateDetector."""
import sys
from pathlib import Path

sys.path.insert(0, str(Path(__file__).resolve().parents[1]))

from sentinel.detect import (
    _eval_rule,
    RealTimeRateDetector,
)


def _tool_event(tool: str, ts_ms: int, *, args: dict | None = None, text: str = "") -> dict:
    """Helper: build a trace entry shaped like ingest._trace_record(... gateway_event ...)."""
    norm: dict = {"event": "session.tool", "kind": "session.tool", "name": tool}
    if text:
        norm["text_preview"] = text
    entry: dict = {
        "entry_type": "gateway_event",
        "event_name": "session.tool",
        "ts_ms": ts_ms,
        "normalized": norm,
    }
    if args is not None:
        entry["raw_frame"] = {"type": "event", "event": "session.tool", "payload": {"input": args}}
    return entry


# ---------------------------------------------------------------------------
# rate_limit
# ---------------------------------------------------------------------------

def test_rate_limit_fires_when_threshold_met():
    rule = {
        "id": "s3-rate",
        "severity": "high",
        "title": "Rate",
        "match": {"type": "rate_limit", "window_seconds": 30, "max_calls": 5},
    }
    # 6 calls within 10 seconds → exceeds max_calls=5
    trace = [_tool_event("read_file", 1000 + i * 1000) for i in range(6)]
    findings = _eval_rule(rule, trace=trace, baseline_names=set(), trace_blob="")
    assert len(findings) == 1
    assert findings[0]["ruleId"] == "s3-rate"
    assert findings[0]["severity"] == "high"


def test_rate_limit_does_not_fire_below_threshold():
    rule = {
        "id": "s3-rate",
        "severity": "high",
        "title": "Rate",
        "match": {"type": "rate_limit", "window_seconds": 30, "max_calls": 10},
    }
    trace = [_tool_event("read_file", 1000 + i * 1000) for i in range(5)]
    findings = _eval_rule(rule, trace=trace, baseline_names=set(), trace_blob="")
    assert findings == []


def test_rate_limit_window_excludes_old_calls():
    """Calls outside the sliding window should not count."""
    rule = {
        "id": "s3-rate",
        "severity": "high",
        "title": "Rate",
        "match": {"type": "rate_limit", "window_seconds": 30, "max_calls": 5},
    }
    # 4 calls at t=0..3s, then 4 more at t=100s (well past window)
    trace = (
        [_tool_event("read_file", i * 1000) for i in range(4)]
        + [_tool_event("read_file", 100_000 + i * 1000) for i in range(4)]
    )
    findings = _eval_rule(rule, trace=trace, baseline_names=set(), trace_blob="")
    assert findings == []


def test_rate_limit_per_tool_isolation():
    """Different tools have independent counters."""
    rule = {
        "id": "s3-rate",
        "severity": "high",
        "title": "Rate",
        "match": {"type": "rate_limit", "window_seconds": 30, "max_calls": 5},
    }
    trace = [
        _tool_event("read_file" if i % 2 == 0 else "write_file", i * 100)
        for i in range(8)
    ]
    findings = _eval_rule(rule, trace=trace, baseline_names=set(), trace_blob="")
    assert findings == []


def test_rate_limit_tools_filter_includes_only_listed():
    rule = {
        "id": "s3-rate",
        "severity": "high",
        "title": "Rate",
        "match": {
            "type": "rate_limit",
            "window_seconds": 30,
            "max_calls": 3,
            "tools": ["read_file"],
        },
    }
    trace = [_tool_event("write_file", i * 100) for i in range(10)]
    findings = _eval_rule(rule, trace=trace, baseline_names=set(), trace_blob="")
    assert findings == []


# ---------------------------------------------------------------------------
# loop_detect
# ---------------------------------------------------------------------------

def test_loop_detect_fires_on_consecutive_identical_args():
    rule = {
        "id": "s3-loop",
        "severity": "critical",
        "title": "Loop",
        "match": {"type": "loop_detect", "max_identical_consecutive": 5},
    }
    trace = [_tool_event("read_file", i * 100, args={"path": "src/main.py"}) for i in range(5)]
    findings = _eval_rule(rule, trace=trace, baseline_names=set(), trace_blob="")
    assert len(findings) == 1
    assert findings[0]["ruleId"] == "s3-loop"
    assert findings[0]["severity"] == "critical"


def test_loop_detect_no_fire_when_args_vary():
    rule = {
        "id": "s3-loop",
        "severity": "critical",
        "title": "Loop",
        "match": {"type": "loop_detect", "max_identical_consecutive": 3},
    }
    trace = [
        _tool_event("read_file", i * 100, args={"path": f"src/file{i}.py"})
        for i in range(6)
    ]
    findings = _eval_rule(rule, trace=trace, baseline_names=set(), trace_blob="")
    assert findings == []


def test_loop_detect_resets_on_different_tool_in_between():
    rule = {
        "id": "s3-loop",
        "severity": "critical",
        "title": "Loop",
        "match": {"type": "loop_detect", "max_identical_consecutive": 3},
    }
    # 2x same args, then a different tool, then 2x same args again — no run hits 3.
    trace = [
        _tool_event("read_file", 100, args={"path": "a"}),
        _tool_event("read_file", 200, args={"path": "a"}),
        _tool_event("write_file", 300, args={"path": "log"}),
        _tool_event("read_file", 400, args={"path": "a"}),
        _tool_event("read_file", 500, args={"path": "a"}),
    ]
    findings = _eval_rule(rule, trace=trace, baseline_names=set(), trace_blob="")
    assert findings == []


def test_loop_detect_falls_back_to_text_preview_when_no_raw_payload():
    rule = {
        "id": "s3-loop",
        "severity": "critical",
        "title": "Loop",
        "match": {"type": "loop_detect", "max_identical_consecutive": 3},
    }
    # No `args` (raw_frame absent) → must use normalized.text_preview as args key
    trace = [_tool_event("read_file", i * 100, text="reading src/main.py") for i in range(3)]
    findings = _eval_rule(rule, trace=trace, baseline_names=set(), trace_blob="")
    assert len(findings) == 1


# ---------------------------------------------------------------------------
# RealTimeRateDetector
# ---------------------------------------------------------------------------

def test_realtime_rate_fires_when_threshold_crossed():
    rules = [
        {
            "id": "s3-rate",
            "severity": "high",
            "title": "Rate",
            "match": {"type": "rate_limit", "window_seconds": 30, "max_calls": 3},
        }
    ]
    det = RealTimeRateDetector(rules)
    fired = []
    for i in range(3):
        fired.append(det.process(_tool_event("read_file", i * 1000)))
    # 1st and 2nd: empty; 3rd: fires (count == 3 == max)
    assert fired[0] == []
    assert fired[1] == []
    assert len(fired[2]) == 1
    assert fired[2][0]["ruleId"] == "s3-rate"


def test_realtime_rate_window_evicts_old_calls():
    rules = [
        {
            "id": "s3-rate",
            "severity": "high",
            "title": "Rate",
            "match": {"type": "rate_limit", "window_seconds": 5, "max_calls": 3},
        }
    ]
    det = RealTimeRateDetector(rules)
    # 2 calls at t=0..1s
    det.process(_tool_event("read_file", 0))
    det.process(_tool_event("read_file", 1000))
    # next call at t=100s — old ones are now outside the 5s window
    out = det.process(_tool_event("read_file", 100_000))
    assert out == []


def test_realtime_loop_detect_fires_on_consecutive_args():
    rules = [
        {
            "id": "s3-loop",
            "severity": "critical",
            "title": "Loop",
            "match": {"type": "loop_detect", "max_identical_consecutive": 3},
        }
    ]
    det = RealTimeRateDetector(rules)
    fired = []
    for i in range(3):
        fired.append(det.process(_tool_event("read_file", i * 100, args={"path": "src/main.py"})))
    assert fired[0] == []
    assert fired[1] == []
    assert len(fired[2]) == 1
    assert fired[2][0]["severity"] == "critical"


def test_realtime_loop_detect_resets_on_arg_change():
    rules = [
        {
            "id": "s3-loop",
            "severity": "critical",
            "title": "Loop",
            "match": {"type": "loop_detect", "max_identical_consecutive": 3},
        }
    ]
    det = RealTimeRateDetector(rules)
    det.process(_tool_event("read_file", 100, args={"path": "a"}))
    det.process(_tool_event("read_file", 200, args={"path": "a"}))
    # Different args → reset
    out = det.process(_tool_event("read_file", 300, args={"path": "b"}))
    assert out == []


def test_realtime_reset_clears_state():
    rules = [
        {
            "id": "s3-rate",
            "severity": "high",
            "title": "Rate",
            "match": {"type": "rate_limit", "window_seconds": 30, "max_calls": 3},
        }
    ]
    det = RealTimeRateDetector(rules)
    for i in range(2):
        det.process(_tool_event("read_file", i * 100))
    det.reset()
    out = det.process(_tool_event("read_file", 1000))
    assert out == []
