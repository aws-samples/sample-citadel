"""Unit tests for tools.emf — per-turn CloudWatch EMF emitter (Wave 0).

The emitter writes structured-JSON EMF lines to stdout after each completed
turn. Turn-level metrics ride ONE line; per-tool durations (Tool as a bounded
dimension) are one additional line per distinct tool, because the EMF spec
allows only one value per dimension key per log event. Extraction from the
strands AgentResult (1.30.0: ``result.metrics`` = EventLoopMetrics with
``cycle_count``, ``tool_metrics``, ``accumulated_usage``) is defensive —
missing fields emit nothing and the emitter NEVER raises.
"""
import json
import math


# ── Fakes mirroring the strands 1.30.0 metrics API surface ─────────────────

class FakeToolMetrics:
    """Mirrors strands.telemetry.metrics.ToolMetrics fields used by the emitter."""

    def __init__(self, call_count=0, total_time=0.0):
        self.call_count = call_count
        self.total_time = total_time  # seconds, as in strands


class FakeEventLoopMetrics:
    """Attribute-presence-driven fake: only sets what the test provides."""

    def __init__(self, cycle_count=None, tool_metrics=None, accumulated_usage=None):
        if cycle_count is not None:
            self.cycle_count = cycle_count
        if tool_metrics is not None:
            self.tool_metrics = tool_metrics
        if accumulated_usage is not None:
            self.accumulated_usage = accumulated_usage


class FakeAgentResult:
    def __init__(self, metrics=None):
        if metrics is not None:
            self.metrics = metrics


def _full_result():
    return FakeAgentResult(
        metrics=FakeEventLoopMetrics(
            cycle_count=2,
            tool_metrics={
                "extract_information": FakeToolMetrics(call_count=2, total_time=1.5),
                "get_assessment_summary": FakeToolMetrics(call_count=1, total_time=0.25),
            },
            accumulated_usage={
                "inputTokens": 1000,
                "outputTokens": 200,
                "totalTokens": 1200,
                "cacheReadInputTokens": 800,
                "cacheWriteInputTokens": 100,
            },
        )
    )


def _emf_lines(capsys):
    """Parse every non-empty stdout line as JSON and keep the EMF blobs."""
    out = capsys.readouterr().out
    blobs = []
    for line in out.splitlines():
        line = line.strip()
        if not line:
            continue
        parsed = json.loads(line)  # every stdout line the emitter writes must be JSON
        if "_aws" in parsed:
            blobs.append(parsed)
    return blobs


def _metric_units(blob):
    directive = blob["_aws"]["CloudWatchMetrics"][0]
    return {m["Name"]: m["Unit"] for m in directive["Metrics"]}


class TestTurnLineEnvelope:
    def test_turn_line_has_valid_emf_envelope_and_all_metrics(self, capsys):
        from tools.emf import emit_turn_metrics

        emit_turn_metrics(session_id="sess-1", turn_duration_ms=5000.0, agent_result=_full_result())

        blobs = _emf_lines(capsys)
        turn = blobs[0]
        directive = turn["_aws"]["CloudWatchMetrics"][0]
        assert directive["Namespace"] == "Citadel/Intake"
        assert directive["Dimensions"] == [["Environment"]]
        assert isinstance(turn["_aws"]["Timestamp"], int)

        units = _metric_units(turn)
        assert units == {
            "TurnDuration_ms": "Milliseconds",
            "ModelRoundTrips": "Count",
            "ToolCalls": "Count",
            "InputTokens": "Count",
            "OutputTokens": "Count",
            "CacheReadInputTokens": "Count",
            "CacheWriteInputTokens": "Count",
        }

    def test_metric_values_and_properties_land_at_top_level(self, capsys):
        from tools.emf import emit_turn_metrics

        emit_turn_metrics(session_id="sess-1", turn_duration_ms=5000.0, agent_result=_full_result())

        turn = _emf_lines(capsys)[0]
        assert turn["TurnDuration_ms"] == 5000.0
        assert turn["ModelRoundTrips"] == 2
        assert turn["ToolCalls"] == 3  # 2 + 1 calls
        assert turn["InputTokens"] == 1000
        assert turn["OutputTokens"] == 200
        assert turn["CacheReadInputTokens"] == 800
        assert turn["CacheWriteInputTokens"] == 100
        assert turn["session_id"] == "sess-1"
        assert turn["Environment"] == "dev"  # default when ENVIRONMENT unset

    def test_environment_dimension_from_env(self, capsys, monkeypatch):
        from tools.emf import emit_turn_metrics

        monkeypatch.setenv("ENVIRONMENT", "prod")
        emit_turn_metrics(session_id="s", turn_duration_ms=1.0, agent_result=None)

        assert _emf_lines(capsys)[0]["Environment"] == "prod"


class TestPerToolLines:
    def test_one_extra_line_per_tool_with_bounded_tool_dimension(self, capsys):
        from tools.emf import emit_turn_metrics

        emit_turn_metrics(session_id="sess-1", turn_duration_ms=5000.0, agent_result=_full_result())

        blobs = _emf_lines(capsys)
        assert len(blobs) == 3  # 1 turn line + 2 tool lines
        tool_blobs = blobs[1:]
        durations = {}
        for blob in tool_blobs:
            directive = blob["_aws"]["CloudWatchMetrics"][0]
            assert directive["Namespace"] == "Citadel/Intake"
            assert directive["Dimensions"] == [["Environment", "Tool"]]
            assert _metric_units(blob) == {"ToolDuration_ms": "Milliseconds"}
            assert blob["session_id"] == "sess-1"
            durations[blob["Tool"]] = blob["ToolDuration_ms"]
        assert durations == {
            "extract_information": 1500.0,  # 1.5 s → ms
            "get_assessment_summary": 250.0,
        }

    def test_empty_tool_metrics_reports_zero_calls_and_no_tool_lines(self, capsys):
        from tools.emf import emit_turn_metrics

        result = FakeAgentResult(metrics=FakeEventLoopMetrics(cycle_count=1, tool_metrics={}))
        emit_turn_metrics(session_id="s", turn_duration_ms=100.0, agent_result=result)

        blobs = _emf_lines(capsys)
        assert len(blobs) == 1
        assert blobs[0]["ToolCalls"] == 0


class TestDefensiveExtraction:
    def test_missing_usage_and_tools_emit_nothing_for_them(self, capsys):
        from tools.emf import emit_turn_metrics

        result = FakeAgentResult(metrics=FakeEventLoopMetrics(cycle_count=3))
        emit_turn_metrics(session_id="s", turn_duration_ms=42.0, agent_result=result)

        blobs = _emf_lines(capsys)
        assert len(blobs) == 1
        turn = blobs[0]
        assert turn["ModelRoundTrips"] == 3
        for absent in ("InputTokens", "OutputTokens", "ToolCalls",
                       "CacheReadInputTokens", "CacheWriteInputTokens"):
            assert absent not in turn
            assert absent not in _metric_units(turn)

    def test_cache_tokens_omitted_when_absent_from_usage(self, capsys):
        from tools.emf import emit_turn_metrics

        result = FakeAgentResult(
            metrics=FakeEventLoopMetrics(
                accumulated_usage={"inputTokens": 10, "outputTokens": 5, "totalTokens": 15}
            )
        )
        emit_turn_metrics(session_id="s", turn_duration_ms=42.0, agent_result=result)

        turn = _emf_lines(capsys)[0]
        assert turn["InputTokens"] == 10
        assert turn["OutputTokens"] == 5
        assert "CacheReadInputTokens" not in turn
        assert "CacheWriteInputTokens" not in turn

    def test_none_result_emits_turn_duration_only(self, capsys):
        from tools.emf import emit_turn_metrics

        emit_turn_metrics(session_id="s", turn_duration_ms=123.4, agent_result=None)

        blobs = _emf_lines(capsys)
        assert len(blobs) == 1
        assert _metric_units(blobs[0]) == {"TurnDuration_ms": "Milliseconds"}
        assert blobs[0]["TurnDuration_ms"] == 123.4


class TestNeverRaises:
    def test_hostile_agent_result_does_not_raise_and_turn_line_survives(self, capsys):
        from tools.emf import emit_turn_metrics

        class Hostile:
            @property
            def metrics(self):
                raise RuntimeError("boom")

        emit_turn_metrics(session_id="s", turn_duration_ms=10.0, agent_result=Hostile())

        blobs = _emf_lines(capsys)
        assert len(blobs) == 1
        assert blobs[0]["TurnDuration_ms"] == 10.0

    def test_arbitrary_object_result_does_not_raise(self, capsys):
        from tools.emf import emit_turn_metrics

        emit_turn_metrics(session_id="s", turn_duration_ms=10.0, agent_result=object())

        assert len(_emf_lines(capsys)) == 1

    def test_non_finite_duration_and_no_result_emits_nothing(self, capsys):
        from tools.emf import emit_turn_metrics

        emit_turn_metrics(session_id="s", turn_duration_ms=float("nan"), agent_result=None)
        emit_turn_metrics(session_id="s", turn_duration_ms=math.inf, agent_result=None)

        assert _emf_lines(capsys) == []

    def test_non_numeric_metric_fields_are_skipped(self, capsys):
        from tools.emf import emit_turn_metrics

        result = FakeAgentResult(
            metrics=FakeEventLoopMetrics(
                cycle_count="not-a-number",
                tool_metrics={"tool_a": FakeToolMetrics(call_count=1, total_time="bad")},
                accumulated_usage={"inputTokens": True, "outputTokens": 5},
            )
        )
        emit_turn_metrics(session_id="s", turn_duration_ms=10.0, agent_result=result)

        blobs = _emf_lines(capsys)
        turn = blobs[0]
        assert "ModelRoundTrips" not in turn      # non-int cycle_count skipped
        assert "InputTokens" not in turn          # bool is not a token count
        assert turn["OutputTokens"] == 5
        assert turn["ToolCalls"] == 1             # call_count still valid
        assert len(blobs) == 1                    # bad total_time → no tool line
