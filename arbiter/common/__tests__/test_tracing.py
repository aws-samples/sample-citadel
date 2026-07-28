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
    sys.modules.pop("common.tracing", None)
    yield
    sys.modules.pop("common.tracing", None)


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
