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

// Idempotency-seam smoke fixture: the smoke table, the worker's
// least-privilege PutItem-only grant on it, and the wired env vars — all
// gated to exist ONLY in non-production environments.
function buildTemplate(environment: string): Template {
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

describe("ArbiterStack — idempotency-seam smoke fixture (non-prod only)", () => {
  describe("non-prod environment ('test')", () => {
    let template: Template;
    beforeAll(() => {
      template = buildTemplate("test");
    });

    test("smoke table exists, org-scoped key + TTL + SSE", () => {
      template.hasResourceProperties("AWS::DynamoDB::Table", {
        TableName: "citadel-smoke-idempotency-test",
        KeySchema: Match.arrayWith([
          { AttributeName: "orgId", KeyType: "HASH" },
          { AttributeName: "markerId", KeyType: "RANGE" },
        ]),
        TimeToLiveSpecification: { AttributeName: "ttl", Enabled: true },
        SSESpecification: Match.objectLike({ SSEEnabled: true }),
        BillingMode: "PAY_PER_REQUEST",
      });
    });

    test("worker env wires the smoke table name", () => {
      template.hasResourceProperties("AWS::Lambda::Function", {
        Handler: "index.lambda_handler",
        Environment: {
          Variables: Match.objectLike({
            SMOKE_IDEMPOTENCY_TABLE: Match.anyValue(),
          }),
        },
      });
    });

    test("seed lambda env sets SMOKE_FIXTURES_ENABLED=true", () => {
      template.hasResourceProperties("AWS::Lambda::Function", {
        Handler: "index.handler",
        Environment: {
          Variables: Match.objectLike({
            SMOKE_FIXTURES_ENABLED: "true",
          }),
        },
      });
    });

    test("worker grant on the smoke table is PutItem ONLY — no Get/Query/Scan/Update/Delete", () => {
      template.hasResourceProperties("AWS::IAM::Policy", {
        PolicyDocument: {
          Statement: Match.arrayWith([
            Match.objectLike({
              Effect: "Allow",
              Action: "dynamodb:PutItem",
            }),
          ]),
        },
      });

      // Exact-array style defense-in-depth: no policy statement referencing
      // the smoke table ARN carries any action beyond PutItem.
      const smokeTables = template.findResources("AWS::DynamoDB::Table", {
        Properties: { TableName: "citadel-smoke-idempotency-test" },
      });
      const smokeLogicalId = Object.keys(smokeTables)[0];
      expect(smokeLogicalId).toBeDefined();

      const policies = template.findResources("AWS::IAM::Policy");
      const forbidden = [
        "dynamodb:GetItem",
        "dynamodb:Query",
        "dynamodb:Scan",
        "dynamodb:UpdateItem",
        "dynamodb:DeleteItem",
        "dynamodb:*",
      ];
      let foundSmokeGrant = false;
      for (const policy of Object.values(policies) as any[]) {
        for (const stmt of policy.Properties.PolicyDocument.Statement) {
          const resStr = JSON.stringify(stmt.Resource ?? "");
          if (!resStr.includes(smokeLogicalId)) continue;
          const actions = Array.isArray(stmt.Action)
            ? stmt.Action
            : [stmt.Action];
          foundSmokeGrant = true;
          expect(actions).toEqual(["dynamodb:PutItem"]);
          for (const f of forbidden) {
            expect(actions).not.toContain(f);
          }
        }
      }
      expect(foundSmokeGrant).toBe(true);
    });
  });

  describe("production environment ('prod') — smoke fixtures ABSENT", () => {
    let template: Template;
    beforeAll(() => {
      template = buildTemplate("prod");
    });

    test("no smoke table is synthesized", () => {
      const tables = template.findResources("AWS::DynamoDB::Table", {
        Properties: { TableName: "citadel-smoke-idempotency-prod" },
      });
      expect(Object.keys(tables)).toHaveLength(0);
    });

    test("worker env does NOT carry SMOKE_IDEMPOTENCY_TABLE", () => {
      const functions = template.findResources("AWS::Lambda::Function", {
        Properties: { Handler: "index.lambda_handler" },
      });
      for (const fn of Object.values(functions) as any[]) {
        const vars = fn.Properties.Environment?.Variables ?? {};
        expect(vars).not.toHaveProperty("SMOKE_IDEMPOTENCY_TABLE");
      }
    });

    test("seed lambda env does NOT set SMOKE_FIXTURES_ENABLED", () => {
      const functions = template.findResources("AWS::Lambda::Function", {
        Properties: { Handler: "index.handler" },
      });
      let sawSeedFn = false;
      for (const fn of Object.values(functions) as any[]) {
        const vars = fn.Properties.Environment?.Variables ?? {};
        if ("AGENT_CONFIG_TABLE" in vars) {
          sawSeedFn = true;
          expect(vars).not.toHaveProperty("SMOKE_FIXTURES_ENABLED");
        }
      }
      expect(sawSeedFn).toBe(true);
    });

    test("no IAM policy statement anywhere references a smoke table", () => {
      const policies = template.findResources("AWS::IAM::Policy");
      for (const policy of Object.values(policies) as any[]) {
        for (const stmt of policy.Properties.PolicyDocument.Statement) {
          const resStr = JSON.stringify(stmt.Resource ?? "").toLowerCase();
          expect(resStr).not.toContain("smokeidempotency");
        }
      }
    });
  });
});
