/**
 * Deploy-safety retention pins (findings 7f42ae86 provenance / 9c92a738
 * divergent-branch deletion).
 *
 * Finding 9c92a738: a divergent-branch deploy reconciles the environment to
 * the deployed tree and can silently DELETE stateful resources. The defence in
 * CDK is RemovalPolicy.RETAIN (+ DynamoDB deletionProtection where supported)
 * on every DATA-BEARING store, so CloudFormation refuses to tear the store
 * down and the loss becomes a LOUD orphaned-resource / AlreadyExists failure
 * instead of a silent DELETE_COMPLETE.
 *
 * These assertions pin that posture for the resources this change flipped from
 * DESTROY to RETAIN — executions (backend), governance ledger + tool-execution
 * ledger + tool-results bucket (arbiter) — and pin the DELIBERATE EXCLUSION of
 * the disposable smoke fixture (which must stay DESTROY so it self-cleans and
 * never becomes an orphan that blocks a later deploy).
 */

import * as cdk from "aws-cdk-lib";
import { Template, Match } from "aws-cdk-lib/assertions";
import * as dynamodb from "aws-cdk-lib/aws-dynamodb";
import * as events from "aws-cdk-lib/aws-events";
import * as lambda from "aws-cdk-lib/aws-lambda";
import * as appsync from "aws-cdk-lib/aws-appsync";
import { Bucket } from "aws-cdk-lib/aws-s3";
import * as path from "path";
import * as fs from "fs";
import {
  scaffoldBackendAssetDirs,
  scaffoldArbiterStubs,
} from "./helpers/scaffold-stub-assets";

scaffoldBackendAssetDirs(["dist/lambda", "src/schema"]);
scaffoldArbiterStubs();

// BackendStack also needs these seed-lambda asset dirs to synth.
for (const dir of [
  path.resolve(__dirname, "../../src/lambda/seed-organizations"),
  path.resolve(__dirname, "../src/lambda/seed-admin-user"),
  path.resolve(__dirname, "../src/lambda/seed-organizations"),
]) {
  if (!fs.existsSync(dir)) fs.mkdirSync(dir, { recursive: true });
}

import { BackendStack } from "../lib/backend-stack";
import { ArbiterStack } from "../lib/arbiter-stack";

function buildArbiterTemplate(environment: string): Template {
  const app = new cdk.App({ context: { "aws:cdk:bundling-stacks": [] } });
  const backendStack = new cdk.Stack(app, "MockBackendStack", {
    env: { account: "123456789012", region: "us-east-1" },
  });
  const agentEventBus = new events.EventBus(backendStack, "AgentEventBus", {
    eventBusName: `citadel-agents-${environment}`,
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
    `citadel-agents-${environment}`,
    "agentId",
  );
  const workflowsTable = mkTable(
    "WorkflowsTable",
    `citadel-workflows-${environment}`,
    "workflowId",
  );
  const executionsTable = mkTable(
    "ExecutionsTable",
    `citadel-executions-${environment}`,
    "executionId",
  );
  const executionSpecificationsTable = mkTable(
    "ExecutionSpecificationsTable",
    `citadel-execution-specifications-${environment}`,
    "specId",
  );
  const codeBucket = new Bucket(backendStack, "CodeBucket", {
    bucketName: `citadel-code-${environment}`,
  });
  const fanoutFunction = new lambda.Function(backendStack, "FanoutFunction", {
    runtime: lambda.Runtime.NODEJS_24_X,
    handler: "workflow-progress-fanout.handler",
    code: lambda.Code.fromAsset("dist/lambda"),
    timeout: cdk.Duration.seconds(30),
  });
  const appSyncApi = new appsync.GraphqlApi(backendStack, "MockApi", {
    name: "mock-api",
    schema: appsync.SchemaFile.fromAsset(
      path.resolve(__dirname, "../src/schema/schema.graphql"),
    ),
  });

  const stack = new ArbiterStack(app, "TestArbiterStack", {
    environment,
    env: { account: "123456789012", region: "us-east-1" },
    agentEventBus,
    agentConfigTable,
    codeBucket,
    workflowsTable,
    executionsTable,
    fanoutFunction,
    appSyncEndpoint: appSyncApi.graphqlUrl,
    executionSpecificationsTable,
  });
  return Template.fromStack(stack);
}

// Helper: assert a DynamoDB table by name carries RETAIN + deletionProtection.
function expectRetainedProtectedTable(template: Template, tableName: string) {
  const tables = template.findResources("AWS::DynamoDB::Table", {
    Properties: { TableName: tableName },
  });
  const ids = Object.keys(tables);
  expect(ids).toHaveLength(1);
  const resource = tables[ids[0]];
  expect(resource.DeletionPolicy).toBe("Retain");
  expect(resource.UpdateReplacePolicy).toBe("Retain");
  expect(resource.Properties.DeletionProtectionEnabled).toBe(true);
}

describe("Deploy-safety retention — BackendStack executions table", () => {
  let template: Template;
  beforeAll(() => {
    const app = new cdk.App();
    const stack = new BackendStack(app, "TestBackendStackRetention", {
      environment: "test",
      env: { account: "123456789012", region: "us-east-1" },
    });
    template = Template.fromStack(stack);
  });

  test("executions table is RETAIN + deletionProtection (data-bearing execution history)", () => {
    expectRetainedProtectedTable(template, "citadel-executions-test");
  });

  test("executions table keeps PITR", () => {
    template.hasResourceProperties("AWS::DynamoDB::Table", {
      TableName: "citadel-executions-test",
      PointInTimeRecoverySpecification: { PointInTimeRecoveryEnabled: true },
    });
  });
});

describe("Deploy-safety retention — ArbiterStack data-bearing stores", () => {
  let template: Template;
  beforeAll(() => {
    template = buildArbiterTemplate("test");
  });

  test("governance ledger table is RETAIN + deletionProtection (audit store)", () => {
    expectRetainedProtectedTable(template, "citadel-governance-ledger-test");
  });

  test("governance ledger keeps its row-level TTL (deletionProtection guards the table, not rows)", () => {
    template.hasResourceProperties("AWS::DynamoDB::Table", {
      TableName: "citadel-governance-ledger-test",
      TimeToLiveSpecification: { AttributeName: "ttl", Enabled: true },
    });
  });

  test("tool-execution ledger table is RETAIN + deletionProtection (live idempotency state)", () => {
    expectRetainedProtectedTable(
      template,
      "citadel-tool-execution-ledger-test",
    );
  });

  test("tool-execution ledger keeps its row-level TTL", () => {
    template.hasResourceProperties("AWS::DynamoDB::Table", {
      TableName: "citadel-tool-execution-ledger-test",
      TimeToLiveSpecification: { AttributeName: "ttl", Enabled: true },
    });
  });

  test("tool-results offload bucket is RETAIN (offloaded results referenced by unexpired ledger rows)", () => {
    const buckets = template.findResources("AWS::S3::Bucket", {
      Properties: {
        BucketName: "citadel-tool-results-test-123456789012-us-east-1",
      },
    });
    const ids = Object.keys(buckets);
    expect(ids).toHaveLength(1);
    const resource = buckets[ids[0]];
    expect(resource.DeletionPolicy).toBe("Retain");
    expect(resource.UpdateReplacePolicy).toBe("Retain");
  });

  test("tool-results bucket keeps its 7-day operational lifecycle rule (RETAIN blocks teardown, TTL still expires objects)", () => {
    template.hasResourceProperties("AWS::S3::Bucket", {
      BucketName: "citadel-tool-results-test-123456789012-us-east-1",
      LifecycleConfiguration: {
        Rules: Match.arrayWith([
          Match.objectLike({
            Id: "tool-results-operational-ttl",
            Status: "Enabled",
            ExpirationInDays: 7,
          }),
        ]),
      },
    });
  });

  // --- Deliberate EXCLUSION: the disposable smoke fixture must stay DESTROY ---
  test("smoke idempotency fixture is DESTROY and NOT deletion-protected (disposable, self-cleaning)", () => {
    const tables = template.findResources("AWS::DynamoDB::Table", {
      Properties: { TableName: "citadel-smoke-idempotency-test" },
    });
    const ids = Object.keys(tables);
    expect(ids).toHaveLength(1);
    const resource = tables[ids[0]];
    expect(resource.DeletionPolicy).toBe("Delete");
    expect(resource.UpdateReplacePolicy).toBe("Delete");
    // Must NOT be deletion-protected: RETAIN on a self-cleaning fixture would
    // orphan it and block a later re-add (AlreadyExists) for zero data value.
    expect(resource.Properties.DeletionProtectionEnabled).not.toBe(true);
  });
});
