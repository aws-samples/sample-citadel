"""Record-approval dispatch gate (step 5c) tests for
``governed_process_agent_call``.

Mirrors ``test_release_aware_dispatch.py``'s structure and patch
conventions exactly, layered AFTER the release gate (5b) in the same
call path. Covers the four scenarios from the story brief:

  * strict + PENDING_APPROVAL -> denial dict, process_agent_call NOT
    called, a finding IS written.
  * shadow + DRAFT -> proceeds (would-block only), a finding IS written.
  * strict + APPROVED -> proceeds, NO finding written for the approval
    gate.
  * strict + missing agent-config item -> denial with
    reason='approval_record_unknown'.

``write_finding`` and ``resolve_release``/``load_governance_state`` are
mocked the same way the release-gate integration test mocks them —
boto3 itself is stubbed at import time via the same ``patch.multiple``
block used to import ``index`` as ``supervisor_mod``.
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


_ORCH = {"orchestrationId": "orch-123"}


def _agents_config(registry_status=None, missing=False, created_at=None):
    """Builds the agents_config dict the way agent_config.py now produces
    it post-passthrough: 'registryStatus'/'createdAt' live directly on the
    per-agent dict inside agents_config['agents']."""
    if missing:
        return {"agents": []}
    cfg = {"name": "agent-a", "domain": "billing"}
    if registry_status is not None:
        cfg["registryStatus"] = registry_status
    if created_at is not None:
        cfg["createdAt"] = created_at
    return {"agents": [cfg]}


def _common_patches(mode, finding):
    """Shared patch set: release gate is neutralised (RELEASE_DISPATCH_
    ENVIRONMENT stays unset by the autouse _clean_env fixture, so
    resolve_release is never invoked), leaving only the authority gate
    (evaluate/write_finding) and the approval gate (resolve_record_approval
    is NOT patched — it is the pure function under test; only its
    downstream write_finding/process_agent_call collaborators are)."""
    return (
        patch.object(supervisor_mod, "load_governance_state", return_value=_make_state(mode)),
        patch.object(supervisor_mod, "GovernanceEngine"),
        patch.object(supervisor_mod, "write_finding"),
        patch.object(supervisor_mod, "process_agent_call", return_value={"dispatched": True}),
    )


# ---------------------------------------------------------------------------
# strict + PENDING_APPROVAL -> denial, process_agent_call NOT called,
# finding written.
# ---------------------------------------------------------------------------


def test_strict_pending_approval_denies_and_writes_finding(monkeypatch):
    monkeypatch.setattr(supervisor_mod, "_GOVERNANCE_AVAILABLE", True)
    finding = _make_finding(ArbitrationDecision.PERMIT)
    agents_config = _agents_config(registry_status="PENDING_APPROVAL")

    patches = _common_patches("strict", finding)
    with patches[0], patches[1] as MockEngine, patches[2] as mock_write, patches[3] as mock_dispatch:
        MockEngine.return_value.evaluate.return_value = finding

        result = supervisor_mod.governed_process_agent_call(
            agents_config, _ORCH, "agent-a", {"x": 1}, "use-1",
        )

    mock_dispatch.assert_not_called()
    assert result["denied"] is True
    assert result["reason"] == "approval_absent:PENDING_APPROVAL"
    # Authority-gate finding (write_finding call #1) + approval-gate
    # finding (call #2) — at least the approval finding must be present.
    assert mock_write.call_count == 2
    approval_call_finding = mock_write.call_args_list[-1].args[0]
    assert approval_call_finding.reason == "approval_absent:PENDING_APPROVAL"
    assert approval_call_finding.decision == ArbitrationDecision.DENY


# ---------------------------------------------------------------------------
# shadow + DRAFT -> proceeds, finding written (would-block, not refused).
# ---------------------------------------------------------------------------


def test_shadow_draft_proceeds_and_writes_would_block_finding(monkeypatch):
    monkeypatch.setattr(supervisor_mod, "_GOVERNANCE_AVAILABLE", True)
    finding = _make_finding(ArbitrationDecision.PERMIT)
    agents_config = _agents_config(registry_status="DRAFT")

    patches = _common_patches("shadow", finding)
    with patches[0], patches[1] as MockEngine, patches[2] as mock_write, patches[3] as mock_dispatch:
        MockEngine.return_value.evaluate.return_value = finding

        result = supervisor_mod.governed_process_agent_call(
            agents_config, _ORCH, "agent-a", {"x": 1}, "use-1",
        )

    mock_dispatch.assert_called_once()
    assert result == {"dispatched": True}
    assert mock_write.call_count == 2
    approval_call_finding = mock_write.call_args_list[-1].args[0]
    assert approval_call_finding.decision == ArbitrationDecision.PERMIT


# ---------------------------------------------------------------------------
# strict + APPROVED -> proceeds, no approval-gate finding written (only
# the pre-existing authority-gate finding).
# ---------------------------------------------------------------------------


def test_strict_approved_proceeds_without_extra_finding(monkeypatch):
    monkeypatch.setattr(supervisor_mod, "_GOVERNANCE_AVAILABLE", True)
    finding = _make_finding(ArbitrationDecision.PERMIT)
    agents_config = _agents_config(registry_status="APPROVED")

    patches = _common_patches("strict", finding)
    with patches[0], patches[1] as MockEngine, patches[2] as mock_write, patches[3] as mock_dispatch:
        MockEngine.return_value.evaluate.return_value = finding

        result = supervisor_mod.governed_process_agent_call(
            agents_config, _ORCH, "agent-a", {"x": 1}, "use-1",
        )

    mock_dispatch.assert_called_once()
    assert result == {"dispatched": True}
    # Only the authority-gate's own write_finding call — no approval finding.
    mock_write.assert_called_once_with(finding)


# ---------------------------------------------------------------------------
# strict + missing agent-config item -> denial, approval_record_unknown.
# ---------------------------------------------------------------------------


def test_strict_missing_agent_item_denies_unknown_record(monkeypatch):
    monkeypatch.setattr(supervisor_mod, "_GOVERNANCE_AVAILABLE", True)
    finding = _make_finding(ArbitrationDecision.PERMIT)
    agents_config = _agents_config(missing=True)

    patches = _common_patches("strict", finding)
    with patches[0], patches[1] as MockEngine, patches[2] as mock_write, patches[3] as mock_dispatch:
        MockEngine.return_value.evaluate.return_value = finding

        result = supervisor_mod.governed_process_agent_call(
            agents_config, _ORCH, "agent-a", {"x": 1}, "use-1",
        )

    mock_dispatch.assert_not_called()
    assert result["denied"] is True
    assert result["reason"] == "approval_record_unknown"
    assert mock_write.call_count == 2


# ---------------------------------------------------------------------------
# strict + grandfathered MISSING_STATUS + write_finding raises a
# ConditionalCheckFailedException (wrapped in LedgerWriteError) ->
# already-recorded, dispatch proceeds.
# ---------------------------------------------------------------------------


def _conditional_check_failed_error():
    from botocore.exceptions import ClientError

    client_error = ClientError(
        {"Error": {"Code": "ConditionalCheckFailedException", "Message": "x"}},
        "PutItem",
    )
    return _wrap(client_error)


def _wrap(cause):
    err = supervisor_mod.LedgerWriteError(f"DDB put_item failed: {cause}")
    err.__cause__ = cause
    return err


def test_strict_grandfathered_redelivery_conditional_check_proceeds(monkeypatch):
    monkeypatch.setattr(supervisor_mod, "_GOVERNANCE_AVAILABLE", True)
    finding = _make_finding(ArbitrationDecision.PERMIT)
    agents_config = _agents_config(created_at="2000-01-01T00:00:00Z")

    with patch.object(
        supervisor_mod, "load_governance_state",
        return_value=_make_state("strict", effective_at="2030-01-01T00:00:00Z"),
    ), patch.object(supervisor_mod, "GovernanceEngine") as MockEngine, \
            patch.object(supervisor_mod, "write_finding") as mock_write, \
            patch.object(supervisor_mod, "process_agent_call", return_value={"dispatched": True}) as mock_dispatch:
        MockEngine.return_value.evaluate.return_value = finding
        mock_write.side_effect = [None, _conditional_check_failed_error()]

        result = supervisor_mod.governed_process_agent_call(
            agents_config, _ORCH, "agent-a", {"x": 1}, "use-1",
        )

    mock_dispatch.assert_called_once()
    assert result == {"dispatched": True}


# ---------------------------------------------------------------------------
# strict + grandfathered MISSING_STATUS + write_finding raises a generic
# LedgerWriteError -> strict halts (unchanged behaviour).
# ---------------------------------------------------------------------------


def test_strict_grandfathered_generic_write_error_halts(monkeypatch):
    monkeypatch.setattr(supervisor_mod, "_GOVERNANCE_AVAILABLE", True)
    finding = _make_finding(ArbitrationDecision.PERMIT)
    agents_config = _agents_config(created_at="2000-01-01T00:00:00Z")

    with patch.object(
        supervisor_mod, "load_governance_state",
        return_value=_make_state("strict", effective_at="2030-01-01T00:00:00Z"),
    ), patch.object(supervisor_mod, "GovernanceEngine") as MockEngine, \
            patch.object(supervisor_mod, "write_finding") as mock_write, \
            patch.object(supervisor_mod, "process_agent_call", return_value={"dispatched": True}) as mock_dispatch:
        MockEngine.return_value.evaluate.return_value = finding
        mock_write.side_effect = [None, supervisor_mod.LedgerWriteError("boom")]

        result = supervisor_mod.governed_process_agent_call(
            agents_config, _ORCH, "agent-a", {"x": 1}, "use-1",
        )

    mock_dispatch.assert_not_called()
    assert result["denied"] is True
    assert result["reason"] == "approval_finding_write_failed"
