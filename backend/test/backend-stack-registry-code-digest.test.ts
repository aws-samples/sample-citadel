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

const STACK_NAME = "TestBackendStackRegistryCodeDigest";

describe("BackendStack — AgentCoreRegistry CodeDigest property", () => {
  test("CodeDigest is a 64-char lowercase hex sha256 string", () => {
    const app = new cdk.App();
    const stack = new BackendStack(app, STACK_NAME, {
      environment: "test",
      env: { account: "123456789012", region: "us-east-1" },
    });
    const templateJson = cdk.assertions.Template.fromStack(stack).toJSON() as {
      Resources: Record<
        string,
        { Type: string; Properties?: Record<string, unknown> }
      >;
    };

    const registryEntry = Object.entries(templateJson.Resources).find(
      ([logicalId, r]) =>
        r.Type === "AWS::CloudFormation::CustomResource" &&
        logicalId.startsWith("AgentCoreRegistry"),
    );
    if (!registryEntry)
      throw new Error("AgentCoreRegistry custom resource not found");

    const [, resource] = registryEntry;
    const codeDigest = resource.Properties?.CodeDigest;
    expect(typeof codeDigest).toBe("string");
    expect(codeDigest as string).toMatch(/^[0-9a-f]{64}$/);
  });
});
