#!/usr/bin/env python3
"""audit_missing_required_permissions.py — DRY-RUN report of registry
AGENT records whose ``requiredPermissions`` is absent or empty
(PR-4 §3, owner decision 5750aeec: FAIL CLOSED, no grandfathering).

Audits the same record set backend/scripts/stamp-agent-permissions.ts
touches via ``registry.listResources("agent")``: 'agent' AND 'app' kinds
are both included (they group together because both carry a `manifest` in
customDescriptorContent — see RegistryService.listResourcesChecked's
`isAgentOrApp` check in backend/src/services/registry-service.ts). Only
records whose kind infers to 'tool' are skipped.

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

from catalog import registry_client
from catalog.registry_client import get_agent_record  # noqa: E402


def _list_agent_records_or_raise(registry_id: str) -> list[dict]:
    """Like ``catalog.registry_client.list_agent_records``, but RAISES on a
    registry call failure instead of swallowing it.

    ``list_agent_records`` deliberately never raises — it catches
    ``ClientError`` internally and returns ``[]`` so that other callers
    (e.g. arbiter/seedConfig/index.py) can gracefully degrade on a
    transient registry outage. That contract is exactly what hides a
    genuine registry failure from this audit: a throttled/failed call and
    a truly empty, healthy registry both come back as ``[]``, so the
    audit would otherwise report "0 findings" (a clean bill of health) for
    an infrastructure error (PR-4 §3 open item: registry errors must exit
    2, never look like a clean estate).

    Replicates the same pagination loop as
    ``catalog.registry_client.list_agent_records`` (see that function for
    the authoritative shape/field mapping), but calls the shared, lazily
    constructed boto3 client directly via the module's own ``_get_client()``
    so a ``ClientError`` propagates to this script's caller instead of
    being caught.
    """
    client = registry_client._get_client()
    kwargs: dict = {"registryId": registry_id}
    items: list[dict] = []
    while True:
        response = client.list_registry_records(**kwargs)
        summaries = response.get("registryRecords")
        if summaries is None:
            summaries = response.get("records", [])
        for summary in summaries:
            items.append({
                "recordId": summary.get("recordId"),
                "name": summary.get("displayName"),
                "status": summary.get("status"),
                "updatedAt": summary.get("updatedAt"),
            })
        next_token = response.get("nextToken")
        if not next_token:
            break
        kwargs["nextToken"] = next_token
    return items


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
    every agent-or-app registry record whose requiredPermissions is
    absent/empty and which has NOT opted into the explicit
    credentialMode: "none" sentinel.

    Agent AND app records are audited (same grouping
    backend/scripts/stamp-agent-permissions.ts applies via
    listResources('agent') — see RegistryService's isAgentOrApp check).
    Only tool records are excluded.

    Raises on registry call failure so the caller can distinguish
    infrastructure errors from an empty estate.
    """
    findings: list[dict] = []
    summaries = _list_agent_records_or_raise(registry_id)
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

        # Type filter: matches backend/scripts/stamp-agent-permissions.ts's
        # registry.listResources("agent") grouping exactly — agent AND app
        # kinds both count (see RegistryService.listResourcesChecked's
        # `isAgentOrApp` check in backend/src/services/registry-service.ts,
        # which groups 'agent' and 'app' together because both carry a
        # `manifest` in customDescriptorContent; only 'tool' records lack
        # one). Excluding apps here would under-report records the stamp
        # script — and therefore the worker's fail-closed dispatch gate —
        # actually treats as agent-shaped.
        kind = _infer_kind(descriptor)
        if kind not in ("agent", "app"):
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
