"""Regression tests for finding 9ef192d1 (HIGH): the agent subprocess had no
AWS credentials.

Ground truth (dev run 732013d3): the smoke agent declared no
``requiredPermissions`` so ``get_scoped_credentials`` returned ``None``.
``run_agent_in_subprocess`` then POPPED AWS_ACCESS_KEY_ID /
AWS_SECRET_ACCESS_KEY / AWS_SESSION_TOKEN from the child env "so the child
uses the Lambda's default IAM role via the metadata service". But AWS Lambda
delivers the execution role ONLY through those three env vars — there is no
IMDS/metadata service to fall back to. The child therefore had NO credential
source and boto3 raised ``NoCredentialsError``, which the governance ledger
surfaced as "ledger fenced reserve transport error" and refused the tool
fail-closed (0 ledger rows, 0 smoke rows). The wrapper Lambda itself HAD
working credentials in the same invocation.

These tests pin the corrected behavior:

* No scoped credentials -> the child env PROPAGATES the wrapper's ambient
  credential env (does NOT strip it), and a client constructed from that env
  resolves credentials through botocore's own provider chain and can SIGN a
  request. (Constructing a *live-signing* boto3 client that hits STS is
  impractical in a unit test — no live credentials or endpoint — so we assert
  the child env carries USABLE credential material by resolving it through the
  same ``EnvProvider`` path a real boto3 client uses, then SigV4-signing with
  the resolved credentials. That is the exact path that raised
  NoCredentialsError when the vars were stripped.)
* Scoped credentials -> the three credential env vars are OVERWRITTEN with the
  scoped ones (isolation: the child never sees the parent's ambient role).
* The parent process's ``os.environ`` is never modified either way.

All AWS (boto3 client construction, subprocess) is mocked; no real network.
"""

import json
import os
import sys
from unittest.mock import patch, MagicMock

import pytest

from botocore.session import get_session
from botocore.credentials import Credentials
from botocore.auth import SigV4Auth
from botocore.awsrequest import AWSRequest


_ENV = {
    'AGENT_CONFIG_TABLE': 'test-table',
    'AGENT_BUCKET_NAME': 'test-bucket',
    'COMPLETION_BUS_NAME': 'citadel-agents-test',
    'EXECUTIONS_TABLE': 'citadel-executions-test',
}

# Ambient credentials the AWS Lambda runtime sets from the execution role.
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


def _run_capture_env(index, scoped_credentials):
    """Invoke run_agent_in_subprocess with subprocess.run mocked; return the
    ``env`` dict that would have been handed to the child subprocess."""
    mock_result = MagicMock(returncode=0, stdout=_success_stdout(), stderr='')
    with patch('subprocess.run', return_value=mock_result) as mock_run:
        index.run_agent_in_subprocess(
            {'taskDetails': 'x'}, scoped_credentials, None, raise_on_error=True,
        )
    return mock_run.call_args.kwargs['env']


def _resolve_via_provider_chain(child_env):
    """Resolve credentials from *child_env* through botocore's real provider
    chain (the same EnvProvider path a boto3 client uses at construction), by
    pointing os.environ at the child env. Returns the resolved Credentials or
    None — None is exactly the NoCredentialsError condition."""
    only_aws = {k: v for k, v in child_env.items() if k.startswith('AWS_')}
    with patch.dict(os.environ, only_aws, clear=True):
        session = get_session()
        return session.get_credentials()


class TestNoScopedCredentialsPropagatesAmbient:
    def test_child_env_carries_ambient_credentials(self):
        """The three credential env vars must SURVIVE into the child env when
        there are no scoped credentials (the fix: propagate, don't strip)."""
        with patch.dict('os.environ', {**_ENV, **_AMBIENT_CREDS}):
            index = _fresh_index()
            child_env = _run_capture_env(index, scoped_credentials=None)

        assert child_env['AWS_ACCESS_KEY_ID'] == _AMBIENT_CREDS['AWS_ACCESS_KEY_ID']
        assert child_env['AWS_SECRET_ACCESS_KEY'] == _AMBIENT_CREDS['AWS_SECRET_ACCESS_KEY']
        assert child_env['AWS_SESSION_TOKEN'] == _AMBIENT_CREDS['AWS_SESSION_TOKEN']

    def test_client_from_child_env_resolves_and_can_sign(self):
        """A client constructed from the child env resolves usable credentials
        through botocore's provider chain and can SIGN a request — the exact
        path that raised NoCredentialsError when the vars were stripped."""
        with patch.dict('os.environ', {**_ENV, **_AMBIENT_CREDS}):
            index = _fresh_index()
            child_env = _run_capture_env(index, scoped_credentials=None)

        creds = _resolve_via_provider_chain(child_env)
        assert creds is not None, "child env yielded no credentials (NoCredentialsError)"
        frozen = creds.get_frozen_credentials()
        assert frozen.access_key == _AMBIENT_CREDS['AWS_ACCESS_KEY_ID']

        # Prove the resolved credentials actually sign a SigV4 request.
        req = AWSRequest(method='GET', url='https://sts.us-east-1.amazonaws.com/')
        SigV4Auth(creds, 'sts', 'us-east-1').add_auth(req)
        assert req.headers.get('Authorization', '').startswith('AWS4-HMAC-SHA256')


class TestScopedCredentialsOverwriteAmbient:
    def test_scoped_credentials_replace_ambient_in_child_env(self):
        """When scoped credentials are vended they OVERWRITE the ambient ones,
        so the child sees only the narrowed role (isolation)."""
        with patch.dict('os.environ', {**_ENV, **_AMBIENT_CREDS}):
            index = _fresh_index()
            child_env = _run_capture_env(index, scoped_credentials=_SCOPED)

        assert child_env['AWS_ACCESS_KEY_ID'] == _SCOPED['accessKeyId']
        assert child_env['AWS_SECRET_ACCESS_KEY'] == _SCOPED['secretAccessKey']
        assert child_env['AWS_SESSION_TOKEN'] == _SCOPED['sessionToken']

        creds = _resolve_via_provider_chain(child_env)
        assert creds is not None
        assert creds.get_frozen_credentials().access_key == _SCOPED['accessKeyId']


class TestParentEnvNeverModified:
    def test_parent_os_environ_unchanged_no_scoped(self):
        with patch.dict('os.environ', {**_ENV, **_AMBIENT_CREDS}):
            index = _fresh_index()
            _run_capture_env(index, scoped_credentials=None)
            assert os.environ['AWS_ACCESS_KEY_ID'] == _AMBIENT_CREDS['AWS_ACCESS_KEY_ID']

    def test_parent_os_environ_unchanged_scoped(self):
        with patch.dict('os.environ', {**_ENV, **_AMBIENT_CREDS}):
            index = _fresh_index()
            _run_capture_env(index, scoped_credentials=_SCOPED)
            # The parent keeps its OWN ambient creds — scoped creds only ever
            # reach the child env.
            assert os.environ['AWS_ACCESS_KEY_ID'] == _AMBIENT_CREDS['AWS_ACCESS_KEY_ID']
