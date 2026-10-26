"""Tenant isolation enforcement for arbiter record reads.

Every read of an agent/tool record in the arbiter layer MUST pass through
require_same_org() (point reads) or filter_by_org() (scans) before the record
is used for dispatch, catalogue building, or code execution.  A mismatch fails
CLOSED — the record is rejected, a structured log is emitted, and a best-effort
CloudWatch metric is published.

System records:
    Records with orgId == '' (empty string) are platform-seeded / shared.
    Callers that need these records set ``allow_system=True``.
"""
from __future__ import annotations

import logging
from typing import Any

logger = logging.getLogger(__name__)

_METRIC_NAMESPACE = "Citadel/Arbiter"
_METRIC_NAME = "TenantOrgMismatch"
_ORG_UNKNOWN_METRIC = "OrgUnknownRecord"


class OrgMismatchError(Exception):
    """Raised when a record's org does not match the bound execution org."""

    def __init__(
        self,
        record_org: str,
        bound_org: str,
        record_id: str,
        component: str,
    ) -> None:
        self.record_org = record_org
        self.bound_org = bound_org
        self.record_id = record_id
        self.component = component
        super().__init__(
            f"org mismatch: record '{record_id}' has org='{record_org}', "
            f"expected='{bound_org}' (component={component})"
        )


def require_same_org(
    record: dict[str, Any],
    bound_org: str,
    *,
    record_id_field: str = "agentId",
    org_field: str = "orgId",
    component: str = "unknown",
    allow_system: bool = False,
) -> None:
    """Assert that *record[org_field]* matches *bound_org*.  Fails closed.

    Args:
        record: The DynamoDB item or registry record.
        bound_org: The org_id bound to the current unit of work.
        record_id_field: Key to use for the record identifier in logs/errors.
        org_field: Key on the record that holds the org_id.
        component: Caller component name for structured metrics.
        allow_system: If ``True``, records with ``orgId == ''`` are allowed
            through (for platform-seeded agents).  Default ``False``.

    Raises:
        OrgMismatchError: on mismatch or missing orgId.
    """
    record_id = record.get(record_id_field, "<unknown>")

    # orgUnknown rows: the record's org was never set (pre-tagging legacy).
    # Fail closed — never treat as system-shared.
    if record.get("orgUnknown"):
        logger.warning(
            "tenant_guard: OrgUnknownRecord record_id=%s component=%s — excluded (fail-closed)",
            record_id,
            component,
        )
        _emit_metric(_ORG_UNKNOWN_METRIC, component, record_id)
        raise OrgMismatchError("<unknown>", bound_org, record_id, component)

    record_org = record.get(org_field)

    # Absent orgId (org_field not present at all) — fail closed.
    if record_org is None:
        logger.warning(
            "tenant_guard: OrgUnknownRecord record_id=%s component=%s — orgId absent, excluded (fail-closed)",
            record_id,
            component,
        )
        _emit_metric(_ORG_UNKNOWN_METRIC, component, record_id)
        raise OrgMismatchError("<absent>", bound_org, record_id, component)

    # System / shared records (empty-string convention)
    if allow_system and record_org == "":
        return

    if record_org != bound_org:
        logger.error(
            "tenant_guard: %s record_id=%s record_org=%s bound_org=%s component=%s",
            _METRIC_NAME,
            record_id,
            record_org,
            bound_org,
            component,
        )
        _emit_metric(_METRIC_NAME, component, record_id)
        raise OrgMismatchError(record_org, bound_org, record_id, component)


def filter_by_org(
    items: list[dict[str, Any]],
    bound_org: str,
    *,
    org_field: str = "orgId",
    allow_system: bool = False,
    component: str = "unknown",
) -> list[dict[str, Any]]:
    """Filter a list of records to only those matching *bound_org*.

    Used for scan-then-filter paths (supervisor catalogue, fabricator tool
    catalogue) where the table lacks an orgId GSI.  Each rejected record
    emits a warning-level log.

    Records with ``orgUnknown == True`` or a missing orgId are excluded
    (fail-closed) with an ``OrgUnknownRecord`` metric.
    """
    result: list[dict[str, Any]] = []
    for item in items:
        # orgUnknown rows: org was never set — fail closed.
        if item.get("orgUnknown"):
            record_id = item.get("agentId") or item.get("toolId") or "<unknown>"
            logger.warning(
                "tenant_guard: OrgUnknownRecord record=%s component=%s — excluded from %s catalogue",
                record_id,
                component,
                component,
            )
            _emit_metric(_ORG_UNKNOWN_METRIC, component, str(record_id))
            continue
        item_org = item.get(org_field)
        if item_org is None:
            record_id = item.get("agentId") or item.get("toolId") or "<unknown>"
            logger.warning(
                "tenant_guard: OrgUnknownRecord record=%s component=%s — orgId absent, excluded from %s catalogue",
                record_id,
                component,
                component,
            )
            _emit_metric(_ORG_UNKNOWN_METRIC, component, str(record_id))
            continue
        if item_org == bound_org:
            result.append(item)
        elif allow_system and item_org == "":
            result.append(item)
        else:
            logger.warning(
                "tenant_guard: filtered out record org=%s from %s catalogue (bound_org=%s)",
                item_org,
                component,
                bound_org,
            )
    return result


def _emit_metric(metric_name: str, component: str, record_id: str) -> None:
    """Best-effort CloudWatch metric.  Never raises."""
    try:
        import boto3

        cw = boto3.client("cloudwatch")
        cw.put_metric_data(
            Namespace=_METRIC_NAMESPACE,
            MetricData=[
                {
                    "MetricName": metric_name,
                    "Dimensions": [
                        {"Name": "Component", "Value": component},
                    ],
                    "Value": 1,
                    "Unit": "Count",
                },
            ],
        )
    except Exception:  # noqa: BLE001 — metrics are best-effort
        pass
