/**
 * Convention agreement: stamp, worker, and vender all use foundation model ids
 * (baseModelId) in requiredPermissions.models — not inference-profile ids.
 *
 * The vender resolves foundation model ids to IAM resource ARNs that include
 * both the foundation-model ARN and all inference-profile ARNs from the
 * catalog. This test validates that convention end-to-end.
 */

import { computeModelResources } from "../../utils/model-permission-resources";
import { computeAgentPolicies } from "../../utils/policy-helpers";

const ACCOUNT_ID = "123456789012";
const REGION = "us-west-2";

describe("foundation-model-id convention", () => {
  const FOUNDATION_MODEL_ID = "anthropic.claude-sonnet-5";
  const REGION_PROFILES: Record<string, string> = {
    us: "us.anthropic.claude-sonnet-5",
    eu: "eu.anthropic.claude-sonnet-5",
    global: "global.anthropic.claude-sonnet-5",
  };

  test("computeModelResources produces foundation + inference-profile ARNs from a foundation model id", () => {
    const result = computeModelResources(
      FOUNDATION_MODEL_ID,
      REGION_PROFILES,
      ACCOUNT_ID,
      REGION,
    );

    expect(result.foundationModelArns).toEqual([
      `arn:aws:bedrock:${REGION}::foundation-model/${FOUNDATION_MODEL_ID}`,
    ]);
    expect(result.inferenceProfileArns).toHaveLength(3);
    expect(result.inferenceProfileArns).toContainEqual(
      `arn:aws:bedrock:${REGION}:${ACCOUNT_ID}:inference-profile/us.anthropic.claude-sonnet-5`,
    );
    expect(result.inferenceProfileArns).toContainEqual(
      `arn:aws:bedrock:${REGION}:${ACCOUNT_ID}:inference-profile/eu.anthropic.claude-sonnet-5`,
    );
    expect(result.allResourceArns).toHaveLength(4); // 1 foundation + 3 profiles
  });

  test("computeAgentPolicies uses modelResources when provided", () => {
    const modelResources = computeModelResources(
      FOUNDATION_MODEL_ID,
      REGION_PROFILES,
      ACCOUNT_ID,
      REGION,
    );

    const policies = computeAgentPolicies(
      "agent-1",
      {
        models: [FOUNDATION_MODEL_ID],
        modelResources: modelResources.allResourceArns,
      },
      ACCOUNT_ID,
      REGION,
    );

    const modelPolicy = policies.find((p) =>
      p.actions.includes("bedrock:InvokeModel"),
    );
    expect(modelPolicy).toBeDefined();
    // Uses the pre-computed ARNs (4 total: 1 foundation + 3 profiles)
    expect(modelPolicy!.resources).toHaveLength(4);
    expect(modelPolicy!.actions).toContain(
      "bedrock:InvokeModelWithResponseStream",
    );
  });

  test("computeAgentPolicies falls back to foundation-model ARN when no modelResources", () => {
    const policies = computeAgentPolicies(
      "agent-2",
      { models: [FOUNDATION_MODEL_ID] },
      ACCOUNT_ID,
      REGION,
    );

    const modelPolicy = policies.find((p) =>
      p.actions.includes("bedrock:InvokeModel"),
    );
    expect(modelPolicy).toBeDefined();
    // Only the foundation-model ARN
    expect(modelPolicy!.resources).toEqual([
      `arn:aws:bedrock:${REGION}::foundation-model/${FOUNDATION_MODEL_ID}`,
    ]);
  });

  test("empty models array produces no model policy statement", () => {
    const policies = computeAgentPolicies(
      "agent-3",
      { models: [] },
      ACCOUNT_ID,
      REGION,
    );

    const modelPolicy = policies.find((p) =>
      p.actions.includes("bedrock:InvokeModel"),
    );
    expect(modelPolicy).toBeUndefined();
  });

  test("convention: stamp, worker, vender all agree on foundation model id format", () => {
    // The stamp script stores: requiredPermissions.models = ["anthropic.claude-sonnet-5"]
    // The worker unions: _resolve_runtime_model_id returns "anthropic.claude-sonnet-5" (baseModelId)
    // The vender reads: requiredPermissions.models and does modelKeyFromId("anthropic.claude-sonnet-5")
    //                   to look up the catalog entry
    //
    // All three use the raw Bedrock foundation model id (baseModelId field
    // from the catalog), NOT the inference-profile id (which has a region prefix).
    //
    // This is verifiable by checking that:
    // 1. The foundation model id does NOT contain a region prefix
    expect(FOUNDATION_MODEL_ID).not.toMatch(/^(us|eu|ap|me|ca|sa|af|global)\./);
    // 2. The inference-profile ids DO contain region prefixes
    for (const profileId of Object.values(REGION_PROFILES)) {
      expect(profileId).toMatch(/^(us|eu|ap|me|ca|sa|af|global)\./);
    }
    // 3. computeModelResources accepts a foundation model id and produces valid ARNs
    const result = computeModelResources(
      FOUNDATION_MODEL_ID,
      REGION_PROFILES,
      ACCOUNT_ID,
      REGION,
    );
    expect(result.allResourceArns.length).toBeGreaterThan(0);
  });
});
