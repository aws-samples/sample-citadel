/**
 * Cost Compute — pure token-cost helper for the invocation cost ledger.
 *
 * tokenCost = inputTokens/1000 * inputPer1kTokens + outputTokens/1000 * outputPer1kTokens
 *
 * - Rounded half-up to 8 decimal places (`tokenCost`), plus a drift-free
 *   integer `costMicros = Math.round(tokenCost * 1e6)` for downstream SUM
 *   aggregations that must avoid float drift.
 * - Currency is taken verbatim from the catalog pricing row — never inferred.
 * - UNPRICED FALLBACK POLICY (never fabricate a price): if pricing is
 *   missing, or lacks `inputPer1kTokens` / `outputPer1kTokens` / `currency`,
 *   the result is `{priced:false, tokenCost:null, costMicros:null,
 *   currency:null, unpricedReason}`. No price or currency is ever guessed.
 *
 * Pure and I/O-free — no AWS SDK imports, no env var reads. Callers resolve
 * pricing (typically via a DynamoDB GetItem on the model-catalog table) and
 * pass the result in.
 */

/** Pricing metadata read from a model-catalog row. */
export interface PricingInfo {
  inputPer1kTokens: number;
  outputPer1kTokens: number;
  currency: string;
}

/** Why a row could not be priced — used verbatim as `unpricedReason` on the ledger row. */
export type UnpricedReason = "model_not_in_catalog" | "pricing_absent";

export interface TokenCostResult {
  priced: boolean;
  tokenCost: number | null;
  costMicros: number | null;
  currency: string | null;
  unpricedReason?: UnpricedReason;
}

/** Rounds `value` half-up to `decimals` decimal places without introducing float noise. */
function roundHalfUp(value: number, decimals: number): number {
  const factor = 10 ** decimals;
  return Math.round((value + Number.EPSILON) * factor) / factor;
}

/** Type-guards a candidate pricing object: all three required fields present and numeric/string. */
function isUsablePricing(
  pricing: PricingInfo | undefined | null,
): pricing is PricingInfo {
  if (!pricing) return false;
  return (
    typeof pricing.inputPer1kTokens === "number" &&
    Number.isFinite(pricing.inputPer1kTokens) &&
    typeof pricing.outputPer1kTokens === "number" &&
    Number.isFinite(pricing.outputPer1kTokens) &&
    typeof pricing.currency === "string" &&
    pricing.currency.length > 0
  );
}

/**
 * Computes token cost for a single usage record against a resolved pricing
 * row. `unpricedFallbackReason` lets callers distinguish "model not found in
 * catalog at all" from "model found but pricing fields absent" — defaults to
 * `pricing_absent`, the correct reason when `pricing` is simply undefined.
 */
export function computeTokenCost(
  inputTokens: number,
  outputTokens: number,
  pricing: PricingInfo | undefined | null,
  unpricedFallbackReason: UnpricedReason = "pricing_absent",
): TokenCostResult {
  if (!isUsablePricing(pricing)) {
    return {
      priced: false,
      tokenCost: null,
      costMicros: null,
      currency: null,
      unpricedReason: unpricedFallbackReason,
    };
  }

  const rawCost =
    (inputTokens / 1000) * pricing.inputPer1kTokens +
    (outputTokens / 1000) * pricing.outputPer1kTokens;

  const tokenCost = roundHalfUp(rawCost, 8);
  const costMicros = Math.round(tokenCost * 1e6);

  return {
    priced: true,
    tokenCost,
    costMicros,
    currency: pricing.currency,
  };
}
