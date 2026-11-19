"""Tests: worker unions runtime-resolved model into vend requiredPermissions.

PR-5 task 2: at dispatch, the worker resolves the effective model the
subprocess will actually invoke and unions its foundation model id into
requiredPermissions.models before calling the vender, so a later change
of the slot default cannot strand agents on stale stamped models.

The resolved model comes from server-side model config/catalog tables
(never from agent output).
"""
from __future__ import annotations

import json
import os
import sys
from unittest.mock import patch, MagicMock, call

import pytest


_BASE_ENV = {
    'AGENT_CONFIG_TABLE': 'test-table',
    'AGENT_BUCKET_NAME': 'test-bucket',
    'COMPLETION_BUS_NAME': 'citadel-agents-test',
    'CREDENTIAL_VENDER_FUNCTION': 'credential-vender-fn',
    'MODEL_CONFIG_TABLE': 'citadel-model-config-test',
    'MODEL_CATALOG_TABLE': 'citadel-model-catalog-test',
}

# Minimal model config/catalog items for resolution
_CONFIG_ITEM = {
    'scope': 'platform',
    'globalDefaultKey': 'anthropic-claude-sonnet-5',
    'slotDefaults': {},
    'orgDefaults': {},
    'agentOverrides': {},
    'localityMode': 'off',
}

_CATALOG_ITEMS = [
    {
        'modelKey': 'anthropic-claude-sonnet-5',
        'baseModelId': 'anthropic.claude-sonnet-5',
        'status': 'enabled',
        'modality': 'text',
        'invocationMode': 'converse',
        'supportsTools': True,
        'supportsSystemPrompt': True,
        'supportsStreaming': True,
        'regionProfiles': {
            'us': 'us.anthropic.claude-sonnet-5',
            'global': 'global.anthropic.claude-sonnet-5',
        },
    },
]


def _fresh_index():
    sys.modules.pop('index', None)
    import index
    return index


def _mock_ddb_tables(mock_resource):
    """Wire mock DynamoDB tables for model config and catalog."""
    mock_config_table = MagicMock()
    mock_config_table.get_item.return_value = {'Item': _CONFIG_ITEM}

    mock_catalog_table = MagicMock()
    mock_catalog_table.scan.return_value = {'Items': _CATALOG_ITEMS}

    mock_agent_config_table = MagicMock()

    def table_router(name):
        if name == 'citadel-model-config-test':
            return mock_config_table
        if name == 'citadel-model-catalog-test':
            return mock_catalog_table
        return mock_agent_config_table

    mock_resource.return_value.Table.side_effect = table_router
    return mock_agent_config_table


class TestResolveRuntimeModelId:
    """The worker's _resolve_runtime_model_id helper must resolve a
    foundation model id from the model config/catalog tables."""

    def test_resolves_global_default_when_no_override(self):
        with patch.dict('os.environ', _BASE_ENV):
            with patch('boto3.resource') as mock_resource:
                _mock_ddb_tables(mock_resource)
                index = _fresh_index()
                model_id = index._resolve_runtime_model_id(
                    model_override=None,
                )
        assert model_id == 'anthropic.claude-sonnet-5'

    def test_resolves_override_to_base_model_id(self):
        """When a modelOverride (inference-profile id) is set, the resolver
        maps it back to the catalog entry's baseModelId."""
        with patch.dict('os.environ', _BASE_ENV):
            with patch('boto3.resource') as mock_resource:
                _mock_ddb_tables(mock_resource)
                index = _fresh_index()
                model_id = index._resolve_runtime_model_id(
                    model_override='us.anthropic.claude-sonnet-5',
                )
        # The override IS an inference profile id; the function should still
        # return the foundation model id for IAM resource computation.
        assert model_id == 'anthropic.claude-sonnet-5'

    def test_returns_none_when_tables_missing(self):
        env_no_tables = {k: v for k, v in _BASE_ENV.items()
                         if k not in ('MODEL_CONFIG_TABLE', 'MODEL_CATALOG_TABLE')}
        with patch.dict('os.environ', env_no_tables, clear=False):
            with patch('boto3.resource') as mock_resource:
                _mock_ddb_tables(mock_resource)
                index = _fresh_index()
                model_id = index._resolve_runtime_model_id(
                    model_override=None,
                )
        assert model_id is None


class TestWorkerUnionsModelIntoVendRequest:
    """The worker must union the runtime model into requiredPermissions.models
    before calling get_scoped_credentials."""

    def test_models_array_includes_runtime_model(self):
        """When requiredPermissions.models already has [m1], the vend request
        should have [m1, runtime_model] (union)."""
        with patch.dict('os.environ', _BASE_ENV):
            with patch('boto3.resource') as mock_resource:
                _mock_ddb_tables(mock_resource)
                index = _fresh_index()

                # The function under test
                perms = {'models': ['some-other-model'], 'integrations': ['int-1'], 'dataStores': []}
                result = index._union_runtime_model(perms, model_override=None)

        assert 'anthropic.claude-sonnet-5' in result['models']
        assert 'some-other-model' in result['models']

    def test_no_duplicate_when_model_already_present(self):
        with patch.dict('os.environ', _BASE_ENV):
            with patch('boto3.resource') as mock_resource:
                _mock_ddb_tables(mock_resource)
                index = _fresh_index()

                perms = {'models': ['anthropic.claude-sonnet-5'], 'integrations': [], 'dataStores': []}
                result = index._union_runtime_model(perms, model_override=None)

        assert result['models'].count('anthropic.claude-sonnet-5') == 1

    def test_creates_models_array_when_absent(self):
        with patch.dict('os.environ', _BASE_ENV):
            with patch('boto3.resource') as mock_resource:
                _mock_ddb_tables(mock_resource)
                index = _fresh_index()

                perms = {'integrations': ['int-1'], 'dataStores': []}
                result = index._union_runtime_model(perms, model_override=None)

        assert result['models'] == ['anthropic.claude-sonnet-5']

    def test_noop_when_resolution_fails(self):
        env_no_tables = {k: v for k, v in _BASE_ENV.items()
                         if k not in ('MODEL_CONFIG_TABLE', 'MODEL_CATALOG_TABLE')}
        with patch.dict('os.environ', env_no_tables, clear=False):
            with patch('boto3.resource') as mock_resource:
                _mock_ddb_tables(mock_resource)
                index = _fresh_index()

                perms = {'models': ['m1'], 'integrations': [], 'dataStores': []}
                result = index._union_runtime_model(perms, model_override=None)

        # No change when resolution fails (graceful degradation)
        assert result['models'] == ['m1']
