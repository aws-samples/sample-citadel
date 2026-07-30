"""Unit tests for run_id threading through tools.state's EventBridge publish
paths (Pass 1, decision f1cbd5ef) — additive, optional, nullable: identical
contract shape to the traceContext tests in test_state_usage_event.py.
"""
import json
import os
import sys
from unittest import mock

sys.path.insert(0, os.path.join(os.path.dirname(__file__), ".."))


class TestPublishUsageEventRunId:
    def test_includes_run_id_when_provided(self, monkeypatch):
        import tools.state as state

        client = mock.MagicMock()
        monkeypatch.setattr(state, "events_client", client)
        monkeypatch.setattr(state, "EVENT_BUS_NAME", "test-bus")

        state.publish_usage_event("sess-1", {"source": "intake"}, run_id="run-abc123")

        detail = json.loads(client.put_events.call_args.kwargs["Entries"][0]["Detail"])
        assert detail["runId"] == "run-abc123"

    def test_omits_run_id_when_absent_byte_identical_to_pre_feature(self, monkeypatch):
        import tools.state as state

        client = mock.MagicMock()
        monkeypatch.setattr(state, "events_client", client)
        monkeypatch.setattr(state, "EVENT_BUS_NAME", "test-bus")

        state.publish_usage_event("sess-2", {"source": "intake"})

        detail = json.loads(client.put_events.call_args.kwargs["Entries"][0]["Detail"])
        assert "runId" not in detail

    def test_run_id_never_gates_publish_when_it_fails_to_thread(self, monkeypatch):
        """Best-effort discipline: passing a malformed run_id must never
        raise or block the underlying usage-record publish."""
        import tools.state as state

        client = mock.MagicMock()
        monkeypatch.setattr(state, "events_client", client)
        monkeypatch.setattr(state, "EVENT_BUS_NAME", "test-bus")

        # Non-string run_id — must not raise; publish still happens.
        state.publish_usage_event("sess-3", {"source": "intake"}, run_id=None)
        assert client.put_events.call_count == 1


class TestInternalUpdateProgressRunId:
    def test_publish_event_includes_run_id_when_provided(self, monkeypatch):
        import tools.state as state

        client = mock.MagicMock()
        monkeypatch.setattr(state, "events_client", client)
        monkeypatch.setattr(state, "EVENT_BUS_NAME", "test-bus")

        state._publish_event("design", "sess-4", 50, "half done", run_id="run-xyz789")

        detail = json.loads(client.put_events.call_args.kwargs["Entries"][0]["Detail"])
        assert detail["runId"] == "run-xyz789"

    def test_publish_event_omits_run_id_when_absent(self, monkeypatch):
        import tools.state as state

        client = mock.MagicMock()
        monkeypatch.setattr(state, "events_client", client)
        monkeypatch.setattr(state, "EVENT_BUS_NAME", "test-bus")

        state._publish_event("design", "sess-5", 50, "half done")

        entry = client.put_events.call_args.kwargs["Entries"][0]
        detail = json.loads(entry["Detail"])
        assert "runId" not in detail
        # Byte-identical to the pre-feature exact-keys assertion in
        # test_state_usage_event.py.
        assert set(detail.keys()) == {
            "sessionId", "phase", "completionPercentage", "changeSummary", "timestamp",
        }

    def test_internal_update_progress_threads_run_id_through(self, monkeypatch):
        import tools.state as state

        client = mock.MagicMock()
        monkeypatch.setattr(state, "events_client", client)
        monkeypatch.setattr(state, "EVENT_BUS_NAME", "test-bus")
        monkeypatch.setattr(state, "_table", lambda: mock.MagicMock())

        state._internal_update_progress(
            "sess-6", "design", 50, "half done", run_id="run-through",
        )

        detail = json.loads(client.put_events.call_args.kwargs["Entries"][0]["Detail"])
        assert detail["runId"] == "run-through"
