/**
 * Seed custom resource forced re-run properties.
 *
 * After external damage to seeder rows (e.g. a backfill incident), there was
 * no way to force a seeder re-run without a code change. Two new properties
 * close this gap on all three seed custom resources:
 *
 *   - `SeedRunVersion` — a constant bumped in code to force a one-time
 *     re-run on the next deploy (e.g. to heal damaged rows).
 *   - `HealNonce` — read from CDK context `seedHealNonce` (default ''),
 *     so an operator can force a re-run without a code change:
 *     `npx cdk deploy citadel-<stack>-<env> -c seedHealNonce=$(date +%s)`
 *
 * These tests prove:
 *   1. All three seed custom resources carry both properties.
 *   2. SeedRunVersion is a number ≥ 2 (the initial bump value).
 *   3. HealNonce defaults to '' when no context is supplied.
 *   4. HealNonce reflects the CDK context value when supplied.
 */

import * as cdk from "aws-cdk-lib";
import { Template } from "aws-cdk-lib/assertions";
import * as dynamodb from "aws-cdk-lib/aws-dynamodb";
import * as events from "aws-cdk-lib/aws-events";
import { Bucket } from "aws-cdk-lib/aws-s3";
import * as fs from "fs";
import * as path from "path";
import {
  scaffoldBackendAssetDirs,
  scaffoldArbiterStubs,
} from "./helpers/scaffold-stub-assets";

scaffoldBackendAssetDirs(["dist/lambda", "src/schema"]);
scaffoldArbiterStubs();

// Ensure seed-organizations and seed-admin-user asset dirs exist
for (const sub of ["seed-admin-user", "seed-organizations"]) {
  const dir = path.resolve(__dirname, "..", "src", "lambda", sub);
  if (!fs.existsSync(dir)) fs.mkdirSync(dir, { recursive: true });
}

import { ArbiterStack } from "../lib/arbiter-stack";
import { BackendStack } from "../lib/backend-stack";

/** Find custom resource properties by logical ID prefix. */
function findCustomResourceProps(
  template: Template,
  idPrefix: string,
): Record<string, unknown> {
  const resources = template.findResources(
    "AWS::CloudFormation::CustomResource",
  );
  const entry = Object.entries(resources).find(([key]) =>
    key.startsWith(idPrefix),
  );
  if (!entry) throw new Error(`${idPrefix} not found in template`);
  return (
    (entry[1] as { Properties?: Record<string, unknown> }).Properties ?? {}
  );
}

// ---------------------------------------------------------------------------
// ArbiterStack — SeedAgentConfigResource
// ---------------------------------------------------------------------------
function buildArbiterStack(context: Record<string, string> = {}): cdk.Stack {
  const app = new cdk.App({
    context: { "aws:cdk:bundling-stacks": [], ...context },
  });
  const backendStack = new cdk.Stack(app, "MockBackendStack", {
    env: { account: "123456789012", region: "us-east-1" },
  });
  const agentEventBus = new events.EventBus(backendStack, "AgentEventBus", {
    eventBusName: "citadel-agents-test",
  });
  const mkTable = (id: string, name: string, pk: string) =>
    new dynamodb.Table(backendStack, id, {
      tableName: name,
      partitionKey: { name: pk, type: dynamodb.AttributeType.STRING },
      billingMode: dynamodb.BillingMode.PAY_PER_REQUEST,
      removalPolicy: cdk.RemovalPolicy.DESTROY,
    });
  const agentConfigTable = mkTable(
    "AgentConfigTable",
    "citadel-agents-test",
    "agentId",
  );
  const executionSpecificationsTable = mkTable(
    "ExecutionSpecificationsTable",
    "citadel-execution-specifications-test",
    "specId",
  );
  const codeBucket = new Bucket(backendStack, "CodeBucket", {
    bucketName: "citadel-code-test",
  });
  return new ArbiterStack(app, "TestArbiterStack", {
    environment: "test",
    env: { account: "123456789012", region: "us-east-1" },
    agentEventBus,
    agentConfigTable,
    codeBucket,
    executionSpecificationsTable,
  });
}

describe("ArbiterStack — SeedAgentConfigResource forced re-run properties", () => {
  let template: Template;
  beforeAll(() => {
    template = Template.fromStack(buildArbiterStack());
  });

  test("carries SeedRunVersion ≥ 2", () => {
    const props = findCustomResourceProps(template, "SeedAgentConfigResource");
    expect(typeof props.SeedRunVersion).toBe("number");
    expect(props.SeedRunVersion as number).toBeGreaterThanOrEqual(2);
  });

  test("HealNonce defaults to empty string when no context supplied", () => {
    const props = findCustomResourceProps(template, "SeedAgentConfigResource");
    expect(props.HealNonce).toBe("");
  });

  test("HealNonce reflects the seedHealNonce CDK context value", () => {
    const stack = buildArbiterStack({ seedHealNonce: "1730880000" });
    const tmpl = Template.fromStack(stack);
    const props = findCustomResourceProps(tmpl, "SeedAgentConfigResource");
    expect(props.HealNonce).toBe("1730880000");
  });
});

// ---------------------------------------------------------------------------
// BackendStack — SeedBlueprintsResource + SeedEvalSuitesResource
// ---------------------------------------------------------------------------
function buildBackendStack(context: Record<string, string> = {}): cdk.Stack {
  const app = new cdk.App({
    context: { adminEmail: "test@example.com", ...context },
  });
  return new BackendStack(app, "TestBackendStack", {
    environment: "test",
    env: { account: "123456789012", region: "us-east-1" },
  });
}

describe("BackendStack — SeedBlueprintsResource forced re-run properties", () => {
  let template: Template;
  beforeAll(() => {
    template = Template.fromStack(buildBackendStack());
  });

  test("carries SeedRunVersion ≥ 2", () => {
    const props = findCustomResourceProps(template, "SeedBlueprintsResource");
    expect(typeof props.SeedRunVersion).toBe("number");
    expect(props.SeedRunVersion as number).toBeGreaterThanOrEqual(2);
  });

  test("HealNonce defaults to empty string when no context supplied", () => {
    const props = findCustomResourceProps(template, "SeedBlueprintsResource");
    expect(props.HealNonce).toBe("");
  });

  test("HealNonce reflects the seedHealNonce CDK context value", () => {
    const stack = buildBackendStack({ seedHealNonce: "1730880000" });
    const tmpl = Template.fromStack(stack);
    const props = findCustomResourceProps(tmpl, "SeedBlueprintsResource");
    expect(props.HealNonce).toBe("1730880000");
  });
});

describe("BackendStack — SeedEvalSuitesResource forced re-run properties", () => {
  let template: Template;
  beforeAll(() => {
    template = Template.fromStack(buildBackendStack());
  });

  test("carries SeedRunVersion ≥ 2", () => {
    const props = findCustomResourceProps(template, "SeedEvalSuitesResource");
    expect(typeof props.SeedRunVersion).toBe("number");
    expect(props.SeedRunVersion as number).toBeGreaterThanOrEqual(2);
  });

  test("HealNonce defaults to empty string when no context supplied", () => {
    const props = findCustomResourceProps(template, "SeedEvalSuitesResource");
    expect(props.HealNonce).toBe("");
  });

  test("HealNonce reflects the seedHealNonce CDK context value", () => {
    const stack = buildBackendStack({ seedHealNonce: "1730880000" });
    const tmpl = Template.fromStack(stack);
    const props = findCustomResourceProps(tmpl, "SeedEvalSuitesResource");
    expect(props.HealNonce).toBe("1730880000");
  });
});
