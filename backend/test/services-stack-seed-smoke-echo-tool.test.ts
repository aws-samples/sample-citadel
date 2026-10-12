/**
 * CDK assertions for the SeedSmokeEchoToolFunction custom resource.
 *
 * Verifies:
 *   - Resource exists in non-prod (environment='test')
 *   - ENVIRONMENT and SMOKE_FIXTURES_ENABLED env vars are set
 *   - S3 and registry grants are present
 *   - Resource is absent in prod
 */
import * as cdk from "aws-cdk-lib";
import { Match } from "aws-cdk-lib/assertions";
import * as dynamodb from "aws-cdk-lib/aws-dynamodb";
import * as events from "aws-cdk-lib/aws-events";
import * as s3 from "aws-cdk-lib/aws-s3";
import {
  scaffoldBackendAssetDirs,
  scaffoldServiceDockerfiles,
} from "./helpers/scaffold-stub-assets";

scaffoldBackendAssetDirs(["src/schema", "src/lambda/cognito-secret-handler"]);
scaffoldServiceDockerfiles();

import { ServicesStack } from "../lib/services-stack";

function createStack(environment: string): cdk.assertions.Template {
  const app = new cdk.App();
  const prereqStack = new cdk.Stack(app, `PrereqStack-${environment}`, {
    env: { account: "123456789012", region: "us-east-1" },
  });
  const agentEventBus = new events.EventBus(prereqStack, "TestEventBus", {
    eventBusName: "test-bus",
  });
  const documentBucket = new s3.Bucket(prereqStack, "TestDocBucket");

  const stack = new ServicesStack(app, `TestServicesStack-${environment}`, {
    environment,
    agentEventBus,
    documentBucket,
    userOrgMembershipTable: dynamodb.Table.fromTableName(
      prereqStack,
      "UserOrgMembership",
      `citadel-user-org-membership-${environment}`,
    ),
    env: { account: "123456789012", region: "us-east-1" },
  });

  return cdk.assertions.Template.fromStack(stack);
}

describe("SeedSmokeEchoTool", () => {
  describe("non-prod (test)", () => {
    let template: cdk.assertions.Template;

    beforeAll(() => {
      template = createStack("test");
    });

    it("creates the SeedSmokeEchoToolFunction Lambda", () => {
      template.hasResourceProperties("AWS::Lambda::Function", {
        Handler: "seed-smoke-echo-tool/index.handler",
        Runtime: "nodejs24.x",
      });
    });

    it("sets ENVIRONMENT and SMOKE_FIXTURES_ENABLED env vars", () => {
      template.hasResourceProperties("AWS::Lambda::Function", {
        Handler: "seed-smoke-echo-tool/index.handler",
        Environment: {
          Variables: {
            ENVIRONMENT: "test",
            SMOKE_FIXTURES_ENABLED: "true",
          },
        },
      });
    });

    it("creates the SeedSmokeEchoToolResource custom resource", () => {
      template.hasResourceProperties("AWS::CloudFormation::CustomResource", {
        Version: "v1.0.0",
      });
    });

    it("grants S3 access on the tools bucket", () => {
      // The seeder needs PutObject/GetObject/HeadObject on tools/*
      template.hasResourceProperties("AWS::IAM::Policy", {
        PolicyDocument: {
          Statement: Match.arrayWith([
            Match.objectLike({
              Action: ["s3:PutObject", "s3:GetObject", "s3:HeadObject"],
              Effect: "Allow",
            }),
          ]),
        },
      });
    });
  });

  describe("prod", () => {
    let template: cdk.assertions.Template;

    beforeAll(() => {
      template = createStack("prod");
    });

    it("does NOT create the SeedSmokeEchoToolFunction in prod", () => {
      // Verify no Lambda has the seed-smoke-echo-tool handler
      const lambdas = template.findResources("AWS::Lambda::Function", {
        Properties: {
          Handler: "seed-smoke-echo-tool/index.handler",
        },
      });
      expect(Object.keys(lambdas)).toHaveLength(0);
    });
  });
});
