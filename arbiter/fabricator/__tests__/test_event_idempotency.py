"""Slice B (CIT-125): fabricator dedupe on message id (DEVIATION — see below).

Design B.1 specifies dedupe keyed on the EventBridge envelope ``event["id"]``
for both supervisor and fabricator. Verified against the real wiring
(backend/lib/arbiter-stack.ts: fabricatorQueue has NO EventBridge Rule
target — only ``new SqsEventSource(fabricatorQueue, ...)``; the two producers
that enqueue to it, ``fabricator-request-resolver.ts`` and
``agent-import-resolver.ts``, both call SQS ``SendMessageCommand`` directly
with a hand-built JSON body that carries no EventBridge envelope and no
``id``/``detail`` field at all). There is no ``event.id`` for the fabricator
to dedupe on.

DEVIATION (disclosed, see reply): dedupe is keyed on the SQS ``messageId``
(``record["messageId"]``) instead. This preserves the design's core
guarantee — the key is stable across at-least-once SQS redelivery AND across
an SQS DLQ redrive (moving a message back to the source queue preserves its
``messageId``) — via the substrate the fabricator is actually built on,
rather than one it isn't.

Two-phase semantics (design B.1): PENDING claimed before the fabrication
body runs; promoted to DONE on success. A redelivery seeing an existing
PENDING record routes to reconcile (does not re-enter fabrication); a
redelivery seeing DONE is a no-op.
"""

import os
import sys
from unittest.mock import MagicMock, patch

import pytest
from botocore.exceptions import ClientError

sys.path.insert(0, os.path.join(os.path.dirname(__file__), ".."))

os.environ.setdefault("TOOL_CONFIG_TABLE", "fake-tool-table")
os.environ.setdefault("AGENT_CONFIG_TABLE", "fake-agent-table")
os.environ.setdefault("AGENT_BUCKET_NAME", "fake-bucket")
os.environ.setdefault("COMPLETION_BUS_NAME", "fake-bus")
os.environ.setdefault("WORKER_QUEUE_URL", "https://sqs.fake/queue")
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


def _sqs_record(message_id: str, body: dict, request_type: str | None = None):
    record = {
        "messageId": message_id,
        "body": __import__("json").dumps(body),
    }
    if request_type is not None:
        record["messageAttributes"] = {
            "requestType": {"stringValue": request_type}
        }
    return record


class TestFabricatorLambdaHandlerDedupe:
    def test_first_delivery_of_message_processes_once(self):
        event = {
            "Records": [
                _sqs_record(
                    "msg-first-111",
                    {"agent_input": {"taskDetails": "build a thing"}, "orchestration_id": "0"},
                )
            ]
        }
        with patch("index._claim_message_id", return_value="CLAIMED") as claim, \
                patch("index.process_event") as process_event:
            index.lambda_handler(event, {})

        claim.assert_called_once_with("msg-first-111")
        process_event.assert_called_once()

    def test_duplicate_delivery_same_message_id_while_pending_does_not_refabricate(self):
        """RED: today lambda_handler has zero dedupe — every record in
        event['Records'] unconditionally calls process_event, so a
        redelivered SQS message (at-least-once, or a DLQ redrive of a
        message still mid-flight) re-enters fabrication. A PENDING claim
        state must route to reconcile instead."""
        event = {
            "Records": [
                _sqs_record(
                    "msg-dup-222",
                    {"agent_input": {"taskDetails": "build a thing"}, "orchestration_id": "0"},
                )
            ]
        }
        with patch("index._claim_message_id", return_value="ALREADY_PENDING") as claim, \
                patch("index.process_event") as process_event, \
                patch("index._route_to_reconcile") as reconcile:
            index.lambda_handler(event, {})

        claim.assert_called_once_with("msg-dup-222")
        process_event.assert_not_called()
        reconcile.assert_called_once_with("msg-dup-222")

    def test_redrive_of_done_message_is_a_noop(self):
        """A later redrive of a message whose fabrication already
        completed (DONE) must not re-fabricate and must not error."""
        event = {
            "Records": [
                _sqs_record(
                    "msg-done-333",
                    {"agent_input": {"taskDetails": "build a thing"}, "orchestration_id": "0"},
                )
            ]
        }
        with patch("index._claim_message_id", return_value="ALREADY_DONE") as claim, \
                patch("index.process_event") as process_event, \
                patch("index._route_to_reconcile") as reconcile:
            index.lambda_handler(event, {})

        claim.assert_called_once_with("msg-done-333")
        process_event.assert_not_called()
        reconcile.assert_not_called()

    def test_successful_fabrication_marks_message_done(self):
        event = {
            "Records": [
                _sqs_record(
                    "msg-success-444",
                    {"agent_input": {"taskDetails": "build a thing"}, "orchestration_id": "0"},
                )
            ]
        }
        with patch("index._claim_message_id", return_value="CLAIMED"), \
                patch("index.process_event") as process_event, \
                patch("index._complete_message_id") as complete:
            index.lambda_handler(event, {})

        process_event.assert_called_once()
        complete.assert_called_once_with("msg-success-444")

    def test_failed_fabrication_does_not_mark_done(self):
        """On a raised exception from process_event, the message must NOT
        be marked DONE (so a redrive can legitimately retry), and the
        exception must still propagate so SQS/DLQ semantics apply."""
        event = {
            "Records": [
                _sqs_record(
                    "msg-fail-555",
                    {"agent_input": {"taskDetails": "build a thing"}, "orchestration_id": "0"},
                )
            ]
        }
        with patch("index._claim_message_id", return_value="CLAIMED"), \
                patch("index.process_event", side_effect=RuntimeError("boom")), \
                patch("index._complete_message_id") as complete:
            with pytest.raises(RuntimeError):
                index.lambda_handler(event, {})

        complete.assert_not_called()


class TestClaimMessageIdImplementation:
    """Unit coverage of the two-phase claim helper itself."""

    def test_claim_returns_claimed_on_first_put(self):
        fake_table = MagicMock()
        fake_table.put_item.return_value = {}
        with patch("index._idempotency_table", return_value=fake_table):
            result = index._claim_message_id("msg-unit-1")

        assert result == "CLAIMED"
        _, kwargs = fake_table.put_item.call_args
        assert kwargs["Item"]["eventId"] == "msg-unit-1"
        assert kwargs["Item"]["status"] == "PENDING"
        assert "ttl" in kwargs["Item"]

    def test_claim_returns_already_pending_when_existing_record_is_pending(self):
        fake_table = MagicMock()
        fake_table.put_item.side_effect = _conditional_check_failed()
        fake_table.get_item.return_value = {"Item": {"eventId": "msg-unit-2", "status": "PENDING"}}
        with patch("index._idempotency_table", return_value=fake_table):
            result = index._claim_message_id("msg-unit-2")

        assert result == "ALREADY_PENDING"

    def test_claim_returns_already_done_when_existing_record_is_done(self):
        fake_table = MagicMock()
        fake_table.put_item.side_effect = _conditional_check_failed()
        fake_table.get_item.return_value = {"Item": {"eventId": "msg-unit-3", "status": "DONE"}}
        with patch("index._idempotency_table", return_value=fake_table):
            result = index._claim_message_id("msg-unit-3")

        assert result == "ALREADY_DONE"

    def test_complete_message_id_updates_status_to_done(self):
        fake_table = MagicMock()
        with patch("index._idempotency_table", return_value=fake_table):
            index._complete_message_id("msg-unit-4")

        fake_table.update_item.assert_called_once()
        _, kwargs = fake_table.update_item.call_args
        assert kwargs["Key"]["eventId"] == "msg-unit-4"
