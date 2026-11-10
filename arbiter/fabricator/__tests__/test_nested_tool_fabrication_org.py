"""Tests for CIT-302: nested tool fabrication keeps the caller's organisation.

Covers:
  - _make_create_custom_tool binds org_id into the nested store closure
  - store_tool_config_registry fails closed when org_id is empty
  - ContextVars are reset between fabrication jobs (no cross-job leakage)
  - _emit_org_missing_metric is called on the fail-closed path
"""

import json
import os
import sys
from typing import Any
from unittest.mock import MagicMock, patch, call

import pytest

sys.path.insert(0, os.path.join(os.path.dirname(__file__), ".."))
sys.path.insert(0, os.path.join(os.path.dirname(__file__), "..", "..", "common"))

os.environ.setdefault("TOOL_CONFIG_TABLE", "fake-tool-table")
os.environ.setdefault("AGENT_CONFIG_TABLE", "fake-agent-table")
os.environ.setdefault("AGENT_BUCKET_NAME", "fake-bucket")
os.environ.setdefault("COMPLETION_BUS_NAME", "fake-bus")
os.environ.setdefault("WORKER_QUEUE_URL", "https://sqs.fake/queue")
os.environ.setdefault("REGISTRY_ID", "fake-registry-id")
os.environ.setdefault("AWS_DEFAULT_REGION", "us-west-2")

import index
from index import (
    _make_create_custom_tool,
    create_tool_fabricator,
    store_tool_config_registry,
    _emit_org_missing_metric,
    _reset_cloudwatch_client_for_test,
    _reset_registry_client_for_test,
    _begin_registration_run,
    _end_registration_run,
)
from fabrication_context import fabrication_org_id, fabrication_job_id
from tools_config import FabricationError


# ---------------------------------------------------------------------------
# Helpers
# ---------------------------------------------------------------------------

def _make_registry_client_stub(existing_records=None):
    """Build a MagicMock registry client that returns no existing records
    by default and captures create/submit calls."""
    client = MagicMock()
    client.list_registry_records.return_value = {
        "registryRecords": existing_records or [],
    }
    client.create_registry_record.return_value = {
        "recordArn": "arn:aws:agent-registry:us-west-2:123:registry/fake-registry-id/record/rec-new-001",
    }
    client.get_registry_record.return_value = {"status": "DRAFT"}
    client.submit_registry_record_for_approval.return_value = {"status": "APPROVED"}
    return client


# ---------------------------------------------------------------------------
# Test: _make_create_custom_tool binds the outer org into the nested path
# ---------------------------------------------------------------------------

class TestMakeCreateCustomToolOrgBinding:
    """The factory must capture org_id so the nested fabricator registers
    tools under the caller's organisation."""

    def test_nested_store_receives_outer_org(self):
        """When _make_create_custom_tool(org_id='org-X') builds a
        create_custom_tool, the inner store_tool_config_registry call
        receives org_id='org-X'."""
        captured_kwargs: dict[str, Any] = {}

        # Intercept create_tool_fabricator to capture what store_tool_tool
        # is passed, then return a no-op agent.
        original_create_tool_fabricator = index.create_tool_fabricator

        def spy_create_tool_fabricator(store_tool_tool=None):
            # Instead of creating a real Agent, just record the tool and
            # return a callable that invokes store_tool_tool with test args.
            def fake_agent(prompt):
                # Simulate the LLM calling store_tool_config_registry
                store_tool_tool(
                    file_name="/tmp/test_tool.py",
                    tool_id="test_tool",
                    tool_schema={"type": "object"},
                    tool_description="A test tool",
                )
                return "done"
            return fake_agent

        mock_client = _make_registry_client_stub()

        with (
            patch.object(index, "create_tool_fabricator", side_effect=spy_create_tool_fabricator),
            patch.object(index, "_get_registry_client", return_value=mock_client),
            patch.object(index, "registration_checkpoint"),
            patch.object(index, "_emit_org_missing_metric"),
        ):
            # Build the org-bound tool
            bound_tool = _make_create_custom_tool(
                org_id="org-OUTER",
                requested_by="user@example.com",
                spec_id=None,
            )
            # Invoke it (simulates the LLM calling create_custom_tool)
            bound_tool._tool_func(
                tool_description="Create a test tool",
            )

        # Verify that the registry record was created with orgId in custom_metadata
        create_call = mock_client.create_registry_record
        assert create_call.called
        call_kwargs = create_call.call_args[1]
        custom_data = json.loads(call_kwargs["descriptors"]["custom"]["data"])
        assert custom_data["orgId"] == "org-OUTER"
        assert custom_data["createdBy"] == "user@example.com"

    def test_nested_store_receives_spec_id(self):
        """When spec_id is provided, it is threaded into the nested store
        and the spec gate functions are invoked for code-gen tools."""
        mock_client = _make_registry_client_stub()
        gate_calls = []

        def fake_validate(manifest, sid):
            gate_calls.append(("validate", sid))

        def fake_assert(sid):
            gate_calls.append(("assert", sid))

        with (
            patch.object(index, "_get_registry_client", return_value=mock_client),
            patch.object(index, "registration_checkpoint"),
            patch("index.validate_code_tool_binding", side_effect=fake_validate),
            patch("index.assert_spec_approved", side_effect=fake_assert),
            patch.object(index, "_emit_org_missing_metric"),
        ):
            bound_tool = _make_create_custom_tool(
                org_id="org-SPEC",
                requested_by="fabricator",
                spec_id="spec-123",
            )

            def spy_create_tool_fabricator(store_tool_tool=None):
                def fake_agent(prompt):
                    # The bound store wrapper should thread spec_id="spec-123"
                    store_tool_tool._tool_func(
                        file_name="/tmp/spec_tool.py",
                        tool_id="spec_tool",
                        tool_schema={"type": "object", "outputs": ["code"]},
                        tool_description="A code-gen tool",
                    )
                    return "done"
                return fake_agent

            with patch.object(index, "create_tool_fabricator", side_effect=spy_create_tool_fabricator):
                bound_tool._tool_func(tool_description="code gen")

        # The gate functions should have been called with spec_id="spec-123"
        assert ("validate", "spec-123") in gate_calls
        assert ("assert", "spec-123") in gate_calls


# ---------------------------------------------------------------------------
# Test: store_tool_config_registry fails closed when org_id is empty
# ---------------------------------------------------------------------------

class TestStoreToolFailClosedWithoutOrg:
    """store_tool_config_registry must refuse to write when org_id is empty
    and a registration run is active (inside process_event)."""

    def setup_method(self):
        _begin_registration_run()

    def teardown_method(self):
        _end_registration_run()

    def test_empty_org_raises_fabrication_error(self):
        """Calling with org_id='' raises FabricationError."""
        mock_client = _make_registry_client_stub()

        with (
            patch.object(index, "_get_registry_client", return_value=mock_client),
            patch.object(index, "registration_checkpoint"),
            patch.object(index, "_emit_org_missing_metric") as mock_metric,
        ):
            with pytest.raises(FabricationError, match="org_id is required"):
                store_tool_config_registry._tool_func(
                    file_name="/tmp/tool.py",
                    tool_id="orphan_tool",
                    tool_schema={"type": "object"},
                    tool_description="should fail",
                    org_id="",
                )

        # Must NOT have called create_registry_record
        mock_client.create_registry_record.assert_not_called()

    def test_empty_org_emits_org_missing_metric(self):
        """The fail-closed path emits Citadel/Fabricator OrgMissing."""
        mock_client = _make_registry_client_stub()

        with (
            patch.object(index, "_get_registry_client", return_value=mock_client),
            patch.object(index, "registration_checkpoint"),
            patch.object(index, "_emit_org_missing_metric") as mock_metric,
        ):
            with pytest.raises(FabricationError):
                store_tool_config_registry._tool_func(
                    file_name="/tmp/tool.py",
                    tool_id="no_org_tool",
                    tool_schema={"type": "object"},
                    tool_description="should fail",
                    org_id="",
                )

        mock_metric.assert_called_once_with("store_tool_config_registry", "no_org_tool")

    def test_none_org_treated_as_empty(self):
        """org_id=None (missing kwarg default) is treated as empty and refused."""
        mock_client = _make_registry_client_stub()

        with (
            patch.object(index, "_get_registry_client", return_value=mock_client),
            patch.object(index, "registration_checkpoint"),
            patch.object(index, "_emit_org_missing_metric"),
        ):
            # The default is org_id="" (empty string), which triggers the guard
            with pytest.raises(FabricationError, match="org_id is required"):
                store_tool_config_registry._tool_func(
                    file_name="/tmp/tool.py",
                    tool_id="default_org_tool",
                    tool_schema={"type": "object"},
                    tool_description="should fail",
                )

    def test_valid_org_proceeds_normally(self):
        """With a non-empty org_id, registration proceeds."""
        mock_client = _make_registry_client_stub()

        with (
            patch.object(index, "_get_registry_client", return_value=mock_client),
            patch.object(index, "registration_checkpoint"),
            patch.object(index, "publish_fabrication_event"),
        ):
            result = store_tool_config_registry._tool_func(
                file_name="/tmp/good_tool.py",
                tool_id="good_tool",
                tool_schema={"type": "object"},
                tool_description="a good tool",
                org_id="org-VALID",
            )

        assert result is True
        mock_client.create_registry_record.assert_called_once()


# ---------------------------------------------------------------------------
# Test: ContextVars reset between fabrication jobs
# ---------------------------------------------------------------------------

class TestContextVarResetBetweenJobs:
    """fabrication_org_id/job_id must not leak between process_event calls."""

    def test_contextvars_reset_after_process_event(self):
        """After process_event completes (success or failure), the ContextVars
        must be reset to their defaults."""
        # Set ContextVars to simulate a prior run that leaked
        fabrication_org_id.set("org-STALE")
        fabrication_job_id.set("job-STALE")

        # Build a minimal event that passes the org gate but fails quickly
        event = {
            "org_id": "org-NEW",
            "orchestration_id": "orch-123",
            "agent_use_id": "agent-1",
            "agent_input": {"taskDetails": "test"},
        }

        with (
            patch.object(index, "check_design_assessment"),
            patch.object(index, "_write_fabrication_status"),
            patch.object(index, "publish_intake_progress"),
            patch.object(index, "publish_fabrication_event"),
            patch.object(index, "call_with_transient_retry", side_effect=RuntimeError("test abort")),
            patch.object(index, "set_fabrication_deadline"),
            patch.object(index, "clear_fabrication_deadline"),
            patch.object(index, "FabricationDeadline") as mock_deadline_cls,
        ):
            mock_deadline_cls.from_lambda_context.return_value = MagicMock(tripped=False)

            with pytest.raises(RuntimeError, match="test abort"):
                index.process_event(event, {})

        # After process_event's finally block, ContextVars must be reset
        assert fabrication_org_id.get("") == ""
        assert fabrication_job_id.get("") == ""


# ---------------------------------------------------------------------------
# Test: _emit_org_missing_metric
# ---------------------------------------------------------------------------

class TestEmitOrgMissingMetric:
    """The OrgMissing metric helper emits the correct CloudWatch data."""

    def setup_method(self):
        _reset_cloudwatch_client_for_test()

    def teardown_method(self):
        _reset_cloudwatch_client_for_test()

    def test_emits_correct_metric(self):
        mock_cw = MagicMock()
        with patch.object(index, "_cloudwatch", return_value=mock_cw):
            _emit_org_missing_metric("store_tool_config_registry", "my_tool")

        mock_cw.put_metric_data.assert_called_once()
        metric_data = mock_cw.put_metric_data.call_args[1]["MetricData"][0]
        assert metric_data["MetricName"] == "OrgMissing"
        assert metric_data["Dimensions"][0]["Name"] == "Site"
        assert metric_data["Dimensions"][0]["Value"] == "store_tool_config_registry"

    def test_cloudwatch_failure_does_not_raise(self):
        """A CloudWatch outage must never change the guard's behavior."""
        mock_cw = MagicMock()
        mock_cw.put_metric_data.side_effect = RuntimeError("CW down")
        with patch.object(index, "_cloudwatch", return_value=mock_cw):
            # Should not raise
            _emit_org_missing_metric("store_tool_config_registry", "my_tool")


# ---------------------------------------------------------------------------
# Test: create_agent_fabricator uses the bound create_custom_tool_tool
# ---------------------------------------------------------------------------

class TestCreateAgentFabricatorToolBinding:
    """create_agent_fabricator must thread the org-bound create_custom_tool
    into the Agent's tools list."""

    def test_custom_create_tool_passed_to_agent(self):
        """When create_custom_tool_tool is provided, it appears in the
        Agent's tools list (not the legacy unbound version)."""
        sentinel_tool = MagicMock()
        sentinel_tool.__name__ = "create_custom_tool"
        complete_task = MagicMock()
        complete_task.__name__ = "complete_task"

        with patch("index.Agent") as MockAgent, \
             patch("index.models.BedrockModel"):
            MockAgent.return_value = MagicMock()
            index.create_agent_fabricator(
                complete_task,
                org_id="org-TEST",
                create_custom_tool_tool=sentinel_tool,
            )

        # The Agent was constructed with tools that include our sentinel
        agent_call_kwargs = MockAgent.call_args
        tools = agent_call_kwargs[1].get("tools") or agent_call_kwargs[0][1] if len(agent_call_kwargs[0]) > 1 else agent_call_kwargs[1].get("tools")
        assert sentinel_tool in tools
