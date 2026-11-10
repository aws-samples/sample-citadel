"""
Tests for the registration-time spec-approval gate (CIT-256 H2).

Covers:
  - Code-generating tool WITHOUT spec_id → FabricationError
  - Code-generating tool with UNAPPROVED spec → FabricationError
  - Code-generating tool with APPROVED spec → record created as DRAFT + submitted
  - Non-code-generating tool without spec_id → passes (no gate)
  - Record is created as DRAFT and submitted (never directly APPROVED)
  - ToolRegistrationDenied metric emitted on denial
"""

import json
import os
import sys
from unittest.mock import MagicMock, call, patch

import pytest

sys.path.insert(0, os.path.join(os.path.dirname(__file__), ".."))

# Required env vars before import
os.environ.setdefault("TOOL_CONFIG_TABLE", "fake-tool-table")
os.environ.setdefault("AGENT_CONFIG_TABLE", "fake-agent-table")
os.environ.setdefault("AGENT_BUCKET_NAME", "fake-bucket")
os.environ.setdefault("COMPLETION_BUS_NAME", "fake-bus")
os.environ.setdefault("WORKER_QUEUE_URL", "https://sqs.fake/queue")
os.environ.setdefault("REGISTRY_ID", "fake-registry-id")
os.environ.setdefault("AWS_DEFAULT_REGION", "us-west-2")
os.environ.setdefault("EXECUTION_SPECS_TABLE", "fake-specs-table")

from index import store_tool_config_registry  # noqa: E402
import index  # noqa: E402
from tools_config import FabricationError  # noqa: E402


# ---------------------------------------------------------------------------
# Helpers
# ---------------------------------------------------------------------------

def _make_registry_mock(record_id: str = "gen-record-id"):
    """Registry client mock returning realistic responses."""
    client = MagicMock()
    client.list_registry_records.return_value = {"registryRecords": []}
    client.create_registry_record.return_value = {
        "recordArn": (
            f"arn:aws:bedrock-agentcore:us-west-2:123456789012:"
            f"registry/reg/record/{record_id}"
        ),
        "recordId": record_id,
        "status": "CREATING",
    }
    # get_registry_record returns DRAFT — the initial state after creation
    client.get_registry_record.return_value = {
        "recordId": record_id,
        "status": "DRAFT",
    }
    # submit_registry_record_for_approval may return APPROVED (auto-approval)
    # or PENDING_APPROVAL (manual review); default to PENDING_APPROVAL to
    # prove we never write APPROVED ourselves.
    client.submit_registry_record_for_approval.return_value = {
        "recordId": record_id,
        "status": "PENDING_APPROVAL",
    }
    return client


def _make_ddb_mock(spec_status: str = "APPROVED"):
    """DynamoDB resource mock for assert_spec_approved."""
    table = MagicMock()
    table.get_item.return_value = {
        "Item": {"specId": "spec-123", "status": spec_status}
    }
    resource = MagicMock()
    resource.Table.return_value = table
    return resource


CODE_GEN_SCHEMA = {
    "type": "object",
    "properties": {"code": {"type": "string", "description": "Generated code"}},
    "required": ["code"],
    "outputs": ["code"],
}

NON_CODE_GEN_SCHEMA = {
    "type": "object",
    "properties": {"text": {"type": "string", "description": "Text output"}},
    "required": ["text"],
    "outputs": ["text"],
}


@pytest.fixture(autouse=True)
def _reset_cached_clients():
    """Clear module-level lazy clients between tests."""
    index._reset_registry_client_for_test()
    index._reset_cloudwatch_client_for_test()
    yield
    index._reset_registry_client_for_test()
    index._reset_cloudwatch_client_for_test()


# ---------------------------------------------------------------------------
# Gate denials
# ---------------------------------------------------------------------------

class TestSpecGateDeniesUngovernedTools:
    """Code-generating tools must fail closed when spec is missing/unapproved."""

    def test_code_generating_tool_without_spec_id_rejected(self):
        """Code-generating tool + spec_id=None → FabricationError."""
        client = _make_registry_mock()
        with patch("index._get_registry_client", return_value=client):
            with pytest.raises(FabricationError, match="spec_id required"):
                store_tool_config_registry(
                    file_name="/tmp/gen.py",
                    tool_id="gen_tool",
                    tool_schema=CODE_GEN_SCHEMA,
                    tool_description="generates code",
                    spec_id=None,
                    org_id="test-org",
                )
        # Must NOT have created a registry record
        client.create_registry_record.assert_not_called()

    def test_code_generating_tool_with_unapproved_spec_rejected(self):
        """Code-generating tool + spec status DRAFT → FabricationError."""
        client = _make_registry_mock()
        ddb = _make_ddb_mock(spec_status="DRAFT")
        with (
            patch("index._get_registry_client", return_value=client),
            patch("tools_config._get_dynamodb", return_value=ddb),
        ):
            with pytest.raises(FabricationError, match="not APPROVED"):
                store_tool_config_registry(
                    file_name="/tmp/gen.py",
                    tool_id="gen_tool",
                    tool_schema=CODE_GEN_SCHEMA,
                    tool_description="generates code",
                    spec_id="spec-unapproved",
                    org_id="test-org",
                )
        client.create_registry_record.assert_not_called()

    def test_code_generating_tool_missing_outputs_conservative_denial(self):
        """Schema without 'outputs' key + spec_id provided → conservative: treated as code-gen.
        
        validate_code_tool_binding passes (spec_id present), then
        assert_spec_approved checks the spec status.  With an unapproved
        spec this is a denial.
        """
        schema_no_outputs = {
            "type": "object",
            "properties": {"x": {"type": "string", "description": "x"}},
        }
        client = _make_registry_mock()
        ddb = _make_ddb_mock(spec_status="DRAFT")
        with (
            patch("index._get_registry_client", return_value=client),
            patch("tools_config._get_dynamodb", return_value=ddb),
        ):
            with pytest.raises(FabricationError, match="not APPROVED"):
                store_tool_config_registry(
                    file_name="/tmp/noout.py",
                    tool_id="no_outputs_tool",
                    tool_schema=schema_no_outputs,
                    tool_description="no outputs declared",
                    spec_id="spec-no-outputs",
                    org_id="test-org",
                )
        client.create_registry_record.assert_not_called()


# ---------------------------------------------------------------------------
# Gate passes
# ---------------------------------------------------------------------------

class TestSpecGateAllowsGovernedTools:
    """Code-generating tools with approved spec, and non-code-gen tools, pass."""

    def test_code_generating_tool_with_approved_spec_passes(self):
        """Code-gen tool + APPROVED spec → record created + submitted."""
        client = _make_registry_mock()
        ddb = _make_ddb_mock(spec_status="APPROVED")
        with (
            patch("index._get_registry_client", return_value=client),
            patch("tools_config._get_dynamodb", return_value=ddb),
        ):
            result = store_tool_config_registry(
                file_name="/tmp/gen.py",
                tool_id="gen_tool",
                tool_schema=CODE_GEN_SCHEMA,
                tool_description="generates code",
                spec_id="spec-123",
                org_id="test-org",
            )
        assert result is True
        client.create_registry_record.assert_called_once()
        client.submit_registry_record_for_approval.assert_called_once()

    def test_non_code_generating_tool_without_spec_passes(self):
        """Non-code-gen tool + no spec_id → passes (gate not enforced)."""
        client = _make_registry_mock()
        with patch("index._get_registry_client", return_value=client):
            result = store_tool_config_registry(
                file_name="/tmp/text.py",
                tool_id="text_tool",
                tool_schema=NON_CODE_GEN_SCHEMA,
                tool_description="returns text",
                spec_id=None,
                org_id="test-org",
            )
        assert result is True
        client.create_registry_record.assert_called_once()

    def test_non_code_generating_tool_with_empty_outputs_passes(self):
        """Schema with outputs=[] → non-code-gen → passes without spec."""
        schema = {
            "type": "object",
            "properties": {"x": {"type": "string", "description": "x"}},
            "outputs": [],
        }
        client = _make_registry_mock()
        with patch("index._get_registry_client", return_value=client):
            result = store_tool_config_registry(
                file_name="/tmp/empty.py",
                tool_id="empty_outputs_tool",
                tool_schema=schema,
                tool_description="empty outputs",
                spec_id=None,
                org_id="test-org",
            )
        assert result is True
        client.create_registry_record.assert_called_once()

    def test_legacy_tool_without_outputs_key_passes(self):
        """Schema without 'outputs' key + no spec_id → passes (backward compat)."""
        schema = {
            "type": "object",
            "properties": {"x": {"type": "string", "description": "x"}},
        }
        client = _make_registry_mock()
        with patch("index._get_registry_client", return_value=client):
            result = store_tool_config_registry(
                file_name="/tmp/legacy.py",
                tool_id="legacy_tool",
                tool_schema=schema,
                tool_description="legacy tool",
                spec_id=None,
                org_id="test-org",
            )
        assert result is True
        client.create_registry_record.assert_called_once()

    def test_explicit_code_gen_without_spec_id_rejected(self):
        """Schema with outputs=["code"] + no spec_id → FabricationError."""
        client = _make_registry_mock()
        with patch("index._get_registry_client", return_value=client):
            with pytest.raises(FabricationError, match="spec_id required"):
                store_tool_config_registry(
                    file_name="/tmp/gen.py",
                    tool_id="explicit_code_gen",
                    tool_schema=CODE_GEN_SCHEMA,
                    tool_description="generates code",
                    spec_id=None,
                    org_id="test-org",
                )
        client.create_registry_record.assert_not_called()


# ---------------------------------------------------------------------------
# Record lifecycle: DRAFT → submitted (never directly APPROVED)
# ---------------------------------------------------------------------------

class TestRecordCreatedAsDraftAndSubmitted:
    """Verify the fabricator creates records as DRAFT and submits for approval."""

    def test_record_submitted_not_directly_approved(self):
        """submit_registry_record_for_approval is called; update_registry_record_status is NOT."""
        client = _make_registry_mock()
        with patch("index._get_registry_client", return_value=client):
            store_tool_config_registry(
                file_name="/tmp/t.py",
                tool_id="test_tool",
                tool_schema=NON_CODE_GEN_SCHEMA,
                tool_description="desc",
                org_id="test-org",
            )
        client.submit_registry_record_for_approval.assert_called_once()
        client.update_registry_record_status.assert_not_called()

    def test_submit_call_shape_matches_registry_api(self):
        """SubmitRegistryRecordForApproval takes registryId + recordId only."""
        client = _make_registry_mock(record_id="rec-456")
        with patch("index._get_registry_client", return_value=client):
            store_tool_config_registry(
                file_name="/tmp/t.py",
                tool_id="test_tool",
                tool_schema=NON_CODE_GEN_SCHEMA,
                tool_description="desc",
                org_id="test-org",
            )
        kwargs = client.submit_registry_record_for_approval.call_args.kwargs
        assert kwargs["registryId"] == os.environ["REGISTRY_ID"]
        assert kwargs["recordId"] == "rec-456"
        # No other kwargs (the API takes only these two)
        assert set(kwargs.keys()) == {"registryId", "recordId"}

    def test_pending_approval_result_accepted(self):
        """When the registry returns PENDING_APPROVAL, the function succeeds."""
        client = _make_registry_mock()
        client.submit_registry_record_for_approval.return_value = {
            "recordId": "gen-record-id",
            "status": "PENDING_APPROVAL",
        }
        with patch("index._get_registry_client", return_value=client):
            result = store_tool_config_registry(
                file_name="/tmp/t.py",
                tool_id="test_tool",
                tool_schema=NON_CODE_GEN_SCHEMA,
                tool_description="desc",
                org_id="test-org",
            )
        assert result is True

    def test_auto_approved_result_accepted(self):
        """When the registry auto-approves, the function succeeds."""
        client = _make_registry_mock()
        client.submit_registry_record_for_approval.return_value = {
            "recordId": "gen-record-id",
            "status": "APPROVED",
        }
        with patch("index._get_registry_client", return_value=client):
            result = store_tool_config_registry(
                file_name="/tmp/t.py",
                tool_id="test_tool",
                tool_schema=NON_CODE_GEN_SCHEMA,
                tool_description="desc",
                org_id="test-org",
            )
        assert result is True


# ---------------------------------------------------------------------------
# Metric emission
# ---------------------------------------------------------------------------

class TestToolRegistrationDeniedMetric:
    """ToolRegistrationDenied CloudWatch metric must fire on gate denial."""

    def test_metric_emitted_on_code_gen_without_spec(self):
        """Metric fires when code-gen tool lacks spec_id."""
        cw_mock = MagicMock()
        client = _make_registry_mock()
        with (
            patch("index._get_registry_client", return_value=client),
            patch("index._cloudwatch", return_value=cw_mock),
        ):
            with pytest.raises(FabricationError):
                store_tool_config_registry(
                    file_name="/tmp/gen.py",
                    tool_id="gen_metric_tool",
                    tool_schema=CODE_GEN_SCHEMA,
                    tool_description="generates code",
                    spec_id=None,
                    org_id="test-org",
                )
        cw_mock.put_metric_data.assert_called_once()
        metric_data = cw_mock.put_metric_data.call_args.kwargs
        assert metric_data["Namespace"] == "Citadel/Fabricator"
        assert metric_data["MetricData"][0]["MetricName"] == "ToolRegistrationDenied"
        assert metric_data["MetricData"][0]["Value"] == 1
        dims = {
            d["Name"]: d["Value"]
            for d in metric_data["MetricData"][0]["Dimensions"]
        }
        assert dims["ToolId"] == "gen_metric_tool"

    def test_metric_emitted_on_unapproved_spec(self):
        """Metric fires when spec exists but is not APPROVED."""
        cw_mock = MagicMock()
        client = _make_registry_mock()
        ddb = _make_ddb_mock(spec_status="DRAFT")
        with (
            patch("index._get_registry_client", return_value=client),
            patch("index._cloudwatch", return_value=cw_mock),
            patch("tools_config._get_dynamodb", return_value=ddb),
        ):
            with pytest.raises(FabricationError):
                store_tool_config_registry(
                    file_name="/tmp/gen.py",
                    tool_id="gen_metric_tool2",
                    tool_schema=CODE_GEN_SCHEMA,
                    tool_description="generates code",
                    spec_id="spec-unapproved",
                    org_id="test-org",
                )
        cw_mock.put_metric_data.assert_called_once()

    def test_metric_not_emitted_on_success(self):
        """No denial metric when registration succeeds."""
        cw_mock = MagicMock()
        client = _make_registry_mock()
        ddb = _make_ddb_mock(spec_status="APPROVED")
        with (
            patch("index._get_registry_client", return_value=client),
            patch("index._cloudwatch", return_value=cw_mock),
            patch("tools_config._get_dynamodb", return_value=ddb),
        ):
            store_tool_config_registry(
                file_name="/tmp/gen.py",
                tool_id="gen_ok",
                tool_schema=CODE_GEN_SCHEMA,
                tool_description="generates code",
                spec_id="spec-123",
                org_id="test-org",
            )
        cw_mock.put_metric_data.assert_not_called()

    def test_metric_failure_does_not_suppress_gate_error(self):
        """CloudWatch outage must not change the gate's fail-closed behavior."""
        cw_mock = MagicMock()
        cw_mock.put_metric_data.side_effect = RuntimeError("cw down")
        client = _make_registry_mock()
        with (
            patch("index._get_registry_client", return_value=client),
            patch("index._cloudwatch", return_value=cw_mock),
        ):
            with pytest.raises(FabricationError, match="spec_id required"):
                store_tool_config_registry(
                    file_name="/tmp/gen.py",
                    tool_id="gen_cw_fail",
                    tool_schema=CODE_GEN_SCHEMA,
                    tool_description="code gen",
                    spec_id=None,
                    org_id="test-org",
                )
