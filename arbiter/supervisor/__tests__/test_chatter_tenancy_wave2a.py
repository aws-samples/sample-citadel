"""
Red-first tests for wave-2a chatter/dispatch tenancy (finding 87a171ad,
branch fix/chatter-tenancy).

Prior to this fix: the orchestration row carries a server-derived `orgId`
(landed on branch fix/task-request-tenancy), but nothing downstream of
`orchestrate()` actually threads it further:

- `process_agent_call`'s worker SQS dispatch payload has no `orgId` key at
  all (arbiter/supervisor/index.py ~L1001-1050).
- `process_agent_call`'s EventBridge "chatter" emission (DetailType
  'chatter', ~L1053-1080) has no `orgId` on its Detail.
- `invoke_agents_from_conversation`'s "supervisor.feedback" emission
  (~L1118-1150) has no `orgId` on its Detail.
- `send_response`'s "task.response" emission (~L1276-1340) has no `orgId`
  on its Detail.

The fix stamps `orchestration.get('orgId')` onto all four surfaces, using
the SAME additive-when-present idiom as `evalRunId`/`callback`/`runId` —
EXCEPT for chatter/feedback emission, which must FAIL CLOSED: if
`orchestration` carries no orgId, the chatter/feedback EventBridge put
must be skipped entirely (never emit chatter without a tenancy stamp),
logged at error level. The worker SQS dispatch payload gate is enforced
one level up: `handler()` already refuses `task.request` events lacking
`detail.orgId` before `orchestrate()`/`create_orchestration()` ever runs,
so every orchestration row reaching `process_agent_call` already carries a
non-empty `orgId` in production — but this test module still exercises the
narrower unit contract (orchestration dict in, payload/Detail out) without
relying on that upstream gate, and additionally proves process_agent_call
itself fails closed (no SQS send, no chatter emit) if ever handed an
orchestration row with no orgId.
"""
import json
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


def _agents_config():
    return {
        "agents": [
            {
                "name": "worker-agent",
                "action": {"type": "sqs", "target": "https://sqs.example/queue"},
            }
        ]
    }


def _orchestration(org_id="org-alpha"):
    orch = {
        "orchestrationId": "orch-1",
        "conversation": [],
    }
    if org_id is not None:
        orch["orgId"] = org_id
    return orch


class TestProcessAgentCallWorkerPayloadCarriesOrgId:
    """process_agent_call's SQS dispatch payload must carry orgId from the
    orchestration row (additive, same idiom as evalRunId)."""

    def test_worker_payload_includes_org_id_when_present(self):
        index.EVENT_BUS_NAME = ""  # isolate: only assert on the SQS payload here
        _mock_sqs.reset_mock()

        index.process_agent_call(
            _agents_config(), _orchestration(org_id="org-alpha"),
            "worker-agent", {"foo": "bar"}, "use-1",
        )

        _mock_sqs.send_message.assert_called_once()
        sent_body = json.loads(_mock_sqs.send_message.call_args.kwargs["MessageBody"])
        assert sent_body["orgId"] == "org-alpha"

    def test_worker_dispatch_refused_when_org_id_absent(self, caplog):
        """Fail closed: process_agent_call must never dispatch to the
        worker queue for an orchestration row lacking orgId."""
        index.EVENT_BUS_NAME = ""
        _mock_sqs.reset_mock()

        index.process_agent_call(
            _agents_config(), _orchestration(org_id=None),
            "worker-agent", {"foo": "bar"}, "use-1",
        )

        _mock_sqs.send_message.assert_not_called()


class TestChatterEmissionCarriesOrgIdOrIsSkipped:
    """Every 'chatter'/'supervisor.feedback'/'task.response' EventBridge
    emission must carry orgId; absent orgId means the emission is skipped
    entirely (fail closed), never published org-less."""

    def test_agent_call_chatter_emission_includes_org_id(self):
        index.EVENT_BUS_NAME = "fake-bus"
        _mock_events.reset_mock()
        _mock_sqs.reset_mock()

        index.process_agent_call(
            _agents_config(), _orchestration(org_id="org-alpha"),
            "worker-agent", {"foo": "bar"}, "use-1",
        )

        _mock_events.put_events.assert_called_once()
        entry = _mock_events.put_events.call_args.kwargs["Entries"][0]
        detail = json.loads(entry["Detail"])
        assert detail["orgId"] == "org-alpha"

    def test_agent_call_chatter_emission_skipped_when_org_id_absent(self):
        index.EVENT_BUS_NAME = "fake-bus"
        _mock_events.reset_mock()
        _mock_sqs.reset_mock()

        index.process_agent_call(
            _agents_config(), _orchestration(org_id=None),
            "worker-agent", {"foo": "bar"}, "use-1",
        )

        _mock_events.put_events.assert_not_called()

    def test_supervisor_feedback_emission_includes_org_id(self):
        index.EVENT_BUS_NAME = "fake-bus"
        _mock_events.reset_mock()

        orchestration = _orchestration(org_id="org-beta")
        orchestration["conversation"] = [
            {"role": "assistant", "content": [{"text": "all done"}]}
        ]

        index.invoke_agents_from_conversation(orchestration, _agents_config())

        _mock_events.put_events.assert_called_once()
        entry = _mock_events.put_events.call_args.kwargs["Entries"][0]
        assert entry["DetailType"] == "supervisor.feedback"
        detail = json.loads(entry["Detail"])
        assert detail["orgId"] == "org-beta"

    def test_supervisor_feedback_emission_skipped_when_org_id_absent(self):
        index.EVENT_BUS_NAME = "fake-bus"
        _mock_events.reset_mock()

        orchestration = _orchestration(org_id=None)
        orchestration["conversation"] = [
            {"role": "assistant", "content": [{"text": "all done"}]}
        ]

        index.invoke_agents_from_conversation(orchestration, _agents_config())

        _mock_events.put_events.assert_not_called()

    def test_task_response_default_bus_includes_org_id(self):
        index.EVENT_BUS_NAME = "fake-bus"
        _mock_events.reset_mock()

        index.send_response("final answer", org_id="org-gamma")

        _mock_events.put_events.assert_called_once()
        entry = _mock_events.put_events.call_args.kwargs["Entries"][0]
        assert entry["DetailType"] == "task.response"
        detail = json.loads(entry["Detail"])
        assert detail["orgId"] == "org-gamma"

    def test_task_response_default_bus_skipped_when_org_id_absent(self):
        index.EVENT_BUS_NAME = "fake-bus"
        _mock_events.reset_mock()

        index.send_response("final answer", org_id=None)

        _mock_events.put_events.assert_not_called()

    def test_task_response_eventbridge_callback_includes_org_id(self):
        index.EVENT_BUS_NAME = "fake-bus"
        _mock_events.reset_mock()

        index.send_response(
            "final answer",
            callback={"type": "eventbridge"},
            org_id="org-delta",
        )

        _mock_events.put_events.assert_called_once()
        entry = _mock_events.put_events.call_args.kwargs["Entries"][0]
        detail = json.loads(entry["Detail"])
        assert detail["orgId"] == "org-delta"

    def test_task_response_eventbridge_callback_skipped_when_org_id_absent(self):
        index.EVENT_BUS_NAME = "fake-bus"
        _mock_events.reset_mock()

        index.send_response(
            "final answer",
            callback={"type": "eventbridge"},
            org_id=None,
        )

        _mock_events.put_events.assert_not_called()
