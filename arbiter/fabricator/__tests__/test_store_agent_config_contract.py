"""store_agent_config_dynamo / store_agent_config_registry refuse agent configs
the supervisor cannot turn into a tool, before any write.

Background: the supervisor builds one Converse tool per active agent from
``config['name']``, ``config['description']`` and ``config['schema']``. An
active record whose name or description is empty, or whose schema no tool input
schema can be derived from, is skipped at dispatch time. The fabricator wrote
whatever the LLM passed. Both writers now require:

  - a non-empty ``agent_id`` (becomes ``config['name']``);
  - a non-empty ``agent_description``;
  - a ``llm_tool_schema`` for which ``common.agent_config_contract.
    can_derive_tool_schema`` is true (the shapes the supervisor accepts: an
    object schema, a schema with ``properties`` and no ``type``, an OpenAPI
    document, a ``{"function": ...}`` / ``inputSchema`` / ``parameters``
    wrapper, or a JSON string of one of those).

Violations raise ValueError (same style as the reserved-name guard) before any
put_item / CreateRegistryRecord / existing-record lookup. Accepted schemas are
stored exactly as the writers stored them before; the supervisor derives the
tool schema on read.
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
os.environ.setdefault("REGISTRY_ID", "fake-registry-id")
os.environ.setdefault("AWS_DEFAULT_REGION", "us-west-2")

from index import (  # noqa: E402
    store_agent_config_dynamo,
    store_agent_config_registry,
)

_GOOD_SCHEMA = {"type": "object", "properties": {"q": {"type": "string"}}}

# Shapes the supervisor cannot derive a tool input schema from.
_UNDERIVABLE_SCHEMAS = {
    "type-string": {"type": "string"},
    "type-array": {"type": "array", "items": {}},
    "empty-dict": {},
    "unknown-keys-only": {"foo": "bar"},
    "list": [{"type": "object"}],
    "none": None,
    "json-string-of-list": "[1, 2]",
    "json-string-type-string": '{"type": "string"}',
    "bare-number": 7,
    "function-wrapper-bad-parameters": {"type": "function", "function": {"parameters": [1]}},
}

# Shapes the supervisor derives a tool from; the writers must not refuse them.
_DERIVABLE_SCHEMAS = {
    "type-missing-with-properties": {"properties": {"q": {"type": "string"}}},
    "openapi-document": {"openapi": "3.0.0", "info": {"title": "x"}, "paths": {}},
    "function-wrapper": {"type": "function", "function": {"name": "f", "parameters": _GOOD_SCHEMA}},
    "inputSchema-wrapper": {"name": "t", "inputSchema": _GOOD_SCHEMA},
    "parameters-wrapper": {"parameters": _GOOD_SCHEMA},
}


def _call_dynamo(**overrides):
    mock_table = MagicMock()
    mock_table.put_item.return_value = {}
    mock_dynamo = MagicMock()
    mock_dynamo.Table.return_value = mock_table
    kwargs = {
        "file_name": "agents/billing.py",
        "agent_id": "billing-agent-v1",
        "llm_tool_schema": dict(_GOOD_SCHEMA),
        "agent_description": "Billing agent",
    }
    kwargs.update(overrides)
    with patch("index.boto3") as mock_boto3:
        mock_boto3.resource.return_value = mock_dynamo
        try:
            result = store_agent_config_dynamo(**kwargs)
            error = None
        except ValueError as exc:
            result, error = None, exc
    return result, error, mock_table


def _call_registry(**overrides):
    mock_client = MagicMock()
    mock_client.create_registry_record.return_value = {
        "recordArn": "arn:aws:bedrock-agentcore:us-west-2:123456789012:registry/reg/record/rec1",
        "recordId": "rec1",
        "status": "DRAFT",
    }
    kwargs = {
        "file_name": "agents/billing.py",
        "agent_id": "billing-agent-v1",
        "llm_tool_schema": dict(_GOOD_SCHEMA),
        "agent_description": "Billing agent",
    }
    kwargs.update(overrides)
    with patch("index._find_existing_record_id", return_value=None) as mock_find, \
            patch("index._get_registry_client", return_value=mock_client):
        try:
            result = store_agent_config_registry(**kwargs)
            error = None
        except ValueError as exc:
            result, error = None, exc
    return result, error, mock_client, mock_find


def _registry_config(mock_client) -> dict:
    data = mock_client.create_registry_record.call_args.kwargs["descriptors"]["custom"]["data"]
    return json.loads(data)["config"]


class TestDynamoRejectsIncompleteConfig:
    def test_sanity_good_input_is_written(self):
        result, error, table = _call_dynamo()
        assert error is None
        assert result is True
        table.put_item.assert_called_once()

    @pytest.mark.parametrize("agent_id", ["", "   ", None])
    def test_rejects_empty_name(self, agent_id):
        _, error, table = _call_dynamo(agent_id=agent_id)
        assert isinstance(error, ValueError)
        assert "name" in str(error)
        table.put_item.assert_not_called()

    @pytest.mark.parametrize("description", ["", "   ", None])
    def test_rejects_empty_description(self, description):
        _, error, table = _call_dynamo(agent_description=description)
        assert isinstance(error, ValueError)
        assert "description" in str(error)
        table.put_item.assert_not_called()

    @pytest.mark.parametrize("label", sorted(_UNDERIVABLE_SCHEMAS))
    def test_rejects_schema_no_tool_schema_can_be_derived_from(self, label):
        _, error, table = _call_dynamo(llm_tool_schema=_UNDERIVABLE_SCHEMAS[label])
        assert isinstance(error, ValueError)
        assert "schema" in str(error)
        table.put_item.assert_not_called()

    @pytest.mark.parametrize("label", sorted(_DERIVABLE_SCHEMAS))
    def test_accepts_schema_the_supervisor_can_derive_a_tool_from(self, label):
        schema = _DERIVABLE_SCHEMAS[label]
        result, error, table = _call_dynamo(llm_tool_schema=schema)
        assert error is None
        assert result is True
        assert table.put_item.call_args.kwargs["Item"]["config"]["schema"] == schema

    def test_json_string_object_schema_is_accepted(self):
        result, error, table = _call_dynamo(llm_tool_schema=json.dumps(_GOOD_SCHEMA))
        assert error is None
        assert table.put_item.call_args.kwargs["Item"]["config"]["schema"] == _GOOD_SCHEMA

    def test_unparseable_json_string_schema_raises_value_error_before_write(self):
        _, error, table = _call_dynamo(llm_tool_schema="{not json")
        assert isinstance(error, ValueError)
        table.put_item.assert_not_called()


class TestRegistryRejectsIncompleteConfig:
    def test_sanity_good_input_is_written(self):
        result, error, client, _ = _call_registry()
        assert error is None
        assert result is True
        client.create_registry_record.assert_called_once()

    @pytest.mark.parametrize("agent_id", ["", "   ", None])
    def test_rejects_empty_name(self, agent_id):
        _, error, client, find = _call_registry(agent_id=agent_id)
        assert isinstance(error, ValueError)
        assert "name" in str(error)
        find.assert_not_called()
        client.create_registry_record.assert_not_called()

    @pytest.mark.parametrize("description", ["", "   ", None])
    def test_rejects_empty_description(self, description):
        _, error, client, find = _call_registry(agent_description=description)
        assert isinstance(error, ValueError)
        assert "description" in str(error)
        find.assert_not_called()
        client.create_registry_record.assert_not_called()

    @pytest.mark.parametrize("label", sorted(_UNDERIVABLE_SCHEMAS))
    def test_rejects_schema_no_tool_schema_can_be_derived_from(self, label):
        _, error, client, find = _call_registry(llm_tool_schema=_UNDERIVABLE_SCHEMAS[label])
        assert isinstance(error, ValueError)
        assert "schema" in str(error)
        find.assert_not_called()
        client.create_registry_record.assert_not_called()

    @pytest.mark.parametrize("label", sorted(_DERIVABLE_SCHEMAS))
    def test_accepts_schema_the_supervisor_can_derive_a_tool_from(self, label):
        schema = _DERIVABLE_SCHEMAS[label]
        result, error, client, _ = _call_registry(llm_tool_schema=schema)
        assert error is None
        assert result is True
        assert _registry_config(client)["schema"] == schema

    def test_json_string_object_schema_is_accepted(self):
        _, error, client, _ = _call_registry(llm_tool_schema=json.dumps(_GOOD_SCHEMA))
        assert error is None
        assert _registry_config(client)["schema"] == _GOOD_SCHEMA

    def test_unparseable_json_string_schema_raises_value_error_before_write(self):
        _, error, client, find = _call_registry(llm_tool_schema="{not json")
        assert isinstance(error, ValueError)
        find.assert_not_called()
        client.create_registry_record.assert_not_called()
