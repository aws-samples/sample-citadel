"""Tests: models[] in requiredPermissions must satisfy the fail-closed gate.

PR-5 defect: _is_absent_or_empty_permissions only checked integrations and
dataStores — a requiredPermissions with models:['some-model'] but no
integrations/dataStores was treated as empty, so every fabricated agent with
only model permissions was refused at dispatch.
"""
from __future__ import annotations

import json
import os
import sys
from unittest.mock import patch, MagicMock

import pytest


_ENV = {
    'AGENT_CONFIG_TABLE': 'test-table',
    'AGENT_BUCKET_NAME': 'test-bucket',
    'COMPLETION_BUS_NAME': 'citadel-agents-test',
    'CREDENTIAL_VENDER_FUNCTION': 'credential-vender-fn',
}


def _fresh_index():
    sys.modules.pop('index', None)
    import index
    return index


class TestIsAbsentOrEmptyPermissionsIncludesModels:
    """_is_absent_or_empty_permissions must return False when models is
    non-empty, even if integrations and dataStores are both empty."""

    def test_models_only_is_not_empty(self):
        with patch.dict('os.environ', _ENV):
            index = _fresh_index()
            perms = {'models': ['anthropic.claude-sonnet-5'], 'integrations': [], 'dataStores': []}
            assert index._is_absent_or_empty_permissions(perms) is False

    def test_models_empty_with_no_other_perms_is_empty(self):
        with patch.dict('os.environ', _ENV):
            index = _fresh_index()
            perms = {'models': [], 'integrations': [], 'dataStores': []}
            assert index._is_absent_or_empty_permissions(perms) is True

    def test_none_still_empty(self):
        with patch.dict('os.environ', _ENV):
            index = _fresh_index()
            assert index._is_absent_or_empty_permissions(None) is True

    def test_models_and_integrations_not_empty(self):
        with patch.dict('os.environ', _ENV):
            index = _fresh_index()
            perms = {'models': ['m1'], 'integrations': ['int-1'], 'dataStores': []}
            assert index._is_absent_or_empty_permissions(perms) is False
