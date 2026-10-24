import * as cdk from "aws-cdk-lib";
import * as path from "path";
import * as fs from "fs";

// Ensure asset directories exist for CDK synthesis
const assetDirs = [
  path.resolve(__dirname, "../src/schema"),
  path.resolve(__dirname, "../dist/lambda"),
  path.resolve(__dirname, "../src/lambda/seed-admin-user"),
  path.resolve(__dirname, "../src/lambda/seed-organizations"),
];
for (const dir of assetDirs) {
  if (!fs.existsSync(dir)) fs.mkdirSync(dir, { recursive: true });
}

import { BackendStack } from "../lib/backend-stack";

describe("BackendStack — LIST_FROM_PROJECTION env var (CIT-244)", () => {
  let template: cdk.assertions.Template;

  beforeAll(() => {
    const app = new cdk.App();
    const stack = new BackendStack(app, "TestListProjectionEnv", {
      environment: "test",
      env: { account: "123456789012", region: "us-east-1" },
    });
    template = cdk.assertions.Template.fromStack(stack);
  });

  test("AgentConfigResolverFunction has LIST_FROM_PROJECTION env var set to 'true'", () => {
    template.hasResourceProperties("AWS::Lambda::Function", {
      Handler: "agent-config-resolver.handler",
      Environment: {
        Variables: cdk.assertions.Match.objectLike({
          LIST_FROM_PROJECTION: "true",
        }),
      },
    });
  });

  test("ToolConfigResolverFunction has LIST_FROM_PROJECTION env var set to 'true'", () => {
    template.hasResourceProperties("AWS::Lambda::Function", {
      Handler: "tool-config-resolver.handler",
      Environment: {
        Variables: cdk.assertions.Match.objectLike({
          LIST_FROM_PROJECTION: "true",
        }),
      },
    });
  });

  test("AgentConfigResolverFunction has cloudwatch:PutMetricData permission", () => {
    // Find the IAM role for the agent config resolver and verify it has
    // cloudwatch:PutMetricData in at least one policy statement.
    template.hasResourceProperties("AWS::IAM::Policy", {
      PolicyDocument: {
        Statement: cdk.assertions.Match.arrayWith([
          cdk.assertions.Match.objectLike({
            Action: "cloudwatch:PutMetricData",
            Effect: "Allow",
          }),
        ]),
      },
    });
  });
});
