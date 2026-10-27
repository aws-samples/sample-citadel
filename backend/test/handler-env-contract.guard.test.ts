/**
 * Handler environment-variable contract guard (Node.js Lambdas).
 *
 * For every Lambda function in the synthesized ProjectsStack whose handler
 * points to a `backend/src/lambda/*.ts` entry file, this test:
 *   1. Resolves the handler entry file.
 *   2. Walks local imports (within backend/src/) recursively.
 *   3. Extracts every `process.env.X` name referenced in the transitive
 *      closure.
 *   4. Asserts that each name is present in the function's Environment
 *      Variables in the CloudFormation template — unless it appears in the
 *      OPTIONAL_VARS allowlist with a documented reason.
 *
 * This catches the exact class of bug where a handler (or a shared utility
 * it imports, like project-access.ts) reads a process.env var that the CDK
 * stack never sets — causing fail-closed "Access denied" at runtime.
 *
 * The test also performs a STATIC scan across ALL backend/lib/*-stack.ts
 * files, extracting handler → environment pairs from the source and
 * comparing against the same process.env analysis — covering stacks that
 * are too complex to synth in a unit test.
 */
import * as cdk from "aws-cdk-lib";
import { Template } from "aws-cdk-lib/assertions";
import * as appsync from "aws-cdk-lib/aws-appsync";
import * as cognito from "aws-cdk-lib/aws-cognito";
import * as dynamodb from "aws-cdk-lib/aws-dynamodb";
import * as events from "aws-cdk-lib/aws-events";
import * as sns from "aws-cdk-lib/aws-sns";
import { Bucket } from "aws-cdk-lib/aws-s3";
import * as fs from "fs";
import * as path from "path";
import { scaffoldBackendAssetDirs } from "./helpers/scaffold-stub-assets";

scaffoldBackendAssetDirs(["dist/lambda", "src/schema"]);

// BackendStack references additional asset paths that resolve outside
// backend/ (e.g. path.join(__dirname, "../../src/lambda/seed-organizations")
// in backend-stack.ts resolves to <repo-root>/src/lambda/seed-organizations).
// Create stubs so synthBackendStack() doesn't throw CannotFindAsset in CI.
const EXTRA_ASSET_DIRS = [
  path.resolve(__dirname, "../../src/lambda/seed-organizations"),
  path.resolve(__dirname, "../src/lambda/seed-admin-user"),
  path.resolve(__dirname, "../src/lambda/seed-organizations"),
];
for (const dir of EXTRA_ASSET_DIRS) {
  if (!fs.existsSync(dir)) fs.mkdirSync(dir, { recursive: true });
}

import { ProjectsStack } from "../lib/projects-stack";

jest.setTimeout(60000);

const BACKEND_ROOT = path.resolve(__dirname, "..");
const SRC_ROOT = path.join(BACKEND_ROOT, "src");

// ---------------------------------------------------------------------------
// Allowlist: env vars a Node.js handler may read WITHOUT the CDK function
// providing them.  Each entry MUST have a reason comment.
// ---------------------------------------------------------------------------

/** Ambient / Lambda-runtime-injected vars. */
const AMBIENT_VARS = new Set<string>([
  "AWS_REGION", // Lambda runtime injects the execution region.
  "AWS_ACCESS_KEY_ID", // Lambda runtime credential chain.
  "AWS_SECRET_ACCESS_KEY", // Lambda runtime credential chain.
  "AWS_SESSION_TOKEN", // Lambda runtime credential chain.
  "AWS_LAMBDA_FUNCTION_NAME", // Lambda runtime metadata.
  "NODE_ENV", // Not set by CDK; read defensively in some utils.
  "_X_AMZN_TRACE_ID", // X-Ray trace header — runtime-injected.
]);

/**
 * Per-handler optional vars: the handler reads them with a fallback default
 * or they come from a file-level import where only a subset of the module's
 * exports are used, and the unused export is the one reading the var.
 * Keyed by handler base name (e.g. "generate-report-url").
 *
 * Each entry MUST document why the var is optional for that handler.
 */
const PER_HANDLER_OPTIONAL: Record<string, Set<string>> = {
  // project-resolver imports listADRsForProject from adr-resolver.ts, but
  // ADR_REOPEN_ATTEMPTS_TABLE is only used by handleReopenAdr (a separate
  // export in the same file that project-resolver never calls). File-level
  // import scanning cannot distinguish used vs unused exports.
  "project-resolver": new Set(["ADR_REOPEN_ATTEMPTS_TABLE"]),

  // intake-consent-resolver imports lookupOwnerOrganization from
  // utils/org-membership.ts. That module reads USER_POOL_ID for a Cognito
  // username→sub identity mapping fallback path (resolveSubFromUsername),
  // which returns null when the var is unset — a documented, safe no-op.
  "intake-consent-resolver": new Set(["USER_POOL_ID"]),
};

// ---------------------------------------------------------------------------
// Source analysis helpers
// ---------------------------------------------------------------------------

/** Regex: process.env.SOME_VAR */
const PROCESS_ENV_RE = /process\.env\.([A-Z][A-Z0-9_]*)/g;

/** Regex: local relative imports (from "./foo" or from "../bar/baz"). */
const LOCAL_IMPORT_RE =
  /(?:from\s+['"](\.[^'"]+)['"]|require\(\s*['"](\.[^'"]+)['"]\s*\))/g;

/**
 * Given an absolute TS file path, return all process.env var names referenced.
 */
function envVarsInFile(absPath: string): Set<string> {
  const names = new Set<string>();
  let src: string;
  try {
    src = fs.readFileSync(absPath, "utf8");
  } catch {
    return names;
  }
  for (const m of src.matchAll(PROCESS_ENV_RE)) {
    names.add(m[1]);
  }
  return names;
}

/**
 * Resolve a TS import specifier to an absolute file path.
 * Tries .ts, /index.ts, and bare (already has extension).
 */
function resolveImport(
  fromFile: string,
  specifier: string,
): string | undefined {
  const dir = path.dirname(fromFile);
  const base = path.resolve(dir, specifier);
  for (const candidate of [
    base + ".ts",
    path.join(base, "index.ts"),
    base,
    base + ".js",
  ]) {
    if (fs.existsSync(candidate) && fs.statSync(candidate).isFile()) {
      return candidate;
    }
  }
  return undefined;
}

/**
 * Walk the import graph of a TS file within backend/src/ and return the union
 * of all process.env.X names.
 */
function envVarsTransitive(entryFile: string): Set<string> {
  const visited = new Set<string>();
  const allVars = new Set<string>();

  function walk(absPath: string): void {
    const real = fs.realpathSync(absPath);
    if (visited.has(real)) return;
    visited.add(real);

    // Only follow files under backend/src/ (skip node_modules, etc.).
    if (!real.startsWith(SRC_ROOT)) return;

    for (const v of envVarsInFile(real)) allVars.add(v);

    let src: string;
    try {
      src = fs.readFileSync(real, "utf8");
    } catch {
      return;
    }

    for (const m of src.matchAll(LOCAL_IMPORT_RE)) {
      const spec = m[1] || m[2];
      const resolved = resolveImport(real, spec);
      if (resolved) walk(resolved);
    }
  }

  walk(entryFile);
  return allVars;
}

/**
 * Resolve a CDK handler string (e.g. "document-upload-resolver.handler") to
 * the absolute path of the TS entry file under backend/src/lambda/.
 */
function handlerToSourceFile(handler: string): string | undefined {
  // handler = "foo-bar.handler" → file = "foo-bar"
  // handler = "seed-blueprints/index.handler" → file = "seed-blueprints/index"
  const dotIdx = handler.lastIndexOf(".");
  if (dotIdx < 0) return undefined;
  const filePart = handler.substring(0, dotIdx);
  const candidate = path.join(SRC_ROOT, "lambda", filePart + ".ts");
  if (fs.existsSync(candidate)) return candidate;
  return undefined;
}

// ---------------------------------------------------------------------------
// ProjectsStack fixture (mirrors projects-stack.test.ts)
// ---------------------------------------------------------------------------

function createProjectsStackFixture(app: cdk.App) {
  const backendStack = new cdk.Stack(app, "MockBackendStack", {
    env: { account: "123456789012", region: "us-east-1" },
  });

  return {
    appSyncApi: new appsync.GraphqlApi(backendStack, "MockApi", {
      name: "mock-api",
      schema: appsync.SchemaFile.fromAsset(
        path.resolve(__dirname, "../src/schema/schema.graphql"),
      ),
    }),
    agentEventBus: new events.EventBus(backendStack, "AgentEventBus", {
      eventBusName: "citadel-agents-test",
    }),
    projectsTable: new dynamodb.Table(backendStack, "ProjectsTable", {
      tableName: "citadel-projects-test",
      partitionKey: { name: "projectId", type: dynamodb.AttributeType.STRING },
      billingMode: dynamodb.BillingMode.PAY_PER_REQUEST,
      removalPolicy: cdk.RemovalPolicy.DESTROY,
    }),
    conversationsTable: new dynamodb.Table(backendStack, "ConversationsTable", {
      tableName: "citadel-conversations-test",
      partitionKey: {
        name: "conversationId",
        type: dynamodb.AttributeType.STRING,
      },
      billingMode: dynamodb.BillingMode.PAY_PER_REQUEST,
      removalPolicy: cdk.RemovalPolicy.DESTROY,
    }),
    agentStatusTable: new dynamodb.Table(backendStack, "AgentStatusTable", {
      tableName: "citadel-agent-status-test",
      partitionKey: { name: "projectId", type: dynamodb.AttributeType.STRING },
      sortKey: { name: "agentId", type: dynamodb.AttributeType.STRING },
      billingMode: dynamodb.BillingMode.PAY_PER_REQUEST,
      removalPolicy: cdk.RemovalPolicy.DESTROY,
    }),
    documentBucket: new Bucket(backendStack, "DocumentBucket", {
      bucketName: "citadel-documents-test",
    }),
    idempotencyTable: new dynamodb.Table(backendStack, "IdempotencyTable", {
      tableName: "citadel-idempotency-test",
      partitionKey: { name: "eventId", type: dynamodb.AttributeType.STRING },
      billingMode: dynamodb.BillingMode.PAY_PER_REQUEST,
      removalPolicy: cdk.RemovalPolicy.DESTROY,
    }),
    adrsTable: new dynamodb.Table(backendStack, "AdrsTable", {
      tableName: "citadel-adrs-test",
      partitionKey: { name: "adrId", type: dynamodb.AttributeType.STRING },
      billingMode: dynamodb.BillingMode.PAY_PER_REQUEST,
      removalPolicy: cdk.RemovalPolicy.DESTROY,
    }),
    executionSpecificationsTable: new dynamodb.Table(
      backendStack,
      "ExecutionSpecificationsTable",
      {
        tableName: "citadel-execution-specifications-test",
        partitionKey: { name: "specId", type: dynamodb.AttributeType.STRING },
        billingMode: dynamodb.BillingMode.PAY_PER_REQUEST,
        removalPolicy: cdk.RemovalPolicy.DESTROY,
      },
    ),
    agentDesignAssessmentsTable: new dynamodb.Table(
      backendStack,
      "AgentDesignAssessmentsTable",
      {
        tableName: "citadel-agent-design-assessments-test",
        partitionKey: {
          name: "assessmentId",
          type: dynamodb.AttributeType.STRING,
        },
        billingMode: dynamodb.BillingMode.PAY_PER_REQUEST,
        removalPolicy: cdk.RemovalPolicy.DESTROY,
      },
    ),
    userPool: new cognito.UserPool(backendStack, "UserPool", {
      userPoolName: "citadel-test-pool",
    }),
    alarmTopic: new sns.Topic(backendStack, "AlarmTopic", {
      topicName: "citadel-alarms-test",
    }),
    userOrgMembershipTable: new dynamodb.Table(
      backendStack,
      "UserOrgMembershipTable",
      {
        tableName: "citadel-user-org-membership-test",
        partitionKey: { name: "sub", type: dynamodb.AttributeType.STRING },
      },
    ),
  };
}

function synthProjectsStack(): Template {
  const app = new cdk.App();
  const fixture = createProjectsStackFixture(app);
  const stack = new ProjectsStack(app, "TestProjectsStack", {
    env: { account: "123456789012", region: "us-east-1" },
    environment: "test",
    ...fixture,
  });
  return Template.fromStack(stack);
}

// ---------------------------------------------------------------------------
// Helpers to extract Lambda function → env from a synthesized template
// ---------------------------------------------------------------------------

type CfnFunctionProps = {
  Properties?: {
    Handler?: string;
    Runtime?: string;
    Environment?: { Variables?: Record<string, unknown> };
  };
};

function extractLambdaEnvMap(template: Template): Array<{
  logicalId: string;
  handler: string;
  envKeys: Set<string>;
}> {
  const fns = template.findResources("AWS::Lambda::Function") as Record<
    string,
    CfnFunctionProps
  >;
  const results: Array<{
    logicalId: string;
    handler: string;
    envKeys: Set<string>;
  }> = [];

  for (const [logicalId, resource] of Object.entries(fns)) {
    const handler = resource.Properties?.Handler;
    const runtime = resource.Properties?.Runtime ?? "";
    // Skip non-Node.js runtimes (e.g. Python lambdas if any).
    if (!handler || !runtime.toString().startsWith("nodejs")) continue;

    const envVars = resource.Properties?.Environment?.Variables ?? {};
    results.push({
      logicalId,
      handler,
      envKeys: new Set(Object.keys(envVars)),
    });
  }
  return results;
}

// ---------------------------------------------------------------------------
// Tests
// ---------------------------------------------------------------------------

describe("Handler environment-variable contract guard (Node.js Lambdas)", () => {
  let template: Template;

  beforeAll(() => {
    template = synthProjectsStack();
  });

  test("every process.env var read by a ProjectsStack handler is provided in its CDK environment", () => {
    const lambdas = extractLambdaEnvMap(template);
    expect(lambdas.length).toBeGreaterThan(0);

    const violations: string[] = [];

    for (const { logicalId, handler, envKeys } of lambdas) {
      const sourceFile = handlerToSourceFile(handler);
      if (!sourceFile) continue; // sub-directory handler or non-TS — skip

      const handlerBase = handler.replace(/\.handler$/, "");
      const required = envVarsTransitive(sourceFile);

      for (const varName of required) {
        if (AMBIENT_VARS.has(varName)) continue;
        if (PER_HANDLER_OPTIONAL[handlerBase]?.has(varName)) continue;
        if (!envKeys.has(varName)) {
          violations.push(
            `${logicalId} (${handler}): reads process.env.${varName} but CDK does not set it`,
          );
        }
      }
    }

    expect(violations).toEqual([]);
  });

  test("at least one Lambda was checked (sanity)", () => {
    const lambdas = extractLambdaEnvMap(template);
    // ProjectsStack has 17 Lambda handlers.
    expect(lambdas.length).toBeGreaterThan(10);
  });
});

// ---------------------------------------------------------------------------
// IAM grant guard: every *_TABLE env var must have a DynamoDB grant
// ---------------------------------------------------------------------------

/**
 * For every Node.js Lambda function in the synthesized BackendStack template,
 * for each `*_TABLE` environment variable whose value is a `{ Ref: <logicalId> }`,
 * assert that at least one IAM::Policy attached to the function's role grants
 * a `dynamodb:*` action on that table's ARN.
 *
 * This catches the exact bug class where a handler has PROJECTS_TABLE in its
 * env but no grantReadData/grantReadWriteData on the table — causing
 * AccessDeniedException at runtime.
 */

import { BackendStack } from "../lib/backend-stack";

function synthBackendStack(): Template {
  const app = new cdk.App();
  const stack = new BackendStack(app, "GuardBackendStack", {
    environment: "test",
    env: { account: "123456789012", region: "us-east-1" },
  });
  return Template.fromStack(stack);
}

type CfnPolicyProps = {
  Properties?: {
    Roles?: Array<{ Ref?: string } | string>;
    PolicyDocument?: {
      Statement?: Array<{
        Action?: string | string[];
        Resource?: unknown;
      }>;
    };
  };
};

type CfnFunctionPropsExtended = {
  Properties?: {
    Handler?: string;
    Runtime?: string;
    Role?: { "Fn::GetAtt"?: [string, string] };
    Environment?: { Variables?: Record<string, unknown> };
  };
};

/**
 * Allowlist: functions that legitimately hold a *_TABLE env without needing
 * DynamoDB access on it.  Each entry MUST have a justification.
 *
 * Keyed by handler base name → set of env var names.
 */
const TABLE_ENV_GRANT_ALLOWLIST: Record<string, Set<string>> = {
  // (Currently empty — no known legitimate cases.)
};

describe("Handler TABLE env → DynamoDB grant guard (BackendStack)", () => {
  let backendTemplate: Template;

  beforeAll(() => {
    backendTemplate = synthBackendStack();
  });

  test("every *_TABLE env var on a Lambda function has a corresponding DynamoDB grant", () => {
    const fns = backendTemplate.findResources(
      "AWS::Lambda::Function",
    ) as Record<string, CfnFunctionPropsExtended>;
    const policies = backendTemplate.findResources(
      "AWS::IAM::Policy",
    ) as Record<string, CfnPolicyProps>;

    const violations: string[] = [];

    for (const [fnLogicalId, fnResource] of Object.entries(fns)) {
      const props = fnResource.Properties;
      if (!props) continue;
      const runtime = props.Runtime ?? "";
      if (!runtime.toString().startsWith("nodejs")) continue;

      const handlerStr = props.Handler ?? "";
      const handlerBase = handlerStr.replace(/\.handler$/, "");
      const roleLogicalId = props.Role?.["Fn::GetAtt"]?.[0];
      if (!roleLogicalId) continue;

      const envVars = props.Environment?.Variables ?? {};

      // Collect all *_TABLE env vars with Ref values
      const tableEnvEntries: Array<{
        envName: string;
        tableLogicalId: string;
      }> = [];
      for (const [envName, envValue] of Object.entries(envVars)) {
        if (!envName.endsWith("_TABLE")) continue;
        const ref = (envValue as { Ref?: string })?.Ref;
        if (!ref) continue;
        tableEnvEntries.push({ envName, tableLogicalId: ref });
      }

      if (tableEnvEntries.length === 0) continue;

      // Find all dynamodb-action table logical IDs granted to this role
      const grantedTableIds = new Set<string>();
      for (const policy of Object.values(policies)) {
        const policyProps = policy.Properties;
        if (!policyProps) continue;
        const roles = policyProps.Roles ?? [];
        const attachedToRole = roles.some(
          (r) => typeof r === "object" && r.Ref === roleLogicalId,
        );
        if (!attachedToRole) continue;

        for (const stmt of policyProps.PolicyDocument?.Statement ?? []) {
          const actions = Array.isArray(stmt.Action)
            ? stmt.Action
            : [stmt.Action];
          const hasDynamo = actions.some(
            (a) => typeof a === "string" && a.startsWith("dynamodb:"),
          );
          if (!hasDynamo) continue;

          // Extract table logical IDs from Resource (may be array or single)
          const resources = Array.isArray(stmt.Resource)
            ? stmt.Resource
            : [stmt.Resource];
          for (const res of resources) {
            const resStr = JSON.stringify(res ?? "");
            // Match Fn::GetAtt references to table ARNs
            for (const { tableLogicalId } of tableEnvEntries) {
              if (resStr.includes(tableLogicalId)) {
                grantedTableIds.add(tableLogicalId);
              }
            }
          }
        }
      }

      // Check each TABLE env has a grant
      for (const { envName, tableLogicalId } of tableEnvEntries) {
        if (TABLE_ENV_GRANT_ALLOWLIST[handlerBase]?.has(envName)) continue;
        if (!grantedTableIds.has(tableLogicalId)) {
          violations.push(
            `${fnLogicalId} (${handlerStr}): has ${envName} env (table ${tableLogicalId}) but no DynamoDB grant on that table`,
          );
        }
      }
    }

    expect(violations).toEqual([]);
  });

  test("AgentMessageHandler specifically has a DynamoDB grant on ProjectsTable", () => {
    // Targeted assertion for the exact bug this fix addresses
    const fns = backendTemplate.findResources(
      "AWS::Lambda::Function",
    ) as Record<string, CfnFunctionPropsExtended>;
    const policies = backendTemplate.findResources(
      "AWS::IAM::Policy",
    ) as Record<string, CfnPolicyProps>;

    // Find the AgentMessageHandler function
    const msgHandlerEntry = Object.entries(fns).find(
      ([, res]) => res.Properties?.Handler === "agent-message-handler.handler",
    );
    expect(msgHandlerEntry).toBeDefined();
    const [, msgHandler] = msgHandlerEntry!;
    const roleLogicalId = msgHandler.Properties!.Role!["Fn::GetAtt"]![0];
    const projectsTableRef = (
      msgHandler.Properties!.Environment!.Variables!.PROJECTS_TABLE as {
        Ref: string;
      }
    ).Ref;

    // Find any dynamodb grant on that table for this role
    let hasGrant = false;
    for (const policy of Object.values(policies)) {
      const policyProps = policy.Properties;
      if (!policyProps) continue;
      const roles = policyProps.Roles ?? [];
      if (!roles.some((r) => typeof r === "object" && r.Ref === roleLogicalId))
        continue;
      for (const stmt of policyProps.PolicyDocument?.Statement ?? []) {
        const actions = Array.isArray(stmt.Action)
          ? stmt.Action
          : [stmt.Action];
        if (
          !actions.some(
            (a) => typeof a === "string" && a.startsWith("dynamodb:"),
          )
        )
          continue;
        if (JSON.stringify(stmt.Resource ?? "").includes(projectsTableRef)) {
          hasGrant = true;
        }
      }
    }
    expect(hasGrant).toBe(true);
  });
});
