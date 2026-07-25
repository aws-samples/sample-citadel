"""Unit tests for tools.emf.capture_turn_usage — per-turn usage capture for
the strands conversational loop (agent.py's Agent.stream_async path).

Reuses the same defensive AgentResult.metrics.accumulated_usage extraction
seam as emit_turn_metrics rather than adding a second parallel hook.
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


class TestCaptureTurnUsage:
    def test_publishes_usage_record_with_accumulated_tokens(self, monkeypatch):
        import tools.emf as emf

        published = []
        monkeypatch.setattr("tools.state.publish_usage_event", lambda sid, rec: published.append((sid, rec)))

        result = FakeAgentResult(FakeEventLoopMetrics(
            accumulated_usage={"inputTokens": 100, "outputTokens": 40, "totalTokens": 140},
        ))
        emf.capture_turn_usage("sess-1", turn_duration_ms=250.0, agent_result=result)

        assert len(published) == 1
        session_id, record = published[0]
        assert session_id == "sess-1"
        assert record["inputTokens"] == 100
        assert record["outputTokens"] == 40
        assert record["source"] == "intake"
        assert record["latencyMs"] == 250

    def test_no_result_event_publishes_nothing(self, monkeypatch):
        import tools.emf as emf

        published = []
        monkeypatch.setattr("tools.state.publish_usage_event", lambda sid, rec: published.append((sid, rec)))

        emf.capture_turn_usage("sess-2", turn_duration_ms=10.0, agent_result=None)
        assert published == []

    def test_result_without_usage_publishes_nothing(self, monkeypatch):
        import tools.emf as emf

        published = []
        monkeypatch.setattr("tools.state.publish_usage_event", lambda sid, rec: published.append((sid, rec)))

        result = FakeAgentResult(FakeEventLoopMetrics(accumulated_usage=None))
        emf.capture_turn_usage("sess-3", turn_duration_ms=10.0, agent_result=result)
        assert published == []

    def test_publish_failure_never_raises(self, monkeypatch):
        import tools.emf as emf

        def _boom(sid, rec):
            raise RuntimeError("EventBridge down")

        monkeypatch.setattr("tools.state.publish_usage_event", _boom)

        result = FakeAgentResult(FakeEventLoopMetrics(
            accumulated_usage={"inputTokens": 5, "outputTokens": 5},
        ))
        # Must not raise.
        emf.capture_turn_usage("sess-4", turn_duration_ms=10.0, agent_result=result)

    def test_malformed_metrics_never_raises(self, monkeypatch):
        import tools.emf as emf

        monkeypatch.setattr("tools.state.publish_usage_event", lambda sid, rec: None)
        # metrics attribute deliberately absent
        emf.capture_turn_usage("sess-5", turn_duration_ms=10.0, agent_result=object())
