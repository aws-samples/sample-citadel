"""Tests for the per-slot model-config loader.

Runs from the service test root and imports the mirrored modules directly
(the same flat layout the Docker build sees). DynamoDB access is exercised
through an injected fake ``dynamodb_resource`` (a ``MagicMock`` that routes
``Table(name)`` by name), and environment is driven with ``monkeypatch``.
All model ids are generic placeholders.
"""
import os, sys
from unittest.mock import MagicMock

sys.path.insert(0, os.path.abspath(os.path.join(os.path.dirname(__file__), '..')))
from model_config_loader import load_intake_model_id, load_extraction_model_id  # noqa: E402

_CONFIG_TABLE = 'model-config-table'
_CATALOG_TABLE = 'model-catalog-table'


def _set_tables(monkeypatch):
    monkeypatch.setenv('MODEL_CONFIG_TABLE', _CONFIG_TABLE)
    monkeypatch.setenv('MODEL_CATALOG_TABLE', _CATALOG_TABLE)


def _unset_tables(monkeypatch):
    monkeypatch.delenv('MODEL_CONFIG_TABLE', raising=False)
    monkeypatch.delenv('MODEL_CATALOG_TABLE', raising=False)


def _fake_resource(*, config_item, catalog_items):
    """A MagicMock DynamoDB resource routing ``Table(name)`` by name."""
    config_tbl = MagicMock()
    config_tbl.get_item.return_value = {'Item': config_item} if config_item is not None else {}
    catalog_tbl = MagicMock()
    catalog_tbl.scan.return_value = {'Items': list(catalog_items)}

    def _table(name):
        if name == _CONFIG_TABLE:
            return config_tbl
        if name == _CATALOG_TABLE:
            return catalog_tbl
        raise AssertionError(f'unexpected table: {name}')

    resource = MagicMock()
    resource.Table.side_effect = _table
    return resource


def test_intake_happy_path_resolves_regional_profile(monkeypatch):
    _set_tables(monkeypatch)
    resource = _fake_resource(
        config_item={'scope': 'platform', 'globalDefaultKey': 'model-x'},
        catalog_items=[{
            'modelKey': 'model-x',
            'status': 'enabled',
            'modality': 'text',
            'invocationMode': 'converse',
            'supportsTools': True,
            'regionProfiles': {'us': 'us.p.model-x'},
        }],
    )
    result = load_intake_model_id(
        region='us-east-1',
        fallback_model_id='fallback-intake-id',
        dynamodb_resource=resource,
    )
    assert result == 'us.p.model-x'


def test_extraction_happy_path_resolves_toolless_regional_profile(monkeypatch):
    _set_tables(monkeypatch)
    resource = _fake_resource(
        config_item={'scope': 'platform', 'globalDefaultKey': 'model-e'},
        catalog_items=[{
            'modelKey': 'model-e',
            'status': 'enabled',
            'modality': 'text',
            'invocationMode': 'converse',
            'supportsTools': False,
            'regionProfiles': {'us': 'us.p.model-e'},
        }],
    )
    result = load_extraction_model_id(
        region='us-east-1',
        fallback_model_id='fallback-extraction-id',
        dynamodb_resource=resource,
    )
    assert result == 'us.p.model-e'


def test_env_unset_returns_fallback_for_both_slots(monkeypatch):
    _unset_tables(monkeypatch)
    resource = _fake_resource(
        config_item={'scope': 'platform', 'globalDefaultKey': 'model-x'},
        catalog_items=[{'modelKey': 'model-x', 'status': 'enabled',
                        'regionProfiles': {'us': 'us.p.model-x'}}],
    )
    assert load_intake_model_id(
        region='us-east-1', fallback_model_id='fallback-intake-id',
        dynamodb_resource=resource) == 'fallback-intake-id'
    assert load_extraction_model_id(
        region='us-east-1', fallback_model_id='fallback-extraction-id',
        dynamodb_resource=resource) == 'fallback-extraction-id'


def test_resource_error_returns_fallback(monkeypatch):
    _set_tables(monkeypatch)
    resource = MagicMock()
    resource.Table.side_effect = RuntimeError('dynamodb unavailable')
    assert load_intake_model_id(
        region='us-east-1', fallback_model_id='fallback-intake-id',
        dynamodb_resource=resource) == 'fallback-intake-id'


def test_missing_config_item_returns_fallback(monkeypatch):
    _set_tables(monkeypatch)
    resource = _fake_resource(config_item=None, catalog_items=[])
    assert load_extraction_model_id(
        region='us-east-1', fallback_model_id='fallback-extraction-id',
        dynamodb_resource=resource) == 'fallback-extraction-id'
