"""Tests for paused-time exclusion (Bug A) and undated approval expiry (Bug B).

Bug A: execution timeout must use effective age (wall-clock minus paused time),
       not raw wall-clock from startedAt.
Bug B: approval requests with expiresAt null/absent must fall back to
       requestedAt + APPROVAL_TIMEOUT_SECONDS.
"""

import sys
import os
from datetime import datetime, timezone, timedelta

# stepRunner must be importable.
_step_runner = os.path.join(os.path.dirname(__file__), '..', '..', 'stepRunner')
if _step_runner not in sys.path:
    sys.path.insert(0, _step_runner)

# timeoutWatchdog package directory.
_pkg_dir = os.path.join(os.path.dirname(__file__), '..')
sys.path.insert(0, _pkg_dir)

import importlib.util
import pathlib

import pytest
from unittest.mock import patch, MagicMock

import timeout_watchdog as exec_watchdog

_spec = importlib.util.spec_from_file_location(
    'approval_watchdog',
    pathlib.Path(__file__).resolve().parent.parent / 'index.py')
approval_watchdog = importlib.util.module_from_spec(_spec)
_spec.loader.exec_module(approval_watchdog)


# ---------------------------------------------------------------------------
# Helpers
# ---------------------------------------------------------------------------

_NOW = datetime(2026, 10, 5, 12, 0, 0, tzinfo=timezone.utc)


def _iso(dt: datetime) -> str:
    return dt.astimezone(timezone.utc).isoformat()


# ---------------------------------------------------------------------------
# Bug A — execution timeout excludes paused time
# ---------------------------------------------------------------------------

@pytest.fixture
def mock_exec_wd():
    """Patch exec_watchdog module-level table, events, and CloudWatch."""
    tables = {
        'executions_table': MagicMock(),
        'events': MagicMock(),
        'cw': MagicMock(),
    }
    with (
        patch.object(exec_watchdog, '_executions_table', tables['executions_table']),
        patch.object(exec_watchdog, 'events', tables['events']),
        patch.object(exec_watchdog, '_get_cw_client', return_value=tables['cw']),
        patch.object(exec_watchdog, '_now', return_value=_NOW),
    ):
        yield tables


class TestPausedTimeExclusion:
    """Bug A: effective age = wall-clock - pausedSeconds - ongoing pause."""

    def test_parked_2h_resumed_1min_ago_not_failed(self, mock_exec_wd, monkeypatch):
        """An execution started 2h+1min ago, parked for 2h (pausedSeconds=7200),
        resumed 1 minute ago → effective running time ~1 min, well under the
        default 1h timeout → must NOT be failed."""
        monkeypatch.delenv('WORKFLOW_TIMEOUT_SECONDS', raising=False)
        execution = {
            'executionId': 'paused-1',
            'workflowId': 'wf-paused-1',
            'status': 'running',
            'startedAt': _iso(_NOW - timedelta(hours=2, minutes=1)),
            'pausedSeconds': 7200,  # 2h of accumulated pause
            # pausedAt absent → not currently paused (resumed)
        }
        mock_exec_wd['executions_table'].scan.return_value = {'Items': [execution]}

        result = exec_watchdog.handler({}, None)

        mock_exec_wd['executions_table'].update_item.assert_not_called()
        mock_exec_wd['events'].publish_workflow_failed.assert_not_called()
        assert result['timedOut'] == 0

    def test_running_2h_no_pause_is_failed(self, mock_exec_wd, monkeypatch):
        """An execution started 2h ago with no pause at all → effective running
        time = 2h > default 1h timeout → must be failed."""
        monkeypatch.delenv('WORKFLOW_TIMEOUT_SECONDS', raising=False)
        execution = {
            'executionId': 'stuck-1',
            'workflowId': 'wf-stuck-1',
            'status': 'running',
            'startedAt': _iso(_NOW - timedelta(hours=2)),
            # No pausedSeconds, no pausedAt → pure wall-clock
        }
        mock_exec_wd['executions_table'].scan.return_value = {'Items': [execution]}

        result = exec_watchdog.handler({}, None)

        mock_exec_wd['executions_table'].update_item.assert_called_once()
        mock_exec_wd['events'].publish_workflow_failed.assert_called_once()
        assert result['timedOut'] == 1

    def test_currently_paused_not_failed(self, mock_exec_wd, monkeypatch):
        """An execution started 2h ago, currently paused (pausedAt set 1h59m ago)
        → effective running time ~1 min → not failed."""
        monkeypatch.delenv('WORKFLOW_TIMEOUT_SECONDS', raising=False)
        execution = {
            'executionId': 'paused-now',
            'workflowId': 'wf-paused-now',
            'status': 'running',
            'startedAt': _iso(_NOW - timedelta(hours=2)),
            'pausedSeconds': 0,
            'pausedAt': _iso(_NOW - timedelta(hours=1, minutes=59)),
        }
        mock_exec_wd['executions_table'].scan.return_value = {'Items': [execution]}

        result = exec_watchdog.handler({}, None)

        mock_exec_wd['executions_table'].update_item.assert_not_called()
        assert result['timedOut'] == 0

    def test_partial_pause_still_times_out(self, mock_exec_wd, monkeypatch):
        """An execution started 3h ago, paused for only 30min → effective 2h30m
        > default 1h → failed."""
        monkeypatch.delenv('WORKFLOW_TIMEOUT_SECONDS', raising=False)
        execution = {
            'executionId': 'partial-pause',
            'workflowId': 'wf-partial-pause',
            'status': 'running',
            'startedAt': _iso(_NOW - timedelta(hours=3)),
            'pausedSeconds': 1800,  # 30 min
        }
        mock_exec_wd['executions_table'].scan.return_value = {'Items': [execution]}

        result = exec_watchdog.handler({}, None)

        mock_exec_wd['executions_table'].update_item.assert_called_once()
        assert result['timedOut'] == 1


# ---------------------------------------------------------------------------
# Bug B — approval timeout fires for expiresAt null (manual_pause)
# ---------------------------------------------------------------------------

@pytest.fixture
def mock_appr_wd():
    """Patch approval_watchdog module-level table, executor, and _now."""
    table = MagicMock()
    deny = MagicMock(return_value=True)
    with (
        patch.object(approval_watchdog, '_executions_table', table),
        patch.object(approval_watchdog, '_now', return_value=_NOW),
        patch.object(approval_watchdog.executor, 'deny_execution', deny),
    ):
        yield {'table': table, 'deny': deny}


def _approval_execution(
    execution_id: str,
    node_id: str = 'node-1',
    *,
    requested_at: datetime | None = None,
    expires_at: object = 'UNSET',  # sentinel — UNSET means key absent
    decision: str | None = None,
) -> dict:
    req: dict = {
        'requestType': 'manual_pause',
        'reason': 'manual pause',
        'requestedBy': 'user',
        'requestedAt': _iso(requested_at) if requested_at else None,
        'resumeToken': 'tok-abc',
        'decidedBy': None,
        'decidedAt': None,
        'decision': decision,
        'orgId': 'org-1',
        'metadata': {},
    }
    if expires_at == 'UNSET':
        # expiresAt key intentionally absent (manual_pause).
        pass
    else:
        req['expiresAt'] = _iso(expires_at) if expires_at else None
    return {
        'executionId': execution_id,
        'workflowId': f'wf-{execution_id}',
        'status': 'awaiting_approval',
        'startedAt': _iso(_NOW - timedelta(hours=2)),
        'nodeResults': {node_id: {'status': 'awaiting_approval'}},
        'approvalRequests': {node_id: req},
    }


class TestUndatedApprovalExpiry:
    """Bug B: expiresAt null/absent → fall back to requestedAt + timeout."""

    def test_null_expires_at_old_request_is_denied(self, mock_appr_wd, monkeypatch):
        """A manual_pause request with no expiresAt, requestedAt older than
        APPROVAL_TIMEOUT_SECONDS → denied."""
        monkeypatch.setenv('APPROVAL_TIMEOUT_SECONDS', '3600')  # 1h
        ex = _approval_execution(
            'appr-1',
            requested_at=_NOW - timedelta(hours=2),  # 2h ago > 1h timeout
            expires_at='UNSET',
        )
        mock_appr_wd['table'].scan.return_value = {'Items': [ex]}

        result = approval_watchdog.handler({}, None)

        mock_appr_wd['deny'].assert_called_once()
        assert result['denied'] == 1

    def test_null_expires_at_recent_request_untouched(self, mock_appr_wd, monkeypatch):
        """A manual_pause request with no expiresAt, requestedAt newer than
        APPROVAL_TIMEOUT_SECONDS → NOT denied."""
        monkeypatch.setenv('APPROVAL_TIMEOUT_SECONDS', '3600')  # 1h
        ex = _approval_execution(
            'appr-2',
            requested_at=_NOW - timedelta(minutes=30),  # 30 min ago < 1h
            expires_at='UNSET',
        )
        mock_appr_wd['table'].scan.return_value = {'Items': [ex]}

        result = approval_watchdog.handler({}, None)

        mock_appr_wd['deny'].assert_not_called()
        assert result['denied'] == 0

    def test_explicit_none_expires_at_old_request_is_denied(self, mock_appr_wd, monkeypatch):
        """expiresAt explicitly set to None (not just absent) → same fallback."""
        monkeypatch.setenv('APPROVAL_TIMEOUT_SECONDS', '3600')
        ex = _approval_execution(
            'appr-3',
            requested_at=_NOW - timedelta(hours=2),
            expires_at=None,  # explicit None
        )
        mock_appr_wd['table'].scan.return_value = {'Items': [ex]}

        result = approval_watchdog.handler({}, None)

        mock_appr_wd['deny'].assert_called_once()
        assert result['denied'] == 1
