"""Property-based tests for arbiter/common/usage.py

Exercises the pure usage-record schema and helpers shared by the worker
subprocess capture and the supervisor's converse-call capture: record
construction/validation, Bedrock Converse usage-block extraction, and the
defensive boundary sanitizer used when parsing a usage array coming back
from a subprocess or an event payload.

All helpers here are pure (no I/O, no AWS clients) and must never raise on
malformed input except where explicitly documented (bad ``source`` literal).
"""
from __future__ import annotations

import math

import pytest
from hypothesis import given, settings
from hypothesis import strategies as st

from common.usage import (
    aggregate_usage,
    build_usage_record,
    extract_converse_usage,
    parse_usage_array,
)

# --- Hypothesis strategies ---------------------------------------------------

_valid_sources = st.sampled_from(["worker", "supervisor"])
_invalid_sources = st.text(max_size=20).filter(
    lambda s: s not in ("worker", "supervisor")
)

# Arbitrary token-count inputs: negative ints, floats, None, strings, bools.
_token_ish = st.one_of(
    st.integers(min_value=-1000, max_value=1000),
    st.floats(allow_nan=True, allow_infinity=True, width=32),
    st.none(),
    st.text(max_size=10),
    st.booleans(),
)

_model_ids = st.one_of(st.none(), st.text(max_size=50))


# ---------------------------------------------------------------------------
# build_usage_record
# ---------------------------------------------------------------------------

class TestBuildUsageRecord:
    """Property tests for build_usage_record."""

    @given(source=_valid_sources, call_index=st.integers(min_value=0, max_value=10_000))
    @settings(max_examples=50)
    def test_required_keys_present_with_valid_source(self, source, call_index):
        """A record built with a valid source always carries every required key."""
        record = build_usage_record(
            model_id="some.model",
            input_tokens=10,
            output_tokens=20,
            latency_ms=5,
            call_index=call_index,
            source=source,
        )
        for key in (
            "modelId",
            "inputTokens",
            "outputTokens",
            "latencyMs",
            "callIndex",
            "capturedAt",
            "source",
        ):
            assert key in record, f"missing required key: {key}"
        assert record["source"] == source
        assert record["callIndex"] == call_index
        assert record["callIndex"] >= 0

    @given(
        input_tokens=_token_ish,
        output_tokens=_token_ish,
    )
    @settings(max_examples=100)
    def test_token_counts_always_non_negative_ints(self, input_tokens, output_tokens):
        """Token counts are always coerced/clamped to non-negative ints,
        regardless of negative, float, None, string, or bool input."""
        record = build_usage_record(
            model_id="m",
            input_tokens=input_tokens,
            output_tokens=output_tokens,
            latency_ms=0,
            call_index=0,
            source="worker",
        )
        assert isinstance(record["inputTokens"], int)
        assert isinstance(record["outputTokens"], int)
        assert record["inputTokens"] >= 0
        assert record["outputTokens"] >= 0

    @given(source=_invalid_sources)
    @settings(max_examples=30)
    def test_invalid_source_raises_value_error(self, source):
        """A source outside {'worker','supervisor'} raises ValueError."""
        with pytest.raises(ValueError):
            build_usage_record(
                model_id="m",
                input_tokens=1,
                output_tokens=1,
                latency_ms=1,
                call_index=0,
                source=source,
            )

    def test_missing_model_id_defaults_to_empty_string(self):
        """None/missing modelId becomes '' per schema, not None."""
        record = build_usage_record(
            model_id=None,
            input_tokens=1,
            output_tokens=1,
            latency_ms=1,
            call_index=0,
            source="worker",
        )
        assert record["modelId"] == ""

    def test_captured_at_defaults_to_iso8601_utc_string(self):
        """capturedAt defaults to a non-empty ISO8601 string when not supplied."""
        record = build_usage_record(
            model_id="m",
            input_tokens=1,
            output_tokens=1,
            latency_ms=1,
            call_index=0,
            source="worker",
        )
        assert isinstance(record["capturedAt"], str)
        assert len(record["capturedAt"]) > 0
        # Must be parseable as ISO8601.
        from datetime import datetime
        datetime.fromisoformat(record["capturedAt"].replace("Z", "+00:00"))

    @given(call_index=st.integers(max_value=-1))
    @settings(max_examples=20)
    def test_negative_call_index_clamped_to_zero(self, call_index):
        """callIndex is clamped to >= 0 even if a negative value is supplied."""
        record = build_usage_record(
            model_id="m",
            input_tokens=1,
            output_tokens=1,
            latency_ms=1,
            call_index=call_index,
            source="worker",
        )
        assert record["callIndex"] >= 0


# ---------------------------------------------------------------------------
# extract_converse_usage
# ---------------------------------------------------------------------------

class TestExtractConverseUsage:
    """Property tests for extract_converse_usage."""

    @given(
        input_tokens=st.integers(min_value=0, max_value=100_000),
        output_tokens=st.integers(min_value=0, max_value=100_000),
        total_tokens=st.integers(min_value=0, max_value=200_000),
    )
    @settings(max_examples=50)
    def test_matching_usage_block_returns_matching_ints(
        self, input_tokens, output_tokens, total_tokens
    ):
        """A well-formed Converse response usage block round-trips exactly."""
        resp = {
            "usage": {
                "inputTokens": input_tokens,
                "outputTokens": output_tokens,
                "totalTokens": total_tokens,
            }
        }
        got_in, got_out, got_total = extract_converse_usage(resp)
        assert got_in == input_tokens
        assert got_out == output_tokens
        assert got_total == total_tokens

    def test_missing_usage_block_returns_zeros_and_none(self):
        """No usage key -> (0, 0, None), never raises."""
        assert extract_converse_usage({}) == (0, 0, None)

    def test_none_response_never_raises(self):
        """None response is tolerated defensively."""
        result = extract_converse_usage(None)
        assert result == (0, 0, None)

    @given(garbage=st.one_of(
        st.text(max_size=20),
        st.integers(),
        st.lists(st.integers(), max_size=3),
        st.dictionaries(st.text(max_size=5), st.text(max_size=5), max_size=3),
    ))
    @settings(max_examples=50)
    def test_arbitrary_garbage_never_raises(self, garbage):
        """Arbitrary non-conforming input never raises."""
        result = extract_converse_usage(garbage)
        assert isinstance(result, tuple) and len(result) == 3


# ---------------------------------------------------------------------------
# parse_usage_array
# ---------------------------------------------------------------------------

class TestParseUsageArray:
    """Property tests for parse_usage_array — boundary sanitizer."""

    @given(raw=st.one_of(
        st.none(),
        st.text(max_size=30),
        st.integers(),
        st.dictionaries(st.text(max_size=5), st.text(max_size=5), max_size=3),
        st.lists(st.one_of(
            st.dictionaries(st.text(max_size=10), st.text(max_size=10), max_size=5),
            st.integers(),
            st.text(max_size=10),
            st.none(),
        ), max_size=10),
    ))
    @settings(max_examples=100)
    def test_never_raises_on_arbitrary_input(self, raw):
        """parse_usage_array must never raise regardless of input shape."""
        result = parse_usage_array(raw)
        assert isinstance(result, list)

    def test_non_list_input_returns_empty_list(self):
        """A non-list top-level value returns an empty list rather than raising."""
        assert parse_usage_array("not-a-list") == []
        assert parse_usage_array(None) == []
        assert parse_usage_array(42) == []

    def test_list_of_dicts_passes_through(self):
        """A list of well-formed dict records passes through as dicts."""
        records = [
            {"modelId": "m", "inputTokens": 1, "outputTokens": 2,
             "latencyMs": 3, "callIndex": 0, "capturedAt": "2024-01-01T00:00:00Z",
             "source": "worker"},
        ]
        result = parse_usage_array(records)
        assert result == records

    def test_non_dict_entries_are_dropped(self):
        """Non-dict entries in the list are dropped, not raised on."""
        result = parse_usage_array([{"a": 1}, "garbage", 42, None, {"b": 2}])
        assert result == [{"a": 1}, {"b": 2}]


# ---------------------------------------------------------------------------
# aggregate_usage
# ---------------------------------------------------------------------------

class TestAggregateUsage:
    """Property tests for aggregate_usage — pure per-node usage rollup."""

    @given(raw=st.one_of(
        st.none(),
        st.text(max_size=30),
        st.integers(),
        st.dictionaries(st.text(max_size=5), st.text(max_size=5), max_size=3),
        st.lists(st.one_of(
            st.dictionaries(st.text(max_size=10), st.text(max_size=10), max_size=5),
            st.integers(),
            st.text(max_size=10),
            st.none(),
        ), max_size=10),
    ))
    @settings(max_examples=100)
    def test_never_raises_on_arbitrary_input(self, raw):
        """aggregate_usage must never raise regardless of input shape."""
        result = aggregate_usage(raw)
        assert isinstance(result, dict)
        for key in ("inputTokens", "outputTokens", "totalTokens", "callCount"):
            assert key in result

    def test_empty_input_returns_all_zeros(self):
        """No records -> every total is zero, never raises."""
        assert aggregate_usage([]) == {
            "inputTokens": 0,
            "outputTokens": 0,
            "totalTokens": 0,
            "callCount": 0,
        }
        assert aggregate_usage(None) == {
            "inputTokens": 0,
            "outputTokens": 0,
            "totalTokens": 0,
            "callCount": 0,
        }

    @given(
        records=st.lists(
            st.fixed_dictionaries({
                "inputTokens": st.integers(min_value=0, max_value=10_000),
                "outputTokens": st.integers(min_value=0, max_value=10_000),
            }),
            max_size=10,
        ),
    )
    @settings(max_examples=100)
    def test_totals_equal_sum_of_inputs_and_outputs(self, records):
        """totalTokens is always inputTokens + outputTokens; callCount == len(records)."""
        result = aggregate_usage(records)
        expected_in = sum(r["inputTokens"] for r in records)
        expected_out = sum(r["outputTokens"] for r in records)
        assert result["inputTokens"] == expected_in
        assert result["outputTokens"] == expected_out
        assert result["totalTokens"] == expected_in + expected_out
        assert result["callCount"] == len(records)

    def test_garbage_entries_dropped_before_summing(self):
        """Non-dict entries in the raw list are dropped, not summed as zero."""
        records = [
            {"inputTokens": 5, "outputTokens": 10},
            "garbage",
            42,
            None,
            {"inputTokens": 3, "outputTokens": 2},
        ]
        result = aggregate_usage(records)
        assert result == {
            "inputTokens": 8,
            "outputTokens": 12,
            "totalTokens": 20,
            "callCount": 2,
        }

    def test_missing_or_malformed_token_fields_coerce_to_zero(self):
        """A record missing inputTokens/outputTokens (or with malformed values)
        contributes 0 for that field rather than raising."""
        records = [
            {"inputTokens": "not-a-number", "outputTokens": None},
            {"outputTokens": 7},
        ]
        result = aggregate_usage(records)
        assert result == {
            "inputTokens": 0,
            "outputTokens": 7,
            "totalTokens": 7,
            "callCount": 2,
        }
