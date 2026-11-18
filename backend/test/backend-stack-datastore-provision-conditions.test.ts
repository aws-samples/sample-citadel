/**
 * Continuum C3 (PR-2): CDK synth guard for datastore provisioning
 * conditions.
 *
 * Verifies the datastore-resolver Lambda's own IAM policy (NOT the vended
 * citadel-ds-<id> role) carries the tag/region-constrained shape this PR
 * introduces:
 *   - create-verbs (dynamodb:CreateTable, rds:CreateDBInstance,
 *     bedrock:CreateKnowledgeBase) necessarily grant Resource "*", but
 *     MUST carry a Condition referencing aws:RequestTag/citadel:dataStoreId
 *     or aws:RequestedRegion.
 *   - destructive verbs (dynamodb:DeleteTable, rds:DeleteDBInstance) are
 *     NEVER granted on a bare "*" resource — they must be bounded to this
 *     account+region (table/* or db:* ARN pattern).
 *
 * Mirrors backend-stack-kb-ownership-grant.test.ts's in-process synth
 * pattern so CI never needs a prior `cdk synth`.
 */
import * as cdk from "aws-cdk-lib";
import { Template } from "aws-cdk-lib/assertions";
import * as fs from "fs";
import * as path from "path";
import { scaffoldBackendAssetDirs } from "./helpers/scaffold-stub-assets";

scaffoldBackendAssetDirs(["dist/lambda", "src/schema"]);

const EXTRA_ASSET_DIRS = [
  path.resolve(__dirname, "../src/lambda/seed-admin-user"),
  path.resolve(__dirname, "../src/lambda/seed-organizations"),
];
for (const dir of EXTRA_ASSET_DIRS) {
  if (!fs.existsSync(dir)) fs.mkdirSync(dir, { recursive: true });
}

import { BackendStack } from "../lib/backend-stack";

jest.setTimeout(60000);

const ACCOUNT_ID = "123456789012";
const REGION = "us-east-1";

interface IamStatement {
  Effect: string;
  Action: string | string[];
  Resource: unknown;
  Condition?: Record<string, unknown>;
}

function synthBackendStack(): Template {
  const app = new cdk.App();
  const stack = new BackendStack(app, "DataStoreProvisionConditionsStack", {
    environment: "test",
    env: { account: ACCOUNT_ID, region: REGION },
  });
  return Template.fromStack(stack);
}

function collectDataStoreResolverPolicyStatements(
  template: Template,
): IamStatement[] {
  const resources = template.toJSON().Resources as Record<
    string,
    { Type: string; Properties?: Record<string, unknown> }
  >;

  const policyStatements: IamStatement[] = [];

  for (const [, resource] of Object.entries(resources)) {
    if (resource.Type !== "AWS::IAM::Policy") continue;
    const doc = resource.Properties?.PolicyDocument as {
      Statement?: IamStatement[];
    };
    if (!doc?.Statement) continue;

    const roles = resource.Properties?.Roles as Array<{ Ref?: string }>;
    const isDataStorePolicy = roles?.some(
      (r) =>
        r.Ref &&
        (r.Ref.includes("DataStoreResolver") ||
          r.Ref.includes("DatastoreResolver") ||
          r.Ref.includes("datastoreresolver")),
    );
    if (!isDataStorePolicy) continue;

    for (const stmt of doc.Statement) {
      policyStatements.push(stmt);
    }
  }

  return policyStatements;
}

function findStatementsWithAction(
  statements: IamStatement[],
  action: string,
): IamStatement[] {
  return statements.filter((stmt) => {
    const actions = Array.isArray(stmt.Action) ? stmt.Action : [stmt.Action];
    return actions.includes(action);
  });
}

function hasBareWildcardResource(stmt: IamStatement): boolean {
  const resources = Array.isArray(stmt.Resource)
    ? stmt.Resource
    : [stmt.Resource];
  return resources.includes("*");
}

function conditionReferencesTagOrRegion(stmt: IamStatement): boolean {
  const condition = stmt.Condition;
  if (!condition) return false;
  const serialized = JSON.stringify(condition);
  return (
    serialized.includes("citadel:dataStoreId") ||
    serialized.includes("aws:RequestedRegion")
  );
}

describe("Citadel PR-2 — backend-stack datastore provisioning IAM conditions", () => {
  let statements: IamStatement[];

  beforeAll(() => {
    const template = synthBackendStack();
    statements = collectDataStoreResolverPolicyStatements(template);
  });

  it("dynamodb:CreateTable on a wildcard resource carries a tag or region condition", () => {
    const stmts = findStatementsWithAction(statements, "dynamodb:CreateTable");
    expect(stmts.length).toBeGreaterThan(0);
    for (const stmt of stmts) {
      if (hasBareWildcardResource(stmt)) {
        expect(conditionReferencesTagOrRegion(stmt)).toBe(true);
      }
    }
  });

  it("rds:CreateDBInstance on a wildcard resource carries a tag or region condition", () => {
    const stmts = findStatementsWithAction(statements, "rds:CreateDBInstance");
    expect(stmts.length).toBeGreaterThan(0);
    for (const stmt of stmts) {
      if (hasBareWildcardResource(stmt)) {
        expect(conditionReferencesTagOrRegion(stmt)).toBe(true);
      }
    }
  });

  it("bedrock:CreateKnowledgeBase on a wildcard resource carries a tag or region condition", () => {
    const stmts = findStatementsWithAction(
      statements,
      "bedrock:CreateKnowledgeBase",
    );
    expect(stmts.length).toBeGreaterThan(0);
    for (const stmt of stmts) {
      if (hasBareWildcardResource(stmt)) {
        expect(conditionReferencesTagOrRegion(stmt)).toBe(true);
      }
    }
  });

  it("dynamodb:DeleteTable is never granted on a bare wildcard resource", () => {
    const stmts = findStatementsWithAction(statements, "dynamodb:DeleteTable");
    expect(stmts.length).toBeGreaterThan(0);
    for (const stmt of stmts) {
      expect(hasBareWildcardResource(stmt)).toBe(false);
    }
  });

  it("rds:DeleteDBInstance is never granted on a bare wildcard resource", () => {
    const stmts = findStatementsWithAction(statements, "rds:DeleteDBInstance");
    expect(stmts.length).toBeGreaterThan(0);
    for (const stmt of stmts) {
      expect(hasBareWildcardResource(stmt)).toBe(false);
    }
  });

  it("dynamodb:DeleteTable is bounded to this account+region table ARN pattern", () => {
    const stmts = findStatementsWithAction(statements, "dynamodb:DeleteTable");
    for (const stmt of stmts) {
      const resources = Array.isArray(stmt.Resource)
        ? stmt.Resource
        : [stmt.Resource];
      const serialized = JSON.stringify(resources);
      expect(serialized).toContain("table/");
    }
  });

  it("rds:DeleteDBInstance is bounded to this account+region db ARN pattern", () => {
    const stmts = findStatementsWithAction(statements, "rds:DeleteDBInstance");
    for (const stmt of stmts) {
      const resources = Array.isArray(stmt.Resource)
        ? stmt.Resource
        : [stmt.Resource];
      const serialized = JSON.stringify(resources);
      expect(serialized).toContain("db:");
    }
  });
});
