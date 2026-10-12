/**
 * Asserts that ServicesStack creates the ToolsBucket with the expected
 * security properties and that sandbox/seeder reference it.
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

function buildStack(): {
  template: cdk.assertions.Template;
  stack: ServicesStack;
} {
  const app = new cdk.App();
  const prereq = new cdk.Stack(app, "ToolsBucketPrereq", {
    env: { account: "123456789012", region: "us-east-1" },
  });
  const bus = new events.EventBus(prereq, "Bus", {
    eventBusName: "tools-bucket-bus",
  });
  const bucket = new s3.Bucket(prereq, "DocBucket");
  const membershipTable = new dynamodb.Table(prereq, "UserOrgMembership", {
    tableName: "citadel-user-org-membership-test",
    partitionKey: { name: "sub", type: dynamodb.AttributeType.STRING },
    billingMode: dynamodb.BillingMode.PAY_PER_REQUEST,
  });

  const stack = new ServicesStack(app, "citadel-services-toolsbucket", {
    environment: "test",
    agentEventBus: bus,
    documentBucket: bucket,
    userOrgMembershipTable: membershipTable,
    env: { account: "123456789012", region: "us-east-1" },
  });
  const template = cdk.assertions.Template.fromStack(stack);
  return { template, stack };
}

describe("ServicesStack — ToolsBucket", () => {
  let template: cdk.assertions.Template;

  beforeAll(() => {
    ({ template } = buildStack());
  });

  test("creates ToolsBucket with expected physical name", () => {
    template.hasResourceProperties("AWS::S3::Bucket", {
      BucketName: "citadel-tools-test-123456789012-us-east-1",
    });
  });

  test("ToolsBucket has S3-managed encryption (AES256)", () => {
    template.hasResourceProperties("AWS::S3::Bucket", {
      BucketName: "citadel-tools-test-123456789012-us-east-1",
      BucketEncryption: {
        ServerSideEncryptionConfiguration: [
          {
            ServerSideEncryptionByDefault: {
              SSEAlgorithm: "AES256",
            },
          },
        ],
      },
    });
  });

  test("ToolsBucket has block public access BLOCK_ALL", () => {
    template.hasResourceProperties("AWS::S3::Bucket", {
      BucketName: "citadel-tools-test-123456789012-us-east-1",
      PublicAccessBlockConfiguration: {
        BlockPublicAcls: true,
        BlockPublicPolicy: true,
        IgnorePublicAcls: true,
        RestrictPublicBuckets: true,
      },
    });
  });

  test("ToolsBucket has versioning enabled", () => {
    template.hasResourceProperties("AWS::S3::Bucket", {
      BucketName: "citadel-tools-test-123456789012-us-east-1",
      VersioningConfiguration: {
        Status: "Enabled",
      },
    });
  });

  test("ToolSandboxFunction env references ToolsBucket", () => {
    // The sandbox uses toolsBucket.bucketName which resolves via Ref
    template.hasResourceProperties("AWS::Lambda::Function", {
      Handler: "tool-sandbox.handler",
    });
    // Verify the TOOLS_BUCKET env var is set (may be a Ref token)
    const fns = template.findResources("AWS::Lambda::Function", {
      Properties: {
        Handler: "tool-sandbox.handler",
      },
    });
    const logicalIds = Object.keys(fns);
    expect(logicalIds.length).toBeGreaterThanOrEqual(1);
    const fnProps = fns[logicalIds[0]].Properties;
    expect(fnProps.Environment.Variables.TOOLS_BUCKET).toBeDefined();
  });

  test("SeedSmokeEchoToolFunction env references ToolsBucket", () => {
    const fns = template.findResources("AWS::Lambda::Function", {
      Properties: {
        Handler: "seed-smoke-echo-tool/index.handler",
      },
    });
    const logicalIds = Object.keys(fns);
    expect(logicalIds.length).toBeGreaterThanOrEqual(1);
    const fnProps = fns[logicalIds[0]].Properties;
    expect(fnProps.Environment.Variables.TOOLS_BUCKET).toBeDefined();
  });
});
