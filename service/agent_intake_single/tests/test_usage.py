"""Unit tests for tools.usage — replicated intake-service usage-record helper.

Mirrors the canonical schema in arbiter/common/usage.py (modelId,
inputTokens, outputTokens, latencyMs, callIndex, capturedAt, source) but is
a container-local copy: the intake service is built from a separate
Dockerfile whose build context does not include arbiter/, so this module
must have zero import dependency on it.
"""
import os
import sys

sys.path.insert(0, os.path.join(os.path.dirname(__file__), ".."))

from tools.usage import (
    build_usage_record,
    extract_converse_usage,
    UsageCallCounter,
    SOURCE,
)


class TestBuildUsageRecord:
    def test_source_is_always_intake(self):
        record = build_usage_record(
            model_id="anthropic.claude-sonnet-4-6", input_tokens=10,
            output_tokens=5, latency_ms=100, call_index=0,
        )
        assert record["source"] == "intake"
        assert SOURCE == "intake"

    def test_schema_field_names_match_canonical_arbiter_schema(self):
        record = build_usage_record(
            model_id="m", input_tokens=1, output_tokens=2, latency_ms=3, call_index=4,
        )
        assert set(record.keys()) == {
            "modelId", "inputTokens", "outputTokens", "latencyMs",
            "callIndex", "capturedAt", "source",
        }

    def test_missing_model_id_defaults_to_empty_string(self):
        record = build_usage_record(
            model_id=None, input_tokens=1, output_tokens=1, latency_ms=1, call_index=0,
        )
        assert record["modelId"] == ""

    def test_negative_numeric_inputs_clamp_to_zero(self):
        record = build_usage_record(
            model_id="m", input_tokens=-5, output_tokens=-1, latency_ms=-100, call_index=-1,
        )
        assert record["inputTokens"] == 0
        assert record["outputTokens"] == 0
        assert record["latencyMs"] == 0
        assert record["callIndex"] == 0

    def test_non_numeric_string_input_coerces_to_zero_never_raises(self):
        record = build_usage_record(
            model_id="m", input_tokens="not-a-number", output_tokens=None,
            latency_ms=float("nan"), call_index="3",
        )
        assert record["inputTokens"] == 0
        assert record["outputTokens"] == 0
        assert record["latencyMs"] == 0
        assert record["callIndex"] == 3

    def test_captured_at_defaults_to_iso8601_when_not_supplied(self):
        record = build_usage_record(
            model_id="m", input_tokens=1, output_tokens=1, latency_ms=1, call_index=0,
        )
        # Must be parseable as ISO8601 — round trip via fromisoformat.
        from datetime import datetime
        datetime.fromisoformat(record["capturedAt"])

    def test_explicit_captured_at_is_preserved(self):
        record = build_usage_record(
            model_id="m", input_tokens=1, output_tokens=1, latency_ms=1,
            call_index=0, captured_at="2026-01-01T00:00:00+00:00",
        )
        assert record["capturedAt"] == "2026-01-01T00:00:00+00:00"


class TestExtractConverseUsage:
    def test_extracts_input_and_output_tokens(self):
        resp = {"usage": {"inputTokens": 42, "outputTokens": 7}}
        assert extract_converse_usage(resp) == (42, 7)

    def test_non_dict_response_returns_zero_zero(self):
        assert extract_converse_usage(None) == (0, 0)
        assert extract_converse_usage("not a dict") == (0, 0)
        assert extract_converse_usage([1, 2, 3]) == (0, 0)

    def test_missing_usage_block_returns_zero_zero(self):
        assert extract_converse_usage({"output": {}}) == (0, 0)

    def test_partial_usage_block_defaults_missing_field_to_zero(self):
        assert extract_converse_usage({"usage": {"inputTokens": 10}}) == (10, 0)

    def test_never_raises_on_malformed_usage_value(self):
        resp = {"usage": {"inputTokens": {"nested": "object"}, "outputTokens": []}}
        assert extract_converse_usage(resp) == (0, 0)


class TestUsageCallCounter:
    def test_starts_at_zero_and_increments_monotonically(self):
        counter = UsageCallCounter()
        assert counter.next() == 0
        assert counter.next() == 1
        assert counter.next() == 2

    def test_independent_instances_do_not_share_state(self):
        a = UsageCallCounter()
        b = UsageCallCounter()
        a.next()
        a.next()
        assert b.next() == 0
