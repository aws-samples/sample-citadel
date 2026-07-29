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

export const UNIT_MILLISECONDS = "Milliseconds";
export const UNIT_COUNT = "Count";

export const DIMENSION_WORKFLOW_ID = "WorkflowId";
export const DIMENSION_AGENT_ID = "AgentId";
