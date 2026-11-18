"""Shared fixtures for agent_intake_single tests."""
import os
import sys

sys.path.insert(0, os.path.join(os.path.dirname(__file__), ".."))

import pytest
import request_context


@pytest.fixture(autouse=True)
def _bind_default_session():
    """Auto-bind a default session identity for all tests.

    Tests that need a specific session_id can call request_context.bind_request()
    again — it overwrites the previous binding.
    """
    request_context.bind_request({
        "session_id": "sess-1",
        "sessionAttributes": {"userId": "user-1", "org": "org-1"},
    })
    yield
    request_context.clear()


@pytest.fixture(autouse=True)
def _bypass_consent(monkeypatch):
    """Auto-bypass the consent check for existing postfab tests.

    Tests that explicitly test the consent gate (test_consent.py,
    test_consent_flow.py) provide their own mocks. This fixture ensures all
    other postfab tests continue to work without needing consent records in
    DynamoDB.

    require_consent now returns a ConsentHandle (check-without-delete);
    consume_consent deletes. Both are stubbed to no-ops here.
    """
    from tools.consent import ConsentHandle
    _noop_handle = ConsentHandle(session_id="bypass", action="bypass")
    import tools.postfab as postfab
    monkeypatch.setattr(postfab, "require_consent", lambda session_id, action: _noop_handle)
    monkeypatch.setattr(postfab, "consume_consent", lambda handle: None)
    import tools.fabricate as fabricate
    monkeypatch.setattr(fabricate, "require_consent", lambda session_id, action: _noop_handle)
    monkeypatch.setattr(fabricate, "consume_consent", lambda handle: None)
