"""Supervisor tenant-guard: trusted org-source resolution (decision 512b2f58).

The trusted source for the supervisor's bound org is the ORCHESTRATIONS row's
orgId (written by the supervisor after the resolver-side tenancy gate), NOT
the EventBridge event's detail.orgId.

Tests:
- Row org wins over event detail org.
- Event-only org accepted with WARN when the row has no orgId (fresh request).
- Row/event orgId disagreement fails closed + metric.
- task.completion loads orgId from the orchestration row; refuses when absent.
"""
from __future__ import annotations

import os
import sys
from unittest.mock import MagicMock, patch, call

import pytest

sys.path.insert(0, os.path.join(os.path.dirname(__file__), ".."))

os.environ.setdefault("AGENT_CONFIG_TABLE", "fake-table")
os.environ.setdefault("EVENT_BUS_NAME", "fake-bus")
os.environ.setdefault("ORCHESTRATION_TABLE", "fake-orch-table")
os.environ.setdefault("WORKER_STATE_TABLE", "fake-worker-table")
os.environ.setdefault("APPS_TABLE", "fake-apps-table")

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


def _make_task_request_event(task="do something", org_id=None,
                              orchestration_id=None):
    detail = {"task": task}
    if org_id is not None:
        detail["orgId"] = org_id
    if orchestration_id is not None:
        detail["orchestrationId"] = orchestration_id
    return {"source": "task.request", "detail": detail}


def _make_task_completion_event(orchestration_id, node="agent-1"):
    return {
        "source": "task.completion",
        "detail": {
            "orchestration_id": orchestration_id,
            "data": "done",
            "agent_use_id": "use-1",
            "node": node,
            "usage": [],
        },
    }


# ---------------------------------------------------------------------------
# task.request: row org wins
# ---------------------------------------------------------------------------
class TestTaskRequestRowOrgWins:
    """When the orchestration row exists AND has orgId, it is the trusted
    source — even when the event detail also carries orgId."""

    @patch.object(index, "orchestrate")
    @patch.object(index, "_resolve_orchestration_org_id", return_value="org-from-row")
    def test_row_org_used_when_both_present_and_agree(
        self, mock_resolve, mock_orchestrate
    ):
        event = _make_task_request_event(
            task="build it", org_id="org-from-row", orchestration_id="orch-99"
        )
        index.handler(event, {})

        mock_resolve.assert_called_once_with("orch-99")
        mock_orchestrate.assert_called_once()
        assert mock_orchestrate.call_args.kwargs["org_id"] == "org-from-row"

    @patch.object(index, "orchestrate")
    @patch.object(index, "_resolve_orchestration_org_id", return_value="org-from-row")
    def test_row_org_used_when_event_has_no_org(
        self, mock_resolve, mock_orchestrate
    ):
        """Row org is accepted even when the event detail has no orgId."""
        event = _make_task_request_event(
            task="build it", orchestration_id="orch-99"
        )
        index.handler(event, {})

        mock_orchestrate.assert_called_once()
        assert mock_orchestrate.call_args.kwargs["org_id"] == "org-from-row"


# ---------------------------------------------------------------------------
# task.request: event-only org accepted with WARN when row has none
# ---------------------------------------------------------------------------
class TestTaskRequestEventOnlyOrg:
    """When the orchestration row does not exist or has no orgId, the
    event detail's orgId is accepted as a fallback."""

    @patch.object(index, "orchestrate")
    @patch.object(index, "_resolve_orchestration_org_id", return_value="")
    def test_event_org_accepted_when_row_empty(
        self, mock_resolve, mock_orchestrate
    ):
        event = _make_task_request_event(
            task="build it", org_id="org-from-event", orchestration_id="orch-1"
        )
        index.handler(event, {})

        mock_orchestrate.assert_called_once()
        assert mock_orchestrate.call_args.kwargs["org_id"] == "org-from-event"

    @patch.object(index, "orchestrate")
    def test_event_org_accepted_when_no_orchestration_id(self, mock_orchestrate):
        """Fresh task.request with no orchestrationId — common path; uses
        event detail.orgId directly."""
        event = _make_task_request_event(task="build it", org_id="org-fresh")
        index.handler(event, {})

        mock_orchestrate.assert_called_once()
        assert mock_orchestrate.call_args.kwargs["org_id"] == "org-fresh"


# ---------------------------------------------------------------------------
# task.request: row/event disagreement fails closed
# ---------------------------------------------------------------------------
class TestTaskRequestOrgDisagreement:
    """When the orchestration row has orgId AND the event detail carries a
    DIFFERENT orgId, the dispatch is refused (fail closed) and a metric is
    emitted."""

    @patch.object(index, "_emit_org_source_mismatch_metric")
    @patch.object(index, "orchestrate")
    @patch.object(index, "_resolve_orchestration_org_id", return_value="org-A")
    def test_mismatch_fails_closed(
        self, mock_resolve, mock_orchestrate, mock_metric
    ):
        event = _make_task_request_event(
            task="build it", org_id="org-B", orchestration_id="orch-99"
        )
        index.handler(event, {})

        mock_orchestrate.assert_not_called()
        mock_metric.assert_called_once()

    @patch.object(index, "_emit_org_source_mismatch_metric")
    @patch.object(index, "orchestrate")
    @patch.object(index, "_resolve_orchestration_org_id", return_value="org-A")
    def test_mismatch_creates_no_orchestration_row(
        self, mock_resolve, mock_orchestrate, mock_metric
    ):
        event = _make_task_request_event(
            task="build it", org_id="org-B", orchestration_id="orch-99"
        )
        with patch.object(index, "create_orchestration") as mock_create:
            index.handler(event, {})

        mock_create.assert_not_called()


# ---------------------------------------------------------------------------
# task.request: no org from either source fails closed
# ---------------------------------------------------------------------------
class TestTaskRequestNoOrgAnywhere:
    """When neither the row nor the event provides an org, dispatch is
    refused (same fail-closed as the old missing-detail.orgId gate)."""

    @patch.object(index, "orchestrate")
    @patch.object(index, "_resolve_orchestration_org_id", return_value="")
    def test_no_org_fails_closed(self, mock_resolve, mock_orchestrate):
        event = _make_task_request_event(task="build it", orchestration_id="orch-1")
        index.handler(event, {})

        mock_orchestrate.assert_not_called()

    @patch.object(index, "orchestrate")
    def test_no_org_no_orch_id_fails_closed(self, mock_orchestrate):
        event = _make_task_request_event(task="build it")
        index.handler(event, {})

        mock_orchestrate.assert_not_called()


# ---------------------------------------------------------------------------
# task.completion: row org wins; refuses when absent
# ---------------------------------------------------------------------------
class TestTaskCompletionRowOrg:
    """task.completion loads the orchestration row; orgId on the row is the
    sole authority (the event does not carry orgId)."""

    @patch.object(index, "orchestrate")
    @patch.object(index, "update_orchestration_with_results")
    @patch.object(index, "update_workflow_tracking", return_value=(True, {"r": "ok"}))
    @patch.object(index, "parse_decimals", side_effect=lambda o: o)
    @patch.object(index, "load_orchestration")
    def test_continues_when_row_has_org(
        self, mock_load, mock_parse, mock_update, mock_update_results,
        mock_orchestrate,
    ):
        mock_load.return_value = {
            "orchestrationId": "orch-1",
            "orgId": "org-trusted",
            "request_id": "req-1",
            "conversation": [],
        }
        event = _make_task_completion_event("orch-1")
        index.handler(event, {})

        mock_orchestrate.assert_called_once()

    @patch.object(index, "orchestrate")
    @patch.object(index, "load_orchestration")
    def test_refuses_when_row_has_no_org(
        self, mock_load, mock_orchestrate,
    ):
        """Orchestration row with no orgId → fail closed, no continuation."""
        mock_load.return_value = {
            "orchestrationId": "orch-1",
            "request_id": "req-1",
            "conversation": [],
        }
        event = _make_task_completion_event("orch-1")
        index.handler(event, {})

        mock_orchestrate.assert_not_called()

    @patch.object(index, "orchestrate")
    @patch.object(index, "load_orchestration")
    def test_refuses_when_row_has_empty_org(
        self, mock_load, mock_orchestrate,
    ):
        mock_load.return_value = {
            "orchestrationId": "orch-1",
            "orgId": "",
            "request_id": "req-1",
            "conversation": [],
        }
        event = _make_task_completion_event("orch-1")
        index.handler(event, {})

        mock_orchestrate.assert_not_called()


# ---------------------------------------------------------------------------
# _resolve_orchestration_org_id unit tests
# ---------------------------------------------------------------------------
class TestResolveOrchestrationOrgId:
    """Unit tests for the row-reading helper itself."""

    def test_returns_org_from_row(self):
        mock_table = MagicMock()
        mock_table.get_item.return_value = {
            "Item": {"orchestrationId": "orch-1", "orgId": "org-found"}
        }
        _mock_dynamodb.Table.return_value = mock_table

        result = index._resolve_orchestration_org_id("orch-1")
        assert result == "org-found"

    def test_returns_empty_when_row_has_no_org(self):
        mock_table = MagicMock()
        mock_table.get_item.return_value = {
            "Item": {"orchestrationId": "orch-1"}
        }
        _mock_dynamodb.Table.return_value = mock_table

        result = index._resolve_orchestration_org_id("orch-1")
        assert result == ""

    def test_returns_empty_when_row_not_found(self):
        mock_table = MagicMock()
        mock_table.get_item.return_value = {}
        _mock_dynamodb.Table.return_value = mock_table

        result = index._resolve_orchestration_org_id("orch-1")
        assert result == ""

    def test_returns_empty_on_exception(self):
        mock_table = MagicMock()
        mock_table.get_item.side_effect = Exception("DynamoDB down")
        _mock_dynamodb.Table.return_value = mock_table

        result = index._resolve_orchestration_org_id("orch-1")
        assert result == ""

    def test_returns_empty_when_orchestration_id_empty(self):
        result = index._resolve_orchestration_org_id("")
        assert result == ""
