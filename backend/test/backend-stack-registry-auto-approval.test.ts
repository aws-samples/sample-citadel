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

function findRegistryResource(template: cdk.assertions.Template) {
  const json = template.toJSON() as {
    Resources: Record<
      string,
      { Type: string; Properties?: Record<string, unknown> }
    >;
  };
  const entry = Object.entries(json.Resources).find(
    ([logicalId, r]) =>
      r.Type === "AWS::CloudFormation::CustomResource" &&
      logicalId.startsWith("AgentCoreRegistry"),
  );
  if (!entry) throw new Error("AgentCoreRegistry custom resource not found");
  return entry[1];
}

describe("BackendStack — registry AutoApproval default", () => {
  test("AutoApproval defaults to 'false' (manual review) when no context is provided", () => {
    const app = new cdk.App();
    const stack = new BackendStack(app, "TestRegistryAutoApprovalDefault", {
      environment: "test",
      env: { account: "123456789012", region: "us-east-1" },
    });
    const template = cdk.assertions.Template.fromStack(stack);
    const resource = findRegistryResource(template);
    expect(resource.Properties?.AutoApproval).toBe("false");
  });

  test("AutoApproval is 'true' when registryAutoApproval context is set to 'true'", () => {
    const app = new cdk.App({ context: { registryAutoApproval: "true" } });
    const stack = new BackendStack(app, "TestRegistryAutoApprovalTrue", {
      environment: "test",
      env: { account: "123456789012", region: "us-east-1" },
    });
    const template = cdk.assertions.Template.fromStack(stack);
    const resource = findRegistryResource(template);
    expect(resource.Properties?.AutoApproval).toBe("true");
  });

  test("synth emits a warning annotation when auto-approval is enabled", () => {
    const app = new cdk.App({ context: { registryAutoApproval: "true" } });
    const stack = new BackendStack(app, "TestRegistryAutoApprovalWarning", {
      environment: "test",
      env: { account: "123456789012", region: "us-east-1" },
    });
    const annotations = cdk.assertions.Annotations.fromStack(stack);
    annotations.hasWarning(
      "*",
      cdk.assertions.Match.stringLikeRegexp("registryAutoApproval is enabled"),
    );
  });

  test("synth does NOT emit the auto-approval warning when using the default", () => {
    const app = new cdk.App();
    const stack = new BackendStack(app, "TestRegistryNoWarning", {
      environment: "test",
      env: { account: "123456789012", region: "us-east-1" },
    });
    const annotations = cdk.assertions.Annotations.fromStack(stack);
    annotations.hasNoWarning(
      "*",
      cdk.assertions.Match.stringLikeRegexp("registryAutoApproval is enabled"),
    );
  });
});
