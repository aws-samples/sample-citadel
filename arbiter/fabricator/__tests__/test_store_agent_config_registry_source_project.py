"""Source-project tagging tests for store_agent_config_registry.

Identifiability: a fabricated agent must carry the source project (intake
session / orchestration id) so the catalog can show and group by it.

Contract under test:
  - When ``source_project_id`` is provided (and not '0'/empty/None):
      * the human description gets a ' (Project: <id>)' suffix,
      * the CUSTOM descriptor inlineContent carries ``sourceProjectId``.
  - The suffix is NOT duplicated if the description already ends with it.
  - When ``source_project_id`` is absent/'0'/empty: no suffix is appended and
    ``sourceProjectId`` is omitted (backward compatible).
"""

import json
import sys
import os
from unittest.mock import patch, MagicMock

import pytest

sys.path.insert(0, os.path.join(os.path.dirname(__file__), ".."))

os.environ.setdefault("TOOL_CONFIG_TABLE", "fake-tool-table")
os.environ.setdefault("AGENT_CONFIG_TABLE", "fake-agent-table")
os.environ.setdefault("AGENT_BUCKET_NAME", "fake-bucket")
os.environ.setdefault("COMPLETION_BUS_NAME", "fake-bus")
os.environ.setdefault("WORKER_QUEUE_URL", "https://sqs.fake/queue")
os.environ.setdefault("REGISTRY_ID", "fake-registry-id")
os.environ.setdefault("AWS_DEFAULT_REGION", "us-west-2")

from index import store_agent_config_registry  # noqa: E402
import index  # noqa: E402


SCHEMA = {
    "type": "object",
    "properties": {"q": {"type": "string", "description": "query"}},
    "required": ["q"],
}


def _make_registry_mock(record_id="gen-record-id"):
    client = MagicMock()
    client.list_registry_records.return_value = {"records": []}
    client.create_registry_record.return_value = {
        "recordArn": (
            "arn:aws:bedrock-agentcore:us-west-2:123456789012:"
            f"registry/reg/record/{record_id}"
        ),
        "recordId": record_id,
        "status": "DRAFT",
    }
    return client


@pytest.fixture(autouse=True)
def _reset_cached_client():
    index._reset_registry_client_for_test()
    yield
    index._reset_registry_client_for_test()


def _create_kwargs(client):
    return client.create_registry_record.call_args.kwargs


def _custom_metadata(client):
    inline = _create_kwargs(client)["descriptors"]["custom"]["inlineContent"]
    return json.loads(inline)


class TestSourceProjectTagging:
    def test_appends_project_suffix_and_stores_source_project_id(self):
        client = _make_registry_mock()
        with patch("index._get_registry_client", return_value=client), \
                patch.object(index, "_write_app_meta_row", return_value=True):
            store_agent_config_registry(
                file_name="/tmp/a.py",
                agent_id="agent_a",
                llm_tool_schema=SCHEMA,
                agent_description="Does a thing",
                source_project_id="proj-123",
            )

        kwargs = _create_kwargs(client)
        assert kwargs["description"] == "Does a thing (Project: proj-123)"
        meta = _custom_metadata(client)
        assert meta["sourceProjectId"] == "proj-123"

    def test_does_not_duplicate_suffix(self):
        client = _make_registry_mock()
        with patch("index._get_registry_client", return_value=client), \
                patch.object(index, "_write_app_meta_row", return_value=True):
            store_agent_config_registry(
                file_name="/tmp/a.py",
                agent_id="agent_a",
                llm_tool_schema=SCHEMA,
                agent_description="Does a thing (Project: proj-123)",
                source_project_id="proj-123",
            )

        kwargs = _create_kwargs(client)
        assert kwargs["description"] == "Does a thing (Project: proj-123)"
        assert kwargs["description"].count("(Project: proj-123)") == 1

    def test_omits_suffix_and_metadata_when_no_project(self):
        client = _make_registry_mock()
        with patch("index._get_registry_client", return_value=client), \
                patch.object(index, "_write_app_meta_row", return_value=True):
            store_agent_config_registry(
                file_name="/tmp/a.py",
                agent_id="agent_a",
                llm_tool_schema=SCHEMA,
                agent_description="Does a thing",
            )

        kwargs = _create_kwargs(client)
        assert kwargs["description"] == "Does a thing"
        meta = _custom_metadata(client)
        assert "sourceProjectId" not in meta

    @pytest.mark.parametrize("blank", ["0", "", None])
    def test_treats_blank_project_ids_as_absent(self, blank):
        client = _make_registry_mock()
        with patch("index._get_registry_client", return_value=client), \
                patch.object(index, "_write_app_meta_row", return_value=True):
            store_agent_config_registry(
                file_name="/tmp/a.py",
                agent_id="agent_a",
                llm_tool_schema=SCHEMA,
                agent_description="Does a thing",
                source_project_id=blank,
            )

        kwargs = _create_kwargs(client)
        assert kwargs["description"] == "Does a thing"
        meta = _custom_metadata(client)
        assert "sourceProjectId" not in meta
