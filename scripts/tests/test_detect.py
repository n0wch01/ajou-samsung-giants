"""Unit tests for sentinel/detect.py."""
import json
import textwrap
from pathlib import Path

import pytest

import sys
sys.path.insert(0, str(Path(__file__).resolve().parents[1]))

from sentinel.detect import (
    _load_baseline,
    _load_trace,
    _load_yaml_rules,
    _extract_tool_names,
    _last_tools_effective_names,
    _eval_rule,
    run_detect,
)


# ---------------------------------------------------------------------------
# _extract_tool_names
# ---------------------------------------------------------------------------

def test_extract_tool_names_flat_list():
    obj = [{"name": "exec"}, {"name": "read_file"}]
    assert _extract_tool_names(obj) == ["exec", "read_file"]


def test_extract_tool_names_dedup():
    obj = [{"name": "exec"}, {"name": "exec"}]
    assert _extract_tool_names(obj) == ["exec"]


def test_extract_tool_names_nested():
    obj = {"tools": [{"toolName": "shell"}, {"id": "browser"}]}
    names = _extract_tool_names(obj)
    assert "shell" in names
    assert "browser" in names


def test_extract_tool_names_empty():
    assert _extract_tool_names({}) == []
    assert _extract_tool_names([]) == []
    assert _extract_tool_names(None) == []


# ---------------------------------------------------------------------------
# _load_baseline
# ---------------------------------------------------------------------------

def test_load_baseline_with_tool_names(tmp_path: Path):
    f = tmp_path / "baseline.json"
    f.write_text(json.dumps({"tool_names": ["exec", "read_file"]}))
    assert _load_baseline(f) == {"exec", "read_file"}


def test_load_baseline_missing_file():
    assert _load_baseline(Path("/nonexistent/path.json")) == set()


def test_load_baseline_malformed_json(tmp_path: Path):
    f = tmp_path / "bad.json"
    f.write_text("not-json")
    assert _load_baseline(f) == set()


# ---------------------------------------------------------------------------
# _load_trace
# ---------------------------------------------------------------------------

def test_load_trace_valid(tmp_path: Path):
    f = tmp_path / "trace.jsonl"
    lines = [json.dumps({"entry_type": "meta", "ts_ms": 1}), json.dumps({"entry_type": "gateway_event"})]
    f.write_text("\n".join(lines) + "\n")
    rows = _load_trace(f)
    assert len(rows) == 2
    assert rows[0]["entry_type"] == "meta"


def test_load_trace_skips_malformed_lines(tmp_path: Path):
    f = tmp_path / "trace.jsonl"
    f.write_text('{"ok": 1}\nnot-json\n{"ok": 2}\n')
    rows = _load_trace(f)
    assert len(rows) == 2


def test_load_trace_missing_file():
    assert _load_trace(Path("/nonexistent/trace.jsonl")) == []


def test_load_trace_skips_blank_lines(tmp_path: Path):
    f = tmp_path / "trace.jsonl"
    f.write_text('\n\n{"entry_type": "meta"}\n\n')
    rows = _load_trace(f)
    assert len(rows) == 1


# ---------------------------------------------------------------------------
# _last_tools_effective_names
# ---------------------------------------------------------------------------

def test_last_tools_effective_names_returns_last():
    trace = [
        {"entry_type": "tools_snapshot", "rpc_method": "tools.effective",
         "payload_summary": {"tool_names": ["exec"]}},
        {"entry_type": "tools_snapshot", "rpc_method": "tools.effective",
         "payload_summary": {"tool_names": ["exec", "shell"]}},
    ]
    assert _last_tools_effective_names(trace) == ["exec", "shell"]


def test_last_tools_effective_names_ignores_catalog():
    trace = [
        {"entry_type": "tools_snapshot", "rpc_method": "tools.catalog",
         "payload_summary": {"tool_names": ["catalog_tool"]}},
    ]
    assert _last_tools_effective_names(trace) == []


def test_last_tools_effective_names_empty():
    assert _last_tools_effective_names([]) == []


# ---------------------------------------------------------------------------
# _eval_rule — trace_line_regex
# ---------------------------------------------------------------------------

def test_eval_rule_trace_line_regex_match():
    rule = {
        "id": "test-rule",
        "severity": "high",
        "title": "Test Match",
        "match": {"type": "trace_line_regex", "pattern": "mock-malicious-plugin"},
    }
    trace = [{"entry_type": "meta", "message": "loaded mock-malicious-plugin"}]
    trace_blob = json.dumps(trace[0])
    findings = _eval_rule(rule, trace=trace, baseline_names=set(), trace_blob=trace_blob)
    assert len(findings) == 1
    assert findings[0]["ruleId"] == "test-rule"
    assert findings[0]["severity"] == "high"


def test_eval_rule_trace_line_regex_no_match():
    rule = {
        "id": "test-rule",
        "severity": "high",
        "title": "Test",
        "match": {"type": "trace_line_regex", "pattern": "definitely-not-present-xyz"},
    }
    findings = _eval_rule(rule, trace=[], baseline_names=set(), trace_blob='{"ok": 1}')
    assert findings == []


def test_eval_rule_invalid_regex():
    rule = {
        "id": "bad",
        "severity": "high",
        "title": "Bad",
        "match": {"type": "trace_line_regex", "pattern": "[invalid"},
    }
    findings = _eval_rule(rule, trace=[], baseline_names=set(), trace_blob="anything")
    assert findings == []


# ---------------------------------------------------------------------------
# _eval_rule — tools_effective_diff
# ---------------------------------------------------------------------------

def test_eval_rule_tools_diff_detects_new_tool():
    rule = {
        "id": "diff-rule",
        "severity": "medium",
        "title": "New tool",
        "match": {"type": "tools_effective_diff", "added_regex": ".*"},
    }
    trace = [
        {"entry_type": "tools_snapshot", "rpc_method": "tools.effective",
         "payload_summary": {"tool_names": ["exec", "evil_plugin"]}},
    ]
    baseline = {"exec"}
    findings = _eval_rule(rule, trace=trace, baseline_names=baseline, trace_blob="")
    names = [f["message"] for f in findings]
    assert any("evil_plugin" in m for m in names)


def test_eval_rule_tools_diff_no_baseline_warns():
    rule = {
        "id": "diff-rule",
        "severity": "medium",
        "title": "New tool",
        "match": {"type": "tools_effective_diff", "added_regex": ".*"},
    }
    findings = _eval_rule(rule, trace=[], baseline_names=set(), trace_blob="")
    assert any("baseline" in f["title"].lower() or "baseline" in f["message"].lower() for f in findings)


# ---------------------------------------------------------------------------
# run_detect — integration
# ---------------------------------------------------------------------------

def test_run_detect_returns_report(tmp_path: Path):
    trace_file = tmp_path / "trace.jsonl"
    trace_file.write_text(
        json.dumps({"entry_type": "meta", "ts_ms": 1, "message": "sentinel ingest start"}) + "\n"
        + json.dumps({
            "entry_type": "gateway_event", "event_name": "session.tool",
            "normalized": {"kind": "session.tool"},
            "raw_frame": {"event": "session.tool", "payload": {"name": "exec"}},
        }) + "\n"
    )
    rules_dir = tmp_path / "rules"
    rules_dir.mkdir()
    rule_file = rules_dir / "test.yaml"
    rule_file.write_text(textwrap.dedent("""
        version: 1
        rules:
          - id: always-fires
            severity: info
            title: Always fires
            message: This rule always matches.
            match:
              type: trace_line_regex
              pattern: 'sentinel ingest start'
    """))

    report = run_detect(trace_path=trace_file, rules_dir=rules_dir, baseline_path=None)
    assert "findings" in report
    assert report["meta"]["rules_loaded"] == 1
    assert report["meta"]["trace_rows"] == 2
    assert any(f["ruleId"] == "always-fires" for f in report["findings"])
