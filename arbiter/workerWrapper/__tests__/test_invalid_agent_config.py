"""
Malformed agent-record ``config`` handling (finding c4cb69f9).

The agent record's ``config`` field is stored in DynamoDB either as a native
dict/list value or as a JSON-encoded string (existing
``isinstance(config, str)`` convention). A cancelled prior attempt would
``json.loads`` a prose (non-JSON) string directly, letting an unclassified
``JSONDecodeError`` propagate:

* on the workflow-node path, an unclassified error class defers to the
  per-node ``retryableErrors`` author list instead of being taxonomically
  forbidden from retry;
* on the legacy supervisor-task path, the exception was caught only by
  ``lambda_handler``'s catch-all, which adds the SQS message to
  ``batchItemFailures`` — causing indefinite redelivery of a config that will
  never parse.

Both call sites now route through ``index._parse_agent_config``, which logs
agentId + field name + a hard-capped 200-char value slice, then raises
``InvalidAgentConfigError`` — a class name ``failure_taxonomy`` maps to
``FailureClass.INVALID_AGENT_CONFIG`` (disposition ``NEVER``).

All AWS (boto3) is mocked; no real network or credentials.
"""

import json
import sys
from unittest.mock import patch, MagicMock

import pytest


_ENV = {
    'AGENT_CONFIG_TABLE': 'test-table',
    'AGENT_BUCKET_NAME': 'test-bucket',
    'COMPLETION_BUS_NAME': 'citadel-agents-test',
}

_PROSE_CONFIG = "this is not json at all, just prose"


def _fresh_index():
    sys.modules.pop('index', None)
    import index
    return index


# ---------------------------------------------------------------------------
# _parse_agent_config: unit-level behaviour and logging
# ---------------------------------------------------------------------------


class TestParseAgentConfigUnit:
    def test_dict_config_passes_through_unchanged(self):
        index = _fresh_index()
        cfg = {'filename': 'agent.py'}
        assert index._parse_agent_config(cfg, agent_id='a1') is cfg

    def test_valid_json_string_config_is_parsed(self):
        index = _fresh_index()
        cfg = json.dumps({'filename': 'agent.py'})
        assert index._parse_agent_config(cfg, agent_id='a1') == {'filename': 'agent.py'}

    def test_prose_config_raises_invalid_agent_config_error(self):
        index = _fresh_index()
        with pytest.raises(index.InvalidAgentConfigError):
            index._parse_agent_config(_PROSE_CONFIG, agent_id='agent-A')

    def test_non_object_json_raises_invalid_agent_config_error(self):
        """A string that parses to valid JSON but not an object (e.g. a bare
        JSON array or number) is still an invalid agent config."""
        index = _fresh_index()
        with pytest.raises(index.InvalidAgentConfigError):
            index._parse_agent_config(json.dumps([1, 2, 3]), agent_id='agent-A')

    def test_prose_config_logs_agent_id_and_truncated_value(self, capsys):
        index = _fresh_index()
        long_prose = "x" * 500
        with pytest.raises(index.InvalidAgentConfigError):
            index._parse_agent_config(long_prose, agent_id='agent-A', field_name='config')

        out = capsys.readouterr().out
        log_lines = [json.loads(line) for line in out.strip().splitlines() if line.strip()]
        invalid_logs = [l for l in log_lines if l.get('action') == 'invalid_agent_config']
        assert len(invalid_logs) == 1
        entry = invalid_logs[0]
        assert entry['agentId'] == 'agent-A'
        assert entry['field'] == 'config'
        # Never more than 200 chars of the offending value, even though the
        # input was 500 chars long.
        assert len(entry['value']) == 200
        assert entry['value'] == long_prose[:200]

    def test_short_prose_config_logs_value_in_full_under_cap(self, capsys):
        index = _fresh_index()
        with pytest.raises(index.InvalidAgentConfigError):
            index._parse_agent_config(_PROSE_CONFIG, agent_id='agent-B', field_name='config')

        out = capsys.readouterr().out
        log_lines = [json.loads(line) for line in out.strip().splitlines() if line.strip()]
        entry = next(l for l in log_lines if l.get('action') == 'invalid_agent_config')
        assert entry['value'] == _PROSE_CONFIG
        assert len(entry['value']) < 200


# ---------------------------------------------------------------------------
# Taxonomy classification of the raised exception
# ---------------------------------------------------------------------------


class TestInvalidAgentConfigErrorClassifiesAsNeverRetry:
    def test_error_classname_classifies_to_invalid_agent_config(self):
        from common import failure_taxonomy as ft

        index = _fresh_index()
        try:
            index._parse_agent_config(_PROSE_CONFIG, agent_id='agent-A')
        except index.InvalidAgentConfigError as exc:
            assert ft.classify(type(exc).__name__) is ft.FailureClass.INVALID_AGENT_CONFIG
            assert ft.disposition(ft.FailureClass.INVALID_AGENT_CONFIG) is ft.RetryDisposition.NEVER
            assert ft.is_auto_retryable(ft.FailureClass.INVALID_AGENT_CONFIG) is False
            assert ft.is_retry_forbidden_by_taxonomy(type(exc).__name__) is True
        else:
            pytest.fail("expected InvalidAgentConfigError")


# ---------------------------------------------------------------------------
# Workflow-node dispatch path (_process_workflow_node)
# ---------------------------------------------------------------------------


def _workflow_msg():
    return {
        'message_type': 'workflow_node',
        'execution_id': 'exec-1',
        'node_id': 'n0',
        'workflow_id': 'wf-1',
        'agent_id': 'agent-A',
        'input': {'taskDetails': 'do the thing'},
        'configuration': {},
    }


class TestWorkflowNodePathProseConfig:
    def test_prose_config_fails_node_never_retry_and_acks(self):
        mock_events = MagicMock()
        mock_events.put_events.return_value = {'FailedEntryCount': 0}

        with patch.dict('os.environ', _ENV):
            with patch('boto3.resource'), patch('boto3.client', return_value=mock_events):
                index = _fresh_index()
                with patch.object(
                    index, 'load_config_from_dynamodb',
                    return_value={'config': _PROSE_CONFIG},
                ), patch.object(index, 'get_scoped_credentials', return_value=None):
                    # Should not raise: the generic except-block in
                    # _process_workflow_node catches InvalidAgentConfigError,
                    # classifies it, emits a failed node result, and returns
                    # (SQS message acked, never added to batchItemFailures).
                    index.process_event(_workflow_msg(), {})

        # A node.failed result was emitted with the classified error.
        assert mock_events.put_events.called
        entry = mock_events.put_events.call_args.kwargs['Entries'][0]
        detail = json.loads(entry['Detail'])
        assert detail['status'] == 'failed'
        assert detail['error'] == 'InvalidAgentConfigError'

    def test_prose_config_does_not_reach_subprocess(self):
        mock_events = MagicMock()
        mock_events.put_events.return_value = {'FailedEntryCount': 0}

        with patch.dict('os.environ', _ENV):
            with patch('boto3.resource'), patch('boto3.client', return_value=mock_events):
                index = _fresh_index()
                with patch.object(
                    index, 'load_config_from_dynamodb',
                    return_value={'config': _PROSE_CONFIG},
                ), patch.object(index, 'get_scoped_credentials', return_value=None), \
                        patch.object(index, 'run_agent_in_subprocess') as mock_run:
                    index.process_event(_workflow_msg(), {})

        mock_run.assert_not_called()


# ---------------------------------------------------------------------------
# Legacy supervisor-task path (process_agent_call, via lambda_handler)
# ---------------------------------------------------------------------------


def _sqs_record(message_id='msg-1'):
    return {
        'messageId': message_id,
        'body': json.dumps({
            'orchestration_id': 'orch-1',
            'agent_use_id': 'use-1',
            'agent_input': {'taskDetails': 'do it'},
            'node': 'agent-A',
        }),
    }


class TestLegacyPathProseConfig:
    def test_prose_config_is_acked_not_retried(self):
        """InvalidAgentConfigError on the legacy path must be swallowed by
        lambda_handler as a terminal, never-retry outcome — the SQS message
        must NOT appear in batchItemFailures (which would cause redelivery of
        a config that will never parse)."""
        with patch.dict('os.environ', _ENV):
            with patch('boto3.resource'), patch('boto3.client'):
                index = _fresh_index()
                with patch.object(
                    index, 'load_config_from_dynamodb',
                    return_value={'config': _PROSE_CONFIG},
                ):
                    result = index.lambda_handler(
                        {'Records': [_sqs_record('msg-1')]}, {}
                    )

        assert result['batchItemFailures'] == []

    def test_prose_config_logs_agent_id_and_truncated_value(self, capsys):
        with patch.dict('os.environ', _ENV):
            with patch('boto3.resource'), patch('boto3.client'):
                index = _fresh_index()
                with patch.object(
                    index, 'load_config_from_dynamodb',
                    return_value={'config': _PROSE_CONFIG},
                ):
                    index.lambda_handler({'Records': [_sqs_record('msg-1')]}, {})

        out = capsys.readouterr().out
        log_lines = []
        for line in out.strip().splitlines():
            try:
                log_lines.append(json.loads(line))
            except ValueError:
                continue
        entry = next(l for l in log_lines if l.get('action') == 'invalid_agent_config')
        assert entry['agentId'] == 'agent-A'
        assert entry['field'] == 'config'
        assert entry['value'] == _PROSE_CONFIG

    def test_other_records_in_batch_unaffected_by_invalid_config_record(self):
        """A genuinely transient failure on a sibling record still reports as
        a batch item failure (retry), while the invalid-config record does
        not — the two dispositions must not bleed into each other."""
        good_record = _sqs_record('msg-good')
        bad_record = _sqs_record('msg-bad')

        def fake_load_config(agent_id):
            return {'config': _PROSE_CONFIG}

        with patch.dict('os.environ', _ENV):
            with patch('boto3.resource'), patch('boto3.client'):
                index = _fresh_index()
                with patch.object(
                    index, 'load_config_from_dynamodb', side_effect=fake_load_config,
                ), patch.object(
                    index, 'process_event', side_effect=[RuntimeError('transient'), None]
                ) as mock_process:
                    result = index.lambda_handler(
                        {'Records': [good_record, bad_record]}, {}
                    )

        assert mock_process.call_count == 2
        failure_ids = {f['itemIdentifier'] for f in result['batchItemFailures']}
        assert failure_ids == {'msg-good'}
