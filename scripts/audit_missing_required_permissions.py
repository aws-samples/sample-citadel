#!/usr/bin/env python3
"""audit_missing_required_permissions.py — DRY-RUN report of registry
records (agents/tools) whose ``requiredPermissions`` is absent or empty
(PR-4 §3, owner decision 5750aeec: FAIL CLOSED, no grandfathering).

This script performs NO WRITES and NO AUTO-STAMPING — it is read-only
reconnaissance (per the practices doc's "Read-only reconnaissance before
destructive DB ops" rule, applied here even though nothing destructive is
planned: this script exists specifically to let an operator see the blast
radius of the fail-closed worker gate BEFORE it is deployed, so quantifying
first is the entire point).

Every record reported here will be REFUSED at worker dispatch under PR-4
unless it is either re-fabricated (which auto-stamps permissions going
forward) or explicitly granted a non-empty requiredPermissions set by an
operator, or re-stamped with the explicit credentialMode: "none" sentinel
for genuinely credential-less (pure-compute) agents.

Usage:
    python3 scripts/audit_missing_required_permissions.py --registry-id <id>

Exit code is always 0 (dry-run / report tool — never fails CI on its own;
the printed count is for a human or a SEPARATE gate to act on).
"""
from __future__ import annotations

import argparse
import json
import os
import sys

# Make the catalog package (registry_client) importable when run directly
# from the repo root, mirroring the convention other arbiter modules use
# (``from catalog.registry_client import ...`` with ``arbiter/`` on
# sys.path — see arbiter/supervisor/index.py, arbiter/stepRunner/executor.py).
_REPO_ROOT = os.path.dirname(os.path.dirname(os.path.abspath(__file__)))
sys.path.insert(0, os.path.join(_REPO_ROOT, "arbiter"))

from catalog.registry_client import get_agent_record, list_agent_records  # noqa: E402


def _is_absent_or_empty_permissions(required_permissions) -> bool:
    """Mirrors the worker dispatch gate's deny-default check
    (arbiter/workerWrapper/index.py's _is_absent_or_empty_permissions)."""
    if not required_permissions or not isinstance(required_permissions, dict):
        return True
    return not (
        required_permissions.get("integrations") or required_permissions.get("dataStores")
    )


def _has_no_cloud_sentinel(config: dict) -> bool:
    if config.get("credentialMode") == "none":
        return True
    required_permissions = config.get("requiredPermissions")
    if isinstance(required_permissions, dict) and required_permissions.get("credentialMode") == "none":
        return True
    return False


def _parse_custom_descriptor(content: str | None) -> dict:
    if not content:
        return {}
    try:
        parsed = json.loads(content)
    except (json.JSONDecodeError, TypeError):
        return {}
    return parsed if isinstance(parsed, dict) else {}


def audit_missing_required_permissions(registry_id: str) -> list[dict]:
    """Return a list of {recordId, name, orgId, createdBy, status} dicts for
    every registry record whose requiredPermissions is absent/empty and
    which has NOT opted into the explicit credentialMode: "none" sentinel.

    Never raises — registry_client's own read operations already degrade
    to [] / None on any failure; this function propagates that contract.
    """
    findings: list[dict] = []
    summaries = list_agent_records(registry_id)
    for summary in summaries:
        record_id = summary.get("recordId")
        if not record_id:
            continue
        full_record = get_agent_record(registry_id, record_id)
        if full_record is None:
            continue
        descriptor = _parse_custom_descriptor(full_record.get("customDescriptorContent"))
        config = descriptor.get("config") if isinstance(descriptor.get("config"), dict) else {}
        # Permission data may be stamped at either the top-level descriptor
        # (PR-4's custom_metadata["requiredPermissions"]) or nested under
        # config — check both, same as the worker's config.get(...) read.
        required_permissions = (
            descriptor.get("requiredPermissions")
            if descriptor.get("requiredPermissions") is not None
            else config.get("requiredPermissions")
        )
        if _has_no_cloud_sentinel(config) or _has_no_cloud_sentinel(descriptor):
            continue
        if not _is_absent_or_empty_permissions(required_permissions):
            continue
        findings.append({
            "recordId": record_id,
            "name": summary.get("name") or full_record.get("name"),
            "orgId": descriptor.get("orgId"),
            "createdBy": descriptor.get("createdBy"),
            "status": summary.get("status") or full_record.get("status"),
        })
    return findings


def _print_report(findings: list[dict]) -> None:
    print(f"audit_missing_required_permissions: {len(findings)} record(s) "
          f"would be REFUSED at dispatch under PR-4's fail-closed gate "
          f"(no requiredPermissions and no credentialMode: 'none' sentinel):")
    if not findings:
        print("  (none)")
        return
    print(f"  {'recordId':<40} {'name':<30} {'orgId':<20} {'createdBy':<20} status")
    for f in findings:
        print(
            f"  {str(f['recordId']):<40} {str(f['name']):<30} "
            f"{str(f['orgId']):<20} {str(f['createdBy']):<20} {f['status']}"
        )
    print(f"\nDRY-RUN ONLY — no writes performed. {len(findings)} record(s) found.")


def main(argv: list[str] | None = None) -> int:
    parser = argparse.ArgumentParser(description=__doc__)
    parser.add_argument(
        "--registry-id",
        default=os.environ.get("REGISTRY_ID"),
        help="AgentCore Registry ID (defaults to REGISTRY_ID env var).",
    )
    args = parser.parse_args(argv)

    if not args.registry_id:
        print(
            "audit_missing_required_permissions: no --registry-id given and "
            "REGISTRY_ID env var is unset; nothing to audit.",
            file=sys.stderr,
        )
        return 0

    findings = audit_missing_required_permissions(args.registry_id)
    _print_report(findings)
    return 0


if __name__ == "__main__":
    sys.exit(main())
