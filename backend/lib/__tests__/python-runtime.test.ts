/**
 * Stack test for python-runtime.ts — enforces that every Python Lambda
 * function and every Python LayerVersion in the Citadel CDK stacks uses
 * the single-source-of-truth constants from lib/python-runtime.ts.
 *
 * Three categories of guard:
 *
 * 1. **Synth guard** — synthesise the ArbiterStack (the only stack with
 *    Python layers and PythonFunction bundling) and assert:
 *    a) every `AWS::Lambda::Function` with a `python` runtime uses
 *       exactly `PYTHON_RUNTIME`;
 *    b) every `AWS::Lambda::LayerVersion` with Python
 *       `compatibleRuntimes` uses `PYTHON_RUNTIME`.
 *
 * 2. **Grep guard** — no literal `build-python3.` or `PYTHON_3_1`
 *    appears in any `backend/lib/*.ts` file outside `python-runtime.ts`
 *    and this test file, so the constants cannot be bypassed.
 *
 * 3. **Derivation guard** — `PYTHON_BUILD_IMAGE` is built from a
 *    Dockerfile whose base image tag is derived from `PYTHON_RUNTIME.name`,
 *    so they can never diverge.
 */
import * as fs from "fs";
import * as path from "path";
import * as cdk from "aws-cdk-lib";
import { Template } from "aws-cdk-lib/assertions";
import * as dynamodb from "aws-cdk-lib/aws-dynamodb";
import * as events from "aws-cdk-lib/aws-events";
import { Bucket } from "aws-cdk-lib/aws-s3";
import { ArbiterStack } from "../arbiter-stack";
import { PYTHON_RUNTIME } from "../python-runtime";
import {
  scaffoldBackendAssetDirs,
  scaffoldArbiterStubs,
} from "../../test/helpers/scaffold-stub-assets";

scaffoldBackendAssetDirs(["dist/lambda", "src/schema"]);
scaffoldArbiterStubs();

// ---------------------------------------------------------------------------
// Category 1: Synth guards
// ---------------------------------------------------------------------------
describe("Python runtime consistency (synth)", () => {
  let template: ReturnType<typeof Template.fromStack>;

  beforeEach(() => {
    const app = new cdk.App({ context: { "aws:cdk:bundling-stacks": [] } });
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

    const stack = new ArbiterStack(app, "ArbiterPyRuntimeTestStack", {
      environment: "test",
      env: { account: "123456789012", region: "us-east-1" },
      agentEventBus,
      agentConfigTable,
      codeBucket,
      executionSpecificationsTable,
    });

    template = Template.fromStack(stack);
  });

  it("every Python Lambda function uses PYTHON_RUNTIME", () => {
    const resources = (
      template as unknown as {
        toJSON(): { Resources: Record<string, Record<string, unknown>> };
      }
    ).toJSON().Resources;

    const violations: string[] = [];
    const expectedRuntime = PYTHON_RUNTIME.name; // e.g. "python3.15"

    for (const [logicalId, resource] of Object.entries(resources)) {
      if (resource.Type !== "AWS::Lambda::Function") continue;
      const props = resource.Properties as Record<string, unknown> | undefined;
      if (!props) continue;
      const runtime = props.Runtime as string | undefined;
      if (!runtime || !runtime.startsWith("python")) continue;
      if (runtime !== expectedRuntime) {
        violations.push(
          `${logicalId}: runtime ${runtime} !== ${expectedRuntime}`,
        );
      }
    }

    expect(violations).toEqual([]);
  });

  it("every Python LayerVersion has PYTHON_RUNTIME in compatibleRuntimes", () => {
    const resources = (
      template as unknown as {
        toJSON(): { Resources: Record<string, Record<string, unknown>> };
      }
    ).toJSON().Resources;

    const violations: string[] = [];
    const expectedRuntime = PYTHON_RUNTIME.name;

    for (const [logicalId, resource] of Object.entries(resources)) {
      if (resource.Type !== "AWS::Lambda::LayerVersion") continue;
      const props = resource.Properties as Record<string, unknown> | undefined;
      if (!props) continue;
      const runtimes = props.CompatibleRuntimes as string[] | undefined;
      if (!runtimes) continue;
      const hasPython = runtimes.some((r: string) => r.startsWith("python"));
      if (!hasPython) continue;
      if (!runtimes.includes(expectedRuntime)) {
        violations.push(
          `${logicalId}: compatibleRuntimes [${runtimes.join(", ")}] missing ${expectedRuntime}`,
        );
      }
    }

    expect(violations).toEqual([]);
  });
});

// ---------------------------------------------------------------------------
// Category 2: Grep guard — no literal runtime/image tokens outside the
// single-source-of-truth module
// ---------------------------------------------------------------------------
describe("Python runtime consistency (grep guard)", () => {
  const LIB_DIR = path.resolve(__dirname, "..");
  const ALLOWED_FILES = new Set([
    "python-runtime.ts",
    // This test file itself references the patterns for assertion purposes
    path.basename(__filename),
  ]);

  /**
   * Scan all .ts files in backend/lib/ for forbidden literal patterns.
   * Returns an array of `"file:line: match"` strings.
   */
  function scanForLiterals(pattern: RegExp): string[] {
    const violations: string[] = [];
    const files = fs.readdirSync(LIB_DIR).filter((f) => f.endsWith(".ts"));

    for (const file of files) {
      if (ALLOWED_FILES.has(file)) continue;
      const filePath = path.join(LIB_DIR, file);
      const stat = fs.statSync(filePath);
      if (!stat.isFile()) continue;
      const lines = fs.readFileSync(filePath, "utf-8").split("\n");
      for (let i = 0; i < lines.length; i++) {
        if (pattern.test(lines[i])) {
          violations.push(`${file}:${i + 1}: ${lines[i].trim()}`);
        }
      }
    }
    return violations;
  }

  it('no literal "build-python3." outside python-runtime.ts', () => {
    const violations = scanForLiterals(/build-python3\./);
    expect(violations).toEqual([]);
  });

  it('no literal "PYTHON_3_1" outside python-runtime.ts', () => {
    // Matches PYTHON_3_14, PYTHON_3_15, etc. — any hardcoded runtime enum
    const violations = scanForLiterals(/PYTHON_3_1\d/);
    expect(violations).toEqual([]);
  });
});

// ---------------------------------------------------------------------------
// Category 3: Derivation guard
// ---------------------------------------------------------------------------
describe("Python runtime derivation", () => {
  it("PYTHON_BUILD_IMAGE is derived from PYTHON_RUNTIME.name", () => {
    // Verify the Dockerfile references the Lambda base image for the
    // correct version — this is the true single-source derivation
    // guarantee.  We check the Dockerfile directly rather than accessing
    // .image (which would trigger a Docker build that tests don't need).
    const dockerfilePath = path.resolve(
      __dirname,
      "..",
      "python-build-image",
      "Dockerfile",
    );
    const dockerfile = fs.readFileSync(dockerfilePath, "utf-8");
    const version = PYTHON_RUNTIME.name.replace("python", ""); // "3.15"
    expect(dockerfile).toContain(
      `public.ecr.aws/lambda/python:\${LAMBDA_BASE_TAG}`,
    );
    expect(dockerfile).toContain(`ARG LAMBDA_BASE_TAG=${version}`);
    // Verify ENTRYPOINT is cleared (CDK bundling needs bash as the CMD)
    expect(dockerfile).toMatch(/ENTRYPOINT\s+\[\]/);
  });
});
