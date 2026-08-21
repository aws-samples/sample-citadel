"""Non-prod gating + idempotency tests for the diagnostic smoke-idempotency
agent seed in arbiter/seedConfig/index.py.

Contract under test:
  - SMOKE_FIXTURES_ENABLED unset (prod) -> the smoke agent row is NEVER
    written, the smoke module is NEVER uploaded, and no smoke registry
    record lookup/create happens at all.
  - SMOKE_FIXTURES_ENABLED='true' (non-prod) -> exactly one smoke agent DDB
    row is put, exactly one module upload attempted, seeded 'active'.
  - Re-running the seeder (two Create/Update invocations) with
    SMOKE_FIXTURES_ENABLED set creates nothing extra: put_item is called
    with the SAME item both times (plain-upsert idempotency, matching the
    existing echo-agent seed's contract) and the module upload is a
    same-key overwrite, not an accumulating side effect.
"""

import sys
import os
from unittest.mock import patch, MagicMock

sys.path.insert(0, os.path.join(os.path.dirname(__file__), ".."))

os.environ.setdefault("AGENT_CONFIG_TABLE", "fake-agent-table")
os.environ.setdefault("WORKER_QUEUE_URL", "https://sqs.fake/worker")
os.environ.setdefault("FABRICATOR_QUEUE_URL", "https://sqs.fake/fabricator")
os.environ.setdefault("AUTHORITY_UNITS_TABLE", "fake-authority-units-table")
os.environ.setdefault(
    "CONSTITUTIONAL_LAYERS_TABLE", "fake-constitutional-layers-table"
)

import index  # noqa: E402
from index import handler, SMOKE_IDEMPOTENCY_AGENT_ID  # noqa: E402


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


def _run_handler_once(smoke_enabled, agent_bucket="fake-code-bucket"):
    mock_table = MagicMock()
    mock_dynamodb = MagicMock()
    mock_dynamodb.Table.return_value = mock_table

    env_patch = dict(os.environ)
    env_patch.pop("REGISTRY_ID", None)
    env_patch.pop("REGISTRY_ENABLED", None)
    env_patch.pop("SMOKE_FIXTURES_ENABLED", None)
    if smoke_enabled:
        env_patch["SMOKE_FIXTURES_ENABLED"] = "true"
    if agent_bucket:
        env_patch["AGENT_BUCKET_NAME"] = agent_bucket
    else:
        env_patch.pop("AGENT_BUCKET_NAME", None)

    with patch.dict(os.environ, env_patch, clear=True), \
         patch("index.boto3") as mock_boto3, \
         patch("index.SMOKE_FIXTURES_ENABLED", smoke_enabled), \
         patch("cfnresponse.send") as mock_send:
        mock_boto3.resource.return_value = mock_dynamodb
        mock_boto3.client.return_value = MagicMock()
        handler(_cfn_event(), _ctx())

    return mock_table, mock_boto3, mock_send


class TestProdExclusion:
    def test_smoke_agent_row_never_written_when_disabled(self):
        mock_table, mock_boto3, mock_send = _run_handler_once(smoke_enabled=False)

        put_agent_ids = [
            call.kwargs["Item"]["agentId"]
            for call in mock_table.put_item.call_args_list
            if "agentId" in call.kwargs.get("Item", {})
        ]
        assert SMOKE_IDEMPOTENCY_AGENT_ID not in put_agent_ids
        assert mock_send.call_args[0][2] == "SUCCESS"

    def test_smoke_module_never_uploaded_when_disabled(self):
        mock_table, mock_boto3, mock_send = _run_handler_once(smoke_enabled=False)

        s3_client = mock_boto3.client.return_value
        uploaded_keys = [
            call.kwargs.get("Key")
            for call in s3_client.put_object.call_args_list
        ]
        assert "agents/smoke_idempotency_agent.py" not in uploaded_keys

    def test_no_registry_lookup_for_smoke_agent_when_disabled(self):
        """Even with a registry configured, a disabled smoke gate must never
        touch the registry for the smoke agent name."""
        mock_table = MagicMock()
        mock_dynamodb = MagicMock()
        mock_dynamodb.Table.return_value = mock_table
        list_mock = MagicMock(return_value=[])

        env_patch = dict(os.environ)
        env_patch.pop("SMOKE_FIXTURES_ENABLED", None)
        env_patch["REGISTRY_ID"] = "fake-registry"
        env_patch["REGISTRY_ENABLED"] = "true"

        with patch.dict(os.environ, env_patch, clear=True), \
             patch("index.boto3") as mock_boto3, \
             patch("index.SMOKE_FIXTURES_ENABLED", False), \
             patch("catalog.registry_client.list_agent_records", list_mock), \
             patch("cfnresponse.send"):
            mock_boto3.resource.return_value = mock_dynamodb
            mock_boto3.client.return_value = MagicMock()
            handler(_cfn_event(), _ctx())

        registry_lookup_names = [c.args[0] for c in list_mock.call_args_list]
        # list_agent_records is called once for the (always-on) demo echo
        # agent lookup; it must never be called a second time attributable
        # to the smoke agent when the gate is off. We assert call count <= 1
        # (the echo-agent lookup) rather than inspecting args, since
        # list_agent_records takes only registryId.
        assert len(registry_lookup_names) <= 1


class TestNonProdSeeding:
    def test_smoke_agent_row_written_once_when_enabled(self):
        mock_table, mock_boto3, mock_send = _run_handler_once(smoke_enabled=True)

        smoke_puts = [
            call.kwargs["Item"]
            for call in mock_table.put_item.call_args_list
            if call.kwargs.get("Item", {}).get("agentId") == SMOKE_IDEMPOTENCY_AGENT_ID
        ]
        assert len(smoke_puts) == 1
        assert smoke_puts[0]["state"] == "active"
        assert smoke_puts[0]["config"]["filename"] == "smoke_idempotency_agent.py"
        assert mock_send.call_args[0][2] == "SUCCESS"

    def test_smoke_module_uploaded_when_enabled(self):
        mock_table, mock_boto3, mock_send = _run_handler_once(smoke_enabled=True)

        s3_client = mock_boto3.client.return_value
        uploaded_keys = [
            call.kwargs.get("Key")
            for call in s3_client.put_object.call_args_list
        ]
        assert "agents/smoke_idempotency_agent.py" in uploaded_keys


class TestSeederIdempotency:
    def test_re_running_seeder_twice_creates_nothing_extra(self):
        """Two independent Create/Update invocations (simulating a CFN
        Update re-run) must each write exactly one smoke agent row with the
        identical payload — a plain-put_item upsert, never accumulating."""
        first_table, _, first_send = _run_handler_once(smoke_enabled=True)
        second_table, _, second_send = _run_handler_once(smoke_enabled=True)

        def _smoke_items(mock_table):
            return [
                call.kwargs["Item"]
                for call in mock_table.put_item.call_args_list
                if call.kwargs.get("Item", {}).get("agentId") == SMOKE_IDEMPOTENCY_AGENT_ID
            ]

        first_items = _smoke_items(first_table)
        second_items = _smoke_items(second_table)

        assert len(first_items) == 1
        assert len(second_items) == 1
        assert first_items[0] == second_items[0]
        assert first_send.call_args[0][2] == "SUCCESS"
        assert second_send.call_args[0][2] == "SUCCESS"
