"""
Property-based tests for aggregate_tool_bindings in workerWrapper/index.py.

# Feature: tool-integration-binding, Property 3: Tool Binding Aggregation Collects All Unique IDs

Tests cover:
- aggregate_tool_bindings: collects all unique integration IDs and data store IDs
  from arbitrary lists of tool configs with arbitrary bindings.

**Validates: Requirements 2.1**
"""

import sys
import os

import pytest
from hypothesis import given, settings, HealthCheck
from hypothesis import strategies as st

sys.path.insert(0, os.path.join(os.path.dirname(__file__), ".."))

os.environ.setdefault("AGENT_CONFIG_TABLE", "fake-table")
os.environ.setdefault("AGENT_BUCKET_NAME", "fake-bucket")
os.environ.setdefault("COMPLETION_BUS_NAME", "fake-bus")
os.environ.setdefault("CREDENTIAL_VENDER_FUNCTION", "")

from index import aggregate_tool_bindings


# ---------------------------------------------------------------------------
# Strategies
# ---------------------------------------------------------------------------

# Generate realistic IDs: non-empty alphanumeric strings with dashes
binding_id = st.text(
    min_size=1,
    max_size=30,
    alphabet=st.characters(whitelist_categories=("L", "N"), whitelist_characters="-_"),
)

# Integration type names (e.g., CONFLUENCE, SLACK, JIRA)
integration_type = st.sampled_from([
    "CONFLUENCE", "JIRA", "SLACK", "SERVICENOW",
    "ZENDESK", "PAGERDUTY", "MICROSOFT",
])

# Data store type names (e.g., S3, DYNAMODB, RDS_POSTGRESQL)
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

# A tool config dict with optional bindings
tool_config = st.fixed_dictionaries({
    "toolId": binding_id,
}, optional={
    "integrationBindings": st.lists(integration_binding, min_size=0, max_size=5),
    "dataStoreBindings": st.lists(datastore_binding, min_size=0, max_size=5),
})

# A list of tool configs
tool_config_list = st.lists(tool_config, min_size=0, max_size=10)


# ---------------------------------------------------------------------------
# Property 3: Tool Binding Aggregation Collects All Unique IDs
# ---------------------------------------------------------------------------

class TestBindingAggregationProperties:
    """
    Property 3: Tool Binding Aggregation Collects All Unique IDs

    For any list of tool configs with arbitrary integrationBindings and
    dataStoreBindings, aggregate_tool_bindings should return:
    - integrations: the set of all unique integrationId values across all tools
    - dataStores: the set of all unique dataStoreId values across all tools

    **Validates: Requirements 2.1**
    """

    @given(tool_configs=tool_config_list)
    @settings(max_examples=100, suppress_health_check=[HealthCheck.too_slow])
    def test_integration_ids_equal_union_of_all_binding_ids(self, tool_configs):
        """Returned integration IDs equal the union of all integrationId values."""
        result = aggregate_tool_bindings(tool_configs)

        # Compute expected: union of all integrationId values across all tools
        expected_integration_ids = set()
        for tool in tool_configs:
            for binding in tool.get("integrationBindings", []):
                expected_integration_ids.add(binding["integrationId"])

        actual_integration_ids = set(result["integrations"])
        assert actual_integration_ids == expected_integration_ids

    @given(tool_configs=tool_config_list)
    @settings(max_examples=100, suppress_health_check=[HealthCheck.too_slow])
    def test_datastore_ids_equal_union_of_all_binding_ids(self, tool_configs):
        """Returned data store IDs equal the union of all dataStoreId values."""
        result = aggregate_tool_bindings(tool_configs)

        # Compute expected: union of all dataStoreId values across all tools
        expected_datastore_ids = set()
        for tool in tool_configs:
            for binding in tool.get("dataStoreBindings", []):
                expected_datastore_ids.add(binding["dataStoreId"])

        actual_datastore_ids = set(result["dataStores"])
        assert actual_datastore_ids == expected_datastore_ids

    @given(tool_configs=tool_config_list)
    @settings(max_examples=100, suppress_health_check=[HealthCheck.too_slow])
    def test_no_duplicate_ids_in_result(self, tool_configs):
        """Returned ID lists contain no duplicates."""
        result = aggregate_tool_bindings(tool_configs)

        assert len(result["integrations"]) == len(set(result["integrations"]))
        assert len(result["dataStores"]) == len(set(result["dataStores"]))

    @given(tool_configs=tool_config_list)
    @settings(max_examples=100, suppress_health_check=[HealthCheck.too_slow])
    def test_result_has_required_keys(self, tool_configs):
        """Result always contains 'integrations' and 'dataStores' keys."""
        result = aggregate_tool_bindings(tool_configs)

        assert "integrations" in result
        assert "dataStores" in result
        assert isinstance(result["integrations"], list)
        assert isinstance(result["dataStores"], list)
