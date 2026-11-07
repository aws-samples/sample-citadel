"""Tests for agent_runner response serialisation fix.

Validates that:
  - A dict response is serialised as valid JSON (json.loads round-trip).
  - A list response is serialised as valid JSON.
  - A plain string response is passed through as-is.
  - The echo agent's ``{}`` dict return becomes a JSON string, not a repr.
"""

import sys
import os
import json
import io
from unittest.mock import patch, MagicMock
import importlib.util
import types

sys.path.insert(0, os.path.join(os.path.dirname(__file__), '..'))

import agent_runner


class TestResponseSerialisation:
    """agent_runner.main() serialises dict/list returns as JSON, not repr."""

    def _run_main_with_response(self, handler_return):
        """Helper: run agent_runner.main() with a mock agent module that
        returns ``handler_return``, capture stdout, return parsed envelope."""
        mock_module = types.ModuleType('agent_module')
        mock_module.handler = lambda **kwargs: handler_return

        stdin_payload = json.dumps({
            'modulePath': '/tmp/fake_module.py',
            'request': {},
        })

        captured_stdout = io.StringIO()

        with (
            patch('sys.stdin', io.StringIO(stdin_payload)),
            patch('sys.stdout', captured_stdout),
            patch.object(agent_runner, '_install_tool_call_hooks', return_value=False),
            patch.object(agent_runner, '_install_model_override', return_value=False),
            patch.object(agent_runner, '_install_usage_capture', return_value=False),
            patch('importlib.util.spec_from_file_location') as mock_spec,
        ):
            mock_loader = MagicMock()
            mock_loader.exec_module = lambda m: None
            spec_obj = MagicMock()
            spec_obj.loader = mock_loader
            mock_spec.return_value = spec_obj

            with patch('importlib.util.module_from_spec', return_value=mock_module):
                agent_runner.main()

        raw = captured_stdout.getvalue().strip()
        return json.loads(raw)

    def test_dict_response_is_valid_json(self):
        """A dict response round-trips through json.loads."""
        envelope = self._run_main_with_response({'route': 'branch-a'})
        response_str = envelope['response']
        parsed = json.loads(response_str)
        assert parsed == {'route': 'branch-a'}

    def test_list_response_is_valid_json(self):
        """A list response round-trips through json.loads."""
        envelope = self._run_main_with_response([1, 2, 3])
        response_str = envelope['response']
        parsed = json.loads(response_str)
        assert parsed == [1, 2, 3]

    def test_string_response_passed_through(self):
        """A plain string response is stored as-is."""
        envelope = self._run_main_with_response('hello world')
        assert envelope['response'] == 'hello world'

    def test_empty_dict_response_is_json(self):
        """The echo agent's empty dict ``{}`` becomes a JSON string."""
        envelope = self._run_main_with_response({})
        response_str = envelope['response']
        parsed = json.loads(response_str)
        assert parsed == {}

    def test_nested_dict_response(self):
        """A nested dict is serialised as valid JSON."""
        payload = {'data': {'status': 'ok', 'count': 42}}
        envelope = self._run_main_with_response(payload)
        response_str = envelope['response']
        parsed = json.loads(response_str)
        assert parsed == payload

    def test_dict_response_not_python_repr(self):
        """A dict response must NOT use Python repr (single quotes)."""
        envelope = self._run_main_with_response({'key': 'value'})
        response_str = envelope['response']
        # Python repr would produce {'key': 'value'} with single quotes
        # JSON uses double quotes: {"key": "value"}
        assert response_str.startswith('{')
        assert '"key"' in response_str
        assert "'" not in response_str or response_str == json.dumps({'key': 'value'})
