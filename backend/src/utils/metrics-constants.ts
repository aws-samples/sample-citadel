/**
 * Shared CloudWatch metric constants for the TypeScript backend tier.
 *
 * Single source of truth for metric names, units, and dimension keys that
 * TypeScript Lambda resolvers emit for per-node/per-invocation telemetry. A
 * downstream dashboards story consumes these names/dimensions directly, so
 * they are a CONTRACT — changing a literal value here is a breaking change
 * for that story. Pinned by literal-value tests in
 * `backend/src/utils/__tests__/metrics-constants.test.ts`.
 *
 * Namespace: `Citadel/Workflows`, mirroring the Python arbiter tier's
 * `arbiter/common/metrics_constants.py` (same namespace both languages
 * write into — a downstream dashboard/alarm should not care which runtime
 * emitted a given `NodeColdStart` datapoint).
 *
 * Dimensions are intentionally low-cardinality (WorkflowId, AgentId) —
 * never executionId/nodeId, matching the Python tier's convention.
 */

export const METRIC_NAMESPACE = "Citadel/Workflows";

/** Agent/Lambda cold start: emitted once per container lifetime via a
 * module-scope flag flipped on first invocation. */
export const METRIC_NODE_COLD_START = "NodeColdStart";

/**
 * Node duration (Milliseconds), emitted on node completion. Mirrors the
 * Python arbiter tier's `METRIC_NODE_DURATION_MS` in
 * `arbiter/common/metrics_constants.py` — added here for the dashboards
 * story (decision ab73ae1b), which needs it from the TS/CDK side.
 */
export const METRIC_NODE_DURATION_MS = "NodeDurationMs";

/**
 * Terminal (non-retryable) node failure (Count). Mirrors the Python
 * arbiter tier's `METRIC_NODE_FAILURE`. Added here for the dashboards
 * story (decision ab73ae1b).
 */
export const METRIC_NODE_FAILURE = "NodeFailure";

/**
 * Dispatch -> worker-start queue wait (Milliseconds). Mirrors the Python
 * arbiter tier's `METRIC_NODE_QUEUE_WAIT_MS`. Added here for the
 * dashboards story (decision ab73ae1b).
 */
export const METRIC_NODE_QUEUE_WAIT_MS = "NodeQueueWaitMs";

/**
 * Runtime backstop metric (Count) for the runId silent-regression guard
 * (Pass 1, decision f1cbd5ef): emitted WARN-level whenever a finding or
 * dispatch is written runId-absent. Observability only — never gates
 * dispatch or a fail-closed write. Mirrors the Python arbiter tier's
 * `METRIC_UNSTAMPED_DISPATCH` in `arbiter/common/metrics_constants.py`.
 * Pinned per the "do NOT retype metric names" lesson — always import this
 * constant at the emission call site, never hand-type the string literal.
 */
export const METRIC_UNSTAMPED_DISPATCH = "UnstampedDispatch";

export const UNIT_MILLISECONDS = "Milliseconds";
export const UNIT_COUNT = "Count";

// ── Release-aware dispatch (this story) ─────────────────────────────────
// Mirrors the Python arbiter tier's METRIC_RELEASE_DISPATCH_EVALUATED /
// METRIC_RELEASE_DISPATCH_WOULD_BLOCK / METRIC_RELEASE_DISPATCH_REFUSED in
// arbiter/common/metrics_constants.py. TypeScript resolvers do not emit
// these today (the release-aware dispatch gate lives entirely in the
// Python arbiter tier); declared here so a future TS-side emitter (or a
// cross-language dashboard) references the same literal rather than
// hand-typing it, mirroring every other metric name in this file.
export const METRIC_RELEASE_DISPATCH_EVALUATED = "ReleaseDispatchEvaluated";
export const METRIC_RELEASE_DISPATCH_WOULD_BLOCK = "ReleaseDispatchWouldBlock";
export const METRIC_RELEASE_DISPATCH_REFUSED = "ReleaseDispatchRefused";
export const DIMENSION_RELEASE_MODE = "ReleaseDispatchMode";
export const DIMENSION_RELEASE_OUTCOME = "ReleaseDispatchOutcome";

// ── Canary arm assignment (attribution-only, decision D2) ───────────────
// Per-dispatch counter of which arm a stickiness key resolved to, so the
// canary split can be measured. Dimensioned ONLY by low-cardinality keys:
// WorkflowId (existing) × ReleaseArm (stable|candidate). releaseId is
// high-cardinality and MUST NOT be a CloudWatch dimension (it lives on the
// usage row / cost ledger / findings instead) — same rule the module
// docstring states for executionId/nodeId. Mirrored in the Python arbiter
// tier's arbiter/common/metrics_constants.py.
export const METRIC_CANARY_ASSIGNMENT = "CanaryAssignment";
export const DIMENSION_RELEASE_ARM = "ReleaseArm";

export const DIMENSION_WORKFLOW_ID = "WorkflowId";
export const DIMENSION_AGENT_ID = "AgentId";
