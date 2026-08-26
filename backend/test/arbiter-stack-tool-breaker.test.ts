import * as cdk from "aws-cdk-lib";
import { Template, Match } from "aws-cdk-lib/assertions";
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

// Per-target tool circuit breaker (task 28d624b1): the org-scoped state table
// (RETAIN + deletionProtection + TTL), the CDK->function env delivery of the
// TOOL_BREAKER_* tunables, and the least-privilege (Put/Get/Update, NO
// Delete/Scan) worker grant scoped to the one table.
describe("ArbiterStack — tool-target circuit breaker (task 28d624b1)", () => {
  let template: Template;

  beforeAll(() => {
    const app = new cdk.App({ context: { "aws:cdk:bundling-stacks": [] } });
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
    const workflowsTable = mkTable(
      "WorkflowsTable",
      "citadel-workflows-test",
      "workflowId",
    );
    const executionsTable = mkTable(
      "ExecutionsTable",
      "citadel-executions-test",
      "executionId",
    );
    const executionSpecificationsTable = mkTable(
      "ExecutionSpecificationsTable",
      "citadel-execution-specifications-test",
      "specId",
    );
    const codeBucket = new Bucket(backendStack, "CodeBucket", {
      bucketName: "citadel-code-test",
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
      environment: "test",
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
    template = Template.fromStack(stack);
  });

  test("breaker table has org-scoped composite key, TTL, PITR, and SSE", () => {
    template.hasResourceProperties("AWS::DynamoDB::Table", {
      TableName: "citadel-tool-breaker-state-test",
      KeySchema: Match.arrayWith([
        { AttributeName: "pk", KeyType: "HASH" },
        { AttributeName: "sk", KeyType: "RANGE" },
      ]),
      TimeToLiveSpecification: { AttributeName: "ttl", Enabled: true },
      PointInTimeRecoverySpecification: { PointInTimeRecoveryEnabled: true },
      SSESpecification: Match.objectLike({ SSEEnabled: true }),
      BillingMode: "PAY_PER_REQUEST",
      DeletionProtectionEnabled: true,
    });
  });

  test("breaker table is RETAIN (deletion + update-replace) — no silent teardown", () => {
    template.hasResource("AWS::DynamoDB::Table", {
      Properties: Match.objectLike({
        TableName: "citadel-tool-breaker-state-test",
      }),
      DeletionPolicy: "Retain",
      UpdateReplacePolicy: "Retain",
    });
  });

  test("worker env wires the breaker table + tunables (CDK -> function env)", () => {
    template.hasResourceProperties("AWS::Lambda::Function", {
      Handler: "index.lambda_handler",
      Environment: {
        Variables: Match.objectLike({
          TOOL_BREAKER_TABLE: Match.anyValue(),
          TOOL_BREAKER_FAILURE_THRESHOLD: "5",
          TOOL_BREAKER_WINDOW_SECONDS: "60",
          TOOL_BREAKER_RECOVERY_SECONDS: "30",
          TOOL_BREAKER_PROBE_LEASE_SECONDS: "30",
          TOOL_BREAKER_CACHE_TTL_SECONDS: "3",
        }),
      },
    });
  });

  test("worker grant on the breaker table has no Delete/Scan on it", () => {
    // Scan every IAM statement that references the breaker table's logical id
    // and assert none carries DeleteItem/Scan/Query (least privilege — the
    // `ttl` attribute handles expiry; transitions are conditional updates).
    const breakerTables = template.findResources("AWS::DynamoDB::Table", {
      Properties: { TableName: "citadel-tool-breaker-state-test" },
    });
    const breakerLogicalId = Object.keys(breakerTables)[0];
    expect(breakerLogicalId).toBeDefined();

    const policies = template.findResources("AWS::IAM::Policy");
    const forbidden = [
      "dynamodb:DeleteItem",
      "dynamodb:Scan",
      "dynamodb:Query",
    ];
    let sawBreakerGrant = false;
    for (const policy of Object.values(policies)) {
      for (const stmt of policy.Properties.PolicyDocument.Statement) {
        const refsBreaker = JSON.stringify(stmt.Resource ?? "").includes(
          breakerLogicalId,
        );
        if (refsBreaker) {
          sawBreakerGrant = true;
          const actions = Array.isArray(stmt.Action)
            ? stmt.Action
            : [stmt.Action];
          for (const f of forbidden) {
            expect(actions).not.toContain(f);
          }
          expect(actions).toEqual(
            expect.arrayContaining([
              "dynamodb:PutItem",
              "dynamodb:GetItem",
              "dynamodb:UpdateItem",
            ]),
          );
        }
      }
    }
    expect(sawBreakerGrant).toBe(true);
  });
});
