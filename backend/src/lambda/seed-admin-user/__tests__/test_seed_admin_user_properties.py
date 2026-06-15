"""
Tests for seed-admin-user Lambda handler.

Tests the CloudFormation custom resource handler that creates the initial
admin user in Cognito. The handler must:
  - Read the password from Secrets Manager (not env vars)
  - Create the user with a temporary password (Permanent=False)
  - Skip creation if admin email is not provided
  - Be idempotent (skip if user already exists)
  - Never raise — errors go via cfnresponse
"""

import sys
import os
import json
import importlib
from unittest.mock import patch, MagicMock

import pytest

# Add the Lambda source directory to sys.path
_lambda_dir = os.path.join(os.path.dirname(__file__), "..")
if _lambda_dir not in sys.path:
    sys.path.insert(0, _lambda_dir)

# Set required env vars
os.environ["USER_POOL_ID"] = "us-east-1_FakePool"
os.environ["ADMIN_EMAIL"] = "admin@example.com"
os.environ["ADMIN_FIRST_NAME"] = "Admin"
os.environ["ADMIN_LAST_NAME"] = "User"
os.environ["ADMIN_PASSWORD_SECRET_ARN"] = (
    "arn:aws:secretsmanager:us-east-1:123456789012:secret:citadel/admin-password-dev-AbCdEf"
)
# Remove ADMIN_PASSWORD so the handler cannot fall back to it
os.environ.pop("ADMIN_PASSWORD", None)


# ---------------------------------------------------------------------------
# Fixtures
# ---------------------------------------------------------------------------

BASE_EVENT = {
    "ResponseURL": "https://cfn-response.example.com/callback",
    "StackId": "arn:aws:cloudformation:us-east-1:123456789012:stack/TestStack",
    "RequestId": "unique-id-1234",
    "LogicalResourceId": "SeedAdminUserResource",
}

FAKE_CONTEXT = type("Ctx", (), {"log_stream_name": "test-stream"})()


def _make_cognito_mock(user_exists=False):
    mock = MagicMock()
    exc = type("UserNotFoundException", (Exception,), {})
    mock.exceptions.UserNotFoundException = exc
    if user_exists:
        mock.admin_get_user.return_value = {"Username": "admin@example.com"}
    else:
        mock.admin_get_user.side_effect = exc("not found")
    return mock


def _make_sm_mock(password="GeneratedPass1!"):
    mock = MagicMock()
    mock.get_secret_value.return_value = {
        "SecretString": json.dumps({"password": password})
    }
    return mock


def _client_factory(cognito_mock, sm_mock):
    def factory(service_name, **kwargs):
        if service_name == "cognito-idp":
            return cognito_mock
        if service_name == "secretsmanager":
            return sm_mock
        raise ValueError(f"Unexpected service: {service_name}")
    return factory


def _load_handler():
    """Import (or reimport) the handler module, returning the handler function."""
    for mod_name in ("index", "cfnresponse"):
        if mod_name in sys.modules:
            del sys.modules[mod_name]
    import index
    return index.handler, index


def _run_handler(event, cognito_mock=None, sm_mock=None, env_overrides=None):
    """Run the handler with mocked AWS clients. Returns (cfn_send_mock, cognito, sm)."""
    if cognito_mock is None:
        cognito_mock = _make_cognito_mock()
    if sm_mock is None:
        sm_mock = _make_sm_mock()

    env = env_overrides or {}

    # We need to mock boto3 and cfnresponse.send at the module level.
    # Since cfnresponse.send makes a real HTTP call, we mock the entire
    # cfnresponse module before importing index.
    mock_cfn_send = MagicMock()
    mock_cfn_module = MagicMock()
    mock_cfn_module.send = mock_cfn_send
    mock_cfn_module.SUCCESS = "SUCCESS"
    mock_cfn_module.FAILED = "FAILED"

    mock_boto3 = MagicMock()
    mock_boto3.client.side_effect = _client_factory(cognito_mock, sm_mock)

    with patch.dict(os.environ, env, clear=False):
        # Clear cached modules so index.py re-imports with our mocks
        for mod_name in ("index", "cfnresponse"):
            if mod_name in sys.modules:
                del sys.modules[mod_name]

        # Inject mocks into sys.modules before importing index
        sys.modules["cfnresponse"] = mock_cfn_module
        sys.modules["boto3"] = mock_boto3

        try:
            import index
            index.handler(event, FAKE_CONTEXT)
        finally:
            # Clean up injected mocks
            for mod_name in ("index", "cfnresponse", "boto3"):
                sys.modules.pop(mod_name, None)

    return mock_cfn_send, cognito_mock, sm_mock


# ---------------------------------------------------------------------------
# Tests
# ---------------------------------------------------------------------------

class TestDeleteRequests:
    def test_delete_sends_success(self):
        """Delete requests always respond with SUCCESS."""
        event = {**BASE_EVENT, "RequestType": "Delete"}

        mock_cfn_send = MagicMock()
        mock_cfn_module = MagicMock()
        mock_cfn_module.send = mock_cfn_send
        mock_cfn_module.SUCCESS = "SUCCESS"
        mock_cfn_module.FAILED = "FAILED"

        for mod_name in ("index", "cfnresponse"):
            sys.modules.pop(mod_name, None)
        sys.modules["cfnresponse"] = mock_cfn_module

        try:
            import index
            index.handler(event, FAKE_CONTEXT)
        finally:
            for mod_name in ("index", "cfnresponse"):
                sys.modules.pop(mod_name, None)

        mock_cfn_send.assert_called_once()
        assert mock_cfn_send.call_args[0][2] == "SUCCESS"


class TestSecretsManagerIntegration:
    def test_create_reads_password_from_secrets_manager(self):
        """Create must read the password from Secrets Manager, not env vars."""
        event = {**BASE_EVENT, "RequestType": "Create"}
        sm = _make_sm_mock("MyGenerated123!")

        mock_send, _, sm_out = _run_handler(event, sm_mock=sm)

        sm_out.get_secret_value.assert_called_once_with(
            SecretId=os.environ["ADMIN_PASSWORD_SECRET_ARN"]
        )

    def test_create_does_not_use_admin_password_env_var(self):
        """Handler must NOT read ADMIN_PASSWORD from environment."""
        event = {**BASE_EVENT, "RequestType": "Create"}

        mock_send, cognito, _ = _run_handler(
            event, env_overrides={"ADMIN_PASSWORD": "ShouldBeIgnored123!"}
        )

        # The password used should come from Secrets Manager, not env
        if cognito.admin_create_user.called:
            call_kwargs = cognito.admin_create_user.call_args[1]
            assert call_kwargs["TemporaryPassword"] != "ShouldBeIgnored123!"


class TestTemporaryPassword:
    def test_create_does_not_set_permanent_password(self):
        """Password must NOT be set as permanent — user changes on first login."""
        event = {**BASE_EVENT, "RequestType": "Create"}
        cognito = _make_cognito_mock(user_exists=False)
        sm = _make_sm_mock("TempPass456!")

        _run_handler(event, cognito_mock=cognito, sm_mock=sm)

        # admin_set_user_password with Permanent=True must NOT be called
        cognito.admin_set_user_password.assert_not_called()


class TestSkipConditions:
    def test_skips_when_no_admin_email(self):
        """When ADMIN_EMAIL is empty, handler skips and sends SUCCESS."""
        event = {**BASE_EVENT, "RequestType": "Create"}

        mock_send, cognito, _ = _run_handler(
            event, env_overrides={"ADMIN_EMAIL": ""}
        )

        cognito.admin_create_user.assert_not_called()
        assert mock_send.call_args[0][2] == "SUCCESS"

    def test_idempotent_when_user_exists(self):
        """If user already exists, handler skips creation and sends SUCCESS."""
        event = {**BASE_EVENT, "RequestType": "Create"}
        cognito = _make_cognito_mock(user_exists=True)

        mock_send, cog, _ = _run_handler(event, cognito_mock=cognito)

        cog.admin_create_user.assert_not_called()
        assert mock_send.call_args[0][2] == "SUCCESS"


class TestErrorHandling:
    @pytest.mark.parametrize("request_type", ["Create", "Update", "Delete"])
    def test_handler_never_raises(self, request_type):
        """Handler never raises; errors are sent via cfnresponse."""
        event = {**BASE_EVENT, "RequestType": request_type}
        # Should not raise
        _run_handler(event)

    def test_secrets_manager_failure_sends_failed(self):
        """If Secrets Manager call fails, handler sends FAILED cfnresponse."""
        event = {**BASE_EVENT, "RequestType": "Create"}
        sm = MagicMock()
        sm.get_secret_value.side_effect = Exception("Access denied")

        mock_send, _, _ = _run_handler(event, sm_mock=sm)

        assert mock_send.call_args[0][2] == "FAILED"
