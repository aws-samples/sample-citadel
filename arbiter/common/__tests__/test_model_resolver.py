"""Unit and property tests for pure model resolution.

All model ids and profile ids used here are generic placeholders; region
prefixes are always derived from ``cross_region_prefix`` (plus the ``'global'``
sentinel), never hardcoded, so the suite exercises behaviour without baking in
any provider-specific identifiers.
"""
import pytest
from hypothesis import given, settings, strategies as st

from common.region import cross_region_prefix
from common.model_types import (
    CatalogEntry,
    InvocationMode,
    LocalityMode,
    Modality,
    ModelConfig,
    ModelStatus,
    ProfileScope,
    ResolutionSource,
    ResolvedModel,
    SlotRequirements,
)
from common.model_resolver import (
    candidate_chain,
    is_valid_for_slot,
    resolve_model,
    resolve_profile,
)

# Caller-supplied fallback default. The resolver never hardcodes this.
BOOTSTRAP = 'caller-supplied-default'


def make_entry(
    model_key,
    *,
    status=ModelStatus.ENABLED,
    modality=Modality.TEXT,
    invocation_mode=InvocationMode.CONVERSE,
    supports_tools=True,
    base_model_id='base',
    provider='prov',
    region_profiles=None,
):
    """Build a CatalogEntry with usable, tool-capable text defaults."""
    return CatalogEntry(
        model_key=model_key,
        provider=provider,
        base_model_id=base_model_id,
        status=status,
        modality=modality,
        invocation_mode=invocation_mode,
        supports_tools=supports_tools,
        region_profiles=dict(region_profiles or {}),
    )


# ---------------------------------------------------------------------------
# Unit tests
# ---------------------------------------------------------------------------
def test_agent_override_wins_when_valid():
    catalog = {'k_agent': make_entry('k_agent'), 'k_global': make_entry('k_global')}
    config = ModelConfig(
        global_default_key='k_global',
        slot_defaults={'chat': 'k_global'},
        org_defaults={'chat': 'k_global'},
        agent_overrides={'agent-1': 'k_agent'},
    )
    result = resolve_model(
        'chat', SlotRequirements(), config, catalog, 'us-east-1', BOOTSTRAP, agent_id='agent-1'
    )
    assert result.source == ResolutionSource.AGENT
    assert result.model_key == 'k_agent'


def test_falls_through_to_org_when_no_agent():
    catalog = {'k_org': make_entry('k_org'), 'k_slot': make_entry('k_slot')}
    config = ModelConfig(org_defaults={'chat': 'k_org'}, slot_defaults={'chat': 'k_slot'})
    result = resolve_model('chat', SlotRequirements(), config, catalog, 'us-east-1', BOOTSTRAP)
    assert result.source == ResolutionSource.ORG
    assert result.model_key == 'k_org'


def test_falls_through_to_slot_when_no_agent_or_org():
    catalog = {'k_slot': make_entry('k_slot'), 'k_global': make_entry('k_global')}
    config = ModelConfig(slot_defaults={'chat': 'k_slot'}, global_default_key='k_global')
    result = resolve_model('chat', SlotRequirements(), config, catalog, 'us-east-1', BOOTSTRAP)
    assert result.source == ResolutionSource.SLOT
    assert result.model_key == 'k_slot'


def test_falls_through_to_global_when_only_global():
    catalog = {'k_global': make_entry('k_global')}
    config = ModelConfig(global_default_key='k_global')
    result = resolve_model('chat', SlotRequirements(), config, catalog, 'us-east-1', BOOTSTRAP)
    assert result.source == ResolutionSource.GLOBAL
    assert result.model_key == 'k_global'


@pytest.mark.parametrize(
    'status', [ModelStatus.DISABLED, ModelStatus.DEPRECATED, ModelStatus.DISCOVERED]
)
def test_non_enabled_entry_is_skipped(status):
    catalog = {'k_bad': make_entry('k_bad', status=status), 'k_good': make_entry('k_good')}
    config = ModelConfig(agent_overrides={'a': 'k_bad'}, global_default_key='k_good')
    result = resolve_model(
        'chat', SlotRequirements(), config, catalog, 'us-east-1', BOOTSTRAP, agent_id='a'
    )
    assert result.model_key == 'k_good'
    assert result.source == ResolutionSource.GLOBAL


def test_tool_requirement_skips_non_tool_model():
    catalog = {
        'k_notools': make_entry('k_notools', supports_tools=False),
        'k_tools': make_entry('k_tools', supports_tools=True),
    }
    config = ModelConfig(agent_overrides={'a': 'k_notools'}, global_default_key='k_tools')
    result = resolve_model(
        'chat', SlotRequirements(requires_tools=True), config, catalog, 'us-east-1',
        BOOTSTRAP, agent_id='a',
    )
    assert result.model_key == 'k_tools'


def test_modality_mismatch_is_skipped():
    catalog = {
        'k_embed': make_entry('k_embed', modality=Modality.EMBEDDING),
        'k_text': make_entry('k_text', modality=Modality.TEXT),
    }
    config = ModelConfig(agent_overrides={'a': 'k_embed'}, global_default_key='k_text')
    result = resolve_model(
        'chat', SlotRequirements(modality=Modality.TEXT), config, catalog, 'us-east-1',
        BOOTSTRAP, agent_id='a',
    )
    assert result.model_key == 'k_text'


def test_regional_profile_chosen_when_present():
    prefix = cross_region_prefix('us-east-1')
    catalog = {'k': make_entry('k', region_profiles={prefix: 'regional-profile'})}
    config = ModelConfig(global_default_key='k')
    result = resolve_model('chat', SlotRequirements(), config, catalog, 'us-east-1', BOOTSTRAP)
    assert result.model_id == 'regional-profile'
    assert result.profile_scope == ProfileScope.REGIONAL
    assert result.warnings == ()


def test_global_fallback_off_has_no_warning():
    catalog = {'k': make_entry('k', region_profiles={'global': 'global-profile'})}
    config = ModelConfig(global_default_key='k', locality_mode=LocalityMode.OFF)
    result = resolve_model('chat', SlotRequirements(), config, catalog, 'us-east-1', BOOTSTRAP)
    assert result.model_id == 'global-profile'
    assert result.profile_scope == ProfileScope.GLOBAL
    assert result.warnings == ()


def test_global_fallback_regional_preferred_warns():
    catalog = {'k': make_entry('k', region_profiles={'global': 'global-profile'})}
    config = ModelConfig(global_default_key='k', locality_mode=LocalityMode.REGIONAL_PREFERRED)
    result = resolve_model('chat', SlotRequirements(), config, catalog, 'us-east-1', BOOTSTRAP)
    assert result.model_id == 'global-profile'
    assert result.profile_scope == ProfileScope.GLOBAL
    assert len(result.warnings) == 1


def test_strict_without_regional_blocks_and_falls_to_bootstrap():
    catalog = {'k': make_entry('k', region_profiles={'global': 'global-profile'})}
    config = ModelConfig(global_default_key='k', locality_mode=LocalityMode.STRICT)
    result = resolve_model('chat', SlotRequirements(), config, catalog, 'us-east-1', BOOTSTRAP)
    assert result.source == ResolutionSource.BOOTSTRAP
    assert result.model_id == BOOTSTRAP
    assert result.profile_scope != ProfileScope.GLOBAL


def test_strict_falls_through_to_next_candidate_with_regional():
    prefix = cross_region_prefix('us-east-1')
    catalog = {
        'k_blocked': make_entry('k_blocked', region_profiles={'global': 'global-profile'}),
        'k_ok': make_entry('k_ok', region_profiles={prefix: 'regional-profile'}),
    }
    config = ModelConfig(
        agent_overrides={'a': 'k_blocked'},
        global_default_key='k_ok',
        locality_mode=LocalityMode.STRICT,
    )
    result = resolve_model(
        'chat', SlotRequirements(), config, catalog, 'us-east-1', BOOTSTRAP, agent_id='a'
    )
    assert result.model_key == 'k_ok'
    assert result.profile_scope == ProfileScope.REGIONAL


def test_construction_fallback_for_empty_profiles_under_off():
    base = 'placeholder-base'
    catalog = {'k': make_entry('k', base_model_id=base, region_profiles={})}
    config = ModelConfig(global_default_key='k', locality_mode=LocalityMode.OFF)
    prefix = cross_region_prefix('us-east-1')
    result = resolve_model('chat', SlotRequirements(), config, catalog, 'us-east-1', BOOTSTRAP)
    assert result.model_id == f"{prefix}.{base}"
    assert result.profile_scope == ProfileScope.REGIONAL
    assert len(result.warnings) == 1


def test_bootstrap_when_catalog_empty():
    config = ModelConfig(global_default_key='k_missing')
    result = resolve_model('chat', SlotRequirements(), config, {}, 'us-east-1', BOOTSTRAP)
    assert result.source == ResolutionSource.BOOTSTRAP
    assert result.model_id == BOOTSTRAP
    assert result.model_key is None


def test_bootstrap_when_no_configured_defaults():
    result = resolve_model('chat', SlotRequirements(), ModelConfig(), {}, 'us-east-1', BOOTSTRAP)
    assert result.source == ResolutionSource.BOOTSTRAP
    assert result.model_id == BOOTSTRAP


# ---------------------------------------------------------------------------
# Property-based strategies
# ---------------------------------------------------------------------------
_REGIONS = [
    'us-east-1', 'us-west-2', 'eu-west-1', 'ap-southeast-2', 'ap-northeast-1',
    'me-south-1', 'ca-central-1', 'sa-east-1', 'af-south-1', '',
]
# Region prefixes are derived from the shared helper; only the 'global'
# sentinel is added. No prefix literals are hardcoded.
_PREFIXES = sorted({cross_region_prefix(r) for r in _REGIONS} | {'global'})

_KEYS = ['k1', 'k2', 'k3']
_SLOTS = ['s1', 's2', 's3']
_AGENTS = ['a1', 'a2', 'a3']

region_strategy = st.one_of(st.sampled_from(_REGIONS), st.text(max_size=12))


@st.composite
def entry_strategy(draw, key):
    profiles = draw(
        st.dictionaries(
            st.sampled_from(_PREFIXES),
            st.sampled_from(['p1', 'p2']),
            max_size=3,
        )
    )
    return CatalogEntry(
        model_key=key,
        provider='prov',
        base_model_id='base',
        status=draw(st.sampled_from(list(ModelStatus))),
        modality=draw(st.sampled_from(list(Modality))),
        invocation_mode=draw(st.sampled_from(list(InvocationMode))),
        supports_tools=draw(st.booleans()),
        region_profiles=profiles,
    )


@st.composite
def catalog_strategy(draw):
    keys = draw(st.lists(st.sampled_from(_KEYS), unique=True, max_size=3))
    return {k: draw(entry_strategy(k)) for k in keys}


@st.composite
def config_strategy(draw):
    return ModelConfig(
        global_default_key=draw(st.one_of(st.none(), st.sampled_from(_KEYS))),
        slot_defaults=draw(
            st.dictionaries(st.sampled_from(_SLOTS), st.sampled_from(_KEYS), max_size=3)
        ),
        org_defaults=draw(
            st.dictionaries(st.sampled_from(_SLOTS), st.sampled_from(_KEYS), max_size=3)
        ),
        agent_overrides=draw(
            st.dictionaries(st.sampled_from(_AGENTS), st.sampled_from(_KEYS), max_size=3)
        ),
        locality_mode=draw(st.sampled_from(list(LocalityMode))),
    )


@st.composite
def requirements_strategy(draw):
    return SlotRequirements(
        requires_tools=draw(st.booleans()),
        modality=draw(st.sampled_from(list(Modality))),
        requires_converse=draw(st.booleans()),
    )


_COMMON = dict(
    catalog=catalog_strategy(),
    config=config_strategy(),
    requirements=requirements_strategy(),
    region=region_strategy,
    slot=st.sampled_from(_SLOTS),
    agent_id=st.one_of(st.none(), st.sampled_from(_AGENTS)),
)


# ---------------------------------------------------------------------------
# Property tests
# ---------------------------------------------------------------------------
@settings(max_examples=75, deadline=None)
@given(**_COMMON)
def test_resolve_model_never_raises(catalog, config, requirements, region, slot, agent_id):
    result = resolve_model(slot, requirements, config, catalog, region, BOOTSTRAP, agent_id=agent_id)
    assert isinstance(result, ResolvedModel)


@settings(max_examples=75, deadline=None)
@given(**_COMMON)
def test_strict_never_yields_global_scope(catalog, config, requirements, region, slot, agent_id):
    config.locality_mode = LocalityMode.STRICT
    result = resolve_model(slot, requirements, config, catalog, region, BOOTSTRAP, agent_id=agent_id)
    assert result.profile_scope != ProfileScope.GLOBAL


@settings(max_examples=75, deadline=None)
@given(**_COMMON)
def test_result_key_is_present_and_valid(catalog, config, requirements, region, slot, agent_id):
    result = resolve_model(slot, requirements, config, catalog, region, BOOTSTRAP, agent_id=agent_id)
    if result.model_key is not None:
        assert result.model_key in catalog
        assert is_valid_for_slot(catalog[result.model_key], requirements)


@settings(max_examples=75, deadline=None)
@given(**_COMMON)
def test_bootstrap_when_no_candidate_resolves(catalog, config, requirements, region, slot, agent_id):
    result = resolve_model(slot, requirements, config, catalog, region, BOOTSTRAP, agent_id=agent_id)
    any_resolves = False
    for _source, key in candidate_chain(slot, agent_id, config):
        entry = catalog.get(key)
        if entry is None or not is_valid_for_slot(entry, requirements):
            continue
        profile_id, _scope, _warns = resolve_profile(entry, region, config.locality_mode)
        if profile_id is not None:
            any_resolves = True
            break
    if not any_resolves:
        assert result.source == ResolutionSource.BOOTSTRAP
        assert result.model_id == BOOTSTRAP
