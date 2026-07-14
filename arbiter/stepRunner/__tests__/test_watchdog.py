"""
Unit tests for the scheduled timeout watchdog.

The watchdog is a self-contained Lambda that periodically scans the executions
table for executions still in the 'running' state whose ``startedAt`` is older
than a configurable timeout (``WORKFLOW_TIMEOUT_SECONDS``). Each stuck execution
is marked ``failed`` (idempotently, via a conditional update that guards
``status == 'running'``) and a ``workflow.failed`` event is emitted through the
shared events module.

Contract exercised here:
  * a stuck running execution is marked failed AND emits workflow.failed
  * a recent running execution is untouched
  * a terminal execution is never surfaced by the running-only scan filter
  * the conditional update makes concurrent/duplicate sweeps a no-op
  * a full re-run after the first sweep is a no-op (already terminal → filtered)
  * WORKFLOW_TIMEOUT_SECONDS overrides the default window
  * a running execution with no startedAt is skipped conservatively

All AWS is mocked; no real network or credentials are touched.
"""

import sys
import os
import importlib.util
from datetime import datetime, timezone, timedelta

sys.path.insert(0, os.path.join(os.path.dirname(__file__), '..'))

import pytest
from unittest.mock import patch, MagicMock
from botocore.exceptions import ClientError


# ---------------------------------------------------------------------------
# Import the LOCAL watchdog module by explicit file path.
#
# The name ``watchdog`` collides with the file-watching pip package installed
# in the dev venv, and plugins may import that package before our test's
# sys.path insert takes effect. Loading from the module's absolute path under a
# distinct internal name guarantees we always exercise OUR Lambda module,
# regardless of sys.path ordering or import caching.
# ---------------------------------------------------------------------------
_WATCHDOG_PATH = os.path.join(os.path.dirname(__file__), '..', 'watchdog.py')
_spec = importlib.util.spec_from_file_location('steprunner_watchdog', _WATCHDOG_PATH)
watchdog = importlib.util.module_from_spec(_spec)
sys.modules['steprunner_watchdog'] = watchdog
_spec.loader.exec_module(watchdog)


# ---------------------------------------------------------------------------
# Helpers
# ---------------------------------------------------------------------------

def _iso(dt: datetime) -> str:
    return dt.astimezone(timezone.utc).isoformat()


def _running(execution_id: str, started_delta_seconds: int, **overrides) -> dict:
    """Build a running execution item started ``started_delta_seconds`` ago."""
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
    """Patch the module-level executions table, events, and CloudWatch client."""
    tables = {
        'executions_table': MagicMock(),
        'events': MagicMock(),
        'cw': MagicMock(),
    }
    with patch.object(watchdog, '_executions_table', tables['executions_table']), \
         patch.object(watchdog, 'events', tables['events']), \
         patch.object(watchdog, '_get_cw_client', return_value=tables['cw']):
        yield tables


def _conditional_check_failed() -> ClientError:
    return ClientError(
        {'Error': {'Code': 'ConditionalCheckFailedException', 'Message': 'stale'}},
        'UpdateItem',
    )


# ---------------------------------------------------------------------------
# Stuck execution → failed + event
# ---------------------------------------------------------------------------

class TestStuckExecution:
    def test_stuck_running_execution_is_marked_failed(self, mock_wd, monkeypatch):
        monkeypatch.delenv('WORKFLOW_TIMEOUT_SECONDS', raising=False)
        stuck = _running('stuck-1', started_delta_seconds=7200)  # 2h old, default 1h
        mock_wd['executions_table'].scan.return_value = {'Items': [stuck]}

        watchdog.handler({}, None)

        mock_wd['executions_table'].update_item.assert_called_once()
        kwargs = mock_wd['executions_table'].update_item.call_args.kwargs
        assert kwargs['Key'] == {'executionId': 'stuck-1'}
        # Conditional update guards status == running for idempotency.
        assert 'ConditionExpression' in kwargs
        assert kwargs['ExpressionAttributeValues'][':failed'] == 'failed'

    def test_stuck_running_execution_emits_workflow_failed(self, mock_wd, monkeypatch):
        monkeypatch.delenv('WORKFLOW_TIMEOUT_SECONDS', raising=False)
        stuck = _running('stuck-2', started_delta_seconds=7200)
        mock_wd['executions_table'].scan.return_value = {'Items': [stuck]}

        watchdog.handler({}, None)

        mock_wd['events'].publish_workflow_failed.assert_called_once()
        call = mock_wd['events'].publish_workflow_failed.call_args
        assert call.kwargs['execution_id'] == 'stuck-2'
        assert call.kwargs['workflow_id'] == 'wf-stuck-2'
        # Timeout failures are execution-level, not tied to a single node.
        assert call.kwargs['failed_node_id'] == ''
        assert 'timed out' in call.kwargs['error'].lower()


# ---------------------------------------------------------------------------
# Recent / terminal executions untouched
# ---------------------------------------------------------------------------

class TestNonStuckExecutions:
    def test_recent_running_execution_is_untouched(self, mock_wd, monkeypatch):
        monkeypatch.delenv('WORKFLOW_TIMEOUT_SECONDS', raising=False)
        recent = _running('recent-1', started_delta_seconds=30)  # 30s old
        mock_wd['executions_table'].scan.return_value = {'Items': [recent]}

        watchdog.handler({}, None)

        mock_wd['executions_table'].update_item.assert_not_called()
        mock_wd['events'].publish_workflow_failed.assert_not_called()

    def test_scan_filters_to_running_status_only(self, mock_wd, monkeypatch):
        """Terminal executions must never be surfaced — the scan filters on
        status == 'running', so completed/failed/cancelled rows are excluded
        at the source."""
        monkeypatch.delenv('WORKFLOW_TIMEOUT_SECONDS', raising=False)
        mock_wd['executions_table'].scan.return_value = {'Items': []}

        watchdog.handler({}, None)

        scan_kwargs = mock_wd['executions_table'].scan.call_args.kwargs
        values = scan_kwargs.get('ExpressionAttributeValues', {})
        assert 'running' in values.values()
        mock_wd['events'].publish_workflow_failed.assert_not_called()

    def test_running_execution_without_started_at_is_skipped(self, mock_wd, monkeypatch):
        monkeypatch.delenv('WORKFLOW_TIMEOUT_SECONDS', raising=False)
        no_start = {'executionId': 'no-start', 'workflowId': 'wf-x', 'status': 'running'}
        mock_wd['executions_table'].scan.return_value = {'Items': [no_start]}

        watchdog.handler({}, None)

        mock_wd['executions_table'].update_item.assert_not_called()
        mock_wd['events'].publish_workflow_failed.assert_not_called()


# ---------------------------------------------------------------------------
# Idempotency
# ---------------------------------------------------------------------------

class TestIdempotency:
    def test_conditional_check_failure_is_a_noop(self, mock_wd, monkeypatch):
        """If another sweep (or the executor) already moved the execution out of
        'running', the conditional update fails and we do NOT emit a duplicate
        workflow.failed."""
        monkeypatch.delenv('WORKFLOW_TIMEOUT_SECONDS', raising=False)
        stuck = _running('race-1', started_delta_seconds=7200)
        mock_wd['executions_table'].scan.return_value = {'Items': [stuck]}
        mock_wd['executions_table'].update_item.side_effect = _conditional_check_failed()

        # Must not raise.
        watchdog.handler({}, None)

        mock_wd['events'].publish_workflow_failed.assert_not_called()

    def test_rerun_after_first_sweep_is_noop(self, mock_wd, monkeypatch):
        """First sweep fails the stuck execution; the second sweep's scan no
        longer returns it (now terminal → filtered out) so no duplicate event."""
        monkeypatch.delenv('WORKFLOW_TIMEOUT_SECONDS', raising=False)
        stuck = _running('once-1', started_delta_seconds=7200)
        mock_wd['executions_table'].scan.side_effect = [
            {'Items': [stuck]},   # first invocation sees it running
            {'Items': []},        # second invocation: it's now failed → filtered
        ]

        watchdog.handler({}, None)
        watchdog.handler({}, None)

        assert mock_wd['events'].publish_workflow_failed.call_count == 1
        assert mock_wd['executions_table'].update_item.call_count == 1


# ---------------------------------------------------------------------------
# Configurable timeout
# ---------------------------------------------------------------------------

class TestTimeoutConfig:
    def test_env_override_shortens_timeout(self, mock_wd, monkeypatch):
        monkeypatch.setenv('WORKFLOW_TIMEOUT_SECONDS', '60')
        # 120s old > 60s override → stuck.
        stuck = _running('short-1', started_delta_seconds=120)
        mock_wd['executions_table'].scan.return_value = {'Items': [stuck]}

        watchdog.handler({}, None)

        mock_wd['events'].publish_workflow_failed.assert_called_once()

    def test_invalid_env_falls_back_to_default(self, mock_wd, monkeypatch):
        monkeypatch.setenv('WORKFLOW_TIMEOUT_SECONDS', 'not-a-number')
        # 120s old is < default (1h) → NOT stuck when the bad env is ignored.
        recent = _running('short-2', started_delta_seconds=120)
        mock_wd['executions_table'].scan.return_value = {'Items': [recent]}

        watchdog.handler({}, None)

        mock_wd['events'].publish_workflow_failed.assert_not_called()


# ---------------------------------------------------------------------------
# Metric emission is best-effort
# ---------------------------------------------------------------------------

class TestMetric:
    def test_metric_emit_failure_does_not_raise(self, mock_wd, monkeypatch):
        monkeypatch.delenv('WORKFLOW_TIMEOUT_SECONDS', raising=False)
        stuck = _running('metric-1', started_delta_seconds=7200)
        mock_wd['executions_table'].scan.return_value = {'Items': [stuck]}
        mock_wd['cw'].put_metric_data.side_effect = RuntimeError('cw down')

        # Best-effort telemetry must not break the sweep.
        watchdog.handler({}, None)

        mock_wd['events'].publish_workflow_failed.assert_called_once()
