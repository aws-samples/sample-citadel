"""
Red-first tests for the callback-hardening gap on send_response
(finding 87a171ad, items g/h).

Prior to this fix: the `eventbridge` callback branch of `send_response()`
trusted THREE caller-supplied fields verbatim onto a `put_events` call —
`callback.eventBusName`, `callback.source`, and `callback.detailType` —
with no allowlist. A caller could target an arbitrary event bus (not just
the platform bus) and/or forge `Source: 'task.request'` (the Supervisor's
own dispatch-trigger source, see test_org_tenancy_task_request.py), which
would let a downstream consumer of `send_response`'s output re-enter the
Supervisor's own `task.request` handling loop from what is nominally a
*response* path. There was also a live `elif callback_type == 'sqs'`
branch that sent to an arbitrary caller-supplied `queueUrl`.

The fix pins the eventbridge callback to:
  - EventBusName: ALWAYS `EVENT_BUS_NAME` (platform bus), regardless of
    `callback.eventBusName`.
  - Source: ALWAYS the reserved constant `SUPERVISOR_RESPONSE_SOURCE`
    ('citadel.supervisor'), regardless of `callback.source`.
  - DetailType: ALWAYS `'task.response'`, regardless of
    `callback.detailType`.

And removes the `sqs` callback branch entirely — unknown/removed callback
types (including 'sqs') log and no-op, matching the existing 'mcp'
removal precedent already in this module.
"""
import os
import sys
from unittest.mock import MagicMock, patch

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


class TestEventBridgeCallbackIgnoresCallerSuppliedBusName:
    """The eventbridge callback branch must ALWAYS target EVENT_BUS_NAME,
    never a caller-supplied callback.eventBusName."""

    def test_caller_supplied_event_bus_name_is_ignored(self):
        with patch.object(index, "events_client") as mock_events:
            index.send_response(
                "hello",
                callback={
                    "type": "eventbridge",
                    "eventBusName": "attacker-controlled-bus",
                },
            )

        mock_events.put_events.assert_called_once()
        entries = mock_events.put_events.call_args.kwargs["Entries"]
        assert entries[0]["EventBusName"] == index.EVENT_BUS_NAME
        assert entries[0]["EventBusName"] != "attacker-controlled-bus"


class TestEventBridgeCallbackPinsSourceAndDetailType:
    """Source and DetailType on the eventbridge callback branch must be
    pinned to the reserved constants, never caller-supplied."""

    def test_caller_supplied_source_is_ignored(self):
        with patch.object(index, "events_client") as mock_events:
            index.send_response(
                "hello",
                callback={"type": "eventbridge", "source": "attacker.source"},
            )

        entries = mock_events.put_events.call_args.kwargs["Entries"]
        assert entries[0]["Source"] == index.SUPERVISOR_RESPONSE_SOURCE
        assert entries[0]["Source"] != "attacker.source"

    def test_caller_supplied_detail_type_is_ignored(self):
        with patch.object(index, "events_client") as mock_events:
            index.send_response(
                "hello",
                callback={"type": "eventbridge", "detailType": "not.task.response"},
            )

        entries = mock_events.put_events.call_args.kwargs["Entries"]
        assert entries[0]["DetailType"] == "task.response"
        assert entries[0]["DetailType"] != "not.task.response"

    def test_default_no_callback_path_also_uses_pinned_source(self):
        """The no-callback default branch (send to EVENT_BUS_NAME with no
        callback argument) must use the same reserved Source constant,
        not a bare literal that could drift from the callback branch."""
        with patch.object(index, "events_client") as mock_events:
            index.send_response("hello", callback=None)

        entries = mock_events.put_events.call_args.kwargs["Entries"]
        assert entries[0]["Source"] == index.SUPERVISOR_RESPONSE_SOURCE
        assert entries[0]["EventBusName"] == index.EVENT_BUS_NAME


class TestTaskRequestSourceCannotBeReEntered:
    """Negative test proving the Supervisor's own task.request dispatch
    rule cannot be re-triggered via a forged send_response callback: no
    combination of caller-supplied callback fields can produce an
    emitted event whose Source is 'task.request' (the exact source
    handler() gates dispatch on — see
    test_org_tenancy_task_request.py)."""

    def test_callback_claiming_task_request_source_is_impossible(self):
        with patch.object(index, "events_client") as mock_events:
            index.send_response(
                "hello",
                callback={
                    "type": "eventbridge",
                    "source": "task.request",
                    "eventBusName": "fake-bus",
                    "detailType": "System-Task",
                },
            )

        entries = mock_events.put_events.call_args.kwargs["Entries"]
        emitted_source = entries[0]["Source"]
        assert emitted_source != "task.request"
        assert emitted_source == index.SUPERVISOR_RESPONSE_SOURCE

        # Prove the emitted event, fed straight back into handler(), would
        # NOT be treated as a task.request dispatch trigger.
        forged_event = {
            "source": emitted_source,
            "detail": entries[0].get("Detail"),
        }
        with patch.object(index, "orchestrate") as mock_orchestrate:
            index.handler(forged_event, {})
        mock_orchestrate.assert_not_called()


class TestSqsCallbackBranchRemoved:
    """The `elif callback_type == 'sqs'` branch is deleted. An 'sqs'
    callback type is now an unknown type: logged, no-op, no SQS call."""

    def test_sqs_callback_type_does_not_call_sqs_send_message(self):
        with patch.object(index, "sqs") as mock_sqs:
            index.send_response(
                "hello",
                callback={"type": "sqs", "queueUrl": "https://sqs.example/q"},
            )

        mock_sqs.send_message.assert_not_called()

    def test_sqs_callback_type_logs_unknown_and_does_not_raise(self, capsys):
        index.send_response(
            "hello",
            callback={"type": "sqs", "queueUrl": "https://sqs.example/q"},
        )
        captured = capsys.readouterr()
        assert "sqs" in captured.out.lower()

    def test_mcp_callback_type_still_unknown_and_no_op(self):
        """Pre-existing behavior (mcp removal) must be unaffected by this
        change."""
        with patch.object(index, "events_client") as mock_events, \
                patch.object(index, "sqs") as mock_sqs:
            index.send_response(
                "hello",
                callback={"type": "mcp", "endpoint": "https://example/webhook"},
            )

        mock_events.put_events.assert_not_called()
        mock_sqs.send_message.assert_not_called()
