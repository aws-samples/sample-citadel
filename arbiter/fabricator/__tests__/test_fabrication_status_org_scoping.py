"""
Cross-tenant exposure fix (design evidence bf4a13f2, fabricator-queue
section) — org_id stamping tests for the arbiter's fabrication-status
writer.

process_event must thread the SQS event's org_id through to every
_write_fabrication_status call (PROCESSING, COMPLETED, and every FAILED
path), and _write_fabrication_status itself must stamp orgId onto the row
with if_not_exists semantics so it never clobbers a producer-set orgId
(e.g. the direct-UI PENDING write).
"""

import sys
import os
from unittest.mock import patch, MagicMock

sys.path.insert(0, os.path.join(os.path.dirname(__file__), ".."))

os.environ.setdefault("TOOL_CONFIG_TABLE", "fake-tool-table")
os.environ.setdefault("AGENT_CONFIG_TABLE", "fake-agent-table")
os.environ.setdefault("AGENT_BUCKET_NAME", "fake-bucket")
os.environ.setdefault("COMPLETION_BUS_NAME", "fake-bus")
os.environ.setdefault("WORKER_QUEUE_URL", "https://sqs.fake/queue")

import index


def _base_event(org_id=None):
    event = {
        "orchestration_id": "sess-1",
        "agent_use_id": "MyAgent",
        "node": "fabricator",
        "agent_input": {"taskDetails": "Create an agent that does things"},
        "agent_index": 0,
        "total_agents": 1,
    }
    if org_id is not None:
        event["org_id"] = org_id
    return event


class TestOrgIdThreadedThroughProcessEvent:
    def setup_method(self):
        os.environ["FABRICATION_JOBS_TABLE"] = "citadel-fabrication-jobs-test"

    def teardown_method(self):
        os.environ.pop("FABRICATION_JOBS_TABLE", None)

    def test_org_id_from_event_reaches_every_status_write_on_success(self):
        calls = []

        def record(orchestration_id, agent_use_id, status, **kwargs):
            calls.append((status, kwargs))

        with patch.object(index, "_write_fabrication_status", side_effect=record), \
                patch.object(index, "check_design_assessment"), \
                patch.object(index, "create_agent_fabricator") as mk, \
                patch.object(index, "publish_intake_progress"):
            mk.return_value = MagicMock()
            index.process_event(_base_event(org_id="org-caller"), {}, request_type="agent-creation")

        assert len(calls) >= 2
        for status, kwargs in calls:
            assert kwargs.get("org_id") == "org-caller", (
                f"status={status} write did not receive org_id"
            )

    def test_org_id_from_event_reaches_the_failed_write_on_exception(self):
        calls = []

        def record(orchestration_id, agent_use_id, status, **kwargs):
            calls.append((status, kwargs))

        boom = RuntimeError("fabrication blew up")
        with patch.object(index, "_write_fabrication_status", side_effect=record), \
                patch.object(index, "check_design_assessment"), \
                patch.object(index, "create_agent_fabricator") as mk, \
                patch.object(index, "publish_intake_progress"), \
                patch.object(index, "publish_fabrication_event"):
            agent = MagicMock(side_effect=boom)
            mk.return_value = agent
            try:
                index.process_event(_base_event(org_id="org-caller"), {}, request_type="agent-creation")
            except RuntimeError:
                pass

        failed_calls = [kw for s, kw in calls if s == "FAILED"]
        assert failed_calls, "expected at least one FAILED status write"
        for kwargs in failed_calls:
            assert kwargs.get("org_id") == "org-caller"

    def test_missing_org_id_on_event_defaults_to_empty_and_is_not_stamped(self):
        # Mirrors the existing '' fallback convention (Phase 2b) — absent
        # org_id must not block fabrication, and must not write a blank
        # orgId attribute onto the row (verified at the lower level below).
        calls = []

        def record(orchestration_id, agent_use_id, status, **kwargs):
            calls.append((status, kwargs))

        with patch.object(index, "_write_fabrication_status", side_effect=record), \
                patch.object(index, "check_design_assessment"), \
                patch.object(index, "create_agent_fabricator") as mk, \
                patch.object(index, "publish_intake_progress"):
            mk.return_value = MagicMock()
            index.process_event(_base_event(), {}, request_type="agent-creation")

        for status, kwargs in calls:
            assert kwargs.get("org_id") == ""


class TestWriteFabricationStatusStampsOrgIdWithIfNotExists:
    """Lower-level: _write_fabrication_status's actual UpdateExpression."""

    def setup_method(self):
        os.environ["FABRICATION_JOBS_TABLE"] = "citadel-fabrication-jobs-test"

    def teardown_method(self):
        os.environ.pop("FABRICATION_JOBS_TABLE", None)

    def test_org_id_written_with_if_not_exists_semantics(self):
        captured = {}

        class FakeDynamoClient:
            def update_item(self, **kwargs):
                captured.update(kwargs)
                return {}

        with patch.object(index.boto3, "client", return_value=FakeDynamoClient()):
            index._write_fabrication_status(
                "sess-1", "AgentX", "PROCESSING", agent_name="AgentX", org_id="org-a",
            )

        assert "orgId = if_not_exists(orgId, :orgId)" in captured["UpdateExpression"]
        assert captured["ExpressionAttributeValues"][":orgId"] == {"S": "org-a"}

    def test_no_org_id_attribute_written_when_org_id_is_empty(self):
        captured = {}

        class FakeDynamoClient:
            def update_item(self, **kwargs):
                captured.update(kwargs)
                return {}

        with patch.object(index.boto3, "client", return_value=FakeDynamoClient()):
            index._write_fabrication_status(
                "sess-1", "AgentX", "PROCESSING", agent_name="AgentX", org_id="",
            )

        assert "orgId" not in captured["UpdateExpression"]
        assert ":orgId" not in captured["ExpressionAttributeValues"]

    def test_no_org_id_attribute_written_when_org_id_omitted(self):
        captured = {}

        class FakeDynamoClient:
            def update_item(self, **kwargs):
                captured.update(kwargs)
                return {}

        with patch.object(index.boto3, "client", return_value=FakeDynamoClient()):
            index._write_fabrication_status(
                "sess-1", "AgentX", "PROCESSING", agent_name="AgentX",
            )

        assert "orgId" not in captured["UpdateExpression"]
        assert ":orgId" not in captured["ExpressionAttributeValues"]
