/**
 * eval-evaluator-compose.ts (CIT-107) — composes an EvaluatorRegistry's
 * combined EvaluatorDimensionScore[] output (built-in canonical
 * dimensions + org-registered custom dimensions) into one final,
 * deterministically-ordered vector for persistence/reporting.
 *
 * Deliberate design choice on DIMENSION_ORDER/canonicalScoreVector
 * (eval-scoring.ts): NEITHER is modified. `canonicalScoreVector` stays
 * the single source of truth for ordering the 8 fixed canonical
 * dimensions and is reused verbatim here — this module only decides
 * where CUSTOM (non-canonical) dimension names go: APPENDED after every
 * canonical dimension, sorted alphabetically for a stable, deterministic
 * order. This mirrors the existing "trajectory is appended, not
 * inserted" precedent in eval-scoring.ts (DIMENSION_ORDER's own comment)
 * — extending that same additive-safe pattern one level further, from
 * "a new built-in dimension" to "an arbitrary custom dimension", without
 * ever widening the closed DimensionName union or eval-score-aggregate.ts's
 * DIMENSION_ORDER-keyed aggregation loop. A consumer that has never heard
 * of a custom dimension (e.g. aggregateScoreVectors, which iterates
 * DIMENSION_ORDER only) simply never sees it — no crash, no silent
 * corruption of the canonical 8-dimension aggregate.
 *
 * First-occurrence-wins de-duplication defends both against a genuinely
 * duplicate custom entry AND (defense-in-depth) against a misconfigured
 * evaluator that emits a canonical dimension name — the canonical/
 * first-registered entry always wins, a later one is dropped rather than
 * silently overwriting it.
 */
import {
  canonicalScoreVector,
  DIMENSION_ORDER,
  type DimensionScore,
} from "./eval-scoring";
import type { EvaluatorDimensionScore } from "./eval-evaluator-registry";

const CANONICAL_DIMENSIONS = new Set<string>(DIMENSION_ORDER);

/**
 * Composes evaluator results into one final vector: canonical dimensions
 * ordered via the unchanged canonicalScoreVector(), custom dimensions
 * appended after in alphabetical order. Duplicate dimension names
 * (canonical or custom) keep only their first occurrence.
 */
export function composeScoreVector(
  scores: EvaluatorDimensionScore[],
): EvaluatorDimensionScore[] {
  const seen = new Set<string>();
  const canonical: DimensionScore[] = [];
  const custom: EvaluatorDimensionScore[] = [];

  for (const score of scores) {
    if (seen.has(score.dimension)) continue;
    seen.add(score.dimension);
    if (CANONICAL_DIMENSIONS.has(score.dimension)) {
      canonical.push(score as DimensionScore);
    } else {
      custom.push(score);
    }
  }

  const orderedCanonical = canonicalScoreVector(canonical);
  const orderedCustom = [...custom].sort((a, b) =>
    a.dimension.localeCompare(b.dimension),
  );

  return [...orderedCanonical, ...orderedCustom];
}
