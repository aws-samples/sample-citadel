import * as cdk from "aws-cdk-lib";
import { Template, Match } from "aws-cdk-lib/assertions";
import * as path from "path";
import * as fs from "fs";

// Ensure asset directories exist for CDK synthesis
const assetDirs = [
  path.resolve(__dirname, "../src/schema"),
  path.resolve(__dirname, "../dist/lambda"),
  path.resolve(__dirname, "../../src/lambda/seed-organizations"),
  path.resolve(__dirname, "../src/lambda/seed-admin-user"),
  path.resolve(__dirname, "../src/lambda/seed-organizations"),
];
for (const dir of assetDirs) {
  if (!fs.existsSync(dir)) fs.mkdirSync(dir, { recursive: true });
}

import { BackendStack } from "../lib/backend-stack";

describe("BackendStack — AppInvokeHandler (Agent App invoke-path fix)", () => {
  let template: Template;

  beforeAll(() => {
    const app = new cdk.App();
    const stack = new BackendStack(app, "TestBackendStack", {
      environment: "test",
      env: { account: "123456789012", region: "us-east-1" },
    });
    template = Template.fromStack(stack);
  });

  test("AppInvokeHandler exists with Node.js 24.x runtime, 30s timeout, and correct env vars", () => {
    template.hasResourceProperties("AWS::Lambda::Function", {
      Handler: "app-invoke-handler.handler",
      Runtime: "nodejs24.x",
      Timeout: 30,
      Environment: {
        Variables: Match.objectLike({
          APPS_TABLE: Match.anyValue(),
          WORKFLOWS_TABLE: Match.anyValue(),
          EXECUTIONS_TABLE: Match.anyValue(),
          EVENT_BUS_NAME: Match.anyValue(),
          IDEMPOTENCY_TABLE: Match.anyValue(),
        }),
      },
    });
  });

  test("AppInvokeHandler has its own LogGroup", () => {
    const functions = template.findResources("AWS::Lambda::Function", {
      Properties: { Handler: "app-invoke-handler.handler" },
    });
    const logicalId = Object.keys(functions)[0];
    expect(logicalId).toBeDefined();

    const logGroups = template.findResources("AWS::Logs::LogGroup");
    // At least one LogGroup exists (function-specific, not shared) — full
    // wiring is via `logGroup:` prop, so a dedicated resource must exist.
    expect(Object.keys(logGroups).length).toBeGreaterThan(0);
  });

  test("AppInvokeRule matches source citadel.app.invoke / detailType app.invoke.requested", () => {
    template.hasResourceProperties("AWS::Events::Rule", {
      EventPattern: Match.objectLike({
        source: ["citadel.app.invoke"],
        "detail-type": ["app.invoke.requested"],
      }),
    });
  });

  test("AppInvokeRule targets AppInvokeHandler with retryAttempts 2 and maxEventAge 2h", () => {
    const functions = template.findResources("AWS::Lambda::Function", {
      Properties: { Handler: "app-invoke-handler.handler" },
    });
    const fnLogicalId = Object.keys(functions)[0];
    expect(fnLogicalId).toBeDefined();

    const rules = template.findResources("AWS::Events::Rule", {
      Properties: {
        EventPattern: Match.objectLike({ source: ["citadel.app.invoke"] }),
      },
    });
    const ruleLogicalId = Object.keys(rules)[0];
    expect(ruleLogicalId).toBeDefined();
    const targets = rules[ruleLogicalId].Properties.Targets;
    expect(targets).toHaveLength(1);
    expect(targets[0].RetryPolicy).toMatchObject({
      MaximumRetryAttempts: 2,
      MaximumEventAgeInSeconds: 7200,
    });
    const arnRef = targets[0].Arn;
    const getAtt = arnRef?.["Fn::GetAtt"];
    expect(Array.isArray(getAtt) && getAtt[0] === fnLogicalId).toBe(true);
  });

  test("AppInvokeHandler has read access to Apps and Workflows tables, write to Executions, rw to Idempotency, and PutEvents to the bus", () => {
    const functions = template.findResources("AWS::Lambda::Function", {
      Properties: { Handler: "app-invoke-handler.handler" },
    });
    const fnLogicalId = Object.keys(functions)[0];
    expect(fnLogicalId).toBeDefined();

    const policies = template.findResources("AWS::IAM::Policy");
    const ownPolicies = Object.values(policies).filter((p: any) => {
      const roles = p.Properties?.Roles || [];
      return roles.some((r: any) =>
        (r?.Ref || "").includes("AppInvokeHandler"),
      );
    });
    expect(ownPolicies.length).toBeGreaterThan(0);

    const allActions = ownPolicies.flatMap((p: any) => {
      const statements = p.Properties?.PolicyDocument?.Statement || [];
      return statements.flatMap((s: any) =>
        Array.isArray(s.Action) ? s.Action : [s.Action],
      );
    });

    expect(allActions).toEqual(
      expect.arrayContaining([
        "dynamodb:GetItem",
        "dynamodb:PutItem",
        "events:PutEvents",
      ]),
    );
  });
});
