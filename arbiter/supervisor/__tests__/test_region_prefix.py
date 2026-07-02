"""Region-to-cross-region-inference-prefix mapping for the supervisor.

Confirms _cross_region_prefix returns the correct inference-profile prefix
for each supported AWS region family, including the af- family, and falls
back to 'us' for unrecognised regions.
"""

import sys
import os
from unittest.mock import patch

import pytest

sys.path.insert(0, os.path.join(os.path.dirname(__file__), ".."))

os.environ.setdefault("AGENT_CONFIG_TABLE", "fake-table")
os.environ.setdefault("EVENT_BUS_NAME", "fake-bus")
os.environ.setdefault("ORCHESTRATION_TABLE", "fake-orch-table")
os.environ.setdefault("WORKER_STATE_TABLE", "fake-worker-table")

# Patch boto3 at module level before importing index
import boto3
from unittest.mock import MagicMock as _MagicMock

_mock_dynamodb = _MagicMock()
_mock_sqs = _MagicMock()
_mock_bedrock = _MagicMock()
_mock_events = _MagicMock()

with patch.multiple(
    "boto3",
    resource=_MagicMock(return_value=_mock_dynamodb),
    client=_MagicMock(side_effect=lambda svc, **kw: {
        "sqs": _mock_sqs,
        "bedrock-runtime": _mock_bedrock,
        "events": _mock_events,
    }.get(svc, _MagicMock())),
):
    from index import _cross_region_prefix


@pytest.mark.parametrize(
    "region, expected",
    [
        ("us-east-1", "us"),
        ("eu-west-1", "eu"),
        ("ap-southeast-2", "au"),
        ("ap-northeast-1", "apac"),
        ("me-south-1", "me"),
        ("ca-central-1", "ca"),
        ("sa-east-1", "sa"),
        ("af-south-1", "af"),
        ("unknown-region-1", "us"),
    ],
)
def test_cross_region_prefix(region, expected):
    assert _cross_region_prefix(region) == expected
