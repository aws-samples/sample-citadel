"""
Property-based tests for arbiter/supervisor/agent_config.py

Tests parse_decimals and create_agent_specs using Hypothesis.
"""

import sys
import os
import json
from decimal import Decimal

import pytest
from hypothesis import given, assume, settings
from hypothesis import strategies as st

sys.path.insert(0, os.path.join(os.path.dirname(__file__), ".."))
os.environ.setdefault("AGENT_CONFIG_TABLE", "fake-table")

from agent_config import parse_decimals, create_agent_specs


# ---------------------------------------------------------------------------
# Strategies
# ---------------------------------------------------------------------------

safe_decimals = st.decimals(
    min_value=Decimal("-1e10"),
    max_value=Decimal("1e10"),
    allow_nan=False,
    allow_infinity=False,
)

primitive_values = st.one_of(
    st.integers(min_value=-10**9, max_value=10**9),
    st.floats(min_value=-1e10, max_value=1e10, allow_nan=False, allow_infinity=False),
    st.text(max_size=50),
    st.booleans(),
    st.none(),
    safe_decimals,
)

json_like = st.recursive(
    primitive_values,
    lambda children: st.one_of(
        st.lists(children, max_size=5),
        st.dictionaries(st.text(max_size=10), children, max_size=5),
    ),
    max_leaves=20,
)

agent_config_entry = st.fixed_dictionaries({
    "name": st.text(min_size=1, max_size=30).filter(lambda s: s.strip() != ""),
    "description": st.text(min_size=1, max_size=100).filter(lambda s: s.strip() != ""),
    "schema": st.fixed_dictionaries({
        "type": st.just("object"),
        "properties": st.dictionaries(
            st.text(min_size=1, max_size=20).filter(lambda s: s.strip() != ""),
            st.fixed_dictionaries({
                "type": st.sampled_from(["string", "integer", "boolean", "number"]),
                "description": st.text(min_size=1, max_size=50),
            }),
            min_size=0,
            max_size=4,
        ),
    }),
})

agents_config = st.fixed_dictionaries({
    "agents": st.lists(agent_config_entry, min_size=1, max_size=8),
})


# ---------------------------------------------------------------------------
# parse_decimals (supervisor copy)
# ---------------------------------------------------------------------------

class TestParseDecimals:
    """Property tests for the supervisor's parse_decimals."""

    @given(data=json_like)
    @settings(max_examples=200)
    def test_output_contains_no_decimals(self, data):
        """No Decimal instances remain after parsing."""
        result = parse_decimals(data)
        self._assert_no_decimals(result)

    @given(data=json_like)
    @settings(max_examples=200)
    def test_idempotent(self, data):
        """parse_decimals(parse_decimals(x)) == parse_decimals(x)."""
        once = parse_decimals(data)
        twice = parse_decimals(once)
        assert once == twice

    @given(d=safe_decimals)
    def test_whole_decimals_become_int(self, d):
        """Whole Decimals become int."""
        assume(d % 1 == 0)
        result = parse_decimals(d)
        assert isinstance(result, int)

    @given(d=safe_decimals)
    def test_fractional_decimals_become_float(self, d):
        """Fractional Decimals become float."""
        assume(d % 1 != 0)
        result = parse_decimals(d)
        assert isinstance(result, float)

    @given(items=st.lists(safe_decimals, max_size=10))
    def test_preserves_list_length(self, items):
        result = parse_decimals(items)
        assert len(result) == len(items)

    @given(mapping=st.dictionaries(st.text(max_size=10), safe_decimals, max_size=10))
    def test_preserves_dict_keys(self, mapping):
        result = parse_decimals(mapping)
        assert set(result.keys()) == set(mapping.keys())

    def _assert_no_decimals(self, obj):
        assert not isinstance(obj, Decimal)
        if isinstance(obj, dict):
            for v in obj.values():
                self._assert_no_decimals(v)
        elif isinstance(obj, list):
            for item in obj:
                self._assert_no_decimals(item)


# ---------------------------------------------------------------------------
# create_agent_specs
# ---------------------------------------------------------------------------

class TestCreateAgentSpecs:
    """Property tests for create_agent_specs."""

    @given(config=agents_config)
    @settings(max_examples=100)
    def test_output_length_matches_input(self, config):
        """Number of specs equals number of agents."""
        specs = create_agent_specs(config)
        assert len(specs) == len(config["agents"])

    @given(config=agents_config)
    @settings(max_examples=100)
    def test_each_spec_has_tool_spec_key(self, config):
        """Every output element has a 'toolSpec' key."""
        for spec in create_agent_specs(config):
            assert "toolSpec" in spec

    @given(config=agents_config)
    @settings(max_examples=100)
    def test_each_spec_has_required_fields(self, config):
        """Each toolSpec has name, description, and inputSchema.json."""
        for spec in create_agent_specs(config):
            ts = spec["toolSpec"]
            assert "name" in ts
            assert "description" in ts
            assert "inputSchema" in ts
            assert "json" in ts["inputSchema"]

    @given(config=agents_config)
    @settings(max_examples=100)
    def test_names_preserved_in_order(self, config):
        """Agent names appear in the same order as input."""
        specs = create_agent_specs(config)
        input_names = [a["name"] for a in config["agents"]]
        output_names = [s["toolSpec"]["name"] for s in specs]
        assert input_names == output_names

    @given(config=agents_config)
    @settings(max_examples=100)
    def test_specs_are_json_serializable(self, config):
        """Output specs can be serialized to JSON (no Decimals)."""
        specs = create_agent_specs(config)
        serialized = json.dumps(specs)
        assert isinstance(serialized, str)
