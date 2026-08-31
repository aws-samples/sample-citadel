"""Slice B (CIT-125): supervisor event.id dedupe.

Guards against duplicate dispatch/continuation on at-least-once EventBridge
delivery and DLQ redrive by claiming ``event["id"]`` in the shared
``citadel-idempotency-<env>`` table (PK ``eventId``) before doing any work.

Contract under test (design B.1):
  - First delivery of a given event id: claim succeeds, handler proceeds
    (``orchestrate`` / continuation called).
  - Duplicate delivery of the SAME event id: claim raises
    ``ConditionalCheckFailedException`` -> handler is a no-op (ACK, return).
  - Distinct event ids are each processed once (no false-positive dedupe).
  - A DDB error OTHER than the conditional-check failure on the claim write
    must propagate (rethrown) so the message is redelivered / DLQ'd rather
    than silently swallowed.
"""

import os
import sys
from unittest.mock import MagicMock, patch

import pytest
from botocore.exceptions import ClientError

sys.path.insert(0, os.path.join(os.path.dirname(__file__), ".."))

os.environ.setdefault("ORCHESTRATION_TABLE", "fake-orchestration-table")
os.environ.setdefault("WORKER_STATE_TABLE", "fake-worker-state-table")
os.environ.setdefault("AGENT_CONFIG_TABLE", "fake-agent-config-table")
os.environ.setdefault("EVENT_BUS_NAME", "fake-bus")
os.environ.setdefault("COMPLETION_BUS_NAME", "fake-bus")
os.environ.setdefault("IDEMPOTENCY_TABLE", "citadel-idempotency-test")
os.environ.setdefault("AWS_DEFAULT_REGION", "us-west-2")

import index  # noqa: E402


def _conditional_check_failed():
    return ClientError(
        error_response={
            "Error": {
                "Code": "ConditionalCheckFailedException",
                "Message": "The conditional request failed",
            }
        },
        operation_name="PutItem",
    )


def _throttling_error():
    return ClientError(
        error_response={
            "Error": {
                "Code": "ProvisionedThroughputExceededException",
                "Message": "throttled",
            }
        },
        operation_name="PutItem",
    )


class TestSupervisorTaskRequestDedupe:
    def test_first_delivery_dispatches_once(self):
        event = {
            "source": "task.request",
            "detail": {"task": "do the thing", "appId": "app-1"},
            "id": "evt-aaa-111",
        }
        with patch("index._claim_event_id", return_value=True) as claim, \
                patch("index.orchestrate") as orchestrate:
            index.handler(event, {})

        claim.assert_called_once_with("evt-aaa-111")
        orchestrate.assert_called_once()

    def test_duplicate_task_request_same_event_id_dispatches_once(self):
        """RED: today the handler has no dedupe guard at all, so a
        duplicate delivery of the same event id calls orchestrate() a
        second time. This must become a no-op."""
        event = {
            "source": "task.request",
            "detail": {"task": "do the thing", "appId": "app-1"},
            "id": "evt-dup-222",
        }
        with patch("index._claim_event_id", return_value=False) as claim, \
                patch("index.orchestrate") as orchestrate:
            index.handler(event, {})

        claim.assert_called_once_with("evt-dup-222")
        orchestrate.assert_not_called()

    def test_distinct_event_ids_both_processed(self):
        """No false-positive dedupe across genuinely distinct events."""
        event_a = {
            "source": "task.request",
            "detail": {"task": "task A"},
            "id": "evt-distinct-a",
        }
        event_b = {
            "source": "task.request",
            "detail": {"task": "task B"},
            "id": "evt-distinct-b",
        }
        with patch("index._claim_event_id", return_value=True) as claim, \
                patch("index.orchestrate") as orchestrate:
            index.handler(event_a, {})
            index.handler(event_b, {})

        assert claim.call_count == 2
        assert orchestrate.call_count == 2

    def test_claim_ddb_transient_error_propagates_not_swallowed(self):
        """A non-conditional-check DDB error on the claim write must
        rethrow so EventBridge retries / eventually DLQs the message,
        rather than being treated as either success or duplicate."""
        event = {
            "source": "task.request",
            "detail": {"task": "do the thing"},
            "id": "evt-transient-err",
        }
        with patch("index._claim_event_id", side_effect=_throttling_error()), \
                patch("index.orchestrate") as orchestrate:
            with pytest.raises(ClientError):
                index.handler(event, {})

        orchestrate.assert_not_called()


class TestSupervisorTaskCompletionDedupe:
    def test_first_completion_triggers_continuation_once(self):
        event = {
            "source": "task.completion",
            "detail": {"orchestration_id": "orch-1", "node": "worker-a"},
            "id": "evt-completion-first",
        }
        fake_orchestration = {"request_id": "req-1"}
        with patch("index._claim_event_id", return_value=True) as claim, \
                patch("index.load_orchestration", return_value=fake_orchestration), \
                patch("index.update_workflow_tracking", return_value=(True, {"ok": True})), \
                patch("index.update_orchestration_with_results") as update_results, \
                patch("index.parse_decimals", side_effect=lambda x: x), \
                patch("index.orchestrate") as orchestrate:
            index.handler(event, {})

        claim.assert_called_once_with("evt-completion-first")
        update_results.assert_called_once()
        orchestrate.assert_called_once()

    def test_duplicate_completion_same_event_id_continues_once(self):
        """RED: today a redelivered task.completion re-runs
        update_orchestration_with_results + orchestrate() a second time.
        Must become a no-op on the duplicate delivery."""
        event = {
            "source": "task.completion",
            "detail": {"orchestration_id": "orch-1", "node": "worker-a"},
            "id": "evt-completion-dup",
        }
        with patch("index._claim_event_id", return_value=False) as claim, \
                patch("index.load_orchestration") as load_orch, \
                patch("index.update_workflow_tracking") as update_tracking, \
                patch("index.update_orchestration_with_results") as update_results, \
                patch("index.orchestrate") as orchestrate:
            index.handler(event, {})

        claim.assert_called_once_with("evt-completion-dup")
        load_orch.assert_not_called()
        update_tracking.assert_not_called()
        update_results.assert_not_called()
        orchestrate.assert_not_called()


class TestClaimEventIdImplementation:
    """Unit-level coverage of the conditional-put claim helper itself,
    independent of the handler wiring above."""

    def test_claim_returns_true_on_first_put(self):
        fake_table = MagicMock()
        fake_table.put_item.return_value = {}
        with patch("index._idempotency_table", return_value=fake_table):
            result = index._claim_event_id("evt-unit-1", consumer="supervisor")

        assert result is True
        _, kwargs = fake_table.put_item.call_args
        assert kwargs["Item"]["eventId"] == "evt-unit-1"
        assert "ttl" in kwargs["Item"]
        assert kwargs["ConditionExpression"] is not None

    def test_claim_returns_false_on_conditional_check_failed(self):
        fake_table = MagicMock()
        fake_table.put_item.side_effect = _conditional_check_failed()
        with patch("index._idempotency_table", return_value=fake_table):
            result = index._claim_event_id("evt-unit-2", consumer="supervisor")

        assert result is False

    def test_claim_reraises_other_client_errors(self):
        fake_table = MagicMock()
        fake_table.put_item.side_effect = _throttling_error()
        with patch("index._idempotency_table", return_value=fake_table):
            with pytest.raises(ClientError):
                index._claim_event_id("evt-unit-3", consumer="supervisor")
