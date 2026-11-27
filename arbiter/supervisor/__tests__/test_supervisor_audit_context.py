"""Supervisor dispatch hands the governance engine real audit evidence.

The seeded global constitution (``arbiter/seedConfig/index.py``) carries the
invariant ``audit.record_produced eq True``
(``no_irreversible_action_without_audit_trail``). ``GovernanceEngine``
reads it from ``DispatchRequest.context``. The supervisor used to build
``context={}``, so the invariant could never hold.

Covers:
  1. ``save_orchestration`` reports success (returns True) and still raises
     on failure for its existing callers.
  2. ``governed_process_agent_call`` persists the orchestration record
     BEFORE the engine is consulted and builds the context from that
     evidence only: ``audit.record_produced`` is True only if the persist
     succeeded.
  3. Offline evaluation against the seeded global constitution rules and the
     seeded ``supervisor-invoke-all`` authority unit with the real engine.
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

_AGENTS_CONFIG = {
    "agents": [{"name": "demo-echo-agent", "domain": "default", "registryStatus": "APPROVED"}]
}
_ORCH_ID = "orch-audit-1"
_RUN_ID = "run-audit-1"
_TRACE_ID = "1-67890abc-1234567890abcdef12345678"


def _orch() -> dict:
    # Fresh dict per test: the supervisor must not leak state through it.
    return {"orchestrationId": _ORCH_ID, "orgId": "org-test", "runId": _RUN_ID}


def _permit() -> GovernanceFinding:
    return GovernanceFinding.create(
        workflow_id=_ORCH_ID,
        decision=ArbitrationDecision.PERMIT,
        requesting_agent="supervisor",
        target_agent="demo-echo-agent",
        reason="test",
        scope_evaluated="supervisor-invoke-all",
    )


def _state() -> MagicMock:
    state = MagicMock()
    state.authority_units = []
    state.composition_contracts = []
    state.case_law = []
    state.constitutional_layers = []
    state.enforcement_mode = "shadow"
    return state


def _dispatch(
    orchestration, *, save_side_effect=None, save_return=True, order=None,
    agents_config=None, agent_name="demo-echo-agent",
):
    """Run governed_process_agent_call; return (request seen by engine, save mock)."""
    order = order if order is not None else []

    def _evaluate(request):
        order.append("evaluate")
        return _permit()

    def _save(_orch):
        order.append("save")
        if save_side_effect is not None:
            raise save_side_effect
        return save_return

    with patch.object(supervisor_mod, "_GOVERNANCE_AVAILABLE", True), \
         patch.object(supervisor_mod, "load_governance_state", return_value=_state()), \
         patch.object(supervisor_mod, "GovernanceEngine") as MockEngine, \
         patch.object(supervisor_mod, "write_finding"), \
         patch.object(supervisor_mod, "process_agent_call", return_value={"ok": True}), \
         patch.object(supervisor_mod, "save_orchestration", side_effect=_save) as mock_save, \
         patch.object(
             supervisor_mod.tracing, "active_trace_context",
             return_value={"traceId": _TRACE_ID},
         ):
        MockEngine.return_value.evaluate.side_effect = _evaluate
        supervisor_mod.governed_process_agent_call(
            agents_config if agents_config is not None else _AGENTS_CONFIG,
            orchestration, agent_name, {"x": 1}, "use-1",
        )
        request = MockEngine.return_value.evaluate.call_args.args[0]
    return request, mock_save


# ---------------------------------------------------------------------------
# 1. save_orchestration success is observable
# ---------------------------------------------------------------------------


class TestSaveOrchestrationResult:
    def test_returns_true_after_put_item_succeeds(self):
        with patch.object(supervisor_mod, "dynamodb") as ddb:
            assert supervisor_mod.save_orchestration({"orchestrationId": "o-1"}) is True
        ddb.Table.return_value.put_item.assert_called_once()

    def test_still_raises_when_put_item_fails(self):
        with patch.object(supervisor_mod, "dynamodb") as ddb:
            ddb.Table.return_value.put_item.side_effect = RuntimeError("ddb down")
            with pytest.raises(RuntimeError, match="ddb down"):
                supervisor_mod.save_orchestration({"orchestrationId": "o-1"})


# ---------------------------------------------------------------------------
# 2. Dispatch context is built from persistence evidence only
# ---------------------------------------------------------------------------


class TestDispatchAuditContext:
    def test_persisted_record_yields_full_evidence_context(self):
        request, _ = _dispatch(_orch())

        assert request.context == {
            "audit.record_produced": True,
            "audit_record_type": "orchestration",
            "audit_record_id": _ORCH_ID,
            "run_id": _RUN_ID,
            "trace_id": _TRACE_ID,
            "scope.expansion_under_unconfirmed_state": False,
        }

    def test_record_is_persisted_before_the_engine_is_consulted(self):
        order: list[str] = []
        _dispatch(_orch(), order=order)

        assert order == ["save", "evaluate"]

    def test_persist_failure_does_not_claim_an_audit_record(self):
        request, _ = _dispatch(_orch(), save_side_effect=RuntimeError("ddb down"))

        assert request.context["audit.record_produced"] is False
        assert "audit_record_id" not in request.context
        assert "audit_record_type" not in request.context

    def test_persist_failure_does_not_halt_the_governed_call(self):
        # The engine, not the supervisor, decides what a missing audit record
        # means (it denies via the invariant); the call itself must complete.
        request, _ = _dispatch(_orch(), save_side_effect=RuntimeError("ddb down"))

        assert request.target_agent_id == "demo-echo-agent"

    def test_save_that_returns_falsy_is_not_treated_as_persisted(self):
        request, _ = _dispatch(_orch(), save_return=None)

        assert request.context["audit.record_produced"] is False

    def test_missing_run_and_trace_ids_are_omitted_not_none(self):
        orch = {"orchestrationId": _ORCH_ID, "orgId": "org-test"}
        with patch.object(supervisor_mod.tracing, "active_trace_context", return_value=None):
            request, _ = _dispatch_without_trace(orch)

        assert "run_id" not in request.context
        assert "trace_id" not in request.context
        assert request.context["audit.record_produced"] is True

    def test_orchestration_without_id_is_never_reported_as_persisted(self):
        request, mock_save = _dispatch(
            {"orgId": "org-test", "runId": _RUN_ID}, save_side_effect=KeyError("orchestrationId"),
        )

        assert request.context["audit.record_produced"] is False

    def test_orchestration_without_id_skips_the_save_and_is_not_persisted(self):
        request, mock_save = _dispatch({"orgId": "org-test"})

        mock_save.assert_not_called()
        assert request.context["audit.record_produced"] is False

    def test_other_request_fields_are_unchanged(self):
        request, _ = _dispatch(_orch())

        assert request.requesting_agent_id == "supervisor"
        assert request.target_agent_id == "demo-echo-agent"
        assert request.action_type == "invoke_agent"
        assert request.domain == "default"
        assert request.workflow_id == _ORCH_ID
        assert request.agent_use_id == "use-1"
        assert request.agent_input == {"x": 1}

    def test_persisted_flag_is_not_written_onto_the_orchestration_row(self):
        # A stored flag would be reloaded as stale "evidence" on resume.
        orch = _orch()
        _dispatch(orch)

        assert set(orch) == {"orchestrationId", "orgId", "runId"}


def _dispatch_without_trace(orchestration):
    """Variant of _dispatch that leaves active_trace_context to the caller's patch."""
    with patch.object(supervisor_mod, "_GOVERNANCE_AVAILABLE", True), \
         patch.object(supervisor_mod, "load_governance_state", return_value=_state()), \
         patch.object(supervisor_mod, "GovernanceEngine") as MockEngine, \
         patch.object(supervisor_mod, "write_finding"), \
         patch.object(supervisor_mod, "process_agent_call", return_value={"ok": True}), \
         patch.object(supervisor_mod, "save_orchestration", return_value=True) as mock_save:
        MockEngine.return_value.evaluate.return_value = _permit()
        supervisor_mod.governed_process_agent_call(
            _AGENTS_CONFIG, orchestration, "demo-echo-agent", {"x": 1}, "use-1",
        )
        request = MockEngine.return_value.evaluate.call_args.args[0]
    return request, mock_save


# ---------------------------------------------------------------------------
# 3. Offline evaluation against the seeded constitution (real engine)
# ---------------------------------------------------------------------------

# Verbatim copy of ``global_constitution`` from ``arbiter/seedConfig/index.py``
# (the dict is built inline inside ``handler()`` and is not importable) and of
# the ``supervisor-invoke-all`` authority unit from the same handler. Keep in
# lockstep with the seed, as arbiter/seedConfig/__tests__/test_index_properties.py
# does for the constitution.
_SEEDED_GLOBAL_CONSTITUTION = {
    "layerId": "global-constitution",
    "layerType": "global",
    "appliesTo": [],
    "rules": [
        {
            "field": "audit.record_produced",
            "operator": "eq",
            "value": True,
            "description": "no_irreversible_action_without_audit_trail",
        },
        {
            "field": "scope.expansion_under_unconfirmed_state",
            "operator": "eq",
            "value": False,
            "description": "no_scope_expansion_under_unconfirmed_state",
        },
    ],
}
_SEEDED_SUPERVISOR_UNIT = {
    "unitId": "supervisor-invoke-all",
    "agentId": "supervisor",
    "registryId": "*GLOBAL*",
    "scope": {
        "decision_type": "invoke_agent",
        "domain": "*",
        "conditions": {},
        "limits": {},
    },
    "riskRating": "low",
    "revoked": False,
}


def _seeded_engine():
    from arbiter.governance.engine import GovernanceEngine
    from arbiter.governance.models import (
        AuthorityScope, AuthorityUnit, ConstitutionalLayer,
    )

    unit = _SEEDED_SUPERVISOR_UNIT
    layer = _SEEDED_GLOBAL_CONSTITUTION
    return GovernanceEngine(
        authority_units=[AuthorityUnit(
            unit_id=unit["unitId"],
            agent_id=unit["agentId"],
            scope=AuthorityScope(
                decision_type=unit["scope"]["decision_type"],
                domain=unit["scope"]["domain"],
                conditions=unit["scope"]["conditions"],
                limits=unit["scope"]["limits"],
            ),
            risk_rating=unit["riskRating"],
            registry_id=unit["registryId"],
            revoked=unit["revoked"],
        )],
        composition_contracts=[],
        case_law=[],
        constitutional_layers=[ConstitutionalLayer(
            layer_id=layer["layerId"],
            layer_type=layer["layerType"],
            applies_to=layer["appliesTo"],
            rules=layer["rules"],
        )],
    )


def _demo_echo_request(context):
    from arbiter.governance.models import DispatchRequest

    return DispatchRequest(
        requesting_agent_id="supervisor",
        target_agent_id="demo-echo-agent",
        action_type="invoke_agent",
        domain="default",
        workflow_id=_ORCH_ID,
        agent_use_id="use-1",
        context=context,
        agent_input={"message": "hello"},
    )


def _supervisor_context() -> dict:
    request, _ = _dispatch(_orch())
    return request.context


class TestSeededConstitutionEvaluation:
    def test_empty_context_is_denied_by_the_audit_invariant(self):
        from arbiter.governance.models import ArbitrationDecision as AD

        finding = _seeded_engine().evaluate(_demo_echo_request({}))

        assert finding.decision == AD.DENY
        assert "audit.record_produced" in finding.reason

    def test_supervisor_context_is_allowed_by_both_seeded_rules(self):
        from arbiter.governance.models import ArbitrationDecision as AD

        finding = _seeded_engine().evaluate(_demo_echo_request(_supervisor_context()))

        assert finding.decision == AD.PERMIT

    def test_unpersisted_record_is_legitimately_denied_by_the_audit_invariant(self):
        from arbiter.governance.models import ArbitrationDecision as AD

        request, _ = _dispatch(_orch(), save_side_effect=RuntimeError("ddb down"))
        finding = _seeded_engine().evaluate(_demo_echo_request(request.context))

        assert finding.decision == AD.DENY
        assert "audit.record_produced" in finding.reason

    def test_missing_scope_field_is_denied_by_the_scope_rule(self):
        # An absent field reads as None, which violates `eq False`.
        from arbiter.governance.models import ArbitrationDecision as AD

        ctx = {
            k: v for k, v in _supervisor_context().items()
            if k != "scope.expansion_under_unconfirmed_state"
        }
        finding = _seeded_engine().evaluate(_demo_echo_request(ctx))

        assert finding.decision == AD.DENY
        assert "scope.expansion_under_unconfirmed_state" in finding.reason

    def test_dynamic_expansion_context_is_denied_by_the_scope_rule(self):
        from arbiter.governance.models import ArbitrationDecision as AD

        request, _ = _dispatch(_orch(), agent_name="not-in-catalogue")
        finding = _seeded_engine().evaluate(_demo_echo_request(request.context))

        assert finding.decision == AD.DENY
        assert "scope.expansion_under_unconfirmed_state" in finding.reason

    def test_awaiting_approval_context_is_denied_by_the_scope_rule(self):
        from arbiter.governance.models import ArbitrationDecision as AD

        request, _ = _dispatch({**_orch(), "status": "awaiting_approval"})
        finding = _seeded_engine().evaluate(_demo_echo_request(request.context))

        assert finding.decision == AD.DENY
        assert "scope.expansion_under_unconfirmed_state" in finding.reason


# ---------------------------------------------------------------------------
# 4. scope.expansion_under_unconfirmed_state evidence
# ---------------------------------------------------------------------------

_SCOPE_FIELD = "scope.expansion_under_unconfirmed_state"


class TestScopeConfinementEvidence:
    def test_catalogue_agent_in_running_orchestration_is_not_an_expansion(self):
        request, _ = _dispatch({**_orch(), "status": "running"})

        assert request.context[_SCOPE_FIELD] is False

    def test_catalogue_agent_with_no_status_is_not_an_expansion(self):
        request, _ = _dispatch(_orch())

        assert request.context[_SCOPE_FIELD] is False

    def test_agent_outside_the_loaded_catalogue_is_an_expansion(self):
        request, _ = _dispatch(_orch(), agent_name="surprise-agent")

        assert request.context[_SCOPE_FIELD] is True

    def test_awaiting_approval_orchestration_is_an_expansion(self):
        request, _ = _dispatch({**_orch(), "status": "awaiting_approval"})

        assert request.context[_SCOPE_FIELD] is True

    def test_empty_loaded_catalogue_is_an_expansion(self):
        request, _ = _dispatch(_orch(), agents_config={"agents": []})

        assert request.context[_SCOPE_FIELD] is True

    def test_helper_treats_unknown_catalogue_as_an_expansion(self):
        ctx = supervisor_mod._audit_evidence_context(
            _orch(), True, agent_name="demo-echo-agent", loaded_agent_names=None,
        )

        assert ctx[_SCOPE_FIELD] is True
