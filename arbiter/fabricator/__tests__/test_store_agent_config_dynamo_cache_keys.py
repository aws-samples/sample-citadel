"""
Tests that store_agent_config_dynamo writes sourceProjectId and
registryRecordId into every DynamoDB agent-cache item, so the
sourceProjectId-index GSI is populated at fabrication time
(not only after registry-sync runs).
"""

import json
import os
import sys
from unittest.mock import MagicMock, patch

import pytest

sys.path.insert(0, os.path.join(os.path.dirname(__file__), ".."))

os.environ.setdefault("AGENT_CONFIG_TABLE", "fake-agent-table")
os.environ.setdefault("AGENT_BUCKET_NAME", "fake-bucket")
os.environ.setdefault("COMPLETION_BUS_NAME", "fake-bus")
os.environ.setdefault("WORKER_QUEUE_URL", "https://sqs.fake/queue")
os.environ.setdefault("TOOL_CONFIG_TABLE", "fake-tool-table")


class TestStoreAgentConfigDynamoCacheKeys:
    """store_agent_config_dynamo must always write sourceProjectId and
    registryRecordId so the GSI is populated at write time."""

    def test_put_item_includes_source_project_id_when_provided(self):
        from index import store_agent_config_dynamo

        mock_table = MagicMock()
        mock_table.put_item.return_value = {}
        mock_dynamo = MagicMock()
        mock_dynamo.Table.return_value = mock_table

        with patch("index.boto3") as mock_boto3:
            mock_boto3.resource.return_value = mock_dynamo
            store_agent_config_dynamo(
                file_name="agents/billing.py",
                agent_id="billing-agent-v1",
                llm_tool_schema={"type": "object", "properties": {}},
                agent_description="Billing agent",
                source_project_id="proj-42",
                registry_record_id="rec-abc",
            )

        call_args = mock_table.put_item.call_args
        item = call_args[1]["Item"] if "Item" in call_args[1] else call_args[0][0]["Item"]
        assert item["sourceProjectId"] == "proj-42"
        assert item["registryRecordId"] == "rec-abc"

    def test_put_item_omits_source_project_id_when_none(self):
        from index import store_agent_config_dynamo

        mock_table = MagicMock()
        mock_table.put_item.return_value = {}
        mock_dynamo = MagicMock()
        mock_dynamo.Table.return_value = mock_table

        with patch("index.boto3") as mock_boto3:
            mock_boto3.resource.return_value = mock_dynamo
            store_agent_config_dynamo(
                file_name="agents/billing.py",
                agent_id="billing-agent-v2",
                llm_tool_schema={"type": "object", "properties": {}},
                agent_description="Billing agent v2",
            )

        call_args = mock_table.put_item.call_args
        item = call_args[1]["Item"] if "Item" in call_args[1] else call_args[0][0]["Item"]
        assert "sourceProjectId" not in item
        assert "registryRecordId" not in item

    def test_put_item_includes_registry_record_id_without_project(self):
        """registryRecordId can be set independently of sourceProjectId."""
        from index import store_agent_config_dynamo

        mock_table = MagicMock()
        mock_table.put_item.return_value = {}
        mock_dynamo = MagicMock()
        mock_dynamo.Table.return_value = mock_table

        with patch("index.boto3") as mock_boto3:
            mock_boto3.resource.return_value = mock_dynamo
            store_agent_config_dynamo(
                file_name="agents/billing.py",
                agent_id="billing-agent-v3",
                llm_tool_schema={"type": "object", "properties": {}},
                agent_description="Billing agent v3",
                registry_record_id="rec-xyz",
            )

        call_args = mock_table.put_item.call_args
        item = call_args[1]["Item"] if "Item" in call_args[1] else call_args[0][0]["Item"]
        assert item["registryRecordId"] == "rec-xyz"
        assert "sourceProjectId" not in item
