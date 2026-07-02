import os
import sys

import pytest

sys.path.insert(0, os.path.abspath(os.path.join(os.path.dirname(__file__), "..")))
from region import cross_region_prefix  # noqa: E402


@pytest.mark.parametrize("region,expected", [
    ("us-east-1", "us"),
    ("eu-west-1", "eu"),
    ("ap-southeast-2", "au"),
    ("ap-northeast-1", "apac"),
    ("me-south-1", "me"),
    ("ca-central-1", "ca"),
    ("sa-east-1", "sa"),
    ("af-south-1", "af"),
    ("unknown-region-1", "us"),
])
def test_cross_region_prefix(region, expected):
    assert cross_region_prefix(region) == expected
