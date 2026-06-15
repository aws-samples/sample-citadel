"""
Property-based tests for arbiter/seedConfig/cfnresponse.py

Tests that the CloudFormation custom resource response body is always
well-formed JSON with all required fields.
"""

import sys
import os
import json
from unittest.mock import patch, MagicMock

import pytest
from hypothesis import given, settings
from hypothesis import strategies as st

sys.path.insert(0, os.path.join(os.path.dirname(__file__), ".."))

from cfnresponse import send, SUCCESS, FAILED


# ---------------------------------------------------------------------------
# Strategies
# ---------------------------------------------------------------------------

response_statuses = st.sampled_from([SUCCESS, FAILED])

cfn_events = st.fixed_dictionaries({
    "ResponseURL": st.just("https://cfn-response.example.com/callback"),
    "StackId": st.text(min_size=1, max_size=80).map(
        lambda s: f"arn:aws:cloudformation:us-east-1:123456789012:stack/{s}"
    ),
    "RequestId": st.uuids().map(str),
    "LogicalResourceId": st.text(
        min_size=1, max_size=40,
        alphabet=st.characters(whitelist_categories=("L", "N")),
    ),
})

lambda_contexts = st.builds(
    lambda name: type("Context", (), {"log_stream_name": name})(),
    st.text(min_size=1, max_size=60),
)

response_data = st.dictionaries(
    st.text(min_size=1, max_size=20),
    st.text(max_size=100),
    max_size=5,
)


# ---------------------------------------------------------------------------
# send() response body
# ---------------------------------------------------------------------------

class TestCfnResponseSend:
    """Property tests for cfnresponse.send."""

    @given(
        event=cfn_events,
        context=lambda_contexts,
        status=response_statuses,
        data=response_data,
    )
    @settings(max_examples=100)
    def test_response_body_is_valid_json(self, event, context, status, data):
        """Response body sent to CFN is always valid JSON."""
        captured_body = {}

        mock_http = MagicMock()
        def capture_request(method, url, headers, body):
            captured_body["value"] = body
            return MagicMock(status=200)

        mock_http.request = capture_request

        with patch("cfnresponse.http", mock_http):
            send(event, context, status, data)

        body = json.loads(captured_body["value"])
        assert isinstance(body, dict)

    @given(
        event=cfn_events,
        context=lambda_contexts,
        status=response_statuses,
        data=response_data,
    )
    @settings(max_examples=100)
    def test_response_has_required_fields(self, event, context, status, data):
        """Response body always contains all CFN-required fields."""
        captured_body = {}

        mock_http = MagicMock()
        def capture_request(method, url, headers, body):
            captured_body["value"] = body
            return MagicMock(status=200)

        mock_http.request = capture_request

        with patch("cfnresponse.http", mock_http):
            send(event, context, status, data)

        body = json.loads(captured_body["value"])
        required_fields = [
            "Status", "Reason", "PhysicalResourceId",
            "StackId", "RequestId", "LogicalResourceId",
            "NoEcho", "Data",
        ]
        for field in required_fields:
            assert field in body, f"Missing required field: {field}"

    @given(
        event=cfn_events,
        context=lambda_contexts,
        status=response_statuses,
        data=response_data,
    )
    @settings(max_examples=100)
    def test_status_matches_input(self, event, context, status, data):
        """Response Status matches the input status."""
        captured_body = {}

        mock_http = MagicMock()
        def capture_request(method, url, headers, body):
            captured_body["value"] = body
            return MagicMock(status=200)

        mock_http.request = capture_request

        with patch("cfnresponse.http", mock_http):
            send(event, context, status, data)

        body = json.loads(captured_body["value"])
        assert body["Status"] == status

    @given(
        event=cfn_events,
        context=lambda_contexts,
        status=response_statuses,
        data=response_data,
    )
    @settings(max_examples=100)
    def test_stack_and_request_ids_match(self, event, context, status, data):
        """StackId and RequestId in response match the event."""
        captured_body = {}

        mock_http = MagicMock()
        def capture_request(method, url, headers, body):
            captured_body["value"] = body
            return MagicMock(status=200)

        mock_http.request = capture_request

        with patch("cfnresponse.http", mock_http):
            send(event, context, status, data)

        body = json.loads(captured_body["value"])
        assert body["StackId"] == event["StackId"]
        assert body["RequestId"] == event["RequestId"]
        assert body["LogicalResourceId"] == event["LogicalResourceId"]

    @given(
        event=cfn_events,
        context=lambda_contexts,
        status=response_statuses,
        data=response_data,
    )
    @settings(max_examples=50)
    def test_data_matches_input(self, event, context, status, data):
        """Response Data matches the input responseData."""
        captured_body = {}

        mock_http = MagicMock()
        def capture_request(method, url, headers, body):
            captured_body["value"] = body
            return MagicMock(status=200)

        mock_http.request = capture_request

        with patch("cfnresponse.http", mock_http):
            send(event, context, status, data)

        body = json.loads(captured_body["value"])
        assert body["Data"] == data

    @given(
        event=cfn_events,
        context=lambda_contexts,
        data=response_data,
    )
    @settings(max_examples=50)
    def test_no_echo_defaults_to_false(self, event, context, data):
        """NoEcho defaults to False when not specified."""
        captured_body = {}

        mock_http = MagicMock()
        def capture_request(method, url, headers, body):
            captured_body["value"] = body
            return MagicMock(status=200)

        mock_http.request = capture_request

        with patch("cfnresponse.http", mock_http):
            send(event, context, SUCCESS, data)

        body = json.loads(captured_body["value"])
        assert body["NoEcho"] is False

    @given(
        event=cfn_events,
        context=lambda_contexts,
        data=response_data,
        physical_id=st.text(min_size=1, max_size=50),
    )
    @settings(max_examples=50)
    def test_custom_physical_resource_id(self, event, context, data, physical_id):
        """Custom physicalResourceId overrides the default."""
        captured_body = {}

        mock_http = MagicMock()
        def capture_request(method, url, headers, body):
            captured_body["value"] = body
            return MagicMock(status=200)

        mock_http.request = capture_request

        with patch("cfnresponse.http", mock_http):
            send(event, context, SUCCESS, data, physicalResourceId=physical_id)

        body = json.loads(captured_body["value"])
        assert body["PhysicalResourceId"] == physical_id

    @given(event=cfn_events, context=lambda_contexts, data=response_data)
    @settings(max_examples=50)
    def test_sends_put_request(self, event, context, data):
        """Always sends a PUT request to the ResponseURL."""
        mock_http = MagicMock()
        mock_http.request.return_value = MagicMock(status=200)

        with patch("cfnresponse.http", mock_http):
            send(event, context, SUCCESS, data)

        mock_http.request.assert_called_once()
        call_args = mock_http.request.call_args
        assert call_args[0][0] == "PUT"
        assert call_args[0][1] == event["ResponseURL"]

    @given(
        event=cfn_events,
        context=lambda_contexts,
        data=response_data,
        reason=st.text(min_size=1, max_size=100),
    )
    @settings(max_examples=50)
    def test_custom_reason_overrides_default(self, event, context, data, reason):
        """Custom reason string overrides the default log stream reason."""
        captured_body = {}

        mock_http = MagicMock()
        def capture_request(method, url, headers, body):
            captured_body["value"] = body
            return MagicMock(status=200)

        mock_http.request = capture_request

        with patch("cfnresponse.http", mock_http):
            send(event, context, SUCCESS, data, reason=reason)

        body = json.loads(captured_body["value"])
        assert body["Reason"] == reason
