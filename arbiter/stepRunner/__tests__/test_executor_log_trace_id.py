"""Unit tests for executor._log_event trace_id injection (architect task
f4f4bab3-7a07-4acf-ba43-ba43bb488444, design §"Structured-log trace-id
inclusion at the cited logger seams both languages" — `_log_event` gains
`trace_id`).

No-op-safe: with no active X-Ray segment (the pytest default), the logged
line has no `trace_id` key at all — additive-absence, never a null/None
placeholder that would change the line's shape.
"""
import sys
import os
import json
from unittest.mock import patch

sys.path.insert(0, os.path.join(os.path.dirname(__file__), '..'))

import executor


def test_log_event_omits_trace_id_with_no_active_segment(capsys):
    executor._log_event('node_dispatch', executionId='exec-1', nodeId='n0')
    out = capsys.readouterr().out.strip()
    payload = json.loads(out)
    assert 'trace_id' not in payload
    assert payload['executionId'] == 'exec-1'


def test_log_event_includes_trace_id_when_active_segment_present(capsys):
    fake_ctx = {'traceId': '1-aaaaaaaa-bbbbbbbbbbbbbbbbbbbbbbbb'}
    with patch.object(executor.tracing, 'active_trace_context', return_value=fake_ctx):
        executor._log_event('node_dispatch', executionId='exec-1', nodeId='n0')
    out = capsys.readouterr().out.strip()
    payload = json.loads(out)
    assert payload['trace_id'] == '1-aaaaaaaa-bbbbbbbbbbbbbbbbbbbbbbbb'
