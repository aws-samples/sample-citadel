"""
Property-based tests for governance helpers in workerWrapper/governance.py.

Tests step constraints tool filtering, max iterations enforcement,
and backward compatibility when no constraints are provided.
"""

import sys
import os
import json
import logging
from unittest.mock import patch, MagicMock

import pytest
from hypothesis import given, assume, settings, HealthCheck
from hypothesis import strategies as st

sys.path.insert(0, os.path.join(os.path.dirname(__file__), ".."))

from worker_governance import (
    apply_step_constraints,
    apply_tool_restrictions,
    apply_system_prompt_addition,
    build_subprocess_env,
)


# ---------------------------------------------------------------------------
# Strategies
# ---------------------------------------------------------------------------

tool_id = st.text(
    min_size=1,
    max_size=30,
    alphabet=st.characters(whitelist_categories=("L", "N"), whitelist_characters="-_"),
)

tool_list = st.lists(tool_id, min_size=0, max_size=20, unique=True)

positive_int = st.integers(min_value=1, max_value=10000)


# ---------------------------------------------------------------------------
# Property 24: Step constraints tool filtering
# ---------------------------------------------------------------------------

class TestStepConstraintsToolFiltering:
    """
    Property 24: Step constraints tool filtering

    For any agent tool list and any stepConstraints.allowedTools list,
    the resulting available tools should be the intersection of the two
    lists — only tools present in both the agent's tools and the allowed
    list should remain.

    **Validates: Requirements 13.2**
    """

    @given(agent_tools=tool_list, allowed_tools=tool_list)
    @settings(max_examples=100, suppress_health_check=[HealthCheck.too_slow])
    def test_result_is_intersection_of_agent_tools_and_allowed(self, agent_tools, allowed_tools):
        """Resulting tools are exactly the intersection of agent tools and allowedTools."""
        step_constraints = {'allowedTools': allowed_tools}
        result = apply_step_constraints(agent_tools, step_constraints)

        expected = [t for t in agent_tools if t in set(allowed_tools)]
        assert result == expected

    @given(agent_tools=tool_list, allowed_tools=tool_list)
    @settings(max_examples=100, suppress_health_check=[HealthCheck.too_slow])
    def test_result_is_subset_of_agent_tools(self, agent_tools, allowed_tools):
        """Filtered tools are always a subset of the original agent tools."""
        step_constraints = {'allowedTools': allowed_tools}
        result = apply_step_constraints(agent_tools, step_constraints)

        assert set(result).issubset(set(agent_tools))

    @given(agent_tools=tool_list, allowed_tools=tool_list)
    @settings(max_examples=100, suppress_health_check=[HealthCheck.too_slow])
    def test_result_is_subset_of_allowed_tools(self, agent_tools, allowed_tools):
        """Filtered tools are always a subset of the allowed tools."""
        step_constraints = {'allowedTools': allowed_tools}
        result = apply_step_constraints(agent_tools, step_constraints)

        assert set(result).issubset(set(allowed_tools))

    @given(agent_tools=tool_list, allowed_tools=tool_list)
    @settings(max_examples=100, suppress_health_check=[HealthCheck.too_slow])
    def test_result_preserves_agent_tool_order(self, agent_tools, allowed_tools):
        """Filtered tools preserve the original ordering from agent tools."""
        step_constraints = {'allowedTools': allowed_tools}
        result = apply_step_constraints(agent_tools, step_constraints)

        # Verify order: each result element appears in agent_tools in the same relative order
        agent_indices = [agent_tools.index(t) for t in result]
        assert agent_indices == sorted(agent_indices)


# ---------------------------------------------------------------------------
# Property 25: Max iterations enforcement
# ---------------------------------------------------------------------------

class TestMaxIterationsEnforcement:
    """
    Property 25: Max iterations enforcement

    For any positive integer maxIterations, the Worker Wrapper should pass
    MAX_ITERATIONS as a string env var to the subprocess.

    **Validates: Requirements 13.4**
    """

    @given(max_iterations=positive_int)
    @settings(max_examples=100)
    def test_max_iterations_set_as_env_var(self, max_iterations):
        """MAX_ITERATIONS env var is set to string representation of maxIterations."""
        env = build_subprocess_env({}, max_iterations=max_iterations)
        assert env['MAX_ITERATIONS'] == str(max_iterations)

    @given(max_iterations=positive_int)
    @settings(max_examples=100)
    def test_max_iterations_is_string_type(self, max_iterations):
        """MAX_ITERATIONS env var value is always a string."""
        env = build_subprocess_env({}, max_iterations=max_iterations)
        assert isinstance(env['MAX_ITERATIONS'], str)

    @given(max_iterations=positive_int)
    @settings(max_examples=100)
    def test_max_iterations_round_trips_to_int(self, max_iterations):
        """MAX_ITERATIONS env var can be parsed back to the original integer."""
        env = build_subprocess_env({}, max_iterations=max_iterations)
        assert int(env['MAX_ITERATIONS']) == max_iterations


# ---------------------------------------------------------------------------
# Property 26: No constraints backward compatibility
# ---------------------------------------------------------------------------

class TestNoConstraintsBackwardCompatibility:
    """
    Property 26: No constraints backward compatibility

    Without stepConstraints, all tools are allowed and default iteration
    limit is used (no MAX_ITERATIONS env var set).

    **Validates: Requirements 13.5**
    """

    @given(agent_tools=tool_list)
    @settings(max_examples=100)
    def test_no_constraints_returns_all_tools(self, agent_tools):
        """Without stepConstraints, all agent tools are returned unchanged."""
        result = apply_step_constraints(agent_tools, None)
        assert result == agent_tools

    @given(agent_tools=tool_list)
    @settings(max_examples=100)
    def test_constraints_without_allowed_tools_key_returns_all(self, agent_tools):
        """With stepConstraints dict missing allowedTools key, all tools returned."""
        result = apply_step_constraints(agent_tools, {})
        assert result == agent_tools

    @given(agent_tools=tool_list)
    @settings(max_examples=100)
    def test_constraints_with_other_keys_only_returns_all(self, agent_tools):
        """With stepConstraints containing only maxIterations, all tools returned."""
        result = apply_step_constraints(agent_tools, {'maxIterations': 5})
        assert result == agent_tools

    def test_no_max_iterations_omits_env_var(self):
        """Without maxIterations, MAX_ITERATIONS env var is not set."""
        env = build_subprocess_env({}, max_iterations=None)
        assert 'MAX_ITERATIONS' not in env

    def test_no_app_config_omits_env_var(self):
        """Without appConfig, APP_CONFIG env var is not set."""
        env = build_subprocess_env({})
        assert 'APP_CONFIG' not in env

    def test_no_model_override_omits_env_var(self):
        """Without modelOverride, MODEL_OVERRIDE env var is not set."""
        env = build_subprocess_env({})
        assert 'MODEL_OVERRIDE' not in env

    # -----------------------------------------------------------------
    # US-ARB-012a layer-2 governance triplet tests
    # -----------------------------------------------------------------

    def test_no_governance_identity_omits_env_vars(self):
        """Without agent_id/workflow_id/denied_tools, no injection env vars."""
        env = build_subprocess_env({})
        assert 'CITADEL_AGENT_ID' not in env
        assert 'CITADEL_WORKFLOW_ID' not in env
        assert 'DENIED_TOOLS' not in env

    def test_agent_id_populates_citadel_agent_id(self):
        """agent_id kwarg -> CITADEL_AGENT_ID env var."""
        env = build_subprocess_env({}, agent_id='agent-42')
        assert env['CITADEL_AGENT_ID'] == 'agent-42'

    def test_workflow_id_populates_citadel_workflow_id(self):
        """workflow_id kwarg -> CITADEL_WORKFLOW_ID env var."""
        env = build_subprocess_env({}, workflow_id='wf-abc')
        assert env['CITADEL_WORKFLOW_ID'] == 'wf-abc'

    def test_denied_tools_populates_env_csv(self):
        """denied_tools list -> comma-separated DENIED_TOOLS env var."""
        env = build_subprocess_env({}, denied_tools=['a', 'b', 'c'])
        assert env['DENIED_TOOLS'] == 'a,b,c'

    def test_denied_tools_filters_empty_and_none_entries(self):
        """Falsy entries in denied_tools do not produce empty CSV slots."""
        env = build_subprocess_env({}, denied_tools=['a', '', None, 'b'])  # type: ignore[list-item]
        assert env['DENIED_TOOLS'] == 'a,b'

    def test_empty_denied_tools_list_omits_env_var(self):
        """Empty list doesn't set DENIED_TOOLS (no-op vs unset)."""
        env = build_subprocess_env({}, denied_tools=[])
        assert 'DENIED_TOOLS' not in env

    def test_all_filtered_denied_tools_omits_env_var(self):
        """If every entry is falsy the var stays unset — we never emit a stray
        comma string."""
        env = build_subprocess_env({}, denied_tools=['', None, ''])  # type: ignore[list-item]
        assert 'DENIED_TOOLS' not in env

    def test_empty_agent_id_omits_env_var(self):
        """Empty string (falsy) does NOT populate the env var."""
        env = build_subprocess_env({}, agent_id='')
        assert 'CITADEL_AGENT_ID' not in env

    @given(agent_tools=tool_list)
    @settings(max_examples=100)
    def test_no_constraints_preserves_tool_identity(self, agent_tools):
        """Without constraints, returned list is equal to input (not same object)."""
        result = apply_step_constraints(agent_tools, None)
        assert result == agent_tools
        # Should be a new list, not the same reference
        if agent_tools:
            assert result is not agent_tools


# ---------------------------------------------------------------------------
# Decision 67caf7b0: systemPromptAddition / modelOverride size caps
# ---------------------------------------------------------------------------

class TestSystemPromptAdditionCap:
    """systemPromptAddition size cap (decision 67caf7b0).

    Cap default 4000 chars, overridable via WORKER_MAX_PROMPT_ADDITION_CHARS
    (int; fallback 4000 on missing/invalid). Oversized additions are SKIPPED
    entirely with a WARN — never truncated, never a failure. Length is
    measured on the stripped value. Enforced inside
    apply_system_prompt_addition so the supervisor task path and the
    workflow-node path both get the rule with zero caller changes.
    """

    def test_at_cap_addition_is_applied(self, monkeypatch):
        monkeypatch.delenv('WORKER_MAX_PROMPT_ADDITION_CHARS', raising=False)
        addition = 'x' * 4000
        result = apply_system_prompt_addition('Base.', addition)
        assert result == 'Base.\n' + addition

    def test_over_cap_addition_is_skipped_with_warning(self, monkeypatch, caplog):
        monkeypatch.delenv('WORKER_MAX_PROMPT_ADDITION_CHARS', raising=False)
        addition = 'x' * 4001
        with caplog.at_level(logging.WARNING):
            result = apply_system_prompt_addition('Base.', addition)
        # Skipped entirely — never truncated, prompt unchanged.
        assert result == 'Base.'
        # WARN includes the offending length and the effective cap.
        assert 'system_prompt_addition_skipped' in caplog.text
        assert '4001' in caplog.text
        assert '4000' in caplog.text

    def test_env_override_is_respected(self, monkeypatch, caplog):
        monkeypatch.setenv('WORKER_MAX_PROMPT_ADDITION_CHARS', '10')
        with caplog.at_level(logging.WARNING):
            assert apply_system_prompt_addition('B', 'x' * 10) == 'B\n' + 'x' * 10
            assert apply_system_prompt_addition('B', 'x' * 11) == 'B'
        assert 'system_prompt_addition_skipped' in caplog.text

    def test_invalid_env_falls_back_to_4000(self, monkeypatch):
        monkeypatch.setenv('WORKER_MAX_PROMPT_ADDITION_CHARS', 'not-an-int')
        addition = 'x' * 4000
        assert apply_system_prompt_addition('B', addition) == 'B\n' + addition
        assert apply_system_prompt_addition('B', 'x' * 4001) == 'B'

    def test_non_positive_env_falls_back_to_4000(self, monkeypatch):
        monkeypatch.setenv('WORKER_MAX_PROMPT_ADDITION_CHARS', '-5')
        addition = 'x' * 4000
        assert apply_system_prompt_addition('B', addition) == 'B\n' + addition

    def test_length_is_measured_on_the_stripped_value(self, monkeypatch):
        """Whitespace padding does not count against the cap; the applied
        value is the original addition (never modified)."""
        monkeypatch.delenv('WORKER_MAX_PROMPT_ADDITION_CHARS', raising=False)
        padded = '  ' + 'x' * 4000 + '  \n'
        result = apply_system_prompt_addition('Base.', padded)
        assert result == 'Base.\n' + padded

    def test_helper_reads_env_per_call(self, monkeypatch):
        from worker_governance import get_max_prompt_addition_chars
        monkeypatch.delenv('WORKER_MAX_PROMPT_ADDITION_CHARS', raising=False)
        assert get_max_prompt_addition_chars() == 4000
        monkeypatch.setenv('WORKER_MAX_PROMPT_ADDITION_CHARS', '123')
        assert get_max_prompt_addition_chars() == 123


class TestModelOverrideCap:
    """modelOverride 256-char hygiene cap at its env installation point
    (decision 67caf7b0) — same skip+WARN semantics, never truncate."""

    def test_at_cap_model_override_is_installed(self):
        override = 'm' * 256
        env = build_subprocess_env({}, model_override=override)
        assert env['MODEL_OVERRIDE'] == override

    def test_over_cap_model_override_is_skipped_with_warning(self, caplog):
        override = 'm' * 257
        with caplog.at_level(logging.WARNING):
            env = build_subprocess_env(
                {}, model_override=override, agent_id='agent-9', workflow_id='wf-9'
            )
        assert 'MODEL_OVERRIDE' not in env
        assert 'model_override_skipped' in caplog.text
        assert '257' in caplog.text
        assert '256' in caplog.text
        # Available correlation context rides along in the WARN.
        assert 'agent-9' in caplog.text
        assert 'wf-9' in caplog.text

    def test_skipped_model_override_does_not_disturb_other_env(self, caplog):
        with caplog.at_level(logging.WARNING):
            env = build_subprocess_env(
                {'KEEP': '1'}, model_override='m' * 300, max_iterations=3
            )
        assert env['KEEP'] == '1'
        assert env['MAX_ITERATIONS'] == '3'
        assert 'MODEL_OVERRIDE' not in env


# ---------------------------------------------------------------------------
# US-ARB-015: SCOPE_WORKER_PRE_FILTER constant export
# ---------------------------------------------------------------------------

def test_scope_worker_pre_filter_constant_exported():
    """US-ARB-015: SCOPE_WORKER_PRE_FILTER is exported at module level with
    the canonical value 'worker-pre-filter'. Paired with
    SCOPE_WORKER_TOOL_HANDLER in governed_tool_handler.py per QD-5.
    """
    from worker_governance import SCOPE_WORKER_PRE_FILTER
    assert SCOPE_WORKER_PRE_FILTER == 'worker-pre-filter'
