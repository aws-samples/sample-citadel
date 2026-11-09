"""Tests for JSON-string auto-parsing in condition.resolve_field_path
and the executor's condition_evaluated reason/actual diagnostics.

Validates that:
  - resolve_field_path parses a JSON string at an intermediate step.
  - A Python repr string (not valid JSON) returns None.
  - evaluate_condition matches when the response is a JSON string.
  - The executor emits reason='output_not_json' for repr-string outputs.
  - The executor emits reason='field_missing' when the key does not exist.
  - The executor emits actual on success (no reason).
"""

import sys
import os
import json
from unittest.mock import MagicMock, patch

sys.path.insert(0, os.path.join(os.path.dirname(__file__), '..'))

from condition import evaluate_condition, resolve_field_path
import executor


def _mock_executions_table():
    return MagicMock()


def _capture_log_events(capsys):
    out = capsys.readouterr().out
    lines = [line.strip() for line in out.strip().split('\n') if line.strip()]
    events = []
    for line in lines:
        try:
            events.append(json.loads(line))
        except json.JSONDecodeError:
            pass
    return events


class TestResolveFieldPathJsonParsing:
    """resolve_field_path auto-parses JSON strings during traversal."""

    def test_parses_json_string_value(self):
        """A JSON-encoded dict at an intermediate step is parsed and traversed."""
        obj = {'response': json.dumps({'route': 'branch-a'})}
        assert resolve_field_path(obj, 'response.route') == 'branch-a'

    def test_nested_json_string(self):
        """A JSON-encoded nested dict is parsed correctly."""
        obj = {'result': json.dumps({'data': {'status': 'ok'}})}
        assert resolve_field_path(obj, 'result.data.status') == 'ok'

    def test_python_repr_returns_none(self):
        """A Python repr string (not valid JSON) returns None."""
        obj = {'response': "{'route': 'branch-a'}"}
        assert resolve_field_path(obj, 'response.route') is None

    def test_plain_string_not_json_returns_none(self):
        """A plain non-JSON string returns None at the next path step."""
        obj = {'response': 'hello world'}
        assert resolve_field_path(obj, 'response.route') is None

    def test_dict_value_still_works(self):
        """A dict value (not a JSON string) still resolves normally."""
        obj = {'result': {'route': 'branch-b'}}
        assert resolve_field_path(obj, 'result.route') == 'branch-b'

    def test_json_array_string_returns_none_for_key(self):
        """A JSON array string has no dict keys to traverse."""
        obj = {'response': json.dumps([1, 2, 3])}
        assert resolve_field_path(obj, 'response.route') is None


class TestEvaluateConditionWithJsonString:
    """evaluate_condition works when the source_output contains JSON strings."""

    def test_equals_matches_json_string_field(self):
        """equals matches when the value is inside a JSON-encoded string."""
        output = {'response': json.dumps({'route': 'branch-a'})}
        condition = {'field': 'response.route', 'operator': 'equals', 'value': 'branch-a'}
        assert evaluate_condition(condition, output) is True

    def test_equals_no_match_json_string_field(self):
        """equals does not match when the JSON-encoded value differs."""
        output = {'response': json.dumps({'route': 'branch-b'})}
        condition = {'field': 'response.route', 'operator': 'equals', 'value': 'branch-a'}
        assert evaluate_condition(condition, output) is False

    def test_equals_fails_with_repr_string(self):
        """equals returns False when the value is a Python repr (not JSON)."""
        output = {'response': "{'route': 'branch-a'}"}
        condition = {'field': 'response.route', 'operator': 'equals', 'value': 'branch-a'}
        assert evaluate_condition(condition, output) is False

    def test_exists_true_for_json_string(self):
        """exists returns True for a field inside a JSON-encoded string."""
        output = {'response': json.dumps({'route': 'x'})}
        condition = {'field': 'response.route', 'operator': 'exists', 'value': None}
        assert evaluate_condition(condition, output) is True

    def test_exists_false_for_repr_string(self):
        """exists returns False for a field inside a Python repr string."""
        output = {'response': "{'route': 'x'}"}
        condition = {'field': 'response.route', 'operator': 'exists', 'value': None}
        assert evaluate_condition(condition, output) is False


class TestExecutorConditionDiagnostics:
    """Executor emits reason/actual in condition_evaluated log events."""

    def test_actual_present_on_match(self, capsys):
        """condition_evaluated carries actual value when condition matches."""
        mock_table = _mock_executions_table()
        with patch.object(executor, '_executions_table', mock_table):
            edges = [{
                'id': 'e1', 'source': 'r', 'target': 'a',
                'condition': {'field': 'result.route', 'operator': 'equals', 'value': 'branch-a'},
            }]
            output = {'result': {'route': 'branch-a'}}
            node_results = {'r': {'status': 'completed'}, 'a': {'status': 'pending'}}
            executor._evaluate_and_persist_skips('exec-1', 'r', output, edges, node_results)

        events = _capture_log_events(capsys)
        ce = [e for e in events if e.get('action') == 'condition_evaluated']
        assert len(ce) == 1
        assert ce[0]['actual'] == 'branch-a'
        assert ce[0]['matched'] is True
        # reason should be absent (None filtered by _log_event)
        assert 'reason' not in ce[0]

    def test_reason_output_not_json_for_repr_string(self, capsys):
        """condition_evaluated carries reason='output_not_json' for repr strings."""
        mock_table = _mock_executions_table()
        with patch.object(executor, '_executions_table', mock_table):
            edges = [{
                'id': 'e1', 'source': 'r', 'target': 'a',
                'condition': {'field': 'response.route', 'operator': 'equals', 'value': 'branch-a'},
            }]
            # Simulate pre-fix worker output: Python repr, not JSON
            output = {'response': "{'route': 'branch-a'}"}
            node_results = {'r': {'status': 'completed'}, 'a': {'status': 'pending'}}
            executor._evaluate_and_persist_skips('exec-1', 'r', output, edges, node_results)

        events = _capture_log_events(capsys)
        ce = [e for e in events if e.get('action') == 'condition_evaluated']
        assert len(ce) == 1
        assert ce[0]['matched'] is False
        assert ce[0].get('reason') == 'output_not_json'

    def test_reason_field_missing_for_absent_key(self, capsys):
        """condition_evaluated carries reason='output_not_json' when the
        envelope's response is a non-JSON string (the worker returned a
        plain-text answer instead of structured JSON)."""
        mock_table = _mock_executions_table()
        with patch.object(executor, '_executions_table', mock_table):
            edges = [{
                'id': 'e1', 'source': 'r', 'target': 'a',
                'condition': {'field': 'result.route', 'operator': 'equals', 'value': 'branch-a'},
            }]
            # Worker envelope with non-JSON response
            output = {'response': 'hello'}
            node_results = {'r': {'status': 'completed'}, 'a': {'status': 'pending'}}
            executor._evaluate_and_persist_skips('exec-1', 'r', output, edges, node_results)

        events = _capture_log_events(capsys)
        ce = [e for e in events if e.get('action') == 'condition_evaluated']
        assert len(ce) == 1
        assert ce[0]['matched'] is False
        assert ce[0].get('reason') == 'output_not_json'

    def test_reason_field_missing_for_non_envelope_output(self, capsys):
        """condition_evaluated carries reason='field_missing' when output
        is not a worker envelope and the key is absent."""
        mock_table = _mock_executions_table()
        with patch.object(executor, '_executions_table', mock_table):
            edges = [{
                'id': 'e1', 'source': 'r', 'target': 'a',
                'condition': {'field': 'result.route', 'operator': 'equals', 'value': 'branch-a'},
            }]
            # Non-envelope output: extra keys beyond response/usage
            output = {'status': 'done', 'data': 'something'}
            node_results = {'r': {'status': 'completed'}, 'a': {'status': 'pending'}}
            executor._evaluate_and_persist_skips('exec-1', 'r', output, edges, node_results)

        events = _capture_log_events(capsys)
        ce = [e for e in events if e.get('action') == 'condition_evaluated']
        assert len(ce) == 1
        assert ce[0]['matched'] is False
        assert ce[0].get('reason') == 'field_missing'

    def test_json_string_resolves_with_actual(self, capsys):
        """condition_evaluated resolves actual from a JSON-encoded string."""
        mock_table = _mock_executions_table()
        with patch.object(executor, '_executions_table', mock_table):
            edges = [{
                'id': 'e1', 'source': 'r', 'target': 'a',
                'condition': {'field': 'response.route', 'operator': 'equals', 'value': 'branch-a'},
            }]
            # Post-fix worker output: JSON string
            output = {'response': json.dumps({'route': 'branch-a'})}
            node_results = {'r': {'status': 'completed'}, 'a': {'status': 'pending'}}
            executor._evaluate_and_persist_skips('exec-1', 'r', output, edges, node_results)

        events = _capture_log_events(capsys)
        ce = [e for e in events if e.get('action') == 'condition_evaluated']
        assert len(ce) == 1
        assert ce[0]['matched'] is True
        assert ce[0]['actual'] == 'branch-a'
        assert 'reason' not in ce[0]
