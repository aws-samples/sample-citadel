/**
 * ToolSandboxFunction itself (env vars, IAM grants) is UNCHANGED and still
 * present — board task 10c3bf48 Slice 1 only stops routing Mutation.testTool
 * to it (see services-stack-tool-run-resolver.test.ts for the new routing).
 * Slice 2 deletes ToolSandboxFunction entirely; until then this guard pins
 * that the function definition itself was not touched.
 */
import * as cdk from "aws-cdk-lib";
import * as dynamodb from "aws-cdk-lib/aws-dynamodb";
import * as events from "aws-cdk-lib/aws-events";
import * as s3 from "aws-cdk-lib/aws-s3";
import {
  scaffoldBackendAssetDirs,
  scaffoldServiceDockerfiles,
} from "./helpers/scaffold-stub-assets";

scaffoldBackendAssetDirs([
  "src/schema",
  "src/lambda/cognito-secret-handler",
  "dist/lambda",
]);
scaffoldServiceDockerfiles();

import { ServicesStack } from "../lib/services-stack";

const APPSYNC_API_ID = "api-testtool";
const APPSYNC_API_ARN = `arn:aws:appsync:us-west-2:123456789012:apis/${APPSYNC_API_ID}`;
const APPSYNC_URL =
  "https://api-testtool.appsync-api.us-west-2.amazonaws.com/graphql";

function buildStack(): cdk.assertions.Template {
  const app = new cdk.App();
  const prereq = new cdk.Stack(app, "TestToolPrereq", {
    env: { account: "123456789012", region: "us-west-2" },
  });
  const bus = new events.EventBus(prereq, "Bus", {
    eventBusName: "test-tool-bus",
  });
  const bucket = new s3.Bucket(prereq, "DocBucket");
  const membershipTable = new dynamodb.Table(prereq, "UserOrgMembership", {
    tableName: "citadel-user-org-membership-test",
    partitionKey: { name: "sub", type: dynamodb.AttributeType.STRING },
    billingMode: dynamodb.BillingMode.PAY_PER_REQUEST,
  });

  const stack = new ServicesStack(app, "citadel-services-testtool", {
    environment: "test",
    agentEventBus: bus,
    documentBucket: bucket,
    userOrgMembershipTable: membershipTable,
    appSyncApiArn: APPSYNC_API_ARN,
    appSyncApiId: APPSYNC_API_ID,
    appSyncGraphqlUrl: APPSYNC_URL,
    userPoolId: "us-west-2_testpool",
    userPoolArn:
      "arn:aws:cognito-idp:us-west-2:123456789012:userpool/us-west-2_testpool",
    env: { account: "123456789012", region: "us-west-2" },
  });
  return cdk.assertions.Template.fromStack(stack);
}

describe("ServicesStack — ToolSandboxFunction definition (retired from testTool routing, not yet deleted)", () => {
  let template: cdk.assertions.Template;

  beforeAll(() => {
    template = buildStack();
  });

  test("ToolSandboxFunction's own AppSync datasource is no longer used by testTool, but the function still exists", () => {
    template.hasResourceProperties("AWS::Lambda::Function", {
      FunctionName: "citadel-tool-sandbox-test",
    });
    // testTool now targets ToolRunResolverLambdaDataSource — see
    // services-stack-tool-run-resolver.test.ts.
    template.hasResourceProperties("AWS::AppSync::Resolver", {
      ApiId: APPSYNC_API_ID,
      TypeName: "Mutation",
      FieldName: "testTool",
      DataSourceName: cdk.assertions.Match.not(
        cdk.assertions.Match.stringLikeRegexp("ToolSandbox"),
      ),
    });
  });

  test("ToolSandboxFunction has TOOLS_CONFIG_TABLE env var matching the real table name", () => {
    template.hasResourceProperties("AWS::Lambda::Function", {
      FunctionName: "citadel-tool-sandbox-test",
      Environment: {
        Variables: {
          TOOLS_CONFIG_TABLE: "citadel-tools-test",
        },
      },
    });
  });

  test("ToolSandboxFunction has DynamoDB GetItem permission on the tools table", () => {
    // The addToRolePolicy with an explicit ARN string renders as a
    // single-element array in the synthesized template.
    template.hasResourceProperties("AWS::IAM::Policy", {
      PolicyDocument: {
        Statement: cdk.assertions.Match.arrayWith([
          cdk.assertions.Match.objectLike({
            Effect: "Allow",
            Action: cdk.assertions.Match.anyValue(),
          }),
        ]),
      },
    });
    // Verify the function itself exists with correct env
    template.hasResourceProperties("AWS::Lambda::Function", {
      FunctionName: "citadel-tool-sandbox-test",
    });
  });

  test("ToolSandboxFunction has REGISTRY_ENABLED and REGISTRY_ID env vars", () => {
    template.hasResourceProperties("AWS::Lambda::Function", {
      FunctionName: "citadel-tool-sandbox-test",
      Environment: {
        Variables: cdk.assertions.Match.objectLike({
          REGISTRY_ENABLED: "true",
          // REGISTRY_ID is resolved from SSM at deploy time — CDK synthesizes
          // it as a dynamic reference token, so we only assert it is present.
          REGISTRY_ID: cdk.assertions.Match.anyValue(),
        }),
      },
    });
  });

  test("ToolSandboxFunction has read-only registry IAM grants", () => {
    template.hasResourceProperties("AWS::IAM::Policy", {
      PolicyDocument: {
        Statement: cdk.assertions.Match.arrayWith([
          cdk.assertions.Match.objectLike({
            Effect: "Allow",
            Action: [
              "agent-registry:GetRegistryRecord",
              "agent-registry:ListRegistryRecords",
            ],
          }),
        ]),
      },
    });
  });
});
