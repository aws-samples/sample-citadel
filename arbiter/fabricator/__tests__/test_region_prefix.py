import os
import sys

import pytest

from common.region import cross_region_prefix as arbiter_prefix

# The intake service is a separate build/deploy unit with its own copy of the
# pure prefix helper. Load it directly (no heavy dependencies) and assert the
# two copies agree so they cannot drift apart.
_SERVICE_DIR = os.path.abspath(
    os.path.join(os.path.dirname(__file__), "..", "..", "..", "service", "agent_intake_single")
)
if _SERVICE_DIR not in sys.path:
    sys.path.append(_SERVICE_DIR)
from region import cross_region_prefix as service_prefix  # noqa: E402


@pytest.mark.parametrize("region", [
    "us-east-1", "us-west-2", "eu-west-1", "eu-central-1",
    "ap-southeast-2", "ap-northeast-1", "ap-south-1",
    "me-south-1", "ca-central-1", "sa-east-1", "af-south-1",
    "unknown-region-1", "",
])
def test_arbiter_and_service_prefix_agree(region):
    assert arbiter_prefix(region) == service_prefix(region)
