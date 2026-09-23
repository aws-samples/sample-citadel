"""Correlation-id-on-dispatch wiring tests.

Root cause: worker citadel.execution spans (execution_trace_scope in
workerWrapper/index.py._process_workflow_node) carried an EMPTY
correlation_id while StepRunner spans populated it. The NodeDispatchMessage
contract (build/parse) already supported correlation_id end to end; the gap
was that executor.invoke_node's build_node_dispatch_message call never
passed it. Fixed by threading ``run_id or execution_id`` — the SAME fallback
the step runner's own event-handler span already applies (index.py:
``detail.get('correlationId') or detail.get('executionId')``) — onto the
dispatch message, so the worker's execution_trace_scope always receives a
non-empty correlation_id.
"""
from __future__ import annotations

import json
import os
import sys

from unittest.mock import MagicMock, patch

sys.path.insert(0, os.path.join(os.path.dirname(__file__), ".."))

from common import workflow_contract  # noqa: E402


class TestContractRoundTrip:
    def test_build_and_parse_correlation_id(self):
        msg = workflow_contract.build_node_dispatch_message(
            execution_id="e1", node_id="n1", workflow_id="w1", agent_id="a1",
            correlation_id="corr-123",
        )
        assert msg["correlation_id"] == "corr-123"
        parsed = workflow_contract.parse_node_dispatch_message(msg)
        assert parsed.correlation_id == "corr-123"

    def test_correlation_id_omitted_when_absent(self):
        msg = workflow_contract.build_node_dispatch_message(
            execution_id="e1", node_id="n1", workflow_id="w1", agent_id="a1",
        )
        assert "correlation_id" not in msg
        assert workflow_contract.parse_node_dispatch_message(msg).correlation_id is None


class TestExecutorThreadsCorrelationIdOntoDispatch:
    def _invoke(self, monkeypatch, *, run_id=None):
        import executor

        node = {"id": "n0", "agentId": "agent-A", "data": {}}
        exec_table = MagicMock()
        exec_table.update_item.return_value = {
            "Attributes": {"nodeResults": {"n0": {"dispatchGeneration": 1}}}
        }
        sqs = MagicMock()
        monkeypatch.setenv("WORKER_QUEUE_URL", "https://sqs/queue")
        with patch.object(executor, "_executions_table", exec_table), \
             patch.object(executor, "_get_sqs_client", lambda: sqs), \
             patch.object(executor, "events", MagicMock()), \
             patch.object(executor.tracing, "active_trace_context", lambda: None):
            executor.invoke_node("exec1", "wf1", node, {}, {}, run_id=run_id)
        return json.loads(sqs.send_message.call_args.kwargs["MessageBody"])

    def test_dispatch_carries_run_id_as_correlation_id(self, monkeypatch):
        body = self._invoke(monkeypatch, run_id="run-xyz")
        assert body["correlation_id"] == "run-xyz"
        assert body["runId"] == "run-xyz"

    def test_dispatch_falls_back_to_execution_id_when_run_id_absent(self, monkeypatch):
        body = self._invoke(monkeypatch, run_id=None)
        assert body["correlation_id"] == "exec1"
        assert "runId" not in body


class TestWorkerReceivesCorrelationId:
    def test_worker_scope_receives_correlation_id_from_dispatch(self, monkeypatch):
        """The worker's execution_trace_scope call in
        _process_workflow_node must receive the correlation_id carried on
        the parsed NodeDispatchMessage — never empty when the dispatch
        message carried one (mirrors the run_id/execution_id fallback
        applied at dispatch time above)."""
        sys.path.insert(
            0, os.path.join(os.path.dirname(__file__), "..", "..", "workerWrapper")
        )
        import index as worker_index

        dispatch_msg = workflow_contract.build_node_dispatch_message(
            execution_id="exec1", node_id="n0", workflow_id="wf1", agent_id="agent-A",
            correlation_id="exec1",
        )

        captured = {}

        class _CaptureScope:
            def __init__(self, **kwargs):
                captured.update(kwargs)

            def __enter__(self):
                return self

            def __exit__(self, exc_type, exc_val, exc_tb):
                return None

        with patch.object(worker_index, "execution_trace_scope", _CaptureScope), \
             patch.object(worker_index, "load_config_from_dynamodb",
                           side_effect=RuntimeError("stop after scope entry")):
            try:
                worker_index._process_workflow_node(dispatch_msg)
            except RuntimeError:
                pass

        assert captured.get("correlation_id") == "exec1"
