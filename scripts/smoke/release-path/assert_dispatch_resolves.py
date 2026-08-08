#!/usr/bin/env python3
"""assert_dispatch_resolves.py — read-only dispatch-side resolution check
for the release-path smoke fixture.

Calls arbiter.governance.release_resolution.resolve_release(org_id,
agent_target_id, environment) for the SENTINEL org/agent/environment this
fixture set promoted a release for (via run-smoke.ts), and asserts:

  1. status == RESOLVED
  2. release['releaseId'] == the releaseId that was cut/promoted

This module (resolve_release) is READ-ONLY BY CONSTRUCTION: it issues at
most one GetItem against EnvironmentReleasePointersTable and one against
AgentReleasesTable, and never imports/calls anything that could write to
either. See release_resolution.py's own module docstring — "IAM floor
(enforced at the CDK layer, not here): GetItem/Query only on both
tables." This script adds NO additional AWS calls beyond that single
resolve_release invocation; it does not touch DynamoDB directly at all.

NON-BLOCKING MODE: this script never sets/checks strict enforcement mode
and never asserts anything about `_check_release_gate`'s would_block
behavior — the approved design is explicit that resolve_release's
RESOLVED outcome is observable in shadow/permissive without needing
strict mode at all (strict changes whether an unresolved lookup BLOCKS
dispatch, not whether resolution itself succeeds). Running this script
never flips governance enforcement mode.

WHY THIS DOES NOT NEED TO WEAKEN THE release-store CHOKE POINT: the
choke-point guard (release-store-choke-point.guard.test.ts) protects
AgentReleasesTable's WRITE surface (Put/Update/Delete) inside
backend/src/lambda/**. This script never writes to that table (or
EnvironmentReleasePointersTable) — it only reads, and it reads via the
SAME read-only Python module the real dispatch gate
(arbiter/stepRunner/executor.py's _check_release_gate) already calls in
production, rather than a bespoke table read. No new read/write path is
introduced and the guard's effectiveness against runtime writes is
untouched.

Exit codes:
  0 - resolution RESOLVED with the expected releaseId.
  1 - resolution did not match (NO_POINTER / LOOKUP_FAILED / releaseId
      mismatch), or required environment variables are missing.
"""
from __future__ import annotations

import argparse
import json
import os
import sys
from pathlib import Path

# Repo root (two levels up: scripts/smoke/release-path/ -> repo root) so
# `import arbiter....` resolves the same way it does for every other
# script/test in this repo, without requiring the caller to have set
# PYTHONPATH themselves.
REPO_ROOT = Path(__file__).resolve().parents[3]
if str(REPO_ROOT) not in sys.path:
    sys.path.insert(0, str(REPO_ROOT))

SENTINEL_ORG = "SMOKE-RELEASE-FIXTURE-ORG"
SENTINEL_AGENT_TARGET_ID = "smoke-release-fixture-agent"
SENTINEL_ENVIRONMENT = "DEV"

REQUIRED_ENV_VARS = (
    "ENVIRONMENT_RELEASE_POINTERS_TABLE",
    "AGENT_RELEASES_TABLE",
    "AWS_REGION",
)


def _assert_env_complete() -> None:
    missing = [name for name in REQUIRED_ENV_VARS if not os.environ.get(name)]
    if missing:
        raise SystemExit(
            "Missing required environment variable(s): "
            + ", ".join(missing)
            + ". This script never provisions infrastructure or identities "
            "itself — see RUNBOOK.md (\"One-time operator setup\") for how "
            "to discover these table names from your dev deployment, and "
            "note that unlike run-smoke.ts this script needs NO Cognito "
            "identity at all (it calls the dispatch-side Python resolver "
            "directly with plain AWS credentials, matching how the real "
            "Step Runner's _check_release_gate is invoked)."
        )


def main() -> int:
    parser = argparse.ArgumentParser(
        description=(
            "Read-only assertion that dispatch resolution for the "
            "release-path smoke fixture returns RESOLVED with the "
            "expected releaseId. Never writes to AWS."
        )
    )
    parser.add_argument(
        "--release-id",
        required=True,
        help=(
            "The releaseId run-smoke.ts's cutAgentRelease call produced "
            "(printed by run-smoke.ts as 'releaseId=...' on success)."
        ),
    )
    parser.add_argument(
        "--org-id",
        default=SENTINEL_ORG,
        help="Override the sentinel org id (default: %(default)s).",
    )
    parser.add_argument(
        "--agent-target-id",
        default=SENTINEL_AGENT_TARGET_ID,
        help="Override the sentinel agent target id (default: %(default)s).",
    )
    parser.add_argument(
        "--environment",
        default=SENTINEL_ENVIRONMENT,
        help="Override the sentinel environment literal (default: %(default)s).",
    )
    args = parser.parse_args()

    _assert_env_complete()

    # Imported after the env-var check and sys.path setup, and AFTER
    # argparse, so a --help invocation never touches boto3 credential
    # resolution.
    from arbiter.governance.release_resolution import (  # noqa: E402
        ReleaseResolutionStatus,
        resolve_release,
    )

    resolution = resolve_release(
        org_id=args.org_id,
        agent_target_id=args.agent_target_id,
        environment=args.environment,
    )

    print(
        json.dumps(
            {
                "status": resolution.status.value,
                "release_id_in_pointer": (
                    (resolution.release or {}).get("releaseId")
                    if resolution.release
                    else None
                ),
                "expected_release_id": args.release_id,
                "error": resolution.error,
            },
            indent=2,
        )
    )

    if resolution.status != ReleaseResolutionStatus.RESOLVED:
        print(
            f"FAIL: expected status RESOLVED, got {resolution.status.value} "
            f"(error={resolution.error!r}). This usually means run-smoke.ts "
            "has not been run yet against this deployment, or the "
            "ENVIRONMENT_RELEASE_POINTERS_TABLE / AGENT_RELEASES_TABLE env "
            "vars point at a different deployment than the one run-smoke.ts "
            "targeted.",
            file=sys.stderr,
        )
        return 1

    resolved_release_id = (resolution.release or {}).get("releaseId")
    if resolved_release_id != args.release_id:
        print(
            f"FAIL: resolved releaseId ({resolved_release_id!r}) does not "
            f"match the expected releaseId ({args.release_id!r}) that "
            "run-smoke.ts cut/promoted.",
            file=sys.stderr,
        )
        return 1

    print(
        f"PASS: dispatch resolution RESOLVED to the expected release "
        f"{args.release_id} for org={args.org_id} "
        f"agentTargetId={args.agent_target_id} environment={args.environment}. "
        "Read-only — no writes were issued (see module docstring)."
    )
    return 0


if __name__ == "__main__":
    sys.exit(main())
