"""Grandfathering rule (release-aware dispatch) — Python port.

Byte-for-byte port of the deterministic branches in
``backend/src/utils/is-grandfathered.ts``'s ``isGrandfatheredPure``. This
is deliberately a PORT of the existing rule, not a second rule: the two
functions must always agree given the same two arguments, so any change
to one's branch logic must be mirrored in the other.

Why a port instead of a cross-language call: the TS helper's I/O wrapper
(``isGrandfathered``) reads SSM via a Lambda-only in-process cache and is
not reachable from the long-running Python arbiter processes (supervisor
Lambda and stepRunner Lambda run in a different runtime with their own
SSM-backed mode cache in ``hierarchy.py``). The PURE rule below has no I/O
and is safe to duplicate verbatim; the I/O-bound SSM read for
``effective_at`` lives in ``hierarchy.py`` (see ``_resolve_effective_at``),
mirroring the same parameter path
(``/citadel/governance/effective_at/{ENVIRONMENT}``) the TS
``governance-flag.ts`` reader uses, exactly the same way
``_resolve_enforcement_mode`` already mirrors ``governance-flag.ts``'s
``enforce`` parameter.

Callers supply whatever ``created_at`` signal they actually have. The
release-dispatch gate (``release_resolution.py`` / the supervisor and
stepRunner dispatch call sites) has no reliable per-agent creation
timestamp today — the arbiter's agent config and workflow node dicts carry
no ``createdAt`` field, and org/agent registry lookups are optional
(``REGISTRY_ENABLED``) — so it always calls this with ``created_at=None``.
That is not a special case here: ``created_at=None`` already falls into
the "malformed input -> conservative bypass" branch the TS rule defines
for exactly this situation (missing/absent data must never harden into a
block), so no additional branching is needed to accommodate it.
"""
from __future__ import annotations

from typing import Any


def is_grandfathered_pure(
    created_at: Any,
    effective_at: str | None,
) -> bool:
    """Pure implementation of the grandfathering rule.

    Rule (mirrors ``isGrandfatheredPure`` in ``is-grandfathered.ts``):
      - ``effective_at`` is ``None`` or ``''`` -> True (pre-shadow-flip;
        everyone grandfathered).
      - malformed ``created_at`` (not a non-empty string) -> True
        (conservative bypass — a data defect must not become a hard
        failure).
      - ``created_at < effective_at`` (ISO-8601 lexicographic
        comparison) -> True.
      - ``created_at == effective_at`` -> False (the exact cutoff is NOT
        grandfathered).
      - ``created_at > effective_at`` -> False.
    """
    # PARITY-GUARD:BEGIN — mirrored verbatim in
    # backend/src/utils/is-grandfathered.ts's isGrandfatheredPure. If you
    # change the logic between these markers, you MUST update BOTH
    # implementations AND recompute the sha256 in
    # backend/src/utils/grandfathering-parity-cases.json (regionHashes.python),
    # or the parity guard test will fail. See finding 887db42a.
    # Pre-shadow-flip (no cutoff set): everyone is grandfathered.
    if effective_at is None or effective_at == "":
        return True
    # Conservative fallback for malformed/absent created_at data: bypass
    # rather than block.
    if not isinstance(created_at, str) or created_at == "":
        return True
    # ISO-8601 strings compare correctly lexicographically when
    # timezone-normalized, matching the TS side's string comparison.
    return created_at < effective_at
    # PARITY-GUARD:END
