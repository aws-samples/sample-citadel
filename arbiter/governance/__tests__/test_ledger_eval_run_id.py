"""Unit + property tests for eval_run_id serialization in
arbiter/governance/ledger.py (CIT-102 Pass B).

Mirrors test_ledger_run_id.py's byte-identity discipline for the new
``eval_run_id`` field / ``evalRunId`` camelCase alias: an absent eval_run_id
must produce a ledger item byte-identical to the pre-CIT-102 shape (the E2
ledger byte-identity precedent).
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
    }
    defaults.update(overrides)
    return GovernanceFinding(**defaults)


_decision_strategy = st.sampled_from(list(ArbitrationDecision))
_optional_str = st.one_of(st.none(), st.text(min_size=1, max_size=40))
_required_str = st.text(min_size=1, max_size=40).filter(lambda s: s.strip() != "")


def _finding_strategy_with_eval_run_id_none() -> st.SearchStrategy[GovernanceFinding]:
    """Same shape as the run_id byte-identity strategy in
    test_ledger_run_id.py, but for eval_run_id — independently drawn
    everything else, eval_run_id pinned to None so the property below
    checks the absent-eval_run_id write shape (the additive-contract
    guarantee: absent contract keys => zero behavior change)."""

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
        )

    return _inner()


@settings(
    max_examples=100,
    deadline=None,
    suppress_health_check=[HealthCheck.function_scoped_fixture],
)
@given(finding=_finding_strategy_with_eval_run_id_none())
def test_property_serialize_finding_byte_identical_when_eval_run_id_none(
    finding: GovernanceFinding,
) -> None:
    """[FAIL-CLOSED NON-REGRESSION property] For an arbitrary finding with
    ``eval_run_id=None`` (the default / non-eval dispatch case), the
    serialized ledger item contains neither ``eval_run_id`` nor
    ``evalRunId`` — an absent eval_run_id produces a byte-identical write
    to the pre-CIT-102 serialization, mirroring the run_id property in
    test_ledger_run_id.py.
    """
    assert finding.eval_run_id is None
    item = ledger._serialize_finding(finding)

    assert "eval_run_id" not in item
    assert "evalRunId" not in item

    raw = dataclasses.asdict(finding)
    assert raw["eval_run_id"] is None


def test_serialize_finding_emits_camelcase_eval_run_id_when_present() -> None:
    finding = _make_finding(eval_run_id="eval-run-abc123")
    item = ledger._serialize_finding(finding)

    assert item["evalRunId"] == "eval-run-abc123"
    # snake_case raw field is present too (same top-level-loop flattening
    # behavior documented for trace_id/run_id).
    assert item.get("eval_run_id") == "eval-run-abc123"

    assert "ttl" not in item  # ttl is added by write_finding, not _serialize_finding
    assert item["findingId"] == finding.finding_id


def test_eval_run_id_absent_and_run_id_present_do_not_interfere() -> None:
    """Independence check: the two optional stamps (run_id, eval_run_id)
    are serialized independently — one present, one absent, in either
    combination, without cross-contamination."""
    finding = _make_finding(run_id="run-abc123", eval_run_id=None)
    item = ledger._serialize_finding(finding)
    assert item["runId"] == "run-abc123"
    assert "evalRunId" not in item

    finding2 = _make_finding(run_id=None, eval_run_id="eval-run-def456")
    item2 = ledger._serialize_finding(finding2)
    assert item2["evalRunId"] == "eval-run-def456"
    assert "runId" not in item2
