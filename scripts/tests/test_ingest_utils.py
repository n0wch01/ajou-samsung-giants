"""Unit tests for ingest.py utilities (no WS connection needed)."""
import json
import sys
from pathlib import Path

import pytest

sys.path.insert(0, str(Path(__file__).resolve().parents[1]))

from sentinel.ingest import (
    _normalize_gateway_event,
    _extract_tool_names,
    _payload_tool_count,
    _redact_secrets,
    _maybe_redact,
    _rotate_trace_if_needed,
)


# ---------------------------------------------------------------------------
# _normalize_gateway_event
# ---------------------------------------------------------------------------

def test_normalize_session_tool_event():
    frame = {
        "type": "event",
        "event": "session.tool",
        "seq": 42,
        "payload": {"name": "exec", "status": "start"},
    }
    result = _normalize_gateway_event(frame)
    assert result["kind"] == "session.tool"
    assert result["event"] == "session.tool"
    assert result["name"] == "exec"
    assert result["status"] == "start"
    assert result["seq"] == 42


def test_normalize_non_event_frame():
    frame = {"type": "res", "ok": True}
    result = _normalize_gateway_event(frame)
    assert result["kind"] == "non-event"


def test_normalize_approval_event():
    frame = {"type": "event", "event": "session.tool.approval.required", "seq": 1, "payload": {}}
    result = _normalize_gateway_event(frame)
    assert result["kind"] == "approval"


def test_normalize_text_preview_truncated():
    long_text = "x" * 500
    frame = {"type": "event", "event": "chat.message", "seq": 1, "payload": {"text": long_text}}
    result = _normalize_gateway_event(frame)
    assert len(result["text_preview"]) == 400


# ---------------------------------------------------------------------------
# _extract_tool_names / _payload_tool_count
# ---------------------------------------------------------------------------

def test_extract_tool_names_basic():
    names = _extract_tool_names([{"name": "exec"}, {"name": "browser"}])
    assert names == ["exec", "browser"]


def test_payload_tool_count():
    payload = [{"name": "exec"}, {"name": "shell"}]
    result = _payload_tool_count(payload)
    assert result["tool_name_count"] == 2
    assert "exec" in result["tool_names"]


# ---------------------------------------------------------------------------
# _redact_secrets
# ---------------------------------------------------------------------------

def test_redact_api_key():
    text = '{"api_key": "supersecret123456"}'
    result = _redact_secrets(text)
    assert "supersecret" not in result
    assert "***REDACTED***" in result


def test_redact_password():
    text = "password: mypassword"
    result = _redact_secrets(text)
    assert "mypassword" not in result
    assert "***REDACTED***" in result


def test_redact_aws_key():
    text = "key: AKIAIOSFODNN7EXAMPLE"
    result = _redact_secrets(text)
    assert "AKIAIOSFODNN7EXAMPLE" not in result


def test_redact_bearer_token():
    text = "Authorization: Bearer eyJhbGciOiJSUzI1NiIsInR5cCI6IkpXVCJ9.abc"
    result = _redact_secrets(text)
    assert "eyJhbGciOiJSUzI1NiIsInR5cCI6IkpXVCJ9" not in result


def test_redact_no_secrets_unchanged():
    text = '{"event": "session.tool", "name": "exec"}'
    result = _redact_secrets(text)
    assert result == text


# ---------------------------------------------------------------------------
# _maybe_redact
# ---------------------------------------------------------------------------

def test_maybe_redact_disabled():
    obj = {"api_key": "supersecret123456"}
    result = _maybe_redact(obj, redact=False)
    assert result == obj


def test_maybe_redact_enabled():
    obj = {"api_key": "supersecret123456"}
    result = _maybe_redact(obj, redact=True)
    assert isinstance(result, dict)
    assert "supersecret" not in json.dumps(result)


def test_maybe_redact_no_secrets_returns_same():
    obj = {"event": "session.tool"}
    result = _maybe_redact(obj, redact=True)
    assert result == obj


# ---------------------------------------------------------------------------
# _rotate_trace_if_needed
# ---------------------------------------------------------------------------

def test_rotate_creates_old_file(tmp_path: Path):
    trace = tmp_path / "trace.jsonl"
    # write enough to exceed 0.0001 MB threshold
    trace.write_text("x" * 200)
    _rotate_trace_if_needed(trace, max_mb=0.0001)
    old = tmp_path / "trace.jsonl.old"
    assert old.is_file()
    assert not trace.exists()


def test_rotate_does_not_rotate_if_small(tmp_path: Path):
    trace = tmp_path / "trace.jsonl"
    trace.write_text("small")
    _rotate_trace_if_needed(trace, max_mb=100.0)
    assert trace.is_file()
    assert not (tmp_path / "trace.jsonl.old").exists()


def test_rotate_skips_if_file_missing(tmp_path: Path):
    _rotate_trace_if_needed(tmp_path / "nonexistent.jsonl", max_mb=0.001)


def test_rotate_disabled_if_max_mb_zero(tmp_path: Path):
    trace = tmp_path / "trace.jsonl"
    trace.write_text("x" * 10_000)
    _rotate_trace_if_needed(trace, max_mb=0)
    assert trace.is_file()
