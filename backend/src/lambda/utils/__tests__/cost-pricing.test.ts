/**
 * Unit tests for cost-pricing.ts's resolvePricing — shared model-catalog
 * pricing resolution extracted from cost-ledger-writer.ts so the Tier B
 * reconciler recompute path (cost-ledger-reconciler.ts) can reuse the exact
 * same lookup/defensive-fallback semantics rather than duplicating them.
 */
import { DynamoDBDocumentClient } from "@aws-sdk/lib-dynamodb";
import { mockClient } from "aws-sdk-client-mock";

process.env.MODEL_CATALOG_TABLE = "citadel-model-catalog-test";

import { GetCommand } from "@aws-sdk/lib-dynamodb";
import { resolvePricing } from "../cost-pricing";

const ddbMock = mockClient(DynamoDBDocumentClient);

describe("resolvePricing", () => {
  beforeEach(() => {
    ddbMock.reset();
  });

  test("returns usable pricing when the catalog row has all three fields", async () => {
    ddbMock.on(GetCommand).resolves({
      Item: { inputPer1kTokens: 3, outputPer1kTokens: 15, currency: "USD" },
    });

    const result = await resolvePricing("anthropic.claude-sonnet-5");

    expect(result.pricing).toEqual({
      inputPer1kTokens: 3,
      outputPer1kTokens: 15,
      currency: "USD",
    });
    expect(result.modelKey).toBe("anthropic-claude-sonnet-5");
  });

  test("returns undefined pricing with model_not_in_catalog reason when the row is missing", async () => {
    ddbMock.on(GetCommand).resolves({ Item: undefined });

    const result = await resolvePricing("unknown.model");

    expect(result.pricing).toBeUndefined();
    expect(result.reason).toBe("model_not_in_catalog");
  });

  test("returns undefined pricing with pricing_absent reason when fields are missing", async () => {
    ddbMock.on(GetCommand).resolves({ Item: { someOtherField: 1 } });

    const result = await resolvePricing("partial.model");

    expect(result.pricing).toBeUndefined();
    expect(result.reason).toBe("pricing_absent");
  });

  test("never throws and returns pricing_absent when the DynamoDB read fails", async () => {
    ddbMock.on(GetCommand).rejects(new Error("transient DynamoDB error"));

    const result = await resolvePricing("anthropic.claude-sonnet-5");

    expect(result.pricing).toBeUndefined();
    expect(result.reason).toBe("pricing_absent");
  });

  test("empty modelId resolves to an empty modelKey without throwing", async () => {
    ddbMock.on(GetCommand).resolves({ Item: undefined });

    const result = await resolvePricing("");

    expect(result.modelKey).toBe("");
    expect(result.pricing).toBeUndefined();
  });

  test("currency field must be a non-empty string to be usable", async () => {
    ddbMock.on(GetCommand).resolves({
      Item: { inputPer1kTokens: 1, outputPer1kTokens: 2, currency: "" },
    });

    const result = await resolvePricing("m.test");

    expect(result.pricing).toBeUndefined();
    expect(result.reason).toBe("pricing_absent");
  });
});
