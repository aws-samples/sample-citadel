"""PR-4 (owner decision 5750aeec: FAIL CLOSED, no grandfathering) — tests
that ``store_agent_config_registry`` / ``store_tool_config_registry`` stamp
the server-derived ``required_permissions`` into both the executable
``config`` dict and the top-level ``custom_metadata`` (inlineContent), so
the registry mapper and the worker's dispatch gate both see it.
"""
import sys
import os
import json
from unittest.mock import patch, MagicMock

import pytest

sys.path.insert(0, os.path.join(os.path.dirname(__file__), ".."))

os.environ.setdefault("TOOL_CONFIG_TABLE", "fake-tool-table")
os.environ.setdefault("AGENT_CONFIG_TABLE", "fake-agent-table")
os.environ.setdefault("AGENT_BUCKET_NAME", "fake-bucket")
os.environ.setdefault("COMPLETION_BUS_NAME", "fake-bus")
os.environ.setdefault("WORKER_QUEUE_URL", "https://sqs.fake/queue")
os.environ.setdefault("REGISTRY_ID", "fake-registry-id")
os.environ.setdefault("AWS_DEFAULT_REGION", "us-west-2")

import index  # noqa: E402
from index import store_agent_config_registry, store_tool_config_registry  # noqa: E402


def _make_registry_mock(record_id: str = "gen-record-id"):
    client = MagicMock()
    client.create_registry_record.return_value = {
        "recordArn": f"arn:aws:bedrock-agentcore:us-west-2:123456789012:registry/reg/record/{record_id}",
        "recordId": record_id,
        "status": "DRAFT",
    }
    client.update_registry_record_status.return_value = {
        "recordId": record_id,
        "status": "DRAFT",
    }
    client.submit_registry_record_for_approval.return_value = {
        "recordId": record_id,
        "status": "APPROVED",
    }
    client.list_registry_records.return_value = {"items": []}
    return client


@pytest.fixture(autouse=True)
def _reset_cached_client():
    index._reset_registry_client_for_test()
    yield
    index._reset_registry_client_for_test()


class TestStoreAgentConfigRegistryStampsPermissions:
    def test_required_permissions_stamped_into_config_and_metadata(self):
        client = _make_registry_mock()
        perms = {"integrations": ["int-1"], "dataStores": ["ds-1"]}
        with patch("index._get_registry_client", return_value=client):
            store_agent_config_registry(
                file_name="/tmp/agent.py",
                agent_id="agent-1",
                llm_tool_schema={"type": "object"},
                agent_description="does things",
                required_permissions=perms,
            )

        kwargs = client.create_registry_record.call_args.kwargs
        inline = json.loads(kwargs["descriptors"]["custom"]["data"])
        assert inline["requiredPermissions"] == perms
        assert inline["config"]["requiredPermissions"] == perms

    def test_none_required_permissions_leaves_key_absent(self):
        """Legacy callers passing no required_permissions must not have the
        key injected as null — absent, not None, so the worker's deny-
        default check (absent treated same as empty) behaves identically
        to today for callers that haven't adopted PR-4 stamping yet."""
        client = _make_registry_mock()
        with patch("index._get_registry_client", return_value=client):
            store_agent_config_registry(
                file_name="/tmp/agent.py",
                agent_id="agent-2",
                llm_tool_schema={"type": "object"},
                agent_description="does things",
            )

        kwargs = client.create_registry_record.call_args.kwargs
        inline = json.loads(kwargs["descriptors"]["custom"]["data"])
        assert "requiredPermissions" not in inline
        assert "requiredPermissions" not in inline["config"]

    def test_deny_default_empty_permissions_still_stamped_explicitly(self):
        """An explicit empty permission set (deny-default — no bindings
        declared) IS stamped (not treated as 'None/absent') so the record
        carries the EXPLICIT refusal-worthy signal rather than looking like
        a legacy unstamped record."""
        client = _make_registry_mock()
        empty_perms = {"integrations": [], "dataStores": []}
        with patch("index._get_registry_client", return_value=client):
            store_agent_config_registry(
                file_name="/tmp/agent.py",
                agent_id="agent-3",
                llm_tool_schema={"type": "object"},
                agent_description="does things",
                required_permissions=empty_perms,
            )

        kwargs = client.create_registry_record.call_args.kwargs
        inline = json.loads(kwargs["descriptors"]["custom"]["data"])
        assert inline["requiredPermissions"] == empty_perms
        assert inline["config"]["requiredPermissions"] == empty_perms


class TestStoreToolConfigRegistryStampsPermissions:
    def test_required_permissions_stamped_into_config_and_metadata(self):
        client = _make_registry_mock()
        perms = {"integrations": ["int-9"], "dataStores": []}
        with patch("index._get_registry_client", return_value=client):
            store_tool_config_registry(
                file_name="/tmp/tool.py",
                tool_id="tool-1",
                tool_schema={"type": "object"},
                tool_description="does tool things",
                org_id="org-1",
                required_permissions=perms,
            )

        kwargs = client.create_registry_record.call_args.kwargs
        inline = json.loads(kwargs["descriptors"]["custom"]["data"])
        assert inline["requiredPermissions"] == perms
        assert inline["config"]["requiredPermissions"] == perms

    def test_none_required_permissions_leaves_key_absent(self):
        client = _make_registry_mock()
        with patch("index._get_registry_client", return_value=client):
            store_tool_config_registry(
                file_name="/tmp/tool.py",
                tool_id="tool-2",
                tool_schema={"type": "object"},
                tool_description="does tool things",
                org_id="org-1",
            )

        kwargs = client.create_registry_record.call_args.kwargs
        inline = json.loads(kwargs["descriptors"]["custom"]["data"])
        assert "requiredPermissions" not in inline
        assert "requiredPermissions" not in inline["config"]
