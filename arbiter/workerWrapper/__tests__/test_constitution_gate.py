"""Constitution gate for worker tool dispatches.

Every tool call the agent subprocess makes is evaluated by the real
``GovernanceEngine`` against the seeded constitution (the wildcard
``worker-invoke-tool-all`` unit plus the two global rules). Evidence comes from
server-side facts only: the execution record, the declared tool list, the node
status, and the run/trace ids.
"""

from __future__ import annotations

import os
import sys
from types import SimpleNamespace
from unittest.mock import MagicMock

import pytest

_WORKER_DIR = os.path.abspath(os.path.join(os.path.dirname(__file__), '..'))
if _WORKER_DIR not in sys.path:
    sys.path.insert(0, _WORKER_DIR)

from governance.models import (  # noqa: E402
    ArbitrationDecision,
    AuthorityScope,
    AuthorityUnit,
    ConstitutionalLayer,
)
from governance.ledger import LedgerWriteError  # noqa: E402
from constitution_gate import ConstitutionGate  # noqa: E402
from governance_tool_hook import GovernanceEvaluator  # noqa: E402

# Mirrors ``worker-invoke-tool-all`` and ``global-constitution`` in
# arbiter/seedConfig/index.py (keep in lockstep with the seed).
_WILDCARD_UNIT = AuthorityUnit(
    unit_id='worker-invoke-tool-all',
    agent_id='*',
    scope=AuthorityScope(
        decision_type='invoke_tool', domain='*', conditions={}, limits={},
    ),
    risk_rating='low',
    registry_id='*GLOBAL*',
    revoked=False,
)
_GLOBAL_LAYER = ConstitutionalLayer(
    layer_id='global-constitution',
    layer_type='global',
    applies_to=[],
    rules=[
        {
            'field': 'audit.record_produced', 'operator': 'eq', 'value': True,
            'description': 'no_irreversible_action_without_audit_trail',
        },
        {
            'field': 'scope.expansion_under_unconfirmed_state',
            'operator': 'eq', 'value': False,
            'description': 'no_scope_expansion_under_unconfirmed_state',
        },
    ],
)


def _state(mode='strict', units=None):
    return SimpleNamespace(
        authority_units=[_WILDCARD_UNIT] if units is None else units,
        composition_contracts=[],
        case_law=[],
        constitutional_layers=[_GLOBAL_LAYER],
        enforcement_mode=mode,
    )


def _gate(
    *,
    mode='strict',
    declared_tools=('good_tool',),
    execution_item=None,
    load_state_fn=None,
    write_finding_fn=None,
    execution_id='exec-1',
):
    item = {'executionId': 'exec-1', 'status': 'running'} \
        if execution_item is None else execution_item
    return ConstitutionGate(
        agent_id='agent-1',
        workflow_id='exec-1',
        execution_id=execution_id,
        node_id='node-1',
        org_id='org-1',
        run_id='run-1',
        eval_run_id='eval-1',
        declared_tools=declared_tools,
        load_state_fn=load_state_fn or (lambda registry_id=None: _state(mode)),
        write_finding_fn=write_finding_fn or MagicMock(),
        execution_lookup_fn=lambda _eid: item,
        trace_id_fn=lambda: 'trace-1',
    )


class TestPermit:
    def test_permits_with_full_evidence_and_wildcard_unit(self):
        write = MagicMock()
        gate = _gate(write_finding_fn=write)

        verdict = gate.evaluate('good_tool', 'tu-1', {'a': 1})

        assert verdict.refuse is False
        assert verdict.decision == ArbitrationDecision.PERMIT
        write.assert_called_once()

    def test_finding_is_stamped_with_correlation_ids(self):
        write = MagicMock()
        gate = _gate(write_finding_fn=write)

        gate.evaluate('good_tool', 'tu-1', {})

        finding = write.call_args.args[0]
        assert finding.trace_id == 'trace-1'
        assert finding.run_id == 'run-1'
        assert finding.eval_run_id == 'eval-1'
        assert finding.org_id == 'org-1'
        assert finding.target_agent == 'tool:good_tool'
        assert finding.scope_evaluated == 'worker-invoke-tool-all'


class TestDeny:
    def test_denies_when_execution_record_is_missing(self):
        gate = _gate()
        gate._execution_lookup_fn = lambda _eid: None  # no record

        verdict = gate.evaluate('good_tool', 'tu-1', {})

        assert verdict.refuse is True
        assert verdict.decision == ArbitrationDecision.DENY
        assert verdict.finding_id

    def test_denies_when_execution_lookup_raises(self):
        def boom(_eid):
            raise RuntimeError('ddb down')

        gate = _gate()
        gate._execution_lookup_fn = boom

        assert gate.evaluate('good_tool', 'tu-1', {}).refuse is True

    def test_denies_tool_outside_declared_tools(self):
        gate = _gate(declared_tools=('good_tool',))

        verdict = gate.evaluate('other_tool', 'tu-1', {})

        assert verdict.refuse is True
        assert 'scope.expansion_under_unconfirmed_state' in verdict.reason

    def test_denies_when_declared_tools_are_unknown(self):
        gate = _gate(declared_tools=None)

        assert gate.evaluate('good_tool', 'tu-1', {}).refuse is True

    def test_denies_when_node_is_awaiting_approval(self):
        gate = _gate(execution_item={
            'executionId': 'exec-1', 'status': 'running',
            'nodeResults': {'node-1': {'status': 'awaiting_approval'}},
        })

        assert gate.evaluate('good_tool', 'tu-1', {}).refuse is True

    def test_denies_when_no_authority_unit_covers_the_tool(self):
        gate = _gate(load_state_fn=lambda registry_id=None: _state(units=[]))

        assert gate.evaluate('good_tool', 'tu-1', {}).refuse is True


class TestEnforcementMode:
    @pytest.mark.parametrize('mode', ['shadow', 'permissive'])
    def test_non_strict_modes_proceed_but_record_the_would_block(self, mode, caplog):
        write = MagicMock()
        gate = _gate(mode=mode, declared_tools=('good_tool',), write_finding_fn=write)

        with caplog.at_level('WARNING'):
            verdict = gate.evaluate('other_tool', 'tu-1', {})

        assert verdict.refuse is False
        assert verdict.would_block is True
        write.assert_called_once()
        assert write.call_args.args[0].decision != ArbitrationDecision.PERMIT
        assert any('would block' in r.getMessage().lower() for r in caplog.records)

    def test_bypass_override_forces_shadow_behaviour(self, monkeypatch):
        monkeypatch.setenv('ARBITER_GOVERNANCE_BYPASS', 'true')
        gate = _gate(mode='strict')

        assert gate.evaluate('other_tool', 'tu-1', {}).refuse is False


class TestFailClosed:
    def test_state_load_failure_denies(self):
        def boom(registry_id=None):
            raise RuntimeError('scan failed')

        gate = _gate(mode='shadow', load_state_fn=boom)

        verdict = gate.evaluate('good_tool', 'tu-1', {})

        assert verdict.refuse is True
        assert 'constitution_state_unavailable' in verdict.reason

    def test_finding_write_failure_denies_in_every_mode(self):
        write = MagicMock(side_effect=LedgerWriteError('ledger down'))
        gate = _gate(mode='shadow', write_finding_fn=write)

        verdict = gate.evaluate('good_tool', 'tu-1', {})

        assert verdict.refuse is True
        assert 'finding_write_failed' in verdict.reason


class TestExecutionLookupCache:
    def test_execution_record_is_read_once_per_process(self):
        calls = []

        def lookup(eid):
            calls.append(eid)
            return {'executionId': eid, 'status': 'running'}

        gate = _gate()
        gate._execution_lookup_fn = lookup

        gate.evaluate('good_tool', 'tu-1', {})
        gate.evaluate('good_tool', 'tu-2', {})

        assert calls == ['exec-1']


# ---------------------------------------------------------------------------
# Hook wiring
# ---------------------------------------------------------------------------


def _event(tool_name='good_tool', tool_use_id='tu-1'):
    return SimpleNamespace(
        tool_use={'name': tool_name, 'toolUseId': tool_use_id, 'input': {'a': 1}},
        selected_tool=SimpleNamespace(tool_name=tool_name),
    )


class TestHookWiring:
    def _evaluator(self, gate):
        return GovernanceEvaluator(
            agent_id='agent-1', workflow_id='exec-1',
            denied_tools=set(), approval_required_tools=set(),
            constitution_gate=gate,
        )

    def test_evaluator_swaps_the_tool_when_the_gate_refuses(self, monkeypatch):
        monkeypatch.setattr('governance_tool_hook.record_governance_decision',
                            lambda *a, **k: (False, None))
        event = _event('other_tool')
        original = event.selected_tool

        refused = self._evaluator(_gate()).evaluate(event)

        assert refused is True
        assert event.selected_tool is not original

    def test_evaluator_leaves_the_tool_when_the_gate_permits(self, monkeypatch):
        monkeypatch.setattr('governance_tool_hook.record_governance_decision',
                            lambda *a, **k: (False, None))
        event = _event('good_tool')
        original = event.selected_tool

        refused = self._evaluator(_gate()).evaluate(event)

        assert refused is False
        assert event.selected_tool is original

    def test_deny_list_still_runs_before_the_gate(self, monkeypatch):
        gate = MagicMock()
        monkeypatch.setattr('governance_tool_hook.record_governance_decision',
                            lambda *a, **k: (True, {'toolUseId': 'tu-1', 'status': 'error', 'content': []}))

        refused = self._evaluator(gate).evaluate(_event())

        assert refused is True
        gate.evaluate.assert_not_called()

    def test_no_gate_is_a_noop(self, monkeypatch):
        monkeypatch.setattr('governance_tool_hook.record_governance_decision',
                            lambda *a, **k: (False, None))
        evaluator = GovernanceEvaluator(
            agent_id='agent-1', workflow_id='exec-1',
            denied_tools=set(), approval_required_tools=set(),
        )

        assert evaluator.evaluate(_event()) is False

    def test_composed_breaker_path_also_consults_the_gate(self, monkeypatch):
        from tool_idempotency_hook import ComposedToolHook

        monkeypatch.setattr('governance_tool_hook.record_governance_decision',
                            lambda *a, **k: (False, None))
        breaker = MagicMock()
        breaker.pre_check.return_value = None
        event = _event('other_tool')
        original = event.selected_tool

        ComposedToolHook(
            governance=self._evaluator(_gate()), idempotency=None, breaker=breaker,
        )._on_before_tool_call(event)

        assert event.selected_tool is not original


class TestEnvThreading:
    def test_build_subprocess_env_carries_run_id_and_declared_tools(self):
        from worker_governance import build_subprocess_env

        env = build_subprocess_env(
            {}, agent_id='a', execution_id='e', run_id='run-9',
            declared_tools=['t1', 't2'],
        )

        assert env['CITADEL_RUN_ID'] == 'run-9'
        assert env['CITADEL_DECLARED_TOOLS'] == 't1,t2'

    def test_empty_declared_tools_is_set_but_none_is_unset(self):
        from worker_governance import build_subprocess_env

        assert build_subprocess_env({}, declared_tools=[])['CITADEL_DECLARED_TOOLS'] == ''
        assert 'CITADEL_DECLARED_TOOLS' not in build_subprocess_env({})

    def test_gate_from_env_reads_the_citadel_variables(self, monkeypatch):
        from constitution_gate import build_constitution_gate_from_env

        monkeypatch.setenv('CITADEL_EXECUTION_ID', 'exec-1')
        monkeypatch.setenv('CITADEL_RUN_ID', 'run-9')
        monkeypatch.setenv('CITADEL_DECLARED_TOOLS', 'a,b')

        gate = build_constitution_gate_from_env('agent-1')

        assert gate is not None
        assert gate._run_id == 'run-9'
        assert gate._declared_tools == frozenset({'a', 'b'})

    def test_gate_from_env_is_none_without_an_execution(self, monkeypatch):
        from constitution_gate import build_constitution_gate_from_env

        monkeypatch.delenv('CITADEL_EXECUTION_ID', raising=False)

        assert build_constitution_gate_from_env('agent-1') is None
