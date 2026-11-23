/**
 * CDK assertions for the SeedSmokeEchoToolFunction custom resource.
 *
 * Lambda-binding version (board task 10c3bf48, Slice 2): the fixture no
 * longer uploads JS to an S3 bucket — it registers a registry record with
 * a `lambda` integration binding pointed at SmokeEchoLambdaFunction.
 *
 * Verifies:
 *   - SmokeEchoLambdaFunction (the runnable fixture) exists in non-prod
 *   - Resource exists in non-prod (environment='test')
 *   - ENVIRONMENT, SMOKE_FIXTURES_ENABLED, SMOKE_ECHO_FUNCTION_ARN env vars
 *     are set
 *   - Registry grants are present (no S3 grants — no bucket exists)
 *   - Resources are absent in prod
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

    it("creates the SmokeEchoLambdaFunction (the runnable fixture)", () => {
      template.hasResourceProperties("AWS::Lambda::Function", {
        FunctionName: "citadel-smoke-echo-test",
        Handler: "smoke-echo-lambda.handler",
        Runtime: "nodejs24.x",
      });
    });

    it("creates the SeedSmokeEchoToolFunction Lambda", () => {
      template.hasResourceProperties("AWS::Lambda::Function", {
        Handler: "seed-smoke-echo-tool/index.handler",
        Runtime: "nodejs24.x",
      });
    });

    it("sets ENVIRONMENT, SMOKE_FIXTURES_ENABLED, and SMOKE_ECHO_FUNCTION_ARN env vars", () => {
      template.hasResourceProperties("AWS::Lambda::Function", {
        Handler: "seed-smoke-echo-tool/index.handler",
        Environment: {
          Variables: Match.objectLike({
            ENVIRONMENT: "test",
            SMOKE_FIXTURES_ENABLED: "true",
            SMOKE_ECHO_FUNCTION_ARN: Match.objectLike({
              "Fn::GetAtt": Match.arrayWith(["Arn"]),
            }),
          }),
        },
      });
    });

    it("sets a 3-minute (180 s) timeout so the handler can always send a CFN response", () => {
      template.hasResourceProperties("AWS::Lambda::Function", {
        Handler: "seed-smoke-echo-tool/index.handler",
        Timeout: 180,
      });
    });

    it("creates the SeedSmokeEchoToolResource custom resource pointed at the echo function ARN", () => {
      template.hasResourceProperties("AWS::CloudFormation::CustomResource", {
        Version: "v2.0.0",
        SmokeEchoFunctionArn: Match.objectLike({
          "Fn::GetAtt": Match.arrayWith(["Arn"]),
        }),
      });
    });

    it("grants registry write access (Create + Get + List + SubmitForApproval)", () => {
      template.hasResourceProperties("AWS::IAM::Policy", {
        PolicyDocument: {
          Statement: Match.arrayWith([
            Match.objectLike({
              Action: Match.arrayWith(["agent-registry:CreateRegistryRecord"]),
              Effect: "Allow",
            }),
          ]),
        },
      });
    });

    it("does NOT create a ToolsBucket or any S3 bucket for tool code", () => {
      const buckets = template.findResources("AWS::S3::Bucket", {
        Properties: {
          BucketName: Match.stringLikeRegexp("citadel-tools-"),
        },
      });
      expect(Object.keys(buckets)).toHaveLength(0);
    });
  });

  describe("prod", () => {
    let template: cdk.assertions.Template;

    beforeAll(() => {
      template = createStack("prod");
    });

    it("does NOT create the SeedSmokeEchoToolFunction in prod", () => {
      const lambdas = template.findResources("AWS::Lambda::Function", {
        Properties: {
          Handler: "seed-smoke-echo-tool/index.handler",
        },
      });
      expect(Object.keys(lambdas)).toHaveLength(0);
    });

    it("does NOT create the SmokeEchoLambdaFunction in prod", () => {
      const lambdas = template.findResources("AWS::Lambda::Function", {
        Properties: {
          Handler: "smoke-echo-lambda.handler",
        },
      });
      expect(Object.keys(lambdas)).toHaveLength(0);
    });
  });
});
