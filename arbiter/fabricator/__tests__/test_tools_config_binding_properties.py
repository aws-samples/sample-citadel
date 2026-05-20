"""
Property-based tests for Fabricator Binding Persistence Round-Trip.

# Feature: tool-integration-binding, Property 10: Fabricator Binding Persistence Round-Trip

Tests cover:
- store_tool_config_dynamo: when called with integration_bindings and datastore_bindings,
  the resulting DynamoDB item contains integrationBindings and dataStoreBindings deeply
  equal to the inputs.

**Validates: Requirements 7.1, 7.2, 7.3**
"""

import sys
import os
import json
from unittest.mock import patch, MagicMock

sys.path.insert(0, os.path.join(os.path.dirname(__file__), ".."))

os.environ.setdefault("TOOL_CONFIG_TABLE", "fake-tool-table")
os.environ.setdefault("AGENT_CONFIG_TABLE", "fake-agent-table")
os.environ.setdefault("AGENT_BUCKET_NAME", "fake-bucket")
os.environ.setdefault("COMPLETION_BUS_NAME", "fake-bus")
os.environ.setdefault("WORKER_QUEUE_URL", "https://sqs.fake/queue")

import pytest
from hypothesis import given, settings, HealthCheck
from hypothesis import strategies as st

from index import store_tool_config_dynamo


# ---------------------------------------------------------------------------
# Strategies
# ---------------------------------------------------------------------------

# Realistic IDs: non-empty alphanumeric strings with dashes/underscores
binding_id = st.text(
    min_size=1,
    max_size=30,
    alphabet=st.characters(whitelist_categories=("L", "N"), whitelist_characters="-_"),
)

# Integration type names
integration_type = st.sampled_from([
    "CONFLUENCE", "JIRA", "SLACK", "SERVICENOW",
    "ZENDESK", "PAGERDUTY", "MICROSOFT",
])

# Data store type names
datastore_type = st.sampled_from([
    "S3", "DYNAMODB", "RDS_POSTGRESQL", "RDS_MYSQL",
    "AURORA_POSTGRESQL", "AURORA_MYSQL", "KNOWLEDGE_BASE",
    "REDSHIFT", "OPENSEARCH", "NEPTUNE", "TIMESTREAM",
    "DOCUMENTDB", "ELASTICACHE_REDIS",
])

# Operation IDs
operation_id = st.text(
    min_size=1,
    max_size=30,
    alphabet=st.characters(whitelist_categories=("L",), whitelist_characters="_"),
)

# A single integration binding dict
integration_binding = st.fixed_dictionaries({
    "integrationId": binding_id,
    "integrationType": integration_type,
}, optional={
    "operations": st.lists(operation_id, min_size=0, max_size=5),
})

# A single data store binding dict
datastore_binding = st.fixed_dictionaries({
    "dataStoreId": binding_id,
    "dataStoreType": datastore_type,
}, optional={
    "operations": st.lists(operation_id, min_size=0, max_size=5),
})

# Tool metadata
tool_id_st = st.text(
    min_size=1,
    max_size=30,
    alphabet=st.characters(whitelist_categories=("L", "N"), whitelist_characters="_"),
)

tool_description_st = st.text(min_size=1, max_size=200)

tool_schema_st = st.fixed_dictionaries({
    "type": st.just("object"),
    "properties": st.dictionaries(
        st.text(min_size=1, max_size=20, alphabet=st.characters(whitelist_categories=("L",))),
        st.fixed_dictionaries({
            "type": st.sampled_from(["string", "integer", "number", "boolean"]),
            "description": st.text(min_size=1, max_size=100),
        }),
        min_size=1,
        max_size=3,
    ),
    "required": st.lists(
        st.text(min_size=1, max_size=20, alphabet=st.characters(whitelist_categories=("L",))),
        max_size=3,
    ),
})


# ---------------------------------------------------------------------------
# Property 10: Fabricator Binding Persistence Round-Trip
# ---------------------------------------------------------------------------

class TestFabricatorBindingPersistenceRoundTrip:
    """
    Property 10: Fabricator Binding Persistence Round-Trip

    For any valid integration_bindings and datastore_bindings lists,
    calling store_tool_config_dynamo with those bindings should produce
    a DynamoDB item where integrationBindings and dataStoreBindings are
    deeply equal to the inputs.

    **Validates: Requirements 7.1, 7.2, 7.3**
    """

    @given(
        tool_id=tool_id_st,
        tool_schema=tool_schema_st,
        tool_description=tool_description_st,
        int_bindings=st.lists(integration_binding, min_size=1, max_size=5),
        ds_bindings=st.lists(datastore_binding, min_size=1, max_size=5),
    )
    @settings(max_examples=100, suppress_health_check=[HealthCheck.too_slow])
    def test_both_bindings_persisted_in_dynamo_item(
        self, tool_id, tool_schema, tool_description, int_bindings, ds_bindings
    ):
        """DynamoDB item contains integrationBindings and dataStoreBindings
        deeply equal to the inputs when both are provided."""
        mock_table = MagicMock()
        mock_dynamo = MagicMock()
        mock_dynamo.Table.return_value = mock_table

        with patch("index.boto3") as mock_boto3:
            mock_boto3.resource.return_value = mock_dynamo
            store_tool_config_dynamo(
                file_name="/tmp/test_tool.py",
                tool_id=tool_id,
                tool_schema=tool_schema,
                tool_description=tool_description,
                integration_bindings=int_bindings,
                datastore_bindings=ds_bindings,
            )

        # Capture the item passed to put_item
        mock_table.put_item.assert_called_once()
        item = mock_table.put_item.call_args[1]["Item"]

        assert item["integrationBindings"] == int_bindings
        assert item["dataStoreBindings"] == ds_bindings

    @given(
        tool_id=tool_id_st,
        tool_schema=tool_schema_st,
        tool_description=tool_description_st,
        int_bindings=st.lists(integration_binding, min_size=1, max_size=5),
    )
    @settings(max_examples=100, suppress_health_check=[HealthCheck.too_slow])
    def test_only_integration_bindings_persisted(
        self, tool_id, tool_schema, tool_description, int_bindings
    ):
        """When only integration_bindings are provided, integrationBindings
        appears on the item and dataStoreBindings is absent."""
        mock_table = MagicMock()
        mock_dynamo = MagicMock()
        mock_dynamo.Table.return_value = mock_table

        with patch("index.boto3") as mock_boto3:
            mock_boto3.resource.return_value = mock_dynamo
            store_tool_config_dynamo(
                file_name="/tmp/test_tool.py",
                tool_id=tool_id,
                tool_schema=tool_schema,
                tool_description=tool_description,
                integration_bindings=int_bindings,
            )

        item = mock_table.put_item.call_args[1]["Item"]

        assert item["integrationBindings"] == int_bindings
        assert "dataStoreBindings" not in item

    @given(
        tool_id=tool_id_st,
        tool_schema=tool_schema_st,
        tool_description=tool_description_st,
        ds_bindings=st.lists(datastore_binding, min_size=1, max_size=5),
    )
    @settings(max_examples=100, suppress_health_check=[HealthCheck.too_slow])
    def test_only_datastore_bindings_persisted(
        self, tool_id, tool_schema, tool_description, ds_bindings
    ):
        """When only datastore_bindings are provided, dataStoreBindings
        appears on the item and integrationBindings is absent."""
        mock_table = MagicMock()
        mock_dynamo = MagicMock()
        mock_dynamo.Table.return_value = mock_table

        with patch("index.boto3") as mock_boto3:
            mock_boto3.resource.return_value = mock_dynamo
            store_tool_config_dynamo(
                file_name="/tmp/test_tool.py",
                tool_id=tool_id,
                tool_schema=tool_schema,
                tool_description=tool_description,
                datastore_bindings=ds_bindings,
            )

        item = mock_table.put_item.call_args[1]["Item"]

        assert "integrationBindings" not in item
        assert item["dataStoreBindings"] == ds_bindings

    @given(
        tool_id=tool_id_st,
        tool_schema=tool_schema_st,
        tool_description=tool_description_st,
    )
    @settings(max_examples=100, suppress_health_check=[HealthCheck.too_slow])
    def test_no_bindings_omits_binding_fields(
        self, tool_id, tool_schema, tool_description
    ):
        """When neither binding parameter is provided, the DynamoDB item
        contains no integrationBindings or dataStoreBindings fields."""
        mock_table = MagicMock()
        mock_dynamo = MagicMock()
        mock_dynamo.Table.return_value = mock_table

        with patch("index.boto3") as mock_boto3:
            mock_boto3.resource.return_value = mock_dynamo
            store_tool_config_dynamo(
                file_name="/tmp/test_tool.py",
                tool_id=tool_id,
                tool_schema=tool_schema,
                tool_description=tool_description,
            )

        item = mock_table.put_item.call_args[1]["Item"]

        assert "integrationBindings" not in item
        assert "dataStoreBindings" not in item
