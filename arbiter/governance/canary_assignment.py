"""Canary arm-assignment rule (canary agent releases) — Python port.

Byte-for-byte port of the deterministic marked region in
``backend/src/lambda/utils/canary-assignment.ts``'s ``assignArm``. This is
deliberately a PORT of the existing rule, not a second rule: the two
functions must always agree given the same three arguments, so any change
to one's branch logic must be mirrored in the other and both region
hashes in ``canary-assignment-parity-cases.json`` recomputed (see
``test_canary_assignment_parity.py`` / the TS parity suite).

Why a port instead of a cross-language call: the TS helper runs in the
backend Lambda runtime; the arbiter dispatch choke points
(``supervisor/index.py``, ``stepRunner/executor.py`` via
``release_resolution.py``) run in a different Python runtime that cannot
reach it. The PURE rule below has no I/O and is safe to duplicate
verbatim, exactly as ``grandfathering.py``'s ``is_grandfathered_pure``
ports ``is-grandfathered.ts``.

The assignment is the crux of canary stickiness (decision D3,
stable-salt-recompute, NO pin store): the salt is minted once at canary
start and preserved verbatim across reweight, so re-hashing on reweight
never reassigns an existing key — only the threshold moves. See the TS
module docstring for the full stickiness argument.
"""
from __future__ import annotations

import hashlib
import math

# The uniform bucket space. A key hashes into [0, CANARY_BUCKET_SPACE);
# the arm is "candidate" when its bucket is strictly below the threshold
# percentBasisPoints (also expressed in [0, 10000]).
CANARY_BUCKET_SPACE = 10000


def assign_arm(
    stickiness_key: str,
    percent_basis_points: float,
    salt: str,
) -> str:
    """Deterministically assign a stickiness key to ``"stable"`` or
    ``"candidate"`` (mirrors ``assignArm`` in ``canary-assignment.ts``).

    digest = sha256(utf8(salt + ":" + stickiness_key))
    bucket = int(first 8 hex chars of digest, base 16) mod 10000
    arm    = "candidate" if bucket < clamped_percent else "stable"

    Totality: ``percent_basis_points`` is floored then clamped to
    [0, 10000] (0 -> always stable, 10000 -> always candidate); an empty
    stickiness key resolves to ``"stable"`` so a choke point that failed
    to thread a key degrades to the safe arm rather than routing everyone
    to the candidate.
    """
    # PARITY-GUARD:BEGIN — mirrored verbatim in
    # backend/src/lambda/utils/canary-assignment.ts's assignArm. If you
    # change the logic between these markers, you MUST update BOTH
    # implementations AND recompute the sha256 in
    # backend/src/lambda/utils/canary-assignment-parity-cases.json
    # (regionHashes.ts and regionHashes.python), or the parity guard test
    # will fail.
    # Non-finite percents are normalized to match JS Math.floor's total
    # IEEE behavior (Math.floor(Infinity)===Infinity, floored NaN stays
    # NaN and falls through to the stable arm): +inf clamps to full
    # (candidate), -inf and NaN clamp to 0 (stable). Python's math.floor
    # raises OverflowError on inf and min/max are unreliable on NaN, so the
    # branch is explicit here; the TS side gets the same outcomes for free.
    if isinstance(percent_basis_points, float) and math.isnan(percent_basis_points):
        clamped = 0
    elif percent_basis_points == math.inf:
        clamped = CANARY_BUCKET_SPACE
    elif percent_basis_points == -math.inf:
        clamped = 0
    else:
        clamped = max(0, min(CANARY_BUCKET_SPACE, math.floor(percent_basis_points)))
    if clamped <= 0:
        return "stable"
    if clamped >= CANARY_BUCKET_SPACE:
        return "candidate"
    if not isinstance(stickiness_key, str) or stickiness_key == "":
        return "stable"
    digest = hashlib.sha256((salt + ":" + stickiness_key).encode("utf-8")).hexdigest()
    bucket = int(digest[0:8], 16) % CANARY_BUCKET_SPACE
    return "candidate" if bucket < clamped else "stable"
    # PARITY-GUARD:END
