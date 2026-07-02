"""Region-to-cross-region-inference-prefix mapping for the fabricator.

Confirms _cross_region_prefix returns the correct inference-profile prefix
for each supported AWS region family, including the af- family, and falls
back to 'us' for unrecognised regions.
"""

import sys
import os

import pytest

sys.path.insert(0, os.path.join(os.path.dirname(__file__), ".."))

# Set required env vars before import (module-level code reads them).
os.environ.setdefault("TOOL_CONFIG_TABLE", "fake-tool-table")
os.environ.setdefault("AGENT_CONFIG_TABLE", "fake-agent-table")
os.environ.setdefault("AGENT_BUCKET_NAME", "fake-bucket")
os.environ.setdefault("COMPLETION_BUS_NAME", "fake-bus")
os.environ.setdefault("WORKER_QUEUE_URL", "https://sqs.fake/queue")

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
