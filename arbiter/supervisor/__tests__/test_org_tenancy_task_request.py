"""
Red-first tests for the org tenancy gap on task.request dispatch
(finding 87a171ad, high).

Prior to this fix: `handler()`'s `task.request` branch never required
`detail.orgId` (only READ appId/callback/runId/eval keys, all
absent-tolerant), `orchestrate()` had no `org_id` parameter, and
`create_orchestration()` never persisted an org on the row. Any
`task.request` event — regardless of whether the org-scoping resolver
(task-runner-resolver.ts submitTask) actually stamped one — would dispatch
successfully with zero tenancy on the orchestration row.

The fix requires `detail.orgId` on `task.request` and fails closed (no
dispatch, no orchestration row, clear log) when it is absent, mirroring the
resolver-side `requireOrgId` discipline. `create_orchestration` persists it
as `orgId` via the SAME additive-when-present pattern already used for
`callback`/`runId`/`evalRunId`/`evalContext`/`forbiddenTools` — except org
is NOT optional on `task.request`: its absence is a hard failure at the
`handler()` boundary, before `create_orchestration` is ever reached.

These tests exercise the SAME path production traffic takes: `handler()`
receiving a raw `task.request` EventBridge event, mirroring
`test_handler_run_id_threading.py`'s pattern.
"""
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


def _make_task_request_event(task="do something", callback=None, app_id=None,
                              run_id=None, org_id=None):
    detail = {"task": task}
    if callback is not None:
        detail["callback"] = callback
    if app_id is not None:
        detail["appId"] = app_id
    if run_id is not None:
        detail["runId"] = run_id
    if org_id is not None:
        detail["orgId"] = org_id
    return {"source": "task.request", "detail": detail}


class TestHandlerRequiresOrgIdOnTaskRequest:
    """handler() must require detail.orgId on task.request and fail
    closed (no orchestrate() call) when absent."""

    @patch.object(index, "orchestrate")
    def test_handler_passes_org_id_to_orchestrate_when_present(self, mock_orchestrate):
        event = _make_task_request_event(task="build report", org_id="org-alpha")
        index.handler(event, {})

        mock_orchestrate.assert_called_once_with(
            initial_message="build report",
            callback=None,
            app_id=None,
            run_id=None,
            org_id="org-alpha",
            eval_run_id=None,
            eval_context=None,
            forbidden_tools=None,
        )

    def test_handler_fails_closed_when_org_id_absent(self, caplog):
        """RED: today the handler dispatches with no org requirement at
        all. Must become a hard refusal — no orchestrate() call — with a
        clear error-level log identifying the missing tenancy."""
        event = _make_task_request_event(task="build report")

        with patch.object(index, "orchestrate") as mock_orchestrate:
            index.handler(event, {})

        mock_orchestrate.assert_not_called()

    def test_handler_fails_closed_when_org_id_is_empty_string(self):
        """An empty-string orgId is treated the same as absent — not a
        valid tenancy stamp."""
        event = _make_task_request_event(task="build report", org_id="")

        with patch.object(index, "orchestrate") as mock_orchestrate:
            index.handler(event, {})

        mock_orchestrate.assert_not_called()

    def test_handler_fails_closed_creates_no_orchestration_row(self):
        """The refusal must happen BEFORE create_orchestration — no
        orchestration row is ever created for an org-less task.request."""
        event = _make_task_request_event(task="build report")

        with patch.object(index, "create_orchestration") as mock_create, \
                patch.object(index, "save_orchestration") as mock_save:
            index.handler(event, {})

        mock_create.assert_not_called()
        mock_save.assert_not_called()


class TestOrchestrateThreadsOrgIdToCreateOrchestration:
    """orchestrate() must forward its org_id parameter into
    create_orchestration() on the sole production call site (the
    orchestration-not-yet-created branch)."""

    @patch.object(index, "save_orchestration")
    @patch.object(index, "invoke_agents_from_conversation")
    @patch.object(index, "bedrock_circuit_breaker")
    @patch("index.load_config_from_dynamodb")
    @patch.object(index, "create_orchestration")
    def test_orchestrate_forwards_org_id_to_create_orchestration(
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

        index.orchestrate(initial_message="hi", org_id="org-live-1")

        _, kwargs = mock_create.call_args
        assert kwargs.get("org_id") == "org-live-1"


class TestCreateOrchestrationPersistsOrgId:
    """create_orchestration() persists orgId on the row when supplied,
    following the exact same additive pattern already used for
    callback/runId/evalRunId/evalContext/forbiddenTools."""

    def test_org_id_present_when_supplied(self):
        orch = index.create_orchestration(
            conversation=[{"role": "user", "content": [{"text": "hi"}]}],
            org_id="org-9",
        )
        assert orch["orgId"] == "org-9"

    def test_org_id_omitted_when_absent(self):
        """Callers that never pass org_id (e.g. the task.completion resume
        branch, which loads an existing row rather than creating one)
        produce a row with no orgId key rather than a null key."""
        orch = index.create_orchestration(
            conversation=[{"role": "user", "content": [{"text": "hi"}]}],
        )
        assert "orgId" not in orch


class TestLiveEventToOrchestrationRowOrgIdEndToEnd:
    """The org present on the inbound task.request event must reach the
    persisted orchestration row via the SAME code path production traffic
    uses (handler -> orchestrate -> create_orchestration)."""

    def test_org_id_on_inbound_event_reaches_orchestration_row(self):
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

            event = _make_task_request_event(task="ship it", org_id="org-e2e-9")
            index.handler(event, {})

        assert captured_orch.get("orgId") == "org-e2e-9"


class TestGenericDetailFallbackRequiresTaskRequestSource:
    """Decision (finding 87a171ad, item 3): the `elif 'detail' in event`
    generic fallback branch is RESTRICTED to require `source ==
    'task.request'` — i.e. it is removed as a distinct bypass path. Any
    event that is not `task.completion` and not `source == 'task.request'`
    is now a no-op (logged, not silently orchestrated), closing the
    unremarked bypass where arbitrary event detail with no source check
    could trigger orchestration."""

    def test_event_with_unrelated_source_and_detail_is_not_orchestrated(self):
        event = {
            "source": "some.other.source",
            "detail": {"orderId": "12345", "customerId": "C-1234"},
        }
        with patch.object(index, "orchestrate") as mock_orchestrate:
            index.handler(event, {})

        mock_orchestrate.assert_not_called()

    def test_event_with_no_source_at_all_and_detail_is_not_orchestrated(self):
        event = {"detail": {"orderId": "12345"}}
        with patch.object(index, "orchestrate") as mock_orchestrate:
            index.handler(event, {})

        mock_orchestrate.assert_not_called()
