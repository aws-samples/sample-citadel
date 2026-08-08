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

# Runtime backstop metric (Count) for the runId silent-regression guard
# (Pass 1, decision f1cbd5ef): emitted WARN-level whenever a finding or
# dispatch is written runId-absent. Observability only — never gates
# dispatch or a fail-closed write. Mirrors the TS backend tier's
# METRIC_UNSTAMPED_DISPATCH in backend/src/utils/metrics-constants.ts.
# Pinned per the "do NOT retype metric names" lesson — always import this
# constant at the emission call site, never hand-type the string literal.
METRIC_UNSTAMPED_DISPATCH = 'UnstampedDispatch'

# --- Units ---------------------------------------------------------------

UNIT_MILLISECONDS = 'Milliseconds'
UNIT_COUNT = 'Count'

# --- Dimension keys ------------------------------------------------------

DIMENSION_WORKFLOW_ID = 'WorkflowId'
DIMENSION_AGENT_ID = 'AgentId'

# Release-aware dispatch (this story): per-mode dispatch outcome counters
# so the release-gate rollout can be measured before strict is flipped.
# Mirrors the TS backend tier's METRIC_RELEASE_DISPATCH_EVALUATED /
# METRIC_RELEASE_DISPATCH_WOULD_BLOCK / METRIC_RELEASE_DISPATCH_REFUSED in
# backend/src/utils/metrics-constants.ts. Dimensions: WorkflowId (existing,
# above) plus DIMENSION_RELEASE_MODE and DIMENSION_RELEASE_OUTCOME (both
# low-cardinality — 3 modes x 4 status literals).

# Emitted on every governed dispatch once RELEASE_DISPATCH_ENVIRONMENT is
# set, in every mode — the baseline "the gate ran" counter.
METRIC_RELEASE_DISPATCH_EVALUATED = 'ReleaseDispatchEvaluated'

# Emitted in shadow mode (and, informationally, permissive) whenever the
# resolution would have caused a refusal had the mode been strict. Never
# emitted in strict mode itself — strict either proceeds or refuses, it
# does not also "would-block".
METRIC_RELEASE_DISPATCH_WOULD_BLOCK = 'ReleaseDispatchWouldBlock'

# Emitted only in strict mode, only when dispatch is actually refused.
METRIC_RELEASE_DISPATCH_REFUSED = 'ReleaseDispatchRefused'

DIMENSION_RELEASE_MODE = 'ReleaseDispatchMode'
DIMENSION_RELEASE_OUTCOME = 'ReleaseDispatchOutcome'
