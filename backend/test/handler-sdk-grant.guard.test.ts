/**
 * Handler SDK → IAM grant guard (BackendStack).
 *
 * For every Node.js Lambda in the synthesized BackendStack template, this test:
 *   1. Resolves the handler's source entry file.
 *   2. Walks local imports (within backend/src/) transitively.
 *   3. For each DynamoDB SDK command (`new XxxCommand({...})`), scans forward
 *      up to 15 lines for a `TableName: <varName>` property. If found, maps
 *      the const name back to the process.env.*_TABLE env var it was assigned
 *      from, associating that command with a specific table.
 *   4. Maps each command to its IAM action (dynamodb:GetItem, dynamodb:PutItem, …).
 *   5. Asserts the function's role policy grants at least every required action
 *      on the table the command targets.
 *
 * This catches the exact deploy failure where a handler uses GetCommand on a
 * table but the CDK stack only calls grantWriteData (missing dynamodb:GetItem).
 */

import * as cdk from "aws-cdk-lib";
import { Template } from "aws-cdk-lib/assertions";
import * as fs from "fs";
import * as path from "path";
import { scaffoldBackendAssetDirs } from "./helpers/scaffold-stub-assets";

scaffoldBackendAssetDirs(["dist/lambda", "src/schema"]);

// BackendStack references asset paths that may not exist in CI.
const EXTRA_ASSET_DIRS = [
  path.resolve(__dirname, "../../src/lambda/seed-organizations"),
  path.resolve(__dirname, "../src/lambda/seed-admin-user"),
  path.resolve(__dirname, "../src/lambda/seed-organizations"),
];
for (const dir of EXTRA_ASSET_DIRS) {
  if (!fs.existsSync(dir)) fs.mkdirSync(dir, { recursive: true });
}

import { BackendStack } from "../lib/backend-stack";

jest.setTimeout(60000);

const SRC_ROOT = path.resolve(__dirname, "..", "src");

// ---------------------------------------------------------------------------
// SDK Command → IAM action mapping
// ---------------------------------------------------------------------------

const COMMAND_TO_ACTION: Record<string, string> = {
  GetCommand: "dynamodb:GetItem",
  QueryCommand: "dynamodb:Query",
  ScanCommand: "dynamodb:Scan",
  PutCommand: "dynamodb:PutItem",
  UpdateCommand: "dynamodb:UpdateItem",
  DeleteCommand: "dynamodb:DeleteItem",
  BatchWriteCommand: "dynamodb:BatchWriteItem",
  BatchGetCommand: "dynamodb:BatchGetItem",
  TransactWriteCommand: "dynamodb:TransactWriteItems",
};

const COMMAND_NAMES = Object.keys(COMMAND_TO_ACTION);

// ---------------------------------------------------------------------------
// Source analysis helpers
// ---------------------------------------------------------------------------

const LOCAL_IMPORT_RE =
  /(?:from\s+['"](\.[^'"]+)['"]|require\(\s*['"](\.[^'"]+)['"]\s*\))/g;

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

/** Result of analysing one handler's transitive import closure. */
interface HandlerAnalysis {
  /**
   * Per-table associations: env var name → set of SDK command names that
   * target that table (via `TableName: constName` proximity analysis).
   */
  tableToCommands: Map<string, Set<string>>;
}

/**
 * Walk the import graph of a TS handler file and determine which DynamoDB
 * SDK commands target which table env vars.
 *
 * Strategy:
 *   1. In each source file, collect `const X = process.env.Y_TABLE!`
 *      assignments to build a constName→envVarName map.
 *   2. For each `new XxxCommand(` occurrence, scan forward ≤15 lines for
 *      `TableName: <ident>`. If the ident resolves (via the const map) to a
 *      known *_TABLE env var, associate the command with that env var.
 *   3. Commands without a resolvable TableName are unassociated and ignored
 *      (they belong to tables outside this function's env, e.g. in a utility
 *      module shared across handlers).
 */
function analyzeHandler(entryFile: string): HandlerAnalysis {
  const visited = new Set<string>();
  // constName → env var name (e.g. "EVAL_SUITES_TABLE" → "EVAL_SUITES_TABLE",
  // or local alias like "suitesTable" → "EVAL_SUITES_TABLE").
  const constToEnvVar = new Map<string, string>();
  // env var name → set of command names that target it
  const tableToCommands = new Map<string, Set<string>>();

  const TABLE_CONST_RE =
    /(?:const|let|var)\s+([a-zA-Z_][a-zA-Z0-9_]*)\s*=\s*process\.env\.([A-Z][A-Z0-9_]*_TABLE)\b/g;

  function walk(absPath: string): void {
    const real = fs.realpathSync(absPath);
    if (visited.has(real)) return;
    visited.add(real);
    if (!real.startsWith(SRC_ROOT)) return;

    let src: string;
    try {
      src = fs.readFileSync(real, "utf8");
    } catch {
      return;
    }

    // Collect const→env mappings.
    for (const m of src.matchAll(TABLE_CONST_RE)) {
      constToEnvVar.set(m[1], m[2]);
      // Also map the env var name to itself (for direct process.env.X usage).
      constToEnvVar.set(m[2], m[2]);
    }

    // Scan for command→table associations.
    const lines = src.split("\n");
    for (let i = 0; i < lines.length; i++) {
      for (const cmdName of COMMAND_NAMES) {
        if (!lines[i].includes(`new ${cmdName}`)) continue;

        // Scan forward for TableName.
        for (let j = i; j < Math.min(i + 15, lines.length); j++) {
          const tableMatch = /TableName:\s*([a-zA-Z_][a-zA-Z0-9_]*)/.exec(
            lines[j],
          );
          if (tableMatch) {
            const constName = tableMatch[1];
            const envVar = constToEnvVar.get(constName);
            if (envVar) {
              if (!tableToCommands.has(envVar)) {
                tableToCommands.set(envVar, new Set());
              }
              tableToCommands.get(envVar)!.add(cmdName);
            }
            break;
          }
        }
      }
    }

    for (const m of src.matchAll(LOCAL_IMPORT_RE)) {
      const spec = m[1] || m[2];
      const resolved = resolveImport(real, spec);
      if (resolved) walk(resolved);
    }
  }

  walk(entryFile);
  return { tableToCommands };
}

function handlerToSourceFile(handler: string): string | undefined {
  const dotIdx = handler.lastIndexOf(".");
  if (dotIdx < 0) return undefined;
  const filePart = handler.substring(0, dotIdx);
  const candidate = path.join(SRC_ROOT, "lambda", filePart + ".ts");
  if (fs.existsSync(candidate)) return candidate;
  return undefined;
}

// ---------------------------------------------------------------------------
// CloudFormation template helpers
// ---------------------------------------------------------------------------

type CfnFunctionProps = {
  Properties?: {
    Handler?: string;
    Runtime?: string;
    Role?: { "Fn::GetAtt"?: [string, string] };
    Environment?: { Variables?: Record<string, unknown> };
  };
};

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

function collectDynamoGrants(
  policies: Record<string, CfnPolicyProps>,
  roleLogicalId: string,
  tableLogicalIds: string[],
): Map<string, Set<string>> {
  const result = new Map<string, Set<string>>();
  for (const tid of tableLogicalIds) {
    result.set(tid, new Set());
  }

  for (const policy of Object.values(policies)) {
    const policyProps = policy.Properties;
    if (!policyProps) continue;
    const roles = policyProps.Roles ?? [];
    const attached = roles.some(
      (r) => typeof r === "object" && r.Ref === roleLogicalId,
    );
    if (!attached) continue;

    for (const stmt of policyProps.PolicyDocument?.Statement ?? []) {
      const actions = Array.isArray(stmt.Action) ? stmt.Action : [stmt.Action];
      const dynamoActions = actions.filter(
        (a) => typeof a === "string" && a.startsWith("dynamodb:"),
      );
      if (dynamoActions.length === 0) continue;

      const resStr = JSON.stringify(stmt.Resource ?? "");
      for (const tid of tableLogicalIds) {
        if (resStr.includes(tid)) {
          for (const a of dynamoActions) {
            result.get(tid)!.add(a as string);
          }
        }
      }
    }
  }
  return result;
}

// ---------------------------------------------------------------------------
// Test suite
// ---------------------------------------------------------------------------

function synthBackendStack(): Template {
  const app = new cdk.App();
  const stack = new BackendStack(app, "SdkGrantGuardStack", {
    environment: "test",
    env: { account: "123456789012", region: "us-east-1" },
  });
  return Template.fromStack(stack);
}

describe("Handler SDK command → DynamoDB IAM action guard (BackendStack)", () => {
  let template: Template;

  beforeAll(() => {
    template = synthBackendStack();
  });

  test("every DynamoDB SDK command targeting a table has a corresponding IAM action grant", () => {
    const fns = template.findResources("AWS::Lambda::Function") as Record<
      string,
      CfnFunctionProps
    >;
    const policies = template.findResources("AWS::IAM::Policy") as Record<
      string,
      CfnPolicyProps
    >;

    const violations: string[] = [];
    let functionsChecked = 0;

    for (const [fnLogicalId, fnResource] of Object.entries(fns)) {
      const props = fnResource.Properties;
      if (!props) continue;
      const runtime = props.Runtime ?? "";
      if (!runtime.toString().startsWith("nodejs")) continue;

      const handlerStr = props.Handler ?? "";
      const roleLogicalId = props.Role?.["Fn::GetAtt"]?.[0];
      if (!roleLogicalId) continue;

      const sourceFile = handlerToSourceFile(handlerStr);
      if (!sourceFile) continue;

      const envVars = props.Environment?.Variables ?? {};

      // Collect *_TABLE env vars with Ref values.
      const tableEntries: Array<{
        envName: string;
        tableLogicalId: string;
      }> = [];
      for (const [envName, envValue] of Object.entries(envVars)) {
        if (!envName.endsWith("_TABLE")) continue;
        const ref = (envValue as { Ref?: string })?.Ref;
        if (!ref) continue;
        tableEntries.push({ envName, tableLogicalId: ref });
      }

      if (tableEntries.length === 0) continue;

      // Analyse handler source to associate commands with specific tables.
      const analysis = analyzeHandler(sourceFile);

      let hasAssociations = false;
      for (const { envName } of tableEntries) {
        if (analysis.tableToCommands.has(envName)) {
          hasAssociations = true;
          break;
        }
      }
      if (!hasAssociations) continue;

      functionsChecked += 1;

      // Check grants per table using only the commands associated with it.
      const tableIds = tableEntries.map((t) => t.tableLogicalId);
      const grants = collectDynamoGrants(policies, roleLogicalId, tableIds);

      for (const { envName, tableLogicalId } of tableEntries) {
        const cmds = analysis.tableToCommands.get(envName);
        if (!cmds) continue; // no commands target this table

        const grantedActions = grants.get(tableLogicalId) ?? new Set();
        for (const cmd of cmds) {
          const required = COMMAND_TO_ACTION[cmd];
          if (required && !grantedActions.has(required)) {
            violations.push(
              `${fnLogicalId} (${handlerStr}): uses ${cmd} (${required}) on ${envName} but role lacks that action`,
            );
          }
        }
      }
    }

    if (violations.length > 0) {
      console.error(
        "SDK→IAM grant violations:\n" +
          violations.map((v) => `  • ${v}`).join("\n"),
      );
    }
    expect(violations).toEqual([]);
    expect(functionsChecked).toBeGreaterThan(0);
  });

  test("SeedEvalSuites specifically has dynamodb:GetItem on the eval-suites table", () => {
    const fns = template.findResources("AWS::Lambda::Function") as Record<
      string,
      CfnFunctionProps
    >;
    const policies = template.findResources("AWS::IAM::Policy") as Record<
      string,
      CfnPolicyProps
    >;

    const entry = Object.entries(fns).find(
      ([, res]) => res.Properties?.Handler === "seed-eval-suites/index.handler",
    );
    expect(entry).toBeDefined();
    const [, fnRes] = entry!;
    const roleLogicalId = fnRes.Properties!.Role!["Fn::GetAtt"]![0];
    const suitesTableRef = (
      fnRes.Properties!.Environment!.Variables!.EVAL_SUITES_TABLE as {
        Ref: string;
      }
    ).Ref;

    const grants = collectDynamoGrants(policies, roleLogicalId, [
      suitesTableRef,
    ]);
    const grantedActions = grants.get(suitesTableRef) ?? new Set();

    expect(grantedActions).toContain("dynamodb:GetItem");
  });
});
