"""Tests for the reused-record status-aware approval fix.

When _find_existing_record_id returns a record that is already APPROVED or
PENDING_APPROVAL, the fabricator must NOT call SubmitRegistryRecordForApproval
(the registry rejects it with ValidationException 'Cannot submit the record
for approval in current status: APPROVED'). DRAFT records must still be
submitted. REJECTED/DEPRECATED records must fail clearly.

Tests use botocore.stub.Stubber with the REAL agent-registry-control service
model — no hand-copied expected params; the Stubber validates all kwargs
against the botocore ParamValidator automatically.
"""

import sys
import os
import json
from unittest.mock import patch, MagicMock

import pytest
import botocore.session
from botocore.stub import Stubber

sys.path.insert(0, os.path.join(os.path.dirname(__file__), ".."))

os.environ.setdefault("TOOL_CONFIG_TABLE", "fake-tool-table")
os.environ.setdefault("AGENT_CONFIG_TABLE", "fake-agent-table")
os.environ.setdefault("AGENT_BUCKET_NAME", "fake-bucket")
os.environ.setdefault("COMPLETION_BUS_NAME", "fake-bus")
os.environ.setdefault("WORKER_QUEUE_URL", "https://sqs.fake/queue")
os.environ.setdefault("REGISTRY_ID", "fake-registry-id")
os.environ.setdefault("AWS_DEFAULT_REGION", "us-west-2")

import index  # noqa: E402

TOOL_SCHEMA = {
    "type": "object",
    "properties": {"q": {"type": "string", "description": "query"}},
    "required": ["q"],
}

REGISTRY_ID = "fake-registry-id"
RECORD_ID = "existing-rec-1"
RECORD_ARN = (
    f"arn:aws:bedrock-agentcore:us-west-2:123456789012:"
    f"registry/{REGISTRY_ID}/record/{RECORD_ID}"
)
REGISTRY_ARN = (
    f"arn:aws:bedrock-agentcore:us-west-2:123456789012:"
    f"registry/{REGISTRY_ID}"
)
NOW = "2026-01-01T00:00:00Z"


@pytest.fixture(autouse=True)
def _reset_cached_client():
    index._reset_registry_client_for_test()
    yield
    index._reset_registry_client_for_test()


def _stubbed_client():
    """Create a real botocore client with Stubber for shape validation."""
    session = botocore.session.get_session()
    client = session.create_client(
        "agent-registry-control", region_name="us-west-2"
    )
    stubber = Stubber(client)
    return client, stubber


def _get_record_response(status="APPROVED"):
    """Minimal valid GetRegistryRecord response."""
    return {
        "registryArn": REGISTRY_ARN,
        "recordArn": RECORD_ARN,
        "recordId": RECORD_ID,
        "name": "my-tool",
        "displayName": "my-tool",
        "description": "A tool",
        "recordType": "CUSTOM",
        "recordVersion": "1",
        "status": status,
        "createdAt": NOW,
        "updatedAt": NOW,
    }


def _submit_response(status="APPROVED"):
    """Minimal valid SubmitRegistryRecordForApproval response."""
    return {
        "registryArn": REGISTRY_ARN,
        "recordArn": RECORD_ARN,
        "recordId": RECORD_ID,
        "status": status,
        "updatedAt": NOW,
    }


def _list_response(records):
    """Minimal valid ListRegistryRecords response."""
    return {"registryRecords": records}


def _existing_record_summary(name, record_id, org_id=""):
    """A summary entry as returned by ListRegistryRecords."""
    summary = {
        "registryArn": REGISTRY_ARN,
        "recordArn": (
            f"arn:aws:bedrock-agentcore:us-west-2:123456789012:"
            f"registry/{REGISTRY_ID}/record/{record_id}"
        ),
        "recordId": record_id,
        "name": name,
        "displayName": name,
        "recordType": "CUSTOM",
        "recordVersion": "1",
        "status": "APPROVED",
        "createdAt": NOW,
        "updatedAt": NOW,
    }
    if org_id:
        summary["descriptors"] = {
            "custom": {"data": json.dumps({"orgId": org_id})}
        }
    return summary


# ============================================================================
# store_tool_config_registry: reused record status handling
# ============================================================================


class TestToolReusedApproved:
    """Reused APPROVED record → no SubmitRegistryRecordForApproval call."""

    def test_reused_approved_skips_submit(self):
        client, stubber = _stubbed_client()

        # 1. ListRegistryRecords → existing record found
        stubber.add_response(
            "list_registry_records",
            _list_response([_existing_record_summary("my-tool", RECORD_ID)]),
            expected_params={
                "registryId": REGISTRY_ID,
                "filters": [
                    {"name": "recordType", "values": ["CUSTOM"]},
                    {"name": "name", "values": ["my-tool"]},
                ],
                "maxResults": 100,
            },
        )

        # 2. GetRegistryRecord → APPROVED
        stubber.add_response(
            "get_registry_record",
            _get_record_response("APPROVED"),
            expected_params={
                "registryId": REGISTRY_ID,
                "recordId": RECORD_ID,
            },
        )

        # NO submit_registry_record_for_approval stub → if called, Stubber
        # raises UnStubbedResponseError, failing the test.

        with stubber:
            with patch("index._get_registry_client", return_value=client):
                result = index.store_tool_config_registry(
                    file_name="/tmp/tool.py",
                    tool_id="my-tool",
                    tool_schema=TOOL_SCHEMA,
                    tool_description="A tool",
                )
        assert result is True


class TestToolReusedPending:
    """Reused PENDING_APPROVAL record → no submit call."""

    def test_reused_pending_skips_submit(self):
        client, stubber = _stubbed_client()

        stubber.add_response(
            "list_registry_records",
            _list_response([_existing_record_summary("my-tool", RECORD_ID)]),
            expected_params={
                "registryId": REGISTRY_ID,
                "filters": [
                    {"name": "recordType", "values": ["CUSTOM"]},
                    {"name": "name", "values": ["my-tool"]},
                ],
                "maxResults": 100,
            },
        )
        stubber.add_response(
            "get_registry_record",
            _get_record_response("PENDING_APPROVAL"),
            expected_params={
                "registryId": REGISTRY_ID,
                "recordId": RECORD_ID,
            },
        )

        with stubber:
            with patch("index._get_registry_client", return_value=client):
                result = index.store_tool_config_registry(
                    file_name="/tmp/tool.py",
                    tool_id="my-tool",
                    tool_schema=TOOL_SCHEMA,
                    tool_description="A tool",
                )
        assert result is True

    def test_reused_pending_tracked_in_run_state(self):
        """PENDING_APPROVAL reused record records in run_state.pending_approval."""
        client, stubber = _stubbed_client()
        stubber.add_response(
            "list_registry_records",
            _list_response([_existing_record_summary("pending-tool", RECORD_ID)]),
            expected_params={
                "registryId": REGISTRY_ID,
                "filters": [
                    {"name": "recordType", "values": ["CUSTOM"]},
                    {"name": "name", "values": ["pending-tool"]},
                ],
                "maxResults": 100,
            },
        )
        stubber.add_response(
            "get_registry_record",
            _get_record_response("PENDING_APPROVAL"),
            expected_params={
                "registryId": REGISTRY_ID,
                "recordId": RECORD_ID,
            },
        )

        index._begin_registration_run()
        try:
            with stubber:
                with patch("index._get_registry_client", return_value=client):
                    index.store_tool_config_registry(
                        file_name="/tmp/tool.py",
                        tool_id="pending-tool",
                        tool_schema=TOOL_SCHEMA,
                        tool_description="A tool",
                    )
            rs = index._registration_run_state
            assert "pending-tool" in rs.pending_approval
            assert "pending-tool" in rs.succeeded
        finally:
            index._end_registration_run()


class TestToolReusedDraft:
    """Reused DRAFT record → SubmitRegistryRecordForApproval IS called."""

    def test_reused_draft_submits_for_approval(self):
        client, stubber = _stubbed_client()

        stubber.add_response(
            "list_registry_records",
            _list_response([_existing_record_summary("draft-tool", RECORD_ID)]),
            expected_params={
                "registryId": REGISTRY_ID,
                "filters": [
                    {"name": "recordType", "values": ["CUSTOM"]},
                    {"name": "name", "values": ["draft-tool"]},
                ],
                "maxResults": 100,
            },
        )
        # GetRegistryRecord → DRAFT
        stubber.add_response(
            "get_registry_record",
            _get_record_response("DRAFT"),
            expected_params={
                "registryId": REGISTRY_ID,
                "recordId": RECORD_ID,
            },
        )
        # SubmitRegistryRecordForApproval → APPROVED
        stubber.add_response(
            "submit_registry_record_for_approval",
            _submit_response("APPROVED"),
            expected_params={
                "registryId": REGISTRY_ID,
                "recordId": RECORD_ID,
            },
        )

        with stubber:
            with patch("index._get_registry_client", return_value=client):
                result = index.store_tool_config_registry(
                    file_name="/tmp/tool.py",
                    tool_id="draft-tool",
                    tool_schema=TOOL_SCHEMA,
                    tool_description="A tool",
                )
        assert result is True


class TestToolReusedRejected:
    """Reused REJECTED record → clear failure, no submit."""

    def test_reused_rejected_raises(self):
        client, stubber = _stubbed_client()

        stubber.add_response(
            "list_registry_records",
            _list_response([_existing_record_summary("rej-tool", RECORD_ID)]),
            expected_params={
                "registryId": REGISTRY_ID,
                "filters": [
                    {"name": "recordType", "values": ["CUSTOM"]},
                    {"name": "name", "values": ["rej-tool"]},
                ],
                "maxResults": 100,
            },
        )
        stubber.add_response(
            "get_registry_record",
            _get_record_response("REJECTED"),
            expected_params={
                "registryId": REGISTRY_ID,
                "recordId": RECORD_ID,
            },
        )

        with stubber:
            with patch("index._get_registry_client", return_value=client):
                with pytest.raises(RuntimeError, match="terminal status.*REJECTED"):
                    index.store_tool_config_registry(
                        file_name="/tmp/tool.py",
                        tool_id="rej-tool",
                        tool_schema=TOOL_SCHEMA,
                        tool_description="A tool",
                    )


# ============================================================================
# store_agent_config_registry: reused record status handling
# ============================================================================


class TestAgentReusedApproved:
    """Reused APPROVED agent record → no SubmitRegistryRecordForApproval."""

    def test_reused_approved_agent_skips_submit(self):
        client, stubber = _stubbed_client()

        # ListRegistryRecords → existing agent found
        stubber.add_response(
            "list_registry_records",
            _list_response([_existing_record_summary("my-agent", RECORD_ID)]),
            expected_params={
                "registryId": REGISTRY_ID,
                "filters": [
                    {"name": "recordType", "values": ["CUSTOM"]},
                    {"name": "name", "values": ["my-agent"]},
                ],
                "maxResults": 100,
            },
        )
        # GetRegistryRecord → APPROVED
        stubber.add_response(
            "get_registry_record",
            _get_record_response("APPROVED"),
            expected_params={
                "registryId": REGISTRY_ID,
                "recordId": RECORD_ID,
            },
        )

        # No submit stub → Stubber would fail if called.

        with stubber:
            with patch("index._get_registry_client", return_value=client):
                with patch("index._write_app_meta_row", return_value=True):
                    result = index.store_agent_config_registry(
                        file_name="/tmp/agent.py",
                        agent_id="my-agent",
                        llm_tool_schema=TOOL_SCHEMA,
                        agent_description="An agent",
                    )
        assert result is True


class TestAgentReusedPending:
    """Reused PENDING_APPROVAL agent record → no submit call."""

    def test_reused_pending_agent_skips_submit(self):
        client, stubber = _stubbed_client()

        stubber.add_response(
            "list_registry_records",
            _list_response([_existing_record_summary("my-agent", RECORD_ID)]),
            expected_params={
                "registryId": REGISTRY_ID,
                "filters": [
                    {"name": "recordType", "values": ["CUSTOM"]},
                    {"name": "name", "values": ["my-agent"]},
                ],
                "maxResults": 100,
            },
        )
        stubber.add_response(
            "get_registry_record",
            _get_record_response("PENDING_APPROVAL"),
            expected_params={
                "registryId": REGISTRY_ID,
                "recordId": RECORD_ID,
            },
        )

        with stubber:
            with patch("index._get_registry_client", return_value=client):
                with patch("index._write_app_meta_row", return_value=True):
                    result = index.store_agent_config_registry(
                        file_name="/tmp/agent.py",
                        agent_id="my-agent",
                        llm_tool_schema=TOOL_SCHEMA,
                        agent_description="An agent",
                    )
        assert result is True


class TestAgentReusedDraft:
    """Reused DRAFT agent record → SubmitRegistryRecordForApproval called."""

    def test_reused_draft_agent_submits(self):
        client, stubber = _stubbed_client()

        stubber.add_response(
            "list_registry_records",
            _list_response([_existing_record_summary("my-agent", RECORD_ID)]),
            expected_params={
                "registryId": REGISTRY_ID,
                "filters": [
                    {"name": "recordType", "values": ["CUSTOM"]},
                    {"name": "name", "values": ["my-agent"]},
                ],
                "maxResults": 100,
            },
        )
        stubber.add_response(
            "get_registry_record",
            _get_record_response("DRAFT"),
            expected_params={
                "registryId": REGISTRY_ID,
                "recordId": RECORD_ID,
            },
        )
        stubber.add_response(
            "submit_registry_record_for_approval",
            _submit_response("APPROVED"),
            expected_params={
                "registryId": REGISTRY_ID,
                "recordId": RECORD_ID,
            },
        )

        with stubber:
            with patch("index._get_registry_client", return_value=client):
                with patch("index._write_app_meta_row", return_value=True):
                    result = index.store_agent_config_registry(
                        file_name="/tmp/agent.py",
                        agent_id="my-agent",
                        llm_tool_schema=TOOL_SCHEMA,
                        agent_description="An agent",
                    )
        assert result is True


class TestAgentReusedRejected:
    """Reused REJECTED agent record → clear failure."""

    def test_reused_rejected_agent_raises(self):
        client, stubber = _stubbed_client()

        stubber.add_response(
            "list_registry_records",
            _list_response([_existing_record_summary("my-agent", RECORD_ID)]),
            expected_params={
                "registryId": REGISTRY_ID,
                "filters": [
                    {"name": "recordType", "values": ["CUSTOM"]},
                    {"name": "name", "values": ["my-agent"]},
                ],
                "maxResults": 100,
            },
        )
        stubber.add_response(
            "get_registry_record",
            _get_record_response("REJECTED"),
            expected_params={
                "registryId": REGISTRY_ID,
                "recordId": RECORD_ID,
            },
        )

        with stubber:
            with patch("index._get_registry_client", return_value=client):
                with pytest.raises(RuntimeError, match="terminal status.*REJECTED"):
                    index.store_agent_config_registry(
                        file_name="/tmp/agent.py",
                        agent_id="my-agent",
                        llm_tool_schema=TOOL_SCHEMA,
                        agent_description="An agent",
                    )


# ============================================================================
# New-record (non-reuse) path: GetRegistryRecord before submit
# ============================================================================


class TestToolNewRecordDraftSubmit:
    """Freshly-created tool record: GetRegistryRecord returns DRAFT → submit."""

    def test_new_record_reads_status_then_submits(self):
        client, stubber = _stubbed_client()

        # ListRegistryRecords → no existing record
        stubber.add_response(
            "list_registry_records",
            _list_response([]),
            expected_params={
                "registryId": REGISTRY_ID,
                "filters": [
                    {"name": "recordType", "values": ["CUSTOM"]},
                    {"name": "name", "values": ["new-tool"]},
                ],
                "maxResults": 100,
            },
        )
        # Global lookup for cross-org check
        stubber.add_response(
            "list_registry_records",
            _list_response([]),
            expected_params={
                "registryId": REGISTRY_ID,
                "filters": [
                    {"name": "recordType", "values": ["CUSTOM"]},
                    {"name": "name", "values": ["new-tool"]},
                ],
                "maxResults": 100,
            },
        )
        # CreateRegistryRecord (output shape: {recordArn, status})
        stubber.add_response(
            "create_registry_record",
            {
                "recordArn": RECORD_ARN,
                "status": "CREATING",
            },
        )
        # GetRegistryRecord → DRAFT (newly created records settle to DRAFT)
        stubber.add_response(
            "get_registry_record",
            _get_record_response("DRAFT"),
            expected_params={
                "registryId": REGISTRY_ID,
                "recordId": RECORD_ID,
            },
        )
        # SubmitRegistryRecordForApproval → APPROVED
        stubber.add_response(
            "submit_registry_record_for_approval",
            _submit_response("APPROVED"),
            expected_params={
                "registryId": REGISTRY_ID,
                "recordId": RECORD_ID,
            },
        )

        with stubber:
            with patch("index._get_registry_client", return_value=client):
                result = index.store_tool_config_registry(
                    file_name="/tmp/new-tool.py",
                    tool_id="new-tool",
                    tool_schema=TOOL_SCHEMA,
                    tool_description="A new tool",
                )
        assert result is True
