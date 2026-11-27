"""Constitution gate: declared-tool matching and credential-independent reads.

Two risks closed here:

1. Declared-tool matching. ``config['tools']`` entries may be bare toolIds,
   dicts carrying ``name`` and/or ``toolId``, while the Strands tool name the
   hook sees may be either form. The gate accepts a tool when ANY identifier of
   a declared entry matches (hyphen/underscore and case folded). An EMPTY
   declared list means "built-in tools only": the agent's own module defines
   its tools inline (e.g. ``smoke_write_marker``), so nothing can expand beyond
   a declaration that does not exist. Only ``None`` (unknown) denies everything.

2. Credentials. The agent subprocess runs with every ambient AWS credential
   scrubbed (scoped STS credentials, or none at all), so the gate's DynamoDB
   reads (governance tables, executions table) cannot rely on the worker's
   Lambda role. The parent loads that read-only evidence with its own
   credentials and hands it over through a private snapshot file.
"""

from __future__ import annotations

import os
import stat
import sys
from types import SimpleNamespace
from unittest.mock import MagicMock

import pytest

_WORKER_DIR = os.path.abspath(os.path.join(os.path.dirname(__file__), '..'))
if _WORKER_DIR not in sys.path:
    sys.path.insert(0, _WORKER_DIR)

from governance.models import (  # noqa: E402
    AuthorityScope,
    AuthorityUnit,
    ConstitutionalLayer,
)
from constitution_gate import (  # noqa: E402
    ConstitutionGate,
    build_constitution_gate_from_env,
    prepare_governance_snapshot,
)
from worker_governance import (  # noqa: E402
    build_subprocess_env,
    declared_tool_identifiers,
)

_WILDCARD_UNIT = AuthorityUnit(
    unit_id='worker-invoke-tool-all', agent_id='*',
    scope=AuthorityScope(
        decision_type='invoke_tool', domain='*', conditions={}, limits={},
    ),
    risk_rating='low', registry_id='*GLOBAL*', revoked=False,
)
_GLOBAL_LAYER = ConstitutionalLayer(
    layer_id='global-constitution', layer_type='global', applies_to=[],
    rules=[
        {'field': 'audit.record_produced', 'operator': 'eq', 'value': True,
         'description': 'no_irreversible_action_without_audit_trail'},
        {'field': 'scope.expansion_under_unconfirmed_state',
         'operator': 'eq', 'value': False,
         'description': 'no_scope_expansion_under_unconfirmed_state'},
    ],
)


def _state(mode='strict'):
    return SimpleNamespace(
        authority_units=[_WILDCARD_UNIT], composition_contracts=[],
        case_law=[], constitutional_layers=[_GLOBAL_LAYER],
        enforcement_mode=mode,
    )


def _gate(declared_tools):
    return ConstitutionGate(
        agent_id='agent-1', workflow_id='exec-1', execution_id='exec-1',
        node_id='node-1', org_id='org-1', run_id='run-1',
        declared_tools=declared_tools,
        load_state_fn=lambda registry_id=None: _state(),
        write_finding_fn=MagicMock(),
        execution_lookup_fn=lambda _e: {'executionId': 'exec-1', 'status': 'running'},
        trace_id_fn=lambda: 'trace-1',
    )


class TestDeclaredToolIdentifiers:
    def test_collects_name_and_tool_id_from_dict_entries(self):
        ids = declared_tool_identifiers([
            {'name': 'Search Docs', 'toolId': 'tool-123'},
            {'toolId': 'tool-9'},
            {'name': 'only_name'},
            'bare-tool-id',
        ])

        assert ids == ['Search Docs', 'tool-123', 'tool-9', 'only_name', 'bare-tool-id']

    def test_ignores_empty_and_non_string_values(self):
        assert declared_tool_identifiers([None, '', {'name': ''}, {'toolId': 5}, 7]) == []

    def test_env_carries_every_identifier(self):
        env = build_subprocess_env(
            {}, agent_id='a', execution_id='e',
            declared_tools=[{'name': 'n1', 'toolId': 't1'}, 't2'],
        )

        assert env['CITADEL_DECLARED_TOOLS'] == 'n1,t1,t2'


class TestDeclaredToolMatching:
    def test_tool_id_only_declaration_permits_the_tool_id(self):
        ids = declared_tool_identifiers([{'toolId': 'tool-123'}])

        assert _gate(ids).evaluate('tool-123', 'tu-1', {}).refuse is False

    def test_name_declared_alongside_tool_id_permits_the_name(self):
        ids = declared_tool_identifiers([{'name': 'search_docs', 'toolId': 'tool-123'}])

        assert _gate(ids).evaluate('search_docs', 'tu-1', {}).refuse is False

    def test_hyphen_and_case_variants_of_a_declared_name_match(self):
        gate = _gate(['Search-Docs'])

        assert gate.evaluate('search_docs', 'tu-1', {}).refuse is False

    def test_a_different_tool_is_still_outside_scope(self):
        gate = _gate(declared_tools=['tool-123'])

        verdict = gate.evaluate('tool-124', 'tu-1', {})

        assert verdict.refuse is True
        assert 'scope.expansion_under_unconfirmed_state' in verdict.reason

    def test_prefix_of_a_declared_tool_does_not_match(self):
        assert _gate(['search_docs']).evaluate('search', 'tu-1', {}).refuse is True

    def test_empty_declared_list_means_built_in_tools_only_and_is_permitted(self):
        gate = _gate(declared_tools=[])

        assert gate.evaluate('smoke_write_marker', 'tu-1', {}).refuse is False

    def test_unknown_declared_list_still_denies(self):
        assert _gate(declared_tools=None).evaluate('echo', 'tu-1', {}).refuse is True

    def test_env_roundtrip_with_tool_id_only_declaration(self, monkeypatch):
        env = build_subprocess_env(
            {}, agent_id='a', execution_id='e', declared_tools=[{'toolId': 'tool-123'}],
        )
        monkeypatch.setenv('CITADEL_EXECUTION_ID', 'exec-1')
        monkeypatch.setenv('CITADEL_DECLARED_TOOLS', env['CITADEL_DECLARED_TOOLS'])

        gate = build_constitution_gate_from_env('agent-1')

        assert gate is not None
        assert gate.build_context('tool-123')['scope.expansion_under_unconfirmed_state'] is False

    def test_env_roundtrip_with_empty_list_is_built_in_only(self, monkeypatch):
        monkeypatch.setenv('CITADEL_EXECUTION_ID', 'exec-1')
        monkeypatch.setenv('CITADEL_DECLARED_TOOLS', '')

        gate = build_constitution_gate_from_env('agent-1')

        assert gate.build_context('echo')['scope.expansion_under_unconfirmed_state'] is False


class TestGovernanceSnapshot:
    def _prepare(self, tmp_path, **kw):
        return prepare_governance_snapshot(
            execution_id='exec-1', registry_id=None,
            load_state_fn=kw.get('load_state_fn', lambda registry_id=None: _state()),
            execution_lookup_fn=kw.get(
                'execution_lookup_fn',
                lambda _e: {'executionId': 'exec-1', 'status': 'running'},
            ),
            directory=str(tmp_path),
        )

    def test_snapshot_file_is_private(self, tmp_path):
        path = self._prepare(tmp_path)

        assert stat.S_IMODE(os.stat(path).st_mode) == 0o600

    def test_subprocess_gate_reads_snapshot_without_touching_dynamodb(
        self, tmp_path, monkeypatch,
    ):
        import boto3
        import governance.hierarchy as hierarchy

        path = self._prepare(tmp_path)

        def _boom(*a, **k):
            raise AssertionError('subprocess must not read DynamoDB')

        monkeypatch.setattr(boto3, 'resource', _boom)
        monkeypatch.setattr(hierarchy, 'load_governance_state', _boom)
        monkeypatch.setenv('CITADEL_EXECUTION_ID', 'exec-1')
        monkeypatch.setenv('CITADEL_DECLARED_TOOLS', 'echo')
        monkeypatch.setenv('CITADEL_GOVERNANCE_STATE_FILE', path)

        gate = build_constitution_gate_from_env('agent-1')
        gate._write_finding_fn = MagicMock()
        verdict = gate.evaluate('echo', 'tu-1', {})

        assert verdict.refuse is False

    def test_unreadable_snapshot_fails_closed(self, tmp_path, monkeypatch):
        bad = tmp_path / 'bad.pkl'
        bad.write_bytes(b'not a snapshot')
        monkeypatch.setenv('CITADEL_EXECUTION_ID', 'exec-1')
        monkeypatch.setenv('CITADEL_DECLARED_TOOLS', 'echo')
        monkeypatch.setenv('CITADEL_GOVERNANCE_STATE_FILE', str(bad))

        gate = build_constitution_gate_from_env('agent-1')
        gate._write_finding_fn = MagicMock()
        verdict = gate.evaluate('echo', 'tu-1', {})

        assert verdict.refuse is True
        assert verdict.reason == 'constitution_state_unavailable'

    def test_snapshot_carries_missing_execution_record_as_missing_evidence(
        self, tmp_path, monkeypatch,
    ):
        path = self._prepare(tmp_path, execution_lookup_fn=lambda _e: None)
        monkeypatch.setenv('CITADEL_EXECUTION_ID', 'exec-1')
        monkeypatch.setenv('CITADEL_DECLARED_TOOLS', 'echo')
        monkeypatch.setenv('CITADEL_GOVERNANCE_STATE_FILE', path)

        gate = build_constitution_gate_from_env('agent-1')

        assert gate.build_context('echo')['audit.record_produced'] is False

    def test_parent_load_failure_returns_none_so_child_reads_live(self, tmp_path):
        def _fail(registry_id=None):
            raise RuntimeError('ddb down')

        assert self._prepare(tmp_path, load_state_fn=_fail) is None

    def test_env_threads_the_snapshot_path(self):
        env = build_subprocess_env(
            {}, agent_id='a', execution_id='e', governance_snapshot_path='/tmp/x.pkl',
        )

        assert env['CITADEL_GOVERNANCE_STATE_FILE'] == '/tmp/x.pkl'

    def test_env_omits_snapshot_variable_when_absent(self):
        assert 'CITADEL_GOVERNANCE_STATE_FILE' not in build_subprocess_env(
            {}, agent_id='a', execution_id='e',
        )
