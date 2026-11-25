"""Tests that store_agent_config_dynamo and store_agent_config_registry
reject reserved workflow-tracking keys as agent ids, before any write.

Background (finding — reserved agent ids): agent_id is an LLM-chosen
argument of the store_agent_config_registry @tool. Previously,
store_agent_config_dynamo wrote config['name'] = agent_id straight to the
CONFIG table with no check, so a fabricated agent named "data" or
"requestId" (the two reserved top-level attributes on the supervisor's
workflow tracking DynamoDB item, see
arbiter/common/workflow_tracking.RESERVED_WORKFLOW_TRACKING_KEYS) was only
caught much later, by the supervisor's ValueError in
create_workflow_tracking_record — after the agent config had already been
persisted. Both store_agent_config_dynamo and store_agent_config_registry
now reject these agent_id values up front, using the same shared constant
the supervisor uses, before any put_item / CreateRegistryRecord call.
"""

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
os.environ.setdefault("REGISTRY_ID", "fake-registry-id")
os.environ.setdefault("AWS_DEFAULT_REGION", "us-west-2")

from index import (  # noqa: E402
    store_agent_config_dynamo,
    store_agent_config_registry,
)
from common.workflow_tracking import RESERVED_WORKFLOW_TRACKING_KEYS  # noqa: E402


class TestStoreAgentConfigDynamoRejectsReservedKeys:
    """store_agent_config_dynamo must reject a reserved agent_id before
    calling put_item."""

    @pytest.mark.parametrize("reserved_key", sorted(RESERVED_WORKFLOW_TRACKING_KEYS))
    def test_rejects_each_reserved_key(self, reserved_key):
        mock_table = MagicMock()
        mock_dynamo = MagicMock()
        mock_dynamo.Table.return_value = mock_table

        with patch("index.boto3") as mock_boto3:
            mock_boto3.resource.return_value = mock_dynamo
            with pytest.raises(ValueError, match="reserved workflow"):
                store_agent_config_dynamo(
                    file_name="agents/x.py",
                    agent_id=reserved_key,
                    llm_tool_schema={"type": "object", "properties": {}},
                    agent_description="desc",
                )

        mock_table.put_item.assert_not_called()

    def test_happy_path_allows_non_reserved_agent_id(self):
        mock_table = MagicMock()
        mock_table.put_item.return_value = {}
        mock_dynamo = MagicMock()
        mock_dynamo.Table.return_value = mock_table

        with patch("index.boto3") as mock_boto3:
            mock_boto3.resource.return_value = mock_dynamo
            result = store_agent_config_dynamo(
                file_name="agents/billing.py",
                agent_id="billing-agent-v1",
                llm_tool_schema={"type": "object", "properties": {}},
                agent_description="Billing agent",
            )

        assert result is True
        mock_table.put_item.assert_called_once()


class TestStoreAgentConfigRegistryRejectsReservedKeys:
    """store_agent_config_registry must reject a reserved agent_id before
    the existing-record lookup or CreateRegistryRecord."""

    @pytest.mark.parametrize("reserved_key", sorted(RESERVED_WORKFLOW_TRACKING_KEYS))
    def test_rejects_each_reserved_key(self, reserved_key):
        with patch("index._find_existing_record_id") as mock_find, \
                patch("index._get_registry_client") as mock_get_client:
            with pytest.raises(ValueError, match="reserved workflow"):
                store_agent_config_registry(
                    file_name="agents/x.py",
                    agent_id=reserved_key,
                    llm_tool_schema={"type": "object", "properties": {}},
                    agent_description="desc",
                )

        mock_find.assert_not_called()
        mock_get_client.return_value.create_registry_record.assert_not_called()

    def test_happy_path_allows_non_reserved_agent_id(self):
        record_id = "gen-record-id"
        mock_client = MagicMock()
        mock_client.create_registry_record.return_value = {
            "recordArn": f"arn:aws:bedrock-agentcore:us-west-2:123456789012:registry/reg/record/{record_id}",
            "recordId": record_id,
            "status": "DRAFT",
        }

        with patch("index._find_existing_record_id", return_value=None), \
                patch("index._get_registry_client", return_value=mock_client):
            result = store_agent_config_registry(
                file_name="agents/billing.py",
                agent_id="billing-agent-v1",
                llm_tool_schema={"type": "object", "properties": {}},
                agent_description="Billing agent",
            )

        assert result is True
        mock_client.create_registry_record.assert_called_once()
