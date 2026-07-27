/**
 * Cost Pricing — shared model-catalog pricing resolution.
 *
 * Extracted from `cost-ledger-writer.ts`'s original inline `resolvePricing`
 * (no-behavior refactor) so `cost-ledger-reconciler.ts`'s Tier B
 * estimate->actual recompute path can call the exact same lookup +
 * defensive-fallback semantics rather than re-implementing them — a
 * duplicated pricing resolver risks the two paths silently drifting apart
 * on what counts as "usable" pricing.
 *
 * NEVER throws and NEVER fabricates a price: a missing catalog row, a row
 * without usable pricing fields, or a transient DynamoDB read failure all
 * resolve to `{pricing: undefined, reason}` — callers pass that straight
 * into `computeTokenCost`, which produces the unpriced shape.
 */

import { DynamoDBClient } from "@aws-sdk/client-dynamodb";
import { DynamoDBDocumentClient, GetCommand } from "@aws-sdk/lib-dynamodb";
import { modelKeyFromId } from "../model-catalog-sync";
import type { PricingInfo, UnpricedReason } from "./cost-compute";

const dynamoClient = new DynamoDBClient({});
const docClient = DynamoDBDocumentClient.from(dynamoClient);

/** Shape of the catalog row fields this resolver reads — a narrow, defensive view. */
interface CatalogPricingRow {
  inputPer1kTokens?: unknown;
  outputPer1kTokens?: unknown;
  currency?: unknown;
}

/**
 * Resolves pricing for a raw modelId via the model-catalog table
 * (`process.env.MODEL_CATALOG_TABLE`).
 *
 * NEVER throws and NEVER drops the caller's row: a missing row, a row
 * without usable pricing, or a transient DynamoDB read failure all resolve
 * to `{pricing: undefined, reason}`. A catalog-read failure is logged at
 * `error`; a missing/unpriced row is logged at `warn`.
 */
export async function resolvePricing(modelId: string): Promise<{
  pricing: PricingInfo | undefined;
  reason: UnpricedReason;
  modelKey: string;
}> {
  const modelKey = modelId ? modelKeyFromId(modelId) : "";

  let item: CatalogPricingRow | undefined;
  try {
    const result = await docClient.send(
      new GetCommand({
        TableName: process.env.MODEL_CATALOG_TABLE!,
        Key: { modelKey },
      }),
    );
    item = result.Item as CatalogPricingRow | undefined;
  } catch (err: unknown) {
    console.error(
      "cost-pricing: model-catalog read failed; caller will write unpriced (never dropped)",
      { modelKey, error: err instanceof Error ? err.message : String(err) },
    );
    return { pricing: undefined, reason: "pricing_absent", modelKey };
  }

  if (!item) {
    console.warn(
      `cost-pricing: modelKey not found in catalog, resolving unpriced: ${modelKey}`,
    );
    return { pricing: undefined, reason: "model_not_in_catalog", modelKey };
  }

  const usable =
    typeof item.inputPer1kTokens === "number" &&
    typeof item.outputPer1kTokens === "number" &&
    typeof item.currency === "string" &&
    item.currency.length > 0;

  if (!usable) {
    console.warn(
      `cost-pricing: catalog row for ${modelKey} has no usable pricing, resolving unpriced`,
    );
    return { pricing: undefined, reason: "pricing_absent", modelKey };
  }

  return {
    pricing: {
      inputPer1kTokens: item.inputPer1kTokens as number,
      outputPer1kTokens: item.outputPer1kTokens as number,
      currency: item.currency as string,
    },
    reason: "pricing_absent", // unused when pricing is defined
    modelKey,
  };
}
