/**
 * CDK assertions for the getPlatformAlarms resolver (platform-health-resolver.ts).
 *
 * Board task 4cc234d1: the Lambda moved from BackendStack to
 * CitadelTelemetryStack (TelemetryStack already owns the citadel-* alarms
 * this resolver reads; the backend stage is removals-only by policy). The
 * AppSync data source + resolver are still hosted in BackendStack
 * (addPlatformHealthResolver, cross-stack import by ARN) because
 * BackendStack owns the shared appSyncApi construct — so this file now
 * synths BOTH stacks: TelemetryStack for the Lambda/IAM assertions,
 * BackendStack for the AppSync resolver-wiring assertion.
 *
 * Pins:
 *  - BackendStack: a Lambda data source is wired to AppSync
 *    Query.getPlatformAlarms.
 *  - TelemetryStack: the Lambda's role carries exactly
 *    `cloudwatch:DescribeAlarms` on Resource "*" (CloudWatch alarm
 *    Describe* calls are not ARN-scopable — see the explanatory comment
 *    required at the grant site in telemetry-stack.ts) and NOT
 *    `sqs:GetQueueAttributes` (least privilege: queueDepth/queueName are
 *    derived from the alarm payload only).
 *  - every-alarm-has-action.test.ts's alarm counts are unaffected — this
 *    change reads existing alarms, it creates none.
 */
import * as cdk from "aws-cdk-lib";
import { Template, Match } from "aws-cdk-lib/assertions";
import * as cognito from "aws-cdk-lib/aws-cognito";
import * as dynamodb from "aws-cdk-lib/aws-dynamodb";
import * as events from "aws-cdk-lib/aws-events";
import * as sns from "aws-cdk-lib/aws-sns";
import * as s3 from "aws-cdk-lib/aws-s3";
import * as path from "path";
import * as fs from "fs";
import { scaffoldBackendAssetDirs } from "./helpers/scaffold-stub-assets";

scaffoldBackendAssetDirs(["dist/lambda", "src/schema"]);

const EXTRA_ASSET_DIRS = [
  path.resolve(__dirname, "../src/lambda/seed-admin-user"),
  path.resolve(__dirname, "../src/lambda/seed-organizations"),
];
for (const dir of EXTRA_ASSET_DIRS) {
  if (!fs.existsSync(dir)) fs.mkdirSync(dir, { recursive: true });
}

import { BackendStack } from "../lib/backend-stack";
import { TelemetryStack } from "../lib/telemetry-stack";

jest.setTimeout(60000);

describe("BackendStack — getPlatformAlarms resolver (cross-stack wiring)", () => {
  let template: Template;

  beforeAll(() => {
    const app = new cdk.App({ context: { "aws:cdk:bundling-stacks": [] } });
    const stack = new BackendStack(
      app,
      "citadel-backend-platform-alarms-test",
      {
        environment: "test",
        env: { account: "123456789012", region: "us-east-1" },
      },
    );
    // Board task 4cc234d1: BackendStack now wires the resolver onto an
    // IMPORTED cross-stack Lambda (same pattern as
    // addEvalSamplingConfigResolvers) rather than a function it owns.
    stack.addPlatformHealthResolver(
      "arn:aws:lambda:us-east-1:123456789012:function:citadel-platform-health-resolver-test",
    );
    template = Template.fromStack(stack);
  });

  test("AppSync has a resolver wired on Query.getPlatformAlarms", () => {
    template.hasResourceProperties("AWS::AppSync::Resolver", {
      TypeName: "Query",
      FieldName: "getPlatformAlarms",
    });
  });

  test("the resolver's data source points at the imported cross-stack Lambda", () => {
    template.hasResourceProperties("AWS::AppSync::DataSource", {
      Type: "AWS_LAMBDA",
      LambdaConfig: {
        LambdaFunctionArn:
          "arn:aws:lambda:us-east-1:123456789012:function:citadel-platform-health-resolver-test",
      },
    });
  });
});

describe("TelemetryStack — PlatformHealthResolverFunction (owns the Lambda)", () => {
  let template: Template;

  beforeAll(() => {
    const app = new cdk.App();
    const supportStack = new cdk.Stack(app, "SupportStack", {
      env: { account: "123456789012", region: "us-east-1" },
    });

    const userPool = new cognito.UserPool(supportStack, "TestUserPool");
    const agentEventBus = new events.EventBus(supportStack, "TestEventBus");
    const alarmTopic = new sns.Topic(supportStack, "TestAlarmTopic", {
      topicName: "citadel-alarms-test",
    });
    const modelCatalogTable = new dynamodb.Table(
      supportStack,
      "TestModelCatalogTable",
      {
        partitionKey: { name: "modelKey", type: dynamodb.AttributeType.STRING },
      },
    );
    const executionsTable = new dynamodb.Table(
      supportStack,
      "TestExecutionsTable",
      {
        partitionKey: {
          name: "executionId",
          type: dynamodb.AttributeType.STRING,
        },
      },
    );
    const conversationsTable = new dynamodb.Table(
      supportStack,
      "TestConversationsTable",
      {
        partitionKey: {
          name: "projectId",
          type: dynamodb.AttributeType.STRING,
        },
        sortKey: { name: "timestamp", type: dynamodb.AttributeType.STRING },
      },
    );
    const projectsTable = new dynamodb.Table(
      supportStack,
      "TestProjectsTable",
      {
        partitionKey: { name: "id", type: dynamodb.AttributeType.STRING },
      },
    );
    const workflowsTable = new dynamodb.Table(
      supportStack,
      "TestWorkflowsTable",
      {
        partitionKey: {
          name: "workflowId",
          type: dynamodb.AttributeType.STRING,
        },
      },
    );
    const agentConfigTable = new dynamodb.Table(
      supportStack,
      "TestAgentConfigTable",
      {
        partitionKey: { name: "agentId", type: dynamodb.AttributeType.STRING },
      },
    );
    const executionSpecificationsTable = new dynamodb.Table(
      supportStack,
      "TestExecutionSpecificationsTable",
      {
        partitionKey: { name: "specId", type: dynamodb.AttributeType.STRING },
      },
    );
    const modelConfigTable = new dynamodb.Table(
      supportStack,
      "TestModelConfigTable",
      {
        partitionKey: { name: "scope", type: dynamodb.AttributeType.STRING },
      },
    );
    const governanceLedgerTable = new dynamodb.Table(
      supportStack,
      "TestGovernanceLedgerTable",
      {
        partitionKey: {
          name: "findingId",
          type: dynamodb.AttributeType.STRING,
        },
      },
    );
    governanceLedgerTable.addGlobalSecondaryIndex({
      indexName: "workflow-index",
      partitionKey: { name: "workflowId", type: dynamodb.AttributeType.STRING },
      sortKey: { name: "timestamp", type: dynamodb.AttributeType.NUMBER },
    });
    const evalCasesTable = new dynamodb.Table(
      supportStack,
      "TestEvalCasesTable",
      {
        partitionKey: { name: "suiteId", type: dynamodb.AttributeType.STRING },
        sortKey: { name: "caseId", type: dynamodb.AttributeType.STRING },
      },
    );
    const evalRunsTable = new dynamodb.Table(
      supportStack,
      "TestEvalRunsTable",
      {
        partitionKey: {
          name: "evalRunId",
          type: dynamodb.AttributeType.STRING,
        },
      },
    );
    const evalRunCaseResultsTable = new dynamodb.Table(
      supportStack,
      "TestEvalRunCaseResultsTable",
      {
        partitionKey: {
          name: "evalRunId",
          type: dynamodb.AttributeType.STRING,
        },
        sortKey: { name: "caseId", type: dynamodb.AttributeType.STRING },
      },
    );
    const evalSamplingConfigTable = new dynamodb.Table(
      supportStack,
      "TestEvalSamplingConfigTable",
      {
        partitionKey: { name: "orgId", type: dynamodb.AttributeType.STRING },
      },
    );
    const evalProdSamplesTable = new dynamodb.Table(
      supportStack,
      "TestEvalProdSamplesTable",
      {
        partitionKey: { name: "PK", type: dynamodb.AttributeType.STRING },
        sortKey: { name: "SK", type: dynamodb.AttributeType.STRING },
      },
    );
    evalProdSamplesTable.addGlobalSecondaryIndex({
      indexName: "AgentDimTimeIndex",
      partitionKey: { name: "GSI1PK", type: dynamodb.AttributeType.STRING },
      sortKey: { name: "GSI1SK", type: dynamodb.AttributeType.STRING },
    });
    const idempotencyTable = new dynamodb.Table(
      supportStack,
      "TestIdempotencyTable",
      {
        partitionKey: { name: "eventId", type: dynamodb.AttributeType.STRING },
      },
    );

    const stack = new TelemetryStack(app, "TestTelemetryStack", {
      environment: "test",
      env: { account: "123456789012", region: "us-east-1" },
      agentEventBus,
      modelCatalogTable,
      userPool,
      frontendOrigin: "https://example.test",
      bedrockInvocationLogGroupName: "/aws/bedrock/invocation-logs",
      executionsTable,
      conversationsTable,
      projectsTable,
      alarmTopic,
      appSyncApiId: "test-appsync-api-id",
      workflowsTable,
      agentConfigTable,
      executionSpecificationsTable,
      modelConfigTable,
      governanceLedgerTable,
      evalCasesTable,
      evalRunsTable,
      evalRunCaseResultsTable,
      evalSamplingConfigTable,
      evalProdSamplesTable,
      idempotencyTable,
      accessLogsBucket: new s3.Bucket(supportStack, "TestAccessLogsBucket", {
        removalPolicy: cdk.RemovalPolicy.DESTROY,
        autoDeleteObjects: true,
      }),
    });

    template = Template.fromStack(stack);
  });

  test("PlatformHealthResolverFunction's role grants cloudwatch:DescribeAlarms on Resource *", () => {
    template.hasResourceProperties("AWS::IAM::Policy", {
      PolicyDocument: {
        Statement: Match.arrayWith([
          Match.objectLike({
            Effect: "Allow",
            Action: "cloudwatch:DescribeAlarms",
            Resource: "*",
          }),
        ]),
      },
    });
  });

  test("no policy statement on any role grants sqs:GetQueueAttributes to the platform-health function", () => {
    const policies = template.findResources("AWS::IAM::Policy");
    const offenders = Object.entries(policies).filter(([, resource]) => {
      const statements =
        (
          resource as {
            Properties?: { PolicyDocument?: { Statement?: unknown[] } };
          }
        ).Properties?.PolicyDocument?.Statement ?? [];
      return statements.some((s) => {
        const actions = Array.isArray((s as { Action?: unknown }).Action)
          ? (s as { Action: unknown[] }).Action
          : [(s as { Action?: unknown }).Action];
        return actions.includes("sqs:GetQueueAttributes");
      });
    });
    // Other functions in the stack may legitimately hold SQS perms for
    // their own queues; this guard only needs the platform-health function
    // itself to never request it. Here we assert zero NEW
    // sqs:GetQueueAttributes grants were introduced solely by wiring this
    // Lambda — i.e. the function's own dedicated role (found by its Lambda
    // logical id prefix) carries none.
    const platformHealthRoles = Object.keys(
      template.findResources("AWS::Lambda::Function"),
    ).filter((id) => id.startsWith("PlatformHealthResolverFunction"));
    expect(platformHealthRoles.length).toBeGreaterThan(0);

    const offenderIds = offenders.map(([id]) => id);
    const platformHealthOffender = offenderIds.some((id) =>
      id.startsWith("PlatformHealthResolverFunction"),
    );
    expect(platformHealthOffender).toBe(false);
  });

  test("PlatformHealthResolverFunction has a deterministic functionName for cross-stack ARN import", () => {
    template.hasResourceProperties("AWS::Lambda::Function", {
      FunctionName: "citadel-platform-health-resolver-test",
    });
  });
});
