"""Supervisor Converse-call usage capture + dispatch-result attachment tests.

Covers the design's supervisor-side additions:

  - ``orchestrate()`` captures ``response['usage']`` from the Bedrock
    Converse call, builds a ``source='supervisor'`` usage record, and
    threads it through ``invoke_agents_from_conversation`` ->
    ``governed_process_agent_call`` -> ``process_agent_call``.
  - ``process_agent_call`` stamps ``payload['supervisorUsage']`` on the SQS
    dispatch body when a supervisor usage record is supplied.
  - All new parameters default to ``None`` so existing callers/tests are
    unaffected (backward compatible); a missing/absent usage block degrades
    to zeros + a WARN log rather than raising, and dispatch still proceeds.

Follows the module-import and boto3-stubbing conventions of
``test_supervisor_app_id.py`` / ``test_supervisor_governed_dispatch.py``.
"""
from __future__ import annotations

import json
import logging
import os
import sys
from unittest.mock import MagicMock, patch

import pytest

sys.path.insert(0, os.path.join(os.path.dirname(__file__), ".."))

os.environ.setdefault("AGENT_CONFIG_TABLE", "fake-table")
os.environ.setdefault("EVENT_BUS_NAME", "fake-bus")
os.environ.setdefault("ORCHESTRATION_TABLE", "fake-orch-table")
os.environ.setdefault("WORKER_STATE_TABLE", "fake-worker-table")

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
    import index as supervisor_mod


def _bedrock_response_with_tool_use(usage=None):
    """A Converse response with a single toolUse content item, optionally
    carrying a usage block."""
    resp = {
        "output": {
            "message": {
                "role": "assistant",
                "content": [
                    {"toolUse": {"name": "agent-a", "input": {"x": 1}, "toolUseId": "tu-1"}},
                ],
            }
        }
    }
    if usage is not None:
        resp["usage"] = usage
    return resp


def _bedrock_response_text_only(text="ok", usage=None):
    resp = {
        "output": {
            "message": {
                "role": "assistant",
                "content": [{"text": text}],
            }
        }
    }
    if usage is not None:
        resp["usage"] = usage
    return resp


_AGENTS_CONFIG = {
    "agents": [{"name": "agent-a", "description": "test", "schema": {}, "action": {"type": "sqs", "target": "https://sqs.fake/q"}}]
}


class TestOrchestrateSupervisorUsageCapture:
    """orchestrate() captures Converse usage and threads it downstream."""

    @patch.object(supervisor_mod, "save_orchestration")
    @patch.object(supervisor_mod, "create_workflow_tracking_record", return_value="req-1")
    @patch.object(supervisor_mod, "governed_process_agent_call")
    @patch.object(supervisor_mod, "bedrock_circuit_breaker")
    @patch.object(supervisor_mod, "load_config_from_dynamodb")
    def test_supervisor_usage_threaded_to_governed_dispatch(
        self, mock_load, mock_breaker, mock_governed, mock_tracking, mock_save
    ):
        """A Converse response with a usage block results in
        governed_process_agent_call being invoked with a supervisor_usage
        kwarg carrying a source='supervisor' record."""
        mock_load.return_value = {"agents": _AGENTS_CONFIG["agents"]}
        mock_breaker.call.return_value = _bedrock_response_with_tool_use(
            usage={"inputTokens": 11, "outputTokens": 22, "totalTokens": 33}
        )
        mock_governed.return_value = {"ok": True}

        supervisor_mod.orchestrate(initial_message="hello")

        assert mock_governed.called
        _, kwargs = mock_governed.call_args
        supervisor_usage = kwargs.get("supervisor_usage")
        assert supervisor_usage is not None, \
            "expected governed_process_agent_call to receive a supervisor_usage kwarg"
        assert supervisor_usage["source"] == "supervisor"
        assert supervisor_usage["inputTokens"] == 11
        assert supervisor_usage["outputTokens"] == 22
        assert supervisor_usage["modelId"] == supervisor_mod.MODEL_ID

    @patch.object(supervisor_mod, "save_orchestration")
    @patch.object(supervisor_mod, "events_client")
    @patch.object(supervisor_mod, "bedrock_circuit_breaker")
    @patch.object(supervisor_mod, "load_config_from_dynamodb")
    def test_missing_usage_block_degrades_to_zeros_and_warn(
        self, mock_load, mock_breaker, mock_events_client, mock_save, caplog
    ):
        """A Converse response with NO usage block still lets orchestrate()
        proceed (text-only response path), degrading to a zeroed usage
        record rather than raising, and logs a WARN."""
        mock_load.return_value = {"agents": _AGENTS_CONFIG["agents"]}
        mock_breaker.call.return_value = _bedrock_response_text_only("done")

        with caplog.at_level(logging.WARNING, logger=supervisor_mod.logger.name):
            supervisor_mod.orchestrate(initial_message="hello")

        # Must not have raised; the text-only (no agents invoked, no
        # callback) path still publishes supervisor feedback to EventBridge.
        assert mock_events_client.put_events.called
        assert any(
            "no usage block" in r.message for r in caplog.records
        )

    @patch.object(supervisor_mod, "save_orchestration")
    @patch.object(supervisor_mod, "create_workflow_tracking_record", return_value="req-1")
    @patch.object(supervisor_mod, "governed_process_agent_call")
    @patch.object(supervisor_mod, "bedrock_circuit_breaker")
    @patch.object(supervisor_mod, "load_config_from_dynamodb")
    def test_backward_compatible_without_new_kwarg_semantics(
        self, mock_load, mock_breaker, mock_governed, mock_tracking, mock_save
    ):
        """orchestrate() still works end-to-end when the Converse response
        carries no usage block at all — dispatch is unaffected."""
        mock_load.return_value = {"agents": _AGENTS_CONFIG["agents"]}
        mock_breaker.call.return_value = _bedrock_response_with_tool_use(usage=None)
        mock_governed.return_value = {"ok": True}

        # Must not raise.
        supervisor_mod.orchestrate(initial_message="hello")
        assert mock_governed.called


class TestProcessAgentCallSupervisorUsageStamping:
    """process_agent_call stamps payload['supervisorUsage'] on the SQS body."""

    def _agent_config(self):
        return {
            "agents": [
                {"name": "agent-a", "action": {"type": "sqs", "target": "https://sqs.fake/q"}},
            ]
        }

    def test_supervisor_usage_stamped_on_sqs_payload(self):
        """When supervisor_usage is supplied, the SQS MessageBody JSON
        carries a 'supervisorUsage' key with the record."""
        _mock_sqs.send_message.reset_mock()
        usage_record = {
            "modelId": "m", "inputTokens": 1, "outputTokens": 2,
            "latencyMs": 3, "callIndex": 0,
            "capturedAt": "2024-01-01T00:00:00Z", "source": "supervisor",
        }

        with patch.object(supervisor_mod, "EVENT_BUS_NAME", None):
            result = supervisor_mod.process_agent_call(
                self._agent_config(),
                {"orchestrationId": "orch-1"},
                "agent-a",
                {"x": 1},
                "use-1",
                supervisor_usage=usage_record,
            )

        assert _mock_sqs.send_message.called
        _, kwargs = _mock_sqs.send_message.call_args
        body = json.loads(kwargs["MessageBody"])
        assert body.get("supervisorUsage") == usage_record

    def test_no_supervisor_usage_kwarg_is_backward_compatible(self):
        """Calling process_agent_call without supervisor_usage at all
        (the pre-existing call signature) still dispatches successfully,
        with no 'supervisorUsage' key forced into the payload."""
        _mock_sqs.send_message.reset_mock()

        with patch.object(supervisor_mod, "EVENT_BUS_NAME", None):
            result = supervisor_mod.process_agent_call(
                self._agent_config(),
                {"orchestrationId": "orch-1"},
                "agent-a",
                {"x": 1},
                "use-1",
            )

        assert _mock_sqs.send_message.called
        _, kwargs = _mock_sqs.send_message.call_args
        body = json.loads(kwargs["MessageBody"])
        assert "supervisorUsage" not in body

    def test_none_supervisor_usage_omits_key_entirely(self):
        """Explicit supervisor_usage=None must not add a null key to the
        payload — it should behave identically to omitting the kwarg."""
        _mock_sqs.send_message.reset_mock()

        with patch.object(supervisor_mod, "EVENT_BUS_NAME", None):
            supervisor_mod.process_agent_call(
                self._agent_config(),
                {"orchestrationId": "orch-1"},
                "agent-a",
                {"x": 1},
                "use-1",
                supervisor_usage=None,
            )

        _, kwargs = _mock_sqs.send_message.call_args
        body = json.loads(kwargs["MessageBody"])
        assert "supervisorUsage" not in body


class TestGovernedProcessAgentCallForwardsSupervisorUsage:
    """governed_process_agent_call's permit/shadow/permissive paths forward
    supervisor_usage through to process_agent_call unchanged."""

    def _state(self, enforcement_mode="shadow"):
        state = MagicMock()
        state.authority_units = []
        state.composition_contracts = []
        state.case_law = []
        state.constitutional_layers = []
        state.enforcement_mode = enforcement_mode
        return state

    def test_shadow_mode_forwards_supervisor_usage(self, monkeypatch):
        monkeypatch.setattr(supervisor_mod, "_GOVERNANCE_AVAILABLE", True)
        usage_record = {"source": "supervisor", "inputTokens": 5}

        with patch.object(supervisor_mod, "load_governance_state", return_value=self._state("shadow")), \
             patch.object(supervisor_mod, "GovernanceEngine") as mock_engine_cls, \
             patch.object(supervisor_mod, "write_finding"), \
             patch.object(supervisor_mod, "process_agent_call") as mock_dispatch:
            mock_finding = MagicMock()
            mock_finding.scope_evaluated = "supervisor-dispatch"
            mock_engine_cls.return_value.evaluate.return_value = mock_finding

            supervisor_mod.governed_process_agent_call(
                {"agents": [{"name": "agent-a", "domain": "d"}]},
                {"orchestrationId": "orch-1"},
                "agent-a",
                {"x": 1},
                "use-1",
                supervisor_usage=usage_record,
            )

        mock_dispatch.assert_called_once()
        _, kwargs = mock_dispatch.call_args
        assert kwargs.get("supervisor_usage") == usage_record
