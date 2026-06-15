"""
Property-based tests for Fabricator auto-generated agent/tool manifests.

Previously these tested the DynamoDB item written by ``store_agent_config_dynamo``.
Post-QB-013-2 (boto3 1.42 Registry-native refactor) the manifest lives inside
the Registry record's ``descriptors.custom.inlineContent`` JSON. The tests
have been migrated to assert on the Registry path (``store_agent_config_registry``
/ ``store_tool_config_registry``) so that the manifest contract is now verified
against the production code path the UI actually reads from.

Key invariants:

* Agents carry a ``manifest`` key inside ``inlineContent`` with
  ``name`` == agent_id, ``description`` == agent_description, ``version`` "1.0",
  and ``tools`` as a list.
* Tools deliberately do NOT carry a ``manifest`` key — that is the agent/tool
  type discriminator (commit 0a42938) and must be preserved.
* The ``createdBy`` field mirrors the ``requested_by`` kwarg (defaulting to
  ``"fabricator"``) so that ``process_event`` threading surfaces in the record.

**Validates: Requirements 15.5, 8.1/8.2 createdBy, 8.2 no-manifest for tools**
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

from index import store_agent_config_registry, store_tool_config_registry  # noqa: E402
import index  # noqa: E402


# ---------------------------------------------------------------------------
# Strategies
# ---------------------------------------------------------------------------

safe_text = st.text(
    min_size=1, max_size=30,
    alphabet=st.characters(whitelist_categories=("L", "N")),
)

agent_ids = safe_text
tool_ids = safe_text
requester_ids = safe_text

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


def _make_registry_mock(record_id: str = "gen-record-id", status: str = "DRAFT"):
    client = MagicMock()
    client.create_registry_record.return_value = {
        "recordArn": f"arn:aws:bedrock-agentcore:us-west-2:123456789012:registry/reg/record/{record_id}",
        "recordId": record_id,
        "status": status,
    }
    client.update_registry_record_status.return_value = {
        "recordId": record_id,
        "status": status,
    }
    return client


@pytest.fixture(autouse=True)
def _reset_cached_client():
    """Clear the module-level lazy client between tests so the mocked
    ``_get_registry_client`` patch installs fresh each time."""
    index._reset_registry_client_for_test()
    yield
    index._reset_registry_client_for_test()


def _inline_meta_from_create_call(client):
    kwargs = client.create_registry_record.call_args.kwargs
    return json.loads(kwargs["descriptors"]["custom"]["inlineContent"])


# ---------------------------------------------------------------------------
# Agent manifest auto-generation properties (Registry inlineContent)
# ---------------------------------------------------------------------------

class TestAgentManifestAutoGeneration:
    """Registry-backed manifest contract for agents.

    **Validates: Requirements 15.5**
    """

    @given(
        agent_id=agent_ids,
        file_name=file_names,
        schema=tool_schemas,
        description=descriptions,
    )
    @settings(max_examples=50)
    def test_manifest_always_present_in_inline_content(self, agent_id, file_name, schema, description):
        """Agent Registry records always include a 'manifest' key in custom metadata."""
        client = _make_registry_mock()
        with patch("index._get_registry_client", return_value=client):
            store_agent_config_registry(
                file_name=file_name,
                agent_id=agent_id,
                llm_tool_schema=schema,
                agent_description=description,
            )

        meta = _inline_meta_from_create_call(client)
        assert "manifest" in meta

    @given(
        agent_id=agent_ids,
        file_name=file_names,
        schema=tool_schemas,
        description=descriptions,
    )
    @settings(max_examples=50)
    def test_manifest_name_equals_agent_id(self, agent_id, file_name, schema, description):
        """The manifest 'name' field always equals the agent_id."""
        client = _make_registry_mock()
        with patch("index._get_registry_client", return_value=client):
            store_agent_config_registry(
                file_name=file_name,
                agent_id=agent_id,
                llm_tool_schema=schema,
                agent_description=description,
            )

        meta = _inline_meta_from_create_call(client)
        assert meta["manifest"]["name"] == agent_id

    @given(
        agent_id=agent_ids,
        file_name=file_names,
        schema=tool_schemas,
        description=descriptions,
    )
    @settings(max_examples=50)
    def test_manifest_description_equals_agent_description(self, agent_id, file_name, schema, description):
        """The manifest 'description' field always equals the agent_description."""
        client = _make_registry_mock()
        with patch("index._get_registry_client", return_value=client):
            store_agent_config_registry(
                file_name=file_name,
                agent_id=agent_id,
                llm_tool_schema=schema,
                agent_description=description,
            )

        meta = _inline_meta_from_create_call(client)
        assert meta["manifest"]["description"] == description

    @given(
        agent_id=agent_ids,
        file_name=file_names,
        schema=tool_schemas,
        description=descriptions,
    )
    @settings(max_examples=50)
    def test_manifest_version_is_1_0(self, agent_id, file_name, schema, description):
        """The manifest 'version' field is always '1.0' for initial creation."""
        client = _make_registry_mock()
        with patch("index._get_registry_client", return_value=client):
            store_agent_config_registry(
                file_name=file_name,
                agent_id=agent_id,
                llm_tool_schema=schema,
                agent_description=description,
            )

        meta = _inline_meta_from_create_call(client)
        assert meta["manifest"]["version"] == 1

    @given(
        agent_id=agent_ids,
        file_name=file_names,
        schema=tool_schemas,
        description=descriptions,
    )
    @settings(max_examples=50)
    def test_manifest_tools_is_list(self, agent_id, file_name, schema, description):
        """The manifest 'tools' field is always a list."""
        client = _make_registry_mock()
        with patch("index._get_registry_client", return_value=client):
            store_agent_config_registry(
                file_name=file_name,
                agent_id=agent_id,
                llm_tool_schema=schema,
                agent_description=description,
            )

        meta = _inline_meta_from_create_call(client)
        assert isinstance(meta["manifest"]["tools"], list)

    @given(
        agent_id=agent_ids,
        file_name=file_names,
        schema=tool_schemas,
        description=descriptions,
    )
    @settings(max_examples=50)
    def test_manifest_has_all_required_fields(self, agent_id, file_name, schema, description):
        """The manifest always contains all required fields: name, description, version, tools."""
        client = _make_registry_mock()
        with patch("index._get_registry_client", return_value=client):
            store_agent_config_registry(
                file_name=file_name,
                agent_id=agent_id,
                llm_tool_schema=schema,
                agent_description=description,
            )

        manifest = _inline_meta_from_create_call(client)["manifest"]
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
        client = _make_registry_mock()
        with patch("index._get_registry_client", return_value=client):
            store_agent_config_registry(
                file_name=file_name,
                agent_id=agent_id,
                llm_tool_schema=schema,
                agent_description=description,
            )

        manifest = _inline_meta_from_create_call(client)["manifest"]
        assert json.loads(json.dumps(manifest)) == manifest


# ---------------------------------------------------------------------------
# Agent description + createdBy contract (QB-013-2)
# ---------------------------------------------------------------------------

class TestAgentDescriptionAndCreatedBy:
    """Description is plain text; createdBy is threaded from requested_by."""

    @given(
        agent_id=agent_ids,
        file_name=file_names,
        schema=tool_schemas,
        description=descriptions,
    )
    @settings(max_examples=30)
    def test_record_description_is_plain_agent_description(
        self, agent_id, file_name, schema, description,
    ):
        """The top-level description arg to create_registry_record is the raw string."""
        client = _make_registry_mock()
        with patch("index._get_registry_client", return_value=client):
            store_agent_config_registry(
                file_name=file_name,
                agent_id=agent_id,
                llm_tool_schema=schema,
                agent_description=description,
            )

        kwargs = client.create_registry_record.call_args.kwargs
        assert kwargs["description"] == description

    @given(
        agent_id=agent_ids,
        schema=tool_schemas,
        description=descriptions,
        requester=requester_ids,
    )
    @settings(max_examples=30)
    def test_created_by_matches_requested_by_argument(
        self, agent_id, schema, description, requester,
    ):
        """Passing requested_by stamps createdBy in custom metadata."""
        client = _make_registry_mock()
        with patch("index._get_registry_client", return_value=client):
            store_agent_config_registry(
                file_name=f"/tmp/{agent_id}.py",
                agent_id=agent_id,
                llm_tool_schema=schema,
                agent_description=description,
                requested_by=requester,
            )

        meta = _inline_meta_from_create_call(client)
        assert meta["createdBy"] == requester

    @given(
        agent_id=agent_ids,
        schema=tool_schemas,
        description=descriptions,
    )
    @settings(max_examples=15)
    def test_created_by_defaults_to_fabricator(self, agent_id, schema, description):
        """Legacy callers get the literal 'fabricator' default."""
        client = _make_registry_mock()
        with patch("index._get_registry_client", return_value=client):
            store_agent_config_registry(
                file_name=f"/tmp/{agent_id}.py",
                agent_id=agent_id,
                llm_tool_schema=schema,
                agent_description=description,
            )

        meta = _inline_meta_from_create_call(client)
        assert meta["createdBy"] == "fabricator"

    @given(
        agent_id=agent_ids,
        schema=tool_schemas,
        description=descriptions,
    )
    @settings(max_examples=15)
    def test_full_config_stashed_under_inline_content_config(
        self, agent_id, schema, description,
    ):
        """The executable config dict is preserved under inlineContent.config."""
        client = _make_registry_mock()
        with patch("index._get_registry_client", return_value=client):
            store_agent_config_registry(
                file_name=f"/tmp/{agent_id}.py",
                agent_id=agent_id,
                llm_tool_schema=schema,
                agent_description=description,
            )

        meta = _inline_meta_from_create_call(client)
        assert meta["config"]["name"] == agent_id
        assert meta["config"]["description"] == description
        assert meta["config"]["schema"] == schema


# ---------------------------------------------------------------------------
# Tool manifest-absence contract
# ---------------------------------------------------------------------------

class TestToolHasNoManifest:
    """Tool Registry records must NOT carry a manifest key — this is the
    agent/tool type discriminator (commit 0a42938) and must be preserved."""

    @given(
        tool_id=tool_ids,
        file_name=file_names,
        schema=tool_schemas,
        description=descriptions,
    )
    @settings(max_examples=50)
    def test_tool_inline_content_has_no_manifest(self, tool_id, file_name, schema, description):
        client = _make_registry_mock(status="PUBLISHED")
        with patch("index._get_registry_client", return_value=client):
            store_tool_config_registry(
                file_name=file_name,
                tool_id=tool_id,
                tool_schema=schema,
                tool_description=description,
            )

        meta = _inline_meta_from_create_call(client)
        assert "manifest" not in meta

    @given(
        tool_id=tool_ids,
        schema=tool_schemas,
        description=descriptions,
        requester=requester_ids,
    )
    @settings(max_examples=20)
    def test_tool_created_by_matches_requested_by_argument(
        self, tool_id, schema, description, requester,
    ):
        """Tools also record createdBy from requested_by."""
        client = _make_registry_mock(status="PUBLISHED")
        with patch("index._get_registry_client", return_value=client):
            store_tool_config_registry(
                file_name=f"/tmp/{tool_id}.py",
                tool_id=tool_id,
                tool_schema=schema,
                tool_description=description,
                requested_by=requester,
            )

        meta = _inline_meta_from_create_call(client)
        assert meta["createdBy"] == requester
