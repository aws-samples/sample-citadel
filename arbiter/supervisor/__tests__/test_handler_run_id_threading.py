"""
Red-first tests for the production run_id threading gap flagged by verify-p1
(NEEDS_CHANGES item 1, decision f1cbd5ef Pass 1).

Prior to this fix: `handler()`'s `task.request` branch never extracted
`detail.runId`; `orchestrate()` had no `run_id` parameter; and the sole
production `create_orchestration` call site (inside `orchestrate()`) passed
none. Orchestration rows therefore never carried `runId` on the live event
path, and `finding.run_id` was always `None` in production even though
`create_orchestration(run_id=...)` and the best-effort stamp worked when
called directly in unit tests.

These tests exercise the SAME path production traffic takes: `handler()`
receiving a raw `task.request` EventBridge event, mirroring
`test_supervisor_app_id.py`'s `TestHandlerExtractsAppId` pattern used for
the analogous `appId` threading.
"""
import os
import sys
from unittest.mock import MagicMock, patch

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


def _make_task_request_event(task="do something", callback=None, app_id=None, run_id=None):
    detail = {"task": task}
    if callback is not None:
        detail["callback"] = callback
    if app_id is not None:
        detail["appId"] = app_id
    if run_id is not None:
        detail["runId"] = run_id
    return {"source": "task.request", "detail": detail}


class TestHandlerExtractsRunId:
    """handler() must extract detail.runId (when a server-minted value was
    placed there by an upstream entry point, e.g. task-runner-resolver.ts
    submitTask) and pass it through to orchestrate()."""

    @patch.object(index, "orchestrate")
    def test_handler_passes_run_id_to_orchestrate(self, mock_orchestrate):
        event = _make_task_request_event(task="build report", run_id="run-abc-123")
        index.handler(event, {})

        mock_orchestrate.assert_called_once_with(
            initial_message="build report",
            callback=None,
            app_id=None,
            run_id="run-abc-123",
        )

    @patch.object(index, "orchestrate")
    def test_handler_passes_none_when_no_run_id_present(self, mock_orchestrate):
        """Additive/nullable: absence of detail.runId must not raise or
        default to a sentinel other than None."""
        event = _make_task_request_event(task="build report")
        index.handler(event, {})

        mock_orchestrate.assert_called_once_with(
            initial_message="build report",
            callback=None,
            app_id=None,
            run_id=None,
        )


class TestOrchestrateThreadsRunIdToCreateOrchestration:
    """orchestrate() must forward its run_id parameter into
    create_orchestration() on the sole production call site (the
    orchestration-not-yet-created branch)."""

    @patch.object(index, "save_orchestration")
    @patch.object(index, "invoke_agents_from_conversation")
    @patch.object(index, "bedrock_circuit_breaker")
    @patch("index.load_config_from_dynamodb")
    @patch.object(index, "create_orchestration")
    def test_orchestrate_forwards_run_id_to_create_orchestration(
        self, mock_create, mock_load_global, mock_breaker, mock_invoke, mock_save
    ):
        mock_create.return_value = {
            "orchestrationId": "orch-1",
            "conversation": [{"role": "user", "content": [{"text": "hi"}]}],
        }
        mock_load_global.return_value = {
            "agents": [{"name": "agent1", "description": "test", "schema": {}}]
        }
        mock_breaker.call.return_value = {
            "output": {"message": {"role": "assistant", "content": [{"text": "ok"}]}}
        }

        index.orchestrate(initial_message="hi", run_id="run-live-1")

        _, kwargs = mock_create.call_args
        assert kwargs.get("run_id") == "run-live-1"

    @patch.object(index, "save_orchestration")
    @patch.object(index, "invoke_agents_from_conversation")
    @patch.object(index, "bedrock_circuit_breaker")
    @patch("index.load_config_from_dynamodb")
    @patch.object(index, "create_orchestration")
    def test_orchestrate_forwards_none_when_run_id_absent(
        self, mock_create, mock_load_global, mock_breaker, mock_invoke, mock_save
    ):
        """Additive/nullable: no run_id passed at all must not break the
        existing no-runId callers (fallback path, task.completion resume,
        generic-detail fallback)."""
        mock_create.return_value = {
            "orchestrationId": "orch-2",
            "conversation": [{"role": "user", "content": [{"text": "hi"}]}],
        }
        mock_load_global.return_value = {
            "agents": [{"name": "agent1", "description": "test", "schema": {}}]
        }
        mock_breaker.call.return_value = {
            "output": {"message": {"role": "assistant", "content": [{"text": "ok"}]}}
        }

        index.orchestrate(initial_message="hi")

        _, kwargs = mock_create.call_args
        assert kwargs.get("run_id") is None


class TestLiveEventToFindingRunIdEndToEnd:
    """The regression the review caught: a runId present on the inbound
    task.request event must reach the persisted orchestration row via the
    SAME code path production traffic uses (handler -> orchestrate ->
    create_orchestration), not just via a direct create_orchestration(...)
    call in a unit test."""

    def test_run_id_on_inbound_event_reaches_orchestration_row(self):
        captured_orch = {}
        real_create_orchestration = index.create_orchestration

        def _spy_create_orchestration(*args, **kwargs):
            orch = real_create_orchestration(*args, **kwargs)
            captured_orch.update(orch)
            return orch

        with patch.object(index, "save_orchestration"), \
             patch.object(index, "invoke_agents_from_conversation"), \
             patch.object(index, "bedrock_circuit_breaker") as mock_breaker, \
             patch("index.load_config_from_dynamodb") as mock_load_global, \
             patch.object(index, "create_orchestration", side_effect=_spy_create_orchestration):

            mock_load_global.return_value = {
                "agents": [{"name": "agent1", "description": "test", "schema": {}}]
            }
            mock_breaker.call.return_value = {
                "output": {"message": {"role": "assistant", "content": [{"text": "ok"}]}}
            }

            event = _make_task_request_event(task="ship it", run_id="run-e2e-9")
            index.handler(event, {})

        assert captured_orch.get("runId") == "run-e2e-9"
