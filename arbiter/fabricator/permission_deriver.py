"""Server-side, deny-default derivation of least-privilege requiredPermissions
from declared integration/data-store bindings (PR-4, owner decision 5750aeec:
FAIL CLOSED, no grandfathering).

Bundle-sibling module (entry: arbiter/fabricator) — top-level importable, no
``arbiter.`` prefix.

Computed from the SAME validated binding lists ``process_event`` already
trusts for ``org_id`` (server-derived, never an LLM tool argument) and bound
into the closure-wrapped registration tools exactly the way ``org_id`` /
``spec_id`` are today. An empty/absent binding list returns the explicit
empty permission set — deny-default — which the worker's dispatch gate
(``credential_guard`` / the two fail-closed gates in
``arbiter/workerWrapper/index.py``) refuses to run without the agent also
declaring the explicit ``credentialMode: "none"`` sentinel.
"""
from __future__ import annotations

from typing import Any

# Mirrors tools_config.get_direction_instruction's directional semantics:
# 'input' bindings only ever need read access, 'output' bindings only ever
# need write access, 'bidirectional' needs both. Unknown/missing direction
# defaults to 'bidirectional' (the same default tools_config uses) so an
# unlabelled binding is never under-permissioned relative to what the
# generated code is instructed to do.
_READ_DIRECTIONS = frozenset({"input", "bidirectional"})
_WRITE_DIRECTIONS = frozenset({"output", "bidirectional"})

EMPTY_PERMISSIONS: dict[str, list] = {"integrations": [], "dataStores": []}


def _binding_id(binding: dict, id_key: str) -> str | None:
    value = binding.get(id_key)
    return value if isinstance(value, str) and value else None


def derive_required_permissions(
    integration_bindings: list[dict[str, Any]] | None,
    datastore_bindings: list[dict[str, Any]] | None,
) -> dict[str, list]:
    """Derive a least-privilege ``requiredPermissions`` dict from declared
    bindings.

    Returns ``{"integrations": [...], "dataStores": [...]}`` with every
    bound resource id that has a non-empty direction-derived operation set.
    No bindings at all (both args falsy) returns the EXPLICIT empty set
    (:data:`EMPTY_PERMISSIONS`) — deny-default, never ``None`` — so callers
    can distinguish "we computed zero permissions" from "we never computed
    anything".

    This function does not decide whether a tool/agent MAY run with zero
    permissions (the pure-compute ``credentialMode: "none"`` sentinel is a
    SEPARATE, explicit opt-in decided by the caller/operator) — it only
    derives what the DECLARED bindings justify.
    """
    integrations: list[str] = []
    for binding in integration_bindings or []:
        if not isinstance(binding, dict):
            continue
        binding_id = _binding_id(binding, "integrationId")
        if binding_id is None:
            continue
        integrations.append(binding_id)

    data_stores: list[str] = []
    for binding in datastore_bindings or []:
        if not isinstance(binding, dict):
            continue
        binding_id = _binding_id(binding, "dataStoreId")
        if binding_id is None:
            continue
        data_stores.append(binding_id)

    return {"integrations": integrations, "dataStores": data_stores}
