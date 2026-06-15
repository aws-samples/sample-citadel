"""US-ARB-007 gap-closing tests for _constitutional_review operator semantics.

Existing coverage for the six operators lives in test_engine.py (from
US-ARB-005). This file adds 4 gap tests per backlog ACs 1, 3, 4:

  1. Two-layer passing: PERMIT stands through multiple stacked layers (AC1).
  2. Unknown operator safe-default PLUS WARN log emitted (AC3).
  3. Property: any violated rule yields DENY regardless of other rules (AC4).
  4. Empty constitutional_layers list is a regression-safe no-op (AC1).

The engine.py module uses relative imports (``from .models import ...``), so
it must be imported as ``arbiter.governance.engine``. The module logger's
name therefore resolves to that same dotted path. This file matches the
import convention already used by test_engine.py / test_ledger.py / etc.,
rather than the alternative sys.path-insertion style in the task template,
to stay consistent with the existing suite.
"""
from __future__ import annotations

import logging
import os
import sys

import pytest
from hypothesis import given, settings, strategies as st

# Add the project root so ``arbiter.governance.*`` resolves when pytest is
# run from the repo root (same pattern as test_engine.py).
_PROJECT_ROOT = os.path.abspath(
    os.path.join(os.path.dirname(__file__), "..", "..", "..")
)
if _PROJECT_ROOT not in sys.path:
    sys.path.insert(0, _PROJECT_ROOT)

from arbiter.governance.engine import GovernanceEngine  # noqa: E402
from arbiter.governance.models import (  # noqa: E402
    ArbitrationDecision,
    AuthorityScope,
    AuthorityUnit,
    ConstitutionalLayer,
    DispatchRequest,
)


# The engine's logger is named after its module: ``arbiter.governance.engine``.
# Using the same string twice (here and in caplog.set_level) keeps the test
# portable even if engine.py is moved.
_ENGINE_LOGGER_NAME = "arbiter.governance.engine"


# ---------------------------------------------------------------------------
# Minimal construction helpers — duplicated from test_engine.py rather than
# imported so this file is self-contained (test_engine.py is not importable
# as a module without risking test re-collection).
# ---------------------------------------------------------------------------


def _make_scope(
    dt: str = "invoke_agent",
    dom: str = "payment",
    conds: dict | None = None,
    lims: dict | None = None,
) -> AuthorityScope:
    return AuthorityScope(
        decision_type=dt,
        domain=dom,
        conditions=conds or {},
        limits=lims or {},
    )


def _make_unit(
    uid: str,
    agent: str = "alice",
    scope: AuthorityScope | None = None,
) -> AuthorityUnit:
    return AuthorityUnit(
        unit_id=uid,
        agent_id=agent,
        scope=scope if scope is not None else _make_scope(),
        revoked=False,
        expiry_timestamp=None,
    )


def _make_request(
    action: str = "invoke_agent",
    dom: str = "payment",
    requester: str = "alice",
    target: str = "bob",
    ctx: dict | None = None,
) -> DispatchRequest:
    return DispatchRequest(
        requesting_agent_id=requester,
        target_agent_id=target,
        action_type=action,
        domain=dom,
        workflow_id="wf-test",
        agent_use_id="use-test",
        context=ctx or {},
    )


# ---------------------------------------------------------------------------
# Test 1 — AC1: PERMIT stands through two stacked constitutional layers
# ---------------------------------------------------------------------------


def test_two_layer_passing_permit_stands() -> None:
    """Two layers with different passing rules must both pass; permit holds.

    This guards against a regression where an additional layer is short-
    circuited or where the loop exits on the first layer regardless of its
    rule outcome.
    """
    unit = _make_unit("unit-ok")
    layer_a = ConstitutionalLayer(
        layer_id="layer-a",
        layer_type="global",
        rules=[{"field": "safety_checked", "operator": "eq", "value": True}],
    )
    layer_b = ConstitutionalLayer(
        layer_id="layer-b",
        layer_type="domain",
        rules=[{"field": "amount", "operator": "lt", "value": 1000}],
    )
    engine = GovernanceEngine(
        authority_units=[unit],
        composition_contracts=[],
        case_law=[],
        constitutional_layers=[layer_a, layer_b],
    )
    # Context satisfies both rules: safety_checked == True AND amount < 1000.
    finding = engine.evaluate(
        _make_request(ctx={"safety_checked": True, "amount": 500})
    )

    assert finding.decision == ArbitrationDecision.PERMIT
    assert finding.reason == "scope_match:unit-ok"
    assert finding.scope_evaluated == "unit-ok"


# ---------------------------------------------------------------------------
# Test 2 — AC3: Unknown operator safe-defaults to non-violation AND warns
# ---------------------------------------------------------------------------


def test_unknown_operator_safe_defaults_and_warns(caplog) -> None:
    """Unknown operator must not trip DENY, and must emit a WARNING log.

    ``matches`` is not one of the six supported operators. The engine's
    fall-through must (a) leave the permit intact and (b) log a warning
    naming the offending operator so operators can find and fix the spec.
    """
    caplog.set_level(logging.WARNING, logger=_ENGINE_LOGGER_NAME)

    unit = _make_unit("unit-ok")
    layer = ConstitutionalLayer(
        layer_id="unknown-op-layer",
        layer_type="global",
        rules=[{"field": "pattern", "operator": "matches", "value": ".*"}],
    )
    engine = GovernanceEngine(
        authority_units=[unit],
        composition_contracts=[],
        case_law=[],
        constitutional_layers=[layer],
    )
    finding = engine.evaluate(_make_request(ctx={"pattern": "anything"}))

    # Safe default: unknown operator does NOT trip a deny.
    assert finding.decision == ArbitrationDecision.PERMIT
    assert finding.reason == "scope_match:unit-ok"

    # A warning was emitted naming the unknown operator.
    warnings = [
        r for r in caplog.records if r.levelno == logging.WARNING
    ]
    assert warnings, "expected at least one WARNING record"
    joined = " ".join(r.getMessage() for r in warnings)
    assert "Unknown constitutional operator" in joined
    assert "matches" in joined


# ---------------------------------------------------------------------------
# Test 3 — AC4: Property — any violated rule always yields DENY
# ---------------------------------------------------------------------------


@given(
    trigger_value=st.integers(),  # int is never == the string 'expected'
    extra_rule_count=st.integers(min_value=0, max_value=4),
    extra_field_seed=st.integers(min_value=0, max_value=10_000),
)
@settings(max_examples=200, deadline=None)
def test_property_violated_rule_always_yields_deny(
    trigger_value: int,
    extra_rule_count: int,
    extra_field_seed: int,
) -> None:
    """No matter what else is in the rule list, a violated rule forces DENY.

    The ``trigger`` field is driven to an int context value while the rule
    expects the string ``'expected'``. Ints are never equal to that string,
    so the guaranteed-violated rule always trips. Additional passing rules
    (0-4 of them) are appended; the engine must still return DENY with a
    ``constitutional_review:`` reason.
    """
    # Rule 0: guaranteed violation — context int != expected string.
    violated_rule = {
        "field": "trigger",
        "operator": "eq",
        "value": "expected",
    }

    # Additional passing rules: each uses ``exists`` on a field whose value
    # is present in context. They can only pass, never deny.
    extra_rules: list[dict] = []
    extra_ctx: dict = {}
    for i in range(extra_rule_count):
        field_name = f"pass_field_{extra_field_seed}_{i}"
        extra_rules.append(
            {"field": field_name, "operator": "exists", "value": None}
        )
        extra_ctx[field_name] = "present"

    rules = [violated_rule, *extra_rules]
    unit = _make_unit("unit-ok")
    layer = ConstitutionalLayer(
        layer_id="prop-layer",
        layer_type="global",
        rules=rules,
    )
    engine = GovernanceEngine(
        authority_units=[unit],
        composition_contracts=[],
        case_law=[],
        constitutional_layers=[layer],
    )

    ctx = {"trigger": trigger_value}
    ctx.update(extra_ctx)
    finding = engine.evaluate(_make_request(ctx=ctx))

    assert finding.decision == ArbitrationDecision.DENY
    assert finding.reason.startswith("constitutional_review:")
    # The overridden permit's scope_evaluated is preserved on the deny.
    assert finding.scope_evaluated == "unit-ok"


# ---------------------------------------------------------------------------
# Test 4 — AC1 regression: empty constitutional_layers list leaves PERMIT
# ---------------------------------------------------------------------------


def test_empty_constitutional_layers_list_permit_passes_through() -> None:
    """An explicit empty list must behave identically to ``None`` (no layers).

    The engine's constructor coerces ``None`` to ``[]``; this test guards
    the ``[]`` code path so a future refactor can't accidentally break it
    (e.g., by treating an empty list as a signal to fail-closed).
    """
    unit = _make_unit("unit-ok")
    engine = GovernanceEngine(
        authority_units=[unit],
        composition_contracts=[],
        case_law=[],
        constitutional_layers=[],
    )
    finding = engine.evaluate(_make_request())

    assert finding.decision == ArbitrationDecision.PERMIT
    assert finding.reason == "scope_match:unit-ok"
    assert finding.scope_evaluated == "unit-ok"

    # Parity check: None-argument and []-argument must produce the same result.
    engine_none = GovernanceEngine(
        authority_units=[unit],
        composition_contracts=[],
        case_law=[],
        constitutional_layers=None,
    )
    finding_none = engine_none.evaluate(_make_request())
    assert finding_none.decision == finding.decision
    assert finding_none.reason == finding.reason
