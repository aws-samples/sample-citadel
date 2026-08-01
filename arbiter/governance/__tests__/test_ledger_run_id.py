"""Unit + property tests for run_id serialization in
arbiter/governance/ledger.py (Pass 1, decision f1cbd5ef).

Mirrors test_ledger.py's TestTraceIdStamping-adjacent byte-identity property
(test_property_serialize_finding_byte_identical_when_trace_id_none) and the
camelCase-alias-when-present test, extended for the new ``run_id`` field —
same fail-closed non-regression discipline: an absent run_id must produce a
ledger item byte-identical to the pre-runId shape.
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
    }
    defaults.update(overrides)
    return GovernanceFinding(**defaults)


_decision_strategy = st.sampled_from(list(ArbitrationDecision))
_optional_str = st.one_of(st.none(), st.text(min_size=1, max_size=40))
_required_str = st.text(min_size=1, max_size=40).filter(lambda s: s.strip() != "")


def _finding_strategy_with_run_id_none() -> st.SearchStrategy[GovernanceFinding]:
    """Same shape as the trace_id byte-identity strategy in test_ledger.py,
    but for run_id — independently drawn everything else, run_id pinned to
    None so the property below checks the absent-run_id write shape."""

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
        )

    return _inner()


@settings(
    max_examples=100,
    deadline=None,
    suppress_health_check=[HealthCheck.function_scoped_fixture],
)
@given(finding=_finding_strategy_with_run_id_none())
def test_property_serialize_finding_byte_identical_when_run_id_none(
    finding: GovernanceFinding,
) -> None:
    """[FAIL-CLOSED NON-REGRESSION property] For an arbitrary finding with
    ``run_id=None`` (the default / no-runId-on-orchestration case), the
    serialized ledger item contains neither ``run_id`` nor ``runId`` — an
    absent run_id produces a byte-identical write to the pre-runId
    serialization, mirroring the trace_id property in test_ledger.py.
    """
    assert finding.run_id is None
    item = ledger._serialize_finding(finding)

    assert "run_id" not in item
    assert "runId" not in item

    raw = dataclasses.asdict(finding)
    assert raw["run_id"] is None


def test_serialize_finding_emits_camelcase_run_id_when_present() -> None:
    finding = _make_finding(run_id="run-abc123")
    item = ledger._serialize_finding(finding)

    assert item["runId"] == "run-abc123"
    # snake_case raw field is present too (same top-level-loop flattening
    # behavior documented for trace_id in test_ledger.py).
    assert item.get("run_id") == "run-abc123"

    assert "ttl" not in item  # ttl is added by write_finding, not _serialize_finding
    assert item["findingId"] == finding.finding_id


def test_run_id_absent_and_trace_id_present_do_not_interfere() -> None:
    """Independence check: the two optional stamps (trace_id, run_id) are
    serialized independently — one present, one absent, in either
    combination, without cross-contamination."""
    finding = _make_finding(trace_id="1-5f2f0000-abcdef0123456789abcdef01", run_id=None)
    item = ledger._serialize_finding(finding)
    assert item["traceId"] == "1-5f2f0000-abcdef0123456789abcdef01"
    assert "runId" not in item

    finding2 = _make_finding(trace_id=None, run_id="run-def456")
    item2 = ledger._serialize_finding(finding2)
    assert item2["runId"] == "run-def456"
    assert "traceId" not in item2
