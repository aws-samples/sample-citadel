/**
 * Cost Model — Maps LLM token usage to an attributable USD cost.
 *
 * Used by the per-app metrics pipeline to attribute token spend to each
 * published agent app. Costs are computed in *micro-USD* (integer millionths
 * of a dollar) so they can be accumulated with DynamoDB atomic ADD counters
 * without floating-point drift.
 *
 * This is an attribution *estimate*, not an invoice. It is intentionally
 * decoupled from the AWS bill — see docs/proposals for reconciliation scope.
 */

/** Per-model pricing, expressed in USD per 1,000,000 tokens. */
export interface ModelRate {
  /** USD per 1M input (prompt) tokens. */
  inputPerMillion: number;
  /** USD per 1M output (completion) tokens. */
  outputPerMillion: number;
}

/**
 * Static pricing table keyed by model id. Values are illustrative public
 * list prices (USD / 1M tokens) and should be kept in sync as pricing
 * changes; unknown models fall back to {@link DEFAULT_RATE}.
 */
export const MODEL_RATES: Record<string, ModelRate> = {
  'anthropic.claude-3-5-sonnet': { inputPerMillion: 3.0, outputPerMillion: 15.0 },
  'anthropic.claude-3-5-haiku': { inputPerMillion: 0.8, outputPerMillion: 4.0 },
  'anthropic.claude-3-opus': { inputPerMillion: 15.0, outputPerMillion: 75.0 },
  'anthropic.claude-3-haiku': { inputPerMillion: 0.25, outputPerMillion: 1.25 },
  'amazon.titan-text-express': { inputPerMillion: 0.2, outputPerMillion: 0.6 },
  'amazon.nova-pro': { inputPerMillion: 0.8, outputPerMillion: 3.2 },
  'amazon.nova-lite': { inputPerMillion: 0.06, outputPerMillion: 0.24 },
};

/**
 * Fallback rate used when a model id is not present in {@link MODEL_RATES}.
 * Chosen as a conservative non-zero estimate so unknown spend is surfaced
 * rather than silently attributed as free.
 */
export const DEFAULT_RATE: ModelRate = { inputPerMillion: 3.0, outputPerMillion: 15.0 };

export interface CostResult {
  /** Attributed cost in integer micro-USD (millionths of a dollar). */
  costMicroUsd: number;
  /** True when the model id was not found and DEFAULT_RATE was applied. */
  usedFallbackRate: boolean;
}

/**
 * Resolves the pricing for a model id, falling back to {@link DEFAULT_RATE}.
 */
export function resolveRate(model: string | undefined): { rate: ModelRate; usedFallbackRate: boolean } {
  if (model && Object.prototype.hasOwnProperty.call(MODEL_RATES, model)) {
    return { rate: MODEL_RATES[model], usedFallbackRate: false };
  }
  return { rate: DEFAULT_RATE, usedFallbackRate: true };
}

/**
 * Computes the attributable cost of a single request's token usage.
 *
 * Pure function — no side effects. Negative or non-finite token counts are
 * clamped to zero so a malformed log line can never produce negative cost.
 *
 * @returns cost in integer micro-USD plus whether a fallback rate was used.
 */
export function computeCost(
  model: string | undefined,
  inputTokens: number,
  outputTokens: number,
): CostResult {
  const inTok = sanitizeTokens(inputTokens);
  const outTok = sanitizeTokens(outputTokens);
  const { rate, usedFallbackRate } = resolveRate(model);

  // USD/1M tokens × tokens = USD; × 1e6 = micro-USD. Combine to one factor:
  //   microUsd = tokens × (usdPerMillion / 1e6) × 1e6 = tokens × usdPerMillion
  const costMicroUsd = Math.round(inTok * rate.inputPerMillion + outTok * rate.outputPerMillion);

  return { costMicroUsd, usedFallbackRate };
}

/** Converts integer micro-USD to a USD number (for display/aggregation output). */
export function microUsdToUsd(microUsd: number): number {
  return microUsd / 1_000_000;
}

function sanitizeTokens(n: number): number {
  if (!Number.isFinite(n) || n <= 0) return 0;
  return Math.floor(n);
}
