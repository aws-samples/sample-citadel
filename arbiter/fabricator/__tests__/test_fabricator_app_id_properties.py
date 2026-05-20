"""
Property-based tests for Fabricator appId passthrough.

Tests that store_agent_config_dynamo, store_tool_config_dynamo, and
publish_fabrication_event correctly include appId when present and omit it
when absent.

Validates: Requirements 6.1, 6.2
"""

import sys
import os
import json
from unittest.mock import patch, MagicMock

import pytest
from hypothesis import given, assume, settings
from hypothesis import strategies as st

sys.path.insert(0, os.path.join(os.path.dirname(__file__), ".."))

# Set required env vars before import
os.environ.setdefault("TOOL_CONFIG_TABLE", "fake-tool-table")
os.environ.setdefault("AGENT_CONFIG_TABLE", "fake-agent-table")
os.environ.setdefault("AGENT_BUCKET_NAME", "fake-bucket")
os.environ.setdefault("COMPLETION_BUS_NAME", "fake-bus")
os.environ.setdefault("WORKER_QUEUE_URL", "https://sqs.fake/queue")

from index import publish_fabrication_event


# ---------------------------------------------------------------------------
# Strategies
# ---------------------------------------------------------------------------

safe_text = st.text(
    min_size=1, max_size=50,
    alphabet=st.characters(whitelist_categories=("L", "N", "Pd")),
)

app_ids = st.text(
    min_size=1, max_size=50,
    alphabet=st.characters(whitelist_categories=("L", "N", "Pd")),
)

orchestration_ids = safe_text
agent_ids = safe_text
tool_ids = safe_text
event_types = st.sampled_from(["agent.fabricated", "tool.fabricated", "agent.fabrication.failed"])
error_messages = st.text(min_size=1, max_size=200)

tool_schemas = st.fixed_dictionaries({
    "type": st.just("object"),
    "properties": st.dictionaries(
        st.text(min_size=1, max_size=10, alphabet=st.characters(whitelist_categories=("L",))),
        st.fixed_dictionaries({
            "type": st.sampled_from(["string", "integer", "number", "boolean"]),
            "description": st.text(min_size=1, max_size=50),
        }),
        min_size=1,
        max_size=3,
    ),
})

file_names = st.text(
    min_size=1, max_size=20,
    alphabet=st.characters(whitelist_categories=("L", "N")),
).map(lambda s: f"/tmp/{s}.py")

descriptions = st.text(min_size=1, max_size=100)


# ---------------------------------------------------------------------------
# publish_fabrication_event — appId passthrough
# ---------------------------------------------------------------------------

class TestPublishFabricationEventAppId:
    """
    Property tests for publish_fabrication_event appId passthrough.

    **Validates: Requirements 6.2**
    """

    @given(
        orch_id=orchestration_ids,
        event_type=event_types,
        agent_id=agent_ids,
        app_id=app_ids,
    )
    @settings(max_examples=50)
    def test_app_id_included_when_present(self, orch_id, event_type, agent_id, app_id):
        """When appId is provided, the event detail includes it."""
        mock_client = MagicMock()
        mock_client.put_events.return_value = {"FailedEntryCount": 0}

        with patch("index.boto3") as mock_boto3:
            mock_boto3.client.return_value = mock_client
            publish_fabrication_event(orch_id, event_type, agent_id=agent_id, app_id=app_id)

        call_args = mock_client.put_events.call_args
        entries = call_args[1]["Entries"] if "Entries" in call_args[1] else call_args[0][0]
        detail = json.loads(entries[0]["Detail"])
        assert detail["appId"] == app_id

    @given(
        orch_id=orchestration_ids,
        event_type=event_types,
        agent_id=agent_ids,
    )
    @settings(max_examples=50)
    def test_app_id_omitted_when_none(self, orch_id, event_type, agent_id):
        """When appId is None, the event detail does not contain appId."""
        mock_client = MagicMock()
        mock_client.put_events.return_value = {"FailedEntryCount": 0}

        with patch("index.boto3") as mock_boto3:
            mock_boto3.client.return_value = mock_client
            publish_fabrication_event(orch_id, event_type, agent_id=agent_id)

        call_args = mock_client.put_events.call_args
        entries = call_args[1]["Entries"] if "Entries" in call_args[1] else call_args[0][0]
        detail = json.loads(entries[0]["Detail"])
        assert "appId" not in detail


# ---------------------------------------------------------------------------
# store_agent_config_dynamo — appId passthrough
# ---------------------------------------------------------------------------

class TestStoreAgentConfigAppId:
    """
    Property tests for store_agent_config_dynamo appId passthrough.

    **Validates: Requirements 6.1**
    """

    @given(
        agent_id=agent_ids,
        file_name=file_names,
        schema=tool_schemas,
        description=descriptions,
        app_id=app_ids,
    )
    @settings(max_examples=50)
    def test_app_id_stored_when_present(self, agent_id, file_name, schema, description, app_id):
        """When appId is provided, the DynamoDB item includes it."""
        mock_table = MagicMock()
        mock_dynamo = MagicMock()
        mock_dynamo.Table.return_value = mock_table

        with patch("index.boto3") as mock_boto3:
            mock_boto3.resource.return_value = mock_dynamo
            # Import the raw function (unwrap @tool decorator)
            from index import store_agent_config_dynamo
            fn = store_agent_config_dynamo
            # The @tool decorator wraps the function; call the underlying
            fn(
                file_name=file_name,
                agent_id=agent_id,
                llm_tool_schema=schema,
                agent_description=description,
                app_id=app_id,
            )

        put_call = mock_table.put_item.call_args
        item = put_call[1]["Item"] if "Item" in put_call[1] else put_call[0][0]
        assert item["appId"] == app_id

    @given(
        agent_id=agent_ids,
        file_name=file_names,
        schema=tool_schemas,
        description=descriptions,
    )
    @settings(max_examples=50)
    def test_app_id_omitted_when_none(self, agent_id, file_name, schema, description):
        """When appId is None, the DynamoDB item does not contain appId."""
        mock_table = MagicMock()
        mock_dynamo = MagicMock()
        mock_dynamo.Table.return_value = mock_table

        with patch("index.boto3") as mock_boto3:
            mock_boto3.resource.return_value = mock_dynamo
            from index import store_agent_config_dynamo
            fn = store_agent_config_dynamo
            fn(
                file_name=file_name,
                agent_id=agent_id,
                llm_tool_schema=schema,
                agent_description=description,
            )

        put_call = mock_table.put_item.call_args
        item = put_call[1]["Item"] if "Item" in put_call[1] else put_call[0][0]
        assert "appId" not in item


# ---------------------------------------------------------------------------
# store_tool_config_dynamo — appId passthrough
# ---------------------------------------------------------------------------

class TestStoreToolConfigAppId:
    """
    Property tests for store_tool_config_dynamo appId passthrough.

    **Validates: Requirements 6.1**
    """

    @given(
        tool_id=tool_ids,
        file_name=file_names,
        schema=tool_schemas,
        description=descriptions,
        app_id=app_ids,
    )
    @settings(max_examples=50)
    def test_app_id_stored_when_present(self, tool_id, file_name, schema, description, app_id):
        """When appId is provided, the DynamoDB item includes it."""
        mock_table = MagicMock()
        mock_dynamo = MagicMock()
        mock_dynamo.Table.return_value = mock_table

        with patch("index.boto3") as mock_boto3:
            mock_boto3.resource.return_value = mock_dynamo
            from index import store_tool_config_dynamo
            fn = store_tool_config_dynamo
            fn(
                file_name=file_name,
                tool_id=tool_id,
                tool_schema=schema,
                tool_description=description,
                app_id=app_id,
            )

        put_call = mock_table.put_item.call_args
        item = put_call[1]["Item"] if "Item" in put_call[1] else put_call[0][0]
        assert item["appId"] == app_id

    @given(
        tool_id=tool_ids,
        file_name=file_names,
        schema=tool_schemas,
        description=descriptions,
    )
    @settings(max_examples=50)
    def test_app_id_omitted_when_none(self, tool_id, file_name, schema, description):
        """When appId is None, the DynamoDB item does not contain appId."""
        mock_table = MagicMock()
        mock_dynamo = MagicMock()
        mock_dynamo.Table.return_value = mock_table

        with patch("index.boto3") as mock_boto3:
            mock_boto3.resource.return_value = mock_dynamo
            from index import store_tool_config_dynamo
            fn = store_tool_config_dynamo
            fn(
                file_name=file_name,
                tool_id=tool_id,
                tool_schema=schema,
                tool_description=description,
            )

        put_call = mock_table.put_item.call_args
        item = put_call[1]["Item"] if "Item" in put_call[1] else put_call[0][0]
        assert "appId" not in item
