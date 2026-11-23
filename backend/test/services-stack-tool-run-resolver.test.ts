/**
 * ServicesStack — Mutation.testTool resolver cutover to the worker wrapper
 * (board task 10c3bf48, Slice 1).
 *
 * Asserts:
 *  - A new ToolRunResolverFunction exists, backed by tool-run-resolver.ts.
 *  - It is granted `lambda:InvokeFunction` SCOPED to exactly the worker
 *    wrapper function's ARN (no wildcard).
 *  - Its WORKER_WRAPPER_FUNCTION_ARN env var carries that same ARN.
 *  - The testTool AppSync resolver's datasource now targets
 *    ToolRunResolverFunction, not ToolSandboxFunction.
 *  - ToolSandboxFunction itself is UNCHANGED/still present (Slice 2 deletes
 *    it later) — this slice only stops routing to it.
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

const APPSYNC_API_ID = "api-testtool-worker";
const APPSYNC_API_ARN = `arn:aws:appsync:us-west-2:123456789012:apis/${APPSYNC_API_ID}`;
const APPSYNC_URL =
  "https://api-testtool-worker.appsync-api.us-west-2.amazonaws.com/graphql";
const WORKER_FUNCTION_ARN =
  "arn:aws:lambda:us-west-2:123456789012:function:citadel-worker-wrapper-test";

function buildStack(): cdk.assertions.Template {
  const app = new cdk.App();
  const prereq = new cdk.Stack(app, "TestToolWorkerPrereq", {
    env: { account: "123456789012", region: "us-west-2" },
  });
  const bus = new events.EventBus(prereq, "Bus", {
    eventBusName: "test-tool-worker-bus",
  });
  const bucket = new s3.Bucket(prereq, "DocBucket");
  const membershipTable = new dynamodb.Table(prereq, "UserOrgMembership", {
    tableName: "citadel-user-org-membership-test-w",
    partitionKey: { name: "sub", type: dynamodb.AttributeType.STRING },
    billingMode: dynamodb.BillingMode.PAY_PER_REQUEST,
  });

  const stack = new ServicesStack(app, "citadel-services-testtool-worker", {
    environment: "test",
    agentEventBus: bus,
    documentBucket: bucket,
    userOrgMembershipTable: membershipTable,
    appSyncApiArn: APPSYNC_API_ARN,
    appSyncApiId: APPSYNC_API_ID,
    appSyncGraphqlUrl: APPSYNC_URL,
    userPoolId: "us-west-2_testpoolw",
    userPoolArn:
      "arn:aws:cognito-idp:us-west-2:123456789012:userpool/us-west-2_testpoolw",
    workerWrapperFunctionArn: WORKER_FUNCTION_ARN,
    env: { account: "123456789012", region: "us-west-2" },
  });
  return cdk.assertions.Template.fromStack(stack);
}

describe("ServicesStack — testTool cutover to the worker wrapper", () => {
  let template: cdk.assertions.Template;

  beforeAll(() => {
    template = buildStack();
  });

  test("creates a ToolRunResolverFunction", () => {
    template.hasResourceProperties("AWS::Lambda::Function", {
      FunctionName: "citadel-tool-run-resolver-test",
    });
  });

  test("ToolRunResolverFunction has WORKER_WRAPPER_FUNCTION_ARN env pointing at the worker", () => {
    template.hasResourceProperties("AWS::Lambda::Function", {
      FunctionName: "citadel-tool-run-resolver-test",
      Environment: {
        Variables: cdk.assertions.Match.objectLike({
          WORKER_WRAPPER_FUNCTION_ARN: WORKER_FUNCTION_ARN,
        }),
      },
    });
  });

  test("grants lambda:InvokeFunction scoped to exactly the worker function ARN (no wildcard)", () => {
    template.hasResourceProperties("AWS::IAM::Policy", {
      PolicyDocument: {
        Statement: cdk.assertions.Match.arrayWith([
          cdk.assertions.Match.objectLike({
            Effect: "Allow",
            Action: "lambda:InvokeFunction",
            Resource: WORKER_FUNCTION_ARN,
          }),
        ]),
      },
    });
  });

  test("ToolRunResolverFunction's policy grants exactly the expected statements (lambda:InvokeFunction on the worker ARN, GetRegistryRecord on the registry + record sub-resource, dynamodb:GetItem on the legacy tools table, X-Ray write) — nothing else", () => {
    const policies = template.findResources("AWS::IAM::Policy", {
      Properties: {
        PolicyName: cdk.assertions.Match.stringLikeRegexp(
          "ToolRunResolverFunctionServiceRoleDefaultPolicy",
        ),
      },
    });
    const policyIds = Object.keys(policies);
    expect(policyIds).toHaveLength(1);
    const statements = policies[policyIds[0]].Properties.PolicyDocument
      .Statement as Array<Record<string, unknown>>;

    // Exactly 4 statements: no silent scope widening.
    expect(statements).toHaveLength(4);

    const byAction = (action: string) =>
      statements.find((s) => {
        const a = s.Action;
        return Array.isArray(a) ? a.includes(action) : a === action;
      });

    // lambda:InvokeFunction scoped to exactly the worker wrapper ARN.
    expect(byAction("lambda:InvokeFunction")).toMatchObject({
      Effect: "Allow",
      Action: "lambda:InvokeFunction",
      Resource: WORKER_FUNCTION_ARN,
    });

    // Registry read scoped to GetRegistryRecord only — ListRegistryRecords
    // removed, resolveToolConfig's registry path never calls it. Resource
    // is [registryArn, `${registryArn}/*`], both resolved via SSM lookup.
    const registryStmt = byAction("agent-registry:GetRegistryRecord");
    expect(registryStmt).toMatchObject({
      Effect: "Allow",
      Action: "agent-registry:GetRegistryRecord",
    });
    expect(Array.isArray(registryStmt?.Resource)).toBe(true);
    expect((registryStmt?.Resource as unknown[]).length).toBe(2);

    // Legacy DynamoDB fallback read.
    expect(byAction("dynamodb:GetItem")).toMatchObject({
      Effect: "Allow",
      Action: "dynamodb:GetItem",
      Resource:
        "arn:aws:dynamodb:us-west-2:123456789012:table/citadel-tools-test",
    });

    // X-Ray write, granted by `tracing: lambda.Tracing.ACTIVE` (CDK-native,
    // auto-attaches the un-scopable Put*/GetSampling* statement).
    expect(byAction("xray:PutTraceSegments")).toMatchObject({
      Effect: "Allow",
      Action: ["xray:PutTraceSegments", "xray:PutTelemetryRecords"],
      Resource: "*",
    });

    // No statement grants agent-registry:ListRegistryRecords.
    expect(byAction("agent-registry:ListRegistryRecords")).toBeUndefined();
  });

  test("testTool resolver's datasource now targets ToolRunResolverFunction", () => {
    template.hasResourceProperties("AWS::AppSync::DataSource", {
      Type: "AWS_LAMBDA",
      Name: "ToolRunResolverLambdaDataSource",
    });
    template.hasResourceProperties("AWS::AppSync::Resolver", {
      ApiId: APPSYNC_API_ID,
      TypeName: "Mutation",
      FieldName: "testTool",
      DataSourceName: { "Fn::GetAtt": cdk.assertions.Match.anyValue() },
    });
  });

  test("ToolSandboxFunction is still present (Slice 2 removes it, not this slice)", () => {
    template.hasResourceProperties("AWS::Lambda::Function", {
      FunctionName: "citadel-tool-sandbox-test",
    });
  });

  test("the old ToolSandboxLambdaDataSource is no longer wired to testTool", () => {
    const resolvers = template.findResources("AWS::AppSync::Resolver", {
      Properties: {
        TypeName: "Mutation",
        FieldName: "testTool",
      },
    });
    const resolverIds = Object.keys(resolvers);
    expect(resolverIds).toHaveLength(1);
    const resolver = resolvers[resolverIds[0]];
    const dataSourceNameRef = JSON.stringify(
      resolver.Properties.DataSourceName,
    );
    // The resolved logical id behind DataSourceName must belong to the new
    // ToolRunResolverLambdaDataSource, not ToolSandboxLambdaDataSource.
    expect(dataSourceNameRef).not.toMatch(/ToolSandboxLambdaDataSource/);
  });
});
