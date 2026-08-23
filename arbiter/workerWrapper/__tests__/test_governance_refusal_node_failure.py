"""Regression + invariant tests for finding be80ccd7 (HIGH): a governance /
infrastructure REFUSAL inside a NORMALLY-COMPLETED agent turn must fail the
node — the earlier fix (finding 56d763d4) only mapped agent-body EXCEPTIONS.

Ground truth: a tool call's ledger reserve raised a ``LedgerError`` ("ledger
fenced reserve transport error", produced by the NoCredentialsError of finding
9ef192d1). strands catches a tool exception, converts it to an error-status
ToolResult, and lets the agent turn COMPLETE normally (subprocess exit 0, no
agent-body failure marker). The worker then emitted ``workflow.node.completed``
and the execution finalized ``completed`` for a run whose governance gate
hard-failed.

The corrected boundary (DISCRIMINATOR uses the existing typed marker
``governance.tool_execution_ledger.LedgerError``):
  * INFRA/GOVERNANCE REFUSAL (a LedgerError raised by reserve/finalize) is
    recorded in ``tool_idempotency_hook``'s refusal sink; ``agent_runner``
    drains it after the turn and emits a failure-marked envelope so the node
    fails with the LedgerError CLASS fed into retry.py.
  * DOMAIN-level tool error (tool ran + returned status=error, or the agent
    handled it) records NO refusal and completes normally — never blanket-fails.
  * ``StaleWorkerFencedError`` is a DESIGNED exactly-once outcome and is NOT
    recorded as a node-failing refusal (a newer worker owns the node).

All AWS/subprocess is mocked; no real network or credentials.
"""

import io
import json
import os
import sys
import tempfile
from unittest.mock import patch, MagicMock

import pytest


_NODE_ENV = {
    'AGENT_CONFIG_TABLE': 'test-table',
    'AGENT_BUCKET_NAME': 'test-bucket',
    'COMPLETION_BUS_NAME': 'citadel-agents-test',
    'EXECUTIONS_TABLE': 'citadel-executions-test',
}

NODE_MESSAGE = {
    'message_type': 'workflow_node',
    'execution_id': 'exec-1',
    'node_id': 'smoke-1',
    'workflow_id': 'wf-1',
    'agent_id': 'agent-A',
    'input': {'taskDetails': 'do the thing'},
    'configuration': {},
}

MARKER = 'agentExecutionFailed'
REFUSAL_MARKER = 'governanceRefused'


def _fresh_index():
    sys.modules.pop('index', None)
    import index
    return index


def _refusal_stdout(error_class='LedgerError',
                    message='ledger fenced reserve transport error'):
    """The stdout envelope agent_runner writes when a governance/infrastructure
    refusal was recorded during an otherwise-completed turn."""
    return json.dumps({
        MARKER: True,
        REFUSAL_MARKER: True,
        'errorClass': error_class,
        'error': message,
        'usage': [],
    })


# ---------------------------------------------------------------------------
# The recording seam in tool_idempotency_hook.
# ---------------------------------------------------------------------------
class TestGovernanceRefusalSink:
    def test_record_and_drain_roundtrip(self):
        import tool_idempotency_hook as hook
        from governance import tool_execution_ledger as ledger
        hook.drain_governance_refusals()  # start clean
        hook._record_governance_refusal(ledger.LedgerError('transport boom'))
        drained = hook.drain_governance_refusals()
        assert len(drained) == 1
        assert drained[0]['errorClass'] == 'LedgerError'
        assert 'transport boom' in drained[0]['error']
        # Draining clears the sink.
        assert hook.drain_governance_refusals() == []

    def test_retryable_flag_taken_from_ledger_subclass(self):
        import tool_idempotency_hook as hook
        from governance import tool_execution_ledger as ledger
        hook.drain_governance_refusals()
        hook._record_governance_refusal(ledger.RetryableNoExecutionError('no side effect'))
        hook._record_governance_refusal(ledger.LedgerError('transport'))
        drained = hook.drain_governance_refusals()
        by_class = {d['errorClass']: d for d in drained}
        assert by_class['RetryableNoExecutionError']['retryable'] is True
        assert by_class['LedgerError']['retryable'] is False

    def test_stale_worker_fenced_is_a_ledger_subclass_but_carved_out(self):
        """StaleWorkerFencedError IS a LedgerError subclass, so the carve-out in
        _IdempotentToolWrapper.stream() (which handles it in a SEPARATE branch
        BEFORE the generic LedgerError branch and does NOT record it) is a
        deliberate exclusion, not a type gap."""
        from governance import tool_execution_ledger as ledger
        assert issubclass(ledger.StaleWorkerFencedError, ledger.LedgerError)


# ---------------------------------------------------------------------------
# The envelope builder in agent_runner.
# ---------------------------------------------------------------------------
class TestRefusalEnvelope:
    def test_build_refusal_envelope_carries_marker_and_class(self):
        import agent_runner
        env = agent_runner.build_refusal_envelope(
            [{'errorClass': 'LedgerError', 'error': 'transport boom', 'retryable': False}],
            [{'inputTokens': 1}],
        )
        assert env[agent_runner.AGENT_EXECUTION_FAILURE_MARKER] is True
        assert env[agent_runner.GOVERNANCE_REFUSAL_MARKER] is True
        assert env['errorClass'] == 'LedgerError'
        assert 'transport boom' in env['error']
        assert env['usage'] == [{'inputTokens': 1}]

    def test_first_refusal_class_is_the_retry_key(self):
        import agent_runner
        env = agent_runner.build_refusal_envelope(
            [
                {'errorClass': 'OutcomeIndeterminateError', 'error': 'a'},
                {'errorClass': 'LedgerError', 'error': 'b'},
            ],
            [],
        )
        assert env['errorClass'] == 'OutcomeIndeterminateError'
        assert 'a' in env['error'] and 'b' in env['error']


# ---------------------------------------------------------------------------
# agent_runner.main() end-to-end: a handler that records a refusal (mimicking a
# swallowed ledger error) must emit a failure envelope + non-zero exit even
# though the handler RETURNED normally.
# ---------------------------------------------------------------------------
class TestMainDrainsRefusalOnCompletedTurn:
    def test_completed_turn_with_recorded_refusal_fails(self):
        import agent_runner
        import tool_idempotency_hook as hook
        hook.drain_governance_refusals()  # clean

        # A handler that returns normally BUT a tool call recorded a ledger
        # refusal into the shared sink (exactly what the swallowed
        # error-ToolResult path does at runtime).
        with tempfile.NamedTemporaryFile(mode='w', suffix='.py', delete=False) as f:
            f.write(
                "from governance import tool_execution_ledger as ledger\n"
                "import tool_idempotency_hook as hook\n"
                "def handler(**kwargs):\n"
                "    hook._record_governance_refusal(\n"
                "        ledger.LedgerError('ledger fenced reserve transport error'))\n"
                "    return 'the agent finished its turn normally'\n"
            )
            module_path = f.name
        try:
            payload = json.dumps({'modulePath': module_path, 'request': {}})
            fake_stdout = io.StringIO()
            with patch('sys.stdin') as mock_stdin, patch('sys.stdout', fake_stdout):
                mock_stdin.read.return_value = payload
                with pytest.raises(SystemExit) as excinfo:
                    agent_runner.main()
            assert excinfo.value.code != 0
            parsed = json.loads(fake_stdout.getvalue())
            assert parsed[agent_runner.AGENT_EXECUTION_FAILURE_MARKER] is True
            assert parsed[agent_runner.GOVERNANCE_REFUSAL_MARKER] is True
            assert parsed['errorClass'] == 'LedgerError'
            assert 'response' not in parsed  # never laundered into a success
        finally:
            os.unlink(module_path)
            hook.drain_governance_refusals()

    def test_completed_turn_without_refusal_still_succeeds(self):
        """DOMAIN boundary: a turn that records NO refusal completes normally
        (a domain-level tool error the agent handled must NOT blanket-fail)."""
        import agent_runner
        import tool_idempotency_hook as hook
        hook.drain_governance_refusals()

        with tempfile.NamedTemporaryFile(mode='w', suffix='.py', delete=False) as f:
            f.write(
                "def handler(**kwargs):\n"
                "    return 'handled a tool error and finished'\n"
            )
            module_path = f.name
        try:
            payload = json.dumps({'modulePath': module_path, 'request': {}})
            fake_stdout = io.StringIO()
            with patch('sys.stdin') as mock_stdin, patch('sys.stdout', fake_stdout):
                mock_stdin.read.return_value = payload
                agent_runner.main()  # no SystemExit
            parsed = json.loads(fake_stdout.getvalue())
            assert parsed['response'] == 'handled a tool error and finished'
            assert MARKER not in parsed
        finally:
            os.unlink(module_path)


# ---------------------------------------------------------------------------
# STRUCTURAL guard now covers the tool-result/refusal path (exit code 0 is the
# completed-turn shape).
# ---------------------------------------------------------------------------
class TestStructuralGuardCoversRefusal:
    @pytest.mark.parametrize('returncode', [0, 1])
    @pytest.mark.parametrize('raise_on_error', [True, False])
    def test_refusal_envelope_always_raises(self, returncode, raise_on_error):
        with patch.dict('os.environ', _NODE_ENV):
            index = _fresh_index()
            with pytest.raises(index.AgentExecutionError) as excinfo:
                index._interpret_agent_result(
                    returncode,
                    _refusal_stdout(error_class='OutcomeIndeterminateError',
                                    message='reserve transport error'),
                    raise_on_error=raise_on_error,
                )
        assert excinfo.value.error_class == 'OutcomeIndeterminateError'
        assert 'reserve transport error' in excinfo.value.message


# ---------------------------------------------------------------------------
# Full worker path: refusal envelope => node.failed (never completed) + the
# emitted error CLASS drives retry classification (execution then fails).
# ---------------------------------------------------------------------------
class TestWorkerEmitsNodeFailedOnRefusal:
    def test_refusal_emits_node_failed_not_completed_with_retry_class(self):
        mock_result = MagicMock(
            returncode=1,
            stdout=_refusal_stdout(error_class='LedgerError',
                                   message='ledger fenced reserve transport error'),
            stderr='',
        )
        table = MagicMock()
        events = MagicMock()
        events.put_events.return_value = {'FailedEntryCount': 0}
        resource_mock = MagicMock()
        resource_mock.Table.return_value = table

        with patch.dict('os.environ', _NODE_ENV):
            index = _fresh_index()
            with patch('boto3.resource', return_value=resource_mock), \
                 patch('boto3.client', return_value=events):
                with patch.object(index, 'load_config_from_dynamodb',
                                  return_value={'config': {'filename': 'agent.py'}}), \
                     patch.object(index, 'get_scoped_credentials', return_value=None), \
                     patch.object(index, 'load_file_from_s3_into_tmp'), \
                     patch('subprocess.run', return_value=mock_result):
                    index.process_event(dict(NODE_MESSAGE), {})

        entry = events.put_events.call_args.kwargs['Entries'][0]
        assert entry['DetailType'] == 'workflow.node.failed'
        detail = json.loads(entry['Detail'])
        assert detail['status'] == 'failed'
        assert detail['nodeId'] == 'smoke-1'
        assert detail['error'] == 'LedgerError'
        # No completed nodeResults persist (would make the run terminal-success).
        table.update_item.assert_not_called()

        # The emitted class is the retry.py classification key.
        sys.path.insert(0, os.path.join(os.path.dirname(__file__), '..', '..', 'stepRunner'))
        from retry import should_retry
        assert should_retry('LedgerError', ['LedgerError'], 0, 3) is True
        assert should_retry('LedgerError', ['OtherError'], 0, 3) is False
