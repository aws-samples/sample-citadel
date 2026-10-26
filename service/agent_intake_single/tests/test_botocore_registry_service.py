"""Container-level smoke test: botocore ships the agent-registry-control service model.

This test MUST be run with the pinned dependencies from requirements.txt
(e.g. inside the container image or a venv created from that file). It will
fail in any environment whose botocore predates the agent-registry-control
service model — that is intentional: a failing build proves the image would
raise UnknownServiceError at runtime.
"""

import botocore
from botocore.session import get_session


def test_agent_registry_control_is_available():
    """botocore must include the agent-registry-control service model."""
    session = get_session()
    available = session.get_available_services()
    assert "agent-registry-control" in available, (
        f"botocore {botocore.__version__} does not include "
        f"'agent-registry-control' — pin boto3/botocore to a version "
        f"that ships this service model (>= 1.43.116 known good)"
    )
