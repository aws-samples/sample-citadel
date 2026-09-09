"""Unit + property tests for org_id serialization in
arbiter/governance/ledger.py (Governance ledger SLICE 2, decision
7b3f4fe2 supplies the eventual read-side filter; this slice supplies the
VALUE).

Mirrors test_ledger_run_id.py's byte-identity property and the
camelCase-alias-when-present test, extended for the new ``org_id`` field —
same fail-closed non-regression discipline: an absent org_id must produce a
ledger item byte-identical to the pre-org-stamping shape.

NOTE on naming: decision 2dd461f6 (slice 1) unified findingId/workflowId to
camelCase-ONLY (no snake_case duplicate). org_id is NOT part of that
unification list — it is a NEW field added in this slice, so it follows the
SAME additive discipline as trace_id/run_id/eval_run_id: the top-level
``dataclasses.asdict`` flattening loop in ``_serialize_finding`` naturally
emits the snake_case ``org_id`` key (like every other non-unified field),
and an explicit ``item["orgId"] = ...`` camelCase alias is added ONLY when
``finding.org_id is not None`` — never a null placeholder, never an empty
string standing in for "unavailable".
"""
from __future__ import annotations

import dataclasses
import os
import sys
import uuid
from typing import Any

from hypothesis import HealthCheck, given, settings, strategies as st

_PROJECT_ROOT = os.path.abspath(
    os.path.join(os.path.dirname(__file__), "..", "..", "..")
)
if _PROJECT_ROOT not in sys.path:
    sys.path.insert(0, _PROJECT_ROOT)

from arbiter.governance import ledger  # noqa: E402
from arbiter.governance.models import (  # noqa: E402
    ArbitrationDecision,
    GovernanceFinding,
)


def _make_finding(**overrides: Any) -> GovernanceFinding:
    defaults: dict[str, Any] = {
        "workflow_id": "wf-test-001",
        "decision": ArbitrationDecision.PERMIT,
        "requesting_agent": "agent-a",
        "target_agent": "agent-b",
        "reason": "scope covers request",
        "finding_id": str(uuid.uuid4()),
        "timestamp": 1_700_000_000.0,
        "scope_evaluated": "unit-001",
        "contract_evaluated": None,
        "escalation_target": None,
        "residual_authority_denial": False,
        "trace_id": None,
        "run_id": None,
        "eval_run_id": None,
        "org_id": None,
    }
    defaults.update(overrides)
    return GovernanceFinding(**defaults)


_decision_strategy = st.sampled_from(list(ArbitrationDecision))
_optional_str = st.one_of(st.none(), st.text(min_size=1, max_size=40))
_required_str = st.text(min_size=1, max_size=40).filter(lambda s: s.strip() != "")


def _finding_strategy_with_org_id_none() -> st.SearchStrategy[GovernanceFinding]:
    """Same shape as the run_id/eval_run_id byte-identity strategies, but
    for org_id — independently drawn everything else, org_id pinned to None
    so the property below checks the absent-org_id write shape."""

    @st.composite
    def _inner(draw: st.DrawFn) -> GovernanceFinding:
        return GovernanceFinding(
            workflow_id=draw(_required_str),
            decision=draw(_decision_strategy),
            requesting_agent=draw(_required_str),
            target_agent=draw(_required_str),
            reason=draw(_required_str),
            finding_id=str(uuid.uuid4()),
            timestamp=draw(st.floats(min_value=0.0, max_value=2e9)),
            scope_evaluated=draw(_optional_str),
            contract_evaluated=draw(_optional_str),
            escalation_target=draw(_optional_str),
            residual_authority_denial=draw(st.booleans()),
            trace_id=None,
            run_id=None,
            eval_run_id=None,
            org_id=None,
        )

    return _inner()


@settings(
    max_examples=100,
    deadline=None,
    suppress_health_check=[HealthCheck.function_scoped_fixture],
)
@given(finding=_finding_strategy_with_org_id_none())
def test_property_serialize_finding_byte_identical_when_org_id_none(
    finding: GovernanceFinding,
) -> None:
    """[FAIL-CLOSED NON-REGRESSION property] For an arbitrary finding with
    ``org_id=None`` (the default / no-org-available case — e.g. a
    platform-internal finding with no tenant context), the serialized
    ledger item contains neither ``org_id`` nor ``orgId`` — an absent
    org_id produces a byte-identical write to the pre-org-stamping
    serialization, mirroring the run_id/eval_run_id properties.
    """
    assert finding.org_id is None
    item = ledger._serialize_finding(finding)

    assert "org_id" not in item
    assert "orgId" not in item

    raw = dataclasses.asdict(finding)
    assert raw["org_id"] is None


def test_serialize_finding_emits_camelcase_org_id_when_present() -> None:
    finding = _make_finding(org_id="org-abc123")
    item = ledger._serialize_finding(finding)

    assert item["orgId"] == "org-abc123"
    # snake_case raw field is present too (same top-level-loop flattening
    # behavior documented for trace_id/run_id/eval_run_id).
    assert item.get("org_id") == "org-abc123"

    assert "ttl" not in item  # ttl is added by write_finding, not _serialize_finding
    assert item["findingId"] == finding.finding_id


def test_org_id_absent_and_run_id_present_do_not_interfere() -> None:
    """Independence check: the optional stamps (run_id, org_id) are
    serialized independently — one present, one absent, in either
    combination, without cross-contamination."""
    finding = _make_finding(run_id="run-abc123", org_id=None)
    item = ledger._serialize_finding(finding)
    assert item["runId"] == "run-abc123"
    assert "orgId" not in item

    finding2 = _make_finding(run_id=None, org_id="org-def456")
    item2 = ledger._serialize_finding(finding2)
    assert item2["orgId"] == "org-def456"
    assert "runId" not in item2


def test_governance_finding_org_id_defaults_to_none() -> None:
    finding = GovernanceFinding(
        workflow_id="wf-1",
        decision=ArbitrationDecision.PERMIT,
        requesting_agent="arbiter",
        target_agent="agent-1",
        reason="within scope",
    )
    assert finding.org_id is None


def test_governance_finding_create_org_id_kwarg_round_trips() -> None:
    finding = GovernanceFinding.create(
        workflow_id="wf-1",
        decision=ArbitrationDecision.PERMIT,
        requesting_agent="arbiter",
        target_agent="agent-1",
        reason="within scope",
        org_id="org-xyz",
    )
    assert finding.org_id == "org-xyz"


def test_governance_finding_org_id_mutable_post_construction() -> None:
    """Mirrors trace_id's post-construction stamping discipline
    (test_governance_finding_trace_id_mutable_post_construction): the
    supervisor stamps org_id AFTER construction, between engine.evaluate()
    and write_finding(), when org context becomes available only after the
    finding object exists."""
    finding = GovernanceFinding.create(
        workflow_id="wf-1",
        decision=ArbitrationDecision.PERMIT,
        requesting_agent="arbiter",
        target_agent="agent-1",
        reason="within scope",
    )
    assert finding.org_id is None
    finding.org_id = "org-xyz"
    assert finding.org_id == "org-xyz"
