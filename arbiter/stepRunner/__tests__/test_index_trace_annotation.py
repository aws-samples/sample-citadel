"""Unit tests for the step runner Lambda handler's trace-context annotation
at entry (architect task f4f4bab3-7a07-4acf-ba43-ba43bb488444, design
§"File-by-file list" item 8 — R15: index.handler annotates from
detail.traceContext; no-throw when absent).
"""
import sys
import os
from unittest.mock import patch

sys.path.insert(0, os.path.join(os.path.dirname(__file__), '..'))

import index


def _event(detail_type, detail):
    return {'detail-type': detail_type, 'detail': detail}


class TestHandlerAnnotatesFromCarried:
    def test_annotate_called_with_extracted_trace_context(self):
        carried = {'traceId': '1-aaaaaaaa-bbbbbbbbbbbbbbbbbbbbbbbb'}
        detail = {
            'executionId': 'exec-1',
            'workflowId': 'wf-1',
            'traceContext': carried,
        }
        with patch.object(index, 'start_execution'), \
             patch.object(index, 'annotate_from_carried') as mock_annotate, \
             patch.object(index, 'extract_carried', wraps=index.extract_carried) as mock_extract:
            index.handler(_event('execution.start.requested', detail), {})

        mock_extract.assert_called_once_with(detail)
        mock_annotate.assert_called_once_with(carried)

    def test_no_throw_when_trace_context_absent(self):
        detail = {'executionId': 'exec-1', 'workflowId': 'wf-1'}
        with patch.object(index, 'start_execution'):
            result = index.handler(_event('execution.start.requested', detail), {})
        assert result == {'statusCode': 200}

    def test_no_throw_for_arbitrary_malformed_trace_context(self):
        for bad in ['not-a-dict', 42, None, ['a'], {'nested': {'x': 1}}]:
            detail = {'executionId': 'exec-1', 'workflowId': 'wf-1', 'traceContext': bad}
            with patch.object(index, 'start_execution'):
                result = index.handler(_event('execution.start.requested', detail), {})
            assert result == {'statusCode': 200}
