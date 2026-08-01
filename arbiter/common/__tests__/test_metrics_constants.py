"""Literal-value pin tests for arbiter/common/metrics_constants.py.

The downstream dashboards story depends on these exact strings — a rename
here is a breaking change for that story, so every literal is pinned by an
explicit equality assertion (not just "is a string" / "is truthy").
"""
from common import metrics_constants as mc


def test_namespace_is_pinned():
    assert mc.METRIC_NAMESPACE == 'Citadel/Workflows'


def test_metric_names_are_pinned():
    assert mc.METRIC_NODE_DURATION_MS == 'NodeDurationMs'
    assert mc.METRIC_NODE_FAILURE == 'NodeFailure'
    assert mc.METRIC_NODE_QUEUE_WAIT_MS == 'NodeQueueWaitMs'
    assert mc.METRIC_NODE_COLD_START == 'NodeColdStart'


def test_units_are_pinned():
    assert mc.UNIT_MILLISECONDS == 'Milliseconds'
    assert mc.UNIT_COUNT == 'Count'


def test_dimension_keys_are_pinned():
    assert mc.DIMENSION_WORKFLOW_ID == 'WorkflowId'
    assert mc.DIMENSION_AGENT_ID == 'AgentId'
