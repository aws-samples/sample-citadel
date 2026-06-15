"""US-ARB-008 tests — ``governed_process_agent_call`` control-surface band.

Covers all four decision branches (PERMIT, DENY, ESCALATE, HALT) and the
bypass / fail-closed / degraded-mode invariants per Requirement 6.

The supervisor module imports ``governance`` lazily at module load time and
sets ``_GOVERNANCE_AVAILABLE``. The arbiter ``conftest.py`` inserts each
submodule directory onto ``sys.path``; ``index.py`` adds the ``arbiter/``
parent dir itself before attempting the governance import, so governance
resolves from tests without this file needing extra path manipulation.

Test isolation: these tests intentionally do NOT patch boto3 at module scope
— the other supervisor test modules (notably ``test_index_properties.py``)
assert against their own module-level mock instances after importing
``index``. Module-scoped patches here would race that behaviour via the
shared ``sys.modules['index']`` cache. Instead every test patches only the
hooks it needs (``load_governance_state``, ``GovernanceEngine``,
``write_finding``, ``process_agent_call``, ``_get_sns``) using
``patch.object`` on ``supervisor_mod`` — all well-scoped and reverted
automatically on test exit.
"""
from __future__ import annotations

import os
import sys
from unittest.mock import MagicMock, patch

import pytest

sys.path.insert(0, os.path.join(os.path.dirname(__file__), ".."))

os.environ.setdefault("AGENT_CONFIG_TABLE", "fake-table")
os.environ.setdefault("EVENT_BUS_NAME", "fake-bus")
os.environ.setdefault("ORCHESTRATION_TABLE", "fake-orch-table")
os.environ.setdefault("WORKER_STATE_TABLE", "fake-worker-table")

# Patch boto3 only for the duration of the ``index`` import. We don't keep
# the patch active beyond that — subsequent imports of ``index`` from other
# test modules are no-ops (sys.modules cache hit), and those modules use
# their own function-scoped patches to drive behaviour.
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

# Governance symbols — re-exported on the supervisor module by its private
# governance loader (``_load_governance_package``). We deliberately do NOT
# import the ``governance`` top-level name here because
# ``arbiter/workerWrapper/governance.py`` also resolves to that name under
# the conftest ``sys.path`` layout, and we don't want to pollute
# ``sys.modules['governance']`` from a supervisor test.
ArbitrationDecision = supervisor_mod.ArbitrationDecision
GovernanceFinding = supervisor_mod.GovernanceFinding


# ---------------------------------------------------------------------------
# Fixtures / helpers
# ---------------------------------------------------------------------------


@pytest.fixture(autouse=True)
def _clean_env(monkeypatch):
    """Clear governance env vars so each test starts from a known baseline."""
    monkeypatch.delenv("ARBITER_GOVERNANCE_BYPASS", raising=False)
    monkeypatch.delenv("ESCALATION_TOPIC_ARN", raising=False)
    # ``ESCALATION_TOPIC_ARN`` is snapshotted at module-load time — reset it.
    monkeypatch.setattr(supervisor_mod, "ESCALATION_TOPIC_ARN", None)
    yield


def _make_finding(
    decision: ArbitrationDecision,
    scope_evaluated: str | None = None,
    reason: str = "test-reason",
) -> GovernanceFinding:
    """Build a minimal GovernanceFinding for engine stubs to return."""
    return GovernanceFinding.create(
        workflow_id="wf-1",
        decision=decision,
        requesting_agent="supervisor",
        target_agent="agent-a",
        reason=reason,
        scope_evaluated=scope_evaluated,
    )


def _make_state() -> MagicMock:
    """Stub state object for load_governance_state."""
    state = MagicMock()
    state.authority_units = []
    state.composition_contracts = []
    state.case_law = []
    state.constitutional_layers = []
    return state


# Minimal agent config and orchestration used by every test.
_AGENTS_CONFIG = {"agents": [{"name": "agent-a", "domain": "billing"}]}
_ORCH = {"orchestrationId": "orch-123"}


# ---------------------------------------------------------------------------
# 1. Bypass=true shadow mode: always call process_agent_call, always write
# ---------------------------------------------------------------------------


def test_bypass_true_calls_process_even_when_engine_denies(monkeypatch):
    """Shadow mode: DENY decision must still dispatch + still record finding."""
    monkeypatch.setenv("ARBITER_GOVERNANCE_BYPASS", "true")
    monkeypatch.setattr(supervisor_mod, "_GOVERNANCE_AVAILABLE", True)

    finding = _make_finding(ArbitrationDecision.DENY, scope_evaluated="u-1")

    with patch.object(supervisor_mod, "load_governance_state",
                      return_value=_make_state()) as mock_load, \
         patch.object(supervisor_mod, "GovernanceEngine") as MockEngine, \
         patch.object(supervisor_mod, "write_finding") as mock_write, \
         patch.object(supervisor_mod, "process_agent_call",
                      return_value={"dispatched": True}) as mock_dispatch:
        MockEngine.return_value.evaluate.return_value = finding

        result = supervisor_mod.governed_process_agent_call(
            _AGENTS_CONFIG, _ORCH, "agent-a", {"x": 1}, "use-1",
        )

    assert mock_load.called
    mock_write.assert_called_once_with(finding)
    mock_dispatch.assert_called_once_with(
        _AGENTS_CONFIG, _ORCH, "agent-a", {"x": 1}, "use-1",
    )
    assert result == {"dispatched": True}


# ---------------------------------------------------------------------------
# 2. Bypass=false + PERMIT: write THEN dispatch; return propagates
# ---------------------------------------------------------------------------


def test_bypass_false_permit_writes_then_dispatches(monkeypatch):
    monkeypatch.setenv("ARBITER_GOVERNANCE_BYPASS", "false")
    monkeypatch.setattr(supervisor_mod, "_GOVERNANCE_AVAILABLE", True)

    finding = _make_finding(ArbitrationDecision.PERMIT, scope_evaluated="u-1")

    call_order = []

    def _write(_f):
        call_order.append("write")

    def _dispatch(*a, **kw):
        call_order.append("dispatch")
        return {"ok": True}

    with patch.object(supervisor_mod, "load_governance_state",
                      return_value=_make_state()), \
         patch.object(supervisor_mod, "GovernanceEngine") as MockEngine, \
         patch.object(supervisor_mod, "write_finding", side_effect=_write) as mock_write, \
         patch.object(supervisor_mod, "process_agent_call",
                      side_effect=_dispatch) as mock_dispatch:
        MockEngine.return_value.evaluate.return_value = finding

        result = supervisor_mod.governed_process_agent_call(
            _AGENTS_CONFIG, _ORCH, "agent-a", {"x": 1}, "use-1",
        )

    mock_write.assert_called_once_with(finding)
    mock_dispatch.assert_called_once()
    assert call_order == ["write", "dispatch"]
    assert result == {"ok": True}


# ---------------------------------------------------------------------------
# 3. Bypass=false + DENY: block dispatch, return denial shape
# ---------------------------------------------------------------------------


def test_bypass_false_deny_blocks_and_returns_denial(monkeypatch):
    monkeypatch.setenv("ARBITER_GOVERNANCE_BYPASS", "false")
    monkeypatch.setattr(supervisor_mod, "_GOVERNANCE_AVAILABLE", True)

    finding = _make_finding(
        ArbitrationDecision.DENY, scope_evaluated="u-1", reason="no-coverage",
    )

    with patch.object(supervisor_mod, "load_governance_state",
                      return_value=_make_state()), \
         patch.object(supervisor_mod, "GovernanceEngine") as MockEngine, \
         patch.object(supervisor_mod, "write_finding") as mock_write, \
         patch.object(supervisor_mod, "process_agent_call") as mock_dispatch:
        MockEngine.return_value.evaluate.return_value = finding

        result = supervisor_mod.governed_process_agent_call(
            _AGENTS_CONFIG, _ORCH, "agent-a", {"x": 1}, "use-1",
        )

    mock_write.assert_called_once_with(finding)
    mock_dispatch.assert_not_called()
    assert result == {
        "denied": True,
        "finding_id": finding.finding_id,
        "reason": "no-coverage",
    }


# ---------------------------------------------------------------------------
# 4. Bypass=false + ESCALATE + topic set: SNS publish, block dispatch
# ---------------------------------------------------------------------------


def test_bypass_false_escalate_with_topic_publishes_sns(monkeypatch):
    monkeypatch.setenv("ARBITER_GOVERNANCE_BYPASS", "false")
    monkeypatch.setenv("ESCALATION_TOPIC_ARN", "arn:aws:sns:us-east-1:000:escalations")
    monkeypatch.setattr(supervisor_mod, "_GOVERNANCE_AVAILABLE", True)
    monkeypatch.setattr(
        supervisor_mod, "ESCALATION_TOPIC_ARN",
        "arn:aws:sns:us-east-1:000:escalations",
    )

    finding = _make_finding(
        ArbitrationDecision.ESCALATE, scope_evaluated="u-1", reason="contract-halt",
    )

    fake_sns = MagicMock()
    with patch.object(supervisor_mod, "load_governance_state",
                      return_value=_make_state()), \
         patch.object(supervisor_mod, "GovernanceEngine") as MockEngine, \
         patch.object(supervisor_mod, "write_finding") as mock_write, \
         patch.object(supervisor_mod, "process_agent_call") as mock_dispatch, \
         patch.object(supervisor_mod, "_get_sns", return_value=fake_sns):
        MockEngine.return_value.evaluate.return_value = finding

        result = supervisor_mod.governed_process_agent_call(
            _AGENTS_CONFIG, _ORCH, "agent-a", {"x": 1}, "use-1",
        )

    mock_write.assert_called_once_with(finding)
    mock_dispatch.assert_not_called()
    fake_sns.publish.assert_called_once()
    _, kwargs = fake_sns.publish.call_args
    assert kwargs["TopicArn"] == "arn:aws:sns:us-east-1:000:escalations"
    assert kwargs["Subject"].startswith("Governance Escalation: ")
    assert result == {
        "escalated": True,
        "finding_id": finding.finding_id,
        "reason": "contract-halt",
    }


# ---------------------------------------------------------------------------
# 4b. HALT decision is routed the same way as ESCALATE (D7)
# ---------------------------------------------------------------------------


def test_bypass_false_halt_routes_through_escalation(monkeypatch):
    monkeypatch.setenv("ARBITER_GOVERNANCE_BYPASS", "false")
    monkeypatch.setenv("ESCALATION_TOPIC_ARN", "arn:aws:sns:us-east-1:000:escalations")
    monkeypatch.setattr(supervisor_mod, "_GOVERNANCE_AVAILABLE", True)
    monkeypatch.setattr(
        supervisor_mod, "ESCALATION_TOPIC_ARN",
        "arn:aws:sns:us-east-1:000:escalations",
    )

    finding = _make_finding(
        ArbitrationDecision.HALT, scope_evaluated="u-1", reason="state-unconfirmed",
    )

    fake_sns = MagicMock()
    with patch.object(supervisor_mod, "load_governance_state",
                      return_value=_make_state()), \
         patch.object(supervisor_mod, "GovernanceEngine") as MockEngine, \
         patch.object(supervisor_mod, "write_finding"), \
         patch.object(supervisor_mod, "process_agent_call") as mock_dispatch, \
         patch.object(supervisor_mod, "_get_sns", return_value=fake_sns):
        MockEngine.return_value.evaluate.return_value = finding

        result = supervisor_mod.governed_process_agent_call(
            _AGENTS_CONFIG, _ORCH, "agent-a", {"x": 1}, "use-1",
        )

    mock_dispatch.assert_not_called()
    fake_sns.publish.assert_called_once()
    assert result["escalated"] is True
    assert result["reason"] == "state-unconfirmed"


# ---------------------------------------------------------------------------
# 5. Bypass=false + ESCALATE + topic unset: no SNS, still escalated return
# ---------------------------------------------------------------------------


def test_bypass_false_escalate_without_topic_skips_sns(monkeypatch):
    monkeypatch.setenv("ARBITER_GOVERNANCE_BYPASS", "false")
    monkeypatch.delenv("ESCALATION_TOPIC_ARN", raising=False)
    monkeypatch.setattr(supervisor_mod, "_GOVERNANCE_AVAILABLE", True)
    monkeypatch.setattr(supervisor_mod, "ESCALATION_TOPIC_ARN", None)

    finding = _make_finding(
        ArbitrationDecision.ESCALATE, scope_evaluated="u-1", reason="no-topic",
    )

    fake_sns = MagicMock()
    with patch.object(supervisor_mod, "load_governance_state",
                      return_value=_make_state()), \
         patch.object(supervisor_mod, "GovernanceEngine") as MockEngine, \
         patch.object(supervisor_mod, "write_finding"), \
         patch.object(supervisor_mod, "process_agent_call") as mock_dispatch, \
         patch.object(supervisor_mod, "_get_sns", return_value=fake_sns):
        MockEngine.return_value.evaluate.return_value = finding

        result = supervisor_mod.governed_process_agent_call(
            _AGENTS_CONFIG, _ORCH, "agent-a", {"x": 1}, "use-1",
        )

    mock_dispatch.assert_not_called()
    fake_sns.publish.assert_not_called()
    assert result["escalated"] is True
    assert result["reason"] == "no-topic"


# ---------------------------------------------------------------------------
# 6. write_finding raises: exception propagates, dispatch NEVER happens
# ---------------------------------------------------------------------------


def test_write_finding_raises_halts_dispatch(monkeypatch):
    """Fail-closed per D9: ledger failure must propagate, not be swallowed."""
    monkeypatch.setenv("ARBITER_GOVERNANCE_BYPASS", "true")  # even in shadow mode
    monkeypatch.setattr(supervisor_mod, "_GOVERNANCE_AVAILABLE", True)

    finding = _make_finding(ArbitrationDecision.PERMIT, scope_evaluated="u-1")

    with patch.object(supervisor_mod, "load_governance_state",
                      return_value=_make_state()), \
         patch.object(supervisor_mod, "GovernanceEngine") as MockEngine, \
         patch.object(
             supervisor_mod, "write_finding",
             side_effect=supervisor_mod.LedgerWriteError("ddb down"),
         ), \
         patch.object(supervisor_mod, "process_agent_call") as mock_dispatch:
        MockEngine.return_value.evaluate.return_value = finding

        with pytest.raises(supervisor_mod.LedgerWriteError):
            supervisor_mod.governed_process_agent_call(
                _AGENTS_CONFIG, _ORCH, "agent-a", {"x": 1}, "use-1",
            )

    mock_dispatch.assert_not_called()


# ---------------------------------------------------------------------------
# 7. scope_evaluated default: falsy value gets backfilled before write
# ---------------------------------------------------------------------------


def test_scope_evaluated_defaults_to_supervisor_dispatch(monkeypatch):
    monkeypatch.setenv("ARBITER_GOVERNANCE_BYPASS", "true")
    monkeypatch.setattr(supervisor_mod, "_GOVERNANCE_AVAILABLE", True)

    # Engine returns finding with empty scope_evaluated — wrapper must
    # backfill to 'supervisor-dispatch' BEFORE write_finding is called.
    finding = _make_finding(ArbitrationDecision.PERMIT, scope_evaluated="")

    captured = {}

    def _capture_write(f):
        captured["scope"] = f.scope_evaluated

    with patch.object(supervisor_mod, "load_governance_state",
                      return_value=_make_state()), \
         patch.object(supervisor_mod, "GovernanceEngine") as MockEngine, \
         patch.object(supervisor_mod, "write_finding", side_effect=_capture_write), \
         patch.object(supervisor_mod, "process_agent_call", return_value=None):
        MockEngine.return_value.evaluate.return_value = finding

        supervisor_mod.governed_process_agent_call(
            _AGENTS_CONFIG, _ORCH, "agent-a", {"x": 1}, "use-1",
        )

    assert captured["scope"] == "supervisor-dispatch"
    # And the finding object itself is mutated in-place.
    assert finding.scope_evaluated == "supervisor-dispatch"


# ---------------------------------------------------------------------------
# 8. Degraded mode: _GOVERNANCE_AVAILABLE False → pure pass-through
# ---------------------------------------------------------------------------


def test_governance_unavailable_is_pure_passthrough(monkeypatch):
    monkeypatch.setattr(supervisor_mod, "_GOVERNANCE_AVAILABLE", False)

    with patch.object(supervisor_mod, "load_governance_state") as mock_load, \
         patch.object(supervisor_mod, "write_finding") as mock_write, \
         patch.object(supervisor_mod, "process_agent_call",
                      return_value={"dispatched": True}) as mock_dispatch:
        result = supervisor_mod.governed_process_agent_call(
            _AGENTS_CONFIG, _ORCH, "agent-a", {"x": 1}, "use-1",
        )

    mock_load.assert_not_called()
    mock_write.assert_not_called()
    mock_dispatch.assert_called_once_with(
        _AGENTS_CONFIG, _ORCH, "agent-a", {"x": 1}, "use-1",
    )
    assert result == {"dispatched": True}


# ---------------------------------------------------------------------------
# Auxiliary: app_id reaches load_governance_state (D2 scope filter)
# ---------------------------------------------------------------------------


def test_app_id_is_forwarded_to_load_governance_state(monkeypatch):
    monkeypatch.setenv("ARBITER_GOVERNANCE_BYPASS", "true")
    monkeypatch.setattr(supervisor_mod, "_GOVERNANCE_AVAILABLE", True)

    finding = _make_finding(ArbitrationDecision.PERMIT, scope_evaluated="u-1")

    with patch.object(supervisor_mod, "load_governance_state",
                      return_value=_make_state()) as mock_load, \
         patch.object(supervisor_mod, "GovernanceEngine") as MockEngine, \
         patch.object(supervisor_mod, "write_finding"), \
         patch.object(supervisor_mod, "process_agent_call", return_value=None):
        MockEngine.return_value.evaluate.return_value = finding

        supervisor_mod.governed_process_agent_call(
            _AGENTS_CONFIG, _ORCH, "agent-a", {"x": 1}, "use-1",
            registry_id="app-42",
        )

    mock_load.assert_called_once_with(registry_id="app-42")
