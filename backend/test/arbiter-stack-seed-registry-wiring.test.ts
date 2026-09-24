/**
 * Seed Lambda — AgentCore Registry wiring (dual-store agent seam),
 * SSM-resolved.
 *
 * The seedConfig custom-resource Lambda must be able to create the
 * demo-echo-agent's AgentCore Registry record (in addition to its DDB row)
 * so the out-of-box demo flow can pass the app-publish readiness gate
 * (agent binding DESIGN→READY resolves the agent by name in the registry).
 *
 * Since finding 8b7ee8af the registry id/arn are resolved from the SSM
 * parameters `/citadel/<env>/registry/{id,arn}` instead of props, so the
 * wiring is unconditional (the old without-props variant is gone).
 *
 * Asserts on SeedAgentConfigFunction:
 *   A. Catalog layer attached (unconditional — enables the
 *      catalog.registry_client import used for the idempotency lookup).
 *   B. REGISTRY_ID (SSM Ref) / REGISTRY_ENABLED / REGISTRY_GENERATION env.
 *   C. Minimal bedrock-agentcore grants (CreateRegistryRecord +
 *      ListRegistryRecords ONLY) scoped to the SSM-resolved registry arn
 *      (+ /*). No mutation surface beyond create.
 *   D. SeedAgentConfigResource Version bumped so the seed re-runs on the
 *      next deploy and creates the registry record in existing envs.
 */
import * as cdk from "aws-cdk-lib";
import { Template } from "aws-cdk-lib/assertions";
import * as dynamodb from "aws-cdk-lib/aws-dynamodb";
import * as events from "aws-cdk-lib/aws-events";
import { Bucket } from "aws-cdk-lib/aws-s3";
import {
  scaffoldBackendAssetDirs,
  scaffoldArbiterStubs,
} from "./helpers/scaffold-stub-assets";
import {
  CfnPolicyResourceLike,
  CfnResourceLike,
  CfnStatementLike,
  registrySsmParamLogicalIds,
  TemplateJson,
} from "./helpers/registry-ssm";
import { REGISTRY_GENERATION } from "../lib/registry-generation";

// CI + clean-checkout safety: stub the asset dirs that ArbiterStack expects.
scaffoldBackendAssetDirs(["dist/lambda", "src/schema"]);
scaffoldArbiterStubs();

import { ArbiterStack } from "../lib/arbiter-stack";

type Resources = TemplateJson["Resources"];

function buildStack(): TemplateJson {
  const app = new cdk.App({ context: { "aws:cdk:bundling-stacks": [] } });
  const backendStack = new cdk.Stack(app, "MockBackendStack", {
    env: { account: "123456789012", region: "us-east-1" },
  });
  const agentEventBus = new events.EventBus(backendStack, "AgentEventBus", {
    eventBusName: "citadel-agents-test",
  });
  const agentConfigTable = new dynamodb.Table(
    backendStack,
    "AgentConfigTable",
    {
      tableName: "citadel-agents-test",
      partitionKey: { name: "agentId", type: dynamodb.AttributeType.STRING },
      billingMode: dynamodb.BillingMode.PAY_PER_REQUEST,
      removalPolicy: cdk.RemovalPolicy.DESTROY,
    },
  );
  const codeBucket = new Bucket(backendStack, "CodeBucket", {
    bucketName: "citadel-code-test",
  });
  const executionSpecificationsTable = new dynamodb.Table(
    backendStack,
    "ExecutionSpecificationsTable",
    {
      tableName: "citadel-execution-specifications-test",
      partitionKey: { name: "specId", type: dynamodb.AttributeType.STRING },
      billingMode: dynamodb.BillingMode.PAY_PER_REQUEST,
      removalPolicy: cdk.RemovalPolicy.DESTROY,
    },
  );
  const stack = new ArbiterStack(app, "TestArbiterStack", {
    environment: "test",
    env: { account: "123456789012", region: "us-east-1" },
    agentEventBus,
    agentConfigTable,
    codeBucket,
    executionSpecificationsTable,
  });
  return Template.fromStack(stack).toJSON() as TemplateJson;
}

function findSeedLambdaId(resources: Resources): string {
  const entry = Object.entries(resources).find(
    ([key, r]) =>
      r.Type === "AWS::Lambda::Function" &&
      key.startsWith("SeedAgentConfigFunction"),
  );
  if (!entry) throw new Error("SeedAgentConfigFunction not found");
  return entry[0];
}

function seedEnv(resources: Resources): Record<string, unknown> {
  return (
    resources[findSeedLambdaId(resources)]?.Properties?.Environment
      ?.Variables ?? {}
  );
}

function getPoliciesForLambda(
  resources: Resources,
  lambdaLogicalId: string,
): CfnPolicyResourceLike[] {
  const roleRef = (
    resources[lambdaLogicalId]?.Properties?.Role as
      { "Fn::GetAtt"?: string[] } | undefined
  )?.["Fn::GetAtt"]?.[0];
  if (!roleRef) return [];
  return (Object.values(resources) as CfnPolicyResourceLike[]).filter(
    (r) =>
      r.Type === "AWS::IAM::Policy" &&
      Array.isArray(r.Properties?.Roles) &&
      r.Properties.Roles.some((role) => role.Ref === roleRef),
  );
}

function collectAgentcoreStatements(
  policies: CfnPolicyResourceLike[],
): CfnStatementLike[] {
  const statements: CfnStatementLike[] = [];
  for (const p of policies) {
    for (const stmt of p.Properties?.PolicyDocument?.Statement ?? []) {
      const actions = Array.isArray(stmt.Action) ? stmt.Action : [stmt.Action];
      if (
        actions.some(
          (a: unknown) =>
            typeof a === "string" && a.startsWith("agent-registry:"),
        )
      ) {
        statements.push(stmt);
      }
    }
  }
  return statements;
}

function findSeedCustomResource(resources: Resources): CfnResourceLike {
  const entry = Object.entries(resources).find(
    ([key, r]) =>
      r.Type === "AWS::CloudFormation::CustomResource" &&
      key.startsWith("SeedAgentConfigResource"),
  );
  if (!entry) throw new Error("SeedAgentConfigResource not found");
  return entry[1];
}

describe("ArbiterStack — seed Lambda registry wiring (dual-store agent seam)", () => {
  let template: TemplateJson;
  let resources: Resources;
  let idParam: string;
  let arnParam: string;

  beforeAll(() => {
    template = buildStack();
    resources = template.Resources;
    ({ idParam, arnParam } = registrySsmParamLogicalIds(template, "test"));
  });

  test("A. seed Lambda has the catalog layer attached", () => {
    const layers = resources[findSeedLambdaId(resources)]?.Properties?.Layers;
    expect(Array.isArray(layers)).toBe(true);
    const layerRefs = (layers as Array<{ Ref?: string }>)
      .map((l) => l.Ref)
      .filter((ref): ref is string => Boolean(ref));
    expect(
      layerRefs.some((ref: string) => ref.startsWith("ArbiterCatalogLayer")),
    ).toBe(true);
  });

  test("B. seed env carries REGISTRY_ID (SSM Ref), REGISTRY_ENABLED and REGISTRY_GENERATION", () => {
    const env = seedEnv(resources);
    expect(env.REGISTRY_ID).toEqual({ Ref: idParam });
    expect(env.REGISTRY_ENABLED).toBe("true");
    expect(env.REGISTRY_GENERATION).toBe(REGISTRY_GENERATION);
  });

  test("C1. seed role grants CreateRegistryRecord + ListRegistryRecords scoped to the SSM-resolved registry arn", () => {
    const statements = collectAgentcoreStatements(
      getPoliciesForLambda(resources, findSeedLambdaId(resources)),
    );
    expect(statements.length).toBeGreaterThanOrEqual(1);
    const actions = statements.flatMap((s) =>
      Array.isArray(s.Action) ? s.Action : [s.Action],
    );
    expect(actions).toContain("agent-registry:CreateRegistryRecord");
    expect(actions).toContain("agent-registry:ListRegistryRecords");
    for (const stmt of statements) {
      const resourceList = Array.isArray(stmt.Resource)
        ? stmt.Resource
        : [stmt.Resource];
      expect(resourceList).toEqual(
        expect.arrayContaining([
          { Ref: arnParam },
          { "Fn::Join": ["", [{ Ref: arnParam }, "/*"]] },
        ]),
      );
    }
  });

  test("C2. seed role has NO registry mutation actions beyond create (least privilege)", () => {
    const actions = collectAgentcoreStatements(
      getPoliciesForLambda(resources, findSeedLambdaId(resources)),
    ).flatMap((s) => (Array.isArray(s.Action) ? s.Action : [s.Action]));
    for (const forbidden of [
      "agent-registry:UpdateRegistryRecord",
      "agent-registry:UpdateRegistryRecordStatus",
      "agent-registry:SubmitRegistryRecordForApproval",
      "agent-registry:DeleteRegistryRecord",
    ]) {
      expect(actions).not.toContain(forbidden);
    }
  });

  test("D. SeedAgentConfigResource Version bumped to v1.4.0", () => {
    expect(findSeedCustomResource(resources).Properties?.Version).toBe(
      "v1.4.0",
    );
  });
});
