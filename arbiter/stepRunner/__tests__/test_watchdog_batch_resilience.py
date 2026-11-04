"""
Tests for watchdog per-execution error isolation (CIT-259 H6).

Verifies that a poisoned execution row does not abort the entire sweep,
and that healthy executions before and after the poisoned row are processed
normally.
"""

import sys
import os
from datetime import datetime, timezone, timedelta

sys.path.insert(0, os.path.join(os.path.dirname(__file__), '..'))

import pytest
from unittest.mock import patch, MagicMock, call
from botocore.exceptions import ClientError

import timeout_watchdog as watchdog


# ---------------------------------------------------------------------------
# Helpers
# ---------------------------------------------------------------------------

def _iso(dt: datetime) -> str:
    return dt.astimezone(timezone.utc).isoformat()


def _running(execution_id: str, started_delta_seconds: int, **overrides) -> dict:
    started = datetime.now(timezone.utc) - timedelta(seconds=started_delta_seconds)
    item = {
        'executionId': execution_id,
        'workflowId': f'wf-{execution_id}',
        'appId': 'app-1',
        'status': 'running',
        'startedAt': _iso(started),
    }
    item.update(overrides)
    return item


@pytest.fixture
def mock_wd():
    tables = {
        'executions_table': MagicMock(),
        'events': MagicMock(),
        'cw': MagicMock(),
    }
    with patch.object(watchdog, '_executions_table', tables['executions_table']), \
         patch.object(watchdog, 'events', tables['events']), \
         patch.object(watchdog, '_get_cw_client', return_value=tables['cw']):
        yield tables


# ---------------------------------------------------------------------------
# Poisoned row isolation
# ---------------------------------------------------------------------------

class TestPoisonedRowIsolation:
    def test_poisoned_row_does_not_abort_sweep(self, mock_wd, monkeypatch):
        """A poisoned execution in the middle of the scan does not prevent
        healthy executions from being processed."""
        monkeypatch.delenv('WORKFLOW_TIMEOUT_SECONDS', raising=False)

        healthy_1 = _running('healthy-1', started_delta_seconds=7200)
        poisoned = _running('poisoned-1', started_delta_seconds=7200)
        healthy_2 = _running('healthy-2', started_delta_seconds=7200)

        mock_wd['executions_table'].scan.return_value = {
            'Items': [healthy_1, poisoned, healthy_2],
        }

        # Make _process_execution raise for the poisoned row only
        original_process = watchdog._process_execution

        def _patched_process(execution, *args, **kwargs):
            if execution['executionId'] == 'poisoned-1':
                raise ValueError('corrupted nodeResults')
            return original_process(execution, *args, **kwargs)

        with patch.object(watchdog, '_process_execution', side_effect=_patched_process):
            result = watchdog.handler({}, None)

        assert result['scanned'] == 3
        assert result['errors'] == 1
        assert 'poisoned-1' in result['errorExecutionIds']
        # Both healthy executions should have been processed (timed out)
        assert result['timedOut'] == 2

    def test_all_poisoned_does_not_raise(self, mock_wd, monkeypatch):
        """If every execution errors, the sweep still returns normally."""
        monkeypatch.delenv('WORKFLOW_TIMEOUT_SECONDS', raising=False)

        items = [_running(f'bad-{i}', started_delta_seconds=7200) for i in range(3)]
        mock_wd['executions_table'].scan.return_value = {'Items': items}

        with patch.object(watchdog, '_process_execution', side_effect=RuntimeError('boom')):
            result = watchdog.handler({}, None)

        assert result['scanned'] == 3
        assert result['errors'] == 3
        assert result['timedOut'] == 0

    def test_dynamodb_throttle_isolated(self, mock_wd, monkeypatch):
        """A DynamoDB throttle on one execution doesn't break the sweep."""
        monkeypatch.delenv('WORKFLOW_TIMEOUT_SECONDS', raising=False)

        healthy = _running('healthy-t', started_delta_seconds=7200)
        throttled = _running('throttled-t', started_delta_seconds=7200)
        mock_wd['executions_table'].scan.return_value = {
            'Items': [throttled, healthy],
        }

        throttle_exc = ClientError(
            {'Error': {'Code': 'ProvisionedThroughputExceededException', 'Message': 'throttle'}},
            'UpdateItem',
        )
        original_process = watchdog._process_execution

        def _patched(execution, *args, **kwargs):
            if execution['executionId'] == 'throttled-t':
                raise throttle_exc
            return original_process(execution, *args, **kwargs)

        with patch.object(watchdog, '_process_execution', side_effect=_patched):
            result = watchdog.handler({}, None)

        assert result['errors'] == 1
        assert result['timedOut'] == 1

    def test_empty_scan_returns_zero_errors(self, mock_wd, monkeypatch):
        monkeypatch.delenv('WORKFLOW_TIMEOUT_SECONDS', raising=False)
        mock_wd['executions_table'].scan.return_value = {'Items': []}

        result = watchdog.handler({}, None)

        assert result['scanned'] == 0
        assert result['errors'] == 0
        assert result['errorExecutionIds'] == []


# ---------------------------------------------------------------------------
# Metric emission
# ---------------------------------------------------------------------------

class TestWatchdogErrorMetric:
    def test_error_metric_emitted_on_errors(self, mock_wd, monkeypatch):
        monkeypatch.delenv('WORKFLOW_TIMEOUT_SECONDS', raising=False)

        items = [_running('err-1', started_delta_seconds=7200)]
        mock_wd['executions_table'].scan.return_value = {'Items': items}

        with patch.object(watchdog, '_process_execution', side_effect=RuntimeError('boom')):
            watchdog.handler({}, None)

        # Check that the error metric was emitted
        cw_calls = mock_wd['cw'].put_metric_data.call_args_list
        error_metric_calls = [
            c for c in cw_calls
            if c.kwargs.get('Namespace') == 'Citadel/StepRunner'
            or (c.args and len(c.args) > 0)
            or any(
                md.get('MetricName') == 'WatchdogExecutionError'
                for md in c.kwargs.get('MetricData', [])
            )
        ]
        assert len(error_metric_calls) >= 1

    def test_no_error_metric_when_sweep_clean(self, mock_wd, monkeypatch):
        monkeypatch.delenv('WORKFLOW_TIMEOUT_SECONDS', raising=False)
        mock_wd['executions_table'].scan.return_value = {'Items': []}

        watchdog.handler({}, None)

        # Only the timed_out metric should be emitted, not the error metric
        cw_calls = mock_wd['cw'].put_metric_data.call_args_list
        error_metric_calls = [
            c for c in cw_calls
            if any(
                md.get('MetricName') == 'WatchdogExecutionError'
                for md in c.kwargs.get('MetricData', [])
            )
        ]
        assert len(error_metric_calls) == 0
