"""Tests for the server-defined action catalogue in consent.py.

Contract:
- ACTION_CATALOGUE maps every PRIVILEGED_ACTIONS id to a fixed label + description.
- require_consent rejects unknown action ids.
- require_consent rejects ids not in ACTION_CATALOGUE even if a DDB record exists.
- Fabrication-lifecycle tools (plan_fabrication, confirm_fabrication_plan,
  retry_failed_fabrication) are in PRIVILEGED_ACTIONS and require consent.
- Action button labels in postfab tool responses come from the catalogue
  (model cannot alter them).
- Existing happy paths still pass (activate_agents, create_agent_app, etc.).

Run with:
    PYTHONPATH=. ../../.venv/bin/python -m pytest tests/test_consent_catalogue.py -q
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

from tools.consent import (
    require_consent,
    ConsentRequired,
    PRIVILEGED_ACTIONS,
    ACTION_CATALOGUE,
)
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


# ── ACTION_CATALOGUE completeness ───────────────────────────────────────


class TestActionCatalogueCompleteness:
    """Every PRIVILEGED_ACTIONS id must have a catalogue entry."""

    def test_catalogue_covers_all_privileged_actions(self):
        assert set(ACTION_CATALOGUE.keys()) == PRIVILEGED_ACTIONS

    def test_each_catalogue_entry_has_label_and_description(self):
        for action_id, entry in ACTION_CATALOGUE.items():
            assert "label" in entry, f"{action_id} missing 'label'"
            assert "description" in entry, f"{action_id} missing 'description'"
            assert isinstance(entry["label"], str) and len(entry["label"]) > 0
            assert isinstance(entry["description"], str) and len(entry["description"]) > 0


# ── Unknown / mismatched action ids ──────────────────────────────────────


class TestUnknownActionRejected:
    """require_consent must refuse action ids not in ACTION_CATALOGUE."""

    def test_unknown_action_raises(self, mock_table):
        """An action string not in the catalogue is rejected even if a DDB
        record exists (attacker planted it)."""
        mock_table.get_item.return_value = {
            "Item": {
                "p_key": "sess-1",
                "s_key": "consent#sneaky_action",
                "ttl": int(time.time()) + 600,
            }
        }
        with pytest.raises(ConsentRequired, match="unknown_action"):
            require_consent("sess-1", "sneaky_action")
        # DDB should NOT even be queried for an unknown action
        mock_table.get_item.assert_not_called()

    def test_empty_action_raises(self, mock_table):
        with pytest.raises(ConsentRequired, match="unknown_action"):
            require_consent("sess-1", "")
        mock_table.get_item.assert_not_called()

    def test_similar_action_name_rejected(self, mock_table):
        """A near-miss action id (typo) is rejected."""
        with pytest.raises(ConsentRequired, match="unknown_action"):
            require_consent("sess-1", "activate_agent")  # singular
        mock_table.get_item.assert_not_called()


# ── Fabrication tools require consent ────────────────────────────────────


class TestFabricationToolsPrivileged:
    """plan_fabrication, confirm_fabrication_plan, retry_failed_fabrication
    must be in PRIVILEGED_ACTIONS."""

    @pytest.mark.parametrize("action", [
        "plan_fabrication",
        "confirm_fabrication_plan",
        "retry_failed_fabrication",
    ])
    def test_fabrication_action_is_privileged(self, action):
        assert action in PRIVILEGED_ACTIONS

    @pytest.mark.parametrize("action", [
        "plan_fabrication",
        "confirm_fabrication_plan",
        "retry_failed_fabrication",
    ])
    def test_fabrication_action_in_catalogue(self, action):
        assert action in ACTION_CATALOGUE
        assert "label" in ACTION_CATALOGUE[action]

    @pytest.mark.parametrize("action", [
        "plan_fabrication",
        "confirm_fabrication_plan",
        "retry_failed_fabrication",
    ])
    def test_fabrication_action_requires_consent(self, action, mock_table):
        mock_table.get_item.return_value = {}
        with pytest.raises(ConsentRequired, match="missing"):
            require_consent("sess-1", action)


# ── Existing happy paths ────────────────────────────────────────────────


class TestExistingHappyPaths:
    """The four original actions still work with valid consent records."""

    @pytest.mark.parametrize("action", [
        "activate_agents",
        "create_agent_app",
        "generate_process_blueprint",
        "import_blueprint_to_app",
    ])
    def test_valid_consent_still_works(self, action, mock_table):
        mock_table.get_item.return_value = {
            "Item": {
                "p_key": "sess-1",
                "s_key": f"consent#{action}",
                "ttl": int(time.time()) + 600,
            }
        }
        require_consent("sess-1", action)  # should not raise
        mock_table.delete_item.assert_called_once()

    @pytest.mark.parametrize("action", sorted(PRIVILEGED_ACTIONS))
    def test_all_privileged_checked(self, action, mock_table):
        """Every privileged action (including new fabrication ones) is checked."""
        mock_table.get_item.return_value = {}
        with pytest.raises(ConsentRequired):
            require_consent("sess-1", action)


# ── Labels come from catalogue ───────────────────────────────────────────


class TestLabelsFromCatalogue:
    """Action buttons built from catalogue must have the fixed label."""

    def test_catalogue_labels_are_static_strings(self):
        """Labels must be plain strings, not callables or templates."""
        for action_id, entry in ACTION_CATALOGUE.items():
            label = entry["label"]
            assert isinstance(label, str), f"{action_id} label is not a string"
            # No f-string placeholders or format tokens
            assert "{" not in label, f"{action_id} label contains curly braces"
