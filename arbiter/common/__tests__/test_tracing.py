"""Tests for arbiter/common/tracing.py — X-Ray activation for the Python arbiter.

Architect task 5459301e-1e7b-4bfd-bccb-b106aba2748c, design §1(b)/§6 items
9-11: `configure()` must call `patch_all()` exactly once per process
(idempotent), be import-order-safe, and never raise even when tracing
infrastructure (X-Ray daemon/segment context) is entirely absent — as it
always is under pytest.
"""
import importlib
import sys

import pytest


@pytest.fixture(autouse=True)
def _reset_tracing_module():
    """Reload common.tracing fresh for each test so the module-level
    `_configured` guard doesn't leak state between tests."""
    original = sys.modules.pop("common.tracing", None)
    yield
    sys.modules.pop("common.tracing", None)
    if original is not None:
        sys.modules["common.tracing"] = original


def test_configure_calls_patch_all_exactly_once(monkeypatch):
    import common.tracing as tracing_mod

    call_count = {"n": 0}

    def _fake_patch_all():
        call_count["n"] += 1

    monkeypatch.setattr(
        "aws_xray_sdk.core.patch_all", _fake_patch_all, raising=True
    )

    # Reset the module-level guard set by the import-time side effect so
    # this test controls exactly when configure() runs.
    tracing_mod._configured = False
    tracing_mod.configure()
    tracing_mod.configure()
    tracing_mod.configure()

    assert call_count["n"] == 1, "patch_all() must be called exactly once, even across repeated configure() calls"


def test_import_activates_tracing_as_a_side_effect(monkeypatch):
    """Importing the module (fresh) must call patch_all() once without an
    explicit configure() call — the module-level side effect at the bottom
    of tracing.py."""
    call_count = {"n": 0}

    def _fake_patch_all():
        call_count["n"] += 1

    monkeypatch.setattr(
        "aws_xray_sdk.core.patch_all", _fake_patch_all, raising=True
    )

    sys.modules.pop("common.tracing", None)
    importlib.import_module("common.tracing")

    assert call_count["n"] == 1


def test_configure_is_a_no_op_the_second_time_even_from_a_new_reference(monkeypatch):
    """Two different call sites (e.g. supervisor + workerWrapper both
    importing common.tracing) must not double-patch — configure() must
    detect the already-configured state regardless of caller."""
    import common.tracing as tracing_mod

    call_count = {"n": 0}
    monkeypatch.setattr(
        "aws_xray_sdk.core.patch_all",
        lambda: call_count.__setitem__("n", call_count["n"] + 1),
        raising=True,
    )

    tracing_mod._configured = False
    tracing_mod.configure()
    assert call_count["n"] == 1

    # Simulate a second, independent import site calling configure() again.
    import common.tracing as tracing_mod_again
    tracing_mod_again.configure()
    assert call_count["n"] == 1, "a second caller's configure() must not re-patch"


def test_configure_never_raises_when_patch_all_fails(monkeypatch):
    """A failure inside patch_all() (e.g. an unsupported dependency) must be
    swallowed — tracing activation must never break arbiter dispatch."""
    import common.tracing as tracing_mod

    def _raising_patch_all():
        raise RuntimeError("boom")

    monkeypatch.setattr(
        "aws_xray_sdk.core.patch_all", _raising_patch_all, raising=True
    )

    tracing_mod._configured = False
    tracing_mod.configure()  # must not raise

    assert tracing_mod._configured is True, "the guard must still flip even on failure, to avoid retry storms"


def test_configure_is_no_op_safe_without_xray_daemon_or_segment_context():
    """No-daemon safety: calling configure() (which runs the REAL patch_all())
    in this pytest process — which has no X-Ray daemon and no active
    segment/context — must not raise. This is the concrete proof behind the
    "no-op-safe when running under pytest without daemon" requirement."""
    import common.tracing as tracing_mod

    tracing_mod._configured = False
    tracing_mod.configure()  # real patch_all(), no mocking — must not raise

    assert tracing_mod._configured is True


def test_configure_respects_aws_xray_sdk_enabled_false(monkeypatch):
    """Setting AWS_XRAY_SDK_ENABLED=false must make the underlying
    patch_all() a no-op (per aws_xray_sdk's global_sdk_config), which is
    the documented no-op path for test environments without a daemon.

    `global_sdk_config` is a process-wide singleton that caches its
    enabled/disabled state in a private class attribute on first read, so
    this test resets that cache explicitly (both before and after) to stay
    independent of whatever earlier tests in this module or the wider
    arbiter suite already touched it.
    """
    from aws_xray_sdk import global_sdk_config

    cls = global_sdk_config.__class__
    original_cached_value = cls._SDKConfig__SDK_ENABLED
    try:
        monkeypatch.setenv("AWS_XRAY_SDK_ENABLED", "false")
        cls._SDKConfig__SDK_ENABLED = None  # force re-read from env

        assert global_sdk_config.sdk_enabled() is False

        import common.tracing as tracing_mod
        tracing_mod._configured = False
        tracing_mod.configure()  # must not raise even though patching is disabled

        assert tracing_mod._configured is True
    finally:
        cls._SDKConfig__SDK_ENABLED = original_cached_value


# ---------------------------------------------------------------------------
# Trace-context propagation helpers (architect task f4f4bab3-7a07-4acf-ba43-
# ba43bb488444). No-op-safe without an active segment (R10); malformed
# `extract_carried` input degrades to None (R11); the logging filter injects
# trace_id, absent-safe otherwise (R12).
# ---------------------------------------------------------------------------


def test_r10_active_trace_context_returns_none_without_active_segment():
    """R10: no-op-safe with no active X-Ray segment (the pytest default)."""
    import common.tracing as tracing_mod

    assert tracing_mod.active_trace_context() is None


def test_r10_annotate_from_carried_is_noop_without_active_segment():
    """R10: no-op-safe with no active segment, with or without a carried ctx."""
    import common.tracing as tracing_mod

    tracing_mod.annotate_from_carried(None)  # must not raise
    tracing_mod.annotate_from_carried({"traceId": "1-aaaaaaaa-bbbbbbbbbbbbbbbbbbbbbbbb"})  # must not raise


def test_r10_respects_aws_xray_sdk_enabled_false(monkeypatch):
    """R10: helpers stay no-op-safe when tracing is disabled via env var."""
    monkeypatch.setenv("AWS_XRAY_SDK_ENABLED", "false")
    import common.tracing as tracing_mod

    assert tracing_mod.active_trace_context() is None
    tracing_mod.annotate_from_carried({"correlationId": "exec-1"})  # must not raise


def test_r11_extract_carried_returns_none_for_missing_key():
    import common.tracing as tracing_mod

    assert tracing_mod.extract_carried({}) is None
    assert tracing_mod.extract_carried(None) is None


def test_r11_extract_carried_drops_malformed_non_dict():
    import common.tracing as tracing_mod

    assert tracing_mod.extract_carried({"traceContext": "not-a-dict"}) is None
    assert tracing_mod.extract_carried({"traceContext": 42}) is None
    assert tracing_mod.extract_carried({"traceContext": None}) is None
    assert tracing_mod.extract_carried("not-a-dict-at-all") is None


def test_r11_extract_carried_returns_the_dict_when_well_formed():
    import common.tracing as tracing_mod

    carried = {"traceId": "1-aaaaaaaa-bbbbbbbbbbbbbbbbbbbbbbbb", "parentId": "cccccccccccccccc"}
    assert tracing_mod.extract_carried({"traceContext": carried}) == carried


def test_r12_render_xray_header_from_active_trace_context_shape():
    import common.tracing as tracing_mod

    header = tracing_mod.render_xray_header(
        "1-aaaaaaaa-bbbbbbbbbbbbbbbbbbbbbbbb", "cccccccccccccccc", True
    )
    assert header == "Root=1-aaaaaaaa-bbbbbbbbbbbbbbbbbbbbbbbb;Parent=cccccccccccccccc;Sampled=1"


def test_r12_to_traceparent_round_trips_xray_root():
    import common.tracing as tracing_mod

    result = tracing_mod.to_traceparent(
        "1-aaaaaaaa-bbbbbbbbbbbbbbbbbbbbbbbb", "cccccccccccccccc", True
    )
    assert result == "00-aaaaaaaabbbbbbbbbbbbbbbbbbbbbbbb-cccccccccccccccc-01"


def test_r12_to_traceparent_returns_none_for_malformed_root():
    import common.tracing as tracing_mod

    assert tracing_mod.to_traceparent("not-a-trace-id", "cccccccccccccccc", True) is None


def test_r12_log_filter_injects_trace_id_when_active_segment_present(monkeypatch):
    """R12: the logging.Filter injects trace_id from the active segment."""
    import logging

    import common.tracing as tracing_mod

    class _FakeSegment:
        trace_id = "1-aaaaaaaa-bbbbbbbbbbbbbbbbbbbbbbbb"
        id = "cccccccccccccccc"
        not_traced = False

    monkeypatch.setattr(
        "aws_xray_sdk.core.xray_recorder.current_segment", lambda: _FakeSegment(), raising=False
    )
    monkeypatch.setattr(
        "aws_xray_sdk.core.xray_recorder.current_subsegment", lambda: None, raising=False
    )

    log_filter = tracing_mod.TraceIdLogFilter()
    record = logging.LogRecord("test", logging.INFO, __file__, 1, "msg", None, None)
    assert log_filter.filter(record) is True
    assert record.trace_id == "1-aaaaaaaa-bbbbbbbbbbbbbbbbbbbbbbbb"


def test_r12_log_filter_absent_safe_without_active_segment():
    """R12: absent-safe otherwise — no trace_id attribute, never raises."""
    import logging

    import common.tracing as tracing_mod

    log_filter = tracing_mod.TraceIdLogFilter()
    record = logging.LogRecord("test", logging.INFO, __file__, 1, "msg", None, None)
    assert log_filter.filter(record) is True
    assert getattr(record, "trace_id", None) is None


def test_r12_log_filter_falls_back_to_env_trace_id(monkeypatch):
    """R12: with no active segment, fall back to parsing _X_AMZN_TRACE_ID."""
    import logging

    import common.tracing as tracing_mod

    monkeypatch.setenv(
        "_X_AMZN_TRACE_ID",
        "Root=1-aaaaaaaa-bbbbbbbbbbbbbbbbbbbbbbbb;Parent=cccccccccccccccc;Sampled=1",
    )
    log_filter = tracing_mod.TraceIdLogFilter()
    record = logging.LogRecord("test", logging.INFO, __file__, 1, "msg", None, None)
    log_filter.filter(record)
    assert record.trace_id == "1-aaaaaaaa-bbbbbbbbbbbbbbbbbbbbbbbb"


def test_install_log_filter_is_idempotent_and_never_raises():
    import logging

    import common.tracing as tracing_mod

    logger = logging.getLogger("test-install-log-filter")
    tracing_mod.install_log_filter(logger)
    tracing_mod.install_log_filter(logger)  # must not duplicate or raise
    trace_filters = [f for f in logger.filters if isinstance(f, tracing_mod.TraceIdLogFilter)]
    assert len(trace_filters) == 1


# ---------------------------------------------------------------------------
# Annotation-key contract pinning (design §"Annotation-key contract",
# STABLE — the waterfall-viewer story consumes these literal key names).
# Mirrors the TS-side pinning suite in
# backend/src/utils/__tests__/trace-context.test.ts. Without an assertion on
# the literal strings passed to put_annotation/put_metadata, a silent rename
# would break the waterfall-viewer story with zero test failures anywhere
# else in the Python suite.
# ---------------------------------------------------------------------------
class _FakeAnnotatingSegment:
    def __init__(self):
        self.annotations = {}
        self.metadata = {}

    def put_annotation(self, key, value):
        self.annotations[key] = value

    def put_metadata(self, key, value):
        self.metadata[key] = value


def test_annotate_from_carried_stamps_literal_correlation_id_key(monkeypatch):
    import common.tracing as tracing_mod

    segment = _FakeAnnotatingSegment()
    monkeypatch.setattr(
        "aws_xray_sdk.core.xray_recorder.current_segment", lambda: segment, raising=False
    )
    monkeypatch.setattr(
        "aws_xray_sdk.core.xray_recorder.current_subsegment", lambda: None, raising=False
    )

    tracing_mod.annotate_from_carried({"correlationId": "exec-abc"})
    assert segment.annotations["correlation_id"] == "exec-abc"


def test_annotate_from_carried_stamps_literal_source_trace_id_key(monkeypatch):
    import common.tracing as tracing_mod

    segment = _FakeAnnotatingSegment()
    monkeypatch.setattr(
        "aws_xray_sdk.core.xray_recorder.current_segment", lambda: segment, raising=False
    )
    monkeypatch.setattr(
        "aws_xray_sdk.core.xray_recorder.current_subsegment", lambda: None, raising=False
    )

    tracing_mod.annotate_from_carried({"traceId": "1-aaaaaaaa-bbbbbbbbbbbbbbbbbbbbbbbb"})
    assert segment.annotations["source_trace_id"] == "1-aaaaaaaa-bbbbbbbbbbbbbbbbbbbbbbbb"


def test_annotate_from_carried_stamps_literal_execution_id_key(monkeypatch):
    import common.tracing as tracing_mod

    segment = _FakeAnnotatingSegment()
    monkeypatch.setattr(
        "aws_xray_sdk.core.xray_recorder.current_segment", lambda: segment, raising=False
    )
    monkeypatch.setattr(
        "aws_xray_sdk.core.xray_recorder.current_subsegment", lambda: None, raising=False
    )

    tracing_mod.annotate_from_carried({"executionId": "exec-123"})
    assert segment.annotations["execution_id"] == "exec-123"


def test_annotate_from_carried_stamps_literal_node_id_key(monkeypatch):
    import common.tracing as tracing_mod

    segment = _FakeAnnotatingSegment()
    monkeypatch.setattr(
        "aws_xray_sdk.core.xray_recorder.current_segment", lambda: segment, raising=False
    )
    monkeypatch.setattr(
        "aws_xray_sdk.core.xray_recorder.current_subsegment", lambda: None, raising=False
    )

    tracing_mod.annotate_from_carried({"nodeId": "node-1"})
    assert segment.annotations["node_id"] == "node-1"


def test_annotate_from_carried_stamps_literal_session_id_key(monkeypatch):
    import common.tracing as tracing_mod

    segment = _FakeAnnotatingSegment()
    monkeypatch.setattr(
        "aws_xray_sdk.core.xray_recorder.current_segment", lambda: segment, raising=False
    )
    monkeypatch.setattr(
        "aws_xray_sdk.core.xray_recorder.current_subsegment", lambda: None, raising=False
    )

    tracing_mod.annotate_from_carried({"sessionId": "sess-1"})
    assert segment.annotations["session_id"] == "sess-1"


def test_annotate_from_carried_stamps_literal_trace_context_metadata_namespace(monkeypatch):
    import common.tracing as tracing_mod

    segment = _FakeAnnotatingSegment()
    monkeypatch.setattr(
        "aws_xray_sdk.core.xray_recorder.current_segment", lambda: segment, raising=False
    )
    monkeypatch.setattr(
        "aws_xray_sdk.core.xray_recorder.current_subsegment", lambda: None, raising=False
    )

    carried = {"traceId": "1-aaaaaaaa-bbbbbbbbbbbbbbbbbbbbbbbb"}
    tracing_mod.annotate_from_carried(carried)
    assert segment.metadata["trace_context"] == carried

