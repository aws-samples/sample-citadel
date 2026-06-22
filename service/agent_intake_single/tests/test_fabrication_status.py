"""
Tests for durable PENDING fabrication-status writes in
service/agent_intake_single/tools/fabricate.py.

confirm_fabrication_plan enqueues each 'build' agent onto SQS and then writes a
PENDING row to the fabrication-jobs table so the queue UI reflects intake-driven
fabrication. The status write is best-effort: a failure must NOT break the
enqueue, and it is skipped entirely when FABRICATION_JOBS_TABLE is unset.

Run with:
    PYTHONPATH=. pytest tests/test_fabrication_status.py -q
from the service/agent_intake_single directory.
"""
import json
import os
import sys
from unittest import mock

import pytest

sys.path.insert(0, os.path.join(os.path.dirname(__file__), ".."))

os.environ.setdefault("FABRICATOR_QUEUE_URL", "https://sqs.fake/queue")

import tools.fabricate as fab


@pytest.fixture(autouse=True)
def _stub_io(monkeypatch):
    # Avoid real S3 / progress side-effects.
    monkeypatch.setattr(fab, "s3_put", lambda *a, **k: None)
    monkeypatch.setattr(fab, "FABRICATOR_QUEUE_URL", "https://sqs.fake/queue")
    monkeypatch.setattr(fab, "sqs", mock.MagicMock())
    # tools.state import inside confirm_fabrication_plan
    state_mod = mock.MagicMock()
    monkeypatch.setitem(sys.modules, "tools.state", state_mod)
    yield


def _plan():
    return json.dumps([
        {"name": "AgentA", "action": "build", "reason": "new", "spec": "spec A"},
        {"name": "AgentB", "action": "build", "reason": "new", "spec": "spec B"},
        {"name": "AgentC", "action": "reuse", "reason": "exists", "spec": "spec C"},
    ])


def test_writes_pending_row_per_build_agent(monkeypatch):
    monkeypatch.setattr(fab, "FABRICATION_JOBS_TABLE", "citadel-fabrication-jobs-test")
    table = mock.MagicMock()
    monkeypatch.setattr(fab.dynamodb, "Table", mock.MagicMock(return_value=table))

    fab.confirm_fabrication_plan("sess-1", _plan())

    # One PutItem per BUILD agent (2), not for reuse.
    assert table.put_item.call_count == 2
    items = [c.kwargs["Item"] for c in table.put_item.call_args_list]
    names = {i["agentUseId"] for i in items}
    assert names == {"AgentA", "AgentB"}
    first = items[0]
    assert first["orchestrationId"] == "sess-1"
    assert first["status"] == "PENDING"
    assert first["requestType"] == "agent-creation"
    assert first["requestedBy"] == "intake"
    assert len(first["taskDescription"]) <= 500
    assert "submittedAt" in first and "updatedAt" in first
    assert isinstance(first["ttl"], int)


def test_status_write_failure_does_not_break_enqueue(monkeypatch):
    monkeypatch.setattr(fab, "FABRICATION_JOBS_TABLE", "citadel-fabrication-jobs-test")
    table = mock.MagicMock()
    table.put_item.side_effect = Exception("ddb down")
    monkeypatch.setattr(fab.dynamodb, "Table", mock.MagicMock(return_value=table))

    # Should not raise; SQS sends still happen for both build agents.
    result = fab.confirm_fabrication_plan("sess-1", _plan())
    assert fab.sqs.send_message.call_count == 2
    assert "AgentA" in result and "AgentB" in result


def test_skips_status_write_when_table_unset(monkeypatch):
    monkeypatch.setattr(fab, "FABRICATION_JOBS_TABLE", "")
    table = mock.MagicMock()
    monkeypatch.setattr(fab.dynamodb, "Table", mock.MagicMock(return_value=table))

    fab.confirm_fabrication_plan("sess-1", _plan())

    assert fab.sqs.send_message.call_count == 2
    table.put_item.assert_not_called()
