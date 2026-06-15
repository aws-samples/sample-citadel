"""
Tests for cognito-secret-handler Lambda.

Tests the CloudFormation custom resource handler that:
  - Reads the OAuth client secret from a Cognito user pool client
  - Stores it (along with token_url, confluence_domain) into Secrets Manager
  - Reports back to CloudFormation via cfnresponse on both success and failure

Required behaviour:
  - Delete requests → cfnresponse.send SUCCESS, no AWS calls
  - Create/Update happy path → describe_user_pool_client + put_secret_value,
    then cfnresponse.send SUCCESS with {'SecretArn': <arn>}
  - Failure path → cfnresponse.send FAILED before the exception propagates
    (re-raised so Lambda metrics also record the error).

The test isolates the handler by injecting mock cfnresponse and boto3
modules into sys.modules before importing index, matching the convention
used by seed-admin-user/__tests__/test_seed_admin_user_properties.py.
"""

import json
import os
import sys
from unittest.mock import MagicMock

import pytest
from botocore.exceptions import ClientError

# Make the sibling lambda source dir importable as `index` and `cfnresponse`.
_lambda_dir = os.path.join(os.path.dirname(__file__), "..")
if _lambda_dir not in sys.path:
    sys.path.insert(0, _lambda_dir)


# ---------------------------------------------------------------------------
# Fixtures / helpers
# ---------------------------------------------------------------------------

BASE_EVENT = {
    "ResponseURL": "https://cfn-response.example.com/callback",
    "StackId": "arn:aws:cloudformation:us-east-1:123456789012:stack/TestStack",
    "RequestId": "unique-id-1234",
    "LogicalResourceId": "CognitoSecretHandlerResource",
    "ResourceProperties": {
        "UserPoolId": "us-east-1_FakePool",
        "ClientId": "fake-client-id",
        "SecretArn": (
            "arn:aws:secretsmanager:us-east-1:123456789012:"
            "secret:fake-secret-AbCdEf"
        ),
        "TokenUrl": "https://example.com/oauth2/token",
        "ConfluenceDomain": "example.atlassian.net",
    },
}

FAKE_CONTEXT = type("Ctx", (), {"log_stream_name": "test-stream"})()


def _make_cognito_mock(client_secret="real-cognito-secret"):
    mock = MagicMock()
    mock.describe_user_pool_client.return_value = {
        "UserPoolClient": {"ClientSecret": client_secret}
    }
    return mock


def _make_sm_mock():
    mock = MagicMock()
    mock.put_secret_value.return_value = {"VersionId": "v1"}
    return mock


def _client_factory(cognito_mock, sm_mock):
    def factory(service_name, **kwargs):
        if service_name == "cognito-idp":
            return cognito_mock
        if service_name == "secretsmanager":
            return sm_mock
        raise ValueError(f"Unexpected service: {service_name}")

    return factory


def _run_handler(event, cognito_mock=None, sm_mock=None):
    """Run the handler with mocked AWS clients + cfnresponse.

    Returns (mock_cfn_send, cognito_mock, sm_mock, raised_exception).
    """
    if cognito_mock is None:
        cognito_mock = _make_cognito_mock()
    if sm_mock is None:
        sm_mock = _make_sm_mock()

    # Mock cfnresponse module so no real HTTP call happens.
    mock_cfn_send = MagicMock()
    mock_cfn_module = MagicMock()
    mock_cfn_module.send = mock_cfn_send
    mock_cfn_module.SUCCESS = "SUCCESS"
    mock_cfn_module.FAILED = "FAILED"

    # Mock boto3 so .client() returns our pre-configured service mocks.
    mock_boto3 = MagicMock()
    mock_boto3.client.side_effect = _client_factory(cognito_mock, sm_mock)

    # Clear any cached copy of index/cfnresponse so the import below picks
    # up the freshly-injected mocks.
    for mod_name in ("index", "cfnresponse"):
        sys.modules.pop(mod_name, None)
    sys.modules["cfnresponse"] = mock_cfn_module

    # Preserve the real boto3 (needed by botocore.exceptions in this file).
    saved_boto3 = sys.modules.get("boto3")
    sys.modules["boto3"] = mock_boto3

    raised = None
    try:
        import index  # noqa: WPS433 — intentional late import after mocking
        try:
            index.handler(event, FAKE_CONTEXT)
        except Exception as e:  # noqa: BLE001 — test must observe re-raise
            raised = e
    finally:
        for mod_name in ("index", "cfnresponse"):
            sys.modules.pop(mod_name, None)
        if saved_boto3 is not None:
            sys.modules["boto3"] = saved_boto3
        else:
            sys.modules.pop("boto3", None)

    return mock_cfn_send, cognito_mock, sm_mock, raised


# ---------------------------------------------------------------------------
# Tests
# ---------------------------------------------------------------------------


class TestDeleteRequest:
    def test_delete_sends_success_without_aws_calls(self):
        """Delete must short-circuit: SUCCESS, no Cognito or Secrets Manager calls."""
        event = {**BASE_EVENT, "RequestType": "Delete"}
        cognito = _make_cognito_mock()
        sm = _make_sm_mock()

        mock_send, cog, sec, raised = _run_handler(event, cognito, sm)

        assert raised is None
        cog.describe_user_pool_client.assert_not_called()
        sec.put_secret_value.assert_not_called()
        mock_send.assert_called_once()
        # cfnresponse.send signature: send(event, context, status, data, ...)
        args = mock_send.call_args[0]
        assert args[2] == "SUCCESS"


class TestCreateHappyPath:
    @pytest.mark.parametrize("request_type", ["Create", "Update"])
    def test_calls_cognito_then_secrets_manager_then_cfn_success(self, request_type):
        """Happy path: describe pool client → put_secret_value → cfn SUCCESS."""
        event = {**BASE_EVENT, "RequestType": request_type}
        cognito = _make_cognito_mock(client_secret="real-secret-xyz")
        sm = _make_sm_mock()

        mock_send, cog, sec, raised = _run_handler(event, cognito, sm)

        assert raised is None

        # Cognito called with the right args
        cog.describe_user_pool_client.assert_called_once_with(
            UserPoolId="us-east-1_FakePool",
            ClientId="fake-client-id",
        )

        # Secrets Manager called with the right SecretId and a JSON body
        # containing the four expected fields including the cognito secret.
        sec.put_secret_value.assert_called_once()
        sm_kwargs = sec.put_secret_value.call_args[1]
        assert sm_kwargs["SecretId"] == BASE_EVENT["ResourceProperties"]["SecretArn"]
        stored = json.loads(sm_kwargs["SecretString"])
        assert stored == {
            "client_id": "fake-client-id",
            "client_secret": "real-secret-xyz",
            "token_url": "https://example.com/oauth2/token",
            "confluence_domain": "example.atlassian.net",
        }

        # cfnresponse called with SUCCESS and {'SecretArn': <arn>}
        mock_send.assert_called_once()
        args = mock_send.call_args[0]
        assert args[2] == "SUCCESS"
        data = args[3]
        assert data == {"SecretArn": BASE_EVENT["ResourceProperties"]["SecretArn"]}


class TestFailurePath:
    def test_cognito_clienterror_sends_failed_then_re_raises(self):
        """Cognito raises → cfnresponse.send FAILED is called, then exception propagates."""
        event = {**BASE_EVENT, "RequestType": "Create"}
        cognito = _make_cognito_mock()
        cognito.describe_user_pool_client.side_effect = ClientError(
            {
                "Error": {
                    "Code": "ResourceNotFoundException",
                    "Message": "User pool client not found",
                }
            },
            "DescribeUserPoolClient",
        )
        sm = _make_sm_mock()

        mock_send, cog, sec, raised = _run_handler(event, cognito, sm)

        # Re-raised after sending FAILED
        assert raised is not None
        assert isinstance(raised, ClientError)

        # Secrets Manager never reached
        sec.put_secret_value.assert_not_called()

        # cfnresponse.send was called exactly once with FAILED before re-raise
        mock_send.assert_called_once()
        args = mock_send.call_args[0]
        assert args[2] == "FAILED"
        data = args[3]
        assert "Message" in data
        assert "User pool client not found" in data["Message"]

    def test_secrets_manager_failure_sends_failed_then_re_raises(self):
        """Secrets Manager raises → cfnresponse.send FAILED, then propagates."""
        event = {**BASE_EVENT, "RequestType": "Create"}
        cognito = _make_cognito_mock()
        sm = _make_sm_mock()
        sm.put_secret_value.side_effect = ClientError(
            {"Error": {"Code": "AccessDeniedException", "Message": "denied"}},
            "PutSecretValue",
        )

        mock_send, cog, sec, raised = _run_handler(event, cognito, sm)

        assert raised is not None
        assert isinstance(raised, ClientError)
        cog.describe_user_pool_client.assert_called_once()
        mock_send.assert_called_once()
        args = mock_send.call_args[0]
        assert args[2] == "FAILED"
