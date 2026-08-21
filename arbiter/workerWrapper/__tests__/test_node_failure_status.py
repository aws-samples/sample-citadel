"""
Regression + invariant tests for finding 56d763d4 (HIGH): a crashed agent
execution must never be persisted as SUCCESS.

Ground truth (dev execution 350956fa): the agent body raised
"'dict' object can't be awaited"; ``agent_runner`` swallowed it into a
successful ``response`` string, the subprocess exited 0, and the worker
recorded node smoke-1 as ``status=completed`` / ``retryCount=0`` and finalized
the execution ``completed``. That starves retry.py's failure-class logic, the
durable-execution watchdog (the node is terminal-successful), and every
downstream pass/fail consumer.

These tests pin the corrected behavior:

* An agent-body exception surfaces as a FAILURE envelope carrying the error
  CLASS (``run_agent_in_subprocess`` raises ``AgentExecutionError``).
* The worker emits ``workflow.node.failed`` (never ``completed``) and never
  writes a completed nodeResults entry — even when the subprocess exit code is
  0 (the exact defect shape).
* The node-result ``error`` is the exception CLASS, so retry.py's
  ``should_retry`` (``error_type in retryableErrors``) can classify it.
* STRUCTURAL: the pure result-builder ``_interpret_agent_result`` can NEVER
  return a success value for a failure-marked payload, for any exit code /
  raise_on_error combination.

All AWS (boto3, subprocess) is mocked; no real network or credentials.
"""

import json
import sys
from unittest.mock import patch, MagicMock

import pytest


NODE_MESSAGE = {
    'message_type': 'workflow_node',
    'execution_id': 'exec-1',
    'node_id': 'smoke-1',
    'workflow_id': 'wf-1',
    'agent_id': 'agent-A',
    'input': {'taskDetails': 'do the thing'},
    'configuration': {},
}

SUPERVISOR_MESSAGE = {
    'orchestration_id': 'orch-1',
    'agent_use_id': 'use-1',
    'agent_input': {'taskDetails': 'do the thing'},
    'node': 'agent-A',
}

_NODE_ENV = {
    'AGENT_CONFIG_TABLE': 'test-table',
    'AGENT_BUCKET_NAME': 'test-bucket',
    'COMPLETION_BUS_NAME': 'citadel-agents-test',
    'EXECUTIONS_TABLE': 'citadel-executions-test',
}

# The exact ground-truth crash: a TypeError surfaced as "'dict' object can't
# be awaited". agent_runner stamps errorClass=<type name> in the envelope.
FAILURE_MARKER = 'agentExecutionFailed'


def _fresh_index():
    sys.modules.pop('index', None)
    import index
    return index


def _failure_stdout(error_class='TypeError',
                    message="'dict' object can't be awaited", usage=None):
    """Build the stdout envelope agent_runner writes when the agent body
    raises (the defect trigger)."""
    return json.dumps({
        FAILURE_MARKER: True,
        'errorClass': error_class,
        'error': message,
        'usage': usage or [],
    })


# ---------------------------------------------------------------------------
# The defect regression: exit code 0 + failure marker must NOT complete.
# ---------------------------------------------------------------------------

class TestCrashNeverCompletes:
    def test_exit_zero_failure_marker_emits_node_failed_not_completed(self):
        """THE defect (350956fa): the subprocess exits 0 with a success-shaped
        pipe, but the payload carries the agent-body failure marker. The OLD
        code emitted node.completed; the fix emits node.failed carrying the
        error CLASS, and writes NO completed nodeResults entry."""
        mock_result = MagicMock(returncode=0, stdout=_failure_stdout(), stderr='')
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
        # error field is the exception CLASS (retry.py classification key).
        assert detail['error'] == 'TypeError'
        assert 'output' not in detail
        # Crucially: NO completed nodeResults entry was written (a completed
        # persist would make the run terminal-successful again).
        table.update_item.assert_not_called()

    def test_emitted_error_class_drives_retry_classification(self):
        """The emitted node.failed error is the exact class string retry.py's
        should_retry matches on, so a RETRYABLE class retries instead of
        terminally succeeding."""
        mock_result = MagicMock(
            returncode=0, stdout=_failure_stdout(error_class='TimeoutError',
                                                 message='slow tool'), stderr='')
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

        detail = json.loads(events.put_events.call_args.kwargs['Entries'][0]['Detail'])
        emitted_error = detail['error']
        assert emitted_error == 'TimeoutError'

        # Feed the emitted class straight into retry.py's classifier (the same
        # function the executor's handle_node_failure calls).
        sys.path.insert(0, __import__('os').path.join(
            __import__('os').path.dirname(__file__), '..', '..', 'stepRunner'))
        from retry import should_retry
        assert should_retry(emitted_error, [emitted_error], 0, 3) is True
        assert should_retry(emitted_error, ['SomethingElse'], 0, 3) is False


# ---------------------------------------------------------------------------
# STRUCTURAL invariant: the result-builder cannot complete a marked payload.
# ---------------------------------------------------------------------------

class TestResultBuilderInvariant:
    @pytest.mark.parametrize('returncode', [0, 1, 137])
    @pytest.mark.parametrize('raise_on_error', [True, False])
    def test_failure_marker_always_raises(self, returncode, raise_on_error):
        """NO combination of exit code / raise_on_error can turn a
        failure-marked envelope into a success return value."""
        with patch.dict('os.environ', _NODE_ENV):
            index = _fresh_index()
            with pytest.raises(index.AgentExecutionError) as excinfo:
                index._interpret_agent_result(
                    returncode,
                    _failure_stdout(error_class='ValueError', message='bad input'),
                    raise_on_error=raise_on_error,
                )
        # The raised error carries the class (for retry classification) and
        # preserves the diagnostic message.
        assert excinfo.value.error_class == 'ValueError'
        assert 'bad input' in excinfo.value.message

    def test_failure_marker_still_collects_usage_then_raises(self):
        with patch.dict('os.environ', _NODE_ENV):
            index = _fresh_index()
            sink = []
            with pytest.raises(index.AgentExecutionError):
                index._interpret_agent_result(
                    0,
                    _failure_stdout(usage=[{'inputTokens': 3, 'outputTokens': 4}]),
                    raise_on_error=True,
                    usage_sink=sink,
                )
        assert sink == [{'inputTokens': 3, 'outputTokens': 4}]

    def test_success_envelope_still_returns_response(self):
        """Regression: a genuine success (no marker, exit 0) returns the
        response unchanged."""
        with patch.dict('os.environ', _NODE_ENV):
            index = _fresh_index()
            out = index._interpret_agent_result(
                0, json.dumps({'response': 'done', 'usage': []}),
                raise_on_error=True,
            )
        assert out == 'done'

    def test_nonzero_without_marker_preserves_raise_on_error_contract(self):
        """A subprocess-level crash (no marker) keeps the pre-fix contract:
        raise when raise_on_error, else the canned supervisor fallback."""
        with patch.dict('os.environ', _NODE_ENV):
            index = _fresh_index()
            # node path: raises
            with pytest.raises(index.AgentExecutionError):
                index._interpret_agent_result(1, '', raise_on_error=True)
            # supervisor path: canned fallback string
            out = index._interpret_agent_result(1, '', raise_on_error=False)
            assert 'could not be completed' in out

    def test_marker_constant_parity_between_producer_and_consumer(self):
        with patch.dict('os.environ', _NODE_ENV):
            index = _fresh_index()
            import agent_runner
            assert index.AGENT_EXECUTION_FAILURE_MARKER == \
                agent_runner.AGENT_EXECUTION_FAILURE_MARKER == FAILURE_MARKER


# ---------------------------------------------------------------------------
# Sibling swallow: the supervisor task path must not post a fake completion.
# ---------------------------------------------------------------------------

class TestSupervisorSiblingSwallow:
    def test_supervisor_agent_body_crash_does_not_post_task_completion(self):
        """A crashed supervisor agent (failure marker) must NOT be posted as a
        task.completion success — the marker raises and the completion post is
        never reached (SQS redelivery handles it)."""
        mock_result = MagicMock(returncode=1, stdout=_failure_stdout(), stderr='')
        events = MagicMock()
        events.put_events.return_value = {'FailedEntryCount': 0}
        resource_mock = MagicMock()
        resource_mock.Table.return_value = MagicMock()

        with patch.dict('os.environ', _NODE_ENV):
            index = _fresh_index()
            with patch('boto3.resource', return_value=resource_mock), \
                 patch('boto3.client', return_value=events):
                with patch.object(index, 'load_config_from_dynamodb',
                                  return_value={'config': {'filename': 'agent.py', 'tools': []}}), \
                     patch.object(index, 'get_scoped_credentials', return_value=None), \
                     patch.object(index, 'load_file_from_s3_into_tmp'), \
                     patch.object(index, 'build_subprocess_env', return_value={}), \
                     patch.object(index, 'post_task_complete') as mock_ptc, \
                     patch('subprocess.run', return_value=mock_result):
                    with pytest.raises(index.AgentExecutionError):
                        index.process_event(dict(SUPERVISOR_MESSAGE), {})

        mock_ptc.assert_not_called()
