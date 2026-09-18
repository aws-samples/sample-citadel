"""
Tests for the org_id fail-closed guard on arbiter/fabricator/index.py's
process_event (design evidence, section C).

The TS resolver (fabricator-request-resolver.ts) now derives org via
requireOrgId (fail-closed) and always stamps a non-empty org_id onto the
SQS message body. This consumer must mirror that discipline: refuse to
process (no registry record, no status row, no design-assessment gate
call, error-level log, no raise -- safe no-op so the poison message does
not redeliver forever) when org_id is missing/empty on an
agent-creation/tool-creation message, and process normally when it is
present.

The 'manifest-proposal' request type is a DIFFERENT, unrelated event shape
(no agent_input/taskDetails) that already bypasses this whole code path
(see test_manifest_proposal.py) and is NOT in scope for this guard.
"""

import logging
import os
import sys
from unittest.mock import MagicMock, patch

sys.path.insert(0, os.path.join(os.path.dirname(__file__), ".."))

os.environ.setdefault("TOOL_CONFIG_TABLE", "fake-tool-table")
os.environ.setdefault("AGENT_CONFIG_TABLE", "fake-agent-table")
os.environ.setdefault("AGENT_BUCKET_NAME", "fake-bucket")
os.environ.setdefault("COMPLETION_BUS_NAME", "fake-bus")
os.environ.setdefault("WORKER_QUEUE_URL", "https://sqs.fake/queue")

import index


def _base_event(org_id=None, request_type_field=None, org_id_key="org_id"):
    event = {
        "orchestration_id": "sess-1",
        "agent_use_id": "MyAgent",
        "node": "fabricator",
        "agent_input": {"taskDetails": "Create an agent that does things"},
        "agent_index": 0,
        "total_agents": 1,
    }
    if org_id is not None:
        event[org_id_key] = org_id
    if request_type_field is not None:
        event["requestType"] = request_type_field
    return event


class TestProcessEventRefusesOrglessMessage:
    def setup_method(self):
        os.environ["FABRICATION_JOBS_TABLE"] = "citadel-fabrication-jobs-test"

    def teardown_method(self):
        os.environ.pop("FABRICATION_JOBS_TABLE", None)

    def test_missing_org_id_refuses_agent_creation_no_fabrication(self, caplog):
        with patch.object(index, "check_design_assessment") as gate, \
                patch.object(index, "create_agent_fabricator") as mk_agent, \
                patch.object(index, "_write_fabrication_status") as status_write, \
                patch.object(index, "publish_intake_progress") as progress, \
                patch.object(index, "publish_fabrication_event") as fab_event:
            with caplog.at_level(logging.ERROR):
                result = index.process_event(
                    _base_event(), {}, request_type="agent-creation",
                )

        assert result is None
        gate.assert_not_called()
        mk_agent.assert_not_called()
        status_write.assert_not_called()
        progress.assert_not_called()
        fab_event.assert_not_called()
        assert any(
            "org" in rec.message.lower() for rec in caplog.records
        ), "expected an error-level log naming the missing org_id"

    def test_empty_string_org_id_refuses_tool_creation_no_fabrication(self):
        with patch.object(index, "check_design_assessment") as gate, \
                patch.object(index, "create_tool_fabricator") as mk_tool, \
                patch.object(index, "_write_fabrication_status") as status_write:
            result = index.process_event(
                _base_event(org_id=""), {}, request_type="tool-creation",
            )

        assert result is None
        gate.assert_not_called()
        mk_tool.assert_not_called()
        status_write.assert_not_called()

    def test_missing_org_id_refuses_legacy_direct_request_type_none(self):
        # Legacy/direct requests (request_type=None) go through the same
        # code-fabrication path and must be refused the same way.
        with patch.object(index, "check_design_assessment") as gate, \
                patch.object(index, "create_agent_fabricator") as mk_agent, \
                patch.object(index, "_write_fabrication_status") as status_write:
            result = index.process_event(_base_event(), {}, request_type=None)

        assert result is None
        gate.assert_not_called()
        mk_agent.assert_not_called()
        status_write.assert_not_called()

    def test_missing_org_id_does_not_raise(self):
        # Safe no-op: must NOT raise, so the SQS message is deleted rather
        # than redelivered forever (poison-queue defence, mirrors the
        # existing unrecognised-requestType no-op).
        with patch.object(index, "check_design_assessment"), \
                patch.object(index, "create_agent_fabricator"):
            index.process_event(_base_event(), {}, request_type="agent-creation")

    def test_present_org_id_processes_normally_agent_creation(self):
        with patch.object(index, "check_design_assessment") as gate, \
                patch.object(index, "create_agent_fabricator") as mk, \
                patch.object(index, "_write_fabrication_status"), \
                patch.object(index, "publish_intake_progress"):
            mk.return_value = MagicMock()
            result = index.process_event(
                _base_event(org_id="org-real"), {}, request_type="agent-creation",
            )

        assert result is None
        gate.assert_called_once()
        mk.assert_called_once()

    def test_present_org_id_processes_normally_tool_creation(self):
        with patch.object(index, "check_design_assessment") as gate, \
                patch.object(index, "create_tool_fabricator") as mk, \
                patch.object(index, "_write_fabrication_status"), \
                patch.object(index, "publish_intake_progress"):
            mk.return_value = MagicMock()
            result = index.process_event(
                _base_event(org_id="org-real"), {}, request_type="tool-creation",
            )

        assert result is None
        gate.assert_called_once()
        mk.assert_called_once()

    def test_manifest_proposal_request_type_bypasses_this_guard_entirely(self):
        # Different event shape (requestId/correlationId/importId/signals),
        # no org_id concept at all -- must NOT be refused by this guard.
        event = {
            "requestId": "req-1",
            "correlationId": "corr-1",
            "importId": "imp-1",
            "signals": {"summary": "demo"},
        }
        with patch.object(index, "_process_manifest_proposal") as proposal:
            index.process_event(event, {}, request_type="manifest-proposal")

        proposal.assert_called_once()

    def test_unrecognised_request_type_still_safe_noop_independent_of_org_id(self):
        with patch.object(index, "check_design_assessment") as gate:
            result = index.process_event(
                _base_event(org_id="org-real"), {}, request_type="totally-bogus",
            )

        assert result is None
        gate.assert_not_called()


class TestProcessEventAcceptsBothOrgIdKeys:
    """org_id key-mismatch fix (Supervisor sends camelCase 'orgId' on its
    generic worker-dispatch payload — arbiter/supervisor/index.py — while
    service/agent_intake_single/tools/fabricate.py's _send_to_fabricator
    sends snake_case 'org_id'). The gate must accept either key so
    Supervisor-originated fabrication is not refused.
    """

    def setup_method(self):
        os.environ["FABRICATION_JOBS_TABLE"] = "citadel-fabrication-jobs-test"

    def teardown_method(self):
        os.environ.pop("FABRICATION_JOBS_TABLE", None)

    def test_camelcase_orgid_key_processes_normally_agent_creation(self):
        with patch.object(index, "check_design_assessment") as gate, \
                patch.object(index, "create_agent_fabricator") as mk, \
                patch.object(index, "_write_fabrication_status") as status_write, \
                patch.object(index, "publish_intake_progress"):
            mk.return_value = MagicMock()
            result = index.process_event(
                _base_event(org_id="org-real", org_id_key="orgId"),
                {}, request_type="agent-creation",
            )

        assert result is None
        gate.assert_called_once()
        mk.assert_called_once()
        # org_id threaded from the camelCase key reaches the status write.
        assert status_write.call_args.kwargs.get("org_id") == "org-real"

    def test_camelcase_orgid_key_processes_normally_tool_creation(self):
        with patch.object(index, "check_design_assessment") as gate, \
                patch.object(index, "create_tool_fabricator") as mk, \
                patch.object(index, "_write_fabrication_status") as status_write, \
                patch.object(index, "publish_intake_progress"):
            mk.return_value = MagicMock()
            result = index.process_event(
                _base_event(org_id="org-real", org_id_key="orgId"),
                {}, request_type="tool-creation",
            )

        assert result is None
        gate.assert_called_once()
        mk.assert_called_once()
        assert status_write.call_args.kwargs.get("org_id") == "org-real"

    def test_snake_case_org_id_key_still_processes_normally(self):
        # Regression guard: the pre-existing snake_case producer path must
        # keep working after the OR-fallback is introduced.
        with patch.object(index, "check_design_assessment") as gate, \
                patch.object(index, "create_agent_fabricator") as mk, \
                patch.object(index, "_write_fabrication_status") as status_write, \
                patch.object(index, "publish_intake_progress"):
            mk.return_value = MagicMock()
            result = index.process_event(
                _base_event(org_id="org-real", org_id_key="org_id"),
                {}, request_type="agent-creation",
            )

        assert result is None
        gate.assert_called_once()
        mk.assert_called_once()
        assert status_write.call_args.kwargs.get("org_id") == "org-real"

    def test_both_keys_missing_refuses_no_fabrication_no_raise(self, caplog):
        with patch.object(index, "check_design_assessment") as gate, \
                patch.object(index, "create_agent_fabricator") as mk_agent, \
                patch.object(index, "_write_fabrication_status") as status_write, \
                patch.object(index, "publish_intake_progress") as progress, \
                patch.object(index, "publish_fabrication_event") as fab_event:
            with caplog.at_level(logging.ERROR):
                result = index.process_event(
                    _base_event(), {}, request_type="agent-creation",
                )

        assert result is None
        gate.assert_not_called()
        mk_agent.assert_not_called()
        status_write.assert_not_called()
        progress.assert_not_called()
        fab_event.assert_not_called()
        assert any(
            "org" in rec.message.lower() for rec in caplog.records
        ), "expected an error-level log naming the missing org_id"

    def test_both_keys_present_prefers_snake_case(self):
        # Defensive: if a message somehow carries both keys, snake_case wins
        # (matches this module's own attribute naming convention).
        with patch.object(index, "check_design_assessment"), \
                patch.object(index, "create_agent_fabricator") as mk, \
                patch.object(index, "_write_fabrication_status") as status_write, \
                patch.object(index, "publish_intake_progress"):
            mk.return_value = MagicMock()
            event = _base_event(org_id="org-snake", org_id_key="org_id")
            event["orgId"] = "org-camel"
            index.process_event(event, {}, request_type="agent-creation")

        assert status_write.call_args.kwargs.get("org_id") == "org-snake"

    def test_empty_snake_case_falls_back_to_camelcase(self):
        # org_id="" (falsy) present alongside a non-empty orgId must still
        # resolve via the `or` fallback rather than refusing.
        with patch.object(index, "check_design_assessment") as gate, \
                patch.object(index, "create_agent_fabricator") as mk, \
                patch.object(index, "_write_fabrication_status") as status_write, \
                patch.object(index, "publish_intake_progress"):
            mk.return_value = MagicMock()
            event = _base_event(org_id="", org_id_key="org_id")
            event["orgId"] = "org-camel"
            result = index.process_event(event, {}, request_type="agent-creation")

        assert result is None
        gate.assert_called_once()
        mk.assert_called_once()
        assert status_write.call_args.kwargs.get("org_id") == "org-camel"
