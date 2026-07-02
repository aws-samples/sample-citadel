"""Contract test binding the arbiter model resolver to its service copy.

The service (``service/agent_intake_single``) is a standalone Docker build
that cannot import the arbiter layer, so it ships its own byte-for-byte copy
of ``model_types`` and ``model_resolver`` (the copy differs only in two import
lines). This test runs the same scenarios through both implementations and
asserts identical outputs, so the two copies cannot silently drift.

All model ids and profile ids below are generic placeholders (``provider.*``);
no real provider-specific identifier is embedded.
"""
import os, sys

import pytest
import common.model_resolver as arb_resolver
import common.model_types as arb_types
_SVC = os.path.abspath(os.path.join(os.path.dirname(__file__), '..', '..', '..', 'service', 'agent_intake_single'))
if _SVC not in sys.path:
    sys.path.append(_SVC)
import model_resolver as svc_resolver  # noqa: E402
import model_types as svc_types        # noqa: E402


def _run(types_mod, resolver_mod, sc):
    catalog = {}
    for e in sc['catalog']:
        catalog[e['model_key']] = types_mod.CatalogEntry(
            model_key=e['model_key'], provider=e['provider'], base_model_id=e['base_model_id'],
            status=types_mod.ModelStatus(e.get('status', 'disabled')),
            modality=types_mod.Modality(e.get('modality', 'text')),
            invocation_mode=types_mod.InvocationMode(e.get('invocation_mode', 'converse')),
            supports_tools=e.get('supports_tools', False),
            supports_system_prompt=e.get('supports_system_prompt', True),
            supports_streaming=e.get('supports_streaming', True),
            region_profiles=dict(e.get('region_profiles', {})))
    config = types_mod.ModelConfig(
        global_default_key=sc.get('global_default'),
        slot_defaults=dict(sc.get('slot_defaults', {})),
        org_defaults=dict(sc.get('org_defaults', {})),
        agent_overrides=dict(sc.get('agent_overrides', {})),
        locality_mode=types_mod.LocalityMode(sc.get('locality', 'off')))
    reqs = types_mod.SlotRequirements(
        requires_tools=sc.get('requires_tools', False),
        modality=types_mod.Modality(sc.get('modality', 'text')),
        requires_converse=sc.get('requires_converse', False))
    r = resolver_mod.resolve_model(sc['slot'], reqs, config, catalog, sc['region'], sc['bootstrap'], agent_id=sc.get('agent_id'))
    return (r.model_id, r.source.value, r.profile_scope.value, r.model_key, tuple(r.warnings))


# Each scenario is a plain dict consumed by ``_run``. Placeholder model ids of
# the form ``provider.<name>`` and profile ids like ``us.provider.<name>`` keep
# the fixtures free of any real Bedrock identifier.
SCENARIOS = [
    # 1. Agent override beats org, slot, and global defaults.
    {
        'slot': 'chat', 'region': 'us-east-1', 'bootstrap': 'provider.bootstrap',
        'agent_id': 'agent-a',
        'agent_overrides': {'agent-a': 'model-a'},
        'org_defaults': {'chat': 'model-b'},
        'slot_defaults': {'chat': 'model-c'},
        'global_default': 'model-d',
        'catalog': [
            {'model_key': 'model-a', 'provider': 'provider', 'base_model_id': 'provider.model-a',
             'status': 'enabled', 'region_profiles': {'us': 'us.provider.model-a'}},
            {'model_key': 'model-b', 'provider': 'provider', 'base_model_id': 'provider.model-b',
             'status': 'enabled', 'region_profiles': {'us': 'us.provider.model-b'}},
            {'model_key': 'model-c', 'provider': 'provider', 'base_model_id': 'provider.model-c',
             'status': 'enabled', 'region_profiles': {'us': 'us.provider.model-c'}},
            {'model_key': 'model-d', 'provider': 'provider', 'base_model_id': 'provider.model-d',
             'status': 'enabled', 'region_profiles': {'us': 'us.provider.model-d'}},
        ],
    },
    # 2. No agent override -> fall through to the org default.
    {
        'slot': 'chat', 'region': 'us-east-1', 'bootstrap': 'provider.bootstrap',
        'org_defaults': {'chat': 'model-b'},
        'slot_defaults': {'chat': 'model-c'},
        'global_default': 'model-d',
        'catalog': [
            {'model_key': 'model-b', 'provider': 'provider', 'base_model_id': 'provider.model-b',
             'status': 'enabled', 'region_profiles': {'us': 'us.provider.model-b'}},
            {'model_key': 'model-c', 'provider': 'provider', 'base_model_id': 'provider.model-c',
             'status': 'enabled', 'region_profiles': {'us': 'us.provider.model-c'}},
            {'model_key': 'model-d', 'provider': 'provider', 'base_model_id': 'provider.model-d',
             'status': 'enabled', 'region_profiles': {'us': 'us.provider.model-d'}},
        ],
    },
    # 3. No agent or org -> fall through to the slot default.
    {
        'slot': 'chat', 'region': 'us-east-1', 'bootstrap': 'provider.bootstrap',
        'slot_defaults': {'chat': 'model-c'},
        'global_default': 'model-d',
        'catalog': [
            {'model_key': 'model-c', 'provider': 'provider', 'base_model_id': 'provider.model-c',
             'status': 'enabled', 'region_profiles': {'us': 'us.provider.model-c'}},
            {'model_key': 'model-d', 'provider': 'provider', 'base_model_id': 'provider.model-d',
             'status': 'enabled', 'region_profiles': {'us': 'us.provider.model-d'}},
        ],
    },
    # 4. Only a global default is configured.
    {
        'slot': 'chat', 'region': 'us-east-1', 'bootstrap': 'provider.bootstrap',
        'global_default': 'model-d',
        'catalog': [
            {'model_key': 'model-d', 'provider': 'provider', 'base_model_id': 'provider.model-d',
             'status': 'enabled', 'region_profiles': {'us': 'us.provider.model-d'}},
        ],
    },
    # 5. A disabled agent candidate is skipped; org default wins.
    {
        'slot': 'chat', 'region': 'us-east-1', 'bootstrap': 'provider.bootstrap',
        'agent_id': 'agent-a',
        'agent_overrides': {'agent-a': 'model-off'},
        'org_defaults': {'chat': 'model-b'},
        'catalog': [
            {'model_key': 'model-off', 'provider': 'provider', 'base_model_id': 'provider.model-off',
             'status': 'disabled', 'region_profiles': {'us': 'us.provider.model-off'}},
            {'model_key': 'model-b', 'provider': 'provider', 'base_model_id': 'provider.model-b',
             'status': 'enabled', 'region_profiles': {'us': 'us.provider.model-b'}},
        ],
    },
    # 6. A tools-required slot skips a non-tool model and picks the slot default.
    {
        'slot': 'chat', 'region': 'us-east-1', 'bootstrap': 'provider.bootstrap',
        'requires_tools': True,
        'agent_id': 'agent-a',
        'agent_overrides': {'agent-a': 'model-notools'},
        'slot_defaults': {'chat': 'model-tools'},
        'catalog': [
            {'model_key': 'model-notools', 'provider': 'provider', 'base_model_id': 'provider.model-notools',
             'status': 'enabled', 'supports_tools': False, 'region_profiles': {'us': 'us.provider.model-notools'}},
            {'model_key': 'model-tools', 'provider': 'provider', 'base_model_id': 'provider.model-tools',
             'status': 'enabled', 'supports_tools': True, 'region_profiles': {'us': 'us.provider.model-tools'}},
        ],
    },
    # 7. A regional profile is chosen ahead of the global one.
    {
        'slot': 'chat', 'region': 'eu-west-1', 'bootstrap': 'provider.bootstrap',
        'global_default': 'model-a',
        'catalog': [
            {'model_key': 'model-a', 'provider': 'provider', 'base_model_id': 'provider.model-a',
             'status': 'enabled',
             'region_profiles': {'eu': 'eu.provider.model-a', 'global': 'global.provider.model-a'}},
        ],
    },
    # 8. No regional profile, locality off -> global fallback with no warning.
    {
        'slot': 'chat', 'region': 'ap-south-1', 'bootstrap': 'provider.bootstrap',
        'locality': 'off',
        'global_default': 'model-a',
        'catalog': [
            {'model_key': 'model-a', 'provider': 'provider', 'base_model_id': 'provider.model-a',
             'status': 'enabled', 'region_profiles': {'global': 'global.provider.model-a'}},
        ],
    },
    # 9. No regional profile, regional_preferred -> global fallback with a warning.
    {
        'slot': 'chat', 'region': 'ap-south-1', 'bootstrap': 'provider.bootstrap',
        'locality': 'regional_preferred',
        'global_default': 'model-a',
        'catalog': [
            {'model_key': 'model-a', 'provider': 'provider', 'base_model_id': 'provider.model-a',
             'status': 'enabled', 'region_profiles': {'global': 'global.provider.model-a'}},
        ],
    },
    # 10. Strict locality with no regional profile is blocked -> bootstrap.
    {
        'slot': 'chat', 'region': 'us-east-1', 'bootstrap': 'provider.bootstrap',
        'locality': 'strict',
        'global_default': 'model-a',
        'catalog': [
            {'model_key': 'model-a', 'provider': 'provider', 'base_model_id': 'provider.model-a',
             'status': 'enabled', 'region_profiles': {'global': 'global.provider.model-a'}},
        ],
    },
    # 11. Empty region_profiles, locality off -> constructed profile id.
    {
        'slot': 'chat', 'region': 'us-east-1', 'bootstrap': 'provider.bootstrap',
        'locality': 'off',
        'global_default': 'model-a',
        'catalog': [
            {'model_key': 'model-a', 'provider': 'provider', 'base_model_id': 'provider.model-a',
             'status': 'enabled', 'region_profiles': {}},
        ],
    },
    # 12. Empty catalog -> bootstrap default.
    {
        'slot': 'chat', 'region': 'us-east-1', 'bootstrap': 'provider.bootstrap',
        'global_default': 'model-a',
        'catalog': [],
    },
]


@pytest.mark.parametrize('sc', SCENARIOS)
def test_arbiter_and_service_resolver_agree(sc):
    assert _run(arb_types, arb_resolver, sc) == _run(svc_types, svc_resolver, sc)
