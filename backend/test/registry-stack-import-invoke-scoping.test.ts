/**
 * CIT-176 residual findings — AgentImportResolver invoke/assume-role grant
 * scoping regression guard.
 *
 * Asserts that:
 *   (a) `lambda:InvokeFunction` and `execute-api:Invoke` carry an
 *       `aws:ResourceAccount` StringEquals condition pinned to the deployment
 *       account — defense-in-depth that prevents a confused-deputy from
 *       redirecting invoke traffic outside the account even if the ARN
 *       pattern were ever broadened.
 *   (b) `sts:AssumeRole` carries the Null sts:ExternalId false condition
 *       (this already holds; included for completeness).
 *   (c) `bedrock-agentcore:InvokeAgentRuntime` and `bedrock:InvokeAgent`
 *       live on a SEPARATE statement from `lambda:InvokeFunction` /
 *       `execute-api:Invoke` so each pair can carry its own condition set.
 */
import * as cdk from "aws-cdk-lib";
import { Template } from "aws-cdk-lib/assertions";
import * as appsync from "aws-cdk-lib/aws-appsync";
import * as cognito from "aws-cdk-lib/aws-cognito";
import * as dynamodb from "aws-cdk-lib/aws-dynamodb";
import * as events from "aws-cdk-lib/aws-events";
import * as path from "path";
import { scaffoldBackendAssetDirs } from "./helpers/scaffold-stub-assets";

scaffoldBackendAssetDirs(["dist/lambda", "src/schema"]);

import { RegistryStack } from "../lib/registry-stack";

const ACCOUNT = "123456789012";
const REGION = "us-east-1";

interface CfnIamStatement {
  Action: string | string[];
  Resource?: unknown;
  Condition?: Record<string, Record<string, string>>;
  [key: string]: unknown;
}

interface CfnIamPolicyResource {
  Properties?: {
    Roles?: Array<{ Ref?: string }>;
    PolicyDocument?: {
      Statement?: CfnIamStatement[];
    };
  };
}

interface CfnLambdaFunctionResource {
  Properties?: {
    Handler?: string;
    Role?: { "Fn::GetAtt"?: [string, string] };
  };
}

function actionsOf(stmt: CfnIamStatement): string[] {
  return Array.isArray(stmt.Action) ? stmt.Action : [stmt.Action];
}

describe("CIT-176 — AgentImportResolver invoke & assume-role scoping", () => {
  let importPolicyStatements: CfnIamStatement[];

  beforeAll(() => {
    const app = new cdk.App();
    const backendStack = new cdk.Stack(app, "MockBackendStack", {
      env: { account: ACCOUNT, region: REGION },
    });

    const agentEventBus = new events.EventBus(backendStack, "AgentEventBus", {
      eventBusName: "citadel-agents-test",
    });

    const appSyncApi = new appsync.GraphqlApi(backendStack, "MockApi", {
      name: "mock-api",
      schema: appsync.SchemaFile.fromAsset(
        path.resolve(__dirname, "../src/schema/schema.graphql"),
      ),
    });

    const makeTable = (id: string, name: string) =>
      new dynamodb.Table(backendStack, id, {
        tableName: name,
        partitionKey: { name: "pk", type: dynamodb.AttributeType.STRING },
        billingMode: dynamodb.BillingMode.PAY_PER_REQUEST,
        removalPolicy: cdk.RemovalPolicy.DESTROY,
      });

    const stack = new RegistryStack(app, "TestRegistryStackInvokeScoping", {
      environment: "test",
      env: { account: ACCOUNT, region: REGION },
      appSyncApi,
      agentEventBus,
      appsTable: makeTable("AppsTable", "citadel-apps-test"),
      workflowsTable: makeTable("WorkflowsTable", "citadel-workflows-test"),
      agentConfigTable: makeTable("AgentConfigTable", "citadel-agent-config-test"),
      modelCatalogTable: makeTable("ModelCatalogTable", "citadel-model-catalog-test"),
      idempotencyTable: makeTable("IdempotencyTable", "citadel-idempotency-test"),
      userPool: new cognito.UserPool(backendStack, "UserPool"),
      adrsTable: makeTable("AdrsTable", "citadel-adrs-test"),
      organisationTable: makeTable("OrganisationTable", "citadel-organisations-test"),
    });

    const template = Template.fromStack(stack);

    // Find the agent-import resolver Lambda's role
    const lambdas = template.findResources(
      "AWS::Lambda::Function",
    ) as Record<string, CfnLambdaFunctionResource>;
    const importLambda = Object.values(lambdas).find(
      (l) => l.Properties?.Handler === "agent-import-resolver.handler",
    );
    expect(importLambda).toBeDefined();
    const roleLogicalId = importLambda!.Properties!.Role!["Fn::GetAtt"]![0];

    // Collect all IAM policy statements attached to that role
    const policies = template.findResources(
      "AWS::IAM::Policy",
    ) as Record<string, CfnIamPolicyResource>;
    importPolicyStatements = [];
    for (const policy of Object.values(policies)) {
      const roles = policy.Properties?.Roles ?? [];
      const matchesRole = roles.some((r) => r.Ref === roleLogicalId);
      if (!matchesRole) continue;
      const stmts = policy.Properties?.PolicyDocument?.Statement ?? [];
      importPolicyStatements.push(...stmts);
    }
  });

  test("lambda:InvokeFunction and execute-api:Invoke carry aws:ResourceAccount condition", () => {
    const invokeStmt = importPolicyStatements.find((s) => {
      const actions = actionsOf(s);
      return (
        actions.includes("lambda:InvokeFunction") &&
        actions.includes("execute-api:Invoke")
      );
    });
    expect(invokeStmt).toBeDefined();
    expect(invokeStmt!.Condition).toBeDefined();
    expect(invokeStmt!.Condition!.StringEquals).toBeDefined();
    expect(
      invokeStmt!.Condition!.StringEquals["aws:ResourceAccount"],
    ).toBe(ACCOUNT);
  });

  test("lambda:InvokeFunction and bedrock-agentcore:InvokeAgentRuntime are on separate statements", () => {
    // No single statement should combine lambda:InvokeFunction with
    // bedrock-agentcore:InvokeAgentRuntime — they have different scoping needs.
    for (const stmt of importPolicyStatements) {
      const actions = actionsOf(stmt);
      const hasLambdaInvoke = actions.includes("lambda:InvokeFunction");
      const hasBedrockAgentcore = actions.includes(
        "bedrock-agentcore:InvokeAgentRuntime",
      );
      expect(
        hasLambdaInvoke && hasBedrockAgentcore,
      ).toBe(false);
    }
  });

  test("sts:AssumeRole has Null sts:ExternalId false condition (completeness check)", () => {
    const assumeStmt = importPolicyStatements.find((s) => {
      const actions = actionsOf(s);
      return actions.length === 1 && actions[0] === "sts:AssumeRole";
    });
    expect(assumeStmt).toBeDefined();
    expect(assumeStmt!.Condition).toEqual({
      Null: { "sts:ExternalId": "false" },
    });
  });
});
