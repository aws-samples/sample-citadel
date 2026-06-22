"""Idempotency tests for store_agent_config_registry.

Harden the agent-fabrication pipeline: SQS redeliveries and re-triggers must
not create DUPLICATE Registry records for the same agent name.

Contract under test:
  - When a Registry record with the same name (agent_id) already EXISTS,
    store_agent_config_registry SKIPS CreateRegistryRecord (no duplicate),
    still refreshes the AppsTable #META mirror for the existing record, and
    returns True.
  - When NO record with that name exists, CreateRegistryRecord is called
    exactly once.

The lookup mirrors resolveRecordId/listResources in
backend/src/services/registry-service.ts: list CUSTOM records and match on
the record name.
"""

import sys
import os
from unittest.mock import patch, MagicMock

import pytest

sys.path.insert(0, os.path.join(os.path.dirname(__file__), ".."))

# Set required env vars before import.
os.environ.setdefault("TOOL_CONFIG_TABLE", "fake-tool-table")
os.environ.setdefault("AGENT_CONFIG_TABLE", "fake-agent-table")
os.environ.setdefault("AGENT_BUCKET_NAME", "fake-bucket")
os.environ.setdefault("COMPLETION_BUS_NAME", "fake-bus")
os.environ.setdefault("WORKER_QUEUE_URL", "https://sqs.fake/queue")
os.environ.setdefault("REGISTRY_ID", "fake-registry-id")
os.environ.setdefault("AWS_DEFAULT_REGION", "us-west-2")

from index import store_agent_config_registry  # noqa: E402
import index  # noqa: E402  — used for _reset_registry_client_for_test


SCHEMA = {
    "type": "object",
    "properties": {"q": {"type": "string", "description": "query"}},
    "required": ["q"],
}


def _make_registry_mock(existing_records=None, record_id="gen-record-id"):
    """Build a mock bedrock-agentcore-control client.

    Args:
        existing_records: list of record-summary dicts returned by
            list_registry_records (the idempotency lookup). Defaults to [].
        record_id: recordId surfaced in the create_registry_record response.
    """
    client = MagicMock()
    client.list_registry_records.return_value = {
        "records": existing_records or [],
    }
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


class TestIdempotentAgentCreation:
    def test_skips_create_when_same_named_record_exists(self):
        agent_id = "duplicate_agent"
        client = _make_registry_mock(
            existing_records=[{"name": agent_id, "recordId": "existing-rec-id"}],
        )
        with patch("index._get_registry_client", return_value=client):
            result = store_agent_config_registry(
                file_name=f"/tmp/{agent_id}.py",
                agent_id=agent_id,
                llm_tool_schema=SCHEMA,
                agent_description="dup",
            )

        assert result is True
        client.create_registry_record.assert_not_called()

    def test_creates_once_when_no_matching_record_exists(self):
        agent_id = "fresh_agent"
        client = _make_registry_mock(existing_records=[])
        with patch("index._get_registry_client", return_value=client):
            result = store_agent_config_registry(
                file_name=f"/tmp/{agent_id}.py",
                agent_id=agent_id,
                llm_tool_schema=SCHEMA,
                agent_description="fresh",
            )

        assert result is True
        client.create_registry_record.assert_called_once()

    def test_does_not_match_on_different_name(self):
        """A record whose name differs must NOT block creation."""
        agent_id = "wanted_agent"
        client = _make_registry_mock(
            existing_records=[{"name": "some_other_agent", "recordId": "other-id"}],
        )
        with patch("index._get_registry_client", return_value=client):
            result = store_agent_config_registry(
                file_name=f"/tmp/{agent_id}.py",
                agent_id=agent_id,
                llm_tool_schema=SCHEMA,
                agent_description="wanted",
            )

        assert result is True
        client.create_registry_record.assert_called_once()
