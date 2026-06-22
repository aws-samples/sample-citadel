"""
Property-based tests for store_agent_config_registry.

Covers task 9.1 of the agentcore-registry-migration spec:
  - Calls CreateRegistryRecord with agent metadata and custom metadata
  - Leaves the freshly created record in its post-create DRAFT
    (pending-activation) state — the Fabricator does NOT call
    UpdateRegistryRecordStatus(status="DRAFT"). The AgentCore registry
    rejects a DRAFT->DRAFT transition with ValidationException
    ('Invalid target status: DRAFT'), which previously caused fabrication
    to fail even though the record had been created.
  - On failure: logs error and publishes agent.fabrication.failed event
    to EventBridge

Post-boto3-1.42 contract (QB-013-2):
  - ``description`` on the record is the plain human-readable string,
    NOT a JSON blob of the executable config.
  - The full executable config is stashed under
    ``inlineContent.config``; the requester user id is stamped into
    ``inlineContent.createdBy`` (sourced from the event's
    ``requested_by`` field in ``process_event``).

**Validates: Requirements 8.1, 8.3, 8.7**
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

from index import store_agent_config_registry  # noqa: E402
import index  # noqa: E402  — used for _reset_registry_client_for_test


# ---------------------------------------------------------------------------
# Strategies
# ---------------------------------------------------------------------------

safe_text = st.text(
    min_size=1, max_size=30,
    alphabet=st.characters(whitelist_categories=("L", "N")),
)

agent_ids = safe_text
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


@pytest.fixture(autouse=True)
def _reset_cached_client():
    """Clear the module-level lazy client between tests so the mocked
    ``_get_registry_client`` patch installs fresh each time."""
    index._reset_registry_client_for_test()
    yield
    index._reset_registry_client_for_test()


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
        with patch("index._get_registry_client", return_value=client):
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
    def test_description_is_plain_agent_description(self, agent_id, description, schema):
        """The description field is the plain human-readable string, NOT a JSON blob.

        Post-QB-013-2: executable config is stashed under inlineContent.config; the
        top-level description is rendered as text by the UI.
        """
        client = _make_registry_mock()
        with patch("index._get_registry_client", return_value=client):
            store_agent_config_registry(
                file_name=f"/tmp/{agent_id}.py",
                agent_id=agent_id,
                llm_tool_schema=schema,
                agent_description=description,
            )

        kwargs = client.create_registry_record.call_args.kwargs
        assert kwargs["description"] == description

    @given(agent_id=agent_ids, description=descriptions, schema=tool_schemas)
    @settings(max_examples=25)
    def test_inline_content_contains_config_and_manifest(self, agent_id, description, schema):
        """Custom metadata round-trips config, manifest, state via inlineContent."""
        client = _make_registry_mock()
        with patch("index._get_registry_client", return_value=client):
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

        # categories / icon / state — unchanged contract
        assert meta["categories"] == ["worker"]
        assert meta["state"] == "inactive"

        # config — full executable config dict stashed here
        assert meta["config"]["name"] == agent_id
        assert meta["config"]["description"] == description
        assert meta["config"]["schema"] == schema
        assert meta["config"]["filename"] == f"{agent_id}.py"
        assert meta["config"]["action"]["type"] == "sqs"

        # manifest — agents carry a manifest; tools do NOT.
        assert meta["manifest"]["name"] == agent_id
        assert meta["manifest"]["description"] == description

    @given(agent_id=agent_ids, requester=requester_ids, schema=tool_schemas)
    @settings(max_examples=20)
    def test_created_by_reflects_requested_by_argument(self, agent_id, requester, schema):
        """createdBy is sourced from the requested_by kwarg (threaded from event)."""
        client = _make_registry_mock()
        with patch("index._get_registry_client", return_value=client):
            store_agent_config_registry(
                file_name=f"/tmp/{agent_id}.py",
                agent_id=agent_id,
                llm_tool_schema=schema,
                agent_description="desc",
                requested_by=requester,
            )

        kwargs = client.create_registry_record.call_args.kwargs
        meta = json.loads(kwargs["descriptors"]["custom"]["inlineContent"])
        assert meta["createdBy"] == requester

    @given(agent_id=agent_ids, schema=tool_schemas)
    @settings(max_examples=10)
    def test_created_by_defaults_to_fabricator(self, agent_id, schema):
        """Callers that don't pass requested_by get the legacy 'fabricator' stamp."""
        client = _make_registry_mock()
        with patch("index._get_registry_client", return_value=client):
            store_agent_config_registry(
                file_name=f"/tmp/{agent_id}.py",
                agent_id=agent_id,
                llm_tool_schema=schema,
                agent_description="desc",
            )

        kwargs = client.create_registry_record.call_args.kwargs
        meta = json.loads(kwargs["descriptors"]["custom"]["inlineContent"])
        assert meta["createdBy"] == "fabricator"

    @given(agent_id=agent_ids, org=safe_text, schema=tool_schemas)
    @settings(max_examples=20)
    def test_org_id_reflects_org_id_argument(self, agent_id, org, schema):
        """orgId is sourced from the org_id kwarg (threaded from event.org_id)."""
        client = _make_registry_mock()
        with patch("index._get_registry_client", return_value=client):
            store_agent_config_registry(
                file_name=f"/tmp/{agent_id}.py",
                agent_id=agent_id,
                llm_tool_schema=schema,
                agent_description="desc",
                org_id=org,
            )

        kwargs = client.create_registry_record.call_args.kwargs
        meta = json.loads(kwargs["descriptors"]["custom"]["inlineContent"])
        assert meta["orgId"] == org

    @given(agent_id=agent_ids, schema=tool_schemas)
    @settings(max_examples=10)
    def test_org_id_defaults_to_empty_string(self, agent_id, schema):
        """Callers that don't pass org_id get '' — matches resolver's null fallback."""
        client = _make_registry_mock()
        with patch("index._get_registry_client", return_value=client):
            store_agent_config_registry(
                file_name=f"/tmp/{agent_id}.py",
                agent_id=agent_id,
                llm_tool_schema=schema,
                agent_description="desc",
            )

        kwargs = client.create_registry_record.call_args.kwargs
        meta = json.loads(kwargs["descriptors"]["custom"]["inlineContent"])
        assert meta["orgId"] == ""

    @given(agent_id=agent_ids, app_id=app_ids, schema=tool_schemas)
    @settings(max_examples=20)
    def test_app_id_included_in_custom_metadata_when_provided(self, agent_id, app_id, schema):
        client = _make_registry_mock()
        with patch("index._get_registry_client", return_value=client):
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
        with patch("index._get_registry_client", return_value=client):
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
# Requirement 8.3: record is LEFT in its post-create DRAFT (pending-activation)
# state — the Fabricator must NOT call UpdateRegistryRecordStatus("DRAFT").
# ---------------------------------------------------------------------------

class TestInitialStatusDraft:
    """Verify the freshly created record is left in DRAFT WITHOUT a redundant
    UpdateRegistryRecordStatus(status="DRAFT") call.

    CreateRegistryRecord already leaves the record in DRAFT (the
    pre-activation state). The AgentCore registry rejects a DRAFT->DRAFT
    transition with ValidationException ('Invalid target status: DRAFT'),
    so re-asserting DRAFT after create is both redundant AND invalid — it
    previously made store_agent_config_registry raise and publish
    agent.fabrication.failed even though the record was created.

    **Validates: Requirements 8.3**
    """

    @given(agent_id=agent_ids, schema=tool_schemas)
    @settings(max_examples=20)
    def test_status_update_not_called_after_create(self, agent_id, schema):
        """No UpdateRegistryRecordStatus call at all on the happy path — the
        record is left in its post-create DRAFT state."""
        client = _make_registry_mock(record_id="rec-123")
        with patch("index._get_registry_client", return_value=client):
            store_agent_config_registry(
                file_name=f"/tmp/{agent_id}.py",
                agent_id=agent_id,
                llm_tool_schema=schema,
                agent_description="desc",
            )

        assert not client.update_registry_record_status.called

    @given(agent_id=agent_ids, schema=tool_schemas)
    @settings(max_examples=20)
    def test_status_update_never_called_with_draft(self, agent_id, schema):
        """Regression for the ValidationException bug: even hypothetically, the
        record status is NEVER re-asserted to DRAFT after create. Capturing the
        invalid DRAFT->DRAFT transition would make the registry raise and
        fabrication would fail."""
        client = _make_registry_mock(record_id="rec-123")
        with patch("index._get_registry_client", return_value=client):
            store_agent_config_registry(
                file_name=f"/tmp/{agent_id}.py",
                agent_id=agent_id,
                llm_tool_schema=schema,
                agent_description="desc",
            )

        for call in client.update_registry_record_status.call_args_list:
            assert call.kwargs.get("status") != "DRAFT"

    @given(agent_id=agent_ids, schema=tool_schemas)
    @settings(max_examples=20)
    def test_create_registry_record_called_exactly_once(self, agent_id, schema):
        client = _make_registry_mock(record_id="rec-123")
        with patch("index._get_registry_client", return_value=client):
            store_agent_config_registry(
                file_name=f"/tmp/{agent_id}.py",
                agent_id=agent_id,
                llm_tool_schema=schema,
                agent_description="desc",
            )

        assert client.create_registry_record.call_count == 1

    @given(agent_id=agent_ids, schema=tool_schemas)
    @settings(max_examples=20)
    def test_returns_true_on_happy_path(self, agent_id, schema):
        client = _make_registry_mock(record_id="rec-123")
        with patch("index._get_registry_client", return_value=client):
            result = store_agent_config_registry(
                file_name=f"/tmp/{agent_id}.py",
                agent_id=agent_id,
                llm_tool_schema=schema,
                agent_description="desc",
            )

        assert result is True

    @given(agent_id=agent_ids, schema=tool_schemas)
    @settings(max_examples=20)
    def test_no_fabrication_failed_event_on_happy_path(self, agent_id, schema):
        """The successful create path must not publish agent.fabrication.failed.
        Before the fix, the invalid DRAFT->DRAFT update raised and this event
        was published despite the record having been created."""
        client = _make_registry_mock(record_id="rec-123")
        with patch("index._get_registry_client", return_value=client), \
             patch("index.publish_fabrication_event") as mock_publish:
            store_agent_config_registry(
                file_name=f"/tmp/{agent_id}.py",
                agent_id=agent_id,
                llm_tool_schema=schema,
                agent_description="desc",
            )

        assert not mock_publish.called

    @given(agent_id=agent_ids, schema=tool_schemas)
    @settings(max_examples=20)
    def test_custom_metadata_state_is_inactive(self, agent_id, schema):
        """state field in custom metadata is 'inactive' for fabricated agents."""
        client = _make_registry_mock()
        with patch("index._get_registry_client", return_value=client):
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

        with patch("index._get_registry_client", return_value=client), \
             patch("index.publish_fabrication_event") as mock_publish:
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

        with patch("index._get_registry_client", return_value=client), \
             patch("index.publish_fabrication_event") as mock_publish:
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

        with patch("index._get_registry_client", return_value=client), \
             patch("index.publish_fabrication_event",
                   side_effect=Exception("event bus down")):
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
                with patch("index._get_registry_client", return_value=MagicMock()), \
                     patch("index.publish_fabrication_event"):
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
        with patch("index._get_registry_client", return_value=client):
            store_agent_config_registry(
                file_name=f"/tmp/{agent_id}.py",
                agent_id=agent_id,
                llm_tool_schema=json.dumps(schema),
                agent_description="desc",
            )

        kwargs = client.create_registry_record.call_args.kwargs
        meta = json.loads(kwargs["descriptors"]["custom"]["inlineContent"])
        assert meta["config"]["schema"] == schema


# ---------------------------------------------------------------------------
# Phase 3 Step 2: synchronous AppsTable #META mirror
# ---------------------------------------------------------------------------

class TestAppsTableMetaWrite:
    """Phase 3 Step 2: AppsTable #META row written synchronously after
    a Registry record is created.

    Purpose: listApps reads from AppsTable.OrgIndex (PK=orgId, SK=createdAt).
    The resolver path already writes the #META row at createApp; the
    fabricator path historically did not, so fabricated agents stayed
    invisible to listApps until the reconciler ran. After this change the
    fabricator mirrors every successful Registry create into AppsTable.

    Eventually-consistent: any DDB write failure is logged and swallowed
    inside _write_app_meta_row — Registry remains the source of truth.
    The reconciler script still acts as the safety net.
    """

    def test_apps_meta_write_called_after_create_succeeds(self):
        """Successful Registry create triggers boto3 update_item with the
        full #META row shape: TableName, Key={appId: record_id}, all 11
        fields in UpdateExpression, sortId='METADATA'.
        """
        registry = _make_registry_mock(record_id="rec-abc12345")
        fake_ddb = MagicMock()

        def _client_factory(name, *args, **kwargs):
            assert name == "dynamodb", f"unexpected boto3.client({name!r})"
            return fake_ddb

        with patch.dict(os.environ, {"APPS_TABLE": "fake-apps-table"}), \
             patch("index._get_registry_client", return_value=registry), \
             patch("index.boto3.client", side_effect=_client_factory):
            result = store_agent_config_registry(
                file_name="/tmp/myagent.py",
                agent_id="myagent",
                llm_tool_schema={"type": "object", "properties": {}, "required": []},
                agent_description="my desc",
                requested_by="alice@example.com",
                org_id="org-1",
            )

        assert result is True
        assert fake_ddb.update_item.called, (
            "expected _write_app_meta_row to call boto3.client('dynamodb').update_item"
        )
        kwargs = fake_ddb.update_item.call_args.kwargs

        # 1) Target the right table and the right partition key.
        assert kwargs["TableName"] == "fake-apps-table"
        assert kwargs["Key"] == {"appId": {"S": "rec-abc12345"}}

        # 2) UpdateExpression mentions all 11 attribute-name placeholders.
        update_expr = kwargs["UpdateExpression"]
        for placeholder in (
            "#orgId", "#name", "#description", "#status",
            "#workflowIds", "#routingConfig", "#createdBy",
            "#createdAt", "#updatedAt", "#version", "#sortId",
        ):
            assert placeholder in update_expr, (
                f"UpdateExpression missing {placeholder}: {update_expr!r}"
            )

        # 3) ExpressionAttributeValues carry the right shape and content.
        values = kwargs["ExpressionAttributeValues"]
        assert values[":orgId"] == {"S": "org-1"}
        assert values[":name"] == {"S": "myagent"}
        assert values[":description"] == {"S": "my desc"}
        assert values[":status"] == {"S": "DRAFT"}
        assert values[":workflowIds"] == {"L": []}
        assert values[":routingConfig"] == {"S": ""}
        assert values[":createdBy"] == {"S": "alice@example.com"}
        assert values[":version"] == {"N": "1"}
        # The sortId data-attribute marks this row as the METADATA row,
        # matching backend/src/utils/apps-table-meta.ts APP_META_SORT_VALUE.
        assert values[":sortId"] == {"S": "METADATA"}
        # createdAt / updatedAt are ISO-8601 UTC strings ending in 'Z'.
        assert values[":createdAt"]["S"].endswith("Z")
        assert values[":updatedAt"]["S"].endswith("Z")

    def test_apps_meta_write_failure_is_swallowed(self, caplog):
        """When DynamoDB raises, store_agent_config_registry still returns
        True (the Registry write is the source of truth) and the helper
        logs a warning. The reconciler will recover the drift later.
        """
        import logging as _logging

        registry = _make_registry_mock(record_id="rec-xyz")
        fake_ddb = MagicMock()
        fake_ddb.update_item.side_effect = RuntimeError("ddb explosion")

        def _client_factory(name, *args, **kwargs):
            assert name == "dynamodb"
            return fake_ddb

        with patch.dict(os.environ, {"APPS_TABLE": "fake-apps-table"}), \
             patch("index._get_registry_client", return_value=registry), \
             patch("index.boto3.client", side_effect=_client_factory), \
             caplog.at_level(_logging.WARNING, logger="index"):
            result = store_agent_config_registry(
                file_name="/tmp/a.py",
                agent_id="a",
                llm_tool_schema={"type": "object", "properties": {}, "required": []},
                agent_description="desc",
            )

        # Registry create + UpdateRegistryRecordStatus succeeded — return True.
        assert result is True
        assert fake_ddb.update_item.called
        # And the failure was logged via the warning path.
        warned = " ".join(
            rec.message for rec in caplog.records
            if rec.levelno >= _logging.WARNING
        )
        assert "_write_app_meta_row" in warned
        assert "ddb explosion" in warned

    def test_apps_meta_write_skipped_when_apps_table_env_unset(self):
        """No APPS_TABLE env var → helper short-circuits without calling
        boto3.client('dynamodb'). Confirms existing (pre-Phase-3) tests
        in this module are unaffected by the new code path.
        """
        registry = _make_registry_mock(record_id="rec-noenv")
        seen_clients: list[str] = []

        def _client_factory(name, *args, **kwargs):
            seen_clients.append(name)
            return MagicMock()

        with patch.dict(os.environ, {}, clear=False):
            os.environ.pop("APPS_TABLE", None)
            with patch("index._get_registry_client", return_value=registry), \
                 patch("index.boto3.client", side_effect=_client_factory):
                result = store_agent_config_registry(
                    file_name="/tmp/a.py",
                    agent_id="a",
                    llm_tool_schema={"type": "object", "properties": {}, "required": []},
                    agent_description="desc",
                )

        assert result is True
        assert "dynamodb" not in seen_clients
