import * as cdk from "aws-cdk-lib";
import { Template } from "aws-cdk-lib/assertions";
import * as dynamodb from "aws-cdk-lib/aws-dynamodb";
import * as events from "aws-cdk-lib/aws-events";
import * as lambda from "aws-cdk-lib/aws-lambda";
import * as appsync from "aws-cdk-lib/aws-appsync";
import { Bucket } from "aws-cdk-lib/aws-s3";
import * as path from "path";
import {
  scaffoldBackendAssetDirs,
  scaffoldArbiterStubs,
} from "./helpers/scaffold-stub-assets";

scaffoldBackendAssetDirs(["dist/lambda", "src/schema"]);
scaffoldArbiterStubs();

import { ArbiterStack } from "../lib/arbiter-stack";

// CIT-125 slice B: supervisor + fabricator event-id dedupe. Verifies the
// design's core wiring constraint — reuse of the EXISTING shared
// `citadel-idempotency-${env}` table (owned by BackendStack) via
// Table.fromTableName, with RW grants + IDEMPOTENCY_TABLE env on both
// consumer Lambdas, and NO new DynamoDB table created for this feature.

const ENVIRONMENT = "test";

function buildTemplate(): Template {
  const app = new cdk.App({ context: { "aws:cdk:bundling-stacks": [] } });
  const backendStack = new cdk.Stack(app, "MockBackendStack", {
    env: { account: "123456789012", region: "us-east-1" },
  });

  const agentEventBus = new events.EventBus(backendStack, "AgentEventBus", {
    eventBusName: `citadel-agents-${ENVIRONMENT}`,
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
    `citadel-agents-${ENVIRONMENT}`,
    "agentId",
  );
  const workflowsTable = mkTable(
    "WorkflowsTable",
    `citadel-workflows-${ENVIRONMENT}`,
    "workflowId",
  );
  const executionsTable = mkTable(
    "ExecutionsTable",
    `citadel-executions-${ENVIRONMENT}`,
    "executionId",
  );
  const executionSpecificationsTable = mkTable(
    "ExecutionSpecificationsTable",
    `citadel-execution-specifications-${ENVIRONMENT}`,
    "specId",
  );
  const codeBucket = new Bucket(backendStack, "CodeBucket", {
    bucketName: `citadel-code-${ENVIRONMENT}`,
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
    environment: ENVIRONMENT,
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

describe("ArbiterStack — CIT-125 slice B event-id/message-id dedupe wiring", () => {
  let template: Template;
  beforeAll(() => {
    template = buildTemplate();
  });

  test("no new DynamoDB table is created for idempotency (table count unchanged)", () => {
    // The idempotency table is owned by BackendStack and referenced by
    // name — ArbiterStack itself must synthesize zero AWS::DynamoDB::Table
    // resources whose TableName is the idempotency table.
    const tables = template.findResources("AWS::DynamoDB::Table", {
      Properties: { TableName: `citadel-idempotency-${ENVIRONMENT}` },
    });
    expect(Object.keys(tables)).toHaveLength(0);
  });

  test("supervisor has IDEMPOTENCY_TABLE env pointing at the shared table", () => {
    const fns = template.findResources("AWS::Lambda::Function");
    const supervisorIds = Object.keys(fns).filter((id) =>
      id.startsWith("SupervisorAgent"),
    );
    expect(supervisorIds).toHaveLength(1);
    const vars = fns[supervisorIds[0]].Properties.Environment.Variables;
    expect(vars.IDEMPOTENCY_TABLE).toBe(`citadel-idempotency-${ENVIRONMENT}`);
  });

  test("fabricator has IDEMPOTENCY_TABLE env pointing at the shared table", () => {
    const fns = template.findResources("AWS::Lambda::Function");
    const fabricatorIds = Object.keys(fns).filter((id) =>
      id.startsWith("FabricatorAgent"),
    );
    expect(fabricatorIds).toHaveLength(1);
    const vars = fns[fabricatorIds[0]].Properties.Environment.Variables;
    expect(vars.IDEMPOTENCY_TABLE).toBe(`citadel-idempotency-${ENVIRONMENT}`);
  });

  test("supervisor and fabricator both hold a read+write grant on the idempotency table ARN", () => {
    const expectedArn = {
      "Fn::Join": [
        "",
        [
          "arn:",
          { Ref: "AWS::Partition" },
          `:dynamodb:us-east-1:123456789012:table/citadel-idempotency-${ENVIRONMENT}`,
        ],
      ],
    };
    // Actual item-action set emitted by CDK's grantReadWriteData() for this
    // table (grantReadWriteData additionally emits a SEPARATE statement
    // with the stream-only actions GetRecords/GetShardIterator, harmlessly
    // present even though this table has no DynamoDB Stream — asserting on
    // the item-action statement here is sufficient to prove RW, not RO).
    const rwActions = [
      "dynamodb:BatchGetItem",
      "dynamodb:GetItem",
      "dynamodb:Scan",
      "dynamodb:Query",
      "dynamodb:ConditionCheckItem",
      "dynamodb:BatchWriteItem",
      "dynamodb:PutItem",
      "dynamodb:UpdateItem",
      "dynamodb:DeleteItem",
      "dynamodb:DescribeTable",
    ];

    const policies = template.findResources("AWS::IAM::Policy");
    let grantsFound = 0;
    for (const policy of Object.values(policies) as Array<{
      Properties: {
        PolicyDocument: { Statement: Array<Record<string, unknown>> };
      };
    }>) {
      for (const stmt of policy.Properties.PolicyDocument.Statement) {
        const resources = Array.isArray(stmt.Resource)
          ? stmt.Resource
          : [stmt.Resource];
        const matchesIdempotencyTable = resources.some(
          (r: unknown) => JSON.stringify(r) === JSON.stringify(expectedArn),
        );
        if (!matchesIdempotencyTable) continue;
        const actions = Array.isArray(stmt.Action)
          ? stmt.Action
          : [stmt.Action];
        // Skip the separate stream-actions statement grantReadWriteData
        // also emits (GetRecords/GetShardIterator) — only the item-action
        // statement is asserted here.
        if (actions.includes("dynamodb:GetRecords")) continue;
        // grantReadWriteData's item-action statement carries exactly this
        // set (order may vary) — not a superset, not a subset.
        expect([...actions].sort()).toEqual([...rwActions].sort());
        grantsFound += 1;
      }
    }
    // One grant statement per consumer (supervisor + fabricator).
    expect(grantsFound).toBe(2);
  });
});
