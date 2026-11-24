"""Tests for the agent entrypoint invocation contract (worker defect: a
``TypeError: handler() missing 1 required positional argument: 'event'`` was
raised with only a single structured log line and no traceback).

Covers two changes to ``agent_runner.main()``:

1. Invocation errors raised by the agent's entry function must log the full
   traceback (structured field ``traceback``), the resolved entrypoint name,
   and its ``inspect.signature`` string, alongside the existing message.
2. The entry function is invoked according to its signature (via
   ``inspect.signature``): zero params -> ``f()``; one -> ``f(event)``; two
   -> ``f(event, context)``; more positional params or a bare ``*args`` ->
   ``f(event, context)`` if the signature accepts it, else a
   ``ContractError`` naming the signature.
"""

from __future__ import annotations

import importlib.util
import io
import json
import sys
import os
import types
from unittest.mock import MagicMock, patch

sys.path.insert(0, os.path.join(os.path.dirname(__file__), '..'))

import agent_runner


def _run_main(module, *, request=None):
    """Run agent_runner.main() with a prebuilt fake agent module, patched
    stdin/stdout, and the installer side-effects (tool hooks, model
    override, usage capture) disabled. Returns (stdout_text, exit_code).
    """
    stdin_payload = json.dumps({
        'modulePath': '/tmp/fake_module.py',
        'request': request if request is not None else {'foo': 'bar'},
    })
    captured_stdout = io.StringIO()
    exit_code = {'code': None}

    def _fake_exit(code=0):
        exit_code['code'] = code
        raise SystemExit(code)

    with (
        patch('sys.stdin', io.StringIO(stdin_payload)),
        patch('sys.stdout', captured_stdout),
        patch.object(agent_runner, '_install_tool_call_hooks', return_value=False),
        patch.object(agent_runner, '_install_model_override', return_value=False),
        patch.object(agent_runner, '_install_usage_capture', return_value=False),
        patch.object(agent_runner.sys, 'exit', side_effect=_fake_exit),
        patch('importlib.util.spec_from_file_location') as mock_spec,
    ):
        mock_loader = MagicMock()
        mock_loader.exec_module = lambda m: None
        spec_obj = MagicMock()
        spec_obj.loader = mock_loader
        mock_spec.return_value = spec_obj

        with patch('importlib.util.module_from_spec', return_value=module):
            try:
                agent_runner.main()
            except SystemExit:
                pass

    return captured_stdout.getvalue().strip(), exit_code['code']


class TestTracebackLogging:
    """Invocation errors log the full traceback + resolved entrypoint info."""

    def test_handler_exception_logs_traceback_field(self, caplog):
        """A handler that raises logs a structured record carrying a
        non-empty 'traceback' field (caplog.records[i].__dict__)."""
        module = types.ModuleType('agent_module')

        def handler(event):
            raise ValueError('boom')

        module.handler = handler

        with caplog.at_level('ERROR', logger='agent_runner'):
            _run_main(module, request={'foo': 'bar'})

        records_with_tb = [
            r for r in caplog.records if getattr(r, 'traceback', None)
        ]
        assert records_with_tb, 'expected a log record carrying a traceback field'
        tb_text = records_with_tb[0].traceback
        assert 'ValueError' in tb_text
        assert 'boom' in tb_text
        assert 'Traceback' in tb_text

    def test_handler_exception_logs_entrypoint_name_and_signature(self, caplog):
        """The log record names the resolved entrypoint ('handler') and its
        inspect.signature string."""
        module = types.ModuleType('agent_module')

        def handler(event):
            raise ValueError('boom')

        module.handler = handler

        with caplog.at_level('ERROR', logger='agent_runner'):
            _run_main(module, request={'foo': 'bar'})

        records = [r for r in caplog.records if getattr(r, 'traceback', None)]
        assert records
        rec = records[0]
        assert getattr(rec, 'entrypoint', None) == 'handler'
        sig = getattr(rec, 'signature', '')
        assert 'event' in sig

    def test_handler_exception_still_builds_failure_envelope(self):
        """The existing failure-envelope behaviour (stdout marker + exit 1)
        is unchanged — only logging is extended."""
        module = types.ModuleType('agent_module')

        def handler(event):
            raise ValueError('boom')

        module.handler = handler

        stdout_text, exit_code = _run_main(module, request={'foo': 'bar'})
        envelope = json.loads(stdout_text)
        assert envelope[agent_runner.AGENT_EXECUTION_FAILURE_MARKER] is True
        assert envelope['errorClass'] == 'ValueError'
        assert exit_code == 1


class TestSignatureBasedInvocation:
    """The entry function is invoked according to its inspect.signature."""

    def test_zero_param_main_still_works(self):
        """A zero-parameter entry function (main()) is invoked with no args."""
        module = types.ModuleType('agent_module')
        calls = []

        def main():
            calls.append(())
            return 'ok-zero'

        module.handler = main

        stdout_text, exit_code = _run_main(module, request={'foo': 'bar'})
        envelope = json.loads(stdout_text)
        assert envelope['response'] == 'ok-zero'
        assert calls == [()]

    def test_one_param_handler_receives_event_payload(self):
        """A one-parameter handler(event) receives the full event/request
        dict as a single positional argument (the defect under test:
        formerly called as module.handler(**request), raising TypeError
        when the param name did not match a request key)."""
        module = types.ModuleType('agent_module')
        received = {}

        def handler(event):
            received['event'] = event
            return 'ok-one'

        module.handler = handler

        request = {'foo': 'bar', 'baz': 1}
        stdout_text, exit_code = _run_main(module, request=request)
        envelope = json.loads(stdout_text)
        assert envelope['response'] == 'ok-one'
        assert received['event'] == request

    def test_two_param_handler_receives_event_and_context(self):
        """A two-parameter handler(event, context) receives both: the
        request dict and a context object/value."""
        module = types.ModuleType('agent_module')
        received = {}

        def handler(event, context):
            received['event'] = event
            received['context'] = context
            return 'ok-two'

        module.handler = handler

        request = {'foo': 'bar'}
        stdout_text, exit_code = _run_main(module, request=request)
        envelope = json.loads(stdout_text)
        assert envelope['response'] == 'ok-two'
        assert received['event'] == request
        # context must be provided (not None-shaped as the event itself)
        assert 'context' in received

    def test_three_positional_signature_produces_clear_contract_error(self, caplog):
        """A handler with 3 required positional params (and no *args) is
        not callable under the (event) / (event, context) contract and must
        raise a clear ContractError naming the signature — not a bare
        TypeError with no explanation."""
        module = types.ModuleType('agent_module')

        def handler(event, context, extra):
            return 'should-not-run'

        module.handler = handler

        with caplog.at_level('ERROR', logger='agent_runner'):
            stdout_text, exit_code = _run_main(module, request={'foo': 'bar'})

        envelope = json.loads(stdout_text)
        assert envelope[agent_runner.AGENT_EXECUTION_FAILURE_MARKER] is True
        assert envelope['errorClass'] == 'ContractError'
        assert 'event' in envelope['error']
        assert 'context' in envelope['error']
        assert 'extra' in envelope['error']
        assert exit_code == 1

    def test_kwargs_style_handler_backward_compatible(self):
        """Existing **kwargs-style agents (the pre-existing, still-passing
        test_agent_runner_properties.py / test_usage_capture_properties.py
        fixture shape: ``def handler(**kwargs)``) keep working — a
        zero-positional-param, **kwargs-accepting signature is still invoked
        with the request dict unpacked as keyword arguments, preserving
        current behaviour for the kind that already passes arguments this
        way."""
        module = types.ModuleType('agent_module')
        received = {}

        def handler(**kwargs):
            received.update(kwargs)
            return f"squared:{kwargs['x'] * kwargs['x']}"

        module.handler = handler

        stdout_text, exit_code = _run_main(module, request={'x': 4})
        envelope = json.loads(stdout_text)
        assert envelope['response'] == 'squared:16'
        assert received['x'] == 4

    def test_named_scalar_handler_bound_by_key_preserved(self):
        """Regression (verify loop iteration 1): fabricated agents with a
        SINGLE NAMED parameter matching the llm_tool_schema key (e.g.
        ``def handler(email_address: str)``, ``def handler(x: int)`` — see
        arbiter/fabricator/index.py's templates/examples) must keep
        receiving the request value BY NAME, not the whole request dict
        positionally. The old unconditional ``handler(**request)`` bound by
        name; a naive "1 positional param -> func(request)" rule regresses
        this, since these ARE single positional-or-keyword params."""
        module = types.ModuleType('agent_module')
        received = {}

        def handler(email_address: str):
            received['email_address'] = email_address
            return f"validated:{email_address}"

        module.handler = handler

        stdout_text, exit_code = _run_main(
            module, request={'email_address': 'a@b.com'}
        )
        envelope = json.loads(stdout_text)
        assert envelope['response'] == 'validated:a@b.com'
        # Must be the scalar string, never the whole request dict.
        assert received['email_address'] == 'a@b.com'

    def test_named_scalar_int_handler_bound_by_key_preserved(self):
        """Same regression as above with a non-string scalar
        (``def handler(x: int)``, the square-root example template) — binds
        by key, so the handler body's ``x * x`` arithmetic never sees a
        dict."""
        module = types.ModuleType('agent_module')
        received = {}

        def handler(x: int):
            received['x'] = x
            return f"squared:{x * x}"

        module.handler = handler

        stdout_text, exit_code = _run_main(module, request={'x': 4})
        envelope = json.loads(stdout_text)
        assert envelope['response'] == 'squared:16'
        assert received['x'] == 4

    def test_event_shaped_single_param_with_nonmatching_keys_gets_whole_dict(self):
        """A single-param handler whose param name does NOT match any
        request key (the original defect's shape: ``def handler(event)``
        called with ``{'foo': 'bar'}``) must fall through the bind-by-key
        rule (which cannot succeed — no key is named 'event') and still
        receive the whole request dict positionally, exactly as the
        existing one-param test already covers for a plain name, confirming
        the bind-by-key priority ordering does not break the base case."""
        module = types.ModuleType('agent_module')
        received = {}

        def handler(event):
            received['event'] = event
            return 'ok-event-shaped'

        module.handler = handler

        request = {'foo': 'bar', 'baz': 1}
        stdout_text, exit_code = _run_main(module, request=request)
        envelope = json.loads(stdout_text)
        assert envelope['response'] == 'ok-event-shaped'
        assert received['event'] == request

    def test_two_param_handler_with_nonmatching_keys_gets_event_and_none(self):
        """A two-param ``(event, context)`` handler whose param names do not
        match request keys falls through bind-by-key and receives
        ``(request, None)``, as covered generally by
        ``test_two_param_handler_receives_event_and_context`` — pinned again
        here alongside the bind-by-key regression tests for the specific
        non-matching-keys case."""
        module = types.ModuleType('agent_module')
        received = {}

        def handler(event, context):
            received['event'] = event
            received['context'] = context
            return 'ok-two-nonmatching'

        module.handler = handler

        request = {'foo': 'bar'}
        stdout_text, exit_code = _run_main(module, request=request)
        envelope = json.loads(stdout_text)
        assert envelope['response'] == 'ok-two-nonmatching'
        assert received['event'] == request
        assert received['context'] is None
