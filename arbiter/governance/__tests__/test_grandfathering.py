"""Tests for the pure grandfathering rule (release-aware dispatch).

Byte-for-byte port of the deterministic branches in
``backend/src/utils/is-grandfathered.ts``'s ``isGrandfatheredPure`` — same
rule, same branch order, same conservative-bypass posture on malformed
input. This is the ONLY grandfathering rule in the codebase; Python does
not invent a second one, it applies the same one the TS side already
owns, using whatever created-at signal is actually available to a caller
(see release_resolution.py, which has none today and always passes
``created_at=None``).
"""
from __future__ import annotations

import os
import sys

_PROJECT_ROOT = os.path.abspath(
    os.path.join(os.path.dirname(__file__), "..", "..", "..")
)
if _PROJECT_ROOT not in sys.path:
    sys.path.insert(0, _PROJECT_ROOT)

from arbiter.governance.grandfathering import is_grandfathered_pure  # noqa: E402


# ---------------------------------------------------------------------------
# Pre-shadow-flip (no cutoff) -> everyone grandfathered
# ---------------------------------------------------------------------------


def test_none_effective_at_with_normal_created_at_is_true() -> None:
    assert is_grandfathered_pure("2026-05-10T00:00:00Z", None) is True


def test_empty_string_effective_at_with_normal_created_at_is_true() -> None:
    assert is_grandfathered_pure("2026-05-10T00:00:00Z", "") is True


def test_distant_future_created_at_with_none_cutoff_still_grandfathered() -> None:
    assert is_grandfathered_pure("9999-12-31T23:59:59Z", None) is True


# ---------------------------------------------------------------------------
# ISO-8601 lexicographic comparison
# ---------------------------------------------------------------------------


def test_created_at_before_effective_at_is_true() -> None:
    assert is_grandfathered_pure("2026-05-10T00:00:00Z", "2026-05-15T00:00:00Z") is True


def test_created_at_equal_to_effective_at_is_false() -> None:
    assert is_grandfathered_pure("2026-05-15T00:00:00Z", "2026-05-15T00:00:00Z") is False


def test_created_at_after_effective_at_is_false() -> None:
    assert is_grandfathered_pure("2026-05-20T00:00:00Z", "2026-05-15T00:00:00Z") is False


# ---------------------------------------------------------------------------
# Malformed created_at -> conservative bypass (True)
# ---------------------------------------------------------------------------


def test_none_created_at_is_true() -> None:
    assert is_grandfathered_pure(None, "2026-05-15T00:00:00Z") is True


def test_empty_string_created_at_is_true() -> None:
    assert is_grandfathered_pure("", "2026-05-15T00:00:00Z") is True


def test_non_string_created_at_is_true() -> None:
    # Defensive: a caller could pass a non-string by mistake (e.g. an int
    # epoch); this must bypass conservatively, not raise or misbehave.
    assert is_grandfathered_pure(12345, "2026-05-15T00:00:00Z") is True  # type: ignore[arg-type]
