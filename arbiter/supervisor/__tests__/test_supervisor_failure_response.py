"""Failure reporting for supervisor orchestrations.

Incident: an exception raised while orchestrating (e.g. a KeyError from the
agent-config scan) left the caller with no signal at all. The handler had
already claimed the EventBridge event id, so the retry was deduped, and no
task.response and no orchestration record were ever written.

Contract under test:
  - Any exception raised during an orchestration publishes a task.response
    with status 'failed', the error class/message, the orchestrationId, the
    runId and the orgId (Source stays SUPERVISOR_RESPONSE_SOURCE).
  - The orchestration row is written with status 'failed' and the error.
  - The original exception is re-raised so Lambda Errors still count.
  - The idempotency claim is NOT released.
  - A failure inside the failure reporting never masks the original error.
  - The success-path task.response shape is unchanged (no extra keys).
"""
from __future__ import annotations

import json
import os
import sys
from unittest.mock import MagicMock, patch

import pytest

sys.path.insert(0, os.path.join(os.path.dirname(__file__), ".."))

os.environ.setdefault("AGENT_CONFIG_TABLE", "fake-table")
os.environ.setdefault("EVENT_BUS_NAME", "fake-bus")
os.environ.setdefault("ORCHESTRATION_TABLE", "fake-orch-table")
os.environ.setdefault("WORKER_STATE_TABLE", "fake-worker-table")
os.environ.setdefault("APPS_TABLE", "fake-apps-table")

_mock_dynamodb = MagicMock()
_mock_sqs = MagicMock()
_mock_bedrock = MagicMock()
_mock_events = MagicMock()

with patch.multiple(
    "boto3",
    resource=MagicMock(return_value=_mock_dynamodb),
    client=MagicMock(side_effect=lambda svc, **kw: {
        "sqs": _mock_sqs,
        "bedrock-runtime": _mock_bedrock,
        "events": _mock_events,
    }.get(svc, MagicMock())),
):
    import index


ORG = "org-failure-test"
CALLBACK = {"type": "eventbridge"}


def _event(event_id="evt-fail-1", run_id="run-123", callback=CALLBACK):
    detail = {"task": "do the thing", "orgId": ORG, "runId": run_id}
    if callback is not None:
        detail["callback"] = callback
    return {"id": event_id, "source": "task.request", "detail": detail}


def _published_details(mock_events):
    out = []
    for call in mock_events.put_events.call_args_list:
        for entry in call.kwargs["Entries"]:
            out.append((entry, json.loads(entry["Detail"])))
    return out


@pytest.fixture
def harness():
    """Patch every collaborator the handler touches; scan raises RuntimeError."""
    idem_table = MagicMock()
    with patch.object(index, "events_client") as events, \
            patch.object(index, "save_orchestration") as save, \
            patch.object(index, "_idempotency_table", return_value=idem_table), \
            patch.object(index, "_resolve_orchestration_org_id", return_value=""), \
            patch.object(
                index, "load_config_from_dynamodb",
                side_effect=RuntimeError("scan exploded"),
            ):
        yield {"events": events, "save": save, "idem": idem_table}


class TestFailureIsReportedToCaller:
    def test_exception_is_reraised_so_lambda_errors_count(self, harness):
        with pytest.raises(RuntimeError, match="scan exploded"):
            index.handler(_event(), {})

    def test_failed_task_response_is_published_with_error_details(self, harness):
        with pytest.raises(RuntimeError):
            index.handler(_event(), {})

        published = _published_details(harness["events"])
        assert len(published) == 1
        entry, detail = published[0]
        assert entry["Source"] == index.SUPERVISOR_RESPONSE_SOURCE
        assert entry["DetailType"] == "task.response"
        assert entry["EventBusName"] == index.EVENT_BUS_NAME
        assert detail["status"] == "failed"
        assert detail["error"]["type"] == "RuntimeError"
        assert "scan exploded" in detail["error"]["message"]
        assert detail["orgId"] == ORG
        assert detail["runId"] == "run-123"
        assert detail["callback"] == CALLBACK

    def test_published_orchestration_id_matches_the_saved_record(self, harness):
        with pytest.raises(RuntimeError):
            index.handler(_event(), {})

        _, detail = _published_details(harness["events"])[0]
        saved = harness["save"].call_args.kwargs["orchestration"]
        assert detail["orchestrationId"] == saved["orchestrationId"]

    def test_orchestration_record_written_with_failed_status_and_error(self, harness):
        with pytest.raises(RuntimeError):
            index.handler(_event(), {})

        harness["save"].assert_called_once()
        saved = harness["save"].call_args.kwargs["orchestration"]
        assert saved["status"] == "failed"
        assert saved["error"]["type"] == "RuntimeError"
        assert "scan exploded" in saved["error"]["message"]
        assert saved["orgId"] == ORG
        assert saved["runId"] == "run-123"

    def test_failure_without_callback_publishes_to_platform_bus(self, harness):
        with pytest.raises(RuntimeError):
            index.handler(_event(callback=None), {})

        published = _published_details(harness["events"])
        assert len(published) == 1
        entry, detail = published[0]
        assert entry["EventBusName"] == index.EVENT_BUS_NAME
        assert detail["status"] == "failed"
        assert "callback" not in detail

    def test_idempotency_claim_is_not_released(self, harness):
        with pytest.raises(RuntimeError):
            index.handler(_event(), {})

        idem = harness["idem"]
        idem.put_item.assert_called_once()
        idem.delete_item.assert_not_called()
        idem.update_item.assert_not_called()

    def test_long_error_message_is_truncated(self, harness):
        index.load_config_from_dynamodb.side_effect = RuntimeError("x" * 5000)
        with pytest.raises(RuntimeError):
            index.handler(_event(), {})

        _, detail = _published_details(harness["events"])[0]
        assert len(detail["error"]["message"]) <= 500

    def test_task_completion_resume_failure_is_also_reported(self, harness):
        orchestration = {
            "orchestrationId": "orch-resume-1",
            "orgId": ORG,
            "runId": "run-resume",
            "conversation": [{"role": "user", "content": [{"text": "hi"}]}],
        }
        with pytest.raises(RuntimeError):
            index.orchestrate(orchestration=orchestration)

        _, detail = _published_details(harness["events"])[0]
        assert detail["status"] == "failed"
        assert detail["orchestrationId"] == "orch-resume-1"
        assert detail["runId"] == "run-resume"
        assert detail["orgId"] == ORG
        assert orchestration["status"] == "failed"


class TestFailureReportingNeverMasksTheOriginalError:
    def test_save_failure_still_publishes_and_raises_original(self, harness):
        harness["save"].side_effect = ValueError("ddb put failed")
        with pytest.raises(RuntimeError, match="scan exploded"):
            index.handler(_event(), {})

        assert len(_published_details(harness["events"])) == 1

    def test_publish_failure_still_saves_and_raises_original(self, harness):
        harness["events"].put_events.side_effect = ValueError("bus down")
        with pytest.raises(RuntimeError, match="scan exploded"):
            index.handler(_event(), {})

        harness["save"].assert_called_once()


class TestSuccessPathResponseShapeUnchanged:
    def test_send_response_without_failure_args_adds_no_status_keys(self):
        with patch.object(index, "events_client") as events:
            index.send_response("hello", callback=CALLBACK, org_id=ORG)

        _, detail = _published_details(events)[0]
        for key in ("status", "error", "orchestrationId", "runId"):
            assert key not in detail
