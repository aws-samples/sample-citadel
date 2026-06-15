"""
Property-based tests for fabricator/tools_config.py.

Tests cover:
- parse_decimals: idempotency, type correctness, nested structure preservation
- create_tool_specs: output shape invariants, no Decimals leak through
- create_tool_desc: output format invariants
"""

import sys
import os
from decimal import Decimal

sys.path.insert(0, os.path.join(os.path.dirname(__file__), '..'))
os.environ.setdefault('TOOL_CONFIG_TABLE', 'fake-table')

import pytest
from hypothesis import given, settings, assume, HealthCheck
from hypothesis import strategies as st

from tools_config import parse_decimals, create_tool_specs, create_tool_desc


# ---------------------------------------------------------------------------
# Strategies
# ---------------------------------------------------------------------------

whole_decimals = st.integers(min_value=-10_000, max_value=10_000).map(Decimal)
fractional_decimals = st.floats(
    min_value=-10_000, max_value=10_000,
    allow_nan=False, allow_infinity=False,
).filter(lambda f: f % 1 != 0).map(lambda f: Decimal(str(f)))
any_decimal = st.one_of(whole_decimals, fractional_decimals)

primitives = st.one_of(
    st.integers(min_value=-10_000, max_value=10_000),
    st.floats(min_value=-10_000, max_value=10_000, allow_nan=False, allow_infinity=False),
    st.text(max_size=50),
    st.booleans(),
    st.none(),
)

tool_schema = st.fixed_dictionaries({
    "type": st.just("object"),
    "properties": st.dictionaries(
        st.text(min_size=1, max_size=20, alphabet=st.characters(whitelist_categories=('L',))),
        st.fixed_dictionaries({
            "type": st.sampled_from(["string", "integer", "number", "boolean"]),
            "description": st.text(min_size=1, max_size=100),
        }),
        min_size=1,
        max_size=5,
    ),
    "required": st.lists(
        st.text(min_size=1, max_size=20, alphabet=st.characters(whitelist_categories=('L',))),
        max_size=5,
    ),
})

tool_config_entry = st.fixed_dictionaries({
    "name": st.text(min_size=1, max_size=30, alphabet=st.characters(whitelist_categories=('L', 'N'))),
    "description": st.text(min_size=1, max_size=200),
    "schema": tool_schema,
})


# ---------------------------------------------------------------------------
# parse_decimals properties
# ---------------------------------------------------------------------------

class TestParseDecimalsProperties:
    """Property-based tests for parse_decimals."""

    @given(d=whole_decimals)
    def test_whole_decimals_become_int(self, d):
        """Whole Decimal values must be converted to int."""
        result = parse_decimals(d)
        assert isinstance(result, int)
        assert result == int(d)

    @given(d=fractional_decimals)
    def test_fractional_decimals_become_float(self, d):
        """Fractional Decimal values must be converted to float."""
        result = parse_decimals(d)
        assert isinstance(result, float)

    @given(val=primitives)
    def test_non_decimal_passthrough(self, val):
        """Non-Decimal primitives pass through unchanged."""
        result = parse_decimals(val)
        assert result == val
        assert type(result) == type(val)

    @given(d=any_decimal)
    def test_idempotent(self, d):
        """Applying parse_decimals twice yields the same result as once."""
        first = parse_decimals(d)
        second = parse_decimals(first)
        assert first == second

    @given(data=st.recursive(
        any_decimal | primitives,
        lambda children: st.lists(children, max_size=5) | st.dictionaries(
            st.text(min_size=1, max_size=5), children, max_size=5
        ),
        max_leaves=20,
    ))
    @settings(max_examples=200, suppress_health_check=[HealthCheck.too_slow])
    def test_no_decimals_in_nested_output(self, data):
        """After parse_decimals, no Decimal instances exist anywhere in the output."""
        result = parse_decimals(data)
        _assert_no_decimals(result)

    @given(data=st.dictionaries(
        st.text(min_size=1, max_size=10),
        primitives,
        min_size=0,
        max_size=10,
    ))
    def test_dict_keys_preserved(self, data):
        """Dictionary keys are never modified by parse_decimals."""
        result = parse_decimals(data)
        assert set(result.keys()) == set(data.keys())

    @given(data=st.lists(any_decimal, min_size=0, max_size=20))
    def test_list_length_preserved(self, data):
        """List length is preserved after conversion."""
        result = parse_decimals(data)
        assert len(result) == len(data)


# ---------------------------------------------------------------------------
# create_tool_specs properties
# ---------------------------------------------------------------------------

class TestCreateToolSpecsProperties:
    """Property-based tests for create_tool_specs."""

    @given(tools=st.lists(tool_config_entry, min_size=0, max_size=10))
    @settings(max_examples=100, suppress_health_check=[HealthCheck.too_slow])
    def test_output_length_matches_input(self, tools):
        """Output list length equals number of input tools."""
        config = {"tools": tools}
        specs = create_tool_specs(config)
        assert len(specs) == len(tools)

    @given(tools=st.lists(tool_config_entry, min_size=1, max_size=5))
    @settings(max_examples=50, suppress_health_check=[HealthCheck.too_slow])
    def test_each_spec_has_tool_spec_shape(self, tools):
        """Every output element has the required toolSpec structure."""
        config = {"tools": tools}
        specs = create_tool_specs(config)
        for spec in specs:
            assert "toolSpec" in spec
            ts = spec["toolSpec"]
            assert "name" in ts
            assert "description" in ts
            assert "inputSchema" in ts
            assert "json" in ts["inputSchema"]

    @given(tools=st.lists(tool_config_entry, min_size=1, max_size=5))
    @settings(max_examples=50, suppress_health_check=[HealthCheck.too_slow])
    def test_names_match_input(self, tools):
        """Each spec's name matches the corresponding tool's name."""
        config = {"tools": tools}
        specs = create_tool_specs(config)
        for tool, spec in zip(tools, specs):
            assert spec["toolSpec"]["name"] == tool["name"]

    @given(tools=st.lists(tool_config_entry, min_size=1, max_size=5))
    @settings(max_examples=50, suppress_health_check=[HealthCheck.too_slow])
    def test_schema_has_no_decimals(self, tools):
        """Schemas in output specs contain no Decimal instances after conversion."""
        for tool in tools:
            tool["schema"]["injected_decimal"] = Decimal("99.5")
        config = {"tools": tools}
        specs = create_tool_specs(config)
        for spec in specs:
            _assert_no_decimals(spec["toolSpec"]["inputSchema"]["json"])

    def test_empty_tools_returns_empty(self):
        """Empty tools config produces empty specs list."""
        assert create_tool_specs({"tools": []}) == []
        assert create_tool_specs({}) == []


# ---------------------------------------------------------------------------
# create_tool_desc properties
# ---------------------------------------------------------------------------

class TestCreateToolDescProperties:
    """Property-based tests for create_tool_desc."""

    @given(tools=st.lists(tool_config_entry, min_size=0, max_size=10))
    @settings(max_examples=100, suppress_health_check=[HealthCheck.too_slow])
    def test_output_length_matches_input(self, tools):
        """Output list length equals number of input tools."""
        config = {"tools": tools}
        descs = create_tool_desc(config)
        assert len(descs) == len(tools)

    @given(tools=st.lists(tool_config_entry, min_size=1, max_size=5))
    @settings(max_examples=50, suppress_health_check=[HealthCheck.too_slow])
    def test_each_desc_contains_pipe_separator(self, tools):
        """Each description string contains the ' | ' separator."""
        config = {"tools": tools}
        descs = create_tool_desc(config)
        for desc in descs:
            assert " | " in desc

    @given(tools=st.lists(tool_config_entry, min_size=1, max_size=5))
    @settings(max_examples=50, suppress_health_check=[HealthCheck.too_slow])
    def test_each_desc_starts_with_name(self, tools):
        """Each description starts with the tool name."""
        config = {"tools": tools}
        descs = create_tool_desc(config)
        for tool, desc in zip(tools, descs):
            assert desc.startswith(tool["name"])

    @given(tools=st.lists(tool_config_entry, min_size=1, max_size=5))
    @settings(max_examples=50, suppress_health_check=[HealthCheck.too_slow])
    def test_each_desc_ends_with_description(self, tools):
        """Each description ends with the tool description."""
        config = {"tools": tools}
        descs = create_tool_desc(config)
        for tool, desc in zip(tools, descs):
            assert desc.endswith(tool["description"])

    @given(tools=st.lists(tool_config_entry, min_size=1, max_size=5))
    @settings(max_examples=50, suppress_health_check=[HealthCheck.too_slow])
    def test_desc_format_is_name_pipe_description(self, tools):
        """Each description is exactly 'name | description'."""
        config = {"tools": tools}
        descs = create_tool_desc(config)
        for tool, desc in zip(tools, descs):
            assert desc == f"{tool['name']} | {tool['description']}"

    def test_empty_tools_returns_empty(self):
        """Empty tools config produces empty description list."""
        assert create_tool_desc({"tools": []}) == []
        assert create_tool_desc({}) == []


# ---------------------------------------------------------------------------
# Helpers
# ---------------------------------------------------------------------------

def _assert_no_decimals(obj):
    """Recursively assert no Decimal instances exist in obj."""
    if isinstance(obj, Decimal):
        raise AssertionError(f"Found Decimal: {obj}")
    elif isinstance(obj, dict):
        for v in obj.values():
            _assert_no_decimals(v)
    elif isinstance(obj, list):
        for item in obj:
            _assert_no_decimals(item)
