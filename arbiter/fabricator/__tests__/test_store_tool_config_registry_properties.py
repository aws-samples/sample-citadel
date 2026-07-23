"""
Property-based tests for store_tool_config_registry.

Covers task 9.2 of the agentcore-registry-migration spec:
  - Calls CreateRegistryRecord with tool metadata and custom metadata
    (including integrationBindings and dataStoreBindings)
  - Sets initial status to APPROVED (maps to active state)
  - On failure: logs error and publishes tool.fabrication.failed event
    to EventBridge

Post-boto3-1.42 contract (QB-013-2):
  - ``description`` on the record is the plain human-readable string,
    NOT a JSON blob of the executable config.
  - The full executable config is stashed under
    ``inlineContent.config``; the requester user id is stamped into
    ``inlineContent.createdBy`` (sourced from the event's
    ``requested_by`` field in ``process_event``).
  - Tool records deliberately do NOT carry a ``manifest`` key — that is
    the agent/tool type discriminator per commit 0a42938.

**Validates: Requirements 8.2, 8.4, 8.7**
"""

import sys
import os
import json
from unittest.mock import patch, MagicMock

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

from index import store_tool_config_registry  # noqa: E402
import index  # noqa: E402  — used for _reset_registry_client_for_test


# ---------------------------------------------------------------------------
# Strategies
# ---------------------------------------------------------------------------

safe_text = st.text(
    min_size=1, max_size=30,
    alphabet=st.characters(whitelist_categories=("L", "N")),
)

tool_ids = safe_text
app_ids = safe_text
requester_ids = safe_text
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

# Binding strategies — shape matches what the resolvers validate.
binding_id = st.text(
    min_size=1, max_size=20,
    alphabet=st.characters(whitelist_categories=("L", "N"), whitelist_characters="-_"),
)
operation_id = st.text(
    min_size=1, max_size=20,
    alphabet=st.characters(whitelist_categories=("L",), whitelist_characters="_"),
)

integration_binding = st.fixed_dictionaries({
    "integrationId": binding_id,
    "integrationType": st.sampled_from(["SLACK", "JIRA", "CONFLUENCE", "SERVICENOW"]),
    "operations": st.lists(operation_id, min_size=0, max_size=4),
    "direction": st.sampled_from(["INPUT", "OUTPUT", "BIDIRECTIONAL"]),
})
datastore_binding = st.fixed_dictionaries({
    "dataStoreId": binding_id,
    "dataStoreType": st.sampled_from(["S3", "DYNAMODB", "RDS_POSTGRESQL"]),
    "operations": st.lists(operation_id, min_size=0, max_size=4),
    "direction": st.sampled_from(["INPUT", "OUTPUT", "BIDIRECTIONAL"]),
})

integration_bindings_list = st.lists(integration_binding, min_size=1, max_size=3)
datastore_bindings_list = st.lists(datastore_binding, min_size=1, max_size=3)


def _make_registry_mock(record_id: str = "gen-record-id"):
    """Construct a mock boto3 client that returns a realistic CreateRecord response."""
    client = MagicMock()
    client.create_registry_record.return_value = {
        "recordArn": f"arn:aws:bedrock-agentcore:us-west-2:123456789012:registry/reg/record/{record_id}",
        "recordId": record_id,
        "status": "CREATING",
    }
    client.update_registry_record_status.return_value = {
        "recordId": record_id,
        "status": "APPROVED",
    }
    return client


@pytest.fixture(autouse=True)
def _reset_cached_client():
    """Clear the module-level lazy client between tests so the mocked
    ``_get_registry_client`` patch installs fresh each time."""
    index._reset_registry_client_for_test()
    yield
    index._reset_registry_client_for_test()


# ---------------------------------------------------------------------------
# Requirement 8.2: CreateResource is called with tool metadata + custom metadata
#                  (including bindings)
# ---------------------------------------------------------------------------

class TestCreateResourceCall:
    """Verify store_tool_config_registry invokes CreateRegistryRecord correctly.

    **Validates: Requirements 8.2**
    """

    @given(tool_id=tool_ids, description=descriptions, schema=tool_schemas)
    @settings(max_examples=25)
    def test_calls_create_registry_record_with_registry_id(self, tool_id, description, schema):
        client = _make_registry_mock()
        with patch("index._get_registry_client", return_value=client):
            store_tool_config_registry(
                file_name=f"/tmp/{tool_id}.py",
                tool_id=tool_id,
                tool_schema=schema,
                tool_description=description,
            )

        assert client.create_registry_record.called
        kwargs = client.create_registry_record.call_args.kwargs
        assert kwargs["registryId"] == os.environ["REGISTRY_ID"]
        assert kwargs["name"] == tool_id

    @given(tool_id=tool_ids, description=descriptions, schema=tool_schemas)
    @settings(max_examples=25)
    def test_description_is_plain_tool_description(self, tool_id, description, schema):
        """The description field is the plain human-readable string, NOT a JSON blob.

        Post-QB-013-2: executable config is stashed under inlineContent.config; the
        top-level description is rendered as text by the UI.
        """
        client = _make_registry_mock()
        with patch("index._get_registry_client", return_value=client):
            store_tool_config_registry(
                file_name=f"/tmp/{tool_id}.py",
                tool_id=tool_id,
                tool_schema=schema,
                tool_description=description,
            )

        kwargs = client.create_registry_record.call_args.kwargs
        assert kwargs["description"] == description

    @given(tool_id=tool_ids, description=descriptions, schema=tool_schemas)
    @settings(max_examples=25)
    def test_inline_content_contains_config(self, tool_id, description, schema):
        """Custom metadata round-trips full tool config via inlineContent."""
        client = _make_registry_mock()
        with patch("index._get_registry_client", return_value=client):
            store_tool_config_registry(
                file_name=f"/tmp/{tool_id}.py",
                tool_id=tool_id,
                tool_schema=schema,
                tool_description=description,
            )

        kwargs = client.create_registry_record.call_args.kwargs
        assert kwargs["descriptorType"] == "CUSTOM"
        inline = kwargs["descriptors"]["custom"]["inlineContent"]
        meta = json.loads(inline)

        # categories / icon / state — unchanged contract
        assert meta["categories"] == []
        assert meta["state"] == "active"
        assert meta["icon"] == ""

        # config — full executable config dict stashed here
        assert meta["config"]["name"] == tool_id
        assert meta["config"]["description"] == description
        assert meta["config"]["schema"] == schema
        assert meta["config"]["filename"] == f"{tool_id}.py"
        assert meta["config"]["version"] == 1

    @given(tool_id=tool_ids, schema=tool_schemas)
    @settings(max_examples=20)
    def test_tool_metadata_has_no_manifest_key(self, tool_id, schema):
        """Tool records deliberately do NOT carry a manifest key.

        Manifest is the agent/tool type discriminator — commit 0a42938 — and
        must be preserved.
        """
        client = _make_registry_mock()
        with patch("index._get_registry_client", return_value=client):
            store_tool_config_registry(
                file_name=f"/tmp/{tool_id}.py",
                tool_id=tool_id,
                tool_schema=schema,
                tool_description="desc",
            )

        kwargs = client.create_registry_record.call_args.kwargs
        meta = json.loads(kwargs["descriptors"]["custom"]["inlineContent"])
        assert "manifest" not in meta

    @given(tool_id=tool_ids, requester=requester_ids, schema=tool_schemas)
    @settings(max_examples=20)
    def test_created_by_reflects_requested_by_argument(self, tool_id, requester, schema):
        """createdBy is sourced from the requested_by kwarg (threaded from event)."""
        client = _make_registry_mock()
        with patch("index._get_registry_client", return_value=client):
            store_tool_config_registry(
                file_name=f"/tmp/{tool_id}.py",
                tool_id=tool_id,
                tool_schema=schema,
                tool_description="desc",
                requested_by=requester,
            )

        kwargs = client.create_registry_record.call_args.kwargs
        meta = json.loads(kwargs["descriptors"]["custom"]["inlineContent"])
        assert meta["createdBy"] == requester

    @given(tool_id=tool_ids, schema=tool_schemas)
    @settings(max_examples=10)
    def test_created_by_defaults_to_fabricator(self, tool_id, schema):
        """Callers that don't pass requested_by get the legacy 'fabricator' stamp."""
        client = _make_registry_mock()
        with patch("index._get_registry_client", return_value=client):
            store_tool_config_registry(
                file_name=f"/tmp/{tool_id}.py",
                tool_id=tool_id,
                tool_schema=schema,
                tool_description="desc",
            )

        kwargs = client.create_registry_record.call_args.kwargs
        meta = json.loads(kwargs["descriptors"]["custom"]["inlineContent"])
        assert meta["createdBy"] == "fabricator"

    @given(tool_id=tool_ids, org=safe_text, schema=tool_schemas)
    @settings(max_examples=20)
    def test_org_id_reflects_org_id_argument(self, tool_id, org, schema):
        """orgId is sourced from the org_id kwarg (threaded from event.org_id)."""
        client = _make_registry_mock()
        with patch("index._get_registry_client", return_value=client):
            store_tool_config_registry(
                file_name=f"/tmp/{tool_id}.py",
                tool_id=tool_id,
                tool_schema=schema,
                tool_description="desc",
                org_id=org,
            )

        kwargs = client.create_registry_record.call_args.kwargs
        meta = json.loads(kwargs["descriptors"]["custom"]["inlineContent"])
        assert meta["orgId"] == org

    @given(tool_id=tool_ids, schema=tool_schemas)
    @settings(max_examples=10)
    def test_org_id_defaults_to_empty_string(self, tool_id, schema):
        """Callers that don't pass org_id get '' — matches resolver's null fallback."""
        client = _make_registry_mock()
        with patch("index._get_registry_client", return_value=client):
            store_tool_config_registry(
                file_name=f"/tmp/{tool_id}.py",
                tool_id=tool_id,
                tool_schema=schema,
                tool_description="desc",
            )

        kwargs = client.create_registry_record.call_args.kwargs
        meta = json.loads(kwargs["descriptors"]["custom"]["inlineContent"])
        assert meta["orgId"] == ""

    @given(
        tool_id=tool_ids,
        schema=tool_schemas,
        bindings=integration_bindings_list,
    )
    @settings(max_examples=25)
    def test_integration_bindings_preserved_in_custom_metadata(self, tool_id, schema, bindings):
        """integrationBindings must round-trip verbatim into custom metadata."""
        client = _make_registry_mock()
        with patch("index._get_registry_client", return_value=client):
            store_tool_config_registry(
                file_name=f"/tmp/{tool_id}.py",
                tool_id=tool_id,
                tool_schema=schema,
                tool_description="desc",
                integration_bindings=bindings,
            )

        kwargs = client.create_registry_record.call_args.kwargs
        meta = json.loads(kwargs["descriptors"]["custom"]["inlineContent"])
        assert meta["integrationBindings"] == bindings

    @given(
        tool_id=tool_ids,
        schema=tool_schemas,
        bindings=datastore_bindings_list,
    )
    @settings(max_examples=25)
    def test_datastore_bindings_preserved_in_custom_metadata(self, tool_id, schema, bindings):
        """dataStoreBindings must round-trip verbatim into custom metadata."""
        client = _make_registry_mock()
        with patch("index._get_registry_client", return_value=client):
            store_tool_config_registry(
                file_name=f"/tmp/{tool_id}.py",
                tool_id=tool_id,
                tool_schema=schema,
                tool_description="desc",
                datastore_bindings=bindings,
            )

        kwargs = client.create_registry_record.call_args.kwargs
        meta = json.loads(kwargs["descriptors"]["custom"]["inlineContent"])
        assert meta["dataStoreBindings"] == bindings

    @given(
        tool_id=tool_ids,
        schema=tool_schemas,
        ibindings=integration_bindings_list,
        dbindings=datastore_bindings_list,
    )
    @settings(max_examples=20)
    def test_both_binding_types_preserved_together(
        self, tool_id, schema, ibindings, dbindings,
    ):
        client = _make_registry_mock()
        with patch("index._get_registry_client", return_value=client):
            store_tool_config_registry(
                file_name=f"/tmp/{tool_id}.py",
                tool_id=tool_id,
                tool_schema=schema,
                tool_description="desc",
                integration_bindings=ibindings,
                datastore_bindings=dbindings,
            )

        kwargs = client.create_registry_record.call_args.kwargs
        meta = json.loads(kwargs["descriptors"]["custom"]["inlineContent"])
        assert meta["integrationBindings"] == ibindings
        assert meta["dataStoreBindings"] == dbindings

    @given(tool_id=tool_ids, schema=tool_schemas)
    @settings(max_examples=15)
    def test_bindings_omitted_when_not_provided(self, tool_id, schema):
        """When bindings aren't supplied, the keys should not appear in metadata."""
        client = _make_registry_mock()
        with patch("index._get_registry_client", return_value=client):
            store_tool_config_registry(
                file_name=f"/tmp/{tool_id}.py",
                tool_id=tool_id,
                tool_schema=schema,
                tool_description="desc",
            )

        kwargs = client.create_registry_record.call_args.kwargs
        meta = json.loads(kwargs["descriptors"]["custom"]["inlineContent"])
        assert "integrationBindings" not in meta
        assert "dataStoreBindings" not in meta

    @given(tool_id=tool_ids, app_id=app_ids, schema=tool_schemas)
    @settings(max_examples=20)
    def test_app_id_included_in_custom_metadata_when_provided(self, tool_id, app_id, schema):
        client = _make_registry_mock()
        with patch("index._get_registry_client", return_value=client):
            store_tool_config_registry(
                file_name=f"/tmp/{tool_id}.py",
                tool_id=tool_id,
                tool_schema=schema,
                tool_description="desc",
                app_id=app_id,
            )

        kwargs = client.create_registry_record.call_args.kwargs
        meta = json.loads(kwargs["descriptors"]["custom"]["inlineContent"])
        assert meta["appId"] == app_id

    @given(tool_id=tool_ids, schema=tool_schemas)
    @settings(max_examples=20)
    def test_app_id_omitted_when_not_provided(self, tool_id, schema):
        client = _make_registry_mock()
        with patch("index._get_registry_client", return_value=client):
            store_tool_config_registry(
                file_name=f"/tmp/{tool_id}.py",
                tool_id=tool_id,
                tool_schema=schema,
                tool_description="desc",
            )

        kwargs = client.create_registry_record.call_args.kwargs
        meta = json.loads(kwargs["descriptors"]["custom"]["inlineContent"])
        assert "appId" not in meta


# ---------------------------------------------------------------------------
# Requirement 8.4: initial status is APPROVED (maps to active).
#
# UpdateRegistryRecordStatus accepts ONLY this enum (live-verified — a
# "PUBLISHED" value raised a ValidationException at index.py:1580):
#   CREATE_FAILED, DRAFT, UPDATING, PENDING_APPROVAL, UPDATE_FAILED,
#   DEPRECATED, APPROVED, CREATING, REJECTED
# APPROVED is the correct "immediately usable" terminal status: both the
# intake catalog (_registry_state_from_status) and the backend
# (registry-service.ts toInternalState) map the APPROVED family -> "active".
# ---------------------------------------------------------------------------

VALID_REGISTRY_STATUSES = {
    "CREATE_FAILED", "DRAFT", "UPDATING", "PENDING_APPROVAL", "UPDATE_FAILED",
    "DEPRECATED", "APPROVED", "CREATING", "REJECTED",
}


class TestInitialStatusApproved:
    """Verify records are moved to APPROVED status (internal state active).

    **Validates: Requirements 8.4**
    """

    @given(tool_id=tool_ids, schema=tool_schemas)
    @settings(max_examples=20)
    def test_status_update_called_with_approved(self, tool_id, schema):
        client = _make_registry_mock(record_id="rec-789")
        with patch("index._get_registry_client", return_value=client):
            store_tool_config_registry(
                file_name=f"/tmp/{tool_id}.py",
                tool_id=tool_id,
                tool_schema=schema,
                tool_description="desc",
            )

        assert client.update_registry_record_status.called
        kwargs = client.update_registry_record_status.call_args.kwargs
        assert kwargs["status"] == "APPROVED"
        assert kwargs["registryId"] == os.environ["REGISTRY_ID"]
        # recordId is extracted from the create response ARN
        assert kwargs["recordId"] == "rec-789"

    @given(tool_id=tool_ids, schema=tool_schemas)
    @settings(max_examples=20)
    def test_status_is_in_valid_registry_enum(self, tool_id, schema):
        """Pin the status to the UpdateRegistryRecordStatus enum so an
        invalid value (e.g. the old "PUBLISHED") can never ship again."""
        client = _make_registry_mock()
        with patch("index._get_registry_client", return_value=client):
            store_tool_config_registry(
                file_name=f"/tmp/{tool_id}.py",
                tool_id=tool_id,
                tool_schema=schema,
                tool_description="desc",
            )

        kwargs = client.update_registry_record_status.call_args.kwargs
        assert kwargs["status"] in VALID_REGISTRY_STATUSES

    @given(tool_id=tool_ids, schema=tool_schemas)
    @settings(max_examples=20)
    def test_custom_metadata_state_is_active(self, tool_id, schema):
        """state field in custom metadata is 'active' for fabricated tools."""
        client = _make_registry_mock()
        with patch("index._get_registry_client", return_value=client):
            store_tool_config_registry(
                file_name=f"/tmp/{tool_id}.py",
                tool_id=tool_id,
                tool_schema=schema,
                tool_description="desc",
            )

        kwargs = client.create_registry_record.call_args.kwargs
        meta = json.loads(kwargs["descriptors"]["custom"]["inlineContent"])
        assert meta["state"] == "active"


# ---------------------------------------------------------------------------
# Requirement 8.7: on failure, log and publish tool.fabrication.failed event
# ---------------------------------------------------------------------------

class TestFailureEmitsEvent:
    """Verify failures publish an EventBridge event and re-raise.

    **Validates: Requirements 8.7**
    """

    @given(tool_id=tool_ids, err_msg=st.text(min_size=1, max_size=80))
    @settings(max_examples=15)
    def test_create_failure_publishes_tool_fabrication_failed(self, tool_id, err_msg):
        client = MagicMock()
        client.create_registry_record.side_effect = RuntimeError(err_msg)

        with patch("index._get_registry_client", return_value=client), \
             patch("index.publish_fabrication_event") as mock_publish:
            with pytest.raises(RuntimeError):
                store_tool_config_registry(
                    file_name=f"/tmp/{tool_id}.py",
                    tool_id=tool_id,
                    tool_schema={"type": "object", "properties": {}, "required": []},
                    tool_description="desc",
                )

        assert mock_publish.called
        kwargs = mock_publish.call_args.kwargs
        assert kwargs["event_type"] == "tool.fabrication.failed"
        assert err_msg in kwargs["error"]

    @given(tool_id=tool_ids, app_id=app_ids)
    @settings(max_examples=15)
    def test_failure_event_includes_app_id(self, tool_id, app_id):
        client = MagicMock()
        client.create_registry_record.side_effect = RuntimeError("boom")

        with patch("index._get_registry_client", return_value=client), \
             patch("index.publish_fabrication_event") as mock_publish:
            with pytest.raises(RuntimeError):
                store_tool_config_registry(
                    file_name=f"/tmp/{tool_id}.py",
                    tool_id=tool_id,
                    tool_schema={"type": "object", "properties": {}, "required": []},
                    tool_description="desc",
                    app_id=app_id,
                )

        kwargs = mock_publish.call_args.kwargs
        assert kwargs["app_id"] == app_id

    def test_failure_swallows_publish_exception(self):
        """If publish_fabrication_event also fails, the original error still propagates."""
        client = MagicMock()
        client.create_registry_record.side_effect = RuntimeError("create-failed")

        with patch("index._get_registry_client", return_value=client), \
             patch("index.publish_fabrication_event",
                   side_effect=Exception("event bus down")):
            with pytest.raises(RuntimeError, match="create-failed"):
                store_tool_config_registry(
                    file_name="/tmp/t.py",
                    tool_id="t",
                    tool_schema={"type": "object", "properties": {}},
                    tool_description="desc",
                )

    def test_missing_registry_id_raises_value_error(self):
        """Absence of REGISTRY_ID raises ValueError (before any API call)."""
        with patch.dict(os.environ, {}, clear=False):
            orig = os.environ.pop("REGISTRY_ID", None)
            try:
                with patch("index._get_registry_client", return_value=MagicMock()), \
                     patch("index.publish_fabrication_event"):
                    with pytest.raises(ValueError, match="REGISTRY_ID"):
                        store_tool_config_registry(
                            file_name="/tmp/t.py",
                            tool_id="t",
                            tool_schema={"type": "object"},
                            tool_description="desc",
                        )
            finally:
                if orig is not None:
                    os.environ["REGISTRY_ID"] = orig


# ---------------------------------------------------------------------------
# Input normalization — schema-as-string handling
# ---------------------------------------------------------------------------

class TestSchemaAsString:
    """The LLM may pass tool_schema as a JSON string — it must be parsed."""

    @given(tool_id=tool_ids, schema=tool_schemas)
    @settings(max_examples=15)
    def test_string_schema_is_parsed_to_dict(self, tool_id, schema):
        client = _make_registry_mock()
        with patch("index._get_registry_client", return_value=client):
            store_tool_config_registry(
                file_name=f"/tmp/{tool_id}.py",
                tool_id=tool_id,
                tool_schema=json.dumps(schema),
                tool_description="desc",
            )

        kwargs = client.create_registry_record.call_args.kwargs
        meta = json.loads(kwargs["descriptors"]["custom"]["inlineContent"])
        assert meta["config"]["schema"] == schema
