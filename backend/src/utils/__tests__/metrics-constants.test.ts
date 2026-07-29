/**
 * Literal-value pin tests for backend/src/utils/metrics-constants.ts.
 *
 * The downstream dashboards story depends on these exact strings — a rename
 * here is a breaking change for that story, so every literal is pinned by an
 * explicit equality assertion.
 */
import {
  METRIC_NAMESPACE,
  METRIC_NODE_COLD_START,
  UNIT_MILLISECONDS,
  UNIT_COUNT,
  DIMENSION_WORKFLOW_ID,
  DIMENSION_AGENT_ID,
} from "../metrics-constants";

describe("metrics-constants — literal contract", () => {
  test("namespace matches the Python arbiter tier's shared namespace", () => {
    expect(METRIC_NAMESPACE).toBe("Citadel/Workflows");
  });

  test("metric names are pinned", () => {
    expect(METRIC_NODE_COLD_START).toBe("NodeColdStart");
  });

  test("units are pinned", () => {
    expect(UNIT_MILLISECONDS).toBe("Milliseconds");
    expect(UNIT_COUNT).toBe("Count");
  });

  test("dimension keys are pinned", () => {
    expect(DIMENSION_WORKFLOW_ID).toBe("WorkflowId");
    expect(DIMENSION_AGENT_ID).toBe("AgentId");
  });
});
