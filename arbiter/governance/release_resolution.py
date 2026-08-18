"""Read-only pointer -> release resolution for release-aware dispatch.

Resolves an (org_id, agent_target_id, environment) triple to the
AgentRelease it currently points at, by reading (never writing)
EnvironmentReleasePointersTable then AgentReleasesTable. Mirrors
``environment-release-pointer-store.ts``'s key schema exactly:
  - pointer PK/SK: ``orgId`` / ``agentTargetId_environment`` =
    ``f"{agent_target_id}#{environment}"`` (see
    ``environment-release-pointer-store.ts``'s ``sortKey``).
  - release PK: ``releaseId`` (see ``release-store.ts``).

IAM floor (enforced at the CDK layer, not here): GetItem/Query only on
both tables. This module never issues Put/Update/Delete against either —
mirrors the fabricator's design-assessment gate
(``arbiter/fabricator/design_assessment_gate.py``), which is the
established pattern in this codebase for a Python read-only precondition
gate against a table it does not own.

Three-way outcome (ReleaseResolutionStatus), not a boolean, because the
release-dispatch gate's strict-mode doctrine depends on distinguishing
"cleanly resolved to no release" from "the lookup itself failed":

  * RESOLVED      — pointer row found, release row found. ``release`` set.
  * NO_POINTER    — no pointer row exists (either table's env var is
                    unset — table not provisioned in this deployment,
                    same forward-compatible convention as
                    ``design_assessment_gate.py``'s
                    ``AGENT_DESIGN_ASSESSMENTS_TABLE``-unset no-op — or the
                    pointer GetItem returned no Item). This is the
                    BACKWARD-COMPATIBILITY case: an existing deployment
                    with no releases/pointers must land here on every
                    dispatch, indistinguishable from "not using releases
                    yet".
  * LOOKUP_FAILED — the lookup itself could not be completed: a DynamoDB
                    exception (throttle, permissions, network, a
                    misconfigured table name that does not exist), OR a
                    pointer that resolves to a releaseId with no matching
                    row in AgentReleasesTable (a "dangling pointer" —
                    since releases are create-only and never deleted
                    (release-store.ts), a pointer whose releaseId doesn't
                    resolve is a data-integrity failure, not a normal "not
                    yet promoted" state, and must be treated the same as
                    any other lookup failure).

Why LOOKUP_FAILED is not silently folded into NO_POINTER: this codebase's
established doctrine (see hierarchy.py's SSM-failure handling and the
class-level guidance this task follows) is assert-or-refuse, not
warn-and-proceed, for a failed control-surface read in strict mode. A
throttled/broken lookup and a clean "nothing configured yet" state must
remain observably distinct all the way up to the dispatch gate, so strict
mode can refuse on the former while still being backward-compatible with
the latter.
"""
from __future__ import annotations

import os
from dataclasses import dataclass
from enum import Enum
from typing import Any

import boto3
from botocore.exceptions import ClientError

from .canary_assignment import assign_arm

_dynamodb = None


def _get_resource() -> Any:
    """Lazy boto3 resource construction (mirrors design_assessment_gate.py
    and registry_client.py's QB-013-1 pattern: constructing the resource
    at import time triggers credential resolution, which fails in
    credential-less test/local-dev environments)."""
    global _dynamodb
    if _dynamodb is None:
        _dynamodb = boto3.resource("dynamodb")
    return _dynamodb


def __reset_clients_for_test() -> None:
    """Test-only hook — forces the next call to rebuild the cached resource."""
    global _dynamodb
    _dynamodb = None


def _pointer_table_name() -> str | None:
    return os.environ.get("ENVIRONMENT_RELEASE_POINTERS_TABLE") or None


def _release_table_name() -> str | None:
    return os.environ.get("AGENT_RELEASES_TABLE") or None


def _pointer_sort_key(agent_target_id: str, environment: str) -> str:
    """Mirrors environment-release-pointer-store.ts's ``sortKey`` helper."""
    return f"{agent_target_id}#{environment}"


class ReleaseResolutionStatus(str, Enum):
    RESOLVED = "resolved"
    NO_POINTER = "no_pointer"
    LOOKUP_FAILED = "lookup_failed"


@dataclass
class ReleaseResolution:
    status: ReleaseResolutionStatus
    release: dict | None = None
    error: str | None = None
    # Canary attribution (decision D2, attribution-only). The arm a
    # server-minted stickiness key resolved to ("stable" | "candidate"),
    # and the releaseId that arm points at. Both default to the stable
    # arm / stable releaseId for a canary-less pointer, so every existing
    # (canary-absent) caller reads arm="stable" and resolved_release_id
    # equal to the stable release — fully backward-compatible.
    arm: str = "stable"
    resolved_release_id: str | None = None


def resolve_release(
    org_id: str,
    agent_target_id: str,
    environment: str,
    stickiness_key: str | None = None,
) -> ReleaseResolution:
    """Resolve the release currently pointed at for (org_id,
    agent_target_id, environment). Read-only: issues at most one GetItem
    against each of EnvironmentReleasePointersTable and AgentReleasesTable.
    Never raises — every failure mode is captured in the returned
    ``ReleaseResolution.status``.

    Canary (decision D2, attribution-only): when the pointer row carries a
    ``canary`` object AND a ``stickiness_key`` is supplied, the arm is
    computed by the PURE ``assign_arm`` (mirrored TS/Python) from the
    server-minted key, the preserved salt, and the threshold. A
    ``candidate`` arm resolves ``canary.candidateReleaseId``; a ``stable``
    arm (or a canary-less pointer, or a missing key) resolves the stable
    ``releaseId``. The arm and resolved releaseId are returned for
    ATTRIBUTION ONLY — this function does NOT bind the resolved release to
    dispatch config (there is no release->config binding yet). A dangling
    candidate is a data-integrity failure, LOOKUP_FAILED, same as a
    dangling stable pointer.
    """
    pointer_table_name = _pointer_table_name()
    release_table_name = _release_table_name()

    # Forward-compatible no-op: either table not provisioned in this
    # deployment. This is the exact backward-compatibility case — an
    # existing deployment predating this feature has neither table, so
    # every dispatch resolves here with zero AWS calls, identical to
    # today's ungoverned-by-release behaviour.
    if not pointer_table_name or not release_table_name:
        return ReleaseResolution(status=ReleaseResolutionStatus.NO_POINTER)

    try:
        resource = _get_resource()
        pointer_table = resource.Table(pointer_table_name)
        pointer_response = pointer_table.get_item(
            Key={
                "orgId": org_id,
                "agentTargetId_environment": _pointer_sort_key(
                    agent_target_id, environment
                ),
            }
        )
    except Exception as exc:  # noqa: BLE001 — any lookup failure is LOOKUP_FAILED
        return ReleaseResolution(
            status=ReleaseResolutionStatus.LOOKUP_FAILED,
            error=f"pointer lookup failed: {type(exc).__name__}: {exc}",
        )

    pointer_item = pointer_response.get("Item")
    if not pointer_item:
        # Clean, expected state: no promotion has ever happened for this
        # (org, agent, environment) triple. Not a failure.
        return ReleaseResolution(status=ReleaseResolutionStatus.NO_POINTER)

    stable_release_id = pointer_item.get("releaseId")
    if not stable_release_id:
        # Malformed pointer row (should be unreachable given the write
        # boundary in environment-release-pointer-store.ts, which always
        # sets releaseId) — treat the same as a lookup failure rather than
        # guessing at a release.
        return ReleaseResolution(
            status=ReleaseResolutionStatus.LOOKUP_FAILED,
            error="pointer row is missing its releaseId field",
        )

    # Canary arm selection (attribution-only). Absent canary -> stable arm,
    # byte-identical to pre-canary behaviour.
    arm, resolved_release_id = _select_canary_arm(
        pointer_item, stable_release_id, stickiness_key
    )

    try:
        release_response = resource.Table(release_table_name).get_item(
            Key={"releaseId": resolved_release_id}
        )
    except Exception as exc:  # noqa: BLE001 — any lookup failure is LOOKUP_FAILED
        return ReleaseResolution(
            status=ReleaseResolutionStatus.LOOKUP_FAILED,
            error=f"release lookup failed: {type(exc).__name__}: {exc}",
        )

    release_item = release_response.get("Item")
    if not release_item:
        # Dangling pointer/candidate: the release table is create-only and
        # rows are never deleted (release-store.ts), so a releaseId that
        # does not resolve indicates a data-integrity problem, not a normal
        # state. Refuse-worthy, same as any other lookup failure — covers
        # both a dangling STABLE pointer and a dangling canary CANDIDATE.
        return ReleaseResolution(
            status=ReleaseResolutionStatus.LOOKUP_FAILED,
            error=f"dangling pointer: releaseId {resolved_release_id!r} has no matching release row",
        )

    return ReleaseResolution(
        status=ReleaseResolutionStatus.RESOLVED,
        release=release_item,
        arm=arm,
        resolved_release_id=resolved_release_id,
    )


def _select_canary_arm(
    pointer_item: dict,
    stable_release_id: str,
    stickiness_key: str | None,
) -> tuple[str, str]:
    """Pure-ish arm selection: returns ``(arm, resolved_release_id)``.

    Absent canary, absent/empty stickiness key, or a malformed canary
    object all resolve the STABLE arm — a choke point that failed to
    thread a key can never silently route everyone to the candidate
    (mirrors ``assign_arm``'s empty-key contract). Any exception reading
    the canary object degrades to the stable arm rather than raising, so a
    malformed row can never break dispatch.
    """
    try:
        canary = pointer_item.get("canary")
        if not isinstance(canary, dict):
            return "stable", stable_release_id
        if not isinstance(stickiness_key, str) or stickiness_key == "":
            return "stable", stable_release_id
        candidate_release_id = canary.get("candidateReleaseId")
        percent = canary.get("percentBasisPoints")
        salt = canary.get("salt")
        if not candidate_release_id or salt is None or percent is None:
            return "stable", stable_release_id
        arm = assign_arm(stickiness_key, percent, salt)
        if arm == "candidate":
            return "candidate", candidate_release_id
        return "stable", stable_release_id
    except Exception:  # noqa: BLE001 — arm selection must never break dispatch
        return "stable", stable_release_id
