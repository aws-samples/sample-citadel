import * as cdk from "aws-cdk-lib";
import { Template, Match } from "aws-cdk-lib/assertions";
import * as dynamodb from "aws-cdk-lib/aws-dynamodb";
import * as events from "aws-cdk-lib/aws-events";
import * as path from "path";
import * as fs from "fs";

// Ensure asset directories exist for CDK synthesis
const assetDirs = [path.resolve(__dirname, "../dist/lambda")];
for (const dir of assetDirs) {
  if (!fs.existsSync(dir)) fs.mkdirSync(dir, { recursive: true });
}

import { GatewayStack, GatewayStackProps } from "../lib/gateway-stack";

function createTestStack(): { stack: GatewayStack; template: Template } {
  const app = new cdk.App();

  // Create a helper stack to hold shared resources
  const helperStack = new cdk.Stack(app, "HelperStack", {
    env: { account: "123456789012", region: "us-east-1" },
  });

  const appsTable = new dynamodb.Table(helperStack, "AppsTable", {
    tableName: "citadel-apps-test",
    partitionKey: { name: "appId", type: dynamodb.AttributeType.STRING },
    billingMode: dynamodb.BillingMode.PAY_PER_REQUEST,
    removalPolicy: cdk.RemovalPolicy.DESTROY,
  });

  const eventBus = new events.EventBus(helperStack, "EventBus", {
    eventBusName: "citadel-agents-test",
  });

  const idempotencyTable = new dynamodb.Table(helperStack, "IdempotencyTable", {
    tableName: "citadel-idempotency-test",
    partitionKey: { name: "eventId", type: dynamodb.AttributeType.STRING },
    billingMode: dynamodb.BillingMode.PAY_PER_REQUEST,
    removalPolicy: cdk.RemovalPolicy.DESTROY,
  });

  const stack = new GatewayStack(app, "TestGatewayStack", {
    env: { account: "123456789012", region: "us-east-1" },
    environment: "test",
    appsTable,
    eventBus,
    idempotencyTable,
  });

  const template = Template.fromStack(stack);
  return { stack, template };
}

describe("GatewayStack — Shared Lambda Functions (Task 1.1)", () => {
  let template: Template;

  beforeAll(() => {
    ({ template } = createTestStack());
  });

  // --- AppApiAuthorizer Lambda ---
  test("creates AppApiAuthorizer Lambda with Node.js 24.x runtime", () => {
    template.hasResourceProperties("AWS::Lambda::Function", {
      Runtime: "nodejs24.x",
      Handler: "app-api-authorizer.handler",
      Timeout: 10,
    });
  });

  test("AppApiAuthorizer has APPS_TABLE environment variable", () => {
    template.hasResourceProperties("AWS::Lambda::Function", {
      Handler: "app-api-authorizer.handler",
      Environment: {
        Variables: Match.objectLike({
          APPS_TABLE: Match.anyValue(),
        }),
      },
    });
  });

  // --- AppPublishHandler Lambda ---
  test("creates AppPublishHandler Lambda with Node.js 24.x runtime and 120s timeout", () => {
    template.hasResourceProperties("AWS::Lambda::Function", {
      Runtime: "nodejs24.x",
      Handler: "app-publish-handler.handler",
      Timeout: 120,
    });
  });

  test("AppPublishHandler has required environment variables", () => {
    template.hasResourceProperties("AWS::Lambda::Function", {
      Handler: "app-publish-handler.handler",
      Environment: {
        Variables: Match.objectLike({
          APPS_TABLE: Match.anyValue(),
          EVENT_BUS_NAME: Match.anyValue(),
          ENVIRONMENT: "test",
          AUTHORIZER_FUNCTION_ARN: Match.anyValue(),
          IDEMPOTENCY_TABLE: Match.anyValue(),
        }),
      },
    });
  });

  // --- API-key HMAC pepper wiring (authorizer + publish handler) ---
  test("AppApiAuthorizer has ENVIRONMENT environment variable", () => {
    template.hasResourceProperties("AWS::Lambda::Function", {
      Handler: "app-api-authorizer.handler",
      Environment: {
        Variables: Match.objectLike({
          ENVIRONMENT: "test",
        }),
      },
    });
  });

  test("AppApiAuthorizer role grants ssm:GetParameter on the app-api-key-pepper parameter", () => {
    template.hasResourceProperties("AWS::IAM::Policy", {
      PolicyDocument: {
        Statement: Match.arrayWith([
          Match.objectLike({
            Effect: "Allow",
            Action: "ssm:GetParameter",
            Resource: Match.stringLikeRegexp(
              "parameter/citadel/test/app-api-key-pepper",
            ),
          }),
        ]),
      },
    });
  });

  test("AppApiAuthorizer role grants kms:Decrypt on the SSM-managed key alias", () => {
    template.hasResourceProperties("AWS::IAM::Policy", {
      PolicyDocument: {
        Statement: Match.arrayWith([
          Match.objectLike({
            Effect: "Allow",
            Action: "kms:Decrypt",
            Resource: Match.stringLikeRegexp("alias/aws/ssm"),
          }),
        ]),
      },
    });
  });

  test("AppPublishHandler role grants ssm:GetParameter on the app-api-key-pepper parameter", () => {
    const policies = template.findResources("AWS::IAM::Policy");
    const lambdas = template.findResources("AWS::Lambda::Function");
    const handlerLogicalId = Object.keys(lambdas).find(
      (k) => lambdas[k].Properties?.Handler === "app-publish-handler.handler",
    );
    expect(handlerLogicalId).toBeDefined();
    const handlerRoleRef =
      lambdas[handlerLogicalId!].Properties.Role?.["Fn::GetAtt"]?.[0];
    expect(handlerRoleRef).toBeDefined();

    const handlerPolicies = Object.values(policies).filter((p: any) =>
      (p.Properties?.Roles ?? []).some((r: any) => r.Ref === handlerRoleRef),
    );

    const matched = handlerPolicies.some((policy: any) =>
      (policy.Properties.PolicyDocument.Statement as any[]).some((stmt) => {
        const actions: string[] = Array.isArray(stmt.Action)
          ? stmt.Action
          : [stmt.Action];
        const resourceStr = JSON.stringify(stmt.Resource ?? "");
        return (
          actions.includes("ssm:GetParameter") &&
          resourceStr.includes("parameter/citadel/test/app-api-key-pepper")
        );
      }),
    );
    expect(matched).toBe(true);
  });

  test("AppPublishHandler role grants kms:Decrypt on the SSM-managed key alias", () => {
    const policies = template.findResources("AWS::IAM::Policy");
    const lambdas = template.findResources("AWS::Lambda::Function");
    const handlerLogicalId = Object.keys(lambdas).find(
      (k) => lambdas[k].Properties?.Handler === "app-publish-handler.handler",
    );
    const handlerRoleRef =
      lambdas[handlerLogicalId!].Properties.Role?.["Fn::GetAtt"]?.[0];

    const handlerPolicies = Object.values(policies).filter((p: any) =>
      (p.Properties?.Roles ?? []).some((r: any) => r.Ref === handlerRoleRef),
    );

    const matched = handlerPolicies.some((policy: any) =>
      (policy.Properties.PolicyDocument.Statement as any[]).some((stmt) => {
        const actions: string[] = Array.isArray(stmt.Action)
          ? stmt.Action
          : [stmt.Action];
        const resourceStr = JSON.stringify(stmt.Resource ?? "");
        return (
          actions.includes("kms:Decrypt") &&
          resourceStr.includes("alias/aws/ssm")
        );
      }),
    );
    expect(matched).toBe(true);
  });

  // --- AppMetricsHandler Lambda ---
  test("creates AppMetricsHandler Lambda with Node.js 24.x runtime and 60s timeout", () => {
    template.hasResourceProperties("AWS::Lambda::Function", {
      Runtime: "nodejs24.x",
      Handler: "app-metrics-handler.handler",
      Timeout: 60,
    });
  });

  test("AppMetricsHandler has APPS_TABLE environment variable", () => {
    template.hasResourceProperties("AWS::Lambda::Function", {
      Handler: "app-metrics-handler.handler",
      Environment: {
        Variables: Match.objectLike({
          APPS_TABLE: Match.anyValue(),
        }),
      },
    });
  });

  // --- Exactly 3 Lambda functions ---
  test("creates exactly 3 Lambda functions", () => {
    template.resourceCountIs("AWS::Lambda::Function", 3);
  });
});

describe("GatewayStack — IAM Permissions (Task 1.1)", () => {
  let template: Template;

  beforeAll(() => {
    ({ template } = createTestStack());
  });

  test("publish handler has API Gateway management permissions", () => {
    template.hasResourceProperties("AWS::IAM::Policy", {
      PolicyDocument: {
        Statement: Match.arrayWith([
          Match.objectLike({
            Action: Match.arrayWith([
              "apigateway:POST",
              "apigateway:GET",
              "apigateway:DELETE",
              "apigateway:PUT",
              "apigateway:PATCH",
            ]),
            Resource: "arn:aws:apigateway:*::/apis*",
          }),
        ]),
      },
    });
  });

  test("publish handler has IAM role management permissions for citadel-agent-* roles", () => {
    template.hasResourceProperties("AWS::IAM::Policy", {
      PolicyDocument: {
        Statement: Match.arrayWith([
          Match.objectLike({
            Action: Match.arrayWith([
              "iam:CreateRole",
              "iam:DeleteRole",
              "iam:PutRolePolicy",
              "iam:DeleteRolePolicy",
              "iam:TagRole",
              "iam:GetRole",
            ]),
            Resource: Match.arrayWith([
              Match.stringLikeRegexp(
                "arn:aws:iam::123456789012:role/citadel-agent-\\*",
              ),
            ]),
          }),
        ]),
      },
    });
  });

  test("publish handler has STS:AssumeRole scoped to citadel-agent-* roles", () => {
    template.hasResourceProperties("AWS::IAM::Policy", {
      PolicyDocument: {
        Statement: Match.arrayWith([
          Match.objectLike({
            Action: "sts:AssumeRole",
            Resource: Match.stringLikeRegexp(
              "arn:aws:iam::123456789012:role/citadel-agent-\\*",
            ),
          }),
        ]),
      },
    });
  });

  test("publish handler has STS:GetCallerIdentity permission (requires Resource::*)", () => {
    template.hasResourceProperties("AWS::IAM::Policy", {
      PolicyDocument: {
        Statement: Match.arrayWith([
          Match.objectLike({
            Action: "sts:GetCallerIdentity",
            Resource: "*",
          }),
        ]),
      },
    });
  });
});

describe("GatewayStack — SSM Parameter Export (Task 1.1)", () => {
  let template: Template;

  beforeAll(() => {
    ({ template } = createTestStack());
  });

  test("exports authorizer function ARN as SSM parameter", () => {
    template.hasResourceProperties("AWS::SSM::Parameter", {
      Type: "String",
      Name: Match.stringLikeRegexp("/citadel/authorizer-arn-test"),
    });
  });
});
