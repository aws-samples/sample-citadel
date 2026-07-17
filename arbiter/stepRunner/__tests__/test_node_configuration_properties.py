"""
Property-based tests for dag.merge_node_configuration (decision 59376546).

The pure merge helper implements per-node workflow configuration precedence:
``{**workflow_config, **node_config}`` where ``node_config`` is the node
definition's ``configuration`` value. Per-key precedence: node wins. Unknown
keys are carried through untouched (forward compatibility — the worker
ignores what it does not understand). Defensive: a missing/None/empty node
configuration yields the workflow configuration unchanged; a JSON-string
configuration is parsed; garbage is ignored. Inputs are never mutated.

Pure function — no AWS, no I/O.
"""

import sys
import os
import json
import copy

sys.path.insert(0, os.path.join(os.path.dirname(__file__), '..'))

from hypothesis import given, settings
from hypothesis import strategies as st

from dag import merge_node_configuration


# ---------------------------------------------------------------------------
# Strategies
# ---------------------------------------------------------------------------

config_key = st.text(min_size=1, max_size=12)
config_value = st.one_of(
    st.none(),
    st.booleans(),
    st.integers(min_value=-1000, max_value=1000),
    st.text(max_size=12),
)
config_dict = st.dictionaries(config_key, config_value, max_size=6)


class TestMergeNodeConfigurationProperties:
    """Property: merged = {**workflow_config, **node_config}, defensively."""

    @given(workflow_config=config_dict, node_config=config_dict)
    @settings(max_examples=100)
    def test_node_key_wins_per_key(self, workflow_config, node_config):
        """Every key present in the node configuration wins the merge."""
        merged = merge_node_configuration(
            workflow_config, {'id': 'n0', 'configuration': node_config}
        )
        for key, value in node_config.items():
            assert merged[key] == value

    @given(workflow_config=config_dict, node_config=config_dict)
    @settings(max_examples=100)
    def test_workflow_only_keys_preserved(self, workflow_config, node_config):
        """Keys only in the workflow configuration survive the merge unchanged."""
        merged = merge_node_configuration(
            workflow_config, {'id': 'n0', 'configuration': node_config}
        )
        for key, value in workflow_config.items():
            if key not in node_config:
                assert merged[key] == value

    @given(workflow_config=config_dict, node_config=config_dict)
    @settings(max_examples=100)
    def test_merged_keys_are_exactly_the_union(self, workflow_config, node_config):
        """No keys are invented or dropped — unknown keys carried (forward compat)."""
        merged = merge_node_configuration(
            workflow_config, {'id': 'n0', 'configuration': node_config}
        )
        assert set(merged) == set(workflow_config) | set(node_config)

    @given(workflow_config=config_dict, node_config=config_dict)
    @settings(max_examples=100)
    def test_inputs_are_never_mutated(self, workflow_config, node_config):
        """Neither the workflow config nor the node dict is mutated."""
        node = {'id': 'n0', 'configuration': node_config}
        workflow_snapshot = copy.deepcopy(workflow_config)
        node_snapshot = copy.deepcopy(node)

        merge_node_configuration(workflow_config, node)

        assert workflow_config == workflow_snapshot
        assert node == node_snapshot

    @given(workflow_config=config_dict)
    @settings(max_examples=100)
    def test_missing_node_configuration_returns_workflow_config(self, workflow_config):
        """A node without a configuration key → workflow config unchanged."""
        merged = merge_node_configuration(workflow_config, {'id': 'n0'})
        assert merged == workflow_config

    @given(workflow_config=config_dict)
    @settings(max_examples=100)
    def test_none_node_configuration_returns_workflow_config(self, workflow_config):
        """configuration: None → workflow config unchanged."""
        merged = merge_node_configuration(
            workflow_config, {'id': 'n0', 'configuration': None}
        )
        assert merged == workflow_config

    @given(workflow_config=config_dict)
    @settings(max_examples=100)
    def test_empty_node_configuration_returns_workflow_config(self, workflow_config):
        """configuration: {} → workflow config unchanged."""
        merged = merge_node_configuration(
            workflow_config, {'id': 'n0', 'configuration': {}}
        )
        assert merged == workflow_config

    @given(workflow_config=config_dict)
    @settings(max_examples=100)
    def test_none_node_returns_workflow_config(self, workflow_config):
        """A missing node dict entirely → workflow config unchanged."""
        merged = merge_node_configuration(workflow_config, None)
        assert merged == workflow_config

    @given(workflow_config=config_dict)
    @settings(max_examples=100)
    def test_result_is_a_new_dict_not_the_input(self, workflow_config):
        """The merge returns a copy — callers can mutate it safely."""
        merged = merge_node_configuration(workflow_config, {'id': 'n0'})
        assert merged is not workflow_config

    @given(workflow_config=config_dict, node_config=config_dict)
    @settings(max_examples=100)
    def test_json_string_node_configuration_is_parsed(self, workflow_config, node_config):
        """A JSON-string object configuration is tolerated and merged."""
        merged = merge_node_configuration(
            workflow_config, {'id': 'n0', 'configuration': json.dumps(node_config)}
        )
        assert merged == {**workflow_config, **node_config}

    @given(
        workflow_config=config_dict,
        garbage=st.one_of(
            st.just('not-json{'),
            st.just('[1, 2]'),          # valid JSON, not an object
            st.just('"a string"'),      # valid JSON, not an object
            st.integers(),
            st.lists(st.integers(), max_size=3),
            st.booleans(),
        ),
    )
    @settings(max_examples=100)
    def test_garbage_node_configuration_is_ignored(self, workflow_config, garbage):
        """Malformed node configuration never raises — workflow config wins."""
        merged = merge_node_configuration(
            workflow_config, {'id': 'n0', 'configuration': garbage}
        )
        assert merged == workflow_config

    @given(node_config=config_dict)
    @settings(max_examples=100)
    def test_none_workflow_config_treated_as_empty(self, node_config):
        """A None workflow configuration is treated as an empty base."""
        merged = merge_node_configuration(
            None, {'id': 'n0', 'configuration': node_config}
        )
        assert merged == node_config
