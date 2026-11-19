/**
 * Tests for model-permission-resources.ts — computes IAM resource ARNs
 * for Bedrock model invocation policies from the model catalog.
 */
import { computeModelResources } from "../model-permission-resources";

describe("computeModelResources", () => {
  const accountId = "123456789012";
  const region = "us-west-2";

  test("returns foundation-model ARN for the current region", () => {
    const result = computeModelResources(
      "anthropic.claude-sonnet-4-20250514-v1:0",
      {}, // no inference profiles in catalog
      accountId,
      region,
    );
    expect(result.foundationModelArns).toEqual([
      "arn:aws:bedrock:us-west-2::foundation-model/anthropic.claude-sonnet-4-20250514-v1:0",
    ]);
    expect(result.inferenceProfileArns).toEqual([]);
  });

  test("returns inference-profile ARN for the current region prefix", () => {
    const regionProfiles: Record<string, string> = {
      us: "us.anthropic.claude-sonnet-4-20250514-v1:0",
      eu: "eu.anthropic.claude-sonnet-4-20250514-v1:0",
    };
    const result = computeModelResources(
      "anthropic.claude-sonnet-4-20250514-v1:0",
      regionProfiles,
      accountId,
      region,
    );
    expect(result.foundationModelArns).toEqual([
      "arn:aws:bedrock:us-west-2::foundation-model/anthropic.claude-sonnet-4-20250514-v1:0",
    ]);
    // The inference-profile ARN uses * for region because cross-region
    // profiles route across regions, and the IAM policy must cover all.
    expect(result.inferenceProfileArns).toContainEqual(
      `arn:aws:bedrock:${region}:${accountId}:inference-profile/us.anthropic.claude-sonnet-4-20250514-v1:0`,
    );
  });

  test("includes inference-profile ARNs for all region prefixes in catalog", () => {
    const regionProfiles: Record<string, string> = {
      us: "us.anthropic.claude-sonnet-4-20250514-v1:0",
      eu: "eu.anthropic.claude-sonnet-4-20250514-v1:0",
      apac: "apac.anthropic.claude-sonnet-4-20250514-v1:0",
    };
    const result = computeModelResources(
      "anthropic.claude-sonnet-4-20250514-v1:0",
      regionProfiles,
      accountId,
      region,
    );
    expect(result.inferenceProfileArns).toHaveLength(3);
    expect(result.inferenceProfileArns).toContainEqual(
      `arn:aws:bedrock:${region}:${accountId}:inference-profile/us.anthropic.claude-sonnet-4-20250514-v1:0`,
    );
    expect(result.inferenceProfileArns).toContainEqual(
      `arn:aws:bedrock:${region}:${accountId}:inference-profile/eu.anthropic.claude-sonnet-4-20250514-v1:0`,
    );
    expect(result.inferenceProfileArns).toContainEqual(
      `arn:aws:bedrock:${region}:${accountId}:inference-profile/apac.anthropic.claude-sonnet-4-20250514-v1:0`,
    );
  });

  test("allResourceArns combines foundation-model and inference-profile ARNs", () => {
    const regionProfiles: Record<string, string> = {
      us: "us.anthropic.claude-sonnet-4-20250514-v1:0",
    };
    const result = computeModelResources(
      "anthropic.claude-sonnet-4-20250514-v1:0",
      regionProfiles,
      accountId,
      region,
    );
    expect(result.allResourceArns).toEqual([
      ...result.foundationModelArns,
      ...result.inferenceProfileArns,
    ]);
    expect(result.allResourceArns.length).toBeGreaterThan(1);
  });

  test("empty regionProfiles yields only foundation-model ARN", () => {
    const result = computeModelResources(
      "amazon.titan-text-lite-v1",
      {},
      accountId,
      region,
    );
    expect(result.inferenceProfileArns).toHaveLength(0);
    expect(result.allResourceArns).toEqual(result.foundationModelArns);
  });

  test("handles eu region correctly", () => {
    const regionProfiles: Record<string, string> = {
      eu: "eu.anthropic.claude-sonnet-4-20250514-v1:0",
    };
    const result = computeModelResources(
      "anthropic.claude-sonnet-4-20250514-v1:0",
      regionProfiles,
      accountId,
      "eu-west-1",
    );
    expect(result.inferenceProfileArns).toContainEqual(
      `arn:aws:bedrock:eu-west-1:${accountId}:inference-profile/eu.anthropic.claude-sonnet-4-20250514-v1:0`,
    );
  });
});
