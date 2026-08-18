"""Tests for the canary attribution fields on
``arbiter/common/usage.py::build_usage_record`` (decision D2).

release_id / release_arm are additive and omit-when-absent, exactly like
totalTokens / bedrockRequestId — a caller with no canary context produces
a byte-identical (pre-canary) usage row.
"""
from __future__ import annotations

import os
import sys

_PROJECT_ROOT = os.path.abspath(
    os.path.join(os.path.dirname(__file__), "..", "..", "..")
)
if _PROJECT_ROOT not in sys.path:
    sys.path.insert(0, _PROJECT_ROOT)

from arbiter.common.usage import build_usage_record  # noqa: E402


def _base(**kw):
    return build_usage_record(
        model_id="m",
        input_tokens=1,
        output_tokens=2,
        latency_ms=3,
        call_index=0,
        source="worker",
        **kw,
    )


def test_omits_canary_fields_when_absent() -> None:
    rec = _base()
    assert "releaseId" not in rec
    assert "releaseArm" not in rec


def test_includes_release_id_and_arm_when_supplied() -> None:
    rec = _base(release_id="rel-candidate", release_arm="candidate")
    assert rec["releaseId"] == "rel-candidate"
    assert rec["releaseArm"] == "candidate"


def test_stable_arm_is_recorded() -> None:
    rec = _base(release_id="rel-stable", release_arm="stable")
    assert rec["releaseArm"] == "stable"


def test_unknown_arm_literal_is_dropped() -> None:
    # A malformed arm must not be persisted — downstream per-arm rollups
    # can then trust that a present releaseArm is one of the two literals.
    rec = _base(release_id="rel-x", release_arm="bogus")
    assert "releaseArm" not in rec
    assert rec["releaseId"] == "rel-x"


def test_empty_release_id_is_dropped() -> None:
    rec = _base(release_id="", release_arm="candidate")
    assert "releaseId" not in rec
    assert rec["releaseArm"] == "candidate"
