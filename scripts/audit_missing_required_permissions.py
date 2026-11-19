#!/usr/bin/env python3
"""audit_missing_required_permissions.py — DRY-RUN report of registry
AGENT records whose ``requiredPermissions`` is absent or empty
(PR-4 §3, owner decision 5750aeec: FAIL CLOSED, no grandfathering).

Audits AGENT records only, matching the type filter that
backend/scripts/stamp-agent-permissions.ts applies via listResources('agent').
Records whose kind infers to 'tool' or 'app' are skipped.

A record is **satisfied** when:
  - ``requiredPermissions`` has non-empty ``models`` OR ``integrations``
    OR ``dataStores``  (same semantics as the worker's
    ``_is_absent_or_empty_permissions`` in arbiter/workerWrapper/index.py), OR
  - ``credentialMode`` is ``"none"`` (explicit no-cloud sentinel).

This script performs NO WRITES and NO AUTO-STAMPING — it is read-only
reconnaissance.

Exit codes:
  0 — clean estate (no findings)
  1 — one or more AGENT records are missing permissions (CI gate failure)
  2 — registry call failed (infrastructure error)

Usage:
    python3 scripts/audit_missing_required_permissions.py --registry-id <id>
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


def _is_absent_or_empty_permissions(required_permissions: object) -> bool:
    """True when *required_permissions* declares no resource access at all.

    Mirrors the worker dispatch gate's deny-default check
    (arbiter/workerWrapper/index.py ``_is_absent_or_empty_permissions``)
    exactly — checks ``models``, ``integrations``, AND ``dataStores``.
    """
    if not required_permissions or not isinstance(required_permissions, dict):
        return True
    return not (
        required_permissions.get("models")
        or required_permissions.get("integrations")
        or required_permissions.get("dataStores")
    )


def _has_no_cloud_sentinel(config: dict) -> bool:
    if config.get("credentialMode") == "none":
        return True
    required_permissions = config.get("requiredPermissions")
    if isinstance(required_permissions, dict) and required_permissions.get("credentialMode") == "none":
        return True
    return False


def _parse_custom_descriptor(content: str | None) -> dict | None:
    """Parse customDescriptorContent JSON.  Returns None on failure."""
    if not content:
        return None
    try:
        parsed = json.loads(content)
    except (json.JSONDecodeError, TypeError):
        return None
    return parsed if isinstance(parsed, dict) else None


def _infer_kind(descriptor: dict) -> str:
    """Infer record kind from descriptor shape.

    Mirrors backend/src/utils/citadel-kind.ts ``inferKindFromParsed``:
      1. manifest.agentBindings OR appId OR manifest.access → 'app'
      2. manifest present (non-null object)                  → 'agent'
      3. Otherwise                                           → 'tool'
    """
    manifest = descriptor.get("manifest")
    if not isinstance(manifest, dict):
        manifest = None

    if (
        (manifest is not None and manifest.get("agentBindings") is not None)
        or "appId" in descriptor
        or (manifest is not None and manifest.get("access") is not None)
    ):
        return "app"

    if manifest is not None:
        return "agent"

    return "tool"


def audit_missing_required_permissions(registry_id: str) -> list[dict]:
    """Return a list of {recordId, name, orgId, createdBy, status} dicts for
    every AGENT registry record whose requiredPermissions is absent/empty and
    which has NOT opted into the explicit credentialMode: "none" sentinel.

    Only AGENT records are audited (same type filter as
    backend/scripts/stamp-agent-permissions.ts via listResources('agent')).
    Tool and app records are excluded.

    Raises on registry call failure so the caller can distinguish
    infrastructure errors from an empty estate.
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
        if descriptor is None:
            continue

        # Type filter: agents only (exclude tools and apps)
        kind = _infer_kind(descriptor)
        if kind != "agent":
            continue

        raw_config = descriptor.get("config")
        config: dict = raw_config if isinstance(raw_config, dict) else {}
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
    print(f"audit_missing_required_permissions: {len(findings)} AGENT record(s) "
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
    print(f"\nDRY-RUN ONLY — no writes performed. {len(findings)} AGENT record(s) found.")


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

    try:
        findings = audit_missing_required_permissions(args.registry_id)
    except Exception as exc:
        print(
            f"audit_missing_required_permissions: registry call failed: {exc}",
            file=sys.stderr,
        )
        return 2

    _print_report(findings)
    return 1 if findings else 0


if __name__ == "__main__":
    sys.exit(main())
