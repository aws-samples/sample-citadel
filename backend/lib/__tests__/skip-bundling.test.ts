/**
 * Tests for pythonAssetCode() skip-bundling helper (CIT-305).
 *
 * (a) ArbiterStack synthesizes under the flag with Docker unreachable.
 * (b) With the flag unset the helper returns bundling options
 *     (image = PYTHON_BUILD_IMAGE, platform = DOCKER_PLATFORM).
 * (c) The guard still throws for ENVIRONMENT=dev + flag.
 */
import * as cdk from "aws-cdk-lib";
import { Template } from "aws-cdk-lib/assertions";
import * as dynamodb from "aws-cdk-lib/aws-dynamodb";
import * as events from "aws-cdk-lib/aws-events";
import { Bucket } from "aws-cdk-lib/aws-s3";
import { ArbiterStack } from "../arbiter-stack";
import {
  pythonAssetCode,
  PYTHON_BUILD_IMAGE,
  DOCKER_PLATFORM,
} from "../runtime-constants";
import {
  scaffoldBackendAssetDirs,
  scaffoldArbiterStubs,
} from "../../test/helpers/scaffold-stub-assets";

scaffoldBackendAssetDirs(["dist/lambda", "src/schema"]);
scaffoldArbiterStubs();

describe("pythonAssetCode skip-bundling (CIT-305)", () => {
  const savedEnv: Record<string, string | undefined> = {};

  beforeEach(() => {
    savedEnv.CITADEL_SKIP_BUNDLING = process.env.CITADEL_SKIP_BUNDLING;
    savedEnv.ENVIRONMENT = process.env.ENVIRONMENT;
    savedEnv.DOCKER_HOST = process.env.DOCKER_HOST;
  });

  afterEach(() => {
    for (const [key, val] of Object.entries(savedEnv)) {
      if (val === undefined) {
        delete process.env[key];
      } else {
        process.env[key] = val;
      }
    }
  });

  // (a) ArbiterStack synthesizes under the flag with Docker unreachable
  it("synthesizes ArbiterStack with CITADEL_SKIP_BUNDLING=1 and unreachable Docker", () => {
    process.env.CITADEL_SKIP_BUNDLING = "1";
    process.env.ENVIRONMENT = "test";
    process.env.DOCKER_HOST = "tcp://127.0.0.1:1";

    const app = new cdk.App();
    const backendStack = new cdk.Stack(app, "MockBackendStack", {
      env: { account: "123456789012", region: "us-east-1" },
    });

    const agentEventBus = new events.EventBus(backendStack, "AgentEventBus", {
      eventBusName: "citadel-agents-test",
    });

    const agentConfigTable = new dynamodb.Table(
      backendStack,
      "AgentConfigTable",
      {
        tableName: "citadel-agents-test",
        partitionKey: { name: "agentId", type: dynamodb.AttributeType.STRING },
        billingMode: dynamodb.BillingMode.PAY_PER_REQUEST,
        removalPolicy: cdk.RemovalPolicy.DESTROY,
      },
    );

    const codeBucket = new Bucket(backendStack, "CodeBucket", {
      bucketName: "citadel-code-test",
    });

    const executionSpecificationsTable = new dynamodb.Table(
      backendStack,
      "ExecutionSpecificationsTable",
      {
        tableName: "citadel-execution-specifications-test",
        partitionKey: { name: "specId", type: dynamodb.AttributeType.STRING },
        billingMode: dynamodb.BillingMode.PAY_PER_REQUEST,
        removalPolicy: cdk.RemovalPolicy.DESTROY,
      },
    );

    // Must NOT throw — synth must complete without touching Docker.
    const stack = new ArbiterStack(app, "ArbiterSkipBundlingTestStack", {
      environment: "test",
      env: { account: "123456789012", region: "us-east-1" },
      agentEventBus,
      agentConfigTable,
      codeBucket,
      executionSpecificationsTable,
    });

    const template = Template.fromStack(stack);
    // The layer should exist in the template.
    template.resourceCountIs("AWS::Lambda::LayerVersion", 1);
  });

  // (b) With the flag unset, the helper returns bundling options
  it("returns real bundling options when CITADEL_SKIP_BUNDLING is unset", () => {
    delete process.env.CITADEL_SKIP_BUNDLING;

    const result = pythonAssetCode("/some/path", {
      command: ["bash", "-c", "echo hello"],
    });

    expect(result.isBundled).toBe(true);
    expect(result.bundlingOptions).toBeDefined();
    expect(result.bundlingOptions!.image).toBe(PYTHON_BUILD_IMAGE);
    expect(result.bundlingOptions!.platform).toBe(DOCKER_PLATFORM);
    expect(result.bundlingOptions!.command).toEqual([
      "bash",
      "-c",
      "echo hello",
    ]);
  });

  // (c) The guard still throws for ENVIRONMENT=dev + flag
  it("throws when CITADEL_SKIP_BUNDLING is set but ENVIRONMENT is dev", () => {
    process.env.CITADEL_SKIP_BUNDLING = "1";
    process.env.ENVIRONMENT = "dev";

    expect(() =>
      pythonAssetCode("/some/path", {
        command: ["bash", "-c", "echo hello"],
      }),
    ).toThrow(/CITADEL_SKIP_BUNDLING.*not.*test/i);
  });
});
