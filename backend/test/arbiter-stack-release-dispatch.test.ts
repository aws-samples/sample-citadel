/**
 * arbiter-stack-release-dispatch.test.ts — G3 CDK wiring assertions.
 *
 * When the release substrate is provisioned (release tables passed +
 * releaseDefaultOrgId set), the Supervisor and Step Runner Lambdas must
 * carry BOTH release-aware-dispatch env vars:
 *  - RELEASE_DISPATCH_ENVIRONMENT = <environment>.toUpperCase() (the
 *    feature switch, uppercased to match EnvironmentLiteral / pointer SK)
 *  - RELEASE_DEFAULT_ORG_ID = the named org seam
 * resolve_release (Python, unchanged) reads both at dispatch time so each
 * env's stack resolves its OWN pointer set.
 */
import * as cdk from "aws-cdk-lib";
import { Template, Match } from "aws-cdk-lib/assertions";
import * as dynamodb from "aws-cdk-lib/aws-dynamodb";
import * as events from "aws-cdk-lib/aws-events";
import * as lambda from "aws-cdk-lib/aws-lambda";
import * as appsync from "aws-cdk-lib/aws-appsync";
import { Bucket } from "aws-cdk-lib/aws-s3";
import * as path from "path";
import {
  scaffoldBackendAssetDirs,
  scaffoldArbiterStubs,
} from "./helpers/scaffold-stub-assets";

scaffoldBackendAssetDirs(["dist/lambda", "src/schema"]);
scaffoldArbiterStubs();

import { ArbiterStack } from "../lib/arbiter-stack";

function mockTable(
  scope: cdk.Stack,
  id: string,
  tableName: string,
  pk: string,
): dynamodb.Table {
  return new dynamodb.Table(scope, id, {
    tableName,
    partitionKey: { name: pk, type: dynamodb.AttributeType.STRING },
    billingMode: dynamodb.BillingMode.PAY_PER_REQUEST,
    removalPolicy: cdk.RemovalPolicy.DESTROY,
  });
}

function synth(withRelease: boolean): Template {
  const app = new cdk.App();
  const backendStack = new cdk.Stack(app, "MockBackendStackReleaseDispatch", {
    env: { account: "123456789012", region: "us-east-1" },
  });
  const agentEventBus = new events.EventBus(backendStack, "AgentEventBus", {
    eventBusName: "citadel-agents-test",
  });
  const agentConfigTable = mockTable(
    backendStack,
    "AgentConfigTable",
    "citadel-agents-test",
    "agentId",
  );
  const codeBucket = new Bucket(backendStack, "CodeBucket", {
    bucketName: "citadel-code-test",
  });
  const workflowsTable = mockTable(
    backendStack,
    "WorkflowsTable",
    "citadel-workflows-test",
    "workflowId",
  );
  const executionsTable = mockTable(
    backendStack,
    "ExecutionsTable",
    "citadel-executions-test",
    "executionId",
  );
  const executionSpecificationsTable = mockTable(
    backendStack,
    "ExecutionSpecificationsTable",
    "citadel-execution-specifications-test",
    "specId",
  );
  const fanoutFunction = new lambda.Function(backendStack, "FanoutFunction", {
    runtime: lambda.Runtime.NODEJS_24_X,
    handler: "workflow-progress-fanout.handler",
    code: lambda.Code.fromAsset("dist/lambda"),
    timeout: cdk.Duration.seconds(30),
  });
  const appSyncApi = new appsync.GraphqlApi(backendStack, "MockApi", {
    name: "mock-api",
    schema: appsync.SchemaFile.fromAsset(
      path.resolve(__dirname, "../src/schema/schema.graphql"),
    ),
  });

  const releaseProps = withRelease
    ? {
        agentReleasesTable: mockTable(
          backendStack,
          "AgentReleasesTable",
          "citadel-agent-releases-test",
          "releaseId",
        ),
        environmentReleasePointersTable: new dynamodb.Table(
          backendStack,
          "EnvironmentReleasePointersTable",
          {
            tableName: "citadel-environment-release-pointers-test",
            partitionKey: {
              name: "orgId",
              type: dynamodb.AttributeType.STRING,
            },
            sortKey: {
              name: "agentTargetId_environment",
              type: dynamodb.AttributeType.STRING,
            },
            billingMode: dynamodb.BillingMode.PAY_PER_REQUEST,
            removalPolicy: cdk.RemovalPolicy.DESTROY,
          },
        ),
        releaseDefaultOrgId: "org-default-test",
      }
    : {};

  const stack = new ArbiterStack(app, "TestArbiterStackReleaseDispatch", {
    environment: "staging",
    env: { account: "123456789012", region: "us-east-1" },
    agentEventBus,
    agentConfigTable,
    codeBucket,
    workflowsTable,
    executionsTable,
    fanoutFunction,
    appSyncEndpoint: appSyncApi.graphqlUrl,
    executionSpecificationsTable,
    ...releaseProps,
  });
  return Template.fromStack(stack);
}

describe("ArbiterStack — G3 release-aware dispatch env wiring", () => {
  test("Supervisor + Step Runner both carry RELEASE_DISPATCH_ENVIRONMENT (uppercased) + RELEASE_DEFAULT_ORG_ID when the substrate is wired", () => {
    const template = synth(true);

    // Supervisor (python, EventBridge-driven) and Step Runner both get
    // the pair. Assert at least two Lambdas carry the uppercased env token.
    const functions = template.findResources("AWS::Lambda::Function");
    const withDispatch = Object.values(functions).filter((fn) => {
      const vars = fn.Properties?.Environment?.Variables ?? {};
      return (
        vars.RELEASE_DISPATCH_ENVIRONMENT === "STAGING" &&
        vars.RELEASE_DEFAULT_ORG_ID === "org-default-test"
      );
    });
    expect(withDispatch.length).toBeGreaterThanOrEqual(2);
  });

  test("Step Runner (index.handler) carries the uppercased dispatch env + default org", () => {
    const template = synth(true);
    template.hasResourceProperties("AWS::Lambda::Function", {
      Handler: "index.handler",
      Environment: {
        Variables: Match.objectLike({
          RELEASE_DISPATCH_ENVIRONMENT: "STAGING",
          RELEASE_DEFAULT_ORG_ID: "org-default-test",
        }),
      },
    });
  });

  test("without the release substrate, neither dispatch env var is set (forward-compatible no-op)", () => {
    const template = synth(false);
    const functions = template.findResources("AWS::Lambda::Function");
    for (const fn of Object.values(functions)) {
      const vars = fn.Properties?.Environment?.Variables ?? {};
      expect(vars.RELEASE_DISPATCH_ENVIRONMENT).toBeUndefined();
      expect(vars.RELEASE_DEFAULT_ORG_ID).toBeUndefined();
    }
  });
});
