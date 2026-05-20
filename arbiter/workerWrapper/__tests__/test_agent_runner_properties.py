"""
Property-based tests for arbiter/workerWrapper/agent_runner.py

Tests payload parsing from stdin and response serialization to stdout.
"""

import sys
import os
import json
import tempfile
from unittest.mock import patch, MagicMock

import pytest
from hypothesis import given, settings
from hypothesis import strategies as st

sys.path.insert(0, os.path.join(os.path.dirname(__file__), ".."))


# ---------------------------------------------------------------------------
# Strategies
# ---------------------------------------------------------------------------

request_dicts = st.dictionaries(
    st.text(min_size=1, max_size=20, alphabet=st.characters(
        whitelist_categories=("L", "N"),
    )),
    st.text(max_size=100),
    max_size=5,
)

handler_return_values = st.one_of(
    st.text(max_size=200),
    st.integers(min_value=-10**6, max_value=10**6),
    st.floats(min_value=-1e6, max_value=1e6, allow_nan=False, allow_infinity=False),
    st.dictionaries(st.text(max_size=20), st.text(max_size=50), max_size=3),
)


# ---------------------------------------------------------------------------
# agent_runner.main() payload parsing
# ---------------------------------------------------------------------------

class TestAgentRunnerMain:
    """Property tests for agent_runner.main stdin/stdout contract."""

    @given(
        request=request_dicts,
        return_value=st.text(max_size=200),
    )
    @settings(max_examples=50)
    def test_output_is_valid_json_with_response_key(self, request, return_value):
        """agent_runner always writes valid JSON with a 'response' key to stdout."""
        # Create a temporary module with a handler function
        with tempfile.NamedTemporaryFile(
            mode="w", suffix=".py", delete=False
        ) as f:
            f.write(
                f"def handler(**kwargs):\n"
                f"    return {repr(return_value)}\n"
            )
            module_path = f.name

        try:
            payload = json.dumps({
                "modulePath": module_path,
                "request": request,
            })

            captured_output = []

            with patch("sys.stdin") as mock_stdin, \
                 patch("builtins.print", side_effect=lambda s: captured_output.append(s)):
                mock_stdin.read.return_value = payload

                from agent_runner import main
                main()

            assert len(captured_output) == 1
            parsed = json.loads(captured_output[0])
            assert "response" in parsed
        finally:
            os.unlink(module_path)

    @given(request=request_dicts)
    @settings(max_examples=30)
    def test_handler_exception_produces_error_response(self, request):
        """When handler raises, output still contains a 'response' key."""
        with tempfile.NamedTemporaryFile(
            mode="w", suffix=".py", delete=False
        ) as f:
            f.write(
                "def handler(**kwargs):\n"
                "    raise RuntimeError('test error')\n"
            )
            module_path = f.name

        try:
            payload = json.dumps({
                "modulePath": module_path,
                "request": request,
            })

            captured_output = []

            with patch("sys.stdin") as mock_stdin, \
                 patch("builtins.print", side_effect=lambda s: captured_output.append(s)):
                mock_stdin.read.return_value = payload

                from agent_runner import main
                main()

            assert len(captured_output) == 1
            parsed = json.loads(captured_output[0])
            assert "response" in parsed
            assert "failed" in parsed["response"].lower() or "error" in parsed["response"].lower()
        finally:
            os.unlink(module_path)

    @given(request=request_dicts)
    @settings(max_examples=30)
    def test_request_kwargs_passed_to_handler(self, request):
        """Request dict is unpacked as kwargs to the handler function."""
        # Build a handler that returns its kwargs
        with tempfile.NamedTemporaryFile(
            mode="w", suffix=".py", delete=False
        ) as f:
            f.write(
                "def handler(**kwargs):\n"
                "    return str(sorted(kwargs.keys()))\n"
            )
            module_path = f.name

        try:
            payload = json.dumps({
                "modulePath": module_path,
                "request": request,
            })

            captured_output = []

            with patch("sys.stdin") as mock_stdin, \
                 patch("builtins.print", side_effect=lambda s: captured_output.append(s)):
                mock_stdin.read.return_value = payload

                from agent_runner import main
                main()

            parsed = json.loads(captured_output[0])
            expected_keys = str(sorted(request.keys()))
            assert parsed["response"] == expected_keys
        finally:
            os.unlink(module_path)
