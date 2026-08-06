/**
 * eval-builtin-evaluator.ts (CIT-107) — adapts the existing scorer
 * (scoreCase, eval-scoring.ts) to the Evaluator interface
 * (eval-evaluator-registry.ts). This is an ADAPTER, not a rewrite: it
 * delegates every dimension's logic to the unchanged scoreCase() pure
 * function and simply reshapes the call into the pluggable contract, so
 * the 8 built-in dimensions keep their existing, already-tested
 * behaviour byte-for-byte (see eval-builtin-evaluator.test.ts's
 * scoreCase-equality assertion).
 */
import type { Evaluator } from "./eval-evaluator-registry";
import { DIMENSION_ORDER, scoreCase } from "./eval-scoring";

export const builtinEvaluator: Evaluator = {
  id: "builtin.core",
  dimensions: [...DIMENSION_ORDER],
  score: (caseRow, artifact, evalCase) =>
    scoreCase(caseRow, artifact, evalCase),
};
