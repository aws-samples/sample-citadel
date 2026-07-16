"""
Worker-side application of per-node workflow configuration (decision 59376546).

The worker consumes exactly TWO keys from the node-dispatch message's merged
``configuration`` dict, reusing the supervisor task path's enforcement
mechanisms verbatim:

* ``systemPromptAddition`` → ``worker_governance.apply_system_prompt_addition``
  appended to the agent config's ``description``.
* ``modelOverride`` → ``MODEL_OVERRIDE`` in the subprocess env via
  ``worker_governance.build_subprocess_env`` (consumed by
  ``agent_runner._install_model_override``).

Validation parity with the supervisor path: only present, NON-EMPTY STRING
values apply (the supervisor path's falsy-skip / None-omit checks — worker
governance imposes no size caps, so neither does the workflow path). Unknown
keys (including the explicitly deferred ``toolRestrictions``) are IGNORED.
Malformed configuration values never fail the node — a WARN is logged and the
node executes without overrides. An empty configuration leaves behaviour
byte-identical to the pre-feature path.

Wire note: a non-dict ``configuration`` on the SQS message itself is rejected
by the shared contract parser (existing, pinned behaviour — no wire change).
The worker's ``extract_node_overrides`` helper is additionally tolerant of
JSON-string / None / garbage arguments for defensive parity.

All AWS (boto3, subprocess) is mocked; no real network or credentials.
"""

import json
import sys
from unittest.mock import patch, MagicMock

import pytest


_NODE_ENV = {
    'AGENT_CONFIG_TABLE': 'test-table',
    'AGENT_BUCKET_NAME': 'test-bucket',
    'COMPLETION_BUS_NAME': 'citadel-agents-test',
}


def _fresh_index():
    sys.modules.pop('index', None)
    import index
    return index


def _msg(configuration):
    return {
        'message_type': 'workflow_node',
        'execution_id': 'exec-1',
        'node_id': 'n0',
        'workflow_id': 'wf-1',
        'agent_id': 'agent-A',
        'input': {'taskDetails': 'do the thing'},
        'configuration': configuration,
    }


def _extract_extra_env(call):
    env = call.kwargs.get('extra_env')
    if env is None and len(call.args) >= 3:
        env = call.args[2]
    return env


def _run_node(configuration, agent_cfg=None):
    """Drive process_event with a workflow-node message; return
    (mock_run, mock_events, agent_cfg)."""
    if agent_cfg is None:
        agent_cfg = {'config': {'filename': 'agent.py', 'description': 'Base agent.'}}
    mock_events = MagicMock()
    mock_events.put_events.return_value = {'FailedEntryCount': 0}

    with patch.dict('os.environ', _NODE_ENV):
        with patch('boto3.resource'), patch('boto3.client', return_value=mock_events):
            index = _fresh_index()
            with patch.object(index, 'load_config_from_dynamodb',
                              return_value=agent_cfg), \
                 patch.object(index, 'get_scoped_credentials', return_value=None), \
                 patch.object(index, 'load_file_from_s3_into_tmp'), \
                 patch.object(index, 'run_agent_in_subprocess',
                              return_value='done') as mock_run:
                index.process_event(_msg(configuration), {})

    return mock_run, mock_events, agent_cfg


class TestModelOverrideApplication:
    """modelOverride → MODEL_OVERRIDE subprocess env (supervisor mechanism)."""

    def test_model_override_installed_in_subprocess_env(self):
        mock_run, _, _ = _run_node({'modelOverride': 'us.node-model'})

        extra_env = _extract_extra_env(mock_run.call_args)
        assert extra_env is not None
        # The exact env var agent_runner._install_model_override consumes.
        assert extra_env.get('MODEL_OVERRIDE') == 'us.node-model'
        # Governance triplet still intact (no regression).
        assert extra_env.get('CITADEL_AGENT_ID') == 'agent-A'
        assert extra_env.get('CITADEL_WORKFLOW_ID') == 'exec-1'

    def test_empty_string_model_override_is_skipped(self):
        """Existing validation parity: falsy values never install the env var."""
        mock_run, _, _ = _run_node({'modelOverride': ''})
        extra_env = _extract_extra_env(mock_run.call_args)
        assert 'MODEL_OVERRIDE' not in extra_env


class TestSystemPromptAdditionApplication:
    """systemPromptAddition → apply_system_prompt_addition on description."""

    def test_system_prompt_addition_appended_to_description(self):
        _, _, agent_cfg = _run_node({'systemPromptAddition': 'Be terse.'})
        # Exactly the supervisor-path effect: '\n'-joined append.
        assert agent_cfg['config']['description'] == 'Base agent.\nBe terse.'

    def test_empty_string_addition_leaves_description_unchanged(self):
        """Existing validation parity: falsy addition is a no-op."""
        _, _, agent_cfg = _run_node({'systemPromptAddition': ''})
        assert agent_cfg['config']['description'] == 'Base agent.'

    def test_uncapped_value_passes_through_matching_supervisor_path(self):
        """Parity pin: worker_governance imposes no size caps on the supervisor
        path, so the workflow path applies large values verbatim too."""
        big = 'x' * 100_000
        _, _, agent_cfg = _run_node({'systemPromptAddition': big})
        assert agent_cfg['config']['description'] == 'Base agent.\n' + big


class TestEmptyAndUnknownConfiguration:
    """Empty config → byte-identical behaviour; unknown keys ignored."""

    def test_empty_configuration_builds_todays_exact_env(self):
        mock_run, mock_events, agent_cfg = _run_node({})

        extra_env = _extract_extra_env(mock_run.call_args)
        # Byte-identical to the pre-feature env: governance triplet only.
        assert extra_env == {
            'CITADEL_AGENT_ID': 'agent-A',
            'CITADEL_WORKFLOW_ID': 'exec-1',
        }
        assert agent_cfg['config']['description'] == 'Base agent.'
        # Node completed normally.
        entry = mock_events.put_events.call_args.kwargs['Entries'][0]
        assert entry['DetailType'] == 'workflow.node.completed'

    def test_unknown_keys_including_deferred_tool_restrictions_are_ignored(self):
        mock_run, mock_events, agent_cfg = _run_node({
            'toolRestrictions': ['tool-a'],   # explicitly deferred
            'futureKnob': 42,                 # forward-compat carry-through
        })

        extra_env = _extract_extra_env(mock_run.call_args)
        assert 'MODEL_OVERRIDE' not in extra_env
        assert 'DENIED_TOOLS' not in extra_env
        assert agent_cfg['config']['description'] == 'Base agent.'
        entry = mock_events.put_events.call_args.kwargs['Entries'][0]
        assert entry['DetailType'] == 'workflow.node.completed'


class TestMalformedConfigurationValues:
    """Malformed values → WARN + no overrides + node still executes."""

    def test_non_string_values_warn_and_are_ignored(self, capsys):
        mock_run, mock_events, agent_cfg = _run_node({
            'modelOverride': 123,
            'systemPromptAddition': ['not', 'a', 'string'],
        })

        extra_env = _extract_extra_env(mock_run.call_args)
        assert 'MODEL_OVERRIDE' not in extra_env
        assert agent_cfg['config']['description'] == 'Base agent.'
        # Node still executed and completed — malformed config never raises.
        entry = mock_events.put_events.call_args.kwargs['Entries'][0]
        assert entry['DetailType'] == 'workflow.node.completed'
        # A warning was logged for the ignored values.
        assert 'node_configuration_ignored' in capsys.readouterr().out


class TestExtractNodeOverridesHelper:
    """extract_node_overrides: dict; tolerate JSON string; tolerate None;
    never raise on garbage."""

    @pytest.fixture
    def index(self):
        with patch.dict('os.environ', _NODE_ENV):
            with patch('boto3.resource'), patch('boto3.client'):
                yield _fresh_index()

    def test_dict_configuration_yields_both_overrides(self, index):
        result = index.extract_node_overrides(
            {'modelOverride': 'us.m', 'systemPromptAddition': 'Hi.'}
        )
        assert result == ('us.m', 'Hi.')

    def test_json_string_configuration_is_tolerated(self, index):
        result = index.extract_node_overrides(
            json.dumps({'modelOverride': 'us.m', 'systemPromptAddition': 'Hi.'})
        )
        assert result == ('us.m', 'Hi.')

    def test_none_configuration_yields_no_overrides(self, index):
        assert index.extract_node_overrides(None) == (None, None)

    def test_garbage_string_never_raises(self, index, capsys):
        assert index.extract_node_overrides('not-json{') == (None, None)
        assert 'node_configuration_ignored' in capsys.readouterr().out

    def test_non_object_json_never_raises(self, index, capsys):
        assert index.extract_node_overrides('[1, 2]') == (None, None)
        assert index.extract_node_overrides(42) == (None, None)
        assert 'node_configuration_ignored' in capsys.readouterr().out

    def test_unknown_keys_are_ignored(self, index):
        result = index.extract_node_overrides(
            {'toolRestrictions': ['x'], 'other': 1}
        )
        assert result == (None, None)
