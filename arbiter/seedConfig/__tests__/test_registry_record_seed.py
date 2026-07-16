"""Registry-record seeding tests for arbiter/seedConfig/index.py.

The out-of-box demo flow gates app publish on the demo agent's BINDING
flipping DESIGN -> READY. updateAgentBinding (backend/src/lambda/
registry-agent-record-resolver.ts) resolves the target agent BY NAME in the
AgentCore Registry and requires the record's descriptor ``state`` to be
'active'. The seed therefore must ALSO create a Registry record for
``demo-echo-agent`` — mirroring the fabricator's store_agent_config_registry
payload shape (arbiter/fabricator/index.py) — while keeping the existing DDB
row for worker dispatch.

Contract under test:
  - When REGISTRY_ID + REGISTRY_ENABLED are present, the handler creates one
    Registry record named 'demo-echo-agent' via CreateRegistryRecord with the
    fabricator-shaped CUSTOM descriptor (categories/icon/state/manifest/
    config/createdBy/orgId), state 'active', config.filename pointing at the
    S3 module key, and a non-empty description.
  - Like the fabricator, the record is left in its post-create DRAFT state —
    no UpdateRegistryRecordStatus / SubmitRegistryRecordForApproval calls.
  - IDEMPOTENT: when a record with that name already exists (lookup first),
    CreateRegistryRecord is skipped.
  - Skipped entirely (no registry API calls) when the registry env vars are
    absent, and when catalog.registry_client is unavailable (DDB-only envs).
  - DDB row seeding is unchanged in all cases.
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

from index import handler  # noqa: E402

REGISTRY_ID = "fake-registry-id"
WORKER_QUEUE_URL = os.environ["WORKER_QUEUE_URL"]


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


def _make_registry_client(record_id="abc123def456"):
    client = MagicMock(name="bedrock-agentcore-control-mock")
    client.create_registry_record.return_value = {
        "recordArn": (
            "arn:aws:bedrock-agentcore:us-west-2:123456789012:"
            f"registry/reg/record/{record_id}"
        ),
        "recordId": record_id,
        "status": "DRAFT",
    }
    return client


def _run_handler(registry_env, existing_records, registry_client):
    """Invoke the Create handler with mocked boto3 + catalog lookup.

    Returns (mock_table, mock_boto3, mock_send, list_mock).
    """
    mock_table = MagicMock()
    mock_dynamodb = MagicMock()
    mock_dynamodb.Table.return_value = mock_table

    def _client_factory(service_name, *args, **kwargs):
        if service_name == "bedrock-agentcore-control":
            return registry_client
        return MagicMock(name=f"{service_name}-mock")

    env_patch = dict(os.environ)
    env_patch.pop("REGISTRY_ID", None)
    env_patch.pop("REGISTRY_ENABLED", None)
    if registry_env:
        env_patch["REGISTRY_ID"] = REGISTRY_ID
        env_patch["REGISTRY_ENABLED"] = "true"

    list_mock = MagicMock(return_value=existing_records)

    with patch.dict(os.environ, env_patch, clear=True), \
         patch("index.boto3") as mock_boto3, \
         patch("catalog.registry_client.list_agent_records", list_mock), \
         patch("cfnresponse.send") as mock_send:
        mock_boto3.resource.return_value = mock_dynamodb
        mock_boto3.client.side_effect = _client_factory
        handler(_cfn_event(), _ctx())

    return mock_table, mock_boto3, mock_send, list_mock


class TestRegistryRecordCreated:
    def test_creates_record_with_fabricator_shaped_payload(self):
        client = _make_registry_client()
        _, _, mock_send, list_mock = _run_handler(
            registry_env=True, existing_records=[], registry_client=client
        )

        assert mock_send.call_args[0][2] == "SUCCESS"
        list_mock.assert_called_once_with(REGISTRY_ID)
        client.create_registry_record.assert_called_once()
        kwargs = client.create_registry_record.call_args.kwargs

        assert kwargs["registryId"] == REGISTRY_ID
        assert kwargs["name"] == "demo-echo-agent"
        assert isinstance(kwargs["description"], str) and kwargs["description"]
        assert kwargs["descriptorType"] == "CUSTOM"

        metadata = json.loads(kwargs["descriptors"]["custom"]["inlineContent"])
        # Fabricator descriptor shape (store_agent_config_registry).
        for field in (
            "categories", "icon", "state", "manifest", "config",
            "createdBy", "orgId",
        ):
            assert field in metadata, f"missing descriptor field: {field}"
        # READY flip gate: updateAgentBinding requires descriptor state
        # 'active' before a binding may transition to READY.
        assert metadata["state"] == "active"
        assert metadata["config"]["name"] == "demo-echo-agent"
        assert metadata["config"]["filename"] == "demo_echo_agent.py"
        assert metadata["config"]["action"] == {
            "type": "sqs",
            "target": WORKER_QUEUE_URL,
        }
        assert metadata["manifest"]["name"] == "demo-echo-agent"
        assert metadata["manifest"]["description"] == kwargs["description"]

    def test_no_status_mutation_after_create(self):
        """Mirror the fabricator: the record stays in post-create DRAFT."""
        client = _make_registry_client()
        _run_handler(
            registry_env=True, existing_records=[], registry_client=client
        )
        client.update_registry_record_status.assert_not_called()
        client.submit_registry_record_for_approval.assert_not_called()

    def test_ddb_seeding_unchanged_when_registry_configured(self):
        client = _make_registry_client()
        mock_table, _, _, _ = _run_handler(
            registry_env=True, existing_records=[], registry_client=client
        )
        assert mock_table.put_item.call_count == 5
        items = [c.kwargs["Item"] for c in mock_table.put_item.call_args_list]
        echo = [i for i in items if i.get("agentId") == "demo-echo-agent"]
        assert len(echo) == 1
        assert echo[0]["state"] == "active"
        assert echo[0]["config"]["filename"] == "demo_echo_agent.py"


class TestRegistrySkippedWhenNotConfigured:
    def test_no_registry_calls_when_env_absent(self):
        client = _make_registry_client()
        mock_table, mock_boto3, mock_send, list_mock = _run_handler(
            registry_env=False, existing_records=[], registry_client=client
        )
        assert mock_send.call_args[0][2] == "SUCCESS"
        list_mock.assert_not_called()
        client.create_registry_record.assert_not_called()
        service_names = [
            c.args[0] for c in mock_boto3.client.call_args_list if c.args
        ]
        assert "bedrock-agentcore-control" not in service_names
        # DDB seeding still runs.
        assert mock_table.put_item.call_count == 5

    def test_skips_when_catalog_client_unavailable(self):
        """DDB-only envs (no catalog layer) must still seed successfully."""
        client = _make_registry_client()
        mock_table = MagicMock()
        mock_dynamodb = MagicMock()
        mock_dynamodb.Table.return_value = mock_table

        env_patch = dict(os.environ)
        env_patch["REGISTRY_ID"] = REGISTRY_ID
        env_patch["REGISTRY_ENABLED"] = "true"

        with patch.dict(os.environ, env_patch, clear=True), \
             patch.dict(
                 sys.modules,
                 {"catalog": None, "catalog.registry_client": None},
             ), \
             patch("index.boto3") as mock_boto3, \
             patch("cfnresponse.send") as mock_send:
            mock_boto3.resource.return_value = mock_dynamodb
            mock_boto3.client.return_value = MagicMock()
            handler(_cfn_event(), _ctx())

        assert mock_send.call_args[0][2] == "SUCCESS"
        client.create_registry_record.assert_not_called()
        assert mock_table.put_item.call_count == 5


class TestIdempotency:
    def test_skips_create_when_record_already_exists(self):
        client = _make_registry_client()
        existing = [
            {"recordId": "zzz999zzz999", "name": "some-other-agent",
             "status": "DRAFT", "updatedAt": None},
            {"recordId": "abc123def456", "name": "demo-echo-agent",
             "status": "DRAFT", "updatedAt": None},
        ]
        mock_table, _, mock_send, list_mock = _run_handler(
            registry_env=True, existing_records=existing,
            registry_client=client,
        )
        assert mock_send.call_args[0][2] == "SUCCESS"
        list_mock.assert_called_once_with(REGISTRY_ID)
        client.create_registry_record.assert_not_called()
        # DDB seeding unchanged.
        assert mock_table.put_item.call_count == 5

    def test_name_match_is_exact(self):
        """A prefix-similar record must not suppress the create."""
        client = _make_registry_client()
        existing = [
            {"recordId": "zzz999zzz999", "name": "demo-echo-agent-v2",
             "status": "DRAFT", "updatedAt": None},
        ]
        _run_handler(
            registry_env=True, existing_records=existing,
            registry_client=client,
        )
        client.create_registry_record.assert_called_once()
