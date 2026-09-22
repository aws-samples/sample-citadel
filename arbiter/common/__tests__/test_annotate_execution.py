"""Tests for `common.tracing.annotate_execution` (finding 3d92ef6b / CIT-181):
a live execution's StepRunner/Worker spans carried no
run_id/execution_id/correlation_id annotations because `annotate_from_carried`
only fires on carried-context hops, never on the plain workflow-dispatch
path. `annotate_execution` closes that gap by stamping the handler's own
ids directly onto the CURRENT SEGMENT.
"""
import sys

import pytest


@pytest.fixture(autouse=True)
def _reset_tracing_module():
    """Mirror test_tracing.py's fixture: reload common.tracing fresh per
    test so the module-level `_configured` guard doesn't leak state."""
    original = sys.modules.pop("common.tracing", None)
    yield
    sys.modules.pop("common.tracing", None)
    if original is not None:
        sys.modules["common.tracing"] = original


class _FakeAnnotatingSegment:
    def __init__(self):
        self.annotations = {}

    def put_annotation(self, key, value):
        self.annotations[key] = value


class TestAnnotateExecutionStampsOnCurrentSegment:
    def test_stamps_all_keys_on_current_segment_when_all_present(self, monkeypatch):
        import common.tracing as tracing_mod

        segment = _FakeAnnotatingSegment()
        monkeypatch.setattr(
            "aws_xray_sdk.core.xray_recorder.current_segment", lambda: segment, raising=False
        )
        monkeypatch.setattr(
            "aws_xray_sdk.core.xray_recorder.current_subsegment", lambda: None, raising=False
        )

        tracing_mod.annotate_execution(
            run_id="run-1",
            execution_id="exec-1",
            correlation_id="corr-1",
            node_id="node-1",
            workflow_id="wf-1",
        )

        assert segment.annotations == {
            "run_id": "run-1",
            "execution_id": "exec-1",
            "correlation_id": "corr-1",
            "node_id": "node-1",
            "workflow_id": "wf-1",
        }

    def test_prefers_current_segment_over_subsegment(self, monkeypatch):
        """Unlike annotate_from_carried, annotate_execution must stamp the
        SEGMENT first, falling back to the subsegment only when no segment
        is active."""
        import common.tracing as tracing_mod

        seg_segment = _FakeAnnotatingSegment()
        sub_segment = _FakeAnnotatingSegment()
        monkeypatch.setattr(
            "aws_xray_sdk.core.xray_recorder.current_segment", lambda: seg_segment, raising=False
        )
        monkeypatch.setattr(
            "aws_xray_sdk.core.xray_recorder.current_subsegment", lambda: sub_segment, raising=False
        )

        tracing_mod.annotate_execution(execution_id="exec-1")

        assert seg_segment.annotations == {"execution_id": "exec-1"}
        assert sub_segment.annotations == {}

    def test_falls_back_to_subsegment_when_no_segment_active(self, monkeypatch):
        import common.tracing as tracing_mod

        sub_segment = _FakeAnnotatingSegment()
        monkeypatch.setattr(
            "aws_xray_sdk.core.xray_recorder.current_segment", lambda: None, raising=False
        )
        monkeypatch.setattr(
            "aws_xray_sdk.core.xray_recorder.current_subsegment", lambda: sub_segment, raising=False
        )

        tracing_mod.annotate_execution(execution_id="exec-1", node_id="node-1")

        assert sub_segment.annotations == {"execution_id": "exec-1", "node_id": "node-1"}


class TestAnnotateExecutionOmitsAbsentKeys:
    def test_only_non_empty_values_are_annotated(self, monkeypatch):
        import common.tracing as tracing_mod

        segment = _FakeAnnotatingSegment()
        monkeypatch.setattr(
            "aws_xray_sdk.core.xray_recorder.current_segment", lambda: segment, raising=False
        )
        monkeypatch.setattr(
            "aws_xray_sdk.core.xray_recorder.current_subsegment", lambda: None, raising=False
        )

        tracing_mod.annotate_execution(execution_id="exec-1", run_id=None, correlation_id="")

        assert segment.annotations == {"execution_id": "exec-1"}

    def test_no_keys_annotated_when_all_absent(self, monkeypatch):
        import common.tracing as tracing_mod

        segment = _FakeAnnotatingSegment()
        monkeypatch.setattr(
            "aws_xray_sdk.core.xray_recorder.current_segment", lambda: segment, raising=False
        )
        monkeypatch.setattr(
            "aws_xray_sdk.core.xray_recorder.current_subsegment", lambda: None, raising=False
        )

        tracing_mod.annotate_execution()

        assert segment.annotations == {}


class TestAnnotateExecutionNoOpSafety:
    def test_no_op_without_active_segment_or_subsegment(self):
        """R10-style discipline: no active segment/subsegment (the pytest
        default, no X-Ray daemon) must not raise."""
        import common.tracing as tracing_mod

        tracing_mod.annotate_execution(run_id="run-1", execution_id="exec-1")  # must not raise

    def test_no_op_safe_when_recorder_raises(self, monkeypatch):
        """A failure reaching into the recorder (e.g. X-Ray SDK internal
        error) must be swallowed, never break the caller."""
        import common.tracing as tracing_mod

        def _raise():
            raise RuntimeError("boom")

        monkeypatch.setattr(
            "aws_xray_sdk.core.xray_recorder.current_segment", _raise, raising=False
        )

        tracing_mod.annotate_execution(execution_id="exec-1")  # must not raise

    def test_no_op_safe_when_put_annotation_raises(self, monkeypatch):
        import common.tracing as tracing_mod

        class _RaisingSegment:
            def put_annotation(self, key, value):
                raise RuntimeError("boom")

        monkeypatch.setattr(
            "aws_xray_sdk.core.xray_recorder.current_segment", lambda: _RaisingSegment(), raising=False
        )
        monkeypatch.setattr(
            "aws_xray_sdk.core.xray_recorder.current_subsegment", lambda: None, raising=False
        )

        tracing_mod.annotate_execution(execution_id="exec-1")  # must not raise

    def test_respects_aws_xray_sdk_enabled_false(self, monkeypatch):
        monkeypatch.setenv("AWS_XRAY_SDK_ENABLED", "false")
        import common.tracing as tracing_mod

        tracing_mod.annotate_execution(execution_id="exec-1")  # must not raise
