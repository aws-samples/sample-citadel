"""
Property-based tests for app config injection in workerWrapper/governance.py.

# Feature: agent-apps-platform, Property 15: App config injection into subprocess

Tests that app config values are injected as APP_CONFIG env var with serialized JSON.

**Validates: Requirements 7.9**
"""

import sys
import os
import json

import pytest
from hypothesis import given, settings, HealthCheck
from hypothesis import strategies as st

sys.path.insert(0, os.path.join(os.path.dirname(__file__), ".."))

from governance import build_subprocess_env


# ---------------------------------------------------------------------------
# Strategies
# ---------------------------------------------------------------------------

# Generate realistic app config values: JSON-serializable dicts
json_primitives = st.one_of(
    st.text(min_size=0, max_size=50),
    st.integers(min_value=-10000, max_value=10000),
    st.floats(allow_nan=False, allow_infinity=False),
    st.booleans(),
    st.none(),
)

# Recursive JSON strategy for nested config values
json_values = st.recursive(
    json_primitives,
    lambda children: st.one_of(
        st.lists(children, min_size=0, max_size=5),
        st.dictionaries(
            st.text(min_size=1, max_size=20, alphabet=st.characters(
                whitelist_categories=("L", "N"), whitelist_characters="_-"
            )),
            children,
            min_size=0,
            max_size=5,
        ),
    ),
    max_leaves=15,
)

# App config is always a dict at the top level
app_config_strategy = st.dictionaries(
    st.text(min_size=1, max_size=20, alphabet=st.characters(
        whitelist_categories=("L", "N"), whitelist_characters="_-"
    )),
    json_values,
    min_size=0,
    max_size=10,
)


# ---------------------------------------------------------------------------
# Property 15: App config injection into subprocess
# ---------------------------------------------------------------------------

class TestAppConfigInjection:
    """
    Property 15: App config injection into subprocess

    For any app configuration values (valid JSON object), the Worker Wrapper
    should inject them into the agent subprocess environment as the APP_CONFIG
    environment variable containing the serialized JSON string.

    **Validates: Requirements 7.9**
    """

    @given(app_config=app_config_strategy)
    @settings(max_examples=100, suppress_health_check=[HealthCheck.too_slow])
    def test_app_config_injected_as_env_var(self, app_config):
        """APP_CONFIG env var is set when app config is provided."""
        env = build_subprocess_env({}, app_config=app_config)
        assert 'APP_CONFIG' in env

    @given(app_config=app_config_strategy)
    @settings(max_examples=100, suppress_health_check=[HealthCheck.too_slow])
    def test_app_config_is_valid_json_string(self, app_config):
        """APP_CONFIG env var value is a valid JSON string."""
        env = build_subprocess_env({}, app_config=app_config)
        parsed = json.loads(env['APP_CONFIG'])
        assert isinstance(parsed, dict)

    @given(app_config=app_config_strategy)
    @settings(max_examples=100, suppress_health_check=[HealthCheck.too_slow])
    def test_app_config_round_trips_through_json(self, app_config):
        """Serializing then deserializing APP_CONFIG produces equivalent object."""
        env = build_subprocess_env({}, app_config=app_config)
        deserialized = json.loads(env['APP_CONFIG'])
        assert deserialized == app_config

    @given(app_config=app_config_strategy)
    @settings(max_examples=100, suppress_health_check=[HealthCheck.too_slow])
    def test_app_config_is_string_type(self, app_config):
        """APP_CONFIG env var value is always a string (env vars must be strings)."""
        env = build_subprocess_env({}, app_config=app_config)
        assert isinstance(env['APP_CONFIG'], str)

    def test_no_app_config_omits_env_var(self):
        """When app_config is None, APP_CONFIG env var is not set."""
        env = build_subprocess_env({})
        assert 'APP_CONFIG' not in env

    @given(app_config=app_config_strategy)
    @settings(max_examples=100, suppress_health_check=[HealthCheck.too_slow])
    def test_app_config_does_not_clobber_base_env(self, app_config):
        """Injecting APP_CONFIG preserves existing base env vars."""
        base_env = {'EXISTING_VAR': 'keep_me', 'PATH': '/usr/bin'}
        env = build_subprocess_env(base_env, app_config=app_config)
        assert env['EXISTING_VAR'] == 'keep_me'
        assert env['PATH'] == '/usr/bin'
        assert 'APP_CONFIG' in env
