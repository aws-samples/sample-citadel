"""Cross-language parity guard for the grandfathering rule (finding 887db42a).

The rule exists twice — here (``is_grandfathered_pure``) and in
``backend/src/utils/is-grandfathered.ts`` (``isGrandfatheredPure``). This
suite loads the SAME shared JSON fixture consumed by the TS parity suite
(``backend/src/utils/__tests__/is-grandfathered.parity.test.ts``) —
``backend/src/utils/grandfathering-parity-cases.json`` — resolving the path
from the repo root rather than copying the case table. It also recomputes
the sha256 of each language's marked pure-function logic region and
compares against the fixture-recorded hash, so a one-sided edit to either
implementation fails loudly here too.

Do NOT hand-copy cases from the fixture into this file — add new cases to
the JSON fixture and both suites pick them up automatically.
"""
from __future__ import annotations

import hashlib
import json
import os
import re
import sys

_PROJECT_ROOT = os.path.abspath(
    os.path.join(os.path.dirname(__file__), "..", "..", "..")
)
if _PROJECT_ROOT not in sys.path:
    sys.path.insert(0, _PROJECT_ROOT)

from arbiter.governance.grandfathering import is_grandfathered_pure  # noqa: E402

_FIXTURE_PATH = os.path.join(
    _PROJECT_ROOT, "backend", "src", "utils", "grandfathering-parity-cases.json"
)

with open(_FIXTURE_PATH, "r", encoding="utf-8") as _f:
    _FIXTURE = json.load(_f)

_CASES = _FIXTURE["cases"]


def _normalize_region(region: str, comment_prefix: str) -> str:
    """Strip whole-line comments/blank lines, canonicalize quotes, and
    collapse whitespace before hashing.

    Mirrors ``normalizeRegion`` in ``is-grandfathered.parity.test.ts``:

    1. A line whose trimmed content starts with ``comment_prefix``, or is
       empty, is dropped.
    2. A single trailing backslash (line-continuation marker) is stripped
       from each kept line before further processing.
    3. Both ``'`` and ``"`` are mapped to a single canonical character
       (``'``), so a formatter's quote-style rewrite does not change the
       hash.
    4. Every run of whitespace within a kept line is collapsed to a
       single space, then the line is trimmed.
    5. Kept lines are joined with a single SPACE (not newline), so
       splitting one statement across physical lines — with or without a
       trailing backslash — does not change the hash.

    This makes the hash blind to comment-only edits, quote-style
    rewrites, and re-wrapping/re-indentation (including backslash line
    continuation), while still catching any change to executable logic
    (identifiers, operators, literal content, or the set of logic lines
    present).
    """
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
    """Recompute the sha256 of the normalized text strictly between the markers."""
    with open(abs_path, "r", encoding="utf-8") as f:
        content = f.read()
    begin_idx = content.find(begin_marker)
    end_idx = content.find(end_marker)
    if begin_idx == -1 or end_idx == -1 or end_idx < begin_idx:
        raise AssertionError(
            f"Could not locate PARITY-GUARD markers in {abs_path}. "
            "The begin/end marker comments around the pure grandfathering "
            "logic must not be removed."
        )
    region_start = begin_idx + len(begin_marker)
    region = content[region_start:end_idx]
    normalized = _normalize_region(region, comment_prefix)
    return hashlib.sha256(normalized.encode("utf-8")).hexdigest()


# ---------------------------------------------------------------------------
# Shared fixture cases (Python side)
# ---------------------------------------------------------------------------


def test_fixture_declares_at_least_one_case_per_required_branch_shape() -> None:
    assert len(_CASES) > 0
    branches = {c["branch"] for c in _CASES}
    assert len(branches) == len(_CASES)


def test_is_grandfathered_pure_matches_every_fixture_case() -> None:
    for case in _CASES:
        created_at = None if case.get("createdAtIsUndefined") else case["createdAt"]
        actual = is_grandfathered_pure(created_at, case["effectiveAt"])
        assert actual == case["expected"], (
            f"branch={case['branch']!r} description={case['description']!r} "
            f"createdAt={created_at!r} effectiveAt={case['effectiveAt']!r}: "
            f"expected {case['expected']!r}, got {actual!r}"
        )


def test_every_branch_id_declared_in_the_fixture_is_exercised_at_least_once() -> None:
    declared_branches = [c["branch"] for c in _CASES]
    exercised_branches: set[str] = set()
    for case in _CASES:
        created_at = None if case.get("createdAtIsUndefined") else case["createdAt"]
        is_grandfathered_pure(created_at, case["effectiveAt"])
        exercised_branches.add(case["branch"])
    for branch in declared_branches:
        assert branch in exercised_branches
    assert len(exercised_branches) == len(declared_branches)


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
        "Grandfathering rule drift detected: the marked logic region in "
        f"{entry['file']} no longer matches the sha256 recorded in "
        "backend/src/utils/grandfathering-parity-cases.json. If this is an "
        "intentional rule change, update BOTH "
        "backend/src/utils/is-grandfathered.ts AND "
        "arbiter/governance/grandfathering.py, then recompute and update "
        "both region hashes in the fixture. If this is unintentional, "
        "revert the one-sided edit."
    )


def test_ts_logic_region_hash_matches_the_fixture_recorded_sha256() -> None:
    entry = _FIXTURE["regionHashes"]["ts"]
    abs_path = os.path.join(_PROJECT_ROOT, entry["file"])
    actual = _hash_region(
        abs_path, entry["beginMarker"], entry["endMarker"], entry["commentPrefix"]
    )
    assert actual == entry["sha256"], (
        "Grandfathering rule drift detected: the marked logic region in "
        f"{entry['file']} no longer matches the sha256 recorded in "
        "backend/src/utils/grandfathering-parity-cases.json. If this is an "
        "intentional rule change, update BOTH "
        "backend/src/utils/is-grandfathered.ts AND "
        "arbiter/governance/grandfathering.py, then recompute and update "
        "both region hashes in the fixture. If this is unintentional, "
        "revert the one-sided edit."
    )


# ---------------------------------------------------------------------------
# _normalize_region unit behavior
# ---------------------------------------------------------------------------


def _hash_of(region: str, comment_prefix: str = "#") -> str:
    return hashlib.sha256(
        _normalize_region(region, comment_prefix).encode("utf-8")
    ).hexdigest()


def test_splitting_one_statement_across_two_physical_lines_does_not_change_the_hash() -> None:
    original = '    if effective_at is None or effective_at == "":\n        return True'
    rewrapped = (
        "    if effective_at is None or\n"
        '            effective_at == "":\n'
        "        return True"
    )
    assert _hash_of(rewrapped) == _hash_of(original)


def test_backslash_line_continuation_rewrap_does_not_change_the_hash() -> None:
    original = "    return created_at < effective_at"
    rewrapped = "    return created_at \\\n        < effective_at"
    assert _hash_of(rewrapped) == _hash_of(original)


def test_operator_edit_still_changes_the_hash() -> None:
    original = "    return created_at < effective_at"
    edited = "    return created_at <= effective_at"
    assert _hash_of(edited) != _hash_of(original)
