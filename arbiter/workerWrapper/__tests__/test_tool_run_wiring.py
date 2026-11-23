"""RED/GREEN tests for the index.py wiring of the governed tool-run request:

- process_event discriminates a {kind:'tool-run'} message BEFORE falling
  through to the supervisor-task path.
- lambda_handler's direct-invoke branch: an event with no 'Records' key and
  kind == 'tool-run' calls tool_run_handler.process_tool_run and returns its
  result directly (RequestResponse), instead of draining event['Records'].
- The existing SQS batch path (event['Records']) is completely unaffected.
"""
from __future__ import annotations

import sys
import os
from unittest.mock import patch

sys.path.insert(0, os.path.join(os.path.dirname(__file__), ".."))

import index  # noqa: E402
import tool_run_handler  # noqa: E402


class TestProcessEventToolRunDiscriminator:
    def test_tool_run_message_dispatches_to_process_tool_run(self):
        event = {"kind": "tool-run", "toolId": "t1", "runId": "r1", "orgId": "o1", "inputs": {}}
        with patch.object(tool_run_handler, "process_tool_run", return_value={"runId": "r1", "status": "success", "output": {}, "durationMs": 1}) as mocked:
            result = index.process_event(event, context=None)
        mocked.assert_called_once_with(event)
        assert result == {"runId": "r1", "status": "success", "output": {}, "durationMs": 1}

    def test_non_tool_run_message_does_not_call_process_tool_run(self):
        with patch.object(tool_run_handler, "process_tool_run") as mocked:
            with patch.object(index, "workflow_contract", None):
                try:
                    index.process_event({"orchestration_id": "x"}, context=None)
                except Exception:
                    pass
        mocked.assert_not_called()


class TestLambdaHandlerDirectInvoke:
    def test_direct_invoke_branch_returns_process_tool_run_result_without_records(self):
        event = {"kind": "tool-run", "toolId": "t1", "runId": "r1", "orgId": "o1", "inputs": {}}
        expected = {"runId": "r1", "status": "success", "output": {"x": 1}, "durationMs": 5}
        with patch.object(tool_run_handler, "process_tool_run", return_value=expected) as mocked:
            result = index.lambda_handler(event, context=None)
        mocked.assert_called_once_with(event)
        assert result == expected

    def test_sqs_batch_path_unaffected_when_records_present(self):
        # An empty Records batch must still return the batchItemFailures shape,
        # never attempt the direct-invoke branch (no 'kind' key at all here).
        result = index.lambda_handler({"Records": []}, context=None)
        assert result == {"batchItemFailures": []}
