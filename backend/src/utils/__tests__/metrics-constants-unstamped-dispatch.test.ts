/**
 * Literal-value pin test for the new UnstampedDispatch WARN metric name
 * (Pass 1, decision f1cbd5ef — runtime backstop layer of the silent-
 * regression guard). Pinned per the project's "do NOT retype metric names"
 * lesson: this constant is imported everywhere the metric is emitted, never
 * hand-typed as a string literal at the call site.
 */
import {
  METRIC_UNSTAMPED_DISPATCH,
  METRIC_NAMESPACE,
  UNIT_COUNT,
} from "../metrics-constants";

describe("metrics-constants — UnstampedDispatch (Pass 1)", () => {
  test("metric name is pinned", () => {
    expect(METRIC_UNSTAMPED_DISPATCH).toBe("UnstampedDispatch");
  });

  test("shares the existing namespace and Count unit convention", () => {
    expect(METRIC_NAMESPACE).toBe("Citadel/Workflows");
    expect(UNIT_COUNT).toBe("Count");
  });
});
