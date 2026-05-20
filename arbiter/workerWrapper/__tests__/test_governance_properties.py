"""
Property-based tests for governance helpers in workerWrapper/governance.py.

Tests step constraints tool filtering, max iterations enforcement,
and backward compatibility when no constraints are provided.
"""

import sys
import os
import json
from unittest.mock import patch, MagicMock

import pytest
from hypothesis import given, assume, settings, HealthCheck
from hypothesis import strategies as st

sys.path.insert(0, os.path.join(os.path.dirname(__file__), ".."))

from governance import (
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

    @given(agent_tools=tool_list)
    @settings(max_examples=100)
    def test_no_constraints_preserves_tool_identity(self, agent_tools):
        """Without constraints, returned list is equal to input (not same object)."""
        result = apply_step_constraints(agent_tools, None)
        assert result == agent_tools
        # Should be a new list, not the same reference
        if agent_tools:
            assert result is not agent_tools
