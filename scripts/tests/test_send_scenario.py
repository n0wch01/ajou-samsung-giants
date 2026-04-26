"""Unit tests for runner/send_scenario.py."""
import json
import os
import sys
from pathlib import Path
from unittest.mock import patch

import pytest

sys.path.insert(0, str(Path(__file__).resolve().parents[1]))

from runner.send_scenario import _build_chat_params, S1_DEFAULT_MESSAGE


# ---------------------------------------------------------------------------
# S1_DEFAULT_MESSAGE
# ---------------------------------------------------------------------------

def test_s1_default_message_not_empty():
    assert S1_DEFAULT_MESSAGE
    assert ".env" in S1_DEFAULT_MESSAGE
    assert "relay" in S1_DEFAULT_MESSAGE
    assert len(S1_DEFAULT_MESSAGE) > 20


# ---------------------------------------------------------------------------
# _build_chat_params — default path
# ---------------------------------------------------------------------------

def test_build_chat_params_default():
    params = _build_chat_params("agent:main", "hello")
    assert params["sessionKey"] == "agent:main"
    assert params["message"] == "hello"
    assert "idempotencyKey" in params


def test_build_chat_params_unique_idempotency_keys():
    p1 = _build_chat_params("agent:main", "msg")
    p2 = _build_chat_params("agent:main", "msg")
    assert p1["idempotencyKey"] != p2["idempotencyKey"]


# ---------------------------------------------------------------------------
# _build_chat_params — override via env
# ---------------------------------------------------------------------------

def test_build_chat_params_env_override():
    custom = json.dumps({"sessionKey": "custom:key", "message": "from_env", "extra": 42})
    with patch.dict(os.environ, {"OPENCLAW_CHAT_SEND_PARAMS_JSON": custom}):
        params = _build_chat_params("ignored", "ignored")
    assert params["sessionKey"] == "custom:key"
    assert params["extra"] == 42


def test_build_chat_params_env_override_not_dict_raises():
    with patch.dict(os.environ, {"OPENCLAW_CHAT_SEND_PARAMS_JSON": "[1, 2, 3]"}):
        with pytest.raises(ValueError, match="JSON object"):
            _build_chat_params("agent:main", "msg")


def test_build_chat_params_env_empty_uses_default():
    with patch.dict(os.environ, {"OPENCLAW_CHAT_SEND_PARAMS_JSON": ""}):
        params = _build_chat_params("agent:main", "hello")
    assert params["sessionKey"] == "agent:main"
