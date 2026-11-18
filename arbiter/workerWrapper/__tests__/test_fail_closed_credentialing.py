"""Fail-closed credentialing regression tests (PR-4, finding b): HIGH —
credential vending previously failed OPEN. ``get_scoped_credentials`` must
now RAISE :class:`credential_guard.CredentialRefusal` on vend failure, vend
refusal, and missing org — never silently return ``None`` and let the
caller fall through to an un-vetted dispatch.

Owner decision 5750aeec: FAIL CLOSED, no grandfathering.
"""
from __future__ import annotations

import json
import sys
from unittest.mock import patch, MagicMock

import pytest


_ENV = {
    'AGENT_CONFIG_TABLE': 'test-table',
    'AGENT_BUCKET_NAME': 'test-bucket',
    'COMPLETION_BUS_NAME': 'citadel-agents-test',
    'EXECUTIONS_TABLE': 'citadel-executions-test',
    'CREDENTIAL_VENDER_FUNCTION': 'credential-vender-fn',
}

_PERMS = {'integrations': ['int-1'], 'dataStores': []}


def _fresh_index():
    sys.modules.pop('index', None)
    import index
    return index


class TestGetScopedCredentialsRaisesOnNoOrg:
    def test_missing_org_raises_credential_refusal(self):
        import credential_guard as cg
        with patch.dict('os.environ', _ENV):
            index = _fresh_index()
            with pytest.raises(cg.CredentialRefusal) as excinfo:
                index.get_scoped_credentials('agent-A', _PERMS, org_id=None)
        assert excinfo.value.reason == cg.NO_ORG

    def test_empty_string_org_raises_credential_refusal(self):
        import credential_guard as cg
        with patch.dict('os.environ', _ENV):
            index = _fresh_index()
            with pytest.raises(cg.CredentialRefusal):
                index.get_scoped_credentials('agent-A', _PERMS, org_id='')


class TestGetScopedCredentialsRaisesOnVendRefused:
    def test_vender_error_payload_raises(self):
        import credential_guard as cg
        mock_response = {'Payload': MagicMock(read=lambda: json.dumps(
            {'error': 'permission denied by vender policy'}
        ).encode())}
        with patch.dict('os.environ', _ENV):
            index = _fresh_index()
            with patch.object(index, '_get_lambda_client') as mock_client:
                mock_client.return_value.invoke.return_value = mock_response
                with pytest.raises(cg.CredentialRefusal) as excinfo:
                    index.get_scoped_credentials('agent-A', _PERMS, org_id='org-1')
        assert excinfo.value.reason == cg.VEND_REFUSED


class TestGetScopedCredentialsRaisesOnVendFailure:
    def test_lambda_invoke_exception_raises(self):
        import credential_guard as cg
        with patch.dict('os.environ', _ENV):
            index = _fresh_index()
            with patch.object(index, '_get_lambda_client') as mock_client:
                mock_client.return_value.invoke.side_effect = RuntimeError('network boom')
                with pytest.raises(cg.CredentialRefusal) as excinfo:
                    index.get_scoped_credentials('agent-A', _PERMS, org_id='org-1')
        assert excinfo.value.reason == cg.VEND_FAILED

    def test_malformed_vender_response_raises(self):
        import credential_guard as cg
        mock_response = {'Payload': MagicMock(read=lambda: b'not json')}
        with patch.dict('os.environ', _ENV):
            index = _fresh_index()
            with patch.object(index, '_get_lambda_client') as mock_client:
                mock_client.return_value.invoke.return_value = mock_response
                with pytest.raises(cg.CredentialRefusal) as excinfo:
                    index.get_scoped_credentials('agent-A', _PERMS, org_id='org-1')
        assert excinfo.value.reason == cg.VEND_FAILED


class TestGetScopedCredentialsSucceedsOnValidVend:
    def test_returns_credentials_on_success(self):
        creds = {
            'accessKeyId': 'AKIASCOPED', 'secretAccessKey': 's', 'sessionToken': 't',
        }
        mock_response = {'Payload': MagicMock(read=lambda: json.dumps(
            {'credentials': creds}
        ).encode())}
        with patch.dict('os.environ', _ENV):
            index = _fresh_index()
            with patch.object(index, '_get_lambda_client') as mock_client:
                mock_client.return_value.invoke.return_value = mock_response
                result = index.get_scoped_credentials('agent-A', _PERMS, org_id='org-1')
        assert result == creds


class TestGetScopedCredentialsNoVenderConfigured:
    def test_no_vender_function_returns_none_not_raise(self):
        """When CREDENTIAL_VENDER_FUNCTION is unset entirely (vending is not
        wired up in this deployment), the function still returns None — the
        DISPATCH GATE (not this function) decides whether an agent without
        scoped credentials may run (the explicit 'none' sentinel) or must be
        refused."""
        env = dict(_ENV)
        env.pop('CREDENTIAL_VENDER_FUNCTION')
        with patch.dict('os.environ', env, clear=True):
            index = _fresh_index()
            result = index.get_scoped_credentials('agent-A', _PERMS, org_id='org-1')
        assert result is None
