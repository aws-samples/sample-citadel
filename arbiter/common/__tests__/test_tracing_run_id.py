"""Red-first tests for runId propagation in the trace-context helpers
(Pass 1, decision f1cbd5ef, design §2 "Carried trace context" row).

`tracing.py` had ZERO run_id references (verify-p1 NEEDS_CHANGES item 4).
This file adds the additive, optional `run_id` plumbing:
  - `extract_carried()` must pass through a `runId` key present on the
    carried `traceContext` dict unchanged (it's a pure extractor, no
    denylist of keys) — asserted explicitly here so a future refactor that
    narrows the extractor's shape doesn't silently drop `runId`.
  - `annotate_from_carried()` gains a `run_id` X-Ray annotation, mirroring
    the existing `correlation_id`/`source_trace_id`/etc. annotations,
    stamped from `carried.get("runId")` when present — no-op when absent,
    matching the no-op-safe discipline of every other key in this
    function.

Imports `common.tracing` (not a bare `tracing`) and reuses the same
autouse module-reload fixture as `test_tracing.py`, so this file shares
the exact module identity/isolation discipline as the rest of the suite
rather than creating a second `sys.modules['tracing']` copy that would
independently re-run the real `patch_all()` side effect and leak process-
global X-Ray recorder state into unrelated tests.
"""
import sys
from unittest.mock import MagicMock, patch

import pytest


@pytest.fixture(autouse=True)
def _reset_tracing_module():
    """Mirror test_tracing.py's fixture: reload common.tracing fresh per
    test so the module-level `_configured` guard (and any other module
    state) doesn't leak between tests in this file or others."""
    original = sys.modules.pop("common.tracing", None)
    yield
    sys.modules.pop("common.tracing", None)
    if original is not None:
        sys.modules["common.tracing"] = original


class TestExtractCarriedPassesThroughRunId:
    def test_run_id_present_on_carried_trace_context_is_preserved(self):
        import common.tracing as tracing_mod

        detail = {"traceContext": {"traceId": "1-abc", "runId": "run-123"}}
        carried = tracing_mod.extract_carried(detail)
        assert carried is not None
        assert carried.get("runId") == "run-123"

    def test_run_id_absent_on_carried_trace_context_stays_absent(self):
        import common.tracing as tracing_mod

        detail = {"traceContext": {"traceId": "1-abc"}}
        carried = tracing_mod.extract_carried(detail)
        assert carried is not None
        assert "runId" not in carried


class TestAnnotateFromCarriedRunId:
    def test_stamps_run_id_annotation_when_present(self, monkeypatch):
        import common.tracing as tracing_mod

        mock_segment = MagicMock()
        mock_recorder = MagicMock()
        mock_recorder.current_subsegment.return_value = mock_segment
        mock_recorder.current_segment.return_value = None
        monkeypatch.setattr("aws_xray_sdk.core.xray_recorder", mock_recorder, raising=True)

        tracing_mod.annotate_from_carried({"runId": "run-456"})

        mock_segment.put_annotation.assert_any_call("run_id", "run-456")

    def test_no_run_id_annotation_when_absent(self, monkeypatch):
        import common.tracing as tracing_mod

        mock_segment = MagicMock()
        mock_recorder = MagicMock()
        mock_recorder.current_subsegment.return_value = mock_segment
        mock_recorder.current_segment.return_value = None
        monkeypatch.setattr("aws_xray_sdk.core.xray_recorder", mock_recorder, raising=True)

        tracing_mod.annotate_from_carried({"correlationId": "corr-1"})

        for call in mock_segment.put_annotation.call_args_list:
            assert call.args[0] != "run_id"

    def test_no_op_safe_when_no_active_segment(self, monkeypatch):
        import common.tracing as tracing_mod

        mock_recorder = MagicMock()
        mock_recorder.current_subsegment.return_value = None
        mock_recorder.current_segment.return_value = None
        monkeypatch.setattr("aws_xray_sdk.core.xray_recorder", mock_recorder, raising=True)

        # Must not raise.
        tracing_mod.annotate_from_carried({"runId": "run-789"})
