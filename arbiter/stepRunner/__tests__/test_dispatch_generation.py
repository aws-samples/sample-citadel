"""Dispatch-generation wiring tests (PR2 fence plumbing).

Covers the path the generation travels: executor.invoke_node increments it in
the same conditional pending->running write and threads the new value onto the
SQS dispatch message -> workflow_contract build/parse -> worker_governance env
-> agent_runner env reader. Each hop is additive/back-compat (absent -> None ->
unfenced reserve).
"""
from __future__ import annotations

import json
import os
import sys

from unittest.mock import MagicMock, patch

sys.path.insert(0, os.path.join(os.path.dirname(__file__), ".."))

from common import workflow_contract  # noqa: E402


class TestContractRoundTrip:
    def test_build_and_parse_dispatch_generation(self):
        msg = workflow_contract.build_node_dispatch_message(
            execution_id="e1", node_id="n1", workflow_id="w1", agent_id="a1",
            dispatch_generation=3,
        )
        assert msg["dispatch_generation"] == 3
        parsed = workflow_contract.parse_node_dispatch_message(msg)
        assert parsed.dispatch_generation == 3

    def test_generation_omitted_when_absent(self):
        msg = workflow_contract.build_node_dispatch_message(
            execution_id="e1", node_id="n1", workflow_id="w1", agent_id="a1",
        )
        assert "dispatch_generation" not in msg
        assert workflow_contract.parse_node_dispatch_message(msg).dispatch_generation is None

    def test_parse_degrades_malformed_generation_to_none(self):
        msg = workflow_contract.build_node_dispatch_message(
            execution_id="e1", node_id="n1", workflow_id="w1", agent_id="a1",
        )
        msg["dispatch_generation"] = "not-an-int"
        assert workflow_contract.parse_node_dispatch_message(msg).dispatch_generation is None
        msg["dispatch_generation"] = True  # bool is not a valid generation
        assert workflow_contract.parse_node_dispatch_message(msg).dispatch_generation is None


class TestSubprocessEnvThreading:
    def test_generation_sets_env_var(self):
        from worker_governance import build_subprocess_env
        env = build_subprocess_env({}, execution_id="e1", node_id="n1", dispatch_generation=2)
        assert env["CITADEL_DISPATCH_GENERATION"] == "2"

    def test_generation_absent_omits_env_var(self):
        from worker_governance import build_subprocess_env
        env = build_subprocess_env({}, execution_id="e1", node_id="n1")
        assert "CITADEL_DISPATCH_GENERATION" not in env

    def test_generation_bool_is_not_serialized(self):
        from worker_governance import build_subprocess_env
        env = build_subprocess_env({}, execution_id="e1", node_id="n1", dispatch_generation=True)
        assert "CITADEL_DISPATCH_GENERATION" not in env


class TestExecutorThreadsGenerationOntoDispatch:
    def test_invoke_node_increments_and_carries_generation(self, monkeypatch):
        import executor

        node = {"id": "n0", "agentId": "agent-A", "data": {}}
        exec_table = MagicMock()
        # UPDATED_NEW response surfaces the post-increment generation.
        exec_table.update_item.return_value = {
            "Attributes": {"nodeResults": {"n0": {"dispatchGeneration": 1}}}
        }
        sqs = MagicMock()
        monkeypatch.setenv("WORKER_QUEUE_URL", "https://sqs/queue")
        with patch.object(executor, "_executions_table", exec_table), \
             patch.object(executor, "_get_sqs_client", lambda: sqs), \
             patch.object(executor, "events", MagicMock()), \
             patch.object(executor.tracing, "active_trace_context", lambda: None):
            executor.invoke_node("exec1", "wf1", node, {}, {})

        # The conditional dispatch write increments the per-node generation.
        upd = exec_table.update_item.call_args.kwargs
        assert " ADD " in upd["UpdateExpression"]
        assert upd["ExpressionAttributeNames"]["#gen"] == "dispatchGeneration"
        assert upd["ExpressionAttributeValues"][":one"] == 1
        assert upd["ReturnValues"] == "UPDATED_NEW"
        # The dispatched SQS message carries the new generation.
        body = json.loads(sqs.send_message.call_args.kwargs["MessageBody"])
        assert body["dispatch_generation"] == 1

    def test_unparseable_generation_response_omits_it(self, monkeypatch):
        import executor

        node = {"id": "n0", "agentId": "agent-A", "data": {}}
        exec_table = MagicMock()  # default MagicMock response — no real Attributes
        sqs = MagicMock()
        monkeypatch.setenv("WORKER_QUEUE_URL", "https://sqs/queue")
        with patch.object(executor, "_executions_table", exec_table), \
             patch.object(executor, "_get_sqs_client", lambda: sqs), \
             patch.object(executor, "events", MagicMock()), \
             patch.object(executor.tracing, "active_trace_context", lambda: None):
            executor.invoke_node("exec1", "wf1", node, {}, {})
        body = json.loads(sqs.send_message.call_args.kwargs["MessageBody"])
        assert "dispatch_generation" not in body  # back-compat: unfenced dispatch


class TestAgentRunnerGenerationReader:
    def test_reads_int(self, monkeypatch):
        sys.path.insert(0, os.path.join(os.path.dirname(__file__), "..", "..", "workerWrapper"))
        import agent_runner
        monkeypatch.setenv("CITADEL_DISPATCH_GENERATION", "5")
        assert agent_runner._read_dispatch_generation() == 5

    def test_absent_or_invalid_is_none(self, monkeypatch):
        sys.path.insert(0, os.path.join(os.path.dirname(__file__), "..", "..", "workerWrapper"))
        import agent_runner
        monkeypatch.delenv("CITADEL_DISPATCH_GENERATION", raising=False)
        assert agent_runner._read_dispatch_generation() is None
        monkeypatch.setenv("CITADEL_DISPATCH_GENERATION", "nope")
        assert agent_runner._read_dispatch_generation() is None
