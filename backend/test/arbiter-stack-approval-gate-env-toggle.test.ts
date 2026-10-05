import * as cdk from "aws-cdk-lib";
import { Annotations, Match, Template } from "aws-cdk-lib/assertions";
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

// ---------------------------------------------------------------
// Shared helper — synthesize an ArbiterStack with optional context
// overrides and optional env‐var overrides. Env vars are restored
// after synthesis so tests stay isolated.
// ---------------------------------------------------------------
function synthArbiter(opts?: {
  context?: Record<string, string>;
  envOverrides?: Record<string, string>;
}): { template: Template; stack: ArbiterStack; app: cdk.App } {
  // Snapshot then override process.env
  const originals: Record<string, string | undefined> = {};
  for (const [k, v] of Object.entries(opts?.envOverrides ?? {})) {
    originals[k] = process.env[k];
    process.env[k] = v;
  }

  try {
    const app = new cdk.App({
      context: {
        "aws:cdk:bundling-stacks": [],
        ...(opts?.context ?? {}),
      },
    });
    const backendStack = new cdk.Stack(app, "MockBackendStack", {
      env: { account: "123456789012", region: "us-east-1" },
    });
    const agentEventBus = new events.EventBus(backendStack, "AgentEventBus", {
      eventBusName: "citadel-agents-test",
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
      "citadel-agents-test",
      "agentId",
    );
    const workflowsTable = mkTable(
      "WorkflowsTable",
      "citadel-workflows-test",
      "workflowId",
    );
    const executionsTable = mkTable(
      "ExecutionsTable",
      "citadel-executions-test",
      "executionId",
    );
    const executionSpecificationsTable = mkTable(
      "ExecutionSpecificationsTable",
      "citadel-execution-specifications-test",
      "specId",
    );
    const codeBucket = new Bucket(backendStack, "CodeBucket", {
      bucketName: "citadel-code-test",
    });
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

    const stack = new ArbiterStack(app, "TestArbiterStack", {
      environment: "test",
      env: { account: "123456789012", region: "us-east-1" },
      agentEventBus,
      agentConfigTable,
      codeBucket,
      workflowsTable,
      executionsTable,
      fanoutFunction,
      appSyncEndpoint: appSyncApi.graphqlUrl,
      executionSpecificationsTable,
    });
    const template = Template.fromStack(stack);
    return { template, stack, app };
  } finally {
    // Restore env
    for (const [k, v] of Object.entries(originals)) {
      if (v === undefined) delete process.env[k];
      else process.env[k] = v;
    }
  }
}

// Helper: extract the Variables map from a Lambda whose logical id starts with `prefix`.
function envVarsFor(
  template: Template,
  prefix: string,
): Record<string, unknown> {
  const fns = template.findResources("AWS::Lambda::Function");
  const match = Object.entries(fns).find(([id]) => id.startsWith(prefix));
  if (!match) throw new Error(`no function with prefix ${prefix}`);
  return (
    (
      match[1] as {
        Properties?: { Environment?: { Variables?: Record<string, unknown> } };
      }
    ).Properties?.Environment?.Variables ?? {}
  );
}

// ---------------------------------------------------------------
// APPROVAL_GATE_ENABLED precedence tests
// ---------------------------------------------------------------
describe("APPROVAL_GATE_ENABLED precedence", () => {
  // We test all three consumer functions; the watchdog does NOT read this var.
  const consumers = [
    "SupervisorAgent",
    "WorkerAgentWrapper",
    "StepRunnerFunction",
  ];

  test("defaults to 'false' when neither env nor context is set", () => {
    const { template } = synthArbiter();
    for (const prefix of consumers) {
      expect(envVarsFor(template, prefix)).toHaveProperty(
        "APPROVAL_GATE_ENABLED",
        "false",
      );
    }
  });

  test("context wins over default", () => {
    const { template } = synthArbiter({
      context: { approvalGateEnabled: "true" },
    });
    for (const prefix of consumers) {
      expect(envVarsFor(template, prefix)).toHaveProperty(
        "APPROVAL_GATE_ENABLED",
        "true",
      );
    }
  });

  test("env wins over context", () => {
    const { template } = synthArbiter({
      context: { approvalGateEnabled: "false" },
      envOverrides: { APPROVAL_GATE_ENABLED: "true" },
    });
    for (const prefix of consumers) {
      expect(envVarsFor(template, prefix)).toHaveProperty(
        "APPROVAL_GATE_ENABLED",
        "true",
      );
    }
  });
});

// ---------------------------------------------------------------
// APPROVAL_TIMEOUT_SECONDS precedence tests
// ---------------------------------------------------------------
describe("APPROVAL_TIMEOUT_SECONDS precedence", () => {
  const consumer = "WorkflowTimeoutWatchdogFunction";

  test("defaults to '86400' when neither env nor context is set", () => {
    const { template } = synthArbiter();
    expect(envVarsFor(template, consumer)).toHaveProperty(
      "APPROVAL_TIMEOUT_SECONDS",
      "86400",
    );
  });

  test("context wins over default", () => {
    const { template } = synthArbiter({
      context: { approvalTimeoutSeconds: "3600" },
    });
    expect(envVarsFor(template, consumer)).toHaveProperty(
      "APPROVAL_TIMEOUT_SECONDS",
      "3600",
    );
  });

  test("env wins over context", () => {
    const { template } = synthArbiter({
      context: { approvalTimeoutSeconds: "3600" },
      envOverrides: { APPROVAL_TIMEOUT_SECONDS: "7200" },
    });
    expect(envVarsFor(template, consumer)).toHaveProperty(
      "APPROVAL_TIMEOUT_SECONDS",
      "7200",
    );
  });
});

// ---------------------------------------------------------------
// Validation — invalid values produce Annotations errors
// ---------------------------------------------------------------
describe("validation", () => {
  test("invalid APPROVAL_GATE_ENABLED fails synth with Annotations error", () => {
    const { stack } = synthArbiter({
      envOverrides: { APPROVAL_GATE_ENABLED: "yes" },
    });
    const annotations = Annotations.fromStack(stack);
    annotations.hasError(
      "*",
      Match.stringLikeRegexp("Invalid APPROVAL_GATE_ENABLED"),
    );
  });

  test("invalid APPROVAL_TIMEOUT_SECONDS fails synth with Annotations error", () => {
    const { stack } = synthArbiter({
      envOverrides: { APPROVAL_TIMEOUT_SECONDS: "-1" },
    });
    const annotations = Annotations.fromStack(stack);
    annotations.hasError(
      "*",
      Match.stringLikeRegexp("Invalid APPROVAL_TIMEOUT_SECONDS"),
    );
  });

  test("APPROVAL_TIMEOUT_SECONDS rejects zero", () => {
    const { stack } = synthArbiter({
      envOverrides: { APPROVAL_TIMEOUT_SECONDS: "0" },
    });
    const annotations = Annotations.fromStack(stack);
    annotations.hasError(
      "*",
      Match.stringLikeRegexp("Invalid APPROVAL_TIMEOUT_SECONDS"),
    );
  });

  test("APPROVAL_TIMEOUT_SECONDS rejects non-numeric", () => {
    const { stack } = synthArbiter({
      envOverrides: { APPROVAL_TIMEOUT_SECONDS: "abc" },
    });
    const annotations = Annotations.fromStack(stack);
    annotations.hasError(
      "*",
      Match.stringLikeRegexp("Invalid APPROVAL_TIMEOUT_SECONDS"),
    );
  });
});
