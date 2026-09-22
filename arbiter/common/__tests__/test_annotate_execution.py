"""Tests for `common.tracing.annotate_execution` / `execution_trace_scope`
(finding 40061019, superseding the current-*segment*-first design from
finding 3d92ef6b / CIT-181): in a Lambda invocation
`xray_recorder.current_segment()` is the service-owned `FacadeSegment`,
whose `put_annotation` always raises `FacadeSegmentMutationException`
("FacadeSegment cannot be modified") — so the prior design silently
dropped every annotation in Lambda even though the deploy looked healthy.
Subsegment annotations DO export, so `annotate_execution` now always
targets a subsegment (the current one if open, else a freshly-opened one
that it closes again before returning), and `execution_trace_scope` keeps
one subsegment open for a handler's full duration so nested SDK
subsegments (e.g. patched boto3 calls) attach under it.
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


class _FakeFacadeSegment:
    """Shaped like the real aws_xray_sdk FacadeSegment: put_annotation
    always raises FacadeSegmentMutationException ("FacadeSegment cannot be
    modified"). Used to prove annotate_execution never writes to it, even
    if one were somehow returned by current_subsegment()."""

    def put_annotation(self, key, value):
        from aws_xray_sdk.core.exceptions.exceptions import FacadeSegmentMutationException

        raise FacadeSegmentMutationException("FacadeSegment cannot be modified")


class TestAnnotateExecutionTargetsSubsegment:
    def test_annotates_existing_current_subsegment(self, monkeypatch):
        import common.tracing as tracing_mod

        subsegment = _FakeAnnotatingSegment()
        monkeypatch.setattr(
            "aws_xray_sdk.core.xray_recorder.current_subsegment", lambda: subsegment, raising=False
        )
        begin_calls = []
        monkeypatch.setattr(
            "aws_xray_sdk.core.xray_recorder.begin_subsegment",
            lambda *a, **kw: begin_calls.append((a, kw)),
            raising=False,
        )
        end_calls = []
        monkeypatch.setattr(
            "aws_xray_sdk.core.xray_recorder.end_subsegment",
            lambda *a, **kw: end_calls.append((a, kw)),
            raising=False,
        )

        tracing_mod.annotate_execution(
            run_id="run-1",
            execution_id="exec-1",
            correlation_id="corr-1",
            node_id="node-1",
            workflow_id="wf-1",
        )

        assert subsegment.annotations == {
            "run_id": "run-1",
            "execution_id": "exec-1",
            "correlation_id": "corr-1",
            "node_id": "node-1",
            "workflow_id": "wf-1",
        }
        # An already-open subsegment must not be re-opened/closed.
        assert begin_calls == []
        assert end_calls == []

    def test_opens_and_closes_a_fresh_subsegment_when_none_is_open(self, monkeypatch):
        import common.tracing as tracing_mod

        fresh = _FakeAnnotatingSegment()
        monkeypatch.setattr(
            "aws_xray_sdk.core.xray_recorder.current_subsegment", lambda: None, raising=False
        )
        begin_calls = []

        def _begin(name, *a, **kw):
            begin_calls.append(name)
            return fresh

        monkeypatch.setattr("aws_xray_sdk.core.xray_recorder.begin_subsegment", _begin, raising=False)
        end_calls = []
        monkeypatch.setattr(
            "aws_xray_sdk.core.xray_recorder.end_subsegment",
            lambda *a, **kw: end_calls.append(True),
            raising=False,
        )

        tracing_mod.annotate_execution(execution_id="exec-1", node_id="node-1")

        assert begin_calls == ["citadel.execution"]
        assert fresh.annotations == {"execution_id": "exec-1", "node_id": "node-1"}
        assert end_calls == [True]

    def test_never_annotates_current_segment(self, monkeypatch):
        """Regression guard for finding 40061019: current_segment() must
        never even be consulted by annotate_execution — only subsegments."""
        import common.tracing as tracing_mod

        segment = _FakeAnnotatingSegment()

        def _raise_if_called():
            raise AssertionError("annotate_execution must never call current_segment()")

        monkeypatch.setattr(
            "aws_xray_sdk.core.xray_recorder.current_segment", _raise_if_called, raising=False
        )
        subsegment = _FakeAnnotatingSegment()
        monkeypatch.setattr(
            "aws_xray_sdk.core.xray_recorder.current_subsegment", lambda: subsegment, raising=False
        )

        tracing_mod.annotate_execution(execution_id="exec-1")

        assert subsegment.annotations == {"execution_id": "exec-1"}
        assert segment.annotations == {}


class TestAnnotateExecutionNeverMutatesFacadeSegment:
    def test_facade_segment_shaped_current_subsegment_receives_no_annotations(self, monkeypatch):
        """A FacadeSegment-shaped double whose put_annotation raises must
        receive NO annotations and must not propagate the exception."""
        import common.tracing as tracing_mod

        facade = _FakeFacadeSegment()
        monkeypatch.setattr(
            "aws_xray_sdk.core.xray_recorder.current_subsegment", lambda: facade, raising=False
        )
        monkeypatch.setattr(
            "common.tracing._is_facade_segment", lambda entity: True
        )

        # Must not raise.
        tracing_mod.annotate_execution(execution_id="exec-1", run_id="run-1")

    def test_facade_mutation_exception_is_swallowed_even_if_type_check_misses(self, monkeypatch):
        """Defense in depth: even if _is_facade_segment somehow returns
        False for a facade-shaped object, the raised
        FacadeSegmentMutationException from put_annotation itself must
        still be swallowed (never propagate to the caller)."""
        import common.tracing as tracing_mod

        facade = _FakeFacadeSegment()
        monkeypatch.setattr(
            "aws_xray_sdk.core.xray_recorder.current_subsegment", lambda: facade, raising=False
        )
        monkeypatch.setattr("common.tracing._is_facade_segment", lambda entity: False)

        tracing_mod.annotate_execution(execution_id="exec-1")  # must not raise

    def test_real_facade_segment_type_is_detected(self):
        """_is_facade_segment must recognize the real aws_xray_sdk
        FacadeSegment class (not just a duck-typed double)."""
        import common.tracing as tracing_mod
        from aws_xray_sdk.core.models.facade_segment import FacadeSegment

        facade = FacadeSegment("test", "1234567890abcdef", "1-aaaaaaaa-bbbbbbbbbbbbbbbbbbbbbbbb", True)

        assert tracing_mod._is_facade_segment(facade) is True

    def test_non_facade_segment_is_not_flagged(self, monkeypatch):
        import common.tracing as tracing_mod

        assert tracing_mod._is_facade_segment(_FakeAnnotatingSegment()) is False


class TestAnnotateExecutionOmitsAbsentKeys:
    def test_only_non_empty_values_are_annotated(self, monkeypatch):
        import common.tracing as tracing_mod

        subsegment = _FakeAnnotatingSegment()
        monkeypatch.setattr(
            "aws_xray_sdk.core.xray_recorder.current_subsegment", lambda: subsegment, raising=False
        )

        tracing_mod.annotate_execution(execution_id="exec-1", run_id=None, correlation_id="")

        assert subsegment.annotations == {"execution_id": "exec-1"}

    def test_no_keys_annotated_when_all_absent(self, monkeypatch):
        import common.tracing as tracing_mod

        subsegment = _FakeAnnotatingSegment()
        monkeypatch.setattr(
            "aws_xray_sdk.core.xray_recorder.current_subsegment", lambda: subsegment, raising=False
        )

        tracing_mod.annotate_execution()

        assert subsegment.annotations == {}


class TestAnnotateExecutionNoOpSafety:
    def test_no_op_without_active_subsegment_and_no_segment_to_attach_to(self, monkeypatch):
        """R10-style discipline: no current subsegment AND begin_subsegment
        itself returns None (no active segment to attach a fresh
        subsegment to, e.g. pytest with no X-Ray daemon) must not raise."""
        import common.tracing as tracing_mod

        monkeypatch.setattr(
            "aws_xray_sdk.core.xray_recorder.current_subsegment", lambda: None, raising=False
        )
        monkeypatch.setattr(
            "aws_xray_sdk.core.xray_recorder.begin_subsegment", lambda *a, **kw: None, raising=False
        )

        tracing_mod.annotate_execution(run_id="run-1", execution_id="exec-1")  # must not raise

    def test_no_op_safe_when_recorder_raises(self, monkeypatch):
        """A failure reaching into the recorder (e.g. X-Ray SDK internal
        error) must be swallowed, never break the caller."""
        import common.tracing as tracing_mod

        def _raise():
            raise RuntimeError("boom")

        monkeypatch.setattr(
            "aws_xray_sdk.core.xray_recorder.current_subsegment", _raise, raising=False
        )

        tracing_mod.annotate_execution(execution_id="exec-1")  # must not raise

    def test_no_op_safe_when_put_annotation_raises(self, monkeypatch):
        import common.tracing as tracing_mod

        class _RaisingSegment:
            def put_annotation(self, key, value):
                raise RuntimeError("boom")

        monkeypatch.setattr(
            "aws_xray_sdk.core.xray_recorder.current_subsegment", lambda: _RaisingSegment(), raising=False
        )

        tracing_mod.annotate_execution(execution_id="exec-1")  # must not raise

    def test_respects_aws_xray_sdk_enabled_false(self, monkeypatch):
        monkeypatch.setenv("AWS_XRAY_SDK_ENABLED", "false")
        import common.tracing as tracing_mod

        tracing_mod.annotate_execution(execution_id="exec-1")  # must not raise


class TestExecutionTraceScope:
    def test_annotates_existing_subsegment_and_does_not_open_or_close_one(self, monkeypatch):
        import common.tracing as tracing_mod

        subsegment = _FakeAnnotatingSegment()
        monkeypatch.setattr(
            "aws_xray_sdk.core.xray_recorder.current_subsegment", lambda: subsegment, raising=False
        )
        begin_calls = []
        end_calls = []
        monkeypatch.setattr(
            "aws_xray_sdk.core.xray_recorder.begin_subsegment",
            lambda *a, **kw: begin_calls.append(True),
            raising=False,
        )
        monkeypatch.setattr(
            "aws_xray_sdk.core.xray_recorder.end_subsegment",
            lambda *a, **kw: end_calls.append(True),
            raising=False,
        )

        with tracing_mod.execution_trace_scope(execution_id="exec-1"):
            pass

        assert subsegment.annotations == {"execution_id": "exec-1"}
        assert begin_calls == []
        assert end_calls == []

    def test_opens_a_subsegment_and_ends_it_on_success(self, monkeypatch):
        import common.tracing as tracing_mod

        fresh = _FakeAnnotatingSegment()
        monkeypatch.setattr(
            "aws_xray_sdk.core.xray_recorder.current_subsegment", lambda: None, raising=False
        )
        begin_calls = []

        def _begin(name, *a, **kw):
            begin_calls.append(name)
            return fresh

        monkeypatch.setattr("aws_xray_sdk.core.xray_recorder.begin_subsegment", _begin, raising=False)
        end_calls = []
        monkeypatch.setattr(
            "aws_xray_sdk.core.xray_recorder.end_subsegment",
            lambda *a, **kw: end_calls.append(True),
            raising=False,
        )

        ran = []
        with tracing_mod.execution_trace_scope(execution_id="exec-1", node_id="node-1"):
            ran.append(True)

        assert ran == [True]
        assert begin_calls == ["citadel.execution"]
        assert fresh.annotations == {"execution_id": "exec-1", "node_id": "node-1"}
        assert end_calls == [True]

    def test_ends_the_opened_subsegment_on_exception_and_propagates_it(self, monkeypatch):
        import common.tracing as tracing_mod

        fresh = _FakeAnnotatingSegment()
        monkeypatch.setattr(
            "aws_xray_sdk.core.xray_recorder.current_subsegment", lambda: None, raising=False
        )
        monkeypatch.setattr(
            "aws_xray_sdk.core.xray_recorder.begin_subsegment", lambda *a, **kw: fresh, raising=False
        )
        end_calls = []
        monkeypatch.setattr(
            "aws_xray_sdk.core.xray_recorder.end_subsegment",
            lambda *a, **kw: end_calls.append(True),
            raising=False,
        )

        with pytest.raises(ValueError, match="boom"):
            with tracing_mod.execution_trace_scope(execution_id="exec-1"):
                raise ValueError("boom")

        assert end_calls == [True]

    def test_does_not_end_a_pre_existing_subsegment_on_exception(self, monkeypatch):
        """Only a subsegment the scope itself opened is closed on exit —
        one that was already open before the scope started is left for its
        own owner to close."""
        import common.tracing as tracing_mod

        subsegment = _FakeAnnotatingSegment()
        monkeypatch.setattr(
            "aws_xray_sdk.core.xray_recorder.current_subsegment", lambda: subsegment, raising=False
        )
        end_calls = []
        monkeypatch.setattr(
            "aws_xray_sdk.core.xray_recorder.end_subsegment",
            lambda *a, **kw: end_calls.append(True),
            raising=False,
        )

        with pytest.raises(RuntimeError):
            with tracing_mod.execution_trace_scope(execution_id="exec-1"):
                raise RuntimeError("boom")

        assert end_calls == []

    def test_no_op_safe_end_to_end_with_no_xray_activity(self):
        """No X-Ray daemon/segment at all (plain pytest run) — entering and
        exiting the scope, including on exception, must never raise from
        the tracing machinery itself."""
        import common.tracing as tracing_mod

        with pytest.raises(KeyError):
            with tracing_mod.execution_trace_scope(execution_id="exec-1"):
                raise KeyError("boom")
