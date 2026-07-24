/**
 * API-key HMAC pepper — infra follow-up.
 *
 * createAppApiKey/rotateAppApiKey (backend/src/lambda/app-api-key-management.ts)
 * are wired into the registry-agent-record-resolver Lambda (see
 * registry-agent-record-resolver.ts imports + the CreateAppApiKeyResolver /
 * RotateAppApiKeyResolver AppSync resolvers in backend-stack.ts). Both
 * createAppApiKey (new keys) and rotateAppApiKey (rotated keys) call
 * hashApiKey, which reads the pepper via getApiKeyPepper() at
 * `/citadel/${ENVIRONMENT}/app-api-key-pepper`.
 *
 * Asserts that the registry-agent-record-resolver Lambda:
 *  - has the ENVIRONMENT env var wired
 *  - has ssm:GetParameter scoped to the app-api-key-pepper parameter
 *  - has kms:Decrypt scoped to the AWS-managed SSM key alias
 */

import * as cdk from "aws-cdk-lib";
import { Template, Match } from "aws-cdk-lib/assertions";
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

describe("BackendStack — API-key HMAC pepper wiring (registry-agent-record-resolver)", () => {
  let template: Template;

  beforeAll(() => {
    const app = new cdk.App();
    const stack = new BackendStack(app, "TestBackendStackApiKeyPepper", {
      environment: "test",
      env: { account: "123456789012", region: "us-east-1" },
    });
    template = Template.fromStack(stack);
  });

  function findHandlerRoleRef(handler: string): string {
    const lambdas = template.findResources("AWS::Lambda::Function");
    const logicalId = Object.keys(lambdas).find(
      (k) => lambdas[k].Properties?.Handler === handler,
    );
    expect(logicalId).toBeDefined();
    const roleRef = lambdas[logicalId!].Properties.Role?.["Fn::GetAtt"]?.[0];
    expect(roleRef).toBeDefined();
    return roleRef;
  }

  function policiesForRole(roleRef: string) {
    const policies = template.findResources("AWS::IAM::Policy");
    return Object.values(policies).filter((p: any) =>
      (p.Properties?.Roles ?? []).some((r: any) => r.Ref === roleRef),
    );
  }

  test("registry-agent-record-resolver has ENVIRONMENT env var", () => {
    template.hasResourceProperties("AWS::Lambda::Function", {
      Handler: "registry-agent-record-resolver.handler",
      Environment: {
        Variables: Match.objectLike({
          ENVIRONMENT: "test",
        }),
      },
    });
  });

  test("registry-agent-record-resolver role grants ssm:GetParameter on the app-api-key-pepper parameter", () => {
    const roleRef = findHandlerRoleRef(
      "registry-agent-record-resolver.handler",
    );
    const policies = policiesForRole(roleRef);

    const matched = policies.some((policy: any) =>
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

  test("registry-agent-record-resolver role grants kms:Decrypt on the SSM-managed key alias", () => {
    const roleRef = findHandlerRoleRef(
      "registry-agent-record-resolver.handler",
    );
    const policies = policiesForRole(roleRef);

    const matched = policies.some((policy: any) =>
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
});
