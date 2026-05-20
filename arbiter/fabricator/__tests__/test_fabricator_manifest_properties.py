"""
Property-based tests for Fabricator auto-generated agent manifest.

Tests that store_agent_config_dynamo generates and stores an AgentManifest
in the DynamoDB item during agent creation.

**Validates: Requirements 15.5**
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

from index import store_agent_config_dynamo


# ---------------------------------------------------------------------------
# Strategies
# ---------------------------------------------------------------------------

safe_text = st.text(
    min_size=1, max_size=50,
    alphabet=st.characters(whitelist_categories=("L", "N", "Pd")),
)

agent_ids = safe_text

file_names = st.text(
    min_size=1, max_size=20,
    alphabet=st.characters(whitelist_categories=("L", "N")),
).map(lambda s: f"/tmp/{s}.py")

descriptions = st.text(min_size=1, max_size=100)

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

tool_id_lists = st.lists(
    st.text(min_size=1, max_size=20, alphabet=st.characters(whitelist_categories=("L", "N", "Pd"))),
    min_size=0,
    max_size=5,
)


# ---------------------------------------------------------------------------
# Manifest auto-generation properties
# ---------------------------------------------------------------------------

class TestManifestAutoGeneration:
    """
    Property tests for auto-generated manifest in store_agent_config_dynamo.

    **Validates: Requirements 15.5**
    """

    @given(
        agent_id=agent_ids,
        file_name=file_names,
        schema=tool_schemas,
        description=descriptions,
    )
    @settings(max_examples=50)
    def test_manifest_always_present_in_item(self, agent_id, file_name, schema, description):
        """The DynamoDB item always contains a 'manifest' field."""
        mock_table = MagicMock()
        mock_dynamo = MagicMock()
        mock_dynamo.Table.return_value = mock_table

        with patch("index.boto3") as mock_boto3:
            mock_boto3.resource.return_value = mock_dynamo
            store_agent_config_dynamo(
                file_name=file_name,
                agent_id=agent_id,
                llm_tool_schema=schema,
                agent_description=description,
            )

        put_call = mock_table.put_item.call_args
        item = put_call[1]["Item"] if "Item" in put_call[1] else put_call[0][0]
        assert "manifest" in item

    @given(
        agent_id=agent_ids,
        file_name=file_names,
        schema=tool_schemas,
        description=descriptions,
    )
    @settings(max_examples=50)
    def test_manifest_name_equals_agent_id(self, agent_id, file_name, schema, description):
        """The manifest 'name' field always equals the agent_id."""
        mock_table = MagicMock()
        mock_dynamo = MagicMock()
        mock_dynamo.Table.return_value = mock_table

        with patch("index.boto3") as mock_boto3:
            mock_boto3.resource.return_value = mock_dynamo
            store_agent_config_dynamo(
                file_name=file_name,
                agent_id=agent_id,
                llm_tool_schema=schema,
                agent_description=description,
            )

        put_call = mock_table.put_item.call_args
        item = put_call[1]["Item"] if "Item" in put_call[1] else put_call[0][0]
        assert item["manifest"]["name"] == agent_id

    @given(
        agent_id=agent_ids,
        file_name=file_names,
        schema=tool_schemas,
        description=descriptions,
    )
    @settings(max_examples=50)
    def test_manifest_description_equals_agent_description(self, agent_id, file_name, schema, description):
        """The manifest 'description' field always equals the agent_description."""
        mock_table = MagicMock()
        mock_dynamo = MagicMock()
        mock_dynamo.Table.return_value = mock_table

        with patch("index.boto3") as mock_boto3:
            mock_boto3.resource.return_value = mock_dynamo
            store_agent_config_dynamo(
                file_name=file_name,
                agent_id=agent_id,
                llm_tool_schema=schema,
                agent_description=description,
            )

        put_call = mock_table.put_item.call_args
        item = put_call[1]["Item"] if "Item" in put_call[1] else put_call[0][0]
        assert item["manifest"]["description"] == description

    @given(
        agent_id=agent_ids,
        file_name=file_names,
        schema=tool_schemas,
        description=descriptions,
    )
    @settings(max_examples=50)
    def test_manifest_version_is_1_0(self, agent_id, file_name, schema, description):
        """The manifest 'version' field is always '1.0' for initial creation."""
        mock_table = MagicMock()
        mock_dynamo = MagicMock()
        mock_dynamo.Table.return_value = mock_table

        with patch("index.boto3") as mock_boto3:
            mock_boto3.resource.return_value = mock_dynamo
            store_agent_config_dynamo(
                file_name=file_name,
                agent_id=agent_id,
                llm_tool_schema=schema,
                agent_description=description,
            )

        put_call = mock_table.put_item.call_args
        item = put_call[1]["Item"] if "Item" in put_call[1] else put_call[0][0]
        assert item["manifest"]["version"] == "1.0"

    @given(
        agent_id=agent_ids,
        file_name=file_names,
        schema=tool_schemas,
        description=descriptions,
    )
    @settings(max_examples=50)
    def test_manifest_tools_is_list(self, agent_id, file_name, schema, description):
        """The manifest 'tools' field is always a list."""
        mock_table = MagicMock()
        mock_dynamo = MagicMock()
        mock_dynamo.Table.return_value = mock_table

        with patch("index.boto3") as mock_boto3:
            mock_boto3.resource.return_value = mock_dynamo
            store_agent_config_dynamo(
                file_name=file_name,
                agent_id=agent_id,
                llm_tool_schema=schema,
                agent_description=description,
            )

        put_call = mock_table.put_item.call_args
        item = put_call[1]["Item"] if "Item" in put_call[1] else put_call[0][0]
        assert isinstance(item["manifest"]["tools"], list)

    @given(
        agent_id=agent_ids,
        file_name=file_names,
        schema=tool_schemas,
        description=descriptions,
    )
    @settings(max_examples=50)
    def test_manifest_has_all_required_fields(self, agent_id, file_name, schema, description):
        """The manifest always contains all required fields: name, description, version."""
        mock_table = MagicMock()
        mock_dynamo = MagicMock()
        mock_dynamo.Table.return_value = mock_table

        with patch("index.boto3") as mock_boto3:
            mock_boto3.resource.return_value = mock_dynamo
            store_agent_config_dynamo(
                file_name=file_name,
                agent_id=agent_id,
                llm_tool_schema=schema,
                agent_description=description,
            )

        put_call = mock_table.put_item.call_args
        item = put_call[1]["Item"] if "Item" in put_call[1] else put_call[0][0]
        manifest = item["manifest"]
        assert "name" in manifest
        assert "description" in manifest
        assert "version" in manifest
        assert "tools" in manifest

    @given(
        agent_id=agent_ids,
        file_name=file_names,
        schema=tool_schemas,
        description=descriptions,
    )
    @settings(max_examples=50)
    def test_manifest_round_trip_serialization(self, agent_id, file_name, schema, description):
        """Serializing then deserializing the manifest produces an equivalent object."""
        mock_table = MagicMock()
        mock_dynamo = MagicMock()
        mock_dynamo.Table.return_value = mock_table

        with patch("index.boto3") as mock_boto3:
            mock_boto3.resource.return_value = mock_dynamo
            store_agent_config_dynamo(
                file_name=file_name,
                agent_id=agent_id,
                llm_tool_schema=schema,
                agent_description=description,
            )

        put_call = mock_table.put_item.call_args
        item = put_call[1]["Item"] if "Item" in put_call[1] else put_call[0][0]
        manifest = item["manifest"]
        serialized = json.dumps(manifest)
        deserialized = json.loads(serialized)
        assert deserialized == manifest
