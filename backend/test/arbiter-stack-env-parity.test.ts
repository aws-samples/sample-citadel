import * as cdk from "aws-cdk-lib";
import { Template } from "aws-cdk-lib/assertions";
import * as dynamodb from "aws-cdk-lib/aws-dynamodb";
import * as events from "aws-cdk-lib/aws-events";
import * as lambda from "aws-cdk-lib/aws-lambda";
import * as appsync from "aws-cdk-lib/aws-appsync";
import { Bucket } from "aws-cdk-lib/aws-s3";
import * as fs from "fs";
import * as path from "path";
import {
  scaffoldBackendAssetDirs,
  scaffoldArbiterStubs,
} from "./helpers/scaffold-stub-assets";

scaffoldBackendAssetDirs(["dist/lambda", "src/schema"]);
scaffoldArbiterStubs();

import { ArbiterStack } from "../lib/arbiter-stack";

const ARBITER_ROOT = path.resolve(__dirname, "../../arbiter");

/**
 * GENERIC env-var parity guard.
 *
 * Contract: every environment variable a Lambda handler READS from its own
 * runtime (os.environ[...] / os.environ.get(...) / os.getenv(...)) — across its
 * entry package AND the specific shared-layer seam modules it executes — must
 * be PROVIDED on the corresponding synthesized CDK function, unless it is on a
 * documented allowlist of genuinely-optional / ambient / subprocess-injected
 * vars.
 *
 * This is the class of defect behind Bug C: the worker's governed-tool path
 * reads GOVERNANCE_LEDGER_TABLE (in the layer module arbiter/governance/
 * ledger.py) to write its write-once legibility record, but the WorkerAgentWrapper
 * function env never set it — so every governed tool call failed closed
 * ("cannot produce legibility record"). A FakeTable / unit test cannot see a
 * missing *deployment* env var; only a synth-vs-source parity check does.
 *
 * Scoping (deliberate, documented): we scan each function's entry directory
 * plus ONLY the layer seam modules that function actually runs — not the whole
 * shared layer — so unrelated layer modules (e.g. governance/engine.py,
 * d4_retrospective.py) don't over-attribute their env reads to a function that
 * never executes them.
 */

const ENV_READ_PATTERNS = [
  /os\.environ\.get\(\s*['"]([A-Z0-9_]+)['"]/g,
  /os\.getenv\(\s*['"]([A-Z0-9_]+)['"]/g,
  /os\.environ\[\s*['"]([A-Z0-9_]+)['"]\s*\]/g,
];

function pyFilesUnder(target: string): string[] {
  const abs = path.join(ARBITER_ROOT, target);
  const stat = fs.statSync(abs);
  if (stat.isFile()) return [abs];
  const out: string[] = [];
  const walk = (dir: string) => {
    for (const entry of fs.readdirSync(dir, { withFileTypes: true })) {
      const p = path.join(dir, entry.name);
      if (entry.isDirectory()) {
        // Skip test + cache dirs — we want production runtime reads only.
        if (entry.name === "__tests__" || entry.name === "__pycache__")
          continue;
        walk(p);
      } else if (entry.name.endsWith(".py")) {
        out.push(p);
      }
    }
  };
  walk(abs);
  return out;
}

function envVarsRead(targets: string[]): Set<string> {
  const names = new Set<string>();
  for (const t of targets) {
    for (const file of pyFilesUnder(t)) {
      const src = fs.readFileSync(file, "utf8");
      for (const re of ENV_READ_PATTERNS) {
        for (const m of src.matchAll(re)) names.add(m[1]);
      }
    }
  }
  return names;
}

function functionEnvKeys(
  template: Template,
  logicalIdPrefix: string,
): Set<string> {
  const fns = template.findResources("AWS::Lambda::Function");
  const match = Object.entries(fns).find(([id]) =>
    id.startsWith(logicalIdPrefix),
  );
  if (!match) {
    throw new Error(
      `no synthesized function with logical id prefix ${logicalIdPrefix}`,
    );
  }
  const vars = (match[1] as any).Properties?.Environment?.Variables ?? {};
  return new Set(Object.keys(vars));
}

/**
 * Allowlist of env vars a handler may read WITHOUT the CDK function setting
 * them, each with a documented reason. Split into a shared set (ambient /
 * Lambda-runtime / subprocess-injected) and per-function optional/feature-gated
 * sets. Anything read but not here AND not set on the function fails the test.
 */
const AMBIENT_OR_SUBPROCESS = new Set<string>([
  // Lambda runtime / ambient credentials + tracing — injected by the platform.
  "AWS_ACCESS_KEY_ID",
  "AWS_SECRET_ACCESS_KEY",
  "AWS_REGION",
  "PATH",
  "_X_AMZN_TRACE_ID",
  // Per-invocation dispatch context the worker sets on the agent SUBPROCESS's
  // env at launch (never a CDK function env var): see workerWrapper subprocess
  // launch. All CITADEL_* + MODEL_OVERRIDE are in this class.
  "CITADEL_AGENT_ID",
  "CITADEL_DISPATCH_GENERATION",
  "CITADEL_EVAL_RUN_ID",
  "CITADEL_EXECUTION_ID",
  "CITADEL_NODE_ID",
  "CITADEL_ORG_ID",
  "CITADEL_WORKFLOW_ID",
  "CITADEL_WORKFLOW_DEFINITION_ID",
  "MODEL_OVERRIDE",
]);

interface Target {
  name: string;
  logicalIdPrefix: string;
  // Entry package + the specific layer seam modules this function executes.
  sources: string[];
  // Function-specific optional / feature-gated / tunable vars (read defensively
  // via .get() with a fallback/skip), documented per entry.
  optional: Set<string>;
}

const TARGETS: Target[] = [
  {
    name: "WorkerAgentWrapper",
    logicalIdPrefix: "WorkerAgentWrapper",
    sources: [
      "workerWrapper",
      // Governed-tool legibility seam (write-once ledger) — GOVERNANCE_LEDGER_TABLE
      // lives here, NOT in workerWrapper/. This is the Bug C seam.
      "governance/ledger.py",
      // Tool-idempotency ledger the worker reserves/finalizes against.
      "governance/tool_execution_ledger.py",
    ],
    optional: new Set<string>([
      // Feature-gated / defensive reads (os.environ.get(...) with None/default,
      // never fail-closed for the core path):
      "TOOLS_CONFIG_TABLE", // dynamic-tools config; None-guarded, feature-gated
      "DENIED_TOOLS", // optional deny list; '' default
      "EVENT_BUS_NAME", // legacy alias; the worker emits on COMPLETION_BUS_NAME (which IS set)
      "RELEASE_DEFAULT_ORG_ID", // release-attribution seam; only set in release-enabled envs
      "WORKER_MAX_PROMPT_ADDITION_CHARS", // size cap tunable; has a default
      // tool-execution-ledger tunables — all have defaults (_int_env/_float_env):
      "TOOL_LEDGER_TTL_SECONDS",
      "TOOL_RESULT_MAX_INLINE_BYTES",
      "TOOL_LEDGER_LEASE_SECONDS",
      "TOOL_LEDGER_POLL_TIMEOUT_SECONDS",
      "TOOL_LEDGER_POLL_INTERVAL_SECONDS",
      // governance ledger correlation id — best-effort, absent-tolerant:
      "ENVIRONMENT",
    ]),
  },
  {
    name: "StepRunnerFunction",
    logicalIdPrefix: "StepRunnerFunction",
    sources: ["stepRunner"],
    optional: new Set<string>([
      "REGISTRY_ENABLED", // registry feature gate; default off
      "REGISTRY_ID", // only read when REGISTRY_ENABLED
      "WORKFLOW_TIMEOUT_SECONDS", // watchdog tunable; has a default
      "RELEASE_DEFAULT_ORG_ID", // release-attribution seam; feature-gated env
      "RELEASE_DISPATCH_ENVIRONMENT", // release-dispatch feature switch; feature-gated env
    ]),
  },
];

describe("ArbiterStack — handler env-var parity (deployment contract)", () => {
  let template: Template;

  beforeAll(() => {
    const app = new cdk.App({ context: { "aws:cdk:bundling-stacks": [] } });
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
    template = Template.fromStack(stack);
  });

  for (const target of TARGETS) {
    test(`${target.name}: every required env var it reads is set on the function`, () => {
      const read = envVarsRead(target.sources);
      const provided = functionEnvKeys(template, target.logicalIdPrefix);

      const missing: string[] = [];
      for (const name of read) {
        if (AMBIENT_OR_SUBPROCESS.has(name)) continue;
        if (target.optional.has(name)) continue;
        if (!provided.has(name)) missing.push(name);
      }
      expect({ fn: target.name, missing: missing.sort() }).toEqual({
        fn: target.name,
        missing: [],
      });
    });
  }

  test("GOVERNANCE_LEDGER_TABLE is wired on the worker (Bug C regression guard)", () => {
    // The specific var behind Bug C — pinned so a future edit that drops it
    // fails loudly even if the generic scan is later rescoped.
    const provided = functionEnvKeys(template, "WorkerAgentWrapper");
    expect(provided.has("GOVERNANCE_LEDGER_TABLE")).toBe(true);
  });
});
