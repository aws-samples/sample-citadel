"""Pure mapping from persisted items to resolver types.

Maps the raw DynamoDB item shapes for the platform model-config and
model-catalog tables onto the dependency-free value types in
``common.model_types``, and delegates the actual selection to the pure
``common.model_resolver.resolve_model``. Callers (the per-slot I/O loaders)
fetch the config + catalog items themselves and wrap these helpers with their
own fallback. This module is intentionally pure: no boto3, no AWS clients, no
``os``/environment reads, no I/O, no global state.
"""
from __future__ import annotations

from common.model_resolver import resolve_model
from common.model_types import (
    CatalogEntry,
    InvocationMode,
    LocalityMode,
    Modality,
    ModelConfig,
    ModelStatus,
    SlotRequirements,
)


def catalog_entry_from_item(item) -> CatalogEntry:
    """Map a raw DynamoDB catalog item to a ``CatalogEntry``.

    Enum-valued fields are coerced through their enum constructors; absent
    enum fields default to the safe values (``disabled`` / ``text`` /
    ``converse``). Absent booleans and ``regionProfiles`` fall back to the
    value-type defaults.
    """
    return CatalogEntry(
        model_key=item['modelKey'],
        provider=item.get('provider', ''),
        base_model_id=item.get('baseModelId', ''),
        status=ModelStatus(item.get('status') or 'disabled'),
        modality=Modality(item.get('modality') or 'text'),
        invocation_mode=InvocationMode(item.get('invocationMode') or 'converse'),
        supports_tools=bool(item.get('supportsTools', False)),
        supports_system_prompt=bool(item.get('supportsSystemPrompt', True)),
        supports_streaming=bool(item.get('supportsStreaming', True)),
        region_profiles=item.get('regionProfiles') or {},
    )


def catalog_from_items(items) -> dict[str, CatalogEntry]:
    """Map raw DynamoDB catalog items to a ``{model_key: CatalogEntry}`` map.

    The resolver expects a mapping keyed by model key, so the entries are
    collected into a dict keyed on each entry's ``model_key``.
    """
    catalog: dict[str, CatalogEntry] = {}
    for item in items:
        entry = catalog_entry_from_item(item)
        catalog[entry.model_key] = entry
    return catalog


def model_config_from_item(item) -> ModelConfig:
    """Map a raw DynamoDB config item to a ``ModelConfig``.

    Absent maps default to ``{}`` and an absent (or empty) ``localityMode``
    defaults to ``off``.
    """
    return ModelConfig(
        global_default_key=item.get('globalDefaultKey'),
        slot_defaults=item.get('slotDefaults') or {},
        org_defaults=item.get('orgDefaults') or {},
        agent_overrides=item.get('agentOverrides') or {},
        locality_mode=LocalityMode(item.get('localityMode') or 'off'),
    )


def resolve_model_id_from_items(
    *,
    slot,
    requirements,
    config_item,
    catalog_items,
    region,
    fallback_model_id,
) -> str:
    """Resolve an effective model id from raw persisted items.

    When ``config_item`` is falsy (missing/empty) the caller-supplied
    ``fallback_model_id`` is returned without consulting the catalog.
    Otherwise the config + catalog items are mapped to resolver types and
    ``resolve_model`` selects the effective inference-profile id.
    """
    if not config_item:
        return fallback_model_id
    config = model_config_from_item(config_item)
    catalog = catalog_from_items(catalog_items or [])
    return resolve_model(
        slot,
        requirements,
        config,
        catalog,
        region,
        fallback_model_id,
    ).model_id
