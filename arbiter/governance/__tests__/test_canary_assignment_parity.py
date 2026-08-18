"""Cross-language parity + property guard for the canary arm-assignment rule.

The rule exists twice — here (``assign_arm``) and in
``backend/src/lambda/utils/canary-assignment.ts`` (``assignArm``). This
suite loads the SAME shared JSON fixture consumed by the TS parity suite
(``backend/src/lambda/utils/canary-assignment-parity-cases.json``),
recomputes the sha256 of each language's marked logic region against the
fixture-recorded hash, adds a MUST-BITE mutant check, and exercises
hypothesis properties for determinism, monotonicity, and reweight
stickiness.

Do NOT hand-copy cases from the fixture — add new cases there and both
suites pick them up automatically.
"""
from __future__ import annotations

import hashlib
import json
import math
import os
import re
import sys

from hypothesis import given, settings
from hypothesis import strategies as st

_PROJECT_ROOT = os.path.abspath(
    os.path.join(os.path.dirname(__file__), "..", "..", "..")
)
if _PROJECT_ROOT not in sys.path:
    sys.path.insert(0, _PROJECT_ROOT)

from arbiter.governance.canary_assignment import (  # noqa: E402
    CANARY_BUCKET_SPACE,
    assign_arm,
)

_FIXTURE_PATH = os.path.join(
    _PROJECT_ROOT,
    "backend",
    "src",
    "lambda",
    "utils",
    "canary-assignment-parity-cases.json",
)

with open(_FIXTURE_PATH, "r", encoding="utf-8") as _f:
    _FIXTURE = json.load(_f)

_CASES = _FIXTURE["cases"]


def _normalize_region(region: str, comment_prefix: str) -> str:
    """Mirrors ``normalizeRegion`` in the TS parity suite and the
    grandfathering parity guard."""
    kept = []
    for line in region.split("\n"):
        trimmed = line.strip()
        if trimmed == "":
            continue
        if trimmed.startswith(comment_prefix):
            continue
        without_continuation = re.sub(r"\\$", "", line.rstrip())
        canonicalized = re.sub(r"['\"]", "'", without_continuation)
        collapsed = re.sub(r"\s+", " ", canonicalized).strip()
        kept.append(collapsed)
    return " ".join(kept)


def _hash_region(
    abs_path: str, begin_marker: str, end_marker: str, comment_prefix: str
) -> str:
    with open(abs_path, "r", encoding="utf-8") as f:
        content = f.read()
    begin_idx = content.find(begin_marker)
    end_idx = content.find(end_marker)
    if begin_idx == -1 or end_idx == -1 or end_idx < begin_idx:
        raise AssertionError(
            f"Could not locate PARITY-GUARD markers in {abs_path}."
        )
    region = content[begin_idx + len(begin_marker) : end_idx]
    return hashlib.sha256(
        _normalize_region(region, comment_prefix).encode("utf-8")
    ).hexdigest()


def _assign_arm_mutant_less_equal(
    stickiness_key: str, percent_basis_points: float, salt: str
) -> str:
    """assign_arm with the ONE mutation the MUST-BITE test targets: strict
    ``<`` becomes ``<=``."""
    clamped = max(0, min(CANARY_BUCKET_SPACE, math.floor(percent_basis_points)))
    if clamped <= 0:
        return "stable"
    if clamped >= CANARY_BUCKET_SPACE:
        return "candidate"
    if not isinstance(stickiness_key, str) or stickiness_key == "":
        return "stable"
    digest = hashlib.sha256((salt + ":" + stickiness_key).encode("utf-8")).hexdigest()
    bucket = int(digest[0:8], 16) % CANARY_BUCKET_SPACE
    return "candidate" if bucket <= clamped else "stable"


# ---------------------------------------------------------------------------
# Shared fixture cases (Python side)
# ---------------------------------------------------------------------------


def test_fixture_declares_a_unique_branch_id_per_case() -> None:
    assert len(_CASES) > 0
    branches = {c["branch"] for c in _CASES}
    assert len(branches) == len(_CASES)


def test_assign_arm_matches_every_fixture_case() -> None:
    for case in _CASES:
        actual = assign_arm(
            case["stickinessKey"], case["percentBasisPoints"], case["salt"]
        )
        assert actual == case["expected"], (
            f"branch={case['branch']!r} key={case['stickinessKey']!r} "
            f"percent={case['percentBasisPoints']!r} salt={case['salt']!r}: "
            f"expected {case['expected']!r}, got {actual!r}"
        )


# ---------------------------------------------------------------------------
# Drift trip-wire
# ---------------------------------------------------------------------------


def test_python_logic_region_hash_matches_the_fixture_recorded_sha256() -> None:
    entry = _FIXTURE["regionHashes"]["python"]
    abs_path = os.path.join(_PROJECT_ROOT, entry["file"])
    actual = _hash_region(
        abs_path, entry["beginMarker"], entry["endMarker"], entry["commentPrefix"]
    )
    assert actual == entry["sha256"], (
        "Canary arm-assignment rule drift detected: the marked logic region "
        f"in {entry['file']} no longer matches the recorded sha256. Update "
        "BOTH implementations and recompute both region hashes in the fixture."
    )


def test_ts_logic_region_hash_matches_the_fixture_recorded_sha256() -> None:
    entry = _FIXTURE["regionHashes"]["ts"]
    abs_path = os.path.join(_PROJECT_ROOT, entry["file"])
    actual = _hash_region(
        abs_path, entry["beginMarker"], entry["endMarker"], entry["commentPrefix"]
    )
    assert actual == entry["sha256"], (
        "Canary arm-assignment rule drift detected: the marked logic region "
        f"in {entry['file']} no longer matches the recorded sha256. Update "
        "BOTH implementations and recompute both region hashes in the fixture."
    )


# ---------------------------------------------------------------------------
# MUST-BITE mutant
# ---------------------------------------------------------------------------


def test_boundary_case_bites_the_less_equal_mutant() -> None:
    boundary = next(
        c
        for c in _CASES
        if c["branch"] == "boundary_bucket_equals_threshold_stable"
    )
    real = assign_arm(
        boundary["stickinessKey"], boundary["percentBasisPoints"], boundary["salt"]
    )
    mutant = _assign_arm_mutant_less_equal(
        boundary["stickinessKey"], boundary["percentBasisPoints"], boundary["salt"]
    )
    assert real == "stable"
    assert mutant == "candidate"
    assert real != mutant


# ---------------------------------------------------------------------------
# Properties
# ---------------------------------------------------------------------------


def test_routes_approximately_percent_of_keys_to_candidate() -> None:
    salt = "prop-salt"
    percent_bp = 1000  # 10%
    n = 20000
    candidate = sum(
        1 for i in range(n) if assign_arm(f"key-{i}", percent_bp, salt) == "candidate"
    )
    fraction = candidate / n
    assert 0.085 < fraction < 0.115


@settings(max_examples=200)
@given(
    st.text(),
    st.integers(min_value=0, max_value=CANARY_BUCKET_SPACE),
    st.text(min_size=1),
)
def test_is_deterministic(key: str, pct: int, salt: str) -> None:
    assert assign_arm(key, pct, salt) == assign_arm(key, pct, salt)


@settings(max_examples=200)
@given(
    st.text(min_size=1),
    st.integers(min_value=0, max_value=CANARY_BUCKET_SPACE),
    st.integers(min_value=0, max_value=CANARY_BUCKET_SPACE),
    st.text(min_size=1),
)
def test_reweight_is_one_way_delta_band(key: str, a: int, b: int, salt: str) -> None:
    lo, hi = min(a, b), max(a, b)
    arm_lo = assign_arm(key, lo, salt)
    arm_hi = assign_arm(key, hi, salt)
    if arm_lo != arm_hi:
        # Raising percent with a fixed salt can only move stable->candidate.
        assert arm_lo == "stable"
        assert arm_hi == "candidate"


@settings(max_examples=200)
@given(st.text(), st.floats(), st.text())
def test_never_throws_and_returns_valid_arm(key: str, pct: float, salt: str) -> None:
    arm = assign_arm(key, pct, salt)
    assert arm in ("stable", "candidate")
