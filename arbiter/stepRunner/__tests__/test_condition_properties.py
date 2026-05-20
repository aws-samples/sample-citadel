"""
Property-based tests for stepRunner/condition.py.

Tests cover:
- Property 3: Condition Evaluation Determinism
- equals operator returns True iff field value == condition value
- exists operator returns True iff field path resolves to non-None
- resolve_field_path on flat dict with key k returns obj[k]
- resolve_field_path on missing path returns None (not raises)
- notEquals, contains, greaterThan, lessThan operators work correctly
"""

import sys
import os

sys.path.insert(0, os.path.join(os.path.dirname(__file__), '..'))

import pytest
from hypothesis import given, settings, assume
from hypothesis import strategies as st

from condition import evaluate_condition, resolve_field_path


# ---------------------------------------------------------------------------
# Strategies
# ---------------------------------------------------------------------------

# Simple JSON-compatible values for condition testing
json_values = st.one_of(
    st.integers(min_value=-1000, max_value=1000),
    st.floats(allow_nan=False, allow_infinity=False, min_value=-1000, max_value=1000),
    st.text(min_size=0, max_size=20),
    st.booleans(),
)

# Simple flat dicts with string keys and JSON-compatible values
flat_dicts = st.dictionaries(
    keys=st.text(min_size=1, max_size=10, alphabet=st.characters(whitelist_categories=('L', 'N'))),
    values=json_values,
    min_size=0,
    max_size=5,
)

# Dot-notation field paths (1-3 segments)
field_path_segments = st.text(min_size=1, max_size=8, alphabet=st.characters(whitelist_categories=('L', 'N')))
field_paths = st.lists(field_path_segments, min_size=1, max_size=3).map('.'.join)

# Operators
operators = st.sampled_from(['equals', 'notEquals', 'contains', 'greaterThan', 'lessThan', 'exists'])



# ---------------------------------------------------------------------------
# Property 3: Condition Evaluation Determinism (Task 8.2)
# ---------------------------------------------------------------------------

class TestConditionEvaluationDeterminism:
    """
    **Validates: Requirements 16.1, 16.2**

    Property 3: For all conditions c and outputs o,
    evaluate_condition(c, o) always returns the same boolean for the same inputs.
    """

    @given(
        field=field_paths,
        operator=operators,
        value=json_values,
        source_output=flat_dicts,
    )
    @settings(max_examples=100)
    def test_evaluate_condition_is_deterministic(self, field, operator, value, source_output):
        """Calling evaluate_condition twice with identical inputs returns the same result."""
        condition = {'field': field, 'operator': operator, 'value': value}
        result1 = evaluate_condition(condition, source_output)
        result2 = evaluate_condition(condition, source_output)
        assert result1 == result2
        assert isinstance(result1, bool)


# ---------------------------------------------------------------------------
# equals operator (Task 8.2)
# ---------------------------------------------------------------------------

class TestEqualsOperator:
    """
    **Validates: Requirements 16.1, 16.2**

    equals returns True iff field value == condition value.
    """

    @given(key=field_path_segments, value=json_values)
    @settings(max_examples=100)
    def test_equals_true_when_field_matches(self, key, value):
        """equals returns True when the field value matches the condition value."""
        source_output = {key: value}
        condition = {'field': key, 'operator': 'equals', 'value': value}
        assert evaluate_condition(condition, source_output) is True

    @given(key=field_path_segments, val_a=st.integers(), val_b=st.integers())
    @settings(max_examples=100)
    def test_equals_false_when_field_differs(self, key, val_a, val_b):
        """equals returns False when the field value differs from the condition value."""
        assume(val_a != val_b)
        source_output = {key: val_a}
        condition = {'field': key, 'operator': 'equals', 'value': val_b}
        assert evaluate_condition(condition, source_output) is False


# ---------------------------------------------------------------------------
# exists operator (Task 8.2)
# ---------------------------------------------------------------------------

class TestExistsOperator:
    """
    **Validates: Requirements 16.1, 16.2**

    exists returns True iff field path resolves to non-None.
    """

    @given(key=field_path_segments, value=json_values)
    @settings(max_examples=100)
    def test_exists_true_when_field_present(self, key, value):
        """exists returns True when the field path resolves to a value."""
        source_output = {key: value}
        condition = {'field': key, 'operator': 'exists', 'value': None}
        assert evaluate_condition(condition, source_output) is True

    @given(key=field_path_segments)
    @settings(max_examples=100)
    def test_exists_false_when_field_missing(self, key):
        """exists returns False when the field path does not exist."""
        source_output = {}
        condition = {'field': key, 'operator': 'exists', 'value': None}
        assert evaluate_condition(condition, source_output) is False


# ---------------------------------------------------------------------------
# resolve_field_path (Task 8.2)
# ---------------------------------------------------------------------------

class TestResolveFieldPath:
    """
    **Validates: Requirements 16.1, 16.2**

    resolve_field_path on flat dict with key k returns obj[k].
    resolve_field_path on missing path returns None (not raises).
    """

    @given(key=field_path_segments, value=json_values)
    @settings(max_examples=100)
    def test_flat_dict_returns_value(self, key, value):
        """resolve_field_path on a flat dict with key k returns obj[k]."""
        obj = {key: value}
        assert resolve_field_path(obj, key) == value

    @given(path=field_paths)
    @settings(max_examples=100)
    def test_missing_path_returns_none(self, path):
        """resolve_field_path on a missing path returns None, never raises."""
        obj = {}
        result = resolve_field_path(obj, path)
        assert result is None

    def test_nested_path_resolves(self):
        """resolve_field_path resolves dot-notation into nested dicts."""
        obj = {'result': {'status': 'success'}}
        assert resolve_field_path(obj, 'result.status') == 'success'

    def test_empty_path_returns_none(self):
        """resolve_field_path with empty string returns None."""
        obj = {'a': 1}
        assert resolve_field_path(obj, '') is None

    def test_partial_path_returns_none(self):
        """resolve_field_path with partially valid path returns None."""
        obj = {'a': {'b': 1}}
        assert resolve_field_path(obj, 'a.b.c') is None


# ---------------------------------------------------------------------------
# notEquals, contains, greaterThan, lessThan operators (Task 8.2)
# ---------------------------------------------------------------------------

class TestOtherOperators:
    """
    **Validates: Requirements 16.1, 16.2**

    notEquals, contains, greaterThan, lessThan operators work correctly.
    """

    @given(key=field_path_segments, val_a=st.integers(), val_b=st.integers())
    @settings(max_examples=100)
    def test_not_equals_true_when_different(self, key, val_a, val_b):
        """notEquals returns True when field value differs from condition value."""
        assume(val_a != val_b)
        source_output = {key: val_a}
        condition = {'field': key, 'operator': 'notEquals', 'value': val_b}
        assert evaluate_condition(condition, source_output) is True

    @given(key=field_path_segments, value=json_values)
    @settings(max_examples=100)
    def test_not_equals_false_when_same(self, key, value):
        """notEquals returns False when field value equals condition value."""
        source_output = {key: value}
        condition = {'field': key, 'operator': 'notEquals', 'value': value}
        assert evaluate_condition(condition, source_output) is False

    @given(key=field_path_segments, haystack=st.text(min_size=1, max_size=20))
    @settings(max_examples=100)
    def test_contains_true_when_substring_present(self, key, haystack):
        """contains returns True when condition value is a substring of field value."""
        assume(len(haystack) > 0)
        # Use first char as the needle — guaranteed to be in haystack
        needle = haystack[0]
        source_output = {key: haystack}
        condition = {'field': key, 'operator': 'contains', 'value': needle}
        assert evaluate_condition(condition, source_output) is True

    @given(key=field_path_segments, a=st.integers(min_value=-1000, max_value=998))
    @settings(max_examples=100)
    def test_greater_than_true(self, key, a):
        """greaterThan returns True when field value > condition value."""
        source_output = {key: a + 1}
        condition = {'field': key, 'operator': 'greaterThan', 'value': a}
        assert evaluate_condition(condition, source_output) is True

    @given(key=field_path_segments, a=st.integers(min_value=-1000, max_value=1000))
    @settings(max_examples=100)
    def test_greater_than_false_when_equal(self, key, a):
        """greaterThan returns False when field value == condition value."""
        source_output = {key: a}
        condition = {'field': key, 'operator': 'greaterThan', 'value': a}
        assert evaluate_condition(condition, source_output) is False

    @given(key=field_path_segments, a=st.integers(min_value=-998, max_value=1000))
    @settings(max_examples=100)
    def test_less_than_true(self, key, a):
        """lessThan returns True when field value < condition value."""
        source_output = {key: a - 1}
        condition = {'field': key, 'operator': 'lessThan', 'value': a}
        assert evaluate_condition(condition, source_output) is True

    @given(key=field_path_segments, a=st.integers(min_value=-1000, max_value=1000))
    @settings(max_examples=100)
    def test_less_than_false_when_equal(self, key, a):
        """lessThan returns False when field value == condition value."""
        source_output = {key: a}
        condition = {'field': key, 'operator': 'lessThan', 'value': a}
        assert evaluate_condition(condition, source_output) is False

    def test_unknown_operator_returns_false(self):
        """An unknown operator returns False."""
        condition = {'field': 'x', 'operator': 'unknown', 'value': 1}
        assert evaluate_condition(condition, {'x': 1}) is False

    def test_contains_returns_false_when_field_is_none(self):
        """contains returns False when the field resolves to None."""
        condition = {'field': 'missing', 'operator': 'contains', 'value': 'x'}
        assert evaluate_condition(condition, {}) is False

    def test_greater_than_returns_false_when_field_is_none(self):
        """greaterThan returns False when the field resolves to None."""
        condition = {'field': 'missing', 'operator': 'greaterThan', 'value': 1}
        assert evaluate_condition(condition, {}) is False

    def test_less_than_returns_false_when_field_is_none(self):
        """lessThan returns False when the field resolves to None."""
        condition = {'field': 'missing', 'operator': 'lessThan', 'value': 1}
        assert evaluate_condition(condition, {}) is False
