"""
CIT-102 Pass B — supervisor-side frozen-contract threading tests.

Mirrors test_handler_run_id_threading.py's pattern for the new
evalRunId/evalContext/forbiddenTools detail keys: handler() -> orchestrate()
-> create_orchestration() -> governed_process_agent_call() finding stamp ->
process_agent_call() worker-dispatch payload.

Acceptance mapped here:
  * absent contract keys => zero behavior change (byte-identical orchestration
    row / dispatch payload) — the additive-contract guarantee.
  * findings in eval context carry eval_run_id; non-eval dispatches produce
    a byte-identical finding (eval_run_id=None, stripped by the ledger).
"""
import os
import sys
from unittest.mock import MagicMock, patch

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


def _make_task_request_event(task="do something", eval_run_id=None, eval_context=None,
                              forbidden_tools=None):
    detail = {"task": task}
    if eval_run_id is not None:
        detail["evalRunId"] = eval_run_id
    if eval_context is not None:
        detail["evalContext"] = eval_context
    if forbidden_tools is not None:
        detail["forbiddenTools"] = forbidden_tools
    return {"source": "task.request", "detail": detail}


class TestHandlerExtractsEvalContractKeys:
    """handler() must extract detail.evalRunId/evalContext/forbiddenTools
    and pass them through to orchestrate(), absent-tolerant."""

    @patch.object(index, "orchestrate")
    def test_handler_passes_eval_keys_to_orchestrate(self, mock_orchestrate):
        event = _make_task_request_event(
            task="run eval case",
            eval_run_id="eval-run-1",
            eval_context=True,
            forbidden_tools=["dangerous_tool"],
        )
        index.handler(event, {})

        mock_orchestrate.assert_called_once_with(
            initial_message="run eval case",
            callback=None,
            app_id=None,
            run_id=None,
            eval_run_id="eval-run-1",
            eval_context=True,
            forbidden_tools=["dangerous_tool"],
        )

    @patch.object(index, "orchestrate")
    def test_handler_passes_none_when_eval_keys_absent(self, mock_orchestrate):
        """Additive-contract guarantee: absence of all three keys must not
        raise or default to anything other than None."""
        event = _make_task_request_event(task="normal dispatch")
        index.handler(event, {})

        mock_orchestrate.assert_called_once_with(
            initial_message="normal dispatch",
            callback=None,
            app_id=None,
            run_id=None,
            eval_run_id=None,
            eval_context=None,
            forbidden_tools=None,
        )


class TestOrchestrateThreadsEvalKeysToCreateOrchestration:
    """orchestrate() must forward its eval_run_id/eval_context/
    forbidden_tools parameters into create_orchestration() on the sole
    production call site."""

    @patch.object(index, "save_orchestration")
    @patch.object(index, "invoke_agents_from_conversation")
    @patch.object(index, "bedrock_circuit_breaker")
    @patch("index.load_config_from_dynamodb")
    @patch.object(index, "create_orchestration")
    def test_orchestrate_forwards_eval_keys(
        self, mock_create, mock_load_global, mock_breaker, mock_invoke, mock_save
    ):
        mock_create.return_value = {
            "orchestrationId": "orch-1",
            "conversation": [{"role": "user", "content": [{"text": "hi"}]}],
        }
        mock_load_global.return_value = {
            "agents": [{"name": "agent1", "description": "test", "schema": {}}]
        }
        mock_breaker.call.return_value = {
            "output": {"message": {"role": "assistant", "content": [{"text": "ok"}]}}
        }

        index.orchestrate(
            initial_message="hi",
            eval_run_id="eval-run-live-1",
            eval_context=True,
            forbidden_tools=["shell"],
        )

        _, kwargs = mock_create.call_args
        assert kwargs.get("eval_run_id") == "eval-run-live-1"
        assert kwargs.get("eval_context") is True
        assert kwargs.get("forbidden_tools") == ["shell"]

    @patch.object(index, "save_orchestration")
    @patch.object(index, "invoke_agents_from_conversation")
    @patch.object(index, "bedrock_circuit_breaker")
    @patch("index.load_config_from_dynamodb")
    @patch.object(index, "create_orchestration")
    def test_orchestrate_forwards_none_when_eval_keys_absent(
        self, mock_create, mock_load_global, mock_breaker, mock_invoke, mock_save
    ):
        """Additive-contract guarantee: no eval keys passed at all must not
        break existing no-eval callers."""
        mock_create.return_value = {
            "orchestrationId": "orch-2",
            "conversation": [{"role": "user", "content": [{"text": "hi"}]}],
        }
        mock_load_global.return_value = {
            "agents": [{"name": "agent1", "description": "test", "schema": {}}]
        }
        mock_breaker.call.return_value = {
            "output": {"message": {"role": "assistant", "content": [{"text": "ok"}]}}
        }

        index.orchestrate(initial_message="hi")

        _, kwargs = mock_create.call_args
        assert kwargs.get("eval_run_id") is None
        assert kwargs.get("eval_context") is None
        assert kwargs.get("forbidden_tools") is None


class TestCreateOrchestrationEvalKeyOmission:
    """create_orchestration() omits evalRunId/evalContext/forbiddenTools
    entirely (not null keys) when absent — byte-identical row to the
    pre-CIT-102 shape (the additive-contract guarantee)."""

    def test_omitted_when_absent(self):
        orch = index.create_orchestration(
            conversation=[{"role": "user", "content": [{"text": "hi"}]}],
        )
        assert "evalRunId" not in orch
        assert "evalContext" not in orch
        assert "forbiddenTools" not in orch

    def test_present_when_supplied(self):
        orch = index.create_orchestration(
            conversation=[{"role": "user", "content": [{"text": "hi"}]}],
            eval_run_id="eval-run-9",
            eval_context=True,
            forbidden_tools=["shell", "network"],
        )
        assert orch["evalRunId"] == "eval-run-9"
        assert orch["evalContext"] is True
        assert orch["forbiddenTools"] == ["shell", "network"]

    def test_empty_forbidden_tools_list_omitted(self):
        """An empty list must not be persisted as a truthy-looking empty
        key — omitted entirely, matching the 'non-empty list only'
        contract documented on create_orchestration."""
        orch = index.create_orchestration(
            conversation=[{"role": "user", "content": [{"text": "hi"}]}],
            forbidden_tools=[],
        )
        assert "forbiddenTools" not in orch


class TestGovernedProcessAgentCallStampsEvalRunId:
    """governed_process_agent_call() stamps finding.eval_run_id from
    orchestration['evalRunId'] pre-write, and never gates the dispatch
    decision on it (best-effort, same discipline as run_id/trace_id)."""

    @patch("index.write_finding")
    @patch("index.load_governance_state")
    @patch("index.GovernanceEngine")
    @patch("index.process_agent_call")
    def test_stamps_eval_run_id_when_present(
        self, mock_process_call, mock_engine_cls, mock_load_state, mock_write_finding
    ):
        from arbiter.governance.models import ArbitrationDecision, GovernanceFinding

        finding = GovernanceFinding.create(
            workflow_id="orch-eval-1",
            decision=ArbitrationDecision.PERMIT,
            requesting_agent="supervisor",
            target_agent="agent1",
            reason="scope covers request",
        )
        mock_engine_cls.return_value.evaluate.return_value = finding
        mock_load_state.return_value = MagicMock(
            enforcement_mode="strict",
            authority_units=[], composition_contracts=[], case_law=[],
            constitutional_layers=[],
        )

        orchestration = {
            "orchestrationId": "orch-eval-1",
            "evalRunId": "eval-run-42",
            "conversation": [],
        }
        agents_config = {"agents": [{"name": "agent1", "domain": "default"}]}

        index.governed_process_agent_call(
            agents_config, orchestration, "agent1", {"x": 1}, "use-1",
        )

        mock_write_finding.assert_called_once()
        (written_finding,), _ = mock_write_finding.call_args
        assert written_finding.eval_run_id == "eval-run-42"

    @patch("index.write_finding")
    @patch("index.load_governance_state")
    @patch("index.GovernanceEngine")
    @patch("index.process_agent_call")
    def test_eval_run_id_none_when_absent(
        self, mock_process_call, mock_engine_cls, mock_load_state, mock_write_finding
    ):
        """Non-eval dispatch (the overwhelming majority): finding.eval_run_id
        stays None, never gating the PERMIT decision or write_finding call."""
        from arbiter.governance.models import ArbitrationDecision, GovernanceFinding

        finding = GovernanceFinding.create(
            workflow_id="orch-normal-1",
            decision=ArbitrationDecision.PERMIT,
            requesting_agent="supervisor",
            target_agent="agent1",
            reason="scope covers request",
        )
        mock_engine_cls.return_value.evaluate.return_value = finding
        mock_load_state.return_value = MagicMock(
            enforcement_mode="strict",
            authority_units=[], composition_contracts=[], case_law=[],
            constitutional_layers=[],
        )

        orchestration = {"orchestrationId": "orch-normal-1", "conversation": []}
        agents_config = {"agents": [{"name": "agent1", "domain": "default"}]}

        index.governed_process_agent_call(
            agents_config, orchestration, "agent1", {"x": 1}, "use-1",
        )

        mock_write_finding.assert_called_once()
        (written_finding,), _ = mock_write_finding.call_args
        assert written_finding.eval_run_id is None


class TestProcessAgentCallThreadsForbiddenToolsToWorkerDispatch:
    """process_agent_call() must add evalRunId/evalContext/forbiddenTools
    onto the SQS worker-dispatch payload, read from the orchestration row,
    omitted entirely (not null keys) when absent."""

    def test_forbidden_tools_and_eval_keys_on_payload_when_present(self):
        agents_config = {
            "agents": [{
                "name": "agent1",
                "action": {"type": "sqs", "target": "https://sqs.fake/q"},
            }]
        }
        orchestration = {
            "orchestrationId": "orch-1",
            "evalRunId": "eval-run-7",
            "evalContext": True,
            "forbiddenTools": ["shell", "network"],
        }

        with patch.object(index, "sqs") as mock_sqs, \
             patch.object(index, "EVENT_BUS_NAME", None):
            mock_sqs.send_message.return_value = {"MessageId": "m1"}
            index.process_agent_call(
                agents_config, orchestration, "agent1", {"x": 1}, "use-1",
            )

        _, kwargs = mock_sqs.send_message.call_args
        import json as _json
        payload = _json.loads(kwargs["MessageBody"])
        assert payload["evalRunId"] == "eval-run-7"
        assert payload["evalContext"] is True
        assert payload["forbiddenTools"] == ["shell", "network"]

    def test_eval_keys_omitted_from_payload_when_absent(self):
        """Additive-contract guarantee: a non-eval orchestration row
        produces a byte-identical (pre-CIT-102) dispatch payload."""
        agents_config = {
            "agents": [{
                "name": "agent1",
                "action": {"type": "sqs", "target": "https://sqs.fake/q"},
            }]
        }
        orchestration = {"orchestrationId": "orch-2"}

        with patch.object(index, "sqs") as mock_sqs, \
             patch.object(index, "EVENT_BUS_NAME", None):
            mock_sqs.send_message.return_value = {"MessageId": "m2"}
            index.process_agent_call(
                agents_config, orchestration, "agent1", {"x": 1}, "use-1",
            )

        _, kwargs = mock_sqs.send_message.call_args
        import json as _json
        payload = _json.loads(kwargs["MessageBody"])
        assert "evalRunId" not in payload
        assert "evalContext" not in payload
        assert "forbiddenTools" not in payload
