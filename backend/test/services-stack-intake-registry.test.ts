import * as cdk from "aws-cdk-lib";
import * as events from "aws-cdk-lib/aws-events";
import * as s3 from "aws-cdk-lib/aws-s3";
import {
  scaffoldBackendAssetDirs,
  scaffoldServiceDockerfiles,
} from "./helpers/scaffold-stub-assets";

// Ensure asset directories / Dockerfile stub exist for CDK synthesis (mirrors
// services-stack.test.ts bootstrap so this file runs standalone).
scaffoldBackendAssetDirs(["src/schema", "src/lambda/cognito-secret-handler"]);
scaffoldServiceDockerfiles();

import { ServicesStack } from "../lib/services-stack";

const REGISTRY_ID = "reg-abc123";
const REGISTRY_ARN =
  "arn:aws:bedrock-agentcore:us-west-2:123456789012:registry/reg-abc123";

describe("AgentIntakeSingle runtime — AgentCore Registry read access", () => {
  let template: cdk.assertions.Template;

  beforeAll(() => {
    const app = new cdk.App();
    const prereq = new cdk.Stack(app, "IntakeRegistryPrereq", {
      env: { account: "123456789012", region: "us-west-2" },
    });
    const bus = new events.EventBus(prereq, "Bus", { eventBusName: "reg-bus" });
    const bucket = new s3.Bucket(prereq, "DocBucket");

    const stack = new ServicesStack(app, "citadel-services-regtest", {
      environment: "test",
      agentEventBus: bus,
      documentBucket: bucket,
      registryArn: REGISTRY_ARN,
      registryId: REGISTRY_ID,
      env: { account: "123456789012", region: "us-west-2" },
    });
    template = cdk.assertions.Template.fromStack(stack);
  });

  test("the intake runtime has REGISTRY_ID env wired from props.registryId", () => {
    template.hasResourceProperties("AWS::BedrockAgentCore::Runtime", {
      EnvironmentVariables: cdk.assertions.Match.objectLike({
        REGISTRY_ID,
      }),
    });
  });

  test("the intake runtime role has a bedrock-agentcore Registry read grant", () => {
    template.hasResourceProperties("AWS::IAM::Policy", {
      PolicyDocument: {
        Statement: cdk.assertions.Match.arrayWith([
          cdk.assertions.Match.objectLike({
            Effect: "Allow",
            Action: cdk.assertions.Match.arrayWith([
              "bedrock-agentcore:ListRegistryRecords",
              "bedrock-agentcore:GetRegistryRecord",
            ]),
            Resource: cdk.assertions.Match.arrayWith([
              REGISTRY_ARN,
              `${REGISTRY_ARN}/*`,
            ]),
          }),
        ]),
      },
    });
  });
});

describe("AgentIntakeSingle runtime — registry props omitted", () => {
  let template: cdk.assertions.Template;

  beforeAll(() => {
    const app = new cdk.App();
    const prereq = new cdk.Stack(app, "IntakeNoRegistryPrereq", {
      env: { account: "123456789012", region: "us-west-2" },
    });
    const bus = new events.EventBus(prereq, "Bus", {
      eventBusName: "noreg-bus",
    });
    const bucket = new s3.Bucket(prereq, "DocBucket");

    const stack = new ServicesStack(app, "citadel-services-noreg", {
      environment: "test",
      agentEventBus: bus,
      documentBucket: bucket,
      env: { account: "123456789012", region: "us-west-2" },
    });
    template = cdk.assertions.Template.fromStack(stack);
  });

  test("no runtime carries a REGISTRY_ID when registryId is unset", () => {
    const runtimes = template.findResources("AWS::BedrockAgentCore::Runtime");
    for (const runtime of Object.values(runtimes)) {
      const env =
        (
          runtime.Properties as
            | { EnvironmentVariables?: Record<string, unknown> }
            | undefined
        )?.EnvironmentVariables ?? {};
      expect(env).not.toHaveProperty("REGISTRY_ID");
    }
  });

  test("no registry read grant is attached when registryArn is unset", () => {
    const policies = template.findResources("AWS::IAM::Policy");
    const hasRegistryGrant = Object.values(policies).some((policy) => {
      const statements: Array<Record<string, unknown>> =
        ((
          policy.Properties as
            | { PolicyDocument?: { Statement?: unknown[] } }
            | undefined
        )?.PolicyDocument?.Statement as Array<Record<string, unknown>>) ?? [];
      return statements.some((stmt) => {
        const rawAction = stmt.Action;
        const actions: string[] = Array.isArray(rawAction)
          ? (rawAction as string[])
          : [rawAction as string];
        return actions.includes("bedrock-agentcore:ListRegistryRecords");
      });
    });
    expect(hasRegistryGrant).toBe(false);
  });
});
