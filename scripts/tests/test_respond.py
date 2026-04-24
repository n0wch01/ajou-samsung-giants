"""Unit tests for sentinel/respond.py."""
import json
import sys
from pathlib import Path

import pytest

sys.path.insert(0, str(Path(__file__).resolve().parents[1]))

from sentinel.respond import _severity_rank, _alert_stderr, _write_viz_file, _load_findings


# ---------------------------------------------------------------------------
# _severity_rank
# ---------------------------------------------------------------------------

def test_severity_rank_order():
    assert _severity_rank("info") < _severity_rank("low")
    assert _severity_rank("low") < _severity_rank("medium")
    assert _severity_rank("medium") < _severity_rank("high")
    assert _severity_rank("high") < _severity_rank("critical")


def test_severity_rank_unknown_returns_zero():
    assert _severity_rank("unknown") == 0
    assert _severity_rank("") == 0


# ---------------------------------------------------------------------------
# _load_findings
# ---------------------------------------------------------------------------

def test_load_findings_valid(tmp_path: Path):
    f = tmp_path / "findings.json"
    data = {"findings": [{"id": "f1", "severity": "high", "ruleId": "r1", "title": "T", "message": "M"}]}
    f.write_text(json.dumps(data))
    result = _load_findings(f)
    assert result["findings"][0]["id"] == "f1"


def test_load_findings_not_dict(tmp_path: Path):
    f = tmp_path / "bad.json"
    f.write_text(json.dumps([1, 2, 3]))
    with pytest.raises(ValueError, match="JSON object"):
        _load_findings(f)


# ---------------------------------------------------------------------------
# _write_viz_file
# ---------------------------------------------------------------------------

def test_write_viz_file_creates_file(tmp_path: Path):
    out = tmp_path / "subdir" / "findings-latest.json"
    report = {
        "findings": [{"id": "f1", "severity": "critical", "ruleId": "r", "title": "T", "message": "M"}],
        "meta": {"rules_loaded": 1, "trace_rows": 5},
    }
    _write_viz_file(report, out)
    assert out.is_file()
    content = json.loads(out.read_text())
    assert "findings" in content
    assert content["findings"][0]["id"] == "f1"
    assert "meta" in content


def test_write_viz_file_empty_findings(tmp_path: Path):
    out = tmp_path / "empty.json"
    _write_viz_file({"findings": []}, out)
    content = json.loads(out.read_text())
    assert content["findings"] == []


# ---------------------------------------------------------------------------
# _alert_stderr — smoke test (just ensure it doesn't raise)
# ---------------------------------------------------------------------------

def test_alert_stderr_no_findings(capsys):
    _alert_stderr({"findings": []})
    captured = capsys.readouterr()
    assert "no findings" in captured.err


def test_alert_stderr_with_findings(capsys):
    report = {
        "findings": [
            {"id": "f1", "severity": "high", "ruleId": "r1", "title": "Bad thing", "message": "details"},
        ]
    }
    _alert_stderr(report)
    captured = capsys.readouterr()
    assert "1 finding" in captured.err
    assert "Bad thing" in captured.err
