/**
 * BackendStack — SSM-shared Cognito UserPoolClient id seam (CIT-207 phase 1).
 *
 * BackendStack publishes the UserPoolClient id on TWO channels during
 * phase 1:
 *   1. The auto-generated CloudFormation export
 *      (`ExportsOutputRefUserPoolClient...`) — kept alive via
 *      `this.exportValue(...)` so already-deployed frontend/telemetry
 *      stacks keep working while they migrate.
 *   2. The SSM parameter `/citadel/<env>/cognito/client-id` — the NEW
 *      sharing channel, mirroring the registry id/arn seam
 *      (registry-ssm.ts / backend-stack-registry-ssm-sharing.test.ts).
 *
 * This test also asserts the duplicate explicit export
 * (`UserPoolClientIdExport`, `<stackName>-UserPoolClientId`) is gone — it
 * had zero in-app importers and duplicated the auto-export.
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

const STACK_NAME = "TestBackendStackCognitoSeam";

describe("BackendStack — Cognito client id retained export + SSM parameter", () => {
  let template: Template;
  let templateJson: {
    Resources: Record<string, { Type: string; Properties?: unknown }>;
    Outputs?: Record<
      string,
      { Value?: unknown; Export?: { Name?: unknown }; Description?: string }
    >;
  };
  let userPoolClientLogicalId: string;

  beforeAll(() => {
    const app = new cdk.App();
    const stack = new BackendStack(app, STACK_NAME, {
      environment: "test",
      env: { account: "123456789012", region: "us-east-1" },
    });
    template = Template.fromStack(stack);
    templateJson = template.toJSON() as typeof templateJson;

    const clientEntry = Object.entries(templateJson.Resources).find(
      ([logicalId, r]) =>
        r.Type === "AWS::Cognito::UserPoolClient" &&
        logicalId.startsWith("UserPoolClient"),
    );
    if (!clientEntry) throw new Error("UserPoolClient resource not found");
    userPoolClientLogicalId = clientEntry[0];
  });

  // ---------------------------------------------------------------------
  // 1. New SSM parameter
  // ---------------------------------------------------------------------

  test("publishes /citadel/test/cognito/client-id as an SSM parameter valued from the UserPoolClient", () => {
    template.hasResourceProperties("AWS::SSM::Parameter", {
      Name: "/citadel/test/cognito/client-id",
      Type: "String",
      Value: { Ref: userPoolClientLogicalId },
    });
  });

  // ---------------------------------------------------------------------
  // 2. Auto-export retained (exportValue keep-alive)
  // ---------------------------------------------------------------------

  test("retains the auto-generated export of the UserPoolClient id (exportValue keep-alive)", () => {
    const outputs = templateJson.Outputs ?? {};
    const hasAutoExport = Object.entries(outputs).some(([, output]) => {
      const exportName = (output.Export as { Name?: unknown } | undefined)
        ?.Name as string | undefined;
      return (
        typeof exportName === "string" &&
        /ExportsOutputRefUserPoolClient/.test(exportName)
      );
    });
    expect(hasAutoExport).toBe(true);
  });

  // ---------------------------------------------------------------------
  // 3. Duplicate explicit export removed
  // ---------------------------------------------------------------------

  test("no explicit '-UserPoolClientId' export remains (duplicate of the auto-export, zero importers)", () => {
    const outputs = templateJson.Outputs ?? {};
    const hasExplicitExport = Object.entries(outputs).some(([, output]) => {
      const exportName = (output.Export as { Name?: unknown } | undefined)
        ?.Name as string | undefined;
      return (
        typeof exportName === "string" && /-UserPoolClientId$/.test(exportName)
      );
    });
    expect(hasExplicitExport).toBe(false);
  });

  test("the plain UserPoolClientId output (no export) is still present", () => {
    template.hasOutput("UserPoolClientId", {
      Value: { Ref: userPoolClientLogicalId },
    });
  });

  test("publishes exactly one cognito SSM parameter (client-id)", () => {
    const cognitoParams = Object.values(
      template.findResources("AWS::SSM::Parameter", {
        Properties: Match.objectLike({
          Name: Match.stringLikeRegexp("^/citadel/test/cognito/"),
        }),
      }),
    );
    expect(cognitoParams).toHaveLength(1);
  });
});
