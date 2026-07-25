"""Unit tests for tools.state.publish_usage_event — additive EventBridge
usage event, distinct from the existing agent_intake.<phase> progress
namespace so existing consumers stay unbroken.
"""
import json
import os
import sys
from unittest import mock

sys.path.insert(0, os.path.join(os.path.dirname(__file__), ".."))


class TestPublishUsageEvent:
    def test_publishes_new_source_and_detail_type(self, monkeypatch):
        import tools.state as state

        client = mock.MagicMock()
        monkeypatch.setattr(state, "events_client", client)
        monkeypatch.setattr(state, "EVENT_BUS_NAME", "test-bus")

        record = {
            "modelId": "m", "inputTokens": 1, "outputTokens": 2,
            "latencyMs": 3, "callIndex": 0, "capturedAt": "2026-01-01T00:00:00+00:00",
            "source": "intake",
        }
        state.publish_usage_event("sess-1", record)

        assert client.put_events.call_count == 1
        entry = client.put_events.call_args.kwargs["Entries"][0]
        assert entry["Source"] == "agent_intake.usage"
        assert entry["DetailType"] == "intake.usage.captured"
        assert entry["EventBusName"] == "test-bus"

    def test_detail_includes_session_project_correlation_and_usage_fields(self, monkeypatch):
        import tools.state as state

        client = mock.MagicMock()
        monkeypatch.setattr(state, "events_client", client)
        monkeypatch.setattr(state, "EVENT_BUS_NAME", "test-bus")

        record = {
            "modelId": "m", "inputTokens": 1, "outputTokens": 2,
            "latencyMs": 3, "callIndex": 0, "capturedAt": "2026-01-01T00:00:00+00:00",
            "source": "intake",
        }
        state.publish_usage_event("sess-2", record)

        detail = json.loads(client.put_events.call_args.kwargs["Entries"][0]["Detail"])
        assert detail["sessionId"] == "sess-2"
        assert detail["projectId"] == "sess-2"
        assert "correlationId" in detail and detail["correlationId"]
        assert detail["modelId"] == "m"
        assert detail["inputTokens"] == 1
        assert detail["source"] == "intake"

    def test_does_not_publish_when_event_bus_unset(self, monkeypatch):
        import tools.state as state

        client = mock.MagicMock()
        monkeypatch.setattr(state, "events_client", client)
        monkeypatch.setattr(state, "EVENT_BUS_NAME", "")

        state.publish_usage_event("sess-3", {"source": "intake"})
        client.put_events.assert_not_called()

    def test_eventbridge_failure_is_logged_and_swallowed_never_raised(self, monkeypatch):
        import tools.state as state

        client = mock.MagicMock()
        client.put_events.side_effect = RuntimeError("boom")
        monkeypatch.setattr(state, "events_client", client)
        monkeypatch.setattr(state, "EVENT_BUS_NAME", "test-bus")

        # Must not raise.
        state.publish_usage_event("sess-4", {"source": "intake"})

    def test_existing_progress_event_source_and_shape_unchanged(self, monkeypatch):
        """Additive-only guarantee: the pre-existing agent_intake.<phase>
        progress event must be untouched by the new usage event path."""
        import tools.state as state

        client = mock.MagicMock()
        monkeypatch.setattr(state, "events_client", client)
        monkeypatch.setattr(state, "EVENT_BUS_NAME", "test-bus")

        state._publish_event("design", "sess-5", 50, "half done")

        entry = client.put_events.call_args.kwargs["Entries"][0]
        assert entry["Source"] == "agent_intake.design"
        assert entry["DetailType"] == "intake.progress.updated"
        detail = json.loads(entry["Detail"])
        assert set(detail.keys()) == {
            "sessionId", "phase", "completionPercentage", "changeSummary", "timestamp",
        }
