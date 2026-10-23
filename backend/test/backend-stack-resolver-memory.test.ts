import * as cdk from "aws-cdk-lib";
import { Template } from "aws-cdk-lib/assertions";
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

describe("BackendStack — resolver memory right-sizing", () => {
  let template: Template;

  beforeAll(() => {
    const app = new cdk.App();
    const stack = new BackendStack(app, "TestBackendStack", {
      environment: "test",
      env: { account: "123456789012", region: "us-east-1" },
    });
    template = Template.fromStack(stack);
  });

  test("agent-config-resolver Lambda has 512 MB memory", () => {
    template.hasResourceProperties("AWS::Lambda::Function", {
      Handler: "agent-config-resolver.handler",
      MemorySize: 512,
    });
  });

  test("tool-config-resolver Lambda has 512 MB memory", () => {
    template.hasResourceProperties("AWS::Lambda::Function", {
      Handler: "tool-config-resolver.handler",
      MemorySize: 512,
    });
  });
});
