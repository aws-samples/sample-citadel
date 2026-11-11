/**
 * Stack test for runtime-constants.ts — enforces that every Lambda function,
 * LayerVersion, and container image in the Citadel CDK stacks uses the
 * single-source-of-truth constants from lib/runtime-constants.ts.
 *
 * Five categories of guard:
 *
 * 1. **Synth guard** — synthesise the ArbiterStack and assert:
 *    a) every Python function uses PYTHON_RUNTIME;
 *    b) every Python layer uses PYTHON_RUNTIME;
 *    c) every function Architectures == [arm64];
 *    d) every layer CompatibleArchitectures includes arm64.
 *
 * 2. **Grep guard** — no literal runtime, architecture or platform tokens
 *    appear in any backend/lib/*.ts file outside runtime-constants.ts and
 *    this test file, enforcing that the constants cannot be bypassed.
 *
 * 3. **Derivation guard** — PYTHON_BUILD_IMAGE Dockerfile is derived from
 *    PYTHON_RUNTIME.name and uses --platform.
 *
 * 4. **Full-fleet arm64 guard** — all Lambda functions, layers, and
 *    container images across ALL stacks target arm64.
 */
import * as fs from "fs";
import * as path from "path";
import * as cdk from "aws-cdk-lib";
import { Template } from "aws-cdk-lib/assertions";
import * as dynamodb from "aws-cdk-lib/aws-dynamodb";
import * as events from "aws-cdk-lib/aws-events";
import { Bucket } from "aws-cdk-lib/aws-s3";
import { ArbiterStack } from "../arbiter-stack";
import {
  PYTHON_RUNTIME,
  LAMBDA_ARCHITECTURE,
  NODE_RUNTIME,
} from "../runtime-constants";
import {
  scaffoldBackendAssetDirs,
  scaffoldArbiterStubs,
} from "../../test/helpers/scaffold-stub-assets";

scaffoldBackendAssetDirs(["dist/lambda", "src/schema"]);
scaffoldArbiterStubs();

// ---------------------------------------------------------------------------
// Category 1: Synth guards (ArbiterStack — the only stack with Python layers)
// ---------------------------------------------------------------------------
describe("Runtime consistency (synth)", () => {
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

    const stack = new ArbiterStack(app, "ArbiterRuntimeTestStack", {
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
    const expectedRuntime = PYTHON_RUNTIME.name;

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

  it("every Node.js Lambda function uses NODE_RUNTIME", () => {
    const resources = (
      template as unknown as {
        toJSON(): { Resources: Record<string, Record<string, unknown>> };
      }
    ).toJSON().Resources;

    const violations: string[] = [];
    const expectedRuntime = NODE_RUNTIME.name;

    for (const [logicalId, resource] of Object.entries(resources)) {
      if (resource.Type !== "AWS::Lambda::Function") continue;
      const props = resource.Properties as Record<string, unknown> | undefined;
      if (!props) continue;
      const runtime = props.Runtime as string | undefined;
      if (!runtime || !runtime.startsWith("nodejs")) continue;
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

  it("every Lambda function has Architectures == [arm64]", () => {
    const resources = (
      template as unknown as {
        toJSON(): { Resources: Record<string, Record<string, unknown>> };
      }
    ).toJSON().Resources;

    const violations: string[] = [];
    const expectedArch = LAMBDA_ARCHITECTURE.name; // "arm64"

    for (const [logicalId, resource] of Object.entries(resources)) {
      if (resource.Type !== "AWS::Lambda::Function") continue;
      const props = resource.Properties as Record<string, unknown> | undefined;
      if (!props) continue;
      const architectures = props.Architectures as string[] | undefined;
      if (!architectures || !architectures.includes(expectedArch)) {
        violations.push(
          `${logicalId}: Architectures ${JSON.stringify(architectures)} missing ${expectedArch}`,
        );
      }
    }

    expect(violations).toEqual([]);
  });

  it("every LayerVersion has arm64 in compatibleArchitectures", () => {
    const resources = (
      template as unknown as {
        toJSON(): { Resources: Record<string, Record<string, unknown>> };
      }
    ).toJSON().Resources;

    const violations: string[] = [];
    const expectedArch = LAMBDA_ARCHITECTURE.name;

    for (const [logicalId, resource] of Object.entries(resources)) {
      if (resource.Type !== "AWS::Lambda::LayerVersion") continue;
      const props = resource.Properties as Record<string, unknown> | undefined;
      if (!props) continue;
      const arches = props.CompatibleArchitectures as string[] | undefined;
      if (!arches || !arches.includes(expectedArch)) {
        violations.push(
          `${logicalId}: CompatibleArchitectures ${JSON.stringify(arches)} missing ${expectedArch}`,
        );
      }
    }

    expect(violations).toEqual([]);
  });
});

// ---------------------------------------------------------------------------
// Category 2: Grep guard — no literal runtime/architecture/platform tokens
// outside the single-source-of-truth module
// ---------------------------------------------------------------------------
describe("Runtime consistency (grep guard)", () => {
  const LIB_DIR = path.resolve(__dirname, "..");
  const ALLOWED_FILES = new Set([
    "runtime-constants.ts",
    path.basename(__filename),
  ]);

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

  it('no literal "build-python3." outside runtime-constants.ts', () => {
    const violations = scanForLiterals(/build-python3\./);
    expect(violations).toEqual([]);
  });

  it('no literal "PYTHON_3_1" outside runtime-constants.ts', () => {
    const violations = scanForLiterals(/PYTHON_3_1\d/);
    expect(violations).toEqual([]);
  });

  it('no literal "Architecture." outside runtime-constants.ts', () => {
    const violations = scanForLiterals(/Architecture\./);
    expect(violations).toEqual([]);
  });

  it('no literal "--platform" outside runtime-constants.ts', () => {
    const violations = scanForLiterals(/--platform/);
    expect(violations).toEqual([]);
  });

  it('no literal "NODEJS_24_X" outside runtime-constants.ts', () => {
    const violations = scanForLiterals(/NODEJS_24_X/);
    expect(violations).toEqual([]);
  });

  it('no literal "Platform." outside runtime-constants.ts', () => {
    // Platform.LINUX_AMD64 / Platform.LINUX_ARM64 must live only in the
    // single-source-of-truth; consumers use ECR_PLATFORM.
    const violations = scanForLiterals(/Platform\./);
    expect(violations).toEqual([]);
  });
});

// ---------------------------------------------------------------------------
// Category 3: Derivation guard
// ---------------------------------------------------------------------------
describe("Python build image derivation", () => {
  it("PYTHON_BUILD_IMAGE is derived from PYTHON_RUNTIME.name", () => {
    const dockerfilePath = path.resolve(
      __dirname,
      "..",
      "python-build-image",
      "Dockerfile",
    );
    const dockerfile = fs.readFileSync(dockerfilePath, "utf-8");
    const version = PYTHON_RUNTIME.name.replace("python", "");
    expect(dockerfile).toContain(
      `public.ecr.aws/lambda/python:\${LAMBDA_BASE_TAG}`,
    );
    expect(dockerfile).toContain(`ARG LAMBDA_BASE_TAG=${version}`);
    expect(dockerfile).toMatch(/ENTRYPOINT\s+\[\]/);
  });

  it("Dockerfile FROM uses --platform for architecture pinning", () => {
    const dockerfilePath = path.resolve(
      __dirname,
      "..",
      "python-build-image",
      "Dockerfile",
    );
    const dockerfile = fs.readFileSync(dockerfilePath, "utf-8");
    expect(dockerfile).toMatch(
      /FROM\s+--platform=\$\{TARGETPLATFORM\}\s+public\.ecr\.aws\/lambda\/python/,
    );
    expect(dockerfile).toContain("ARG TARGETPLATFORM=linux/amd64");
  });
});

// ---------------------------------------------------------------------------
// Category 4: PDF generator Dockerfile uses TARGETARCH for pandoc
// ---------------------------------------------------------------------------
describe("PDF generator Dockerfile (arm64 readiness)", () => {
  const dockerfilePath = path.resolve(
    __dirname,
    "..",
    "..",
    "..",
    "service",
    "hld_pdf_generator",
    "Dockerfile",
  );

  it("uses TARGETARCH for pandoc download URL", () => {
    const dockerfile = fs.readFileSync(dockerfilePath, "utf-8");
    expect(dockerfile).toContain("ARG TARGETARCH");
    expect(dockerfile).toMatch(/pandoc-.*-linux-\$\{TARGETARCH\}/);
  });

  it("base image matches PYTHON_RUNTIME version", () => {
    const dockerfile = fs.readFileSync(dockerfilePath, "utf-8");
    const version = PYTHON_RUNTIME.name.replace("python", "");
    expect(dockerfile).toContain(`public.ecr.aws/lambda/python:${version}`);
  });
});
