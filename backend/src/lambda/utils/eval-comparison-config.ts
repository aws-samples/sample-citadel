/**
 * eval-comparison-config.ts (CIT-105) — threshold config source of truth
 * shape + pure layered resolver for eval-comparison.ts's
 * ResolvedComparisonThresholds.
 *
 * Mirrors the model-selection resolver's precedence discipline
 * (request override > per-slot/per-suite > per-org default > hardcoded
 * fallback) and its bulletproof-never-throws contract: any missing or
 * malformed config layer degrades silently to the next layer down,
 * ultimately to `DEFAULT_COMPARISON_THRESHOLDS`. This resolver never
 * throws — a threshold-config outage or a bad admin-authored row must
 * never block a comparison from computing.
 *
 * Mostly pure: the only non-pure caller-facing surface is
 * `resolveComparisonThresholds` itself, which takes already-loaded
 * config rows (I/O happens in eval-comparison-resolver.ts) and performs
 * no I/O of its own.
 */
import { DEFAULT_COMPARISON_THRESHOLDS } from "./eval-comparison";
import type { ResolvedComparisonThresholds } from "./eval-comparison";

export { DEFAULT_COMPARISON_THRESHOLDS };
export type { ResolvedComparisonThresholds };

/** Partial threshold overrides — every field optional, since an admin
 * (or a request override) may set only a subset. */
export type PartialComparisonThresholds = Partial<ResolvedComparisonThresholds>;

/** EvalComparisonConfigTable row shape (PK orgId, SK suiteId; SK
 * sentinel `__default__` = org-wide default row). */
export interface ComparisonThresholdConfigRow {
  orgId: string;
  suiteId: string;
  thresholds: PartialComparisonThresholds;
  updatedAt?: string;
  updatedBy?: string;
}

export interface ResolveComparisonThresholdsInput {
  /** Highest precedence — typically a caller-supplied what-if override
   * on the computeEvalComparison mutation. */
  overrides?: PartialComparisonThresholds;
  /** Per-suite config row (EvalComparisonConfigTable SK=suiteId). */
  perSuiteConfig?: ComparisonThresholdConfigRow | null;
  /** Per-org default row (EvalComparisonConfigTable SK=`__default__`). */
  perOrgDefaultConfig?: ComparisonThresholdConfigRow | null;
}

const THRESHOLD_KEYS: readonly (keyof ResolvedComparisonThresholds)[] = [
  "passRateDropThreshold",
  "meanScoreDropThreshold",
  "latencyP95IncreaseMsThreshold",
  "costIncreaseThreshold",
  "minSampleCount",
  "scoreStabilityBand",
];

/** Validates one candidate partial-thresholds object down to only the
 * finite-number fields it legitimately carries. Any non-finite-number
 * value (wrong type, NaN, malformed row) is silently dropped rather than
 * propagated — the bulletproof-fallback contract. Never throws. */
function sanitizePartial(candidate: unknown): PartialComparisonThresholds {
  if (!candidate || typeof candidate !== "object") return {};
  const out: PartialComparisonThresholds = {};
  for (const key of THRESHOLD_KEYS) {
    const value = (candidate as Record<string, unknown>)[key];
    if (typeof value === "number" && Number.isFinite(value)) {
      out[key] = value;
    }
  }
  return out;
}

function sanitizeConfigRow(
  row: ComparisonThresholdConfigRow | null | undefined,
): PartialComparisonThresholds {
  if (!row || typeof row !== "object") return {};
  return sanitizePartial(row.thresholds);
}

/**
 * Layered, pure, never-throws resolver: request override > per-suite >
 * per-org default > DEFAULT_COMPARISON_THRESHOLDS. Missing fields at a
 * higher-precedence layer fall through to the next layer down field-by-
 * field (a partial per-suite row does not blank out fields it doesn't
 * set). The returned object is always a COMPLETE
 * ResolvedComparisonThresholds — safe to echo verbatim into a persisted
 * verdict for reproducibility.
 */
export function resolveComparisonThresholds(
  input: ResolveComparisonThresholdsInput,
): ResolvedComparisonThresholds {
  const overrides = sanitizePartial(input?.overrides);
  const perSuite = sanitizeConfigRow(input?.perSuiteConfig);
  const perOrgDefault = sanitizeConfigRow(input?.perOrgDefaultConfig);

  return {
    ...DEFAULT_COMPARISON_THRESHOLDS,
    ...perOrgDefault,
    ...perSuite,
    ...overrides,
  };
}
