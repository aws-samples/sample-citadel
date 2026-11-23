/**
 * ArbiterStack — the worker wrapper Lambda's execution role must be able
 * to invoke the smoke echo fixture Lambda directly (board task 10c3bf48
 * Slice 2 follow-up).
 *
 * The smoke echo tool's registry record declares `credentialMode: 'none'`
 * (see seed-smoke-echo-tool/index.ts), so tool_run_handler.py's
 * `_invoke_lambda_binding` is called with `credentials=None` and falls
 * back to `boto3.client("lambda")` under the worker's OWN execution role
 * rather than scoped STS credentials. Without an explicit
 * `lambda:InvokeFunction` grant scoped to the echo function's ARN, that
 * call is denied and the deployed smoke test's `testTool` check against
 * the fixture fails.
 *
 * ServicesStack (which owns SmokeEchoLambdaFunction) is instantiated
 * BEFORE ArbiterStack in app.ts and ArbiterStack already depends on it
 * (arbiterStack.addStackDependency(servicesStack)), so passing the real
 * construct — not a deterministic-ARN string — is safe here and avoids a
 * dependency cycle.
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

function buildTemplate(includeSmokeEcho: boolean): Template {
  const app = new cdk.App({ context: { "aws:cdk:bundling-stacks": [] } });
  const backendStack = new cdk.Stack(app, "MockBackendStackSmokeEchoGrant", {
    env: { account: "123456789012", region: "us-east-1" },
  });
  const agentEventBus = new events.EventBus(backendStack, "AgentEventBus", {
    eventBusName: "citadel-agents-test-seg",
  });
  const mkTable = (id: string, name: string, pk: string) =>
    new dynamodb.Table(backendStack, id, {
      tableName: name,
      partitionKey: { name: pk, type: dynamodb.AttributeType.STRING },
      billingMode: dynamodb.BillingMode.PAY_PER_REQUEST,
      removalPolicy: cdk.RemovalPolicy.DESTROY,
    });
  const agentConfigTable = mkTable(
    "AgentConfigTable",
    "citadel-agents-test-seg",
    "agentId",
  );
  const executionSpecificationsTable = mkTable(
    "ExecutionSpecificationsTable",
    "citadel-execution-specifications-test-seg",
    "specId",
  );
  const codeBucket = new Bucket(backendStack, "CodeBucket", {
    bucketName: "citadel-code-test-seg",
  });
  const appSyncApi = new appsync.GraphqlApi(backendStack, "MockApi", {
    name: "mock-api-seg",
    schema: appsync.SchemaFile.fromAsset(
      path.resolve(__dirname, "../src/schema/schema.graphql"),
    ),
  });

  // Stand-in for ServicesStack's SmokeEchoLambdaFunction — a real
  // construct reference, matching how app.ts wires it (not a
  // deterministic-ARN string; ArbiterStack already depends on
  // ServicesStack).
  const smokeEchoLambdaFunction = includeSmokeEcho
    ? new lambda.Function(backendStack, "SmokeEchoLambdaFunctionStandIn", {
        functionName: "citadel-smoke-echo-test-seg",
        runtime: lambda.Runtime.NODEJS_24_X,
        handler: "smoke-echo-lambda.handler",
        code: lambda.Code.fromAsset("dist/lambda"),
      })
    : undefined;

  const stack = new ArbiterStack(
    app,
    `TestArbiterStackSmokeEchoGrant${includeSmokeEcho ? "With" : "Without"}`,
    {
      environment: "test",
      env: { account: "123456789012", region: "us-east-1" },
      agentEventBus,
      agentConfigTable,
      codeBucket,
      appSyncEndpoint: appSyncApi.graphqlUrl,
      executionSpecificationsTable,
      smokeEchoLambdaFunction,
    },
  );
  return Template.fromStack(stack);
}

describe("ArbiterStack — worker role invoke grant on the smoke echo fixture", () => {
  test("grants lambda:InvokeFunction on the smoke echo function when the prop is supplied", () => {
    const template = buildTemplate(true);
    template.hasResourceProperties("AWS::IAM::Policy", {
      PolicyDocument: Match.objectLike({
        Statement: Match.arrayWith([
          Match.objectLike({
            Action: "lambda:InvokeFunction",
            Effect: "Allow",
            // Cross-stack reference (SmokeEchoLambdaFunctionStandIn lives in
            // the mock "backend" stack, ArbiterStack is separate) resolves
            // to Fn::ImportValue, not a same-stack Fn::GetAtt — matches how
            // app.ts wires ServicesStack's SmokeEchoLambdaFunction into
            // ArbiterStack in practice (two distinct stacks).
            Resource: Match.arrayWith([
              Match.objectLike({
                "Fn::ImportValue": Match.stringLikeRegexp(
                  "SmokeEchoLambdaFunctionStandIn",
                ),
              }),
            ]),
          }),
        ]),
      }),
    });
  });

  test("synthesizes cleanly without the grant when the prop is omitted (e.g. prod, where the fixture does not exist)", () => {
    expect(() => buildTemplate(false)).not.toThrow();
  });
});
