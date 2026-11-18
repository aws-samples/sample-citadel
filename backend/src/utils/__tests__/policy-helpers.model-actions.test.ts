/**
 * PR-5 Workstream 1: computeAgentPolicies must emit both bedrock:InvokeModel
 * and bedrock:InvokeModelWithResponseStream, and support pre-computed
 * modelResources ARNs alongside the legacy models-only path.
 */
import { computeAgentPolicies, AgentPermissions } from "../policy-helpers";

describe("computeAgentPolicies model actions (PR-5)", () => {
  const accountId = "123456789012";
  const region = "us-west-2";

  test("models non-empty produces both InvokeModel and InvokeModelWithResponseStream", () => {
    const permissions: AgentPermissions = {
      models: ["anthropic.claude-sonnet-4-20250514-v1:0"],
    };
    const policies = computeAgentPolicies(
      "agent-1",
      permissions,
      accountId,
      region,
    );

    const modelPolicy = policies.find((p) =>
      p.actions.includes("bedrock:InvokeModel"),
    );
    expect(modelPolicy).toBeDefined();
    expect(modelPolicy!.actions).toContain("bedrock:InvokeModel");
    expect(modelPolicy!.actions).toContain(
      "bedrock:InvokeModelWithResponseStream",
    );
    expect(modelPolicy!.actions).toHaveLength(2);
  });

  test("modelResources provided uses those ARNs directly", () => {
    const permissions: AgentPermissions = {
      models: ["anthropic.claude-sonnet-4-20250514-v1:0"],
      modelResources: [
        "arn:aws:bedrock:us-west-2::foundation-model/anthropic.claude-sonnet-4-20250514-v1:0",
        "arn:aws:bedrock:us-west-2:123456789012:inference-profile/us.anthropic.claude-sonnet-4-20250514-v1:0",
      ],
    };
    const policies = computeAgentPolicies(
      "agent-1",
      permissions,
      accountId,
      region,
    );

    const modelPolicy = policies.find((p) =>
      p.actions.includes("bedrock:InvokeModel"),
    );
    expect(modelPolicy).toBeDefined();
    expect(modelPolicy!.resources).toEqual(permissions.modelResources);
  });

  test("empty models produces no model policy statement", () => {
    const permissions: AgentPermissions = { models: [] };
    const policies = computeAgentPolicies(
      "agent-1",
      permissions,
      accountId,
      region,
    );

    const modelPolicies = policies.filter((p) =>
      p.actions.some((a) => a.startsWith("bedrock:")),
    );
    expect(modelPolicies).toHaveLength(0);
  });

  test("models without modelResources falls back to foundation-model ARNs", () => {
    const permissions: AgentPermissions = {
      models: ["anthropic.claude-sonnet-4-20250514-v1:0"],
    };
    const policies = computeAgentPolicies(
      "agent-1",
      permissions,
      accountId,
      region,
    );

    const modelPolicy = policies.find((p) =>
      p.actions.includes("bedrock:InvokeModel"),
    );
    expect(modelPolicy).toBeDefined();
    expect(modelPolicy!.resources).toEqual([
      `arn:aws:bedrock:${region}::foundation-model/anthropic.claude-sonnet-4-20250514-v1:0`,
    ]);
  });
});
