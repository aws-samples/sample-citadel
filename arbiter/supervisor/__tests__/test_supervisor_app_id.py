"""
Tests for Supervisor handler appId extraction and orchestrate() app-scoped routing.

Validates: Requirements 12.1, 12.4
- 12.1: When task request includes appId, Supervisor queries app-scoped agents
- 12.4: When task request has no appId, falls back to load_config_from_dynamodb
"""

import sys
import os
import json
from unittest.mock import patch, MagicMock, call
from decimal import Decimal

import pytest

sys.path.insert(0, os.path.join(os.path.dirname(__file__), ".."))

os.environ.setdefault("AGENT_CONFIG_TABLE", "fake-table")
os.environ.setdefault("EVENT_BUS_NAME", "fake-bus")
os.environ.setdefault("ORCHESTRATION_TABLE", "fake-orch-table")
os.environ.setdefault("WORKER_STATE_TABLE", "fake-worker-table")
os.environ.setdefault("APPS_TABLE", "fake-apps-table")

# Patch boto3 at module level before importing index
_mock_dynamodb = MagicMock()
_mock_sqs = MagicMock()
_mock_bedrock = MagicMock()
_mock_events = MagicMock()

with patch.multiple(
    "boto3",
    resource=MagicMock(return_value=_mock_dynamodb),
    client=MagicMock(side_effect=lambda svc, **kw: {
        "sqs": _mock_sqs,
        "bedrock-runtime": _mock_bedrock,
        "events": _mock_events,
    }.get(svc, MagicMock())),
):
    import index


# ---------------------------------------------------------------------------
# Helpers
# ---------------------------------------------------------------------------

def _make_task_request_event(task="do something", callback=None, app_id=None):
    """Build a task.request EventBridge event."""
    detail = {"task": task}
    if callback is not None:
        detail["callback"] = callback
    if app_id is not None:
        detail["appId"] = app_id
    return {
        "source": "task.request",
        "detail": detail,
    }


def _bedrock_response_text(text="ok"):
    """Minimal Bedrock converse response with text only (no tool use)."""
    return {
        "output": {
            "message": {
                "role": "assistant",
                "content": [{"text": text}],
            }
        }
    }


# ---------------------------------------------------------------------------
# Tests: handler extracts appId from task.request
# ---------------------------------------------------------------------------

class TestHandlerExtractsAppId:
    """Verify handler passes appId from task.request detail to orchestrate()."""

    @patch.object(index, "orchestrate")
    def test_handler_passes_app_id_to_orchestrate(self, mock_orchestrate):
        """When task.request includes appId, handler passes it to orchestrate()."""
        event = _make_task_request_event(task="build report", app_id="app-123")
        index.handler(event, {})

        mock_orchestrate.assert_called_once_with(
            initial_message="build report",
            callback=None,
            app_id="app-123",
        )

    @patch.object(index, "orchestrate")
    def test_handler_passes_none_when_no_app_id(self, mock_orchestrate):
        """When task.request has no appId, handler passes app_id=None."""
        event = _make_task_request_event(task="build report")
        index.handler(event, {})

        mock_orchestrate.assert_called_once_with(
            initial_message="build report",
            callback=None,
            app_id=None,
        )

    @patch.object(index, "orchestrate")
    def test_handler_passes_callback_and_app_id(self, mock_orchestrate):
        """When task.request has both callback and appId, both are passed."""
        cb = {"type": "sqs", "queueUrl": "https://sqs.fake/q"}
        event = _make_task_request_event(
            task="process order", callback=cb, app_id="app-456"
        )
        index.handler(event, {})

        mock_orchestrate.assert_called_once_with(
            initial_message="process order",
            callback=cb,
            app_id="app-456",
        )


# ---------------------------------------------------------------------------
# Tests: orchestrate() routes to app-scoped or global agent loading
# ---------------------------------------------------------------------------

class TestOrchestrateAppScopedRouting:
    """Verify orchestrate() calls load_app_scoped_agents when app_id is present,
    and load_config_from_dynamodb when app_id is None."""

    @patch.object(index, "save_orchestration")
    @patch.object(index, "invoke_agents_from_conversation")
    @patch.object(index, "bedrock_circuit_breaker")
    @patch("index.load_config_from_dynamodb")
    @patch("index.load_app_scoped_agents")
    def test_uses_app_scoped_agents_when_app_id_present(
        self, mock_load_app, mock_load_global, mock_breaker, mock_invoke, mock_save
    ):
        """When app_id is provided, orchestrate() calls load_app_scoped_agents."""
        mock_load_app.return_value = {
            "agents": [{"name": "agent1", "description": "test", "schema": {}}]
        }
        mock_breaker.call.return_value = _bedrock_response_text()

        index.orchestrate(initial_message="hello", app_id="app-789")

        mock_load_app.assert_called_once_with("app-789")
        mock_load_global.assert_not_called()

    @patch.object(index, "save_orchestration")
    @patch.object(index, "invoke_agents_from_conversation")
    @patch.object(index, "bedrock_circuit_breaker")
    @patch("index.load_config_from_dynamodb")
    @patch("index.load_app_scoped_agents")
    def test_uses_global_agents_when_no_app_id(
        self, mock_load_app, mock_load_global, mock_breaker, mock_invoke, mock_save
    ):
        """When app_id is None, orchestrate() calls load_config_from_dynamodb."""
        mock_load_global.return_value = {
            "agents": [{"name": "agent1", "description": "test", "schema": {}}]
        }
        mock_breaker.call.return_value = _bedrock_response_text()

        index.orchestrate(initial_message="hello", app_id=None)

        mock_load_global.assert_called_once()
        mock_load_app.assert_not_called()

    @patch.object(index, "save_orchestration")
    @patch.object(index, "invoke_agents_from_conversation")
    @patch.object(index, "bedrock_circuit_breaker")
    @patch("index.load_config_from_dynamodb")
    @patch("index.load_app_scoped_agents")
    def test_uses_global_agents_when_app_id_not_passed(
        self, mock_load_app, mock_load_global, mock_breaker, mock_invoke, mock_save
    ):
        """When app_id is not passed at all (default), uses global loading."""
        mock_load_global.return_value = {
            "agents": [{"name": "agent1", "description": "test", "schema": {}}]
        }
        mock_breaker.call.return_value = _bedrock_response_text()

        index.orchestrate(initial_message="hello")

        mock_load_global.assert_called_once()
        mock_load_app.assert_not_called()

    @patch.object(index, "save_orchestration")
    @patch.object(index, "invoke_agents_from_conversation")
    @patch.object(index, "bedrock_circuit_breaker")
    @patch("index.load_config_from_dynamodb")
    @patch("index.load_app_scoped_agents")
    def test_no_agents_sends_response_for_app_scoped(
        self, mock_load_app, mock_load_global, mock_breaker, mock_invoke, mock_save
    ):
        """When app-scoped loading returns no agents, sends 'no active agents' response."""
        mock_load_app.return_value = {"agents": []}

        with patch.object(index, "send_response") as mock_send:
            index.orchestrate(initial_message="hello", app_id="app-empty")

        mock_load_app.assert_called_once_with("app-empty")
        # Should not call bedrock since no agents
        mock_breaker.call.assert_not_called()
