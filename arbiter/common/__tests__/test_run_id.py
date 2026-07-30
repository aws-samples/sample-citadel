"""Tests for arbiter/common/run_id.py — run_id mint format/uniqueness and
the build_dispatch_context required-argument guard (Pass 1, decision
f1cbd5ef).
"""
import re

import pytest

from common import run_id as run_id_mod

_RUN_ID_RE = re.compile(
    r"^run-[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$",
    re.IGNORECASE,
)


def test_mint_run_id_produces_run_prefixed_uuid_format():
    value = run_id_mod.mint_run_id()
    assert _RUN_ID_RE.match(value)


def test_mint_run_id_is_greppable_via_run_prefix():
    value = run_id_mod.mint_run_id()
    assert value.startswith("run-")


def test_mint_run_id_produces_unique_values():
    values = {run_id_mod.mint_run_id() for _ in range(100)}
    assert len(values) == 100


def test_build_dispatch_context_includes_required_run_id():
    ctx = run_id_mod.build_dispatch_context(run_id="run-abc", extra="value")
    assert ctx["run_id"] == "run-abc"
    assert ctx["extra"] == "value"


def test_build_dispatch_context_requires_run_id_keyword():
    """Build-time-equivalent guard for Python: omitting run_id raises
    TypeError immediately (no default), mirroring the TS DispatchContext
    type's required `runId` field."""
    with pytest.raises(TypeError):
        run_id_mod.build_dispatch_context(extra="value")  # type: ignore[call-arg]
