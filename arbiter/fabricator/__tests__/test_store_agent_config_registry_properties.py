"""
Property-based tests for store_agent_config_registry.

Covers task 9.1 of the agentcore-registry-migration spec:
  - Calls CreateRegistryRecord with agent metadata and custom metadata
  - Sets initial status to DRAFT (maps to inactive state)
  - On failure: logs error and publishes agent.fabrication.failed event
    to EventBridge

**Validates: Requirements 8.1, 8.3, 8.7**
"""

import sys
import os
import json
from unittest.mock import patch, MagicMock, call

import pytest
from hypothesis import given, settings
from hypothesis import strategies as st

sys.path.insert(0, os.path.join(os.path.dirname(__file__), ".."))

# Set required env vars before import
os.environ.setdefault("TOOL_CONFIG_TABLE", "fake-tool-table")
os.environ.setdefault("AGENT_CONFIG_TABLE", "fake-agent-table")
os.environ.setdefault("AGENT_BUCKET_NAME", "fake-bucket")
os.environ.setdefault("COMPLETION_BUS_NAME", "fake-bus")
os.environ.setdefault("WORKER_QUEUE_URL", "https://sqs.fake/queue")
os.environ.setdefault("REGISTRY_ID", "fake-registry-id")
os.environ.setdefault("AWS_DEFAULT_REGION", "us-west-2")

from index import store_agent_config_registry  # noqa: E402


# ---------------------------------------------------------------------------
# Strategies
# ---------------------------------------------------------------------------

safe_text = st.text(
    min_size=1, max_size=30,
    alphabet=st.characters(whitelist_categories=("L", "N")),
)

agent_ids = safe_text
app_ids = safe_text
descriptions = st.text(min_size=1, max_size=100)

tool_schemas = st.fixed_dictionaries({
    "type": st.just("object"),
    "properties": st.dictionaries(
        st.text(min_size=1, max_size=10, alphabet=st.characters(whitelist_categories=("L",))),
        st.fixed_dictionaries({
            "type": st.sampled_from(["string", "integer", "number", "boolean"]),
            "description": st.text(min_size=1, max_size=30),
        }),
        min_size=1, max_size=3,
    ),
    "required": st.lists(
        st.text(min_size=1, max_size=10, alphabet=st.characters(whitelist_categories=("L",))),
        min_size=0, max_size=3, unique=True,
    ),
})


def _make_registry_mock(record_id: str = "gen-record-id"):
    """Construct a mock boto3 client that returns a realistic CreateRecord response."""
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
    return client


# ---------------------------------------------------------------------------
# Requirement 8.1: CreateResource is called with agent metadata + custom metadata
# ---------------------------------------------------------------------------

class TestCreateResourceCall:
    """Verify store_agent_config_registry invokes CreateRegistryRecord correctly.

    **Validates: Requirements 8.1**
    """

    @given(agent_id=agent_ids, description=descriptions, schema=tool_schemas)
    @settings(max_examples=25)
    def test_calls_create_registry_record_with_registry_id(self, agent_id, description, schema):
        client = _make_registry_mock()
        with patch("index.boto3") as mock_boto3:
            mock_boto3.client.return_value = client
            store_agent_config_registry(
                file_name=f"/tmp/{agent_id}.py",
                agent_id=agent_id,
                llm_tool_schema=schema,
                agent_description=description,
            )

        assert client.create_registry_record.called
        kwargs = client.create_registry_record.call_args.kwargs
        assert kwargs["registryId"] == os.environ["REGISTRY_ID"]
        assert kwargs["name"] == agent_id

    @given(agent_id=agent_ids, description=descriptions, schema=tool_schemas)
    @settings(max_examples=25)
    def test_description_contains_agent_config_json(self, agent_id, description, schema):
        """The description field carries the executable agent config as JSON."""
        client = _make_registry_mock()
        with patch("index.boto3") as mock_boto3:
            mock_boto3.client.return_value = client
            store_agent_config_registry(
                file_name=f"/tmp/{agent_id}.py",
                agent_id=agent_id,
                llm_tool_schema=schema,
                agent_description=description,
            )

        kwargs = client.create_registry_record.call_args.kwargs
        config = json.loads(kwargs["description"])
        assert config["name"] == agent_id
        assert config["description"] == description
        assert config["schema"] == schema
        assert config["filename"] == f"{agent_id}.py"
        assert config["action"]["type"] == "sqs"

    @given(agent_id=agent_ids, description=descriptions, schema=tool_schemas)
    @settings(max_examples=25)
    def test_custom_descriptor_contains_custom_metadata(self, agent_id, description, schema):
        """Custom metadata is carried via descriptors.custom.inlineContent as JSON."""
        client = _make_registry_mock()
        with patch("index.boto3") as mock_boto3:
            mock_boto3.client.return_value = client
            store_agent_config_registry(
                file_name=f"/tmp/{agent_id}.py",
                agent_id=agent_id,
                llm_tool_schema=schema,
                agent_description=description,
            )

        kwargs = client.create_registry_record.call_args.kwargs
        assert kwargs["descriptorType"] == "CUSTOM"
        inline = kwargs["descriptors"]["custom"]["inlineContent"]
        meta = json.loads(inline)
        assert meta["categories"] == ["worker"]
        assert meta["state"] == "inactive"
        assert meta["manifest"]["name"] == agent_id
        assert meta["manifest"]["description"] == description

    @given(agent_id=agent_ids, app_id=app_ids, schema=tool_schemas)
    @settings(max_examples=20)
    def test_app_id_included_in_custom_metadata_when_provided(self, agent_id, app_id, schema):
        client = _make_registry_mock()
        with patch("index.boto3") as mock_boto3:
            mock_boto3.client.return_value = client
            store_agent_config_registry(
                file_name=f"/tmp/{agent_id}.py",
                agent_id=agent_id,
                llm_tool_schema=schema,
                agent_description="desc",
                app_id=app_id,
            )

        kwargs = client.create_registry_record.call_args.kwargs
        meta = json.loads(kwargs["descriptors"]["custom"]["inlineContent"])
        assert meta["appId"] == app_id

    @given(agent_id=agent_ids, schema=tool_schemas)
    @settings(max_examples=20)
    def test_app_id_omitted_when_not_provided(self, agent_id, schema):
        client = _make_registry_mock()
        with patch("index.boto3") as mock_boto3:
            mock_boto3.client.return_value = client
            store_agent_config_registry(
                file_name=f"/tmp/{agent_id}.py",
                agent_id=agent_id,
                llm_tool_schema=schema,
                agent_description="desc",
            )

        kwargs = client.create_registry_record.call_args.kwargs
        meta = json.loads(kwargs["descriptors"]["custom"]["inlineContent"])
        assert "appId" not in meta


# ---------------------------------------------------------------------------
# Requirement 8.3: initial status is DRAFT (maps to inactive)
# ---------------------------------------------------------------------------

class TestInitialStatusDraft:
    """Verify records are created with DRAFT status / state inactive.

    **Validates: Requirements 8.3**
    """

    @given(agent_id=agent_ids, schema=tool_schemas)
    @settings(max_examples=20)
    def test_status_update_called_with_draft(self, agent_id, schema):
        client = _make_registry_mock(record_id="rec-123")
        with patch("index.boto3") as mock_boto3:
            mock_boto3.client.return_value = client
            store_agent_config_registry(
                file_name=f"/tmp/{agent_id}.py",
                agent_id=agent_id,
                llm_tool_schema=schema,
                agent_description="desc",
            )

        assert client.update_registry_record_status.called
        kwargs = client.update_registry_record_status.call_args.kwargs
        assert kwargs["status"] == "DRAFT"
        assert kwargs["registryId"] == os.environ["REGISTRY_ID"]
        # recordId is extracted from the create response ARN
        assert kwargs["recordId"] == "rec-123"

    @given(agent_id=agent_ids, schema=tool_schemas)
    @settings(max_examples=20)
    def test_custom_metadata_state_is_inactive(self, agent_id, schema):
        """state field in custom metadata is 'inactive' for fabricated agents."""
        client = _make_registry_mock()
        with patch("index.boto3") as mock_boto3:
            mock_boto3.client.return_value = client
            store_agent_config_registry(
                file_name=f"/tmp/{agent_id}.py",
                agent_id=agent_id,
                llm_tool_schema=schema,
                agent_description="desc",
            )

        kwargs = client.create_registry_record.call_args.kwargs
        meta = json.loads(kwargs["descriptors"]["custom"]["inlineContent"])
        assert meta["state"] == "inactive"


# ---------------------------------------------------------------------------
# Requirement 8.7: on failure, log and publish agent.fabrication.failed event
# ---------------------------------------------------------------------------

class TestFailureEmitsEvent:
    """Verify failures publish an EventBridge event and re-raise.

    **Validates: Requirements 8.7**
    """

    @given(agent_id=agent_ids, err_msg=st.text(min_size=1, max_size=80))
    @settings(max_examples=15)
    def test_create_failure_publishes_agent_fabrication_failed(self, agent_id, err_msg):
        client = MagicMock()
        client.create_registry_record.side_effect = RuntimeError(err_msg)

        with patch("index.boto3") as mock_boto3, \
             patch("index.publish_fabrication_event") as mock_publish:
            mock_boto3.client.return_value = client

            with pytest.raises(RuntimeError):
                store_agent_config_registry(
                    file_name=f"/tmp/{agent_id}.py",
                    agent_id=agent_id,
                    llm_tool_schema={"type": "object", "properties": {}, "required": []},
                    agent_description="desc",
                )

        assert mock_publish.called
        kwargs = mock_publish.call_args.kwargs
        assert kwargs["event_type"] == "agent.fabrication.failed"
        assert kwargs["agent_id"] == agent_id
        assert err_msg in kwargs["error"]

    @given(agent_id=agent_ids, app_id=app_ids)
    @settings(max_examples=15)
    def test_failure_event_includes_app_id(self, agent_id, app_id):
        client = MagicMock()
        client.create_registry_record.side_effect = RuntimeError("boom")

        with patch("index.boto3") as mock_boto3, \
             patch("index.publish_fabrication_event") as mock_publish:
            mock_boto3.client.return_value = client

            with pytest.raises(RuntimeError):
                store_agent_config_registry(
                    file_name=f"/tmp/{agent_id}.py",
                    agent_id=agent_id,
                    llm_tool_schema={"type": "object", "properties": {}, "required": []},
                    agent_description="desc",
                    app_id=app_id,
                )

        kwargs = mock_publish.call_args.kwargs
        assert kwargs["app_id"] == app_id

    def test_failure_swallows_publish_exception(self):
        """If publish_fabrication_event also fails, the original error still propagates."""
        client = MagicMock()
        client.create_registry_record.side_effect = RuntimeError("create-failed")

        with patch("index.boto3") as mock_boto3, \
             patch("index.publish_fabrication_event",
                   side_effect=Exception("event bus down")) as _:
            mock_boto3.client.return_value = client

            with pytest.raises(RuntimeError, match="create-failed"):
                store_agent_config_registry(
                    file_name="/tmp/a.py",
                    agent_id="a",
                    llm_tool_schema={"type": "object", "properties": {}},
                    agent_description="desc",
                )

    def test_missing_registry_id_raises_value_error(self):
        """Absence of REGISTRY_ID raises ValueError (before any API call)."""
        with patch.dict(os.environ, {}, clear=False):
            orig = os.environ.pop("REGISTRY_ID", None)
            try:
                with patch("index.boto3") as mock_boto3, \
                     patch("index.publish_fabrication_event"):
                    mock_boto3.client.return_value = MagicMock()
                    with pytest.raises(ValueError, match="REGISTRY_ID"):
                        store_agent_config_registry(
                            file_name="/tmp/a.py",
                            agent_id="a",
                            llm_tool_schema={"type": "object"},
                            agent_description="desc",
                        )
            finally:
                if orig is not None:
                    os.environ["REGISTRY_ID"] = orig


# ---------------------------------------------------------------------------
# Input normalization — schema-as-string handling
# ---------------------------------------------------------------------------

class TestSchemaAsString:
    """The LLM may pass llm_tool_schema as a JSON string — it must be parsed."""

    @given(agent_id=agent_ids, schema=tool_schemas)
    @settings(max_examples=15)
    def test_string_schema_is_parsed_to_dict(self, agent_id, schema):
        client = _make_registry_mock()
        with patch("index.boto3") as mock_boto3:
            mock_boto3.client.return_value = client
            store_agent_config_registry(
                file_name=f"/tmp/{agent_id}.py",
                agent_id=agent_id,
                llm_tool_schema=json.dumps(schema),
                agent_description="desc",
            )

        kwargs = client.create_registry_record.call_args.kwargs
        config = json.loads(kwargs["description"])
        assert config["schema"] == schema
