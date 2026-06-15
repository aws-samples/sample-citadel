"""Tests for arbiter/activator/index.py — US-ARB-009.

Covers:
  1. activate_agent happy path
  2. activate_agent missing agent → 404
  3. suspend_agent happy path
  4. suspend_agent missing agent → 404
  5. handler dispatches 'activate'
  6. handler dispatches 'suspend'
  7. handler missing agentId → 400
  8. handler unknown action → 400
  9. Property test — idempotent state machine (200 iterations)

All DynamoDB interaction is mocked via MagicMock; no real AWS calls.
"""

from __future__ import annotations

import os
import sys
import re
from unittest.mock import MagicMock, patch

import pytest
from botocore.exceptions import ClientError
from hypothesis import given, settings, strategies as st

# Add activator module to path (tests live in __tests__/).
sys.path.insert(0, os.path.join(os.path.dirname(__file__), ".."))

# AGENT_CONFIG_TABLE must be set before importing because _get_table()
# reads from env lazily, but we also set a default for safety.
os.environ.setdefault("AGENT_CONFIG_TABLE", "fake-activator-table")

import index as activator  # noqa: E402


ISO_8601_RE = re.compile(
    r'^\d{4}-\d{2}-\d{2}T\d{2}:\d{2}:\d{2}(\.\d+)?(\+\d{2}:\d{2}|Z)$'
)


@pytest.fixture(autouse=True)
def _reset_module_clients():
    """Reset cached boto3 client before and after each test to avoid leakage."""
    activator.__reset_clients_for_test()
    yield
    activator.__reset_clients_for_test()


def _make_conditional_check_failed() -> ClientError:
    return ClientError(
        {
            "Error": {
                "Code": "ConditionalCheckFailedException",
                "Message": "The conditional request failed",
            },
            "ResponseMetadata": {"HTTPStatusCode": 400},
        },
        "UpdateItem",
    )


# ---------------------------------------------------------------------------
# 1. activate_agent happy path
# ---------------------------------------------------------------------------
def test_activate_agent_happy_path():
    mock_table = MagicMock()
    mock_table.update_item.return_value = {}

    with patch.object(activator, "_get_table", return_value=mock_table):
        result = activator.activate_agent("agent-123", "alice")

    assert result["statusCode"] == 200
    assert result["agentId"] == "agent-123"
    assert result["state"] == "active"
    assert ISO_8601_RE.match(result["activatedAt"]), result["activatedAt"]

    mock_table.update_item.assert_called_once()
    call = mock_table.update_item.call_args.kwargs
    assert call["Key"] == {"agentId": "agent-123"}
    assert call["UpdateExpression"] == "SET #s = :s, activatedAt = :t, activatedBy = :u"
    assert call["ExpressionAttributeNames"] == {"#s": "state"}
    assert call["ExpressionAttributeValues"][":s"] == "active"
    assert call["ExpressionAttributeValues"][":u"] == "alice"
    assert ISO_8601_RE.match(call["ExpressionAttributeValues"][":t"])
    assert call["ConditionExpression"] == "attribute_exists(agentId)"


# ---------------------------------------------------------------------------
# 2. activate_agent missing agent → 404
# ---------------------------------------------------------------------------
def test_activate_agent_missing_agent_returns_404():
    mock_table = MagicMock()
    mock_table.update_item.side_effect = _make_conditional_check_failed()

    with patch.object(activator, "_get_table", return_value=mock_table):
        result = activator.activate_agent("does-not-exist", "bob")

    assert result["statusCode"] == 404
    assert "does-not-exist" in result["error"]


# ---------------------------------------------------------------------------
# 3. suspend_agent happy path
# ---------------------------------------------------------------------------
def test_suspend_agent_happy_path():
    mock_table = MagicMock()
    mock_table.update_item.return_value = {}

    with patch.object(activator, "_get_table", return_value=mock_table):
        result = activator.suspend_agent("agent-xyz", "carol")

    assert result["statusCode"] == 200
    assert result["agentId"] == "agent-xyz"
    assert result["state"] == "suspended"
    assert ISO_8601_RE.match(result["suspendedAt"])

    call = mock_table.update_item.call_args.kwargs
    assert call["UpdateExpression"] == "SET #s = :s, suspendedAt = :t, suspendedBy = :u"
    assert call["ExpressionAttributeNames"] == {"#s": "state"}
    assert call["ExpressionAttributeValues"][":s"] == "suspended"
    assert call["ExpressionAttributeValues"][":u"] == "carol"
    assert call["ConditionExpression"] == "attribute_exists(agentId)"


# ---------------------------------------------------------------------------
# 4. suspend_agent missing agent → 404
# ---------------------------------------------------------------------------
def test_suspend_agent_missing_agent_returns_404():
    mock_table = MagicMock()
    mock_table.update_item.side_effect = _make_conditional_check_failed()

    with patch.object(activator, "_get_table", return_value=mock_table):
        result = activator.suspend_agent("ghost-agent", "dave")

    assert result["statusCode"] == 404
    assert "ghost-agent" in result["error"]


# ---------------------------------------------------------------------------
# 5. handler dispatches 'activate'
# ---------------------------------------------------------------------------
def test_handler_dispatches_activate():
    event = {
        "detail": {
            "agentId": "agent-a",
            "action": "activate",
            "actor": "alice",
            "correlationId": "cid-1",
        }
    }
    with patch.object(activator, "activate_agent") as mock_activate:
        mock_activate.return_value = {"statusCode": 200}
        result = activator.handler(event)

    mock_activate.assert_called_once_with("agent-a", "alice")
    assert result == {"statusCode": 200}


# ---------------------------------------------------------------------------
# 6. handler dispatches 'suspend'
# ---------------------------------------------------------------------------
def test_handler_dispatches_suspend():
    event = {
        "detail": {
            "agentId": "agent-b",
            "action": "suspend",
            "actor": "bob",
            "correlationId": "cid-2",
        }
    }
    with patch.object(activator, "suspend_agent") as mock_suspend:
        mock_suspend.return_value = {"statusCode": 200}
        result = activator.handler(event)

    mock_suspend.assert_called_once_with("agent-b", "bob")
    assert result == {"statusCode": 200}


# ---------------------------------------------------------------------------
# 7. handler missing agentId → 400
# ---------------------------------------------------------------------------
def test_handler_missing_agent_id_returns_400():
    event = {"detail": {"action": "activate", "actor": "alice"}}
    result = activator.handler(event)
    assert result["statusCode"] == 400
    assert "agentId" in result["error"] or "missing" in result["error"]


def test_handler_missing_action_returns_400():
    event = {"detail": {"agentId": "agent-x", "actor": "alice"}}
    result = activator.handler(event)
    assert result["statusCode"] == 400


# ---------------------------------------------------------------------------
# 8. handler unknown action → 400
# ---------------------------------------------------------------------------
def test_handler_unknown_action_returns_400():
    event = {
        "detail": {
            "agentId": "agent-c",
            "action": "nuke-from-orbit",
            "actor": "charlie",
        }
    }
    result = activator.handler(event)
    assert result["statusCode"] == 400
    assert "nuke-from-orbit" in result["error"]


# ---------------------------------------------------------------------------
# 9. Property test — idempotent final state.
#
# Invariant: for any non-empty sequence of {activate, suspend} actions
# applied to the same agent, the final persisted state matches the last
# action. Duplicate events never leave the record in a corrupted state
# because UpdateItem overwrites the same attribute.
# ---------------------------------------------------------------------------
@given(
    actions=st.lists(
        st.sampled_from(["activate", "suspend"]),
        min_size=1,
        max_size=25,
    )
)
@settings(max_examples=200, deadline=None)
def test_sequence_of_actions_is_idempotent(actions):
    activator.__reset_clients_for_test()

    # In-memory pseudo-table: records the last state written.
    store = {"state": None}

    mock_table = MagicMock()

    def fake_update_item(**kwargs):
        values = kwargs.get("ExpressionAttributeValues", {})
        store["state"] = values.get(":s")
        return {}

    mock_table.update_item.side_effect = fake_update_item

    with patch.object(activator, "_get_table", return_value=mock_table):
        for action in actions:
            event = {
                "detail": {
                    "agentId": "prop-agent",
                    "action": action,
                    "actor": "tester",
                    "correlationId": "cid",
                }
            }
            result = activator.handler(event)
            assert result["statusCode"] == 200

    expected_state = "active" if actions[-1] == "activate" else "suspended"
    assert store["state"] == expected_state
