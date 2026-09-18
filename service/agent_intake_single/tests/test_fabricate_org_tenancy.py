"""Tests for org-tenancy enforcement in tools/fabricate.py.

Contract:
- _send_to_fabricator resolves org_id = _resolve_session_organization(
  session_id) BEFORE sqs.send_message.
- If org_id is falsy: log at error, raise, and NEVER call sqs.send_message
  (no partial/untenanted enqueue).
- If org_id resolves: the SQS MessageBody JSON carries "org_id": org_id.
- retry_failed_fabrication re-queues via the same _send_to_fabricator path,
  so a resolved org_id must also land in the retry-path MessageBody.

Run with:
    .venv-arbiter-test/bin/python -m pytest \
        service/agent_intake_single/tests/test_fabricate_org_tenancy.py -q
from the repo root.
"""
import json
import os
import sys
from unittest import mock

import pytest

sys.path.insert(0, os.path.join(os.path.dirname(__file__), ".."))

os.environ.setdefault("FABRICATOR_QUEUE_URL", "https://sqs.fake/queue")

import tools.fabricate as fab


@pytest.fixture
def fab_env(monkeypatch):
    monkeypatch.setattr(fab, "sqs", mock.MagicMock())
    monkeypatch.setattr(fab, "FABRICATOR_QUEUE_URL", "https://sqs.fake/queue")
    monkeypatch.setattr(fab, "FABRICATION_JOBS_TABLE", None)
    # _write_pending_fabrication_status is best-effort/unrelated to this
    # contract; no-op it so tests only assert on the tenancy behavior.
    monkeypatch.setattr(fab, "_write_pending_fabrication_status", lambda *a, **k: None)
    return fab


def _sent_bodies():
    return [json.loads(c.kwargs["MessageBody"])
            for c in fab.sqs.send_message.call_args_list]


def test_send_to_fabricator_body_carries_org_id(fab_env, monkeypatch):
    monkeypatch.setattr(fab, "_resolve_session_organization", lambda session_id: "org-123")

    fab._send_to_fabricator("sess-1", {"name": "AgentA", "spec": "spec-a"})

    fab.sqs.send_message.assert_called_once()
    body = _sent_bodies()[0]
    assert body["org_id"] == "org-123"
    assert body["agent_use_id"] == "AgentA"


def test_send_to_fabricator_raises_and_does_not_enqueue_when_org_unresolvable(fab_env, monkeypatch):
    monkeypatch.setattr(fab, "_resolve_session_organization", lambda session_id: None)

    with pytest.raises(Exception, match=r"cannot fabricate: no organisation resolved for session sess-2"):
        fab._send_to_fabricator("sess-2", {"name": "AgentB", "spec": "spec-b"})

    fab.sqs.send_message.assert_not_called()


def test_send_to_fabricator_raises_on_empty_string_org(fab_env, monkeypatch):
    monkeypatch.setattr(fab, "_resolve_session_organization", lambda session_id: "")

    with pytest.raises(Exception, match=r"cannot fabricate: no organisation resolved for session sess-3"):
        fab._send_to_fabricator("sess-3", {"name": "AgentC", "spec": "spec-c"})

    fab.sqs.send_message.assert_not_called()


def test_retry_failed_fabrication_body_carries_org_id(fab_env, monkeypatch):
    monkeypatch.setattr(fab, "_resolve_session_organization", lambda session_id: "org-999")

    table = mock.MagicMock()
    ddb = mock.MagicMock()
    ddb.Table.return_value = table
    monkeypatch.setattr(fab, "dynamodb", ddb)
    monkeypatch.setattr(fab, "FABRICATION_JOBS_TABLE", "jobs-test")

    plan_md = (
        "# Fabrication Plan\n\n"
        "## Agents to Build\n\n"
        "### AgentD\nspec: agent-d\n"
    )
    monkeypatch.setattr(fab, "s3_get", lambda key: plan_md)

    table.query.return_value = {
        "Items": [
            {
                "orchestrationId": "sess-4", "agentUseId": "AgentD",
                "agentName": "AgentD", "status": "FAILED",
                "updatedAt": "2026-07-19T04:31:03.885692Z",
            },
        ],
    }

    result = json.loads(fab.retry_failed_fabrication(session_id="sess-4"))

    assert result["ok"] is True
    fab.sqs.send_message.assert_called_once()
    body = _sent_bodies()[0]
    assert body["org_id"] == "org-999"
    assert body["agent_use_id"] == "AgentD"
