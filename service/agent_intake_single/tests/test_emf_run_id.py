"""Unit tests for run_id threading through tools.emf.capture_turn_usage
(Pass 1, decision f1cbd5ef) — additive, optional keyword argument forwarded
to publish_usage_event.
"""
import os
import sys

sys.path.insert(0, os.path.join(os.path.dirname(__file__), ".."))


class FakeEventLoopMetrics:
    def __init__(self, accumulated_usage=None, cycle_count=1, tool_metrics=None):
        self.cycle_count = cycle_count
        self.tool_metrics = tool_metrics or {}
        if accumulated_usage is not None:
            self.accumulated_usage = accumulated_usage


class FakeAgentResult:
    def __init__(self, metrics=None):
        if metrics is not None:
            self.metrics = metrics


class TestCaptureTurnUsageRunId:
    def test_forwards_run_id_to_publish_usage_event(self, monkeypatch):
        import tools.emf as emf

        captured_kwargs = {}

        def _capture(sid, rec, **kwargs):
            captured_kwargs.update(kwargs)

        monkeypatch.setattr("tools.state.publish_usage_event", _capture)

        result = FakeAgentResult(FakeEventLoopMetrics(
            accumulated_usage={"inputTokens": 100, "outputTokens": 40},
        ))
        emf.capture_turn_usage(
            "sess-1", turn_duration_ms=250.0, agent_result=result, run_id="run-abc",
        )

        assert captured_kwargs.get("run_id") == "run-abc"

    def test_existing_two_positional_arg_callers_unaffected(self, monkeypatch):
        """Backwards-compat: a caller that never passes run_id must behave
        byte-identically to the pre-runId code path."""
        import tools.emf as emf

        published = []
        monkeypatch.setattr(
            "tools.state.publish_usage_event",
            lambda sid, rec: published.append((sid, rec)),
        )

        result = FakeAgentResult(FakeEventLoopMetrics(
            accumulated_usage={"inputTokens": 5, "outputTokens": 5},
        ))
        # No run_id supplied — must not raise, must still publish.
        emf.capture_turn_usage("sess-2", turn_duration_ms=10.0, agent_result=result)
        assert len(published) == 1

    def test_run_id_omitted_when_absent(self, monkeypatch):
        import tools.emf as emf

        captured_kwargs = {"called": False}

        def _capture(sid, rec, **kwargs):
            captured_kwargs["called"] = True
            captured_kwargs.update(kwargs)

        monkeypatch.setattr("tools.state.publish_usage_event", _capture)

        result = FakeAgentResult(FakeEventLoopMetrics(
            accumulated_usage={"inputTokens": 5, "outputTokens": 5},
        ))
        emf.capture_turn_usage("sess-3", turn_duration_ms=10.0, agent_result=result)

        assert captured_kwargs["called"] is True
        assert "run_id" not in captured_kwargs
