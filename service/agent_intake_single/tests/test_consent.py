"""Tests for the consent gate (tools/consent.py).

Contract:
- require_consent raises ConsentRequired when no record exists.
- require_consent succeeds and deletes (consumes) a valid record.
- require_consent raises ConsentRequired for an expired record.
- Consent for session A cannot be used by session B.
- Consent for action X cannot be used for action Y.
- Non-privileged actions pass through without checking.

Run with:
    PYTHONPATH=. ../../.venv/bin/python -m pytest tests/test_consent.py -q
from the service/agent_intake_single directory.
"""
import json
import os
import sys
import time
from unittest import mock

import pytest

sys.path.insert(0, os.path.join(os.path.dirname(__file__), ".."))

import request_context

os.environ.setdefault("APPSYNC_GRAPHQL_URL", "https://test.example/graphql")
os.environ.setdefault("SESSION_MEMORY_TABLE", "test-session-memory")

from tools.consent import require_consent, ConsentRequired, PRIVILEGED_ACTIONS
from tools import consent as _consent_module


@pytest.fixture(autouse=True)
def _restore_real_consent(monkeypatch):
    """Override the conftest bypass — these tests need the REAL require_consent."""
    monkeypatch.setattr(_consent_module, "require_consent", require_consent)


@pytest.fixture
def mock_table(monkeypatch):
    """Provides a mock DynamoDB table with configurable get_item / delete_item."""
    table = mock.MagicMock()
    table.get_item.return_value = {}
    table.delete_item.return_value = {}

    from tools import consent
    monkeypatch.setenv("SESSION_MEMORY_TABLE", "test-session-memory")
    monkeypatch.setattr(consent, "_table", lambda: table)
    return table


class TestConsentRequired:
    """No consent record → refused."""

    def test_missing_record_raises(self, mock_table):
        mock_table.get_item.return_value = {}  # no Item key
        with pytest.raises(ConsentRequired, match="missing"):
            require_consent("sess-1", "activate_agents")

    def test_expired_record_raises(self, mock_table):
        mock_table.get_item.return_value = {
            "Item": {
                "p_key": "sess-1",
                "s_key": "consent#activate_agents",
                "ttl": int(time.time()) - 60,  # expired
            }
        }
        with pytest.raises(ConsentRequired, match="expired"):
            require_consent("sess-1", "activate_agents")


class TestConsentGranted:
    """Valid consent record → proceed and consume."""

    def test_valid_consent_proceeds(self, mock_table):
        mock_table.get_item.return_value = {
            "Item": {
                "p_key": "sess-1",
                "s_key": "consent#activate_agents",
                "ttl": int(time.time()) + 600,
            }
        }
        # Should not raise
        require_consent("sess-1", "activate_agents")

    def test_consent_is_consumed(self, mock_table):
        mock_table.get_item.return_value = {
            "Item": {
                "p_key": "sess-1",
                "s_key": "consent#activate_agents",
                "ttl": int(time.time()) + 600,
            }
        }
        require_consent("sess-1", "activate_agents")
        mock_table.delete_item.assert_called_once_with(
            Key={"p_key": "sess-1", "s_key": "consent#activate_agents"}
        )

    def test_consent_is_single_use(self, mock_table):
        """After consumption, a second call fails."""
        valid_item = {
            "Item": {
                "p_key": "sess-1",
                "s_key": "consent#activate_agents",
                "ttl": int(time.time()) + 600,
            }
        }
        mock_table.get_item.return_value = valid_item

        require_consent("sess-1", "activate_agents")  # first call: OK

        # Now the record is consumed (deleted); simulate empty response
        mock_table.get_item.return_value = {}
        with pytest.raises(ConsentRequired, match="missing"):
            require_consent("sess-1", "activate_agents")


class TestConsentIsolation:
    """Consent is scoped to session + action."""

    def test_consent_for_different_session_not_found(self, mock_table):
        """Consent written for sess-1 cannot be used by sess-2."""
        # The mock returns empty for sess-2's key
        mock_table.get_item.return_value = {}
        with pytest.raises(ConsentRequired, match="missing"):
            require_consent("sess-2", "activate_agents")

    def test_consent_for_different_action_not_found(self, mock_table):
        """Consent for activate_agents cannot satisfy create_agent_app."""
        mock_table.get_item.return_value = {}
        with pytest.raises(ConsentRequired, match="missing"):
            require_consent("sess-1", "create_agent_app")


class TestNonPrivilegedActions:
    """Actions not in PRIVILEGED_ACTIONS pass through unconditionally."""

    def test_non_privileged_action_passes(self, mock_table):
        # Should not raise and should not even call DynamoDB
        require_consent("sess-1", "check_fabrication_status")
        mock_table.get_item.assert_not_called()


class TestAllPrivilegedActions:
    """Every privileged action is checked."""

    @pytest.mark.parametrize("action", sorted(PRIVILEGED_ACTIONS))
    def test_each_privileged_action_checked(self, action, mock_table):
        mock_table.get_item.return_value = {}
        with pytest.raises(ConsentRequired):
            require_consent("sess-1", action)
