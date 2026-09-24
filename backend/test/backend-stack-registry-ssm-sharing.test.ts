/**
 * BackendStack — SSM-shared registry id/arn seam (finding 8b7ee8af).
 *
 * BackendStack publishes the provisioned registry's id/arn on TWO channels:
 *   1. The original CloudFormation exports (`<stackName>-RegistryArn` /
 *      `<stackName>-RegistryId`) — RETAINED so already-deployed consumer
 *      stacks that still reference the exports keep deploying while they
 *      migrate ("phase 2 removes" them, per backend-stack.ts).
 *   2. The SSM parameters `/citadel/<env>/registry/{id,arn}` — the NEW
 *      sharing channel consumer stacks resolve via
 *      `ssm.StringParameter.valueForStringParameter`, decoupling consumer
 *      deploys from cross-stack Fn::ImportValue lock-in.
 *
 * Also pins REGISTRY_GENERATION beside every REGISTRY_ID env var so bumping
 * the generation constant redeploys every registry consumer in this stack.
 */
import * as cdk from "aws-cdk-lib";
import { Template, Match } from "aws-cdk-lib/assertions";
import * as path from "path";
import * as fs from "fs";
import {
  expectRegistryGenerationBesideRegistryId,
  TemplateJson,
} from "./helpers/registry-ssm";

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

const STACK_NAME = "TestBackendStackRegistrySeam";

describe("BackendStack — registry exports retained + SSM parameters published", () => {
  let template: Template;
  let templateJson: TemplateJson & {
    Outputs?: Record<
      string,
      { Value?: unknown; Export?: { Name?: unknown }; Description?: string }
    >;
  };
  let registryLogicalId: string;

  beforeAll(() => {
    const app = new cdk.App();
    const stack = new BackendStack(app, STACK_NAME, {
      environment: "test",
      env: { account: "123456789012", region: "us-east-1" },
    });
    template = Template.fromStack(stack);
    templateJson = template.toJSON() as typeof templateJson;

    const registryEntry = Object.entries(templateJson.Resources).find(
      ([logicalId, r]) =>
        r.Type === "AWS::CloudFormation::CustomResource" &&
        logicalId.startsWith("AgentCoreRegistry"),
    );
    if (!registryEntry)
      throw new Error("AgentCoreRegistry custom resource not found");
    registryLogicalId = registryEntry[0];
  });

  // ---------------------------------------------------------------------
  // 1. Retained CloudFormation exports
  // ---------------------------------------------------------------------

  test(`still exports the registry ARN as ${STACK_NAME}-RegistryArn`, () => {
    template.hasOutput("AgentCoreRegistryArn", {
      Export: { Name: `${STACK_NAME}-RegistryArn` },
      Value: { "Fn::GetAtt": [registryLogicalId, "RegistryArn"] },
    });
  });

  test(`still exports the registry ID as ${STACK_NAME}-RegistryId`, () => {
    template.hasOutput("AgentCoreRegistryId", {
      Export: { Name: `${STACK_NAME}-RegistryId` },
      Value: { "Fn::GetAtt": [registryLogicalId, "RegistryId"] },
    });
  });

  // ---------------------------------------------------------------------
  // 2. SSM parameters (the new sharing channel)
  // ---------------------------------------------------------------------

  test("publishes /citadel/test/registry/id as an SSM parameter valued from the provisioned registry", () => {
    template.hasResourceProperties("AWS::SSM::Parameter", {
      Name: "/citadel/test/registry/id",
      Type: "String",
      Value: { "Fn::GetAtt": [registryLogicalId, "RegistryId"] },
    });
  });

  test("publishes /citadel/test/registry/arn as an SSM parameter valued from the provisioned registry", () => {
    template.hasResourceProperties("AWS::SSM::Parameter", {
      Name: "/citadel/test/registry/arn",
      Type: "String",
      Value: { "Fn::GetAtt": [registryLogicalId, "RegistryArn"] },
    });
  });

  test("publishes exactly the two registry SSM parameters (id + arn)", () => {
    const registryParams = Object.values(
      template.findResources("AWS::SSM::Parameter", {
        Properties: Match.objectLike({
          Name: Match.stringLikeRegexp("^/citadel/test/registry/"),
        }),
      }),
    );
    expect(registryParams).toHaveLength(2);
  });

  // ---------------------------------------------------------------------
  // 3. REGISTRY_GENERATION beside every REGISTRY_ID (backend functions)
  // ---------------------------------------------------------------------

  test("every backend function with REGISTRY_ID also carries REGISTRY_GENERATION", () => {
    expectRegistryGenerationBesideRegistryId(templateJson);
  });
});
