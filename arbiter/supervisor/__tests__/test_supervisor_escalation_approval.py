"""CIT-030 insertion point 2 — supervisor ESCALATE → awaiting_approval.

Tests:
  * APPROVAL_GATE_ENABLED=true + ESCALATE → orchestration written with
    status=awaiting_approval + approvalRequest, execution.paused emitted,
    process_agent_call NOT called, result reason='awaiting_approval:escalation'.
  * APPROVAL_GATE_ENABLED off + ESCALATE → existing terminal behaviour
    (byte-identical to pre-feature).
  * PERMIT unchanged regardless of gate.
  * HALT (gate on) → terminal (gate only activates for ESCALATE, not HALT).
"""
from __future__ import annotations

import os
import sys
from unittest.mock import MagicMock, call, patch

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
_mock_sns = MagicMock()

with patch.multiple(
    "boto3",
    resource=MagicMock(return_value=_mock_dynamodb),
    client=MagicMock(
        side_effect=lambda svc, **kw: {
            "sqs": _mock_sqs,
            "bedrock-runtime": _mock_bedrock,
            "events": _mock_events,
            "sns": _mock_sns,
        }.get(svc, MagicMock())
    ),
):
    import index as supervisor_mod  # noqa: E402

ArbitrationDecision = supervisor_mod.ArbitrationDecision
GovernanceFinding = supervisor_mod.GovernanceFinding


@pytest.fixture(autouse=True)
def _clean_env():
    saved_bypass = os.environ.pop("ARBITER_GOVERNANCE_BYPASS", None)
    saved_gate = os.environ.pop("APPROVAL_GATE_ENABLED", None)
    saved_env_lit = os.environ.pop("RELEASE_DISPATCH_ENVIRONMENT", None)
    prev_available = supervisor_mod._GOVERNANCE_AVAILABLE
    prev_topic = supervisor_mod.ESCALATION_TOPIC_ARN
    supervisor_mod.ESCALATION_TOPIC_ARN = "arn:aws:sns:us-east-1:123:escalations"
    yield
    if saved_bypass is not None:
        os.environ["ARBITER_GOVERNANCE_BYPASS"] = saved_bypass
    if saved_gate is not None:
        os.environ["APPROVAL_GATE_ENABLED"] = saved_gate
    else:
        os.environ.pop("APPROVAL_GATE_ENABLED", None)
    if saved_env_lit is not None:
        os.environ["RELEASE_DISPATCH_ENVIRONMENT"] = saved_env_lit
    else:
        os.environ.pop("RELEASE_DISPATCH_ENVIRONMENT", None)
    supervisor_mod._GOVERNANCE_AVAILABLE = prev_available
    supervisor_mod.ESCALATION_TOPIC_ARN = prev_topic


def _make_finding(decision, reason="escalation-test"):
    return GovernanceFinding.create(
        workflow_id="wf-esc",
        decision=decision,
        requesting_agent="supervisor",
        target_agent="agent-a",
        reason=reason,
        scope_evaluated="supervisor-dispatch",
    )


def _make_state(mode="strict"):
    state = MagicMock()
    state.authority_units = []
    state.composition_contracts = []
    state.case_law = []
    state.constitutional_layers = []
    state.enforcement_mode = mode
    state.effective_at = None
    return state


_AGENTS_CFG = {"agents": [{"name": "agent-a", "domain": "billing", "registryStatus": "APPROVED"}]}
_ORCH = {"orchestrationId": "orch-esc-1", "orgId": "org-test"}


def _common_patches(mode, finding):
    return (
        patch.object(supervisor_mod, "load_governance_state", return_value=_make_state(mode)),
        patch.object(supervisor_mod, "GovernanceEngine"),
        patch.object(supervisor_mod, "write_finding"),
        patch.object(supervisor_mod, "process_agent_call", return_value={"dispatched": True}),
        patch.object(supervisor_mod, "save_orchestration"),
        patch.object(supervisor_mod, "_get_sns", return_value=_mock_sns),
    )


# --------------------------------------------------------------------------
# Gate ON + ESCALATE → awaiting_approval
# --------------------------------------------------------------------------

class TestGateOnEscalateAwaitsApproval:
    def test_orchestration_written_with_awaiting_approval(self, monkeypatch):
        monkeypatch.setattr(supervisor_mod, "_GOVERNANCE_AVAILABLE", True)
        os.environ["APPROVAL_GATE_ENABLED"] = "true"
        finding = _make_finding(ArbitrationDecision.ESCALATE)
        orch = dict(_ORCH)

        patches = _common_patches("strict", finding)
        with patches[0], patches[1] as ME, patches[2], patches[3] as mock_dispatch, \
                patches[4] as mock_save, patches[5]:
            ME.return_value.evaluate.return_value = finding
            _mock_events.reset_mock()

            result = supervisor_mod.governed_process_agent_call(
                _AGENTS_CFG, orch, "agent-a", {"x": 1}, "use-1",
            )

        # Not dispatched
        mock_dispatch.assert_not_called()

        # Orchestration saved with awaiting_approval status + approval request
        mock_save.assert_called_once()
        saved = mock_save.call_args.kwargs.get("orchestration", mock_save.call_args[0][0] if mock_save.call_args[0] else None)
        assert saved["status"] == "awaiting_approval"
        assert "approvalRequest" in saved
        ar = saved["approvalRequest"]
        assert ar["requestType"] == "escalation"
        assert ar["reason"] == "escalation-test"
        assert ar["requestedBy"] == "supervisor"
        assert "resumeToken" in ar

        # Result is the 'paused' outcome
        assert result["escalated"] is True
        assert result["reason"] == "awaiting_approval:escalation"
        assert result["finding_id"] == finding.finding_id

    def test_execution_paused_event_emitted(self, monkeypatch):
        monkeypatch.setattr(supervisor_mod, "_GOVERNANCE_AVAILABLE", True)
        os.environ["APPROVAL_GATE_ENABLED"] = "true"
        finding = _make_finding(ArbitrationDecision.ESCALATE)
        orch = dict(_ORCH)

        patches = _common_patches("strict", finding)
        with patches[0], patches[1] as ME, patches[2], patches[3], \
                patches[4], patches[5]:
            ME.return_value.evaluate.return_value = finding
            _mock_events.reset_mock()

            supervisor_mod.governed_process_agent_call(
                _AGENTS_CFG, orch, "agent-a", {"x": 1}, "use-1",
            )

        # execution.paused event emitted
        put_calls = _mock_events.put_events.call_args_list
        paused_entries = [
            c for c in put_calls
            if any(
                e.get("DetailType") == "execution.paused"
                for e in c.kwargs.get("Entries", c[1].get("Entries", []) if len(c) > 1 else [])
            )
        ]
        assert len(paused_entries) >= 1

    def test_sns_escalation_still_sent(self, monkeypatch):
        monkeypatch.setattr(supervisor_mod, "_GOVERNANCE_AVAILABLE", True)
        os.environ["APPROVAL_GATE_ENABLED"] = "true"
        finding = _make_finding(ArbitrationDecision.ESCALATE)
        orch = dict(_ORCH)

        patches = _common_patches("strict", finding)
        with patches[0], patches[1] as ME, patches[2], patches[3], \
                patches[4], patches[5]:
            ME.return_value.evaluate.return_value = finding
            _mock_sns.reset_mock()

            supervisor_mod.governed_process_agent_call(
                _AGENTS_CFG, orch, "agent-a", {"x": 1}, "use-1",
            )

        # SNS escalation still published (kept in place per spec)
        _mock_sns.publish.assert_called_once()


# --------------------------------------------------------------------------
# Gate OFF + ESCALATE → existing terminal behaviour
# --------------------------------------------------------------------------

class TestGateOffEscalateTerminal:
    def test_escalate_without_gate_returns_terminal(self, monkeypatch):
        monkeypatch.setattr(supervisor_mod, "_GOVERNANCE_AVAILABLE", True)
        os.environ.pop("APPROVAL_GATE_ENABLED", None)
        finding = _make_finding(ArbitrationDecision.ESCALATE)
        orch = dict(_ORCH)

        patches = _common_patches("strict", finding)
        with patches[0], patches[1] as ME, patches[2], patches[3] as mock_dispatch, \
                patches[4] as mock_save, patches[5]:
            ME.return_value.evaluate.return_value = finding

            result = supervisor_mod.governed_process_agent_call(
                _AGENTS_CFG, orch, "agent-a", {"x": 1}, "use-1",
            )

        mock_dispatch.assert_not_called()
        # save_orchestration NOT called from the ESCALATE path (terminal)
        mock_save.assert_not_called()
        assert result["escalated"] is True
        assert result["reason"] == "escalation-test"  # original reason, not awaiting_approval

    def test_gate_false_returns_terminal(self, monkeypatch):
        monkeypatch.setattr(supervisor_mod, "_GOVERNANCE_AVAILABLE", True)
        os.environ["APPROVAL_GATE_ENABLED"] = "false"
        finding = _make_finding(ArbitrationDecision.ESCALATE)
        orch = dict(_ORCH)

        patches = _common_patches("strict", finding)
        with patches[0], patches[1] as ME, patches[2], patches[3], \
                patches[4] as mock_save, patches[5]:
            ME.return_value.evaluate.return_value = finding

            result = supervisor_mod.governed_process_agent_call(
                _AGENTS_CFG, orch, "agent-a", {"x": 1}, "use-1",
            )

        mock_save.assert_not_called()
        assert result["reason"] == "escalation-test"


# --------------------------------------------------------------------------
# PERMIT unchanged regardless of gate
# --------------------------------------------------------------------------

class TestPermitUnchanged:
    def test_permit_dispatches_with_gate_on(self, monkeypatch):
        monkeypatch.setattr(supervisor_mod, "_GOVERNANCE_AVAILABLE", True)
        os.environ["APPROVAL_GATE_ENABLED"] = "true"
        finding = _make_finding(ArbitrationDecision.PERMIT)
        orch = dict(_ORCH)

        patches = _common_patches("strict", finding)
        with patches[0], patches[1] as ME, patches[2], patches[3] as mock_dispatch, \
                patches[4], patches[5]:
            ME.return_value.evaluate.return_value = finding

            result = supervisor_mod.governed_process_agent_call(
                _AGENTS_CFG, orch, "agent-a", {"x": 1}, "use-1",
            )

        mock_dispatch.assert_called_once()
        assert result == {"dispatched": True}


# --------------------------------------------------------------------------
# HALT (gate on) → still terminal (gate only for ESCALATE)
# --------------------------------------------------------------------------

class TestHaltStaysTerminal:
    def test_halt_with_gate_on_is_terminal(self, monkeypatch):
        monkeypatch.setattr(supervisor_mod, "_GOVERNANCE_AVAILABLE", True)
        os.environ["APPROVAL_GATE_ENABLED"] = "true"
        finding = _make_finding(ArbitrationDecision.HALT, reason="halt-reason")
        orch = dict(_ORCH)

        patches = _common_patches("strict", finding)
        with patches[0], patches[1] as ME, patches[2], patches[3] as mock_dispatch, \
                patches[4] as mock_save, patches[5]:
            ME.return_value.evaluate.return_value = finding

            result = supervisor_mod.governed_process_agent_call(
                _AGENTS_CFG, orch, "agent-a", {"x": 1}, "use-1",
            )

        mock_dispatch.assert_not_called()
        mock_save.assert_not_called()
        assert result["escalated"] is True
        assert result["reason"] == "halt-reason"
