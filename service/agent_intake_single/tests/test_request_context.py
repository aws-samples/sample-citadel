"""Tests for request_context — session identity binding.

Run with:
    PYTHONPATH=. pytest tests/test_request_context.py -q
from the service/agent_intake_single directory.
"""
import json
import logging
import os
import sys
from unittest import mock

import pytest

sys.path.insert(0, os.path.join(os.path.dirname(__file__), ".."))

import request_context
from request_context import (
    MissingOrgError,
    MissingSessionError,
    bind_request,
    clear,
    current_session,
    current_session_id,
    require_bound_session_id,
)


@pytest.fixture(autouse=True)
def _clean_context():
    """Ensure each test starts and ends with a clean context."""
    clear()
    yield
    clear()


# --- bind_request ---

def test_bind_request_happy_path():
    payload = {
        "session_id": "proj-123",
        "sessionAttributes": {"userId": "user-sub-456", "org": "org-789"},
    }
    identity = bind_request(payload)
    assert identity.session_id == "proj-123"
    assert identity.user_id == "user-sub-456"
    assert identity.org_id == "org-789"


def test_bind_request_minimal_payload_without_org_raises():
    """org is now required — a payload with only session_id must fail closed."""
    with pytest.raises(MissingOrgError, match="sessionAttributes.org"):
        bind_request({"session_id": "s1"})


def test_bind_request_raises_on_empty_org():
    with pytest.raises(MissingOrgError, match="sessionAttributes.org"):
        bind_request({"session_id": "s1", "sessionAttributes": {"org": ""}})


def test_bind_request_raises_on_whitespace_org():
    with pytest.raises(MissingOrgError, match="sessionAttributes.org"):
        bind_request({"session_id": "s1", "sessionAttributes": {"org": "   "}})


def test_bind_request_raises_on_missing_session_id():
    with pytest.raises(MissingSessionError, match="session_id"):
        bind_request({"prompt": "hello"})


def test_bind_request_raises_on_empty_session_id():
    with pytest.raises(MissingSessionError, match="session_id"):
        bind_request({"session_id": ""})


def test_bind_request_raises_on_whitespace_session_id():
    with pytest.raises(MissingSessionError, match="session_id"):
        bind_request({"session_id": "   "})


# --- current_session / current_session_id ---

def test_current_session_raises_when_unbound():
    with pytest.raises(RuntimeError, match="outside request scope"):
        current_session()


def test_current_session_id_raises_when_unbound():
    with pytest.raises(RuntimeError, match="outside request scope"):
        current_session_id()


def test_current_session_reads_bound_identity():
    bind_request({"session_id": "s1", "sessionAttributes": {"userId": "u1", "org": "org-1"}})
    assert current_session().session_id == "s1"
    assert current_session().user_id == "u1"
    assert current_session_id() == "s1"


# --- require_bound_session_id / mismatch logging ---

def test_require_bound_session_id_returns_bound(caplog):
    bind_request({"session_id": "server-123", "sessionAttributes": {"org": "org-1"}})
    result = require_bound_session_id("get_intake_state", "server-123")
    assert result == "server-123"
    assert "mismatch" not in caplog.text


def test_require_bound_session_id_logs_mismatch(caplog):
    bind_request({"session_id": "server-123", "sessionAttributes": {"org": "org-1"}})
    with caplog.at_level(logging.WARNING, logger="request_context"):
        result = require_bound_session_id("get_intake_state", "attacker-999")
    assert result == "server-123"
    assert "session_id mismatch" in caplog.text
    assert "attacker-999" in caplog.text
    assert "IntakeSessionMismatch" in caplog.text


def test_require_bound_session_id_no_model_arg():
    """When no model session_id is supplied, no log is emitted."""
    bind_request({"session_id": "s1", "sessionAttributes": {"org": "org-1"}})
    result = require_bound_session_id("some_tool")
    assert result == "s1"


# --- clear ---

def test_clear_resets_context():
    bind_request({"session_id": "s1", "sessionAttributes": {"org": "org-1"}})
    clear()
    with pytest.raises(RuntimeError):
        current_session()


# --- two-session negative test ---

def test_tool_uses_bound_session_ignores_model_supplied():
    """Simulates the attack path: model passes a foreign session_id but
    the server-bound context wins."""
    bind_request({"session_id": "tenant-A", "sessionAttributes": {"org": "org-A"}})
    # The tool would call require_bound_session_id:
    used = require_bound_session_id("get_intake_state", "tenant-B")
    assert used == "tenant-A"


# --- tools see org_id ---

def test_tools_see_org_id():
    """Tools can read the bound org_id from the session identity."""
    bind_request({
        "session_id": "proj-1",
        "sessionAttributes": {"userId": "u1", "org": "acme-corp"},
    })
    assert current_session().org_id == "acme-corp"
