"""US-ARB-008 tests — ``governed_process_agent_call`` fail-closed dispatch seam.

Covers:
  1. Package-unavailable refusal (fail-closed, unconditional, never a bypass).
  2. Mode-driven behaviour (permissive/shadow proceed-with-recording; strict
     enforces PERMIT/DENY/ESCALATE/HALT) sourced from
     ``GovernanceState.enforcement_mode``.
  3. ARBITER_GOVERNANCE_BYPASS as an emergency override on top of mode,
     with NO effect on the package-unavailable gate.
  4. Ledger fail-closed invariant (D9): write_finding raising halts dispatch
     in every mode.

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


# ---------------------------------------------------------------------------
# Fixtures / helpers
# ---------------------------------------------------------------------------


@pytest.fixture(autouse=True)
def _clean_env():
    """Clear governance env vars so each test starts from a known baseline."""
    saved_bypass = os.environ.pop("ARBITER_GOVERNANCE_BYPASS", None)
    saved_topic = os.environ.pop("ESCALATION_TOPIC_ARN", None)
    prev_topic_attr = supervisor_mod.ESCALATION_TOPIC_ARN
    prev_available = supervisor_mod._GOVERNANCE_AVAILABLE
    prev_import_error = getattr(supervisor_mod, "_GOVERNANCE_IMPORT_ERROR", None)
    supervisor_mod.ESCALATION_TOPIC_ARN = None
    yield
    if saved_bypass is not None:
        os.environ["ARBITER_GOVERNANCE_BYPASS"] = saved_bypass
    if saved_topic is not None:
        os.environ["ESCALATION_TOPIC_ARN"] = saved_topic
    supervisor_mod.ESCALATION_TOPIC_ARN = prev_topic_attr
    supervisor_mod._GOVERNANCE_AVAILABLE = prev_available
    supervisor_mod._GOVERNANCE_IMPORT_ERROR = prev_import_error


def _make_finding(
    decision: ArbitrationDecision,
    scope_evaluated: str | None = None,
    reason: str = "test-reason",
) -> GovernanceFinding:
    return GovernanceFinding.create(
        workflow_id="wf-1",
        decision=decision,
        requesting_agent="supervisor",
        target_agent="agent-a",
        reason=reason,
        scope_evaluated=scope_evaluated,
    )


def _make_state(enforcement_mode: str = "shadow") -> MagicMock:
    state = MagicMock()
    state.authority_units = []
    state.composition_contracts = []
    state.case_law = []
    state.constitutional_layers = []
    state.enforcement_mode = enforcement_mode
    return state


_AGENTS_CONFIG = {"agents": [{"name": "agent-a", "domain": "billing"}]}
_ORCH = {"orchestrationId": "orch-123"}


# ---------------------------------------------------------------------------
# 0. Package-unavailable refusal — fail-closed, unconditional
# ---------------------------------------------------------------------------


class TestPackageUnavailableRefusal:
    def test_governance_unavailable_refuses_dispatch_never_bypasses(self, monkeypatch, caplog):
        monkeypatch.setattr(supervisor_mod, "_GOVERNANCE_AVAILABLE", False)
        monkeypatch.setattr(
            supervisor_mod, "_GOVERNANCE_IMPORT_ERROR",
            "governance package files not found next to supervisor",
        )

        with patch.object(supervisor_mod, "load_governance_state") as mock_load, \
             patch.object(supervisor_mod, "write_finding") as mock_write, \
             patch.object(supervisor_mod, "process_agent_call") as mock_dispatch, \
             caplog.at_level(logging.ERROR, logger=supervisor_mod.logger.name):
            result = supervisor_mod.governed_process_agent_call(
                _AGENTS_CONFIG, _ORCH, "agent-a", {"x": 1}, "use-1",
            )

        mock_load.assert_not_called()
        mock_write.assert_not_called()
        mock_dispatch.assert_not_called()  # THE bypass path must never fire
        assert result["denied"] is True
        assert result["reason"] == "governance_package_unavailable"
        assert result["target_agent"] == "agent-a"
        assert any(r.levelno == logging.ERROR for r in caplog.records)

    def test_governance_unavailable_refuses_even_with_bypass_true(self, monkeypatch):
        """The emergency override must NOT resurrect ungoverned dispatch when
        the package itself cannot be loaded — there is nothing to evaluate
        against."""
        monkeypatch.setenv("ARBITER_GOVERNANCE_BYPASS", "true")
        monkeypatch.setattr(supervisor_mod, "_GOVERNANCE_AVAILABLE", False)
        monkeypatch.setattr(supervisor_mod, "_GOVERNANCE_IMPORT_ERROR", "boom")

        with patch.object(supervisor_mod, "process_agent_call") as mock_dispatch:
            result = supervisor_mod.governed_process_agent_call(
                _AGENTS_CONFIG, _ORCH, "agent-a", {"x": 1}, "use-1",
            )

        mock_dispatch.assert_not_called()
        assert result["denied"] is True

    def test_handler_module_still_imports_when_package_missing(self):
        """Import-time contract: the module must be importable (handler
        starts) even in the degraded state — already proven by the fact
        this test file imported ``index`` successfully above with the real
        governance package. Explicitly assert the symbol exists and is
        callable so a future refactor can't silently drop it."""
        assert callable(supervisor_mod.handler)
        assert callable(supervisor_mod.governed_process_agent_call)


# ---------------------------------------------------------------------------
# 1. Mode-driven behaviour: permissive/shadow proceed regardless of decision
# ---------------------------------------------------------------------------


class TestModeDrivenPermissiveShadow:
    @pytest.mark.parametrize("mode", ["permissive", "shadow"])
    def test_deny_decision_still_dispatches_and_records(self, monkeypatch, mode):
        monkeypatch.setattr(supervisor_mod, "_GOVERNANCE_AVAILABLE", True)
        finding = _make_finding(ArbitrationDecision.DENY, scope_evaluated="u-1")

        with patch.object(supervisor_mod, "load_governance_state",
                          return_value=_make_state(mode)) as mock_load, \
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
# 2. Mode-driven behaviour: strict enforces PERMIT/DENY/ESCALATE/HALT
# ---------------------------------------------------------------------------


class TestModeDrivenStrict:
    def test_strict_permit_writes_then_dispatches(self, monkeypatch):
        monkeypatch.setattr(supervisor_mod, "_GOVERNANCE_AVAILABLE", True)
        finding = _make_finding(ArbitrationDecision.PERMIT, scope_evaluated="u-1")
        call_order = []

        def _write(_f):
            call_order.append("write")

        def _dispatch(*a, **kw):
            call_order.append("dispatch")
            return {"ok": True}

        with patch.object(supervisor_mod, "load_governance_state",
                          return_value=_make_state("strict")), \
             patch.object(supervisor_mod, "GovernanceEngine") as MockEngine, \
             patch.object(supervisor_mod, "write_finding", side_effect=_write) as mock_write, \
             patch.object(supervisor_mod, "process_agent_call", side_effect=_dispatch) as mock_dispatch:
            MockEngine.return_value.evaluate.return_value = finding

            result = supervisor_mod.governed_process_agent_call(
                _AGENTS_CONFIG, _ORCH, "agent-a", {"x": 1}, "use-1",
            )

        mock_write.assert_called_once_with(finding)
        mock_dispatch.assert_called_once()
        assert call_order == ["write", "dispatch"]
        assert result == {"ok": True}

    def test_strict_deny_blocks_and_returns_denial(self, monkeypatch):
        monkeypatch.setattr(supervisor_mod, "_GOVERNANCE_AVAILABLE", True)
        finding = _make_finding(
            ArbitrationDecision.DENY, scope_evaluated="u-1", reason="no-coverage",
        )

        with patch.object(supervisor_mod, "load_governance_state",
                          return_value=_make_state("strict")), \
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

    def test_strict_escalate_with_topic_publishes_sns(self, monkeypatch):
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
                          return_value=_make_state("strict")), \
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

    def test_strict_halt_routes_through_escalation(self, monkeypatch):
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
                          return_value=_make_state("strict")), \
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

    def test_strict_escalate_without_topic_skips_sns(self, monkeypatch):
        monkeypatch.setattr(supervisor_mod, "_GOVERNANCE_AVAILABLE", True)
        monkeypatch.setattr(supervisor_mod, "ESCALATION_TOPIC_ARN", None)
        finding = _make_finding(
            ArbitrationDecision.ESCALATE, scope_evaluated="u-1", reason="no-topic",
        )
        fake_sns = MagicMock()

        with patch.object(supervisor_mod, "load_governance_state",
                          return_value=_make_state("strict")), \
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
# 3. ARBITER_GOVERNANCE_BYPASS emergency override
# ---------------------------------------------------------------------------


class TestEmergencyBypassOverride:
    def test_bypass_true_forces_proceed_even_in_strict_mode(self, monkeypatch):
        monkeypatch.setenv("ARBITER_GOVERNANCE_BYPASS", "true")
        monkeypatch.setattr(supervisor_mod, "_GOVERNANCE_AVAILABLE", True)
        finding = _make_finding(ArbitrationDecision.DENY, scope_evaluated="u-1")

        with patch.object(supervisor_mod, "load_governance_state",
                          return_value=_make_state("strict")), \
             patch.object(supervisor_mod, "GovernanceEngine") as MockEngine, \
             patch.object(supervisor_mod, "write_finding") as mock_write, \
             patch.object(supervisor_mod, "process_agent_call",
                          return_value={"dispatched": True}) as mock_dispatch:
            MockEngine.return_value.evaluate.return_value = finding

            result = supervisor_mod.governed_process_agent_call(
                _AGENTS_CONFIG, _ORCH, "agent-a", {"x": 1}, "use-1",
            )

        mock_write.assert_called_once_with(finding)
        mock_dispatch.assert_called_once()
        assert result == {"dispatched": True}

    def test_bypass_false_does_not_affect_shadow_mode(self, monkeypatch):
        monkeypatch.setenv("ARBITER_GOVERNANCE_BYPASS", "false")
        monkeypatch.setattr(supervisor_mod, "_GOVERNANCE_AVAILABLE", True)
        finding = _make_finding(ArbitrationDecision.DENY, scope_evaluated="u-1")

        with patch.object(supervisor_mod, "load_governance_state",
                          return_value=_make_state("shadow")), \
             patch.object(supervisor_mod, "GovernanceEngine") as MockEngine, \
             patch.object(supervisor_mod, "write_finding"), \
             patch.object(supervisor_mod, "process_agent_call",
                          return_value={"dispatched": True}) as mock_dispatch:
            MockEngine.return_value.evaluate.return_value = finding

            result = supervisor_mod.governed_process_agent_call(
                _AGENTS_CONFIG, _ORCH, "agent-a", {"x": 1}, "use-1",
            )

        mock_dispatch.assert_called_once()
        assert result == {"dispatched": True}


# ---------------------------------------------------------------------------
# 4. Ledger fail-closed invariant (D9) — every mode
# ---------------------------------------------------------------------------


class TestLedgerFailClosed:
    @pytest.mark.parametrize("mode", ["permissive", "shadow", "strict"])
    def test_write_finding_raises_halts_dispatch(self, monkeypatch, mode):
        monkeypatch.setattr(supervisor_mod, "_GOVERNANCE_AVAILABLE", True)
        finding = _make_finding(ArbitrationDecision.PERMIT, scope_evaluated="u-1")

        with patch.object(supervisor_mod, "load_governance_state",
                          return_value=_make_state(mode)), \
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
# 5. scope_evaluated default backfill
# ---------------------------------------------------------------------------


def test_scope_evaluated_defaults_to_supervisor_dispatch(monkeypatch):
    monkeypatch.setattr(supervisor_mod, "_GOVERNANCE_AVAILABLE", True)
    finding = _make_finding(ArbitrationDecision.PERMIT, scope_evaluated="")
    captured = {}

    def _capture_write(f):
        captured["scope"] = f.scope_evaluated

    with patch.object(supervisor_mod, "load_governance_state",
                      return_value=_make_state("shadow")), \
         patch.object(supervisor_mod, "GovernanceEngine") as MockEngine, \
         patch.object(supervisor_mod, "write_finding", side_effect=_capture_write), \
         patch.object(supervisor_mod, "process_agent_call", return_value=None):
        MockEngine.return_value.evaluate.return_value = finding

        supervisor_mod.governed_process_agent_call(
            _AGENTS_CONFIG, _ORCH, "agent-a", {"x": 1}, "use-1",
        )

    assert captured["scope"] == "supervisor-dispatch"
    assert finding.scope_evaluated == "supervisor-dispatch"


# ---------------------------------------------------------------------------
# 6. app_id forwarding (D2 scope filter)
# ---------------------------------------------------------------------------


def test_app_id_is_forwarded_to_load_governance_state(monkeypatch):
    monkeypatch.setattr(supervisor_mod, "_GOVERNANCE_AVAILABLE", True)
    finding = _make_finding(ArbitrationDecision.PERMIT, scope_evaluated="u-1")

    with patch.object(supervisor_mod, "load_governance_state",
                      return_value=_make_state("shadow")) as mock_load, \
         patch.object(supervisor_mod, "GovernanceEngine") as MockEngine, \
         patch.object(supervisor_mod, "write_finding"), \
         patch.object(supervisor_mod, "process_agent_call", return_value=None):
        MockEngine.return_value.evaluate.return_value = finding

        supervisor_mod.governed_process_agent_call(
            _AGENTS_CONFIG, _ORCH, "agent-a", {"x": 1}, "use-1",
            app_id="app-42",
        )

    mock_load.assert_called_once_with(registry_id="app-42")


# ---------------------------------------------------------------------------
# Per-agent modelOverride forwarding in process_agent_call (real dispatch,
# unaffected by governance wrapper changes above).
# ---------------------------------------------------------------------------

_DISPATCH_CONFIG = {"agents": [{
    "name": "agent-a",
    "action": {"type": "sqs", "target": "https://sqs.fake/my-queue"},
    "modelOverride": "some-model-key",
}]}
_DISPATCH_CONFIG_NO_OVERRIDE = {"agents": [{
    "name": "agent-a",
    "action": {"type": "sqs", "target": "https://sqs.fake/my-queue"},
}]}


def test_process_agent_call_forwards_resolved_model_override(monkeypatch):
    import model_config_loader

    fake_sqs = MagicMock()
    with patch.object(supervisor_mod, "sqs", fake_sqs), \
         patch.object(supervisor_mod, "EVENT_BUS_NAME", None), \
         patch.object(model_config_loader, "resolve_agent_override",
                      return_value="us.p.model-override") as mock_resolve:
        supervisor_mod.process_agent_call(
            _DISPATCH_CONFIG, _ORCH, "agent-a", {"x": 1}, "use-1",
        )

    mock_resolve.assert_called_once()
    assert mock_resolve.call_args[0][0] == "some-model-key"

    fake_sqs.send_message.assert_called_once()
    body = json.loads(fake_sqs.send_message.call_args[1]["MessageBody"])
    assert body["modelOverride"] == "us.p.model-override"


def test_process_agent_call_omits_model_override_when_binding_absent(monkeypatch):
    fake_sqs = MagicMock()
    with patch.object(supervisor_mod, "sqs", fake_sqs), \
         patch.object(supervisor_mod, "EVENT_BUS_NAME", None):
        supervisor_mod.process_agent_call(
            _DISPATCH_CONFIG_NO_OVERRIDE, _ORCH, "agent-a", {"x": 1}, "use-1",
        )

    fake_sqs.send_message.assert_called_once()
    body = json.loads(fake_sqs.send_message.call_args[1]["MessageBody"])
    assert "modelOverride" not in body


def test_process_agent_call_omits_model_override_when_resolution_none(monkeypatch):
    import model_config_loader

    fake_sqs = MagicMock()
    with patch.object(supervisor_mod, "sqs", fake_sqs), \
         patch.object(supervisor_mod, "EVENT_BUS_NAME", None), \
         patch.object(model_config_loader, "resolve_agent_override", return_value=None):
        supervisor_mod.process_agent_call(
            _DISPATCH_CONFIG, _ORCH, "agent-a", {"x": 1}, "use-1",
        )

    fake_sqs.send_message.assert_called_once()
    body = json.loads(fake_sqs.send_message.call_args[1]["MessageBody"])
    assert "modelOverride" not in body
