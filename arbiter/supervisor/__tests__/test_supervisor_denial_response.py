"""Governance denials are reported to the caller, never silent.

Incident (run 576835c6): governed_process_agent_call returned
{'denied': True, 'finding_id', 'reason'} on a strict-mode DENY after writing
the ledger finding, and the supervisor did nothing with it: no task.response,
no chatter, no orchestration record. The caller waited forever.

Contract under test:
  - Every denied dispatch emits a 'supervisor.feedback' chatter event
    (Source SUPERVISOR_RESPONSE_SOURCE, orgId) naming the agent, the reason
    and the findingId.
  - A denied agent is never added to the workflow tracking record (no worker
    will ever complete it, so the resume would never fire).
  - When nothing was dispatched, the task ends: a task.response with status
    'denied' (reason, findingId, denials list, orgId, orchestrationId, runId)
    is published and the orchestration row is saved with status 'denied'.
  - When other agents were dispatched, the denial is fed back to the model
    as an error toolResult on resume, and the final task.response carries the
    denials list next to the model's text.
"""
from __future__ import annotations

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


ORG = "org-denial-test"
CALLBACK = {"type": "eventbridge"}
REASON = "residual_authority_denial:no_scope_covers_action"
FINDING = "72ba8c70-0000-4000-8000-000000000001"


def _denial(finding_id=FINDING, reason=REASON):
    result = {"denied": True, "reason": reason}
    if finding_id is not None:
        result["finding_id"] = finding_id
    return result


def _tool_use(name, use_id):
    return {"toolUse": {"toolUseId": use_id, "name": name, "input": {"q": 1}}}


def _orchestration(content, callback=CALLBACK):
    return {
        "orchestrationId": "orch-denied-1",
        "orgId": ORG,
        "runId": "run-denied-1",
        "callback": callback,
        "conversation": [
            {"role": "user", "content": [{"text": "do the thing"}]},
            {"role": "assistant", "content": content},
        ],
    }


def _agents_config(*names):
    return {"agents": [{"name": n} for n in names]}


def _published(mock_events, detail_type=None):
    out = []
    for call in mock_events.put_events.call_args_list:
        for entry in call.kwargs["Entries"]:
            if detail_type is None or entry["DetailType"] == detail_type:
                out.append((entry, json.loads(entry["Detail"])))
    return out


@pytest.fixture
def harness(monkeypatch):
    monkeypatch.setattr(index, "EVENT_BUS_NAME", "fake-bus")
    with patch.object(index, "events_client") as events, \
            patch.object(index, "save_orchestration") as save, \
            patch.object(index, "create_workflow_tracking_record",
                         return_value="req-1") as tracking, \
            patch.object(index, "governed_process_agent_call") as gov:
        yield {"events": events, "save": save, "tracking": tracking, "gov": gov}


class TestAllDispatchesDenied:
    def _run(self, harness, callback=CALLBACK, denial=None):
        harness["gov"].return_value = denial if denial is not None else _denial()
        orch = _orchestration([_tool_use("billing-agent", "use-1")], callback)
        index.invoke_agents_from_conversation(orch, _agents_config("billing-agent"))
        return orch

    def test_task_response_has_status_denied_with_reason_and_finding(self, harness):
        self._run(harness)

        responses = _published(harness["events"], "task.response")
        assert len(responses) == 1
        entry, detail = responses[0]
        assert entry["Source"] == index.SUPERVISOR_RESPONSE_SOURCE
        assert entry["EventBusName"] == index.EVENT_BUS_NAME
        assert detail["status"] == "denied"
        assert detail["reason"] == REASON
        assert detail["findingId"] == FINDING
        assert detail["orgId"] == ORG
        assert detail["orchestrationId"] == "orch-denied-1"
        assert detail["runId"] == "run-denied-1"
        assert detail["callback"] == CALLBACK

    def test_task_response_lists_each_denial(self, harness):
        self._run(harness)

        _, detail = _published(harness["events"], "task.response")[0]
        assert detail["denials"] == [
            {"agent": "billing-agent", "reason": REASON, "findingId": FINDING}
        ]

    def test_task_response_message_names_agent_and_reason(self, harness):
        self._run(harness)

        _, detail = _published(harness["events"], "task.response")[0]
        assert "billing-agent" in detail["message"]
        assert REASON in detail["message"]

    def test_denial_without_callback_publishes_to_platform_bus(self, harness):
        self._run(harness, callback=None)

        responses = _published(harness["events"], "task.response")
        assert len(responses) == 1
        assert responses[0][1]["status"] == "denied"
        assert "callback" not in responses[0][1]

    def test_chatter_event_names_agent_reason_and_finding(self, harness):
        self._run(harness)

        feedback = _published(harness["events"], "supervisor.feedback")
        assert len(feedback) == 1
        entry, detail = feedback[0]
        assert entry["Source"] == index.SUPERVISOR_RESPONSE_SOURCE
        assert entry["EventBusName"] == index.EVENT_BUS_NAME
        assert detail["action"] == "dispatch_denied"
        assert detail["agent_name"] == "billing-agent"
        assert detail["reason"] == REASON
        assert detail["findingId"] == FINDING
        assert detail["orgId"] == ORG
        assert detail["orchestration_id"] == "orch-denied-1"

    def test_orchestration_record_saved_with_denied_status(self, harness):
        orch = self._run(harness)

        harness["save"].assert_called()
        saved = harness["save"].call_args.kwargs.get("orchestration") \
            or harness["save"].call_args.args[0]
        assert saved is orch
        assert saved["status"] == "denied"
        assert saved["denials"][0]["agent"] == "billing-agent"
        assert saved["denials"][0]["findingId"] == FINDING
        assert "deniedAt" in saved

    def test_denied_agent_is_not_added_to_workflow_tracking(self, harness):
        self._run(harness)

        harness["tracking"].assert_not_called()

    def test_denial_without_finding_id_is_still_reported(self, harness):
        # e.g. governance_package_unavailable / release / approval refusals
        # carry a reason but no ledger finding.
        self._run(harness, denial=_denial(finding_id=None,
                                          reason="governance_package_unavailable"))

        _, detail = _published(harness["events"], "task.response")[0]
        assert detail["status"] == "denied"
        assert detail["reason"] == "governance_package_unavailable"
        assert "findingId" not in detail

    def test_response_failure_does_not_mask_the_saved_record(self, harness):
        harness["events"].put_events.side_effect = ValueError("bus down")

        orch = self._run(harness)

        assert orch["status"] == "denied"
        harness["save"].assert_called()

    def test_save_failure_still_publishes_the_response(self, harness):
        harness["save"].side_effect = ValueError("ddb down")

        self._run(harness)

        assert len(_published(harness["events"], "task.response")) == 1


class TestMixedDispatch:
    def _run(self, harness):
        harness["gov"].side_effect = [{"ResponseMetadata": {}}, _denial()]
        orch = _orchestration([
            _tool_use("ok-agent", "use-ok"),
            _tool_use("billing-agent", "use-denied"),
        ])
        index.invoke_agents_from_conversation(
            orch, _agents_config("ok-agent", "billing-agent"))
        return orch

    def test_only_dispatched_agents_are_tracked(self, harness):
        self._run(harness)

        harness["tracking"].assert_called_once_with(["ok-agent"])

    def test_no_terminal_response_while_other_agents_are_running(self, harness):
        orch = self._run(harness)

        assert _published(harness["events"], "task.response") == []
        assert orch.get("status") != "denied"

    def test_chatter_event_still_emitted_for_the_denied_agent(self, harness):
        self._run(harness)

        feedback = _published(harness["events"], "supervisor.feedback")
        assert [d["agent_name"] for _, d in feedback] == ["billing-agent"]
        assert feedback[0][1]["findingId"] == FINDING

    def test_denial_is_recorded_for_the_resume(self, harness):
        orch = self._run(harness)

        assert orch["pendingDenials"][0]["toolUseId"] == "use-denied"
        assert orch["denials"][0]["agent"] == "billing-agent"


class TestResumeFeedsDenialBackToModel:
    def test_denied_tool_use_gets_an_error_tool_result(self):
        orch = _orchestration([])
        orch["pendingDenials"] = [{
            "toolUseId": "use-denied", "agent": "billing-agent",
            "reason": REASON, "findingId": FINDING,
        }]
        results = {"Attributes": {"data": {
            "ok-agent": {"agent_use_id": "use-ok", "data": "fine"},
        }}}

        index.update_orchestration_with_results(results, orch)

        blocks = orch["conversation"][-1]["content"]
        by_id = {b["toolResult"]["toolUseId"]: b["toolResult"] for b in blocks}
        assert set(by_id) == {"use-ok", "use-denied"}
        assert by_id["use-denied"]["status"] == "error"
        payload = by_id["use-denied"]["content"][0]["json"]
        assert payload["reason"] == REASON
        assert payload["findingId"] == FINDING
        assert "status" not in by_id["use-ok"]

    def test_pending_denials_are_consumed_once(self):
        orch = _orchestration([])
        orch["pendingDenials"] = [{
            "toolUseId": "use-denied", "agent": "billing-agent",
            "reason": REASON, "findingId": FINDING,
        }]
        orch["denials"] = list(orch["pendingDenials"])

        index.update_orchestration_with_results(
            {"Attributes": {"data": {}}}, orch)

        assert "pendingDenials" not in orch
        assert len(orch["denials"]) == 1

    def test_final_text_response_carries_the_denials_list(self, harness):
        orch = _orchestration([{"text": "I could not reach billing."}])
        orch["denials"] = [{
            "toolUseId": "use-denied", "agent": "billing-agent",
            "reason": REASON, "findingId": FINDING,
        }]

        index.invoke_agents_from_conversation(orch, _agents_config("billing-agent"))

        _, detail = _published(harness["events"], "task.response")[0]
        assert detail["message"] == "I could not reach billing."
        assert detail["denials"][0]["agent"] == "billing-agent"
        assert detail["denials"][0]["findingId"] == FINDING


class TestEndToEndThroughOrchestrate:
    def test_strict_deny_reaches_the_caller(self, harness):
        harness["gov"].return_value = _denial()
        spec = {"toolSpec": {"name": "billing-agent"}}
        response = {
            "output": {"message": {"role": "assistant", "content": [
                _tool_use("billing-agent", "use-1")]}},
            "usage": {"inputTokens": 1, "outputTokens": 1, "totalTokens": 2},
        }
        orch = {
            "orchestrationId": "orch-e2e",
            "orgId": ORG,
            "runId": "run-e2e",
            "callback": CALLBACK,
            "conversation": [{"role": "user", "content": [{"text": "bill me"}]}],
        }
        with patch.object(index, "load_config_from_dynamodb",
                          return_value=_agents_config("billing-agent")), \
                patch.object(index, "create_agent_specs", return_value=[spec]), \
                patch.object(index.bedrock_circuit_breaker, "call",
                             return_value=response):
            index.orchestrate(orchestration=orch)

        _, detail = _published(harness["events"], "task.response")[0]
        assert detail["status"] == "denied"
        assert detail["findingId"] == FINDING
        assert orch["status"] == "denied"
        assert harness["save"].call_args_list[-1].kwargs.get("orchestration", orch)["status"] == "denied"


class TestSuccessPathUnchanged:
    def test_send_response_without_denial_args_adds_no_denial_keys(self):
        with patch.object(index, "events_client") as events:
            index.send_response("hello", callback=CALLBACK, org_id=ORG)

        _, detail = _published(events)[0]
        for key in ("status", "reason", "findingId", "denials"):
            assert key not in detail

    def test_permitted_dispatch_tracks_every_agent_and_sends_nothing(self, harness):
        harness["gov"].return_value = {"ResponseMetadata": {}}
        orch = _orchestration([_tool_use("ok-agent", "use-ok")])

        index.invoke_agents_from_conversation(orch, _agents_config("ok-agent"))

        harness["tracking"].assert_called_once_with(["ok-agent"])
        assert _published(harness["events"]) == []
        assert "denials" not in orch
