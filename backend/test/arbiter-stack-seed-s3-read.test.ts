/**
 * Seed Lambda — S3 head_object / GetObject grant (agents/* prefix).
 *
 * The seedConfig custom-resource Lambda's `_copy_s3_to_scoped_key` helper
 * calls `s3:HeadObject` on `agents/{recordId}/{basename}` to check whether
 * the scoped key already exists before copying. HeadObject is authorised
 * by the `s3:GetObject` permission, so the seed role must carry GetObject
 * on the code bucket's `agents/*` prefix.
 *
 * Without this grant the head_object call returns a 403 (the check is
 * non-fatal — the seed treats 403 as "skip" — but it means the idempotency
 * check never fires and the seed always re-copies on every deploy).
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

// CI + clean-checkout safety
scaffoldBackendAssetDirs(["dist/lambda", "src/schema"]);
scaffoldArbiterStubs();

import { ArbiterStack } from "../lib/arbiter-stack";

function buildTemplate(): ReturnType<typeof Template.fromStack> {
  const app = new cdk.App({ context: { "aws:cdk:bundling-stacks": [] } });
  const backend = new cdk.Stack(app, "MockBackendStack", {
    env: { account: "123456789012", region: "us-east-1" },
  });
  const agentEventBus = new events.EventBus(backend, "AgentEventBus", {
    eventBusName: "citadel-agents-test",
  });
  const agentConfigTable = new dynamodb.Table(backend, "AgentConfigTable", {
    tableName: "citadel-agents-test",
    partitionKey: { name: "agentId", type: dynamodb.AttributeType.STRING },
    billingMode: dynamodb.BillingMode.PAY_PER_REQUEST,
    removalPolicy: cdk.RemovalPolicy.DESTROY,
  });
  const codeBucket = new Bucket(backend, "CodeBucket", {
    bucketName: "citadel-code-test",
  });
  const executionSpecificationsTable = new dynamodb.Table(
    backend,
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
  return Template.fromStack(stack);
}

describe("ArbiterStack — seed Lambda S3 read grant for head_object", () => {
  let template: ReturnType<typeof Template.fromStack>;

  beforeAll(() => {
    template = buildTemplate();
  });

  test("seed Lambda role has s3:GetObject on the code bucket agents/* prefix", () => {
    // Find the seed Lambda's role
    const resources = template.toJSON().Resources as Record<
      string,
      { Type: string; Properties: Record<string, unknown> }
    >;

    const seedLambdaId = Object.keys(resources).find(
      (key) =>
        resources[key].Type === "AWS::Lambda::Function" &&
        key.startsWith("SeedAgentConfigFunction"),
    );
    expect(seedLambdaId).toBeDefined();

    const roleRef = (
      resources[seedLambdaId!].Properties.Role as {
        "Fn::GetAtt"?: string[];
      }
    )?.["Fn::GetAtt"]?.[0];
    expect(roleRef).toBeDefined();

    // Collect all IAM policy statements attached to the seed role
    const policies = Object.values(resources).filter(
      (r) =>
        r.Type === "AWS::IAM::Policy" &&
        Array.isArray(
          (r.Properties as { Roles?: Array<{ Ref?: string }> }).Roles,
        ) &&
        (r.Properties as { Roles: Array<{ Ref?: string }> }).Roles.some(
          (role) => role.Ref === roleRef,
        ),
    );

    // Flatten all statements
    type Statement = {
      Effect: string;
      Action: string | string[];
      Resource: unknown;
    };
    const allStatements: Statement[] = [];
    for (const p of policies) {
      const doc = (
        p.Properties as { PolicyDocument: { Statement: Statement[] } }
      ).PolicyDocument;
      allStatements.push(...doc.Statement);
    }

    // Look for a statement granting s3:GetObject (covers HeadObject)
    const getObjectStatements = allStatements.filter((stmt) => {
      const actions = Array.isArray(stmt.Action) ? stmt.Action : [stmt.Action];
      return (
        stmt.Effect === "Allow" &&
        actions.some(
          (a: string) => a === "s3:GetObject" || a === "s3:GetObject*",
        )
      );
    });

    expect(getObjectStatements.length).toBeGreaterThanOrEqual(1);

    // Verify at least one of them scopes to the agents/* prefix
    const resourceJsons = getObjectStatements.map((s) =>
      JSON.stringify(s.Resource),
    );
    const hasAgentsPrefix = resourceJsons.some((r) => r.includes("agents/*"));
    expect(hasAgentsPrefix).toBe(true);
  });
});
