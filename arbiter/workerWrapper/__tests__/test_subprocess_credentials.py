"""Regression tests for finding 9ef192d1 as SUPERSEDED by PR-4 (owner
decision 5750aeec: FAIL CLOSED, no grandfathering).

History: the original fix for 9ef192d1 made the agent subprocess INHERIT
the wrapper Lambda's ambient IAM role when no scoped credentials were
vended ("the documented backward-compat path"). PR-4 removes that branch
entirely: ``run_agent_in_subprocess`` now ALWAYS scrubs ambient AWS
credential env vars via ``credential_guard.build_agent_credential_env``
before building the child env, and takes an explicit ``credential_mode``
("scoped" or "none") rather than inferring behavior from whether
``scoped_credentials`` is truthy. There is no code path left that
propagates the parent Lambda's broad role into the child process.

These tests pin the CORRECTED (fail-closed) behavior:

* ``credential_mode='scoped'`` + scoped credentials -> the three credential
  env vars are OVERWRITTEN with the scoped ones; no ambient key leaks.
* ``credential_mode='scoped'`` + no/empty scoped credentials -> raises
  ``CredentialRefusal`` and ``subprocess.run`` is NEVER called (dispatch is
  refused before a subprocess is ever spawned).
* ``credential_mode='none'`` -> the child env carries NO AWS credential
  material at all (explicit no-cloud sentinel for pure-compute agents).
* The parent process's ``os.environ`` is never modified in any case.

All AWS (boto3 client construction, subprocess) is mocked; no real network.
"""

import json
import os
import sys
from unittest.mock import patch, MagicMock

import pytest


_ENV = {
    'AGENT_CONFIG_TABLE': 'test-table',
    'AGENT_BUCKET_NAME': 'test-bucket',
    'COMPLETION_BUS_NAME': 'citadel-agents-test',
    'EXECUTIONS_TABLE': 'citadel-executions-test',
}

# Ambient credentials the AWS Lambda runtime sets from the execution role —
# must NEVER reach the child under the fail-closed contract.
_AMBIENT_CREDS = {
    'AWS_ACCESS_KEY_ID': 'AKIAAMBIENTPARENT',
    'AWS_SECRET_ACCESS_KEY': 'ambient/secret/key/value',
    'AWS_SESSION_TOKEN': 'ambient-session-token',
}

_SCOPED = {
    'accessKeyId': 'AKIASCOPEDCHILD',
    'secretAccessKey': 'scoped/secret/key/value',
    'sessionToken': 'scoped-session-token',
}


def _fresh_index():
    sys.modules.pop('index', None)
    import index
    return index


def _success_stdout():
    return json.dumps({'response': 'ok', 'usage': []})


def _run_capture_env(index, scoped_credentials, credential_mode):
    """Invoke run_agent_in_subprocess with subprocess.run mocked; return the
    ``env`` dict that would have been handed to the child subprocess."""
    mock_result = MagicMock(returncode=0, stdout=_success_stdout(), stderr='')
    with patch('subprocess.run', return_value=mock_result) as mock_run:
        index.run_agent_in_subprocess(
            {'taskDetails': 'x'}, scoped_credentials, None,
            raise_on_error=True, credential_mode=credential_mode,
        )
    return mock_run.call_args.kwargs['env']


class TestScopedModeOverwritesAmbient:
    def test_scoped_credentials_replace_ambient_in_child_env(self):
        with patch.dict('os.environ', {**_ENV, **_AMBIENT_CREDS}):
            index = _fresh_index()
            child_env = _run_capture_env(index, _SCOPED, credential_mode='scoped')

        assert child_env['AWS_ACCESS_KEY_ID'] == _SCOPED['accessKeyId']
        assert child_env['AWS_SECRET_ACCESS_KEY'] == _SCOPED['secretAccessKey']
        assert child_env['AWS_SESSION_TOKEN'] == _SCOPED['sessionToken']


class TestScopedModeWithoutCredentialsRefusesBeforeSpawn:
    def test_no_scoped_credentials_raises_and_never_spawns(self):
        import credential_guard as cg
        with patch.dict('os.environ', {**_ENV, **_AMBIENT_CREDS}):
            index = _fresh_index()
            with patch('subprocess.run') as mock_run:
                with pytest.raises(cg.CredentialRefusal):
                    index.run_agent_in_subprocess(
                        {'taskDetails': 'x'}, None, None,
                        raise_on_error=True, credential_mode='scoped',
                    )
                mock_run.assert_not_called()

    def test_empty_dict_scoped_credentials_raises_and_never_spawns(self):
        import credential_guard as cg
        with patch.dict('os.environ', {**_ENV, **_AMBIENT_CREDS}):
            index = _fresh_index()
            with patch('subprocess.run') as mock_run:
                with pytest.raises(cg.CredentialRefusal):
                    index.run_agent_in_subprocess(
                        {'taskDetails': 'x'}, {}, None,
                        raise_on_error=True, credential_mode='scoped',
                    )
                mock_run.assert_not_called()


class TestNoneModeCarriesNoCredentialMaterial:
    def test_none_mode_strips_ambient_and_injects_nothing(self):
        with patch.dict('os.environ', {**_ENV, **_AMBIENT_CREDS}):
            index = _fresh_index()
            child_env = _run_capture_env(index, None, credential_mode='none')

        import credential_guard as cg
        assert not (set(child_env) & cg.AMBIENT_AWS_KEYS)

    def test_none_mode_ignores_scoped_credentials_if_somehow_present(self):
        with patch.dict('os.environ', {**_ENV, **_AMBIENT_CREDS}):
            index = _fresh_index()
            child_env = _run_capture_env(index, _SCOPED, credential_mode='none')
        assert 'AWS_ACCESS_KEY_ID' not in child_env


class TestAmbientInheritBranchRemoved:
    """Regression guard: the deleted ``else: pass`` branch (9ef192d1) must
    never resurface. Scoped mode with no credentials must NOT silently fall
    through to the ambient env — it must raise."""

    def test_ambient_credentials_never_reach_child_without_scoped_creds(self):
        import credential_guard as cg
        with patch.dict('os.environ', {**_ENV, **_AMBIENT_CREDS}):
            index = _fresh_index()
            with patch('subprocess.run'):
                with pytest.raises(cg.CredentialRefusal):
                    index.run_agent_in_subprocess(
                        {'taskDetails': 'x'}, None, None,
                        raise_on_error=True, credential_mode='scoped',
                    )


class TestParentEnvNeverModified:
    def test_parent_os_environ_unchanged_scoped(self):
        with patch.dict('os.environ', {**_ENV, **_AMBIENT_CREDS}):
            index = _fresh_index()
            _run_capture_env(index, _SCOPED, credential_mode='scoped')
            assert os.environ['AWS_ACCESS_KEY_ID'] == _AMBIENT_CREDS['AWS_ACCESS_KEY_ID']

    def test_parent_os_environ_unchanged_none_mode(self):
        with patch.dict('os.environ', {**_ENV, **_AMBIENT_CREDS}):
            index = _fresh_index()
            _run_capture_env(index, None, credential_mode='none')
            assert os.environ['AWS_ACCESS_KEY_ID'] == _AMBIENT_CREDS['AWS_ACCESS_KEY_ID']
