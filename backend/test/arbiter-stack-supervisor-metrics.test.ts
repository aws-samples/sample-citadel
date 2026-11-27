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
import {
  CfnPolicyResourceLike,
  CfnStatementLike,
} from "./helpers/registry-ssm";

scaffoldBackendAssetDirs(["dist/lambda", "src/schema"]);
scaffoldArbiterStubs();

import { ArbiterStack } from "../lib/arbiter-stack";

/**
 * The supervisor emits best-effort metrics (release-dispatch, canary
 * assignment, approval-dispatch, GovernanceModeDefaulted, org-source
 * mismatch) that had no cloudwatch:PutMetricData grant behind them. Every
 * call failed with AccessDenied inside its catch, so the signals never
 * landed. Namespaces written by the supervisor package:
 *   - Citadel/Workflows: arbiter/common/metrics_constants.METRIC_NAMESPACE
 *     (supervisor/index.py) and governance/hierarchy.py
 *   - Citadel/Arbiter: SupervisorOrgSourceMismatch (supervisor/index.py) and
 *     common/tenant_guard.py
 */
const SUPERVISOR_METRIC_NAMESPACES = ["Citadel/Arbiter", "Citadel/Workflows"];

function createFixture(app: cdk.App) {
  const backendStack = new cdk.Stack(app, "MockBackendStack", {
    env: { account: "123456789012", region: "us-east-1" },
  });

  const table = (id: string, name: string, key: string) =>
    new dynamodb.Table(backendStack, id, {
      tableName: name,
      partitionKey: { name: key, type: dynamodb.AttributeType.STRING },
      billingMode: dynamodb.BillingMode.PAY_PER_REQUEST,
      removalPolicy: cdk.RemovalPolicy.DESTROY,
    });

  const appSyncApi = new appsync.GraphqlApi(backendStack, "MockApi", {
    name: "mock-api",
    schema: appsync.SchemaFile.fromAsset(
      path.resolve(__dirname, "../src/schema/schema.graphql"),
    ),
  });

  return {
    agentEventBus: new events.EventBus(backendStack, "AgentEventBus", {
      eventBusName: "citadel-agents-test",
    }),
    agentConfigTable: table(
      "AgentConfigTable",
      "citadel-agents-test",
      "agentId",
    ),
    codeBucket: new Bucket(backendStack, "CodeBucket", {
      bucketName: "citadel-code-test",
    }),
    workflowsTable: table(
      "WorkflowsTable",
      "citadel-workflows-test",
      "workflowId",
    ),
    executionsTable: table(
      "ExecutionsTable",
      "citadel-executions-test",
      "executionId",
    ),
    fanoutFunction: new lambda.Function(backendStack, "FanoutFunction", {
      runtime: lambda.Runtime.NODEJS_24_X,
      handler: "workflow-progress-fanout.handler",
      code: lambda.Code.fromAsset("dist/lambda"),
      timeout: cdk.Duration.seconds(30),
    }),
    appSyncEndpoint: appSyncApi.graphqlUrl,
    appsTable: table("AppsTable", "citadel-apps-test", "appId"),
    executionSpecificationsTable: table(
      "ExecutionSpecificationsTable",
      "citadel-execution-specifications-test",
      "specId",
    ),
  };
}

describe("ArbiterStack — supervisor metric publishing grant", () => {
  let template: Template;

  beforeAll(() => {
    const app = new cdk.App({ context: { "aws:cdk:bundling-stacks": [] } });
    const stack = new ArbiterStack(app, "TestArbiterStack", {
      environment: "test",
      env: { account: "123456789012", region: "us-east-1" },
      ...createFixture(app),
    });
    template = Template.fromStack(stack);
  });

  function supervisorRoleLogicalId(): string {
    const functions = template.findResources("AWS::Lambda::Function", {
      Properties: Match.objectLike({
        Environment: {
          Variables: Match.objectLike({
            ORCHESTRATION_TABLE: Match.anyValue(),
            WORKER_STATE_TABLE: Match.anyValue(),
          }),
        },
      }),
    });
    const ids = Object.keys(functions);
    expect(ids).toHaveLength(1);
    const role = (
      functions[ids[0]].Properties as { Role?: { "Fn::GetAtt"?: string[] } }
    ).Role?.["Fn::GetAtt"]?.[0];
    expect(role).toBeDefined();
    return role as string;
  }

  function putMetricDataStatements(): CfnStatementLike[] {
    const roleId = supervisorRoleLogicalId();
    const policies = template.findResources(
      "AWS::IAM::Policy",
    ) as unknown as Record<string, CfnPolicyResourceLike>;
    const out: CfnStatementLike[] = [];
    for (const policy of Object.values(policies)) {
      if (!policy.Properties?.Roles?.some((r) => r.Ref === roleId)) continue;
      for (const statement of policy.Properties?.PolicyDocument?.Statement ??
        []) {
        const actions = ([] as string[]).concat(statement.Action ?? []);
        if (actions.includes("cloudwatch:PutMetricData")) out.push(statement);
      }
    }
    return out;
  }

  test("the supervisor role has exactly one PutMetricData statement, Allow on Resource *", () => {
    const statements = putMetricDataStatements();
    expect(statements).toHaveLength(1);
    expect(statements[0].Effect).toBe("Allow");
    expect(statements[0].Resource).toBe("*");
  });

  test("the statement's cloudwatch:namespace StringEquals condition lists exactly the namespaces the supervisor writes", () => {
    const [statement] = putMetricDataStatements();
    const condition = statement?.Condition as
      { StringEquals?: Record<string, string | string[]> } | undefined;
    const namespaces = ([] as string[]).concat(
      condition?.StringEquals?.["cloudwatch:namespace"] ?? [],
    );
    expect([...namespaces].sort()).toEqual(SUPERVISOR_METRIC_NAMESPACES);
  });

  test("the statement grants only PutMetricData (no other CloudWatch action rides along)", () => {
    const [statement] = putMetricDataStatements();
    expect(([] as string[]).concat(statement?.Action ?? [])).toEqual([
      "cloudwatch:PutMetricData",
    ]);
  });
});
