"""Tests for worker-envelope unwrapping in condition.resolve_field_path.

Validates:
  - The exact live output from execution 6aa77c01 resolves result.route
    correctly (the primary regression this fix addresses).
  - Non-JSON response strings produce reason='output_not_json'.
  - Nested paths resolve through the unwrapped inner object.
  - Fallback to raw envelope keys (response, usage) still works.
  - Legacy outputs without a worker envelope are unchanged.
  - Hypothesis: for random dicts D, wrapping in envelope{response:
    json.dumps(D)} resolves every top-level key of D identically to D.
"""

import sys
import os
import json

sys.path.insert(0, os.path.join(os.path.dirname(__file__), '..'))

from hypothesis import given, settings, assume
from hypothesis import strategies as st

from condition import (
    evaluate_condition,
    resolve_field_path,
    diagnose_resolution_failure,
    _is_worker_envelope,
    _unwrap_envelope,
)


# ---------------------------------------------------------------------------
# Exact live fixture: execution 6aa77c01
# ---------------------------------------------------------------------------

LIVE_ENVELOPE = {"response": "{\"route\": \"branch-a\"}", "usage": []}


class TestLiveEnvelopeFixture:
    """The exact node output observed in execution 6aa77c01."""

    def test_result_route_resolves_to_branch_a(self):
        """result.route resolves to 'branch-a' through the envelope."""
        assert resolve_field_path(LIVE_ENVELOPE, 'result.route') == 'branch-a'

    def test_condition_equals_branch_a_matches(self):
        """evaluate_condition matches the live condition."""
        cond = {'field': 'result.route', 'operator': 'equals', 'value': 'branch-a'}
        assert evaluate_condition(cond, LIVE_ENVELOPE) is True

    def test_condition_equals_branch_b_does_not_match(self):
        """evaluate_condition rejects a non-matching value."""
        cond = {'field': 'result.route', 'operator': 'equals', 'value': 'branch-b'}
        assert evaluate_condition(cond, LIVE_ENVELOPE) is False

    def test_result_route_exists(self):
        """exists operator confirms result.route is present."""
        cond = {'field': 'result.route', 'operator': 'exists', 'value': None}
        assert evaluate_condition(cond, LIVE_ENVELOPE) is True


# ---------------------------------------------------------------------------
# Non-JSON response string
# ---------------------------------------------------------------------------

class TestNonJsonResponseString:
    """When the worker response is not valid JSON."""

    def test_result_field_returns_none(self):
        """result.route returns None when response is not JSON."""
        output = {"response": "I am a plain text answer", "usage": []}
        assert resolve_field_path(output, 'result.route') is None

    def test_diagnose_returns_output_not_json(self):
        """Diagnosis returns output_not_json for non-JSON response."""
        output = {"response": "I am a plain text answer", "usage": []}
        assert diagnose_resolution_failure(output, 'result.route') == 'output_not_json'

    def test_python_repr_returns_none(self):
        """Python repr string (not valid JSON) returns None."""
        output = {"response": "{'route': 'branch-a'}", "usage": []}
        assert resolve_field_path(output, 'result.route') is None

    def test_python_repr_diagnose_output_not_json(self):
        """Python repr diagnosed as output_not_json."""
        output = {"response": "{'route': 'branch-a'}", "usage": []}
        assert diagnose_resolution_failure(output, 'result.route') == 'output_not_json'


# ---------------------------------------------------------------------------
# Nested path through unwrapped envelope
# ---------------------------------------------------------------------------

class TestNestedPathEnvelope:
    """Paths with more than one segment after result. resolve through
    the unwrapped inner object."""

    def test_nested_path_resolves(self):
        """result.data.status resolves through nested inner object."""
        inner = {"data": {"status": "ok"}}
        output = {"response": json.dumps(inner), "usage": []}
        assert resolve_field_path(output, 'result.data.status') == 'ok'

    def test_deeply_nested_path(self):
        """result.a.b.c resolves three levels deep."""
        inner = {"a": {"b": {"c": 42}}}
        output = {"response": json.dumps(inner), "usage": []}
        assert resolve_field_path(output, 'result.a.b.c') == 42


# ---------------------------------------------------------------------------
# Fallback to raw envelope keys
# ---------------------------------------------------------------------------

class TestFallbackToEnvelopeKeys:
    """Explicit envelope references still resolve when they are not in
    the inner object."""

    def test_response_dot_route_still_works(self):
        """response.route resolves via JSON auto-parse of envelope key."""
        output = {"response": json.dumps({"route": "branch-a"}), "usage": []}
        assert resolve_field_path(output, 'response.route') == 'branch-a'

    def test_usage_resolves_to_envelope_usage(self):
        """usage resolves to the envelope's usage array."""
        output = {"response": json.dumps({"route": "x"}), "usage": [{"inputTokens": 5}]}
        assert resolve_field_path(output, 'usage') == [{"inputTokens": 5}]

    def test_response_key_returns_raw_string_when_no_sub_path(self):
        """Bare 'response' against the envelope returns the raw string
        (no sub-path to traverse into)."""
        output = {"response": json.dumps({"route": "x"}), "usage": []}
        # Full path 'response' against inner {"route":"x"} fails (no 'response' key),
        # so fallback to raw envelope returns the JSON string.
        assert resolve_field_path(output, 'response') == json.dumps({"route": "x"})

    def test_result_response_key_via_inner_with_response_key(self):
        """When the inner object itself contains a 'result' key, the full
        path resolves there first (precedence 1)."""
        inner = {"result": {"value": 99}}
        output = {"response": json.dumps(inner), "usage": []}
        assert resolve_field_path(output, 'result.value') == 99


# ---------------------------------------------------------------------------
# Legacy outputs without worker envelope
# ---------------------------------------------------------------------------

class TestLegacyOutputsUnchanged:
    """Outputs that do not match the worker-envelope shape resolve
    exactly as before."""

    def test_dict_with_result_key(self):
        """Legacy output with an explicit result key resolves normally."""
        output = {"result": {"route": "branch-a"}}
        assert resolve_field_path(output, 'result.route') == 'branch-a'

    def test_flat_dict(self):
        """A flat dict with the target key resolves normally."""
        output = {"status": "ok"}
        assert resolve_field_path(output, 'status') == 'ok'

    def test_dict_with_extra_keys_not_envelope(self):
        """A dict with response AND extra keys is not treated as an envelope."""
        output = {"response": json.dumps({"route": "a"}), "usage": [], "extra": True}
        # Not an envelope (has 'extra'), so result.route falls through to raw
        assert resolve_field_path(output, 'result.route') is None
        # But response.route still works via JSON auto-parse
        assert resolve_field_path(output, 'response.route') == 'a'

    def test_empty_dict(self):
        """Empty dict returns None for any path."""
        assert resolve_field_path({}, 'result.route') is None

    def test_dict_with_result_status(self):
        """Legacy output with result.status resolves normally."""
        output = {"result": {"status": "approved"}}
        assert resolve_field_path(output, 'result.status') == 'approved'


# ---------------------------------------------------------------------------
# Envelope detection helpers
# ---------------------------------------------------------------------------

class TestEnvelopeDetection:
    """_is_worker_envelope and _unwrap_envelope behave correctly."""

    def test_minimal_envelope(self):
        """response-only dict is an envelope."""
        assert _is_worker_envelope({"response": "x"}) is True

    def test_full_envelope(self):
        """response+usage dict is an envelope."""
        assert _is_worker_envelope({"response": "x", "usage": []}) is True

    def test_extra_key_not_envelope(self):
        """Dict with an extra key is NOT an envelope."""
        assert _is_worker_envelope({"response": "x", "usage": [], "extra": 1}) is False

    def test_no_response_not_envelope(self):
        """Dict without response key is NOT an envelope."""
        assert _is_worker_envelope({"result": {"route": "a"}}) is False

    def test_non_dict_not_envelope(self):
        """Non-dict is not an envelope."""
        assert _is_worker_envelope("string") is False

    def test_unwrap_json_string(self):
        """Unwrap parses a JSON string response."""
        envelope = {"response": json.dumps({"k": "v"}), "usage": []}
        assert _unwrap_envelope(envelope) == {"k": "v"}

    def test_unwrap_dict_response(self):
        """Unwrap returns a dict response as-is."""
        envelope = {"response": {"k": "v"}, "usage": []}
        assert _unwrap_envelope(envelope) == {"k": "v"}

    def test_unwrap_non_json_returns_none(self):
        """Unwrap returns None for non-JSON string response."""
        envelope = {"response": "not json", "usage": []}
        assert _unwrap_envelope(envelope) is None

    def test_unwrap_json_array_returns_none(self):
        """Unwrap returns None for a JSON array (not a dict)."""
        envelope = {"response": json.dumps([1, 2, 3]), "usage": []}
        assert _unwrap_envelope(envelope) is None


# ---------------------------------------------------------------------------
# Hypothesis: envelope equivalence property
# ---------------------------------------------------------------------------

# Strategy: JSON-serialisable flat dicts with safe keys (no dots, so
# single-segment paths resolve unambiguously).
json_values = st.one_of(
    st.integers(min_value=-1000, max_value=1000),
    st.text(min_size=0, max_size=20),
    st.booleans(),
)

safe_keys = st.text(
    min_size=1, max_size=10,
    alphabet=st.characters(whitelist_categories=('L', 'N')),
)

flat_dicts = st.dictionaries(
    keys=safe_keys,
    values=json_values,
    min_size=1,
    max_size=5,
)


class TestEnvelopeEquivalenceProperty:
    """For random dicts D, envelope{response: json.dumps(D)} resolves
    every top-level key of D identically to D."""

    @given(d=flat_dicts)
    @settings(max_examples=200)
    def test_every_top_level_key_resolves_identically(self, d):
        """resolve_field_path(envelope, key) == resolve_field_path(d, key)
        for every top-level key of D."""
        envelope = {"response": json.dumps(d), "usage": []}
        for key in d:
            # Skip keys that collide with envelope keys to avoid
            # ambiguity (the envelope's own 'response'/'usage' take
            # precedence at the raw level, but the inner object takes
            # precedence at the unwrapped level).
            if key in ('response', 'usage', 'result'):
                continue
            actual_from_envelope = resolve_field_path(envelope, key)
            actual_from_dict = resolve_field_path(d, key)
            assert actual_from_envelope == actual_from_dict, (
                f"key={key!r}: envelope gave {actual_from_envelope!r}, "
                f"dict gave {actual_from_dict!r}"
            )
