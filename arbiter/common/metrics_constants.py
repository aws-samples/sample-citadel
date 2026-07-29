"""Shared CloudWatch metric constants for the Python arbiter tier.

Single source of truth for metric names, units, and dimension keys emitted
by the step runner and the worker. A downstream dashboards story consumes
these names/dimensions directly, so they are a CONTRACT: changing a literal
value here is a breaking change for that story. Pinned by literal-value
tests in ``common/__tests__/test_metrics_constants.py``.

Namespace: reuses ``Citadel/Workflows`` — the step runner's existing
workflow-metric namespace (``NodeDurationMs`` / ``NodeFailure`` already ship
there). Splitting node-lifecycle metrics into a second namespace would only
fragment the dashboards story's queries for no isolation benefit (all of
these metrics describe the same DAG node lifecycle), so this story extends
the existing namespace rather than introducing a new one.

Dimensions are intentionally low-cardinality (WorkflowId, AgentId) — never
executionId/nodeId, which would blow up CloudWatch custom-metric cardinality
(and cost) per the existing ``NodeDurationMs``/``NodeFailure`` convention.
"""

# --- Namespace ---------------------------------------------------------------

METRIC_NAMESPACE = 'Citadel/Workflows'

# --- Metric names -------------------------------------------------------------

# Per-node wall-clock duration (startedAt -> completedAt), already emitted by
# the step runner prior to this change.
METRIC_NODE_DURATION_MS = 'NodeDurationMs'

# Terminal (non-retryable) node failure count, already emitted by the step
# runner prior to this change.
METRIC_NODE_FAILURE = 'NodeFailure'

# Queue-wait: dispatch (SQS send) -> worker-start delta. Emitted by the step
# runner from timestamps carried additively on the node-result event
# (dispatchedAt from the dispatch message, workerStartedAt from the worker).
METRIC_NODE_QUEUE_WAIT_MS = 'NodeQueueWaitMs'

# Agent cold start: emitted by the worker (Lambda tier only — see module
# docstring in workerWrapper/index.py for why the AgentCore Runtime intake
# container is out of scope) exactly once per container lifetime, the first
# time a workflow node is dispatched into a fresh execution environment.
METRIC_NODE_COLD_START = 'NodeColdStart'

# --- Units ---------------------------------------------------------------

UNIT_MILLISECONDS = 'Milliseconds'
UNIT_COUNT = 'Count'

# --- Dimension keys ------------------------------------------------------

DIMENSION_WORKFLOW_ID = 'WorkflowId'
DIMENSION_AGENT_ID = 'AgentId'
