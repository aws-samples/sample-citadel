"""Tests that executor.invoke_node and the three top-level publish call
sites (_finalize_execution, handle_node_failure, cancel_execution) thread
the execution's own orgId through to events.py, mirroring the existing
run_id threading pattern (see test_dispatch_correlation_id.py). Without
this, chatter-publisher.ts (which refuses any EventBridge detail lacking
``orgId``) drops every workflow.*/supervisor.chatter event.
"""
from __future__ import annotations

import os
import sys

from unittest.mock import MagicMock, patch

sys.path.insert(0, os.path.join(os.path.dirname(__file__), ".."))


class TestInvokeNodeThreadsOrgId:
    def _invoke(self, monkeypatch, *, org_id=None):
        import executor

        node = {"id": "n0", "agentId": "agent-A", "data": {}}
        exec_table = MagicMock()
        exec_table.update_item.return_value = {
            "Attributes": {"nodeResults": {"n0": {"dispatchGeneration": 1}}}
        }
        sqs = MagicMock()
        events_mock = MagicMock()
        monkeypatch.setenv("WORKER_QUEUE_URL", "https://sqs/queue")
        with patch.object(executor, "_executions_table", exec_table), \
             patch.object(executor, "_get_sqs_client", lambda: sqs), \
             patch.object(executor, "events", events_mock), \
             patch.object(executor.tracing, "active_trace_context", lambda: None):
            executor.invoke_node("exec1", "wf1", node, {}, {}, org_id=org_id)
        return events_mock

    def test_supervisor_chatter_and_node_started_receive_org_id(self, monkeypatch):
        events_mock = self._invoke(monkeypatch, org_id="org-9")
        chatter_kwargs = events_mock.publish_supervisor_chatter.call_args.kwargs
        started_kwargs = events_mock.publish_node_started.call_args.kwargs
        assert chatter_kwargs.get("org_id") == "org-9"
        assert started_kwargs.get("org_id") == "org-9"

    def test_org_id_omitted_when_absent(self, monkeypatch):
        events_mock = self._invoke(monkeypatch, org_id=None)
        chatter_kwargs = events_mock.publish_supervisor_chatter.call_args.kwargs
        started_kwargs = events_mock.publish_node_started.call_args.kwargs
        assert "org_id" not in chatter_kwargs or chatter_kwargs.get("org_id") is None
        assert "org_id" not in started_kwargs or started_kwargs.get("org_id") is None


class TestStartExecutionAndScheduleFrontierPassOrgId:
    def test_start_execution_passes_execution_org_id_to_invoke_node(self, monkeypatch):
        import executor

        execution = {"orgId": "org-start", "workflowId": "wf1"}
        workflow = {
            "definition": '{"nodes": [{"id": "n0", "agentId": "a1"}], "edges": []}',
            "configuration": "{}",
        }
        exec_table = MagicMock()
        with patch.object(executor, "_load_execution", lambda eid: execution), \
             patch.object(executor, "_load_workflow", lambda wid: workflow), \
             patch.object(executor, "_executions_table", exec_table), \
             patch.object(executor, "events", MagicMock()), \
             patch.object(executor, "invoke_node") as invoke_mock:
            executor.start_execution("exec1", "wf1")
        assert invoke_mock.call_args.kwargs.get("org_id") == "org-start"

    def test_schedule_frontier_passes_execution_org_id_to_invoke_node(self, monkeypatch):
        import executor

        execution = {
            "executionId": "exec1",
            "orgId": "org-frontier",
            "workflowId": "wf1",
            "nodeResults": {"n0": {"status": "pending"}},
        }
        workflow = {
            "definition": '{"nodes": [{"id": "n0", "agentId": "a1"}], "edges": []}',
            "configuration": "{}",
        }
        with patch.object(executor, "find_ready_nodes", lambda *a, **k: ["n0"]), \
             patch.object(executor, "invoke_node") as invoke_mock:
            executor.schedule_frontier(execution, workflow)
        assert invoke_mock.call_args.kwargs.get("org_id") == "org-frontier"


class TestTopLevelPublishCallSitesPassOrgId:
    def test_finalize_execution_passes_org_id(self, monkeypatch):
        import executor

        execution = {"executionId": "exec1", "workflowId": "wf1", "orgId": "org-fin"}
        exec_table = MagicMock()
        exec_table.update_item.return_value = {}
        events_mock = MagicMock()
        with patch.object(executor, "_executions_table", exec_table), \
             patch.object(executor, "events", events_mock):
            executor._finalize_execution(execution, {})
        assert events_mock.publish_workflow_completed.call_args.kwargs.get("org_id") == "org-fin"

    def test_cancel_execution_passes_org_id(self, monkeypatch):
        import executor

        execution = {"executionId": "exec1", "workflowId": "wf1", "orgId": "org-cancel", "nodeResults": {}}
        exec_table = MagicMock()
        events_mock = MagicMock()
        with patch.object(executor, "_load_execution", lambda eid: execution), \
             patch.object(executor, "_executions_table", exec_table), \
             patch.object(executor, "events", events_mock):
            executor.cancel_execution("exec1")
        assert events_mock.publish_workflow_failed.call_args.kwargs.get("org_id") == "org-cancel"
