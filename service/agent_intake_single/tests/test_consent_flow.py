"""Tests for the consent-after-success flow (A), server-authored next actions (B),
and stored fabrication plan (C).

Contract:
(A) consent.py:
  - require_consent checks and TTL-validates WITHOUT deleting; returns a handle
  - consume_consent(handle) deletes the record (one-shot)
  - A failed privileged call (tool raises before consume) keeps the consent valid
  - After a successful consume, a second consume or require_consent fails (single-use)
  - Expired consent is rejected at require_consent time

(B) fabricate.py actions:
  - plan_fabrication success returns `actions` containing a consent entry for
    confirm_fabrication_plan and an "adjust" label entry
  - confirm_fabrication_plan success returns `actions` for the next step

(C) fabricate.py stored plan:
  - plan_fabrication stores the plan in session memory and returns a plan_id
  - confirm_fabrication_plan takes plan_id, loads stored plan from session memory
  - confirm_fabrication_plan rejects an unknown plan_id
  - confirm_fabrication_plan never reads specs from the argument (no plan_json)

(D) SYSTEM_PROMPT contains the verbatim-actions rule
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
    consume_consent,
    ConsentRequired,
    ACTION_CATALOGUE,
)
from tools import consent as _consent_module


# ── Fixtures ────────────────────────────────────────────────────────────


@pytest.fixture(autouse=True)
def _restore_real_consent(monkeypatch):
    """Override the conftest bypass — these tests need the REAL consent fns."""
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


def _valid_consent_item(session_id: str, action: str, ttl_offset: int = 600) -> dict:
    return {
        "Item": {
            "p_key": session_id,
            "s_key": f"consent#{action}",
            "ttl": int(time.time()) + ttl_offset,
        }
    }


# ── (A) Consent check-then-consume ──────────────────────────────────────


class TestConsentCheckWithoutDelete:
    """require_consent checks validity but does NOT delete the record."""

    def test_require_consent_returns_handle(self, mock_table):
        mock_table.get_item.return_value = _valid_consent_item("sess-1", "activate_agents")
        handle = require_consent("sess-1", "activate_agents")
        assert handle is not None
        # Must NOT have called delete_item
        mock_table.delete_item.assert_not_called()

    def test_require_consent_raises_when_missing(self, mock_table):
        mock_table.get_item.return_value = {}
        with pytest.raises(ConsentRequired, match="missing"):
            require_consent("sess-1", "activate_agents")

    def test_require_consent_raises_when_expired(self, mock_table):
        mock_table.get_item.return_value = _valid_consent_item(
            "sess-1", "activate_agents", ttl_offset=-60,
        )
        with pytest.raises(ConsentRequired, match="expired"):
            require_consent("sess-1", "activate_agents")


class TestConsumeConsent:
    """consume_consent deletes the record, making it single-use."""

    def test_consume_deletes_the_record(self, mock_table):
        mock_table.get_item.return_value = _valid_consent_item("sess-1", "activate_agents")
        handle = require_consent("sess-1", "activate_agents")
        consume_consent(handle)
        mock_table.delete_item.assert_called_once_with(
            Key={"p_key": "sess-1", "s_key": "consent#activate_agents"}
        )

    def test_second_require_after_consume_fails(self, mock_table):
        """After consuming, the record is gone — a second require fails."""
        mock_table.get_item.return_value = _valid_consent_item("sess-1", "activate_agents")
        handle = require_consent("sess-1", "activate_agents")
        consume_consent(handle)
        # Now the record is deleted
        mock_table.get_item.return_value = {}
        with pytest.raises(ConsentRequired, match="missing"):
            require_consent("sess-1", "activate_agents")


class TestFailedCallKeepsConsent:
    """A failed privileged call (no consume) keeps the consent for retry."""

    def test_consent_survives_failed_tool(self, mock_table):
        mock_table.get_item.return_value = _valid_consent_item("sess-1", "confirm_fabrication_plan")
        # First call: check consent, then tool fails (no consume)
        handle = require_consent("sess-1", "confirm_fabrication_plan")
        # Simulate tool failure — we never call consume_consent
        mock_table.delete_item.assert_not_called()
        # Second call: consent is still valid (record not deleted)
        handle2 = require_consent("sess-1", "confirm_fabrication_plan")
        assert handle2 is not None
        mock_table.delete_item.assert_not_called()

    def test_success_then_second_needs_new_grant(self, mock_table):
        """After a successful consume, a repeat needs a new consent grant."""
        mock_table.get_item.return_value = _valid_consent_item("sess-1", "plan_fabrication")
        handle = require_consent("sess-1", "plan_fabrication")
        consume_consent(handle)
        # Record is now consumed
        mock_table.get_item.return_value = {}
        with pytest.raises(ConsentRequired, match="missing"):
            require_consent("sess-1", "plan_fabrication")


# ── (B) Server-authored next actions ─────────────────────────────────────


class TestPlanFabricationActions:
    """plan_fabrication success returns server-authored actions."""

    @pytest.fixture
    def _patch_fabricate(self, monkeypatch):
        """Patch out LLM, S3, registry for plan_fabrication."""
        import tools.fabricate as fab
        monkeypatch.setattr(fab, "_extract_agents", lambda td2, sid="": [
            {"name": "test-agent", "spec": "Build a test agent", "requires_external": False},
        ])
        monkeypatch.setattr(fab, "_get_existing_agents", lambda: {})
        monkeypatch.setattr(fab, "s3_get", lambda key: "mock td2 content")
        # Patch consent to succeed
        monkeypatch.setattr(fab, "require_consent", lambda sid, action: mock.MagicMock())
        monkeypatch.setattr(fab, "consume_consent", lambda handle: None)
        # Patch session memory store
        monkeypatch.setattr(fab, "_store_plan_in_session", lambda sid, plan: "plan-123")

    def test_plan_fabrication_returns_actions(self, _patch_fabricate):
        from tools.fabricate import plan_fabrication
        result = json.loads(plan_fabrication())
        assert "actions" in result
        actions = result["actions"]
        # Must have a consent entry for confirm_fabrication_plan
        consent_actions = [a for a in actions if "consent" in a]
        assert len(consent_actions) == 1
        assert consent_actions[0]["consent"] == "confirm_fabrication_plan"
        # Must have an adjust label entry
        label_actions = [a for a in actions if "label" in a]
        assert any("adjust" in a["label"].lower() or "adjust" in a.get("value", "").lower()
                    for a in label_actions)

    def test_plan_fabrication_returns_plan_id(self, _patch_fabricate):
        from tools.fabricate import plan_fabrication
        result = json.loads(plan_fabrication())
        assert "plan_id" in result


# ── (C) Stored fabrication plan ──────────────────────────────────────────


class TestConfirmUsesStoredPlan:
    """confirm_fabrication_plan loads the plan from session memory by plan_id."""

    @pytest.fixture
    def _patch_confirm(self, monkeypatch):
        """Patch out S3, SQS, DDB, consent for confirm_fabrication_plan."""
        import tools.fabricate as fab

        self._stored_plans = {}

        def mock_load(session_id, plan_id):
            return self._stored_plans.get(plan_id)

        def mock_store(session_id, plan):
            pid = "plan-abc"
            self._stored_plans[pid] = plan
            return pid

        monkeypatch.setattr(fab, "_load_plan_from_session", mock_load)
        monkeypatch.setattr(fab, "_store_plan_in_session", mock_store)
        monkeypatch.setattr(fab, "require_consent", lambda sid, action: mock.MagicMock())
        monkeypatch.setattr(fab, "consume_consent", lambda handle: None)
        monkeypatch.setenv("FABRICATOR_QUEUE_URL", "https://sqs.example/queue")
        monkeypatch.setattr(fab, "FABRICATOR_QUEUE_URL", "https://sqs.example/queue")
        monkeypatch.setattr(fab, "_send_to_fabricator", lambda *a, **kw: None)
        monkeypatch.setattr(fab, "s3_put", lambda key, content: None)
        # _internal_update_progress is imported at call time from tools.state,
        # so patch it at the source.
        import tools.state as _state
        monkeypatch.setattr(_state, "_internal_update_progress", lambda **kw: "ok")
        return fab

    def test_confirm_loads_plan_by_plan_id(self, _patch_confirm):
        fab = _patch_confirm
        # Pre-store a plan
        plan = [{"name": "test-agent", "action": "build", "reason": "new", "spec": "spec content"}]
        self._stored_plans["plan-abc"] = plan

        from tools.fabricate import confirm_fabrication_plan
        result = confirm_fabrication_plan(plan_id="plan-abc")
        assert "Error" not in result
        assert "test-agent" in result

    def test_confirm_rejects_unknown_plan_id(self, _patch_confirm):
        from tools.fabricate import confirm_fabrication_plan
        result = confirm_fabrication_plan(plan_id="nonexistent")
        assert "Error" in result or "not found" in result.lower() or "expired" in result.lower()

    def test_confirm_does_not_accept_plan_json_arg(self):
        """confirm_fabrication_plan does NOT take a plan_json argument."""
        import inspect
        from tools.fabricate import confirm_fabrication_plan
        # Get the underlying function (unwrap @tool decorator)
        fn = confirm_fabrication_plan
        if hasattr(fn, '__wrapped__'):
            fn = fn.__wrapped__
        sig = inspect.signature(fn)
        assert "plan_json" not in sig.parameters


# ── (D) SYSTEM_PROMPT verbatim-actions rule ──────────────────────────────


class TestSystemPromptVerbatimActions:
    """The SYSTEM_PROMPT contains the verbatim-actions rule."""

    @pytest.fixture(autouse=True)
    def _load_prompt(self):
        """Read SYSTEM_PROMPT from agent.py source text (avoids importing
        bedrock_agentcore which is not installed in test env)."""
        agent_path = os.path.join(os.path.dirname(__file__), "..", "agent.py")
        with open(agent_path) as f:
            src = f.read()
        # Extract the SYSTEM_PROMPT string between triple-quote delimiters
        start = src.index('SYSTEM_PROMPT = """') + len('SYSTEM_PROMPT = """')
        end = src.index('"""', start)
        self.prompt = src[start:end]

    def test_prompt_contains_verbatim_actions_rule(self):
        # Must instruct the model to emit actions verbatim
        assert "VERBATIM" in self.prompt

    def test_prompt_forbids_reinventing_buttons(self):
        lower = self.prompt.lower()
        assert "do not invent" in lower or "never invent" in lower

    def test_prompt_says_confirm_not_replan(self):
        """After a plan exists, confirmation means confirm_fabrication_plan."""
        assert "confirm_fabrication_plan" in self.prompt
