"""Tests for the supervisor model-selection I/O loader.

Exercises the bulletproof fallback contract: any missing env var, missing
config item, or exception must return the caller-supplied fallback, while the
happy path resolves the regional inference profile from the config + catalog
tables via the shared pure resolver.
"""
from unittest.mock import MagicMock

from model_config_loader import load_model_id

_FALLBACK = 'fallback.provider.model-x'
_CFG_TABLE = 'citadel-model-config-test'
_CAT_TABLE = 'citadel-model-catalog-test'


def _make_resource(cfg_return, cat_return):
    """Build a fake DynamoDB resource that routes ``Table(name)`` by name."""
    cfg_table = MagicMock(name='cfg_table')
    cfg_table.get_item.return_value = cfg_return
    cat_table = MagicMock(name='cat_table')
    cat_table.scan.return_value = cat_return

    def _route(name):
        if name == _CFG_TABLE:
            return cfg_table
        if name == _CAT_TABLE:
            return cat_table
        raise AssertionError(f'unexpected table name: {name}')

    resource = MagicMock(name='dynamodb_resource')
    resource.Table.side_effect = _route
    return resource


def test_returns_fallback_when_env_unset(monkeypatch):
    monkeypatch.delenv('MODEL_CONFIG_TABLE', raising=False)
    monkeypatch.delenv('MODEL_CATALOG_TABLE', raising=False)
    resource = MagicMock(name='unused_resource')

    result = load_model_id(
        region='us-east-1',
        fallback_model_id=_FALLBACK,
        dynamodb_resource=resource,
    )

    assert result == _FALLBACK
    # No table access when the env is not configured.
    resource.Table.assert_not_called()


def test_happy_path_resolves_regional_profile(monkeypatch):
    monkeypatch.setenv('MODEL_CONFIG_TABLE', _CFG_TABLE)
    monkeypatch.setenv('MODEL_CATALOG_TABLE', _CAT_TABLE)
    cfg_return = {'Item': {
        'scope': 'platform',
        'globalDefaultKey': 'm5',
        'slotDefaults': {},
        'orgDefaults': {},
        'agentOverrides': {},
        'localityMode': 'off',
    }}
    cat_return = {'Items': [{
        'modelKey': 'm5',
        'provider': 'p',
        'baseModelId': 'p.model-5',
        'status': 'enabled',
        'modality': 'text',
        'invocationMode': 'converse',
        'supportsTools': True,
        'supportsSystemPrompt': True,
        'supportsStreaming': True,
        'regionProfiles': {'us': 'us.p.model-5', 'global': 'global.p.model-5'},
    }]}
    resource = _make_resource(cfg_return, cat_return)

    result = load_model_id(
        region='us-east-1',
        fallback_model_id=_FALLBACK,
        dynamodb_resource=resource,
    )

    # us-east-1 -> prefix 'us' -> the regional profile is preferred.
    assert result == 'us.p.model-5'
    assert result != _FALLBACK


def test_returns_fallback_when_resource_raises(monkeypatch):
    monkeypatch.setenv('MODEL_CONFIG_TABLE', _CFG_TABLE)
    monkeypatch.setenv('MODEL_CATALOG_TABLE', _CAT_TABLE)
    resource = MagicMock(name='exploding_resource')
    resource.Table.side_effect = RuntimeError('boom')

    result = load_model_id(
        region='us-east-1',
        fallback_model_id=_FALLBACK,
        dynamodb_resource=resource,
    )

    assert result == _FALLBACK


def test_returns_fallback_when_config_item_missing(monkeypatch):
    monkeypatch.setenv('MODEL_CONFIG_TABLE', _CFG_TABLE)
    monkeypatch.setenv('MODEL_CATALOG_TABLE', _CAT_TABLE)
    # get_item with no 'Item' key at all.
    resource_missing = _make_resource({}, {'Items': []})
    # get_item with a present-but-empty 'Item'.
    resource_empty = _make_resource({'Item': {}}, {'Items': []})

    assert load_model_id(
        region='us-east-1',
        fallback_model_id=_FALLBACK,
        dynamodb_resource=resource_missing,
    ) == _FALLBACK
    assert load_model_id(
        region='us-east-1',
        fallback_model_id=_FALLBACK,
        dynamodb_resource=resource_empty,
    ) == _FALLBACK
