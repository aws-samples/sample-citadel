"""Tests for the approval-timeout watchdog (CIT-030 §4).

Contract exercised:
  * An awaiting_approval node whose request expired is denied via deny_execution.
  * An awaiting_approval node whose request has NOT expired is left untouched.
  * A parked (awaiting_approval) node is NEVER re-driven by the stall detector
    in the existing forward-progress watchdog (tested via the shared
    timeout_watchdog module).
  * APPROVAL_TIMEOUT_SECONDS env is respected as the default when expiresAt is
    absent; requestedAt + env seconds is the effective expiry.
  * Already-decided requests are skipped.
  * Requests with no requestedAt AND no expiresAt are skipped conservatively.

All AWS is mocked; no real network or credentials are touched.
"""

import sys
import os
from datetime import datetime, timezone, timedelta

# stepRunner must be importable (executor, approval_requests live there)
_step_runner = os.path.join(os.path.dirname(__file__), '..', '..', 'stepRunner')
if _step_runner not in sys.path:
    sys.path.insert(0, _step_runner)

# timeoutWatchdog package directory — insert BEFORE stepRunner so `import index`
# resolves to timeoutWatchdog/index.py, not stepRunner/index.py.
_pkg_dir = os.path.join(os.path.dirname(__file__), '..')
sys.path.insert(0, _pkg_dir)

import pytest
from unittest.mock import patch, MagicMock, call

import index as approval_watchdog


# ---------------------------------------------------------------------------
# Helpers
# ---------------------------------------------------------------------------

def _iso(dt: datetime) -> str:
    return dt.astimezone(timezone.utc).isoformat()


_NOW = datetime(2026, 10, 5, 12, 0, 0, tzinfo=timezone.utc)


def _awaiting_execution(
    execution_id: str,
    node_id: str = 'node-1',
    *,
    requested_at: datetime | None = None,
    expires_at: datetime | None = None,
    decision: str | None = None,
    resume_token: str = 'tok-123',
    org_id: str = 'org-1',
    exec_status: str = 'awaiting_approval',
) -> dict:
    """Build an execution with one awaiting_approval node + approval request."""
    req = {
        'requestType': 'approval_required',
        'reason': 'test',
        'requestedBy': 'system',
        'requestedAt': _iso(requested_at) if requested_at else None,
        'resumeToken': resume_token,
        'expiresAt': _iso(expires_at) if expires_at else None,
        'decidedBy': None,
        'decidedAt': None,
        'decision': decision,
        'orgId': org_id,
        'metadata': {},
    }
    return {
        'executionId': execution_id,
        'workflowId': f'wf-{execution_id}',
        'status': exec_status,
        'startedAt': _iso(_NOW - timedelta(hours=2)),
        'nodeResults': {
            node_id: {'status': 'awaiting_approval'},
        },
        'approvalRequests': {
            node_id: req,
        },
    }


@pytest.fixture
def mock_wd():
    """Patch module-level table, executor.deny_execution, and _now."""
    table = MagicMock()
    deny = MagicMock(return_value=True)
    with (
        patch.object(approval_watchdog, '_executions_table', table),
        patch.object(approval_watchdog, '_now', return_value=_NOW),
        patch.object(approval_watchdog.executor, 'deny_execution', deny),
    ):
        yield {'table': table, 'deny': deny}


# ---------------------------------------------------------------------------
# Expired request → deny
# ---------------------------------------------------------------------------

class TestExpiredRequestDenied:
    def test_expired_via_expires_at(self, mock_wd, monkeypatch):
        """A request whose expiresAt is in the past is denied."""
        monkeypatch.delenv('APPROVAL_TIMEOUT_SECONDS', raising=False)
        ex = _awaiting_execution(
            'ex-1',
            expires_at=_NOW - timedelta(minutes=5),
            requested_at=_NOW - timedelta(hours=1),
        )
        mock_wd['table'].scan.return_value = {'Items': [ex]}

        result = approval_watchdog.handler({}, None)

        mock_wd['deny'].assert_called_once_with(
            execution_id='ex-1',
            node_id='node-1',
            resume_token='tok-123',
            decided_by='system:approval_timeout',
            org_id='org-1',
            reason='approval_timeout',
        )
        assert result['denied'] == 1

    def test_expired_via_default_timeout(self, mock_wd, monkeypatch):
        """No expiresAt → requestedAt + APPROVAL_TIMEOUT_SECONDS (default 86400)."""
        monkeypatch.delenv('APPROVAL_TIMEOUT_SECONDS', raising=False)
        # Requested 25h ago, no expiresAt → 25h > 24h default → expired.
        ex = _awaiting_execution(
            'ex-2',
            requested_at=_NOW - timedelta(hours=25),
        )
        mock_wd['table'].scan.return_value = {'Items': [ex]}

        result = approval_watchdog.handler({}, None)

        mock_wd['deny'].assert_called_once()
        assert result['denied'] == 1

    def test_expired_via_env_timeout(self, mock_wd, monkeypatch):
        """APPROVAL_TIMEOUT_SECONDS env override is respected."""
        monkeypatch.setenv('APPROVAL_TIMEOUT_SECONDS', '3600')  # 1h
        # Requested 2h ago, env timeout 1h → expired.
        ex = _awaiting_execution(
            'ex-3',
            requested_at=_NOW - timedelta(hours=2),
        )
        mock_wd['table'].scan.return_value = {'Items': [ex]}

        result = approval_watchdog.handler({}, None)

        mock_wd['deny'].assert_called_once()
        assert result['denied'] == 1


# ---------------------------------------------------------------------------
# Unexpired request → untouched
# ---------------------------------------------------------------------------

class TestUnexpiredUntouched:
    def test_unexpired_via_expires_at(self, mock_wd, monkeypatch):
        """A request whose expiresAt is in the future is NOT denied."""
        monkeypatch.delenv('APPROVAL_TIMEOUT_SECONDS', raising=False)
        ex = _awaiting_execution(
            'ex-4',
            expires_at=_NOW + timedelta(hours=1),
            requested_at=_NOW - timedelta(minutes=30),
        )
        mock_wd['table'].scan.return_value = {'Items': [ex]}

        result = approval_watchdog.handler({}, None)

        mock_wd['deny'].assert_not_called()
        assert result['denied'] == 0

    def test_unexpired_via_default_timeout(self, mock_wd, monkeypatch):
        """Requested 1h ago, no expiresAt, default 24h → NOT expired."""
        monkeypatch.delenv('APPROVAL_TIMEOUT_SECONDS', raising=False)
        ex = _awaiting_execution(
            'ex-5',
            requested_at=_NOW - timedelta(hours=1),
        )
        mock_wd['table'].scan.return_value = {'Items': [ex]}

        result = approval_watchdog.handler({}, None)

        mock_wd['deny'].assert_not_called()
        assert result['denied'] == 0


# ---------------------------------------------------------------------------
# Already decided → skipped
# ---------------------------------------------------------------------------

class TestAlreadyDecided:
    def test_already_approved_request_skipped(self, mock_wd, monkeypatch):
        monkeypatch.delenv('APPROVAL_TIMEOUT_SECONDS', raising=False)
        ex = _awaiting_execution(
            'ex-6',
            expires_at=_NOW - timedelta(hours=1),
            requested_at=_NOW - timedelta(hours=2),
            decision='approved',
        )
        mock_wd['table'].scan.return_value = {'Items': [ex]}

        result = approval_watchdog.handler({}, None)

        mock_wd['deny'].assert_not_called()
        assert result['denied'] == 0

    def test_already_denied_request_skipped(self, mock_wd, monkeypatch):
        monkeypatch.delenv('APPROVAL_TIMEOUT_SECONDS', raising=False)
        ex = _awaiting_execution(
            'ex-7',
            expires_at=_NOW - timedelta(hours=1),
            requested_at=_NOW - timedelta(hours=2),
            decision='denied',
        )
        mock_wd['table'].scan.return_value = {'Items': [ex]}

        result = approval_watchdog.handler({}, None)

        mock_wd['deny'].assert_not_called()
        assert result['denied'] == 0


# ---------------------------------------------------------------------------
# No requestedAt and no expiresAt → skipped conservatively
# ---------------------------------------------------------------------------

class TestNoTimestamps:
    def test_no_requested_at_no_expires_at_skipped(self, mock_wd, monkeypatch):
        monkeypatch.delenv('APPROVAL_TIMEOUT_SECONDS', raising=False)
        ex = _awaiting_execution('ex-8')
        # Strip both timestamps.
        ex['approvalRequests']['node-1']['requestedAt'] = None
        ex['approvalRequests']['node-1']['expiresAt'] = None
        mock_wd['table'].scan.return_value = {'Items': [ex]}

        result = approval_watchdog.handler({}, None)

        mock_wd['deny'].assert_not_called()
        assert result['denied'] == 0


# ---------------------------------------------------------------------------
# Parked node not re-driven by existing stall detector
# ---------------------------------------------------------------------------

class TestParkedNodeNotReDriven:
    """Verify the existing stepRunner/timeout_watchdog._find_stalled_node
    skips awaiting_approval nodes (they are NOT 'running')."""

    def test_find_stalled_node_skips_awaiting_approval(self):
        """Import the existing watchdog and confirm its stall detector
        ignores awaiting_approval nodes."""
        import timeout_watchdog as fwd_watchdog

        execution = {
            'nodeResults': {
                'n1': {
                    'status': 'awaiting_approval',
                    'startedAt': _iso(_NOW - timedelta(hours=10)),
                },
                'n2': {
                    'status': 'completed',
                    'startedAt': _iso(_NOW - timedelta(hours=10)),
                },
            },
        }
        # Even with a very short stall threshold, awaiting_approval is not
        # treated as stalled.
        result = fwd_watchdog._find_stalled_node(execution, _NOW, node_stall=1)
        assert result is None

    def test_find_stalled_node_still_detects_running(self):
        """Sanity: a running node past the threshold IS detected."""
        import timeout_watchdog as fwd_watchdog

        execution = {
            'nodeResults': {
                'n1': {
                    'status': 'awaiting_approval',
                    'startedAt': _iso(_NOW - timedelta(hours=10)),
                },
                'n2': {
                    'status': 'running',
                    'startedAt': _iso(_NOW - timedelta(hours=10)),
                },
            },
        }
        result = fwd_watchdog._find_stalled_node(execution, _NOW, node_stall=1)
        assert result == 'n2'


# ---------------------------------------------------------------------------
# Scan filter includes both running and awaiting_approval
# ---------------------------------------------------------------------------

class TestScanFilter:
    def test_scan_includes_running_and_awaiting_approval(self, mock_wd):
        mock_wd['table'].scan.return_value = {'Items': []}

        approval_watchdog._scan_awaiting_or_running()

        scan_kwargs = mock_wd['table'].scan.call_args.kwargs
        values = scan_kwargs.get('ExpressionAttributeValues', {})
        assert ':running' in values
        assert values[':running'] == 'running'
        assert ':awaiting' in values
        assert values[':awaiting'] == 'awaiting_approval'


# ---------------------------------------------------------------------------
# Running execution with parked node (exec still running, node parked)
# ---------------------------------------------------------------------------

class TestRunningExecWithParkedNode:
    def test_expired_node_in_running_execution_is_denied(self, mock_wd, monkeypatch):
        """An execution still 'running' may have individual parked nodes with
        expired approval requests — those must be timed out too."""
        monkeypatch.delenv('APPROVAL_TIMEOUT_SECONDS', raising=False)
        ex = _awaiting_execution(
            'ex-9',
            expires_at=_NOW - timedelta(minutes=5),
            requested_at=_NOW - timedelta(hours=1),
            exec_status='running',
        )
        mock_wd['table'].scan.return_value = {'Items': [ex]}

        result = approval_watchdog.handler({}, None)

        mock_wd['deny'].assert_called_once()
        assert result['denied'] == 1


# ---------------------------------------------------------------------------
# Invalid APPROVAL_TIMEOUT_SECONDS
# ---------------------------------------------------------------------------

class TestEnvFallback:
    def test_invalid_env_falls_back_to_default(self, mock_wd, monkeypatch):
        monkeypatch.setenv('APPROVAL_TIMEOUT_SECONDS', 'garbage')
        # Requested 25h ago, invalid env → 24h default → expired.
        ex = _awaiting_execution(
            'ex-10',
            requested_at=_NOW - timedelta(hours=25),
        )
        mock_wd['table'].scan.return_value = {'Items': [ex]}

        result = approval_watchdog.handler({}, None)

        mock_wd['deny'].assert_called_once()
        assert result['denied'] == 1

    def test_zero_env_falls_back_to_default(self, mock_wd, monkeypatch):
        monkeypatch.setenv('APPROVAL_TIMEOUT_SECONDS', '0')
        # Requested 1h ago, zero → 24h default → NOT expired.
        ex = _awaiting_execution(
            'ex-11',
            requested_at=_NOW - timedelta(hours=1),
        )
        mock_wd['table'].scan.return_value = {'Items': [ex]}

        result = approval_watchdog.handler({}, None)

        mock_wd['deny'].assert_not_called()


# ---------------------------------------------------------------------------
# deny_execution returns False (idempotent no-op) → not counted
# ---------------------------------------------------------------------------

class TestDenyIdempotency:
    def test_deny_noop_not_counted(self, mock_wd, monkeypatch):
        monkeypatch.delenv('APPROVAL_TIMEOUT_SECONDS', raising=False)
        mock_wd['deny'].return_value = False
        ex = _awaiting_execution(
            'ex-12',
            expires_at=_NOW - timedelta(hours=1),
            requested_at=_NOW - timedelta(hours=2),
        )
        mock_wd['table'].scan.return_value = {'Items': [ex]}

        result = approval_watchdog.handler({}, None)

        mock_wd['deny'].assert_called_once()
        assert result['denied'] == 0


# ---------------------------------------------------------------------------
# Multiple nodes on one execution
# ---------------------------------------------------------------------------

class TestMultipleNodes:
    def test_only_expired_nodes_denied(self, mock_wd, monkeypatch):
        """Two parked nodes: one expired, one not. Only the expired one is denied."""
        monkeypatch.delenv('APPROVAL_TIMEOUT_SECONDS', raising=False)
        ex = _awaiting_execution(
            'ex-13',
            node_id='n-old',
            expires_at=_NOW - timedelta(hours=1),
            requested_at=_NOW - timedelta(hours=2),
        )
        # Add a second, unexpired request.
        ex['approvalRequests']['n-fresh'] = {
            'requestType': 'approval_required',
            'reason': 'test',
            'requestedBy': 'system',
            'requestedAt': _iso(_NOW - timedelta(minutes=5)),
            'resumeToken': 'tok-fresh',
            'expiresAt': _iso(_NOW + timedelta(hours=1)),
            'decidedBy': None,
            'decidedAt': None,
            'decision': None,
            'orgId': 'org-1',
            'metadata': {},
        }
        ex['nodeResults']['n-fresh'] = {'status': 'awaiting_approval'}
        mock_wd['table'].scan.return_value = {'Items': [ex]}

        result = approval_watchdog.handler({}, None)

        assert mock_wd['deny'].call_count == 1
        assert mock_wd['deny'].call_args.kwargs['node_id'] == 'n-old'
        assert result['denied'] == 1
