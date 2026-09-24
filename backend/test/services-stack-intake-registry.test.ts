import * as cdk from "aws-cdk-lib";
import * as events from "aws-cdk-lib/aws-events";
import * as s3 from "aws-cdk-lib/aws-s3";
import {
  scaffoldBackendAssetDirs,
  scaffoldServiceDockerfiles,
} from "./helpers/scaffold-stub-assets";
import {
  expectNoRegistryExportImports,
  expectRegistryGenerationBesideRegistryId,
  registrySsmParamLogicalIds,
  TemplateJson,
} from "./helpers/registry-ssm";

// Ensure asset directories / Dockerfile stub exist for CDK synthesis (mirrors
// services-stack.test.ts bootstrap so this file runs standalone).
scaffoldBackendAssetDirs(["src/schema", "src/lambda/cognito-secret-handler"]);
scaffoldServiceDockerfiles();

import { ServicesStack } from "../lib/services-stack";

// Since finding 8b7ee8af the stack resolves the registry id/arn from the SSM
// parameters `/citadel/<env>/registry/{id,arn}` instead of props, so the
// registry wiring is unconditional (the old props-omitted variant is gone).
describe("AgentIntakeSingle runtime — AgentCore Registry read access (SSM-resolved)", () => {
  let template: cdk.assertions.Template;
  let templateJson: TemplateJson;
  let idParam: string;
  let arnParam: string;

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
      env: { account: "123456789012", region: "us-west-2" },
    });
    template = cdk.assertions.Template.fromStack(stack);
    templateJson = template.toJSON() as TemplateJson;
    ({ idParam, arnParam } = registrySsmParamLogicalIds(templateJson, "test"));
  });

  test("the intake runtime has REGISTRY_ID env wired from the SSM registry-id parameter", () => {
    template.hasResourceProperties("AWS::BedrockAgentCore::Runtime", {
      EnvironmentVariables: cdk.assertions.Match.objectLike({
        REGISTRY_ID: { Ref: idParam },
      }),
    });
  });

  test("every function with REGISTRY_ID also carries REGISTRY_GENERATION", () => {
    expectRegistryGenerationBesideRegistryId(templateJson);
  });

  test("the intake runtime role has a bedrock-agentcore Registry read grant scoped to the SSM-resolved arn", () => {
    template.hasResourceProperties("AWS::IAM::Policy", {
      PolicyDocument: {
        Statement: cdk.assertions.Match.arrayWith([
          cdk.assertions.Match.objectLike({
            Effect: "Allow",
            Action: cdk.assertions.Match.arrayWith([
              "agent-registry:ListRegistryRecords",
              "agent-registry:GetRegistryRecord",
            ]),
            Resource: cdk.assertions.Match.arrayWith([
              { Ref: arnParam },
              { "Fn::Join": ["", [{ Ref: arnParam }, "/*"]] },
            ]),
          }),
        ]),
      },
    });
  });

  test("the template does NOT import the backend registry exports (SSM is the only sharing channel)", () => {
    expectNoRegistryExportImports(templateJson);
  });
});
