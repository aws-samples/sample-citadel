"""Release-aware dispatch tests for ``governed_process_agent_call``.

Covers the release resolution seam layered on top of the existing US-ARB-008
mode/decision gate (test_supervisor_governed_dispatch.py):

  * permissive — telemetry only, always proceeds (existing dispatch
    behaviour, unaffected by whether a release resolves).
  * shadow — resolves the release and records a would-block telemetry
    event when none is resolvable, but always proceeds.
  * strict — refuses dispatch when no release is resolvable UNLESS the
    (org, agent, environment) triple is grandfathered; a LOOKUP_FAILED
    resolution always refuses regardless of grandfathering (assert-or-
    refuse doctrine, distinct from the clean NO_POINTER case).

Backward-compatibility invariant asserted throughout: an existing
deployment with RELEASE_DISPATCH_ENVIRONMENT unset (or with the release
tables unset, covered in test_release_resolution.py) must dispatch
byte-identically to pre-feature behaviour — this is asserted here via the
"release gate is a no-op unless RELEASE_DISPATCH_ENVIRONMENT is set"
tests, which is the seam's own backward-compat switch, separate from (and
in addition to) the table-unset seam release_resolution.py already
guarantees.
"""
from __future__ import annotations

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
ReleaseResolutionStatus = supervisor_mod.ReleaseResolutionStatus
ReleaseResolution = supervisor_mod.ReleaseResolution


@pytest.fixture(autouse=True)
def _clean_env():
    saved_bypass = os.environ.pop("ARBITER_GOVERNANCE_BYPASS", None)
    saved_env_lit = os.environ.pop("RELEASE_DISPATCH_ENVIRONMENT", None)
    saved_org = os.environ.pop("RELEASE_DEFAULT_ORG_ID", None)
    prev_available = supervisor_mod._GOVERNANCE_AVAILABLE
    yield
    if saved_bypass is not None:
        os.environ["ARBITER_GOVERNANCE_BYPASS"] = saved_bypass
    if saved_env_lit is not None:
        os.environ["RELEASE_DISPATCH_ENVIRONMENT"] = saved_env_lit
    else:
        os.environ.pop("RELEASE_DISPATCH_ENVIRONMENT", None)
    if saved_org is not None:
        os.environ["RELEASE_DEFAULT_ORG_ID"] = saved_org
    else:
        os.environ.pop("RELEASE_DEFAULT_ORG_ID", None)
    supervisor_mod._GOVERNANCE_AVAILABLE = prev_available


def _make_finding(decision, scope_evaluated="u-1", reason="test-reason"):
    return GovernanceFinding.create(
        workflow_id="wf-1",
        decision=decision,
        requesting_agent="supervisor",
        target_agent="agent-a",
        reason=reason,
        scope_evaluated=scope_evaluated,
    )


def _make_state(enforcement_mode="shadow", effective_at=None):
    state = MagicMock()
    state.authority_units = []
    state.composition_contracts = []
    state.case_law = []
    state.constitutional_layers = []
    state.enforcement_mode = enforcement_mode
    state.effective_at = effective_at
    return state


_AGENTS_CONFIG = {"agents": [{"name": "agent-a", "domain": "billing"}]}
_ORCH = {"orchestrationId": "orch-123"}


def _common_patches(mode, finding, resolve_return):
    """Returns a context-manager-friendly tuple of patches shared by every
    test below: load_governance_state, GovernanceEngine.evaluate,
    write_finding, resolve_release, process_agent_call."""
    return (
        patch.object(supervisor_mod, "load_governance_state", return_value=_make_state(mode)),
        patch.object(supervisor_mod, "GovernanceEngine"),
        patch.object(supervisor_mod, "write_finding"),
        patch.object(supervisor_mod, "resolve_release", return_value=resolve_return),
        patch.object(supervisor_mod, "process_agent_call", return_value={"dispatched": True}),
    )


# ---------------------------------------------------------------------------
# Backward-compat: feature switch (RELEASE_DISPATCH_ENVIRONMENT) unset ->
# resolve_release is never even called, byte-identical to pre-feature
# dispatch.
# ---------------------------------------------------------------------------


def test_release_gate_is_noop_when_dispatch_environment_unset(monkeypatch):
    monkeypatch.setattr(supervisor_mod, "_GOVERNANCE_AVAILABLE", True)
    monkeypatch.delenv("RELEASE_DISPATCH_ENVIRONMENT", raising=False)
    finding = _make_finding(ArbitrationDecision.PERMIT)

    with patch.object(supervisor_mod, "load_governance_state",
                      return_value=_make_state("strict")), \
         patch.object(supervisor_mod, "GovernanceEngine") as MockEngine, \
         patch.object(supervisor_mod, "write_finding"), \
         patch.object(supervisor_mod, "resolve_release") as mock_resolve, \
         patch.object(supervisor_mod, "process_agent_call",
                      return_value={"dispatched": True}) as mock_dispatch:
        MockEngine.return_value.evaluate.return_value = finding

        result = supervisor_mod.governed_process_agent_call(
            _AGENTS_CONFIG, _ORCH, "agent-a", {"x": 1}, "use-1",
        )

    mock_resolve.assert_not_called()
    mock_dispatch.assert_called_once()
    assert result == {"dispatched": True}


# ---------------------------------------------------------------------------
# permissive — telemetry only, always proceeds regardless of resolution.
# ---------------------------------------------------------------------------


@pytest.mark.parametrize(
    "resolve_return",
    [
        ReleaseResolution(status=ReleaseResolutionStatus.RESOLVED, release={"releaseId": "r1"}),
        ReleaseResolution(status=ReleaseResolutionStatus.NO_POINTER),
        ReleaseResolution(status=ReleaseResolutionStatus.LOOKUP_FAILED, error="boom"),
    ],
)
def test_permissive_always_proceeds_and_emits_telemetry(monkeypatch, resolve_return):
    monkeypatch.setattr(supervisor_mod, "_GOVERNANCE_AVAILABLE", True)
    monkeypatch.setenv("RELEASE_DISPATCH_ENVIRONMENT", "PROD")
    finding = _make_finding(ArbitrationDecision.PERMIT)

    patches = _common_patches("permissive", finding, resolve_return)
    with patches[0], patches[1] as MockEngine, patches[2], patches[3] as mock_resolve, \
         patches[4] as mock_dispatch, \
         patch.object(supervisor_mod, "_emit_release_dispatch_metric") as mock_metric:
        MockEngine.return_value.evaluate.return_value = finding

        result = supervisor_mod.governed_process_agent_call(
            _AGENTS_CONFIG, _ORCH, "agent-a", {"x": 1}, "use-1",
        )

    mock_resolve.assert_called_once()
    mock_dispatch.assert_called_once()
    mock_metric.assert_called_once()
    assert mock_metric.call_args.kwargs["mode"] == "permissive"
    assert result == {"dispatched": True}


# ---------------------------------------------------------------------------
# shadow — would-block recorded, dispatch still proceeds.
# ---------------------------------------------------------------------------


def test_shadow_no_release_records_would_block_but_proceeds(monkeypatch):
    monkeypatch.setattr(supervisor_mod, "_GOVERNANCE_AVAILABLE", True)
    monkeypatch.setenv("RELEASE_DISPATCH_ENVIRONMENT", "PROD")
    finding = _make_finding(ArbitrationDecision.PERMIT)
    resolve_return = ReleaseResolution(status=ReleaseResolutionStatus.NO_POINTER)

    patches = _common_patches("shadow", finding, resolve_return)
    with patches[0], patches[1] as MockEngine, patches[2], patches[3], \
         patches[4] as mock_dispatch, \
         patch.object(supervisor_mod, "_emit_release_dispatch_metric") as mock_metric:
        MockEngine.return_value.evaluate.return_value = finding

        result = supervisor_mod.governed_process_agent_call(
            _AGENTS_CONFIG, _ORCH, "agent-a", {"x": 1}, "use-1",
        )

    mock_dispatch.assert_called_once()
    assert mock_metric.call_args.kwargs["mode"] == "shadow"
    assert mock_metric.call_args.kwargs["would_block"] is True
    assert result == {"dispatched": True}


def test_shadow_release_resolved_proceeds_without_would_block(monkeypatch):
    monkeypatch.setattr(supervisor_mod, "_GOVERNANCE_AVAILABLE", True)
    monkeypatch.setenv("RELEASE_DISPATCH_ENVIRONMENT", "PROD")
    finding = _make_finding(ArbitrationDecision.PERMIT)
    resolve_return = ReleaseResolution(
        status=ReleaseResolutionStatus.RESOLVED, release={"releaseId": "r1"},
    )

    patches = _common_patches("shadow", finding, resolve_return)
    with patches[0], patches[1] as MockEngine, patches[2], patches[3], \
         patches[4] as mock_dispatch, \
         patch.object(supervisor_mod, "_emit_release_dispatch_metric") as mock_metric:
        MockEngine.return_value.evaluate.return_value = finding

        result = supervisor_mod.governed_process_agent_call(
            _AGENTS_CONFIG, _ORCH, "agent-a", {"x": 1}, "use-1",
        )

    mock_dispatch.assert_called_once()
    assert mock_metric.call_args.kwargs["would_block"] is False
    assert result == {"dispatched": True}


# ---------------------------------------------------------------------------
# strict — the core refusal semantics.
# ---------------------------------------------------------------------------


class TestStrictReleaseGate:
    def test_resolved_release_proceeds(self, monkeypatch):
        monkeypatch.setattr(supervisor_mod, "_GOVERNANCE_AVAILABLE", True)
        monkeypatch.setenv("RELEASE_DISPATCH_ENVIRONMENT", "PROD")
        finding = _make_finding(ArbitrationDecision.PERMIT)
        resolve_return = ReleaseResolution(
            status=ReleaseResolutionStatus.RESOLVED, release={"releaseId": "r1"},
        )

        patches = _common_patches("strict", finding, resolve_return)
        with patches[0], patches[1] as MockEngine, patches[2], patches[3], patches[4] as mock_dispatch:
            MockEngine.return_value.evaluate.return_value = finding
            result = supervisor_mod.governed_process_agent_call(
                _AGENTS_CONFIG, _ORCH, "agent-a", {"x": 1}, "use-1",
            )

        mock_dispatch.assert_called_once()
        assert result == {"dispatched": True}

    def test_no_pointer_and_not_grandfathered_refuses(self, monkeypatch):
        monkeypatch.setattr(supervisor_mod, "_GOVERNANCE_AVAILABLE", True)
        monkeypatch.setenv("RELEASE_DISPATCH_ENVIRONMENT", "PROD")
        # effective_at set (cutoff has been flipped) + no per-agent
        # created_at signal available -> is_grandfathered_pure(None,
        # effective_at) is actually True (conservative bypass on missing
        # created_at) per the ported rule. To exercise the "refuses"
        # branch we must simulate a resolvable created_at signal that is
        # AFTER the cutoff, which the gate reads via
        # _resolve_agent_created_at (patched here).
        finding = _make_finding(ArbitrationDecision.PERMIT)
        resolve_return = ReleaseResolution(status=ReleaseResolutionStatus.NO_POINTER)

        patches = _common_patches("strict", finding, resolve_return)
        with patches[0] as mock_load, patches[1] as MockEngine, patches[2], patches[3], \
             patches[4] as mock_dispatch, \
             patch.object(supervisor_mod, "_resolve_agent_created_at",
                          return_value="2026-06-01T00:00:00Z"):
            mock_load.return_value = _make_state("strict", effective_at="2026-05-15T00:00:00Z")
            MockEngine.return_value.evaluate.return_value = finding

            result = supervisor_mod.governed_process_agent_call(
                _AGENTS_CONFIG, _ORCH, "agent-a", {"x": 1}, "use-1",
            )

        mock_dispatch.assert_not_called()
        assert result["denied"] is True
        assert result["reason"] == "no_release_resolvable"

    def test_no_pointer_and_grandfathered_proceeds(self, monkeypatch):
        """No created_at signal available (the honest default for this
        codebase today — see release_resolution.py's module docstring) ->
        is_grandfathered_pure(None, effective_at) is True -> proceeds even
        in strict mode with no release resolvable."""
        monkeypatch.setattr(supervisor_mod, "_GOVERNANCE_AVAILABLE", True)
        monkeypatch.setenv("RELEASE_DISPATCH_ENVIRONMENT", "PROD")
        finding = _make_finding(ArbitrationDecision.PERMIT)
        resolve_return = ReleaseResolution(status=ReleaseResolutionStatus.NO_POINTER)

        patches = _common_patches("strict", finding, resolve_return)
        with patches[0] as mock_load, patches[1] as MockEngine, patches[2], patches[3], \
             patches[4] as mock_dispatch:
            mock_load.return_value = _make_state("strict", effective_at="2026-05-15T00:00:00Z")
            MockEngine.return_value.evaluate.return_value = finding

            result = supervisor_mod.governed_process_agent_call(
                _AGENTS_CONFIG, _ORCH, "agent-a", {"x": 1}, "use-1",
            )

        mock_dispatch.assert_called_once()
        assert result == {"dispatched": True}

    def test_no_pointer_pre_flip_effective_at_none_proceeds(self, monkeypatch):
        """effective_at unset (pre-shadow-flip) -> everyone grandfathered
        regardless of created_at -> proceeds."""
        monkeypatch.setattr(supervisor_mod, "_GOVERNANCE_AVAILABLE", True)
        monkeypatch.setenv("RELEASE_DISPATCH_ENVIRONMENT", "PROD")
        finding = _make_finding(ArbitrationDecision.PERMIT)
        resolve_return = ReleaseResolution(status=ReleaseResolutionStatus.NO_POINTER)

        patches = _common_patches("strict", finding, resolve_return)
        with patches[0] as mock_load, patches[1] as MockEngine, patches[2], patches[3], \
             patches[4] as mock_dispatch, \
             patch.object(supervisor_mod, "_resolve_agent_created_at",
                          return_value="2026-06-01T00:00:00Z"):
            mock_load.return_value = _make_state("strict", effective_at=None)
            MockEngine.return_value.evaluate.return_value = finding

            result = supervisor_mod.governed_process_agent_call(
                _AGENTS_CONFIG, _ORCH, "agent-a", {"x": 1}, "use-1",
            )

        mock_dispatch.assert_called_once()
        assert result == {"dispatched": True}

    def test_lookup_failed_always_refuses_even_if_would_be_grandfathered(self, monkeypatch):
        """Assert-or-refuse doctrine: a LOOKUP_FAILED resolution refuses
        regardless of grandfathering — distinct from the clean NO_POINTER
        case, which grandfathering can excuse."""
        monkeypatch.setattr(supervisor_mod, "_GOVERNANCE_AVAILABLE", True)
        monkeypatch.setenv("RELEASE_DISPATCH_ENVIRONMENT", "PROD")
        finding = _make_finding(ArbitrationDecision.PERMIT)
        resolve_return = ReleaseResolution(
            status=ReleaseResolutionStatus.LOOKUP_FAILED, error="throttled",
        )

        patches = _common_patches("strict", finding, resolve_return)
        with patches[0] as mock_load, patches[1] as MockEngine, patches[2], patches[3], \
             patches[4] as mock_dispatch:
            # No effective_at at all (pre-flip) — normally this would
            # grandfather a NO_POINTER resolution, but LOOKUP_FAILED must
            # refuse unconditionally.
            mock_load.return_value = _make_state("strict", effective_at=None)
            MockEngine.return_value.evaluate.return_value = finding

            result = supervisor_mod.governed_process_agent_call(
                _AGENTS_CONFIG, _ORCH, "agent-a", {"x": 1}, "use-1",
            )

        mock_dispatch.assert_not_called()
        assert result["denied"] is True
        assert result["reason"] == "release_lookup_failed"

    def test_lookup_failed_refusal_takes_precedence_over_authority_permit(self, monkeypatch):
        """Even when the authority-graph decision is PERMIT, a
        LOOKUP_FAILED release resolution still refuses in strict mode —
        the release gate and the authority gate are independent AND'd
        conditions, not an either/or."""
        monkeypatch.setattr(supervisor_mod, "_GOVERNANCE_AVAILABLE", True)
        monkeypatch.setenv("RELEASE_DISPATCH_ENVIRONMENT", "PROD")
        finding = _make_finding(ArbitrationDecision.PERMIT)
        resolve_return = ReleaseResolution(
            status=ReleaseResolutionStatus.LOOKUP_FAILED, error="network",
        )

        patches = _common_patches("strict", finding, resolve_return)
        with patches[0] as mock_load, patches[1] as MockEngine, patches[2] as mock_write, \
             patches[3], patches[4] as mock_dispatch:
            mock_load.return_value = _make_state("strict", effective_at=None)
            MockEngine.return_value.evaluate.return_value = finding

            result = supervisor_mod.governed_process_agent_call(
                _AGENTS_CONFIG, _ORCH, "agent-a", {"x": 1}, "use-1",
            )

        # The authority finding is still written (existing D9 ledger
        # behaviour is unaffected by the release gate).
        mock_write.assert_called_once_with(finding)
        mock_dispatch.assert_not_called()
        assert result["denied"] is True


# ---------------------------------------------------------------------------
# Package-unavailable / bypass interactions — the release gate must never
# run when governance itself is unavailable (same fail-closed contract as
# the authority gate).
# ---------------------------------------------------------------------------


def test_release_gate_never_runs_when_governance_package_unavailable(monkeypatch, caplog):
    monkeypatch.setattr(supervisor_mod, "_GOVERNANCE_AVAILABLE", False)
    monkeypatch.setattr(supervisor_mod, "_GOVERNANCE_IMPORT_ERROR", "boom")
    monkeypatch.setenv("RELEASE_DISPATCH_ENVIRONMENT", "PROD")

    with patch.object(supervisor_mod, "resolve_release") as mock_resolve, \
         patch.object(supervisor_mod, "process_agent_call") as mock_dispatch, \
         caplog.at_level(logging.ERROR, logger=supervisor_mod.logger.name):
        result = supervisor_mod.governed_process_agent_call(
            _AGENTS_CONFIG, _ORCH, "agent-a", {"x": 1}, "use-1",
        )

    mock_resolve.assert_not_called()
    mock_dispatch.assert_not_called()
    assert result["denied"] is True
    assert result["reason"] == "governance_package_unavailable"
