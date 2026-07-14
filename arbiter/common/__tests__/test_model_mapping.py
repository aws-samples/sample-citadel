"""Unit tests for the pure item->dataclass mapping kernel.

Covers the raw-item mappers (catalog + config), the catalog dict builder, and
the end-to-end ``resolve_model_id_from_items`` helper — including the
missing-config fallback and a happy-path regional-profile resolution. All ids
are generic placeholders (``p.model-x`` / ``us.p.model-x``); never a real
provider/Bedrock model id.
"""
from __future__ import annotations

from common.model_mapping import (
    catalog_entry_from_item,
    catalog_from_items,
    model_config_from_item,
    resolve_model_id_from_items,
    resolve_model_key_to_id,
)
from common.model_types import (
    CatalogEntry,
    InvocationMode,
    LocalityMode,
    Modality,
    ModelConfig,
    ModelStatus,
    SlotRequirements,
)

_FALLBACK = 'fallback.p.model-x'


def test_catalog_entry_from_item_maps_all_fields_and_coerces_enums():
    item = {
        'modelKey': 'mx',
        'provider': 'p',
        'baseModelId': 'p.model-x',
        'status': 'enabled',
        'modality': 'text',
        'invocationMode': 'converse',
        'supportsTools': True,
        'supportsSystemPrompt': False,
        'supportsStreaming': False,
        'regionProfiles': {'us': 'us.p.model-x'},
    }

    entry = catalog_entry_from_item(item)

    assert entry == CatalogEntry(
        model_key='mx',
        provider='p',
        base_model_id='p.model-x',
        status=ModelStatus.ENABLED,
        modality=Modality.TEXT,
        invocation_mode=InvocationMode.CONVERSE,
        supports_tools=True,
        supports_system_prompt=False,
        supports_streaming=False,
        region_profiles={'us': 'us.p.model-x'},
    )
    # Coerced into enum members, not left as raw strings.
    assert isinstance(entry.status, ModelStatus)
    assert isinstance(entry.modality, Modality)
    assert isinstance(entry.invocation_mode, InvocationMode)


def test_catalog_entry_from_item_applies_defaults_for_absent_fields():
    entry = catalog_entry_from_item({'modelKey': 'mx'})

    assert entry.provider == ''
    assert entry.base_model_id == ''
    assert entry.status == ModelStatus.DISABLED
    assert entry.modality == Modality.TEXT
    assert entry.invocation_mode == InvocationMode.CONVERSE
    assert entry.supports_tools is False
    assert entry.supports_system_prompt is True
    assert entry.supports_streaming is True
    assert entry.region_profiles == {}


def test_model_config_from_item_maps_fields():
    cfg = model_config_from_item({
        'globalDefaultKey': 'mx',
        'slotDefaults': {'supervisor': 'ms'},
        'orgDefaults': {'supervisor': 'mo'},
        'agentOverrides': {'agent-1': 'ma'},
        'localityMode': 'strict',
    })

    assert cfg == ModelConfig(
        global_default_key='mx',
        slot_defaults={'supervisor': 'ms'},
        org_defaults={'supervisor': 'mo'},
        agent_overrides={'agent-1': 'ma'},
        locality_mode=LocalityMode.STRICT,
    )
    assert isinstance(cfg.locality_mode, LocalityMode)


def test_model_config_from_item_applies_defaults_for_absent_fields():
    cfg = model_config_from_item({})

    assert cfg.global_default_key is None
    assert cfg.slot_defaults == {}
    assert cfg.org_defaults == {}
    assert cfg.agent_overrides == {}
    assert cfg.locality_mode == LocalityMode.OFF


def test_catalog_from_items_keys_by_model_key():
    catalog = catalog_from_items([
        {'modelKey': 'a', 'baseModelId': 'p.a'},
        {'modelKey': 'b', 'baseModelId': 'p.b'},
    ])

    assert set(catalog) == {'a', 'b'}
    assert catalog['a'].base_model_id == 'p.a'
    assert catalog['b'].base_model_id == 'p.b'


def test_resolve_model_id_from_items_returns_fallback_when_config_item_none():
    result = resolve_model_id_from_items(
        slot='supervisor',
        requirements=SlotRequirements(),
        config_item=None,
        catalog_items=[],
        region='us-east-1',
        fallback_model_id=_FALLBACK,
    )

    assert result == _FALLBACK


def test_resolve_model_id_from_items_resolves_regional_profile():
    config_item = {
        'globalDefaultKey': 'mx',
        'slotDefaults': {},
        'orgDefaults': {},
        'agentOverrides': {},
        'localityMode': 'off',
    }
    catalog_items = [{
        'modelKey': 'mx',
        'provider': 'p',
        'baseModelId': 'p.model-x',
        'status': 'enabled',
        'modality': 'text',
        'invocationMode': 'converse',
        'supportsTools': True,
        'supportsSystemPrompt': True,
        'supportsStreaming': True,
        'regionProfiles': {'us': 'us.p.model-x', 'global': 'global.p.model-x'},
    }]

    result = resolve_model_id_from_items(
        slot='supervisor',
        requirements=SlotRequirements(
            requires_tools=True,
            modality=Modality.TEXT,
            requires_converse=True,
        ),
        config_item=config_item,
        catalog_items=catalog_items,
        region='us-east-1',
        fallback_model_id=_FALLBACK,
    )

    # us-east-1 -> prefix 'us' -> the regional profile is preferred.
    assert result == 'us.p.model-x'
    assert result != _FALLBACK


# ---------------------------------------------------------------------------
# resolve_model_key_to_id — single-key resolution for per-agent overrides
# ---------------------------------------------------------------------------


def test_resolve_model_key_to_id_enabled_key_resolves_regional_profile():
    catalog_items = [{
        'modelKey': 'mx',
        'provider': 'p',
        'baseModelId': 'p.model-x',
        'status': 'enabled',
        'modality': 'text',
        'invocationMode': 'converse',
        'supportsTools': True,
        'supportsSystemPrompt': True,
        'supportsStreaming': True,
        'regionProfiles': {'us': 'us.p.model-x', 'global': 'global.p.model-x'},
    }]

    result = resolve_model_key_to_id('mx', catalog_items, 'us-east-1', LocalityMode.OFF)

    # us-east-1 -> prefix 'us' -> the regional profile is preferred.
    assert result == 'us.p.model-x'


def test_resolve_model_key_to_id_unknown_key_returns_none():
    catalog_items = [{
        'modelKey': 'mx',
        'baseModelId': 'p.model-x',
        'status': 'enabled',
        'regionProfiles': {'us': 'us.p.model-x'},
    }]

    assert resolve_model_key_to_id('missing', catalog_items, 'us-east-1', LocalityMode.OFF) is None


def test_resolve_model_key_to_id_disabled_entry_returns_none():
    catalog_items = [{
        'modelKey': 'mx',
        'baseModelId': 'p.model-x',
        'status': 'disabled',
        'regionProfiles': {'us': 'us.p.model-x'},
    }]

    assert resolve_model_key_to_id('mx', catalog_items, 'us-east-1', LocalityMode.OFF) is None


def test_resolve_model_key_to_id_empty_or_none_key_returns_none():
    assert resolve_model_key_to_id('', [], 'us-east-1', LocalityMode.OFF) is None
    assert resolve_model_key_to_id(None, [], 'us-east-1', LocalityMode.OFF) is None


def test_resolve_model_key_to_id_strict_locality_without_regional_returns_none():
    catalog_items = [{
        'modelKey': 'mx',
        'provider': 'p',
        'baseModelId': 'p.model-x',
        'status': 'enabled',
        'modality': 'text',
        'invocationMode': 'converse',
        'supportsTools': True,
        # Only a global profile is known — no regional profile for prefix 'us'.
        'regionProfiles': {'global': 'global.p.model-x'},
    }]

    result = resolve_model_key_to_id('mx', catalog_items, 'us-east-1', LocalityMode.STRICT)

    assert result is None
