"""Tests for the three fabricator registry defects fixed in this branch.

Defect 1: _find_existing_record_id used 'filters' kwarg (non-existent param)
           instead of the 'name' query-string parameter.
Defect 2: _approve() treated PENDING_APPROVAL as failure; it's a valid
           submission outcome under manual review.
Defect 3: store_tool_config_registry lacked the org-scoped idempotency
           lookup that store_agent_config_registry already had.

Tests use botocore.stub.Stubber where API shape validation is needed —
Stubber validates kwargs against the real service model so an invalid
parameter shape (like the old 'filters' list) fails the test.
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
from index import store_tool_config_registry  # noqa: E402


TOOL_SCHEMA = {
    "type": "object",
    "properties": {"q": {"type": "string", "description": "query"}},
    "required": ["q"],
}

REGISTRY_ID = "fake-registry-id"


@pytest.fixture(autouse=True)
def _reset_cached_client():
    index._reset_registry_client_for_test()
    yield
    index._reset_registry_client_for_test()


# ---- helpers ---------------------------------------------------------------

def _stubbed_client():
    """Create a real botocore client with Stubber for shape validation.

    Uses ``agent-registry-control`` — the same service the runtime code
    constructs via ``boto3.client('agent-registry-control')``.  An earlier
    version mistakenly used ``bedrock-agentcore-control`` which is a
    different service model with different ListRegistryRecords params.
    """
    session = botocore.session.get_session()
    client = session.create_client(
        "agent-registry-control", region_name="us-west-2"
    )
    stubber = Stubber(client)
    return client, stubber


def _make_mock(
    existing_records=None,
    record_id="gen-rec-id",
    approval_status="APPROVED",
):
    """Build a MagicMock client for tests that don't need shape validation."""
    client = MagicMock()
    client.list_registry_records.return_value = {
        "registryRecords": existing_records or [],
    }
    client.create_registry_record.return_value = {
        "recordArn": (
            f"arn:aws:bedrock-agentcore:us-west-2:123456789012:"
            f"registry/reg/record/{record_id}"
        ),
        "recordId": record_id,
        "status": "CREATING",
    }
    client.submit_registry_record_for_approval.return_value = {
        "recordId": record_id,
        "status": approval_status,
    }
    return client


# ============================================================================
# Defect 1: _find_existing_record_id filter shape validation
# ============================================================================

class TestFilterShapeValidation:
    """Botocore Stubber validates kwargs against the real service model.

    The old code passed 'name' as a top-level kwarg; the fix uses
    'filters' with {name, values} entries per the agent-registry-control
    service model.
    """

    def test_find_existing_record_id_uses_valid_api_shape(self):
        """Stubber validates the kwargs are valid for ListRegistryRecords."""
        client, stubber = _stubbed_client()
        stubber.add_response(
            "list_registry_records",
            {
                "registryRecords": [
                    {
                        "registryArn": "arn:aws:bedrock-agentcore:us-west-2:123:registry/r",
                        "recordArn": "arn:aws:bedrock-agentcore:us-west-2:123:registry/r/record/found-id-1234",
                        "recordId": "found-id-1234",
                        "name": "my-agent",
                        "displayName": "my-agent",
                        "recordType": "CUSTOM",
                        "recordVersion": "1",
                        "status": "APPROVED",
                        "createdAt": "2026-01-01T00:00:00Z",
                        "updatedAt": "2026-01-01T00:00:00Z",
                    }
                ],
            },
            expected_params={
                "registryId": REGISTRY_ID,
                "filters": [
                    {"name": "recordType", "values": ["CUSTOM"]},
                    {"name": "name", "values": ["my-agent"]},
                ],
                "maxResults": 100,
            },
        )
        with stubber:
            with patch("index._get_registry_client", return_value=client):
                result = index._find_existing_record_id(
                    REGISTRY_ID, "my-agent"
                )
        assert result == "found-id-1234"

    def test_find_existing_record_id_returns_none_when_empty(self):
        """No records → returns None."""
        client, stubber = _stubbed_client()
        stubber.add_response(
            "list_registry_records",
            {"registryRecords": []},
            expected_params={
                "registryId": REGISTRY_ID,
                "filters": [
                    {"name": "recordType", "values": ["CUSTOM"]},
                    {"name": "name", "values": ["missing-agent"]},
                ],
                "maxResults": 100,
            },
        )
        with stubber:
            with patch("index._get_registry_client", return_value=client):
                result = index._find_existing_record_id(
                    REGISTRY_ID, "missing-agent"
                )
        assert result is None

    def test_find_existing_record_id_matches_on_name_field(self):
        """When the API returns 'name' (not 'displayName'), the lookup
        still finds the match — the fix checks both fields."""
        client = MagicMock()
        client.list_registry_records.return_value = {
            "registryRecords": [
                {"name": "my-agent", "recordId": "via-name-field"},
            ],
        }
        with patch("index._get_registry_client", return_value=client):
            result = index._find_existing_record_id(REGISTRY_ID, "my-agent")
        assert result == "via-name-field"

    def test_old_filters_kwarg_rejected_by_botocore_validator(self):
        """Prove the old {key, values} filter entries are invalid — botocore rejects them."""
        from botocore.validate import ParamValidator
        session = botocore.session.get_session()
        client = session.create_client(
            "agent-registry-control", region_name="us-west-2"
        )
        model = client.meta.service_model.operation_model("ListRegistryRecords")
        validator = ParamValidator()
        report = validator.validate(
            {
                "registryId": "test",
                "filters": [{"key": "recordType", "values": ["CUSTOM"]}],
            },
            model.input_shape,
        )
        assert report.has_errors(), (
            "The old {key, values} filter entries should be rejected by the service model"
        )


# ============================================================================
# Defect 2: _approve() handles PENDING_APPROVAL as successful submission
# ============================================================================

class TestApprovalPendingApproval:
    """When SubmitRegistryRecordForApproval returns PENDING_APPROVAL,
    the tool should treat it as a successful submission, not a failure."""

    def test_pending_approval_does_not_raise(self):
        """PENDING_APPROVAL from submit should succeed, not raise."""
        client = _make_mock(approval_status="PENDING_APPROVAL")
        # _approve pre-reads status: DRAFT → submit → PENDING_APPROVAL.
        client.get_registry_record.return_value = {"status": "DRAFT"}
        with patch("index._get_registry_client", return_value=client):
            result = store_tool_config_registry(
                file_name="/tmp/tool.py",
                tool_id="my-tool",
                tool_schema=TOOL_SCHEMA,
                tool_description="A tool",
            )
        assert result is True
        # get_registry_record IS called once for the _approve status pre-read.
        assert client.get_registry_record.call_count == 1

    def test_approved_still_works(self):
        """APPROVED (auto-approval) continues to work as before."""
        client = _make_mock(approval_status="APPROVED")
        with patch("index._get_registry_client", return_value=client):
            result = store_tool_config_registry(
                file_name="/tmp/tool.py",
                tool_id="my-tool",
                tool_schema=TOOL_SCHEMA,
                tool_description="A tool",
            )
        assert result is True

    def test_unknown_status_still_raises(self):
        """A genuinely unexpected status (e.g. CREATING stuck) still raises."""
        client = _make_mock(approval_status="CREATING")
        # get_registry_record fallback also returns CREATING
        client.get_registry_record.return_value = {"status": "CREATING"}
        with patch("index._get_registry_client", return_value=client):
            with pytest.raises(RuntimeError, match="did not reach"):
                store_tool_config_registry(
                    file_name="/tmp/tool.py",
                    tool_id="my-tool",
                    tool_schema=TOOL_SCHEMA,
                    tool_description="A tool",
                )

    def test_pending_approval_tracked_in_run_state(self):
        """When _approve returns 'pending_approval', the tool_id is recorded
        in run_state.pending_approval for the fabrication-status write."""
        client = _make_mock(approval_status="PENDING_APPROVAL")
        index._begin_registration_run()
        try:
            with patch("index._get_registry_client", return_value=client):
                store_tool_config_registry(
                    file_name="/tmp/tool.py",
                    tool_id="my-pending-tool",
                    tool_schema=TOOL_SCHEMA,
                    tool_description="A tool",
                )
            run_state = index._registration_run_state
            assert "my-pending-tool" in run_state.pending_approval
            assert "my-pending-tool" in run_state.succeeded
        finally:
            index._registration_run_state = None

    def test_confirmed_pending_approval_via_get_registry_record(self):
        """When get_registry_record pre-read shows PENDING_APPROVAL, the
        tool returns True immediately without calling submit."""
        client = _make_mock(approval_status="SOME_NEW_STATUS")
        client.get_registry_record.return_value = {"status": "PENDING_APPROVAL"}
        with patch("index._get_registry_client", return_value=client):
            result = store_tool_config_registry(
                file_name="/tmp/tool.py",
                tool_id="my-tool",
                tool_schema=TOOL_SCHEMA,
                tool_description="A tool",
            )
        assert result is True


# ============================================================================
# Defect 3: store_tool_config_registry idempotency + cross-org error
# ============================================================================

class TestToolRegistryIdempotency:
    """store_tool_config_registry should reuse existing same-org records
    and surface a clear error for cross-org name collisions."""

    def test_skips_create_when_same_name_same_org_exists(self):
        """Existing record with matching name+org → skip CreateRegistryRecord."""
        existing = [{
            "displayName": "dup-tool",
            "recordId": "existing-tool-rec",
            "descriptors": {
                "custom": {
                    "data": json.dumps({"orgId": "org-1"}),
                },
            },
        }]
        client = _make_mock(existing_records=existing)
        with patch("index._get_registry_client", return_value=client):
            result = store_tool_config_registry(
                file_name="/tmp/dup-tool.py",
                tool_id="dup-tool",
                tool_schema=TOOL_SCHEMA,
                tool_description="duplicate",
                org_id="org-1",
            )
        assert result is True
        client.create_registry_record.assert_not_called()

    def test_creates_when_no_existing_record(self):
        """No existing record → CreateRegistryRecord called."""
        client = _make_mock()
        with patch("index._get_registry_client", return_value=client):
            result = store_tool_config_registry(
                file_name="/tmp/new-tool.py",
                tool_id="new-tool",
                tool_schema=TOOL_SCHEMA,
                tool_description="new",
            )
        assert result is True
        client.create_registry_record.assert_called_once()

    def test_raises_clear_error_when_name_used_by_another_org(self):
        """Record exists under ANOTHER org → clear ValueError, no retry loop."""
        # First call (org-scoped) returns nothing, second (global) finds it
        client = MagicMock()
        call_count = [0]

        def list_side_effect(**kwargs):
            call_count[0] += 1
            if call_count[0] == 1:
                # Org-scoped lookup: no match for this org
                return {"registryRecords": []}
            else:
                # Global lookup: found under another org
                return {
                    "registryRecords": [{
                        "displayName": "taken-tool",
                        "recordId": "other-org-rec",
                        "descriptors": {
                            "custom": {
                                "data": json.dumps({"orgId": "other-org"}),
                            },
                        },
                    }],
                }

        client.list_registry_records.side_effect = list_side_effect
        with patch("index._get_registry_client", return_value=client):
            with pytest.raises(ValueError, match="already used by another organisation"):
                store_tool_config_registry(
                    file_name="/tmp/taken-tool.py",
                    tool_id="taken-tool",
                    tool_schema=TOOL_SCHEMA,
                    tool_description="taken",
                    org_id="my-org",
                )
        client.create_registry_record.assert_not_called()

    def test_creates_when_name_exists_but_for_no_org(self):
        """When the name exists under no org (system/shared) and we're
        searching with org_id, we should find it in the global fallback
        and raise."""
        client = MagicMock()
        call_count = [0]

        def list_side_effect(**kwargs):
            call_count[0] += 1
            if call_count[0] == 1:
                return {"registryRecords": []}
            else:
                return {
                    "registryRecords": [{
                        "displayName": "shared-tool",
                        "recordId": "shared-rec",
                    }],
                }

        client.list_registry_records.side_effect = list_side_effect
        with patch("index._get_registry_client", return_value=client):
            with pytest.raises(ValueError, match="already used by another organisation"):
                store_tool_config_registry(
                    file_name="/tmp/shared-tool.py",
                    tool_id="shared-tool",
                    tool_schema=TOOL_SCHEMA,
                    tool_description="shared",
                    org_id="my-org",
                )


# ============================================================================
# Fabrication status: registryApprovalStatus attribute
# ============================================================================

class TestFabricationStatusApprovalAttribute:
    """_write_fabrication_status propagates registry_approval_status."""

    def test_approval_status_written_to_dynamodb(self):
        """When registry_approval_status is set, it appears in the update."""
        os.environ["FABRICATION_JOBS_TABLE"] = "citadel-fabrication-jobs-test"
        try:
            ddb_mock = MagicMock()
            with patch("index.boto3.client", return_value=ddb_mock):
                index._write_fabrication_status(
                    "orch-1", "agent-1", "COMPLETED",
                    agent_id="agent-1",
                    registry_approval_status="pending_approval",
                )
            call_args = ddb_mock.update_item.call_args
            expr = call_args[1]["UpdateExpression"]
            names = call_args[1]["ExpressionAttributeNames"]
            values = call_args[1]["ExpressionAttributeValues"]
            assert "#registryApprovalStatus" in expr
            assert names["#registryApprovalStatus"] == "registryApprovalStatus"
            assert values[":registryApprovalStatus"] == {"S": "pending_approval"}
        finally:
            os.environ.pop("FABRICATION_JOBS_TABLE", None)

    def test_no_approval_status_when_none(self):
        """When registry_approval_status is None, attribute is omitted."""
        os.environ["FABRICATION_JOBS_TABLE"] = "citadel-fabrication-jobs-test"
        try:
            ddb_mock = MagicMock()
            with patch("index.boto3.client", return_value=ddb_mock):
                index._write_fabrication_status(
                    "orch-1", "agent-1", "COMPLETED",
                    agent_id="agent-1",
                )
            call_args = ddb_mock.update_item.call_args
            values = call_args[1]["ExpressionAttributeValues"]
            assert ":registryApprovalStatus" not in values
        finally:
            os.environ.pop("FABRICATION_JOBS_TABLE", None)
