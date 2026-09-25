"""Registry-seeding resilience tests for arbiter/seedConfig/index.py.

The SeedAgentConfigResource must never fail the whole CloudFormation deploy
because AgentCore Registry record seeding hit AccessDeniedException or
ResourceNotFound. Registry seeding is best-effort; the DynamoDB/S3 seeding
this handler performs remains authoritative and still fails the deploy on
its own errors.

Contract under test:
  - create_registry_record raising a ClientError (AccessDeniedException,
    ResourceNotFoundException) is caught, logged as a WARNING, and the
    handler still returns SUCCESS to CloudFormation.
  - DynamoDB rows (fabricator, demo-echo-agent, authority units,
    constitutional layer) are still written when registry seeding is denied.
  - The SUCCESS response data carries `registrySeeded: False` when the
    registry create was denied/unavailable, and `registrySeeded: True` when
    it succeeded.
"""

import sys
import os
import json
from unittest.mock import patch, MagicMock

sys.path.insert(0, os.path.join(os.path.dirname(__file__), ".."))

os.environ.setdefault("AGENT_CONFIG_TABLE", "fake-agent-table")
os.environ.setdefault("WORKER_QUEUE_URL", "https://sqs.fake/worker")
os.environ.setdefault("FABRICATOR_QUEUE_URL", "https://sqs.fake/fabricator")
os.environ.setdefault("AUTHORITY_UNITS_TABLE", "fake-authority-units-table")
os.environ.setdefault(
    "CONSTITUTIONAL_LAYERS_TABLE", "fake-constitutional-layers-table"
)

from botocore.exceptions import ClientError  # noqa: E402
from index import handler  # noqa: E402

REGISTRY_ID = "fake-registry-id"


def _cfn_event(request_type="Create"):
    return {
        "RequestType": request_type,
        "ResponseURL": "https://cfn-response.example.com/callback",
        "StackId": "arn:aws:cloudformation:us-east-1:123456789012:stack/s",
        "RequestId": "req-1",
        "LogicalResourceId": "SeedAgentConfigResource",
    }


def _ctx():
    return type("Ctx", (), {"log_stream_name": "stream"})()


def _client_error(code):
    return ClientError(
        error_response={"Error": {"Code": code, "Message": code}},
        operation_name="CreateRegistryRecord",
    )


def _run_handler(create_side_effect, existing_records=None):
    mock_table = MagicMock()
    mock_dynamodb = MagicMock()
    mock_dynamodb.Table.return_value = mock_table

    registry_client = MagicMock(name="agent-registry-control-mock")
    if create_side_effect is not None:
        registry_client.create_registry_record.side_effect = create_side_effect
    else:
        registry_client.create_registry_record.return_value = {
            "recordId": "abc123def456",
            "status": "DRAFT",
        }

    def _client_factory(service_name, *args, **kwargs):
        if service_name == "agent-registry-control":
            return registry_client
        return MagicMock(name=f"{service_name}-mock")

    env_patch = dict(os.environ)
    env_patch["REGISTRY_ID"] = REGISTRY_ID
    env_patch["REGISTRY_ENABLED"] = "true"

    list_mock = MagicMock(return_value=existing_records or [])

    with patch.dict(os.environ, env_patch, clear=True), \
         patch("index.boto3") as mock_boto3, \
         patch("catalog.registry_client.list_agent_records", list_mock), \
         patch("cfnresponse.send") as mock_send:
        mock_boto3.resource.return_value = mock_dynamodb
        mock_boto3.client.side_effect = _client_factory
        handler(_cfn_event(), _ctx())

    return mock_table, mock_send, registry_client


class TestRegistryDeniedIsNonFatal:
    def test_access_denied_returns_success_and_ddb_rows_written(self):
        mock_table, mock_send, client = _run_handler(
            create_side_effect=_client_error("AccessDeniedException"),
        )

        assert mock_send.call_args[0][2] == "SUCCESS"
        data = mock_send.call_args[0][3]
        assert data["registrySeeded"] is False

        # DDB seeding stays authoritative: fabricator, demo-echo-agent,
        # 2 authority units, 1 constitutional layer = 5 put_item calls.
        assert mock_table.put_item.call_count == 5
        items = [c.kwargs["Item"] for c in mock_table.put_item.call_args_list]
        agent_ids = {i.get("agentId") for i in items if "agentId" in i}
        assert "fabricator" in agent_ids
        assert "demo-echo-agent" in agent_ids

    def test_resource_not_found_returns_success(self):
        _, mock_send, _ = _run_handler(
            create_side_effect=_client_error("ResourceNotFoundException"),
        )
        assert mock_send.call_args[0][2] == "SUCCESS"
        data = mock_send.call_args[0][3]
        assert data["registrySeeded"] is False

    def test_registry_ok_returns_registry_seeded_true(self):
        _, mock_send, client = _run_handler(create_side_effect=None)

        assert mock_send.call_args[0][2] == "SUCCESS"
        data = mock_send.call_args[0][3]
        assert data["registrySeeded"] is True
        client.create_registry_record.assert_called_once()

    def test_ddb_failure_still_fails_the_deploy(self):
        """DynamoDB/S3 seeding stays authoritative — its own errors must
        still surface as FAILED, unlike registry errors."""
        mock_table = MagicMock()
        mock_table.put_item.side_effect = _client_error(
            "ProvisionedThroughputExceededException"
        )
        mock_dynamodb = MagicMock()
        mock_dynamodb.Table.return_value = mock_table

        env_patch = dict(os.environ)
        env_patch["REGISTRY_ID"] = REGISTRY_ID
        env_patch["REGISTRY_ENABLED"] = "true"

        with patch.dict(os.environ, env_patch, clear=True), \
             patch("index.boto3") as mock_boto3, \
             patch("cfnresponse.send") as mock_send:
            mock_boto3.resource.return_value = mock_dynamodb
            mock_boto3.client.return_value = MagicMock()
            handler(_cfn_event(), _ctx())

        assert mock_send.call_args[0][2] == "FAILED"
