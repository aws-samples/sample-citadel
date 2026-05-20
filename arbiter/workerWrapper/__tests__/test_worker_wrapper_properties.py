"""
Property-based tests for workerWrapper/index.py.

Tests cover:
- run_agent_in_subprocess: credential isolation, env handling
- post_task_complete: event structure invariants
- lambda_handler: batch failure reporting
- process_event: config string/dict handling
"""

import json
import os
import subprocess
from unittest.mock import patch, MagicMock, ANY

import pytest
from hypothesis import given, settings, assume, HealthCheck
from hypothesis import strategies as st


# ---------------------------------------------------------------------------
# Strategies
# ---------------------------------------------------------------------------

identifier_text = st.text(
    min_size=1, max_size=30,
    alphabet=st.characters(whitelist_categories=('L', 'N'), whitelist_characters='_-'),
)

description_text = st.text(min_size=1, max_size=200)

credential_strategy = st.one_of(
    st.none(),
    st.fixed_dictionaries({
        "accessKeyId": st.text(min_size=16, max_size=20, alphabet=st.characters(whitelist_categories=('Lu', 'N'))),
        "secretAccessKey": st.text(min_size=30, max_size=40, alphabet=st.characters(whitelist_categories=('L', 'N'))),
        "sessionToken": st.text(min_size=50, max_size=100, alphabet=st.characters(whitelist_categories=('L', 'N'))),
    }),
)

request_dicts = st.dictionaries(
    st.text(min_size=1, max_size=20, alphabet=st.characters(whitelist_categories=('L',))),
    st.text(min_size=0, max_size=100),
    min_size=0,
    max_size=5,
)


# ---------------------------------------------------------------------------
# run_agent_in_subprocess credential isolation properties
# ---------------------------------------------------------------------------

class TestRunAgentSubprocessProperties:
    """Properties of run_agent_in_subprocess credential handling."""

    @given(creds=credential_strategy, request=request_dicts)
    @settings(max_examples=50, suppress_health_check=[HealthCheck.too_slow])
    def test_scoped_credentials_injected_into_child_env(self, creds, request):
        """When scoped credentials are provided, they appear in the child env."""
        mock_result = MagicMock()
        mock_result.returncode = 0
        mock_result.stdout = json.dumps({"response": "ok"})
        mock_result.stderr = ""

        with patch.dict('os.environ', {
            'AGENT_CONFIG_TABLE': 'test-table',
            'CREDENTIAL_VENDER_FUNCTION': 'test-fn',
        }):
            with patch('boto3.resource'), patch('boto3.client'):
                import importlib
                import sys
                sys.modules.pop('index', None)
                import index

                with patch('subprocess.run', return_value=mock_result) as mock_run:
                    index.run_agent_in_subprocess(request, creds)

                    call_kwargs = mock_run.call_args[1]
                    child_env = call_kwargs['env']

                    if creds:
                        assert child_env['AWS_ACCESS_KEY_ID'] == creds['accessKeyId']
                        assert child_env['AWS_SECRET_ACCESS_KEY'] == creds['secretAccessKey']
                        assert child_env['AWS_SESSION_TOKEN'] == creds['sessionToken']
                    else:
                        # Credentials should be removed from child env
                        assert 'AWS_ACCESS_KEY_ID' not in child_env or \
                               child_env.get('AWS_ACCESS_KEY_ID') == os.environ.get('AWS_ACCESS_KEY_ID')

    @given(request=request_dicts)
    @settings(max_examples=30, suppress_health_check=[HealthCheck.too_slow])
    def test_parent_env_not_modified(self, request):
        """Parent os.environ is never modified by run_agent_in_subprocess."""
        mock_result = MagicMock()
        mock_result.returncode = 0
        mock_result.stdout = json.dumps({"response": "ok"})
        mock_result.stderr = ""

        original_env = os.environ.copy()

        creds = {
            "accessKeyId": "TESTKEY123456789",
            "secretAccessKey": "testsecret1234567890abcdefghij",
            "sessionToken": "t" * 50,
        }

        with patch.dict('os.environ', {
            'AGENT_CONFIG_TABLE': 'test-table',
            'CREDENTIAL_VENDER_FUNCTION': 'test-fn',
        }):
            with patch('boto3.resource'), patch('boto3.client'):
                import importlib
                import sys
                sys.modules.pop('index', None)
                import index

                with patch('subprocess.run', return_value=mock_result):
                    index.run_agent_in_subprocess(request, creds)

                # Verify parent env wasn't polluted with scoped creds
                assert os.environ.get('AWS_ACCESS_KEY_ID') != creds['accessKeyId']
                assert os.environ.get('AWS_SECRET_ACCESS_KEY') != creds['secretAccessKey']

    def test_nonzero_exit_returns_error_message(self):
        """Non-zero subprocess exit returns a fallback error message."""
        mock_result = MagicMock()
        mock_result.returncode = 1
        mock_result.stdout = ""
        mock_result.stderr = "some error"

        with patch.dict('os.environ', {
            'AGENT_CONFIG_TABLE': 'test-table',
            'CREDENTIAL_VENDER_FUNCTION': 'test-fn',
        }):
            with patch('boto3.resource'), patch('boto3.client'):
                import importlib
                import sys
                sys.modules.pop('index', None)
                import index

                with patch('subprocess.run', return_value=mock_result):
                    result = index.run_agent_in_subprocess({}, None)
                    assert "could not be completed" in result

    def test_invalid_json_stdout_returns_raw(self):
        """When subprocess stdout is not valid JSON, raw output is returned."""
        mock_result = MagicMock()
        mock_result.returncode = 0
        mock_result.stdout = "not json output"
        mock_result.stderr = ""

        with patch.dict('os.environ', {
            'AGENT_CONFIG_TABLE': 'test-table',
            'CREDENTIAL_VENDER_FUNCTION': 'test-fn',
        }):
            with patch('boto3.resource'), patch('boto3.client'):
                import importlib
                import sys
                sys.modules.pop('index', None)
                import index

                with patch('subprocess.run', return_value=mock_result):
                    result = index.run_agent_in_subprocess({}, None)
                    assert result == "not json output"

    def test_empty_stdout_returns_no_output_message(self):
        """When subprocess produces no output, a descriptive message is returned."""
        mock_result = MagicMock()
        mock_result.returncode = 0
        mock_result.stdout = ""
        mock_result.stderr = ""

        with patch.dict('os.environ', {
            'AGENT_CONFIG_TABLE': 'test-table',
            'CREDENTIAL_VENDER_FUNCTION': 'test-fn',
        }):
            with patch('boto3.resource'), patch('boto3.client'):
                import importlib
                import sys
                sys.modules.pop('index', None)
                import index

                with patch('subprocess.run', return_value=mock_result):
                    result = index.run_agent_in_subprocess({}, None)
                    assert result == "Agent produced no output"


# ---------------------------------------------------------------------------
# post_task_complete properties
# ---------------------------------------------------------------------------

class TestPostTaskCompleteProperties:
    """Properties of post_task_complete event structure."""

    @given(
        response=description_text,
        agent_use_id=identifier_text,
        agent_name=identifier_text,
        orchestration_id=st.uuids().map(str),
    )
    @settings(max_examples=50, suppress_health_check=[HealthCheck.too_slow])
    def test_event_has_required_fields(self, response, agent_use_id, agent_name, orchestration_id):
        """Published event always has Source, DetailType, EventBusName, Detail."""
        mock_events = MagicMock()
        mock_events.put_events.return_value = {"FailedEntryCount": 0}

        with patch.dict('os.environ', {
            'AGENT_CONFIG_TABLE': 'test-table',
            'CREDENTIAL_VENDER_FUNCTION': 'test-fn',
            'COMPLETION_BUS_NAME': 'test-bus',
        }):
            with patch('boto3.resource'), patch('boto3.client', return_value=mock_events):
                import importlib
                import sys
                sys.modules.pop('index', None)
                import index

                index.post_task_complete(response, agent_use_id, agent_name, orchestration_id)

                call_args = mock_events.put_events.call_args
                entries = call_args[1]['Entries']
                entry = entries[0]

                assert entry['Source'] == 'task.completion'
                assert entry['DetailType'] == 'task.completion'
                assert entry['EventBusName'] == 'test-bus'

                detail = json.loads(entry['Detail'])
                assert detail['orchestration_id'] == orchestration_id
                assert detail['agent_use_id'] == agent_use_id
                assert detail['node'] == agent_name
                assert f"Task completed" in detail['data']


# ---------------------------------------------------------------------------
# lambda_handler batch failure properties
# ---------------------------------------------------------------------------

class TestLambdaHandlerProperties:
    """Properties of lambda_handler batch failure handling."""

    @given(
        num_records=st.integers(min_value=1, max_value=5),
        fail_indices=st.frozensets(st.integers(min_value=0, max_value=4), max_size=5),
    )
    @settings(max_examples=50, suppress_health_check=[HealthCheck.too_slow])
    def test_batch_failures_reported_correctly(self, num_records, fail_indices):
        """Failed records are reported in batchItemFailures."""
        assume(all(i < num_records for i in fail_indices))

        records = []
        for i in range(num_records):
            records.append({
                "messageId": f"msg-{i}",
                "body": json.dumps({
                    "orchestration_id": "orch-1",
                    "agent_use_id": "use-1",
                    "agent_input": {"taskDetails": "test"},
                    "node": "test-agent",
                }),
            })

        call_count = [0]

        def mock_process(event, context):
            idx = call_count[0]
            call_count[0] += 1
            if idx in fail_indices:
                raise Exception(f"Simulated failure for record {idx}")

        with patch.dict('os.environ', {
            'AGENT_CONFIG_TABLE': 'test-table',
            'CREDENTIAL_VENDER_FUNCTION': 'test-fn',
            'COMPLETION_BUS_NAME': 'test-bus',
        }):
            with patch('boto3.resource'), patch('boto3.client'):
                import importlib
                import sys
                sys.modules.pop('index', None)
                import index

                with patch.object(index, 'process_event', side_effect=mock_process):
                    result = index.lambda_handler({"Records": records}, {})

                    assert "batchItemFailures" in result
                    failed_ids = {f["itemIdentifier"] for f in result["batchItemFailures"]}
                    expected_failed = {f"msg-{i}" for i in fail_indices}
                    assert failed_ids == expected_failed

    def test_empty_records_returns_empty_failures(self):
        """Empty Records list returns empty batchItemFailures."""
        with patch.dict('os.environ', {
            'AGENT_CONFIG_TABLE': 'test-table',
            'CREDENTIAL_VENDER_FUNCTION': 'test-fn',
        }):
            with patch('boto3.resource'), patch('boto3.client'):
                import importlib
                import sys
                sys.modules.pop('index', None)
                import index

                result = index.lambda_handler({"Records": []}, {})
                assert result == {"batchItemFailures": []}


# ---------------------------------------------------------------------------
# get_scoped_credentials properties
# ---------------------------------------------------------------------------

class TestGetScopedCredentialsProperties:
    """Properties of get_scoped_credentials."""

    def test_returns_none_without_vender_function(self):
        """Returns None when CREDENTIAL_VENDER_FUNCTION is not set."""
        with patch.dict('os.environ', {
            'AGENT_CONFIG_TABLE': 'test-table',
        }, clear=False):
            os.environ.pop('CREDENTIAL_VENDER_FUNCTION', None)
            with patch('boto3.resource'), patch('boto3.client'):
                import importlib
                import sys
                sys.modules.pop('index', None)
                import index

                result = index.get_scoped_credentials("agent1", {"actions": ["s3:GetObject"]})
                assert result is None

    def test_returns_none_without_permissions(self):
        """Returns None when required_permissions is empty/None."""
        with patch.dict('os.environ', {
            'AGENT_CONFIG_TABLE': 'test-table',
            'CREDENTIAL_VENDER_FUNCTION': 'test-fn',
        }):
            with patch('boto3.resource'), patch('boto3.client'):
                import importlib
                import sys
                sys.modules.pop('index', None)
                import index

                assert index.get_scoped_credentials("agent1", None) is None
                assert index.get_scoped_credentials("agent1", {}) is None
