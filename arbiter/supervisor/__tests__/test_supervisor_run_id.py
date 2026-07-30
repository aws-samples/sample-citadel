"""Tests for run_id threading through create_orchestration and
governed_process_agent_call's best-effort finding stamp (Pass 1, decision
f1cbd5ef) — mirrors the existing trace_id stamping tests in
test_supervisor_governed_dispatch.py::TestTraceIdStamping.
"""
import os
import sys
from unittest.mock import patch

import pytest

sys.path.insert(0, os.path.join(os.path.dirname(__file__), "..", ".."))

import index as supervisor_mod  # noqa: E402
from governance.models import ArbitrationDecision, GovernanceFinding  # noqa: E402

_AGENTS_CONFIG = {"agents": [{"name": "agent-a", "domain": "default"}]}


def _make_finding(decision, **overrides):
    defaults = dict(
        workflow_id="orch-1",
        decision=decision,
        requesting_agent="supervisor",
        target_agent="agent-a",
        reason="ok",
    )
    defaults.update(overrides)
    return GovernanceFinding.create(**defaults)


def _make_state(mode):
    class _State:
        enforcement_mode = mode
        authority_units = []
        composition_contracts = []
        case_law = []
        constitutional_layers = []
    return _State()


class TestCreateOrchestrationRunId:
    def test_run_id_persisted_on_orchestration_row_when_provided(self):
        orch = supervisor_mod.create_orchestration([{"role": "user"}], run_id="run-abc")
        assert orch["runId"] == "run-abc"

    def test_run_id_key_absent_when_not_provided(self):
        """Additive/nullable: omitting run_id must not add a runId key at
        all (byte-identical to the pre-runId orchestration row shape)."""
        orch = supervisor_mod.create_orchestration([{"role": "user"}])
        assert "runId" not in orch

    def test_run_id_key_absent_when_explicitly_none(self):
        orch = supervisor_mod.create_orchestration([{"role": "user"}], run_id=None)
        assert "runId" not in orch


class TestGovernedProcessAgentCallRunIdStamp:
    """Mirrors TestTraceIdStamping — finding.run_id is read from
    orchestration['runId'] and stamped best-effort before write_finding,
    same try/except discipline as the existing trace_id stamp."""

    def test_stamps_run_id_from_orchestration_dict(self, monkeypatch):
        monkeypatch.setattr(supervisor_mod, "_GOVERNANCE_AVAILABLE", True)
        finding = _make_finding(ArbitrationDecision.PERMIT, scope_evaluated="u-1")
        captured = {}

        def _capture_write(f):
            captured["run_id"] = f.run_id

        orch = {"orchestrationId": "orch-2", "conversation": [], "runId": "run-xyz"}

        with patch.object(supervisor_mod, "load_governance_state",
                          return_value=_make_state("shadow")), \
             patch.object(supervisor_mod, "GovernanceEngine") as MockEngine, \
             patch.object(supervisor_mod, "write_finding", side_effect=_capture_write), \
             patch.object(supervisor_mod, "process_agent_call", return_value=None):
            MockEngine.return_value.evaluate.return_value = finding

            supervisor_mod.governed_process_agent_call(
                _AGENTS_CONFIG, orch, "agent-a", {"x": 1}, "use-1",
            )

        assert captured["run_id"] == "run-xyz"
        assert finding.run_id == "run-xyz"

    @pytest.mark.parametrize("mode", ["permissive", "shadow", "strict"])
    def test_absent_run_id_on_orchestration_leaves_finding_run_id_none(self, monkeypatch, mode):
        """[FAIL-CLOSED NON-REGRESSION] Mirrors
        test_trace_context_returns_none_never_denies_dispatch: an
        orchestration row with no runId key must not deny dispatch or
        alter the decision, in any enforcement mode."""
        monkeypatch.setattr(supervisor_mod, "_GOVERNANCE_AVAILABLE", True)
        finding = _make_finding(ArbitrationDecision.PERMIT, scope_evaluated="u-1")
        orch = {"orchestrationId": "orch-3", "conversation": []}  # no runId key

        with patch.object(supervisor_mod, "load_governance_state",
                          return_value=_make_state(mode)), \
             patch.object(supervisor_mod, "GovernanceEngine") as MockEngine, \
             patch.object(supervisor_mod, "write_finding") as mock_write, \
             patch.object(supervisor_mod, "process_agent_call", return_value={"ok": True}) as mock_dispatch:
            MockEngine.return_value.evaluate.return_value = finding

            result = supervisor_mod.governed_process_agent_call(
                _AGENTS_CONFIG, orch, "agent-a", {"x": 1}, "use-1",
            )

        mock_write.assert_called_once_with(finding)
        mock_dispatch.assert_called_once()
        assert finding.run_id is None
        assert result == {"ok": True}

    @pytest.mark.parametrize("mode", ["permissive", "shadow", "strict"])
    def test_run_id_stamp_never_gates_write_finding_on_exception(self, monkeypatch, mode):
        """[FAIL-CLOSED NON-REGRESSION] Best-effort discipline (mirrors
        trace_id's test_trace_context_raises_never_denies_dispatch): if
        reading orchestration['runId'] somehow raises, write_finding must
        still be called exactly once, dispatch must still proceed, and the
        decision must not change, in ANY enforcement mode."""
        monkeypatch.setattr(supervisor_mod, "_GOVERNANCE_AVAILABLE", True)
        finding = _make_finding(ArbitrationDecision.PERMIT, scope_evaluated="u-1")

        class _BoomOrch(dict):
            def get(self, *a, **kw):
                if a and a[0] == "runId":
                    raise RuntimeError("boom")
                return super().get(*a, **kw)

        orch = _BoomOrch({"orchestrationId": "orch-4", "conversation": []})
        write_calls = []

        with patch.object(supervisor_mod, "load_governance_state",
                          return_value=_make_state(mode)), \
             patch.object(supervisor_mod, "GovernanceEngine") as MockEngine, \
             patch.object(supervisor_mod, "write_finding",
                          side_effect=lambda f: write_calls.append(f)), \
             patch.object(supervisor_mod, "process_agent_call", return_value={"ok": True}) as mock_dispatch:
            MockEngine.return_value.evaluate.return_value = finding

            result = supervisor_mod.governed_process_agent_call(
                _AGENTS_CONFIG, orch, "agent-a", {"x": 1}, "use-1",
            )

        assert len(write_calls) == 1
        assert finding.run_id is None
        mock_dispatch.assert_called_once()
        assert result == {"ok": True}

    @pytest.mark.parametrize("mode", ["permissive", "shadow", "strict"])
    def test_run_id_lookup_raises_never_alters_decision(self, monkeypatch, mode):
        """[FAIL-CLOSED NON-REGRESSION] Mirrors
        test_trace_context_raises_never_denies_dispatch but asserts on the
        DECISION outcome itself (PERMIT dispatches) rather than only the
        write_finding call, across all three enforcement modes."""
        monkeypatch.setattr(supervisor_mod, "_GOVERNANCE_AVAILABLE", True)
        finding = _make_finding(ArbitrationDecision.PERMIT, scope_evaluated="u-1")

        class _BoomOrch(dict):
            def get(self, *a, **kw):
                if a and a[0] == "runId":
                    raise RuntimeError("boom")
                return super().get(*a, **kw)

        orch = _BoomOrch({"orchestrationId": "orch-5", "conversation": []})

        with patch.object(supervisor_mod, "load_governance_state",
                          return_value=_make_state(mode)), \
             patch.object(supervisor_mod, "GovernanceEngine") as MockEngine, \
             patch.object(supervisor_mod, "write_finding") as mock_write, \
             patch.object(supervisor_mod, "process_agent_call",
                          return_value={"dispatched": True}) as mock_dispatch:
            MockEngine.return_value.evaluate.return_value = finding

            result = supervisor_mod.governed_process_agent_call(
                _AGENTS_CONFIG, orch, "agent-a", {"x": 1}, "use-1",
            )

        mock_write.assert_called_once_with(finding)
        mock_dispatch.assert_called_once()
        assert finding.run_id is None
        assert result == {"dispatched": True}

    def test_run_id_lookup_raises_strict_deny_still_denies_same_reason(self, monkeypatch):
        """Mirrors test_trace_context_raises_strict_deny_still_denies_same_reason:
        confirms the run_id-lookup exception path does not silently flip a
        DENY into a PERMIT or otherwise change the returned denial payload
        in strict mode, the mode where the decision actually gates
        dispatch."""
        monkeypatch.setattr(supervisor_mod, "_GOVERNANCE_AVAILABLE", True)
        finding = _make_finding(
            ArbitrationDecision.DENY, scope_evaluated="u-1", reason="no-coverage",
        )

        class _BoomOrch(dict):
            def get(self, *a, **kw):
                if a and a[0] == "runId":
                    raise RuntimeError("boom")
                return super().get(*a, **kw)

        orch = _BoomOrch({"orchestrationId": "orch-6", "conversation": []})

        with patch.object(supervisor_mod, "load_governance_state",
                          return_value=_make_state("strict")), \
             patch.object(supervisor_mod, "GovernanceEngine") as MockEngine, \
             patch.object(supervisor_mod, "write_finding") as mock_write, \
             patch.object(supervisor_mod, "process_agent_call") as mock_dispatch:
            MockEngine.return_value.evaluate.return_value = finding

            result = supervisor_mod.governed_process_agent_call(
                _AGENTS_CONFIG, orch, "agent-a", {"x": 1}, "use-1",
            )

        mock_write.assert_called_once_with(finding)
        mock_dispatch.assert_not_called()
        assert result == {
            "denied": True,
            "finding_id": finding.finding_id,
            "reason": "no-coverage",
        }
