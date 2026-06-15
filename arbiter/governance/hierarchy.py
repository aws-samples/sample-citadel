"""
Constitutional hierarchy loader (US-ARB-003).

Loads the four governance config tables (authority units, composition
contracts, case law, constitutional layers) from DynamoDB and caches the
result in-process for ``CACHE_TTL_SECONDS``. Applies the D2 app-scoped
filter on authority units in Python after the scan (filter expressions are
intentionally not used — the in-memory filter is clearer and Scan-with-filter
is no cheaper on read capacity).

Ported from the Agentic Fabric reference with Citadel-specific adaptations:

* boto3 resource is constructed lazily (QB-013-1) rather than at import time,
  so tests can patch ``boto3.resource`` before the first call.
* Cache is keyed by ``registry_id`` (or ``'__ALL__'`` when no filter is supplied)
  because different callers may legitimately request different scopes of the
  authority graph.
* Missing table env vars produce a logged warning and an empty list for that
  domain — the loader must remain callable in partially-provisioned
  environments (AC 4).
"""

from __future__ import annotations

import json
import logging
import os
import time
from dataclasses import dataclass, field
from typing import Any

import boto3

from .models import (
    ArbitrationDecision,
    AuthorityScope,
    AuthorityUnit,
    CaseLawEntry,
    CompositionContract,
    ConflictResolution,
    ConstitutionalLayer,
)

logger = logging.getLogger(__name__)


CACHE_TTL_SECONDS = 300
_GLOBAL_REGISTRY_ID = "*GLOBAL*"
_CACHE_KEY_ALL = "__ALL__"


# ---------------------------------------------------------------------------
# Public dataclass
# ---------------------------------------------------------------------------


@dataclass
class GovernanceState:
    """Snapshot of the four governance config tables at ``loaded_at``.

    ``registry_id`` records the filter that produced this snapshot:

    * ``None`` — no filter was applied; all authority units are present.
    * any string — only ``authority_units`` with ``registryId`` equal to this
      value or to ``'*GLOBAL*'`` are present. The other three collections are
      always unfiltered.
    """

    authority_units: list[AuthorityUnit] = field(default_factory=list)
    composition_contracts: list[CompositionContract] = field(default_factory=list)
    case_law: list[CaseLawEntry] = field(default_factory=list)
    constitutional_layers: list[ConstitutionalLayer] = field(default_factory=list)
    loaded_at: float = 0.0
    registry_id: str | None = None


# ---------------------------------------------------------------------------
# Module-level cache
# ---------------------------------------------------------------------------


# Maps cache key (registry_id or _CACHE_KEY_ALL) to (state, loaded_at).
_cache: dict[str, tuple[GovernanceState, float]] = {}


# ---------------------------------------------------------------------------
# Lazy DDB resource accessor (QB-013-1: do NOT construct at import time)
# ---------------------------------------------------------------------------


def _get_dynamodb_resource() -> Any:
    """Return a boto3 DynamoDB resource, constructed on demand.

    Constructing the resource lazily lets tests patch ``boto3.resource``
    before this function is first called, and avoids triggering AWS
    credential discovery at import time.
    """
    return boto3.resource("dynamodb")


# ---------------------------------------------------------------------------
# Scan helpers
# ---------------------------------------------------------------------------


def _scan_all(table: Any) -> list[dict]:
    """Scan a DDB table and collect every page into a single list."""
    items: list[dict] = []
    kwargs: dict[str, Any] = {}
    while True:
        response = table.scan(**kwargs)
        items.extend(response.get("Items", []))
        last_key = response.get("LastEvaluatedKey")
        if not last_key:
            break
        kwargs["ExclusiveStartKey"] = last_key
    return items


def _maybe_json(value: Any, default: Any) -> Any:
    """Accept a value that may be a JSON string or already-decoded object.

    DDB items deserialised by boto3 are normally dicts/lists, but some
    writers store nested structures as JSON strings. Accept either shape
    so the loader stays forward-compatible.
    """
    if value is None:
        return default
    if isinstance(value, str):
        try:
            return json.loads(value)
        except (json.JSONDecodeError, TypeError):
            return default
    return value


def _scan_table_by_env(env_var: str) -> list[dict] | None:
    """Resolve ``env_var`` to a table name and scan it.

    Returns ``None`` when the env var is unset (caller emits a warning and
    returns an empty domain list). Returns a (possibly empty) list of raw
    items otherwise.
    """
    table_name = os.environ.get(env_var)
    if not table_name:
        logger.warning(
            "Governance loader: %s is not set; loading empty list for this domain.",
            env_var,
        )
        return None
    table = _get_dynamodb_resource().Table(table_name)
    return _scan_all(table)


# ---------------------------------------------------------------------------
# Row deserialisers — each tolerates missing / extra fields for forward compat
# ---------------------------------------------------------------------------


def _scope_from_item(item: dict) -> AuthorityScope:
    scope_data = _maybe_json(item.get("scope"), {}) or {}
    return AuthorityScope(
        decision_type=scope_data.get("decision_type", "*"),
        domain=scope_data.get("domain", "*"),
        conditions=scope_data.get("conditions", {}) or {},
        limits=scope_data.get("limits", {}) or {},
    )


def _authority_unit_from_item(item: dict) -> AuthorityUnit | None:
    try:
        unit_id = item["unitId"]
        agent_id = item["agentId"]
    except KeyError as exc:
        logger.warning(
            "Skipping malformed authority unit row (missing %s): keys=%s",
            exc,
            list(item.keys()),
        )
        return None
    expiry = item.get("expiryTimestamp")
    try:
        expiry_value = float(expiry) if expiry is not None else None
    except (TypeError, ValueError):
        expiry_value = None
    return AuthorityUnit(
        unit_id=unit_id,
        agent_id=agent_id,
        scope=_scope_from_item(item),
        delegation_source=item.get("delegationSource"),
        can_redelegate=bool(item.get("canRedelegate", False)),
        expiry_timestamp=expiry_value,
        revoked=bool(item.get("revoked", False)),
        risk_rating=item.get("riskRating", "low"),
        registry_id=item.get("registryId"),
    )


def _composition_contract_from_item(item: dict) -> CompositionContract | None:
    try:
        contract_id = item["contractId"]
        party_a = item["partyA"]
        party_b = item["partyB"]
    except KeyError as exc:
        logger.warning(
            "Skipping malformed composition contract row (missing %s): keys=%s",
            exc,
            list(item.keys()),
        )
        return None
    invariants = _maybe_json(item.get("invariants"), []) or []
    stop_rights = _maybe_json(item.get("stopRights"), []) or []
    try:
        conflict_resolution = ConflictResolution(
            item.get("conflictResolution", ConflictResolution.DEFAULT_DENY.value)
        )
    except ValueError:
        conflict_resolution = ConflictResolution.DEFAULT_DENY
    return CompositionContract(
        contract_id=contract_id,
        party_a=party_a,
        party_b=party_b,
        authority_precedence=item.get("authorityPrecedence", "none"),
        invariants=list(invariants),
        conflict_resolution=conflict_resolution,
        stop_rights=list(stop_rights),
        scope=_scope_from_item(item),
        escalation_path=item.get("escalationPath"),
    )


def _case_law_from_item(item: dict) -> CaseLawEntry | None:
    # US-ARB-013: skip revoked rows at load time so they never reach the
    # engine. Schema is reconciled with the CDK ``CaseLawTable``:
    #   entryId    (PK, string) -> CaseLawEntry.case_id
    #   pattern    (map)        -> CaseLawEntry.pattern
    #   resolution (string)     -> CaseLawEntry.resolution
    #   createdAt  (ISO-8601)   -> CaseLawEntry.encoded_at (kept as string)
    #   createdBy  (string)     -> CaseLawEntry.encoded_by
    #   scopeOfApplicability    -> CaseLawEntry.scope_of_applicability
    #   precedence (number)     -> CaseLawEntry.precedence
    #   revoked    (bool)       -> filtered here; not re-surfaced
    if item.get("revoked", False):
        return None
    try:
        case_id = item["entryId"]
        resolution_raw = item["resolution"]
    except KeyError as exc:
        logger.warning(
            "Skipping malformed case-law row (missing %s): keys=%s",
            exc,
            list(item.keys()),
        )
        return None
    try:
        resolution = ArbitrationDecision(resolution_raw)
    except ValueError:
        logger.warning(
            "Skipping case-law row with unknown resolution %r (entryId=%s)",
            resolution_raw,
            case_id,
        )
        return None
    pattern = _maybe_json(item.get("pattern"), {}) or {}
    scope_of_applicability = _maybe_json(item.get("scopeOfApplicability"), {}) or {}
    # createdAt is an ISO-8601 string in the CDK schema; coerce to str defensively.
    encoded_at = str(item.get("createdAt", ""))
    try:
        precedence = int(item.get("precedence", 0))
    except (TypeError, ValueError):
        precedence = 0
    return CaseLawEntry(
        case_id=case_id,
        pattern=pattern,
        resolution=resolution,
        encoded_at=encoded_at,
        encoded_by=item.get("createdBy", "unknown"),
        scope_of_applicability=scope_of_applicability,
        precedence=precedence,
        revoked=False,  # filtered above
    )


def _constitutional_layer_from_item(item: dict) -> ConstitutionalLayer | None:
    try:
        layer_id = item["layerId"]
    except KeyError:
        logger.warning(
            "Skipping malformed constitutional-layer row (missing layerId): keys=%s",
            list(item.keys()),
        )
        return None
    applies_to = _maybe_json(item.get("appliesTo"), []) or []
    rules = _maybe_json(item.get("rules"), []) or []
    return ConstitutionalLayer(
        layer_id=layer_id,
        layer_type=item.get("layerType", "global"),
        applies_to=list(applies_to),
        rules=list(rules),
        parent_layer_id=item.get("parentLayerId"),
    )


# ---------------------------------------------------------------------------
# Per-domain loaders
# ---------------------------------------------------------------------------


def _load_authority_units() -> list[AuthorityUnit]:
    items = _scan_table_by_env("AUTHORITY_UNITS_TABLE")
    if items is None:
        return []
    result: list[AuthorityUnit] = []
    for item in items:
        unit = _authority_unit_from_item(item)
        if unit is not None:
            result.append(unit)
    return result


def _load_composition_contracts() -> list[CompositionContract]:
    items = _scan_table_by_env("COMPOSITION_CONTRACTS_TABLE")
    if items is None:
        return []
    result: list[CompositionContract] = []
    for item in items:
        contract = _composition_contract_from_item(item)
        if contract is not None:
            result.append(contract)
    return result


def _load_case_law() -> list[CaseLawEntry]:
    items = _scan_table_by_env("CASE_LAW_TABLE")
    if items is None:
        return []
    result: list[CaseLawEntry] = []
    for item in items:
        entry = _case_law_from_item(item)
        if entry is not None:
            result.append(entry)
    # Highest precedence first — stable ordering across reloads.
    result.sort(key=lambda e: -e.precedence)
    return result


def _load_constitutional_layers() -> list[ConstitutionalLayer]:
    items = _scan_table_by_env("CONSTITUTIONAL_LAYERS_TABLE")
    if items is None:
        return []
    result: list[ConstitutionalLayer] = []
    for item in items:
        layer = _constitutional_layer_from_item(item)
        if layer is not None:
            result.append(layer)
    return result


# ---------------------------------------------------------------------------
# D2 filter
# ---------------------------------------------------------------------------


def _apply_registry_filter(
    units: list[AuthorityUnit], registry_id: str | None
) -> list[AuthorityUnit]:
    """Apply the D2 app-scoped filter on authority units.

    When ``registry_id`` is ``None`` the input is returned unchanged. Otherwise
    only units whose ``registryId`` equals ``registry_id`` or the global sentinel
    ``'*GLOBAL*'`` are retained. Units with no ``registryId`` at all are dropped
    because the D2 rule requires an explicit scope.
    """
    if registry_id is None:
        return units
    allowed = {registry_id, _GLOBAL_REGISTRY_ID}
    return [u for u in units if u.registry_id in allowed]


# ---------------------------------------------------------------------------
# Public entry points
# ---------------------------------------------------------------------------


def load_governance_state(
    registry_id: str | None = None,
    force_reload: bool = False,
) -> GovernanceState:
    """Load the full governance state from DDB, applying the D2 app filter.

    Args:
        registry_id: When provided, authority units are filtered to those whose
            ``registryId`` matches ``registry_id`` or the ``'*GLOBAL*'`` sentinel.
            The other three collections are always unfiltered.
        force_reload: When ``True``, bypasses the cache entry for this
            ``registry_id`` key and re-scans every table.

    Returns:
        A ``GovernanceState`` snapshot.
    """
    cache_key = registry_id if registry_id is not None else _CACHE_KEY_ALL
    now = time.time()

    if not force_reload:
        cached = _cache.get(cache_key)
        if cached is not None:
            state, loaded_at = cached
            if now - loaded_at < CACHE_TTL_SECONDS:
                return state

    # Cache miss (or forced): drop the single entry and re-scan.
    _cache.pop(cache_key, None)

    authority_units = _apply_registry_filter(_load_authority_units(), registry_id)
    composition_contracts = _load_composition_contracts()
    case_law = _load_case_law()
    constitutional_layers = _load_constitutional_layers()

    loaded_at = time.time()
    state = GovernanceState(
        authority_units=authority_units,
        composition_contracts=composition_contracts,
        case_law=case_law,
        constitutional_layers=constitutional_layers,
        loaded_at=loaded_at,
        registry_id=registry_id,
    )
    _cache[cache_key] = (state, loaded_at)

    logger.info(
        "Governance state loaded (registry_id=%s): %d units, %d contracts, "
        "%d case-law entries, %d layers.",
        registry_id,
        len(authority_units),
        len(composition_contracts),
        len(case_law),
        len(constitutional_layers),
    )
    return state


def __reset_hierarchy_cache_for_test() -> None:
    """Clear the process-local cache.

    Test-only helper. Safe to call from production code — the next request
    will simply re-scan the tables.
    """
    _cache.clear()
