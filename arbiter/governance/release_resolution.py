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


def resolve_release(
    org_id: str,
    agent_target_id: str,
    environment: str,
) -> ReleaseResolution:
    """Resolve the release currently pointed at for (org_id,
    agent_target_id, environment). Read-only: issues at most one GetItem
    against each of EnvironmentReleasePointersTable and AgentReleasesTable.
    Never raises — every failure mode is captured in the returned
    ``ReleaseResolution.status``.
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

    release_id = pointer_item.get("releaseId")
    if not release_id:
        # Malformed pointer row (should be unreachable given the write
        # boundary in environment-release-pointer-store.ts, which always
        # sets releaseId) — treat the same as a lookup failure rather than
        # guessing at a release.
        return ReleaseResolution(
            status=ReleaseResolutionStatus.LOOKUP_FAILED,
            error="pointer row is missing its releaseId field",
        )

    try:
        release_response = resource.Table(release_table_name).get_item(
            Key={"releaseId": release_id}
        )
    except Exception as exc:  # noqa: BLE001 — any lookup failure is LOOKUP_FAILED
        return ReleaseResolution(
            status=ReleaseResolutionStatus.LOOKUP_FAILED,
            error=f"release lookup failed: {type(exc).__name__}: {exc}",
        )

    release_item = release_response.get("Item")
    if not release_item:
        # Dangling pointer: the release table is create-only and rows are
        # never deleted (release-store.ts), so a pointer whose releaseId
        # does not resolve indicates a data-integrity problem, not a
        # normal state. Refuse-worthy, same as any other lookup failure.
        return ReleaseResolution(
            status=ReleaseResolutionStatus.LOOKUP_FAILED,
            error=f"dangling pointer: releaseId {release_id!r} has no matching release row",
        )

    return ReleaseResolution(
        status=ReleaseResolutionStatus.RESOLVED,
        release=release_item,
    )
