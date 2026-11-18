/**
 * Citadel PR-1 (C1+C2 CDK grants): Verify the datastore-resolver Lambda
 * role has the IAM/AOSS/Bedrock tagging and list-tags permissions needed
 * for KB ownership tagging (C1) and ownership preflight reads (C2):
 *   - iam:TagRole, iam:ListRoleTags, iam:GetRole  (KB service role, C1+C2)
 *   - aoss:TagResource, aoss:ListTagsForResource, aoss:BatchGetCollection
 *     (AOSS collection, C1+C2)
 *   - bedrock:TagResource, bedrock:ListTagsForResource (Bedrock KB, C1+C2)
 *
 * Mirrors backend-stack-s3-preflight-grant.test.ts's in-process synth
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

function synthBackendStack(): Template {
  const app = new cdk.App();
  const stack = new BackendStack(app, "KbOwnershipGrantStack", {
    environment: "test",
    env: { account: "123456789012", region: "us-east-1" },
  });
  return Template.fromStack(stack);
}

function collectDataStoreResolverPolicyStatements(
  template: Template,
): Array<{ Effect: string; Action: string | string[]; Resource: unknown }> {
  const resources = template.toJSON().Resources as Record<
    string,
    { Type: string; Properties?: Record<string, unknown> }
  >;

  const policyStatements: Array<{
    Effect: string;
    Action: string | string[];
    Resource: unknown;
  }> = [];

  for (const [, resource] of Object.entries(resources)) {
    if (resource.Type !== "AWS::IAM::Policy") continue;
    const doc = resource.Properties?.PolicyDocument as {
      Statement?: Array<{
        Effect: string;
        Action: string | string[];
        Resource: unknown;
      }>;
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

function findStatementWithAction(
  statements: Array<{
    Effect: string;
    Action: string | string[];
    Resource: unknown;
  }>,
  action: string,
) {
  return statements.find((stmt) => {
    const actions = Array.isArray(stmt.Action) ? stmt.Action : [stmt.Action];
    return actions.includes(action);
  });
}

describe("Citadel PR-1 — backend-stack KB ownership tagging grants", () => {
  let statements: Array<{
    Effect: string;
    Action: string | string[];
    Resource: unknown;
  }>;

  beforeAll(() => {
    const template = synthBackendStack();
    statements = collectDataStoreResolverPolicyStatements(template);
  });

  it("has iam:TagRole on the datastore-resolver role", () => {
    const stmt = findStatementWithAction(statements, "iam:TagRole");
    expect(stmt).toBeDefined();
    expect(stmt!.Effect).toBe("Allow");
  });

  it("has iam:ListRoleTags on the datastore-resolver role", () => {
    const stmt = findStatementWithAction(statements, "iam:ListRoleTags");
    expect(stmt).toBeDefined();
    expect(stmt!.Effect).toBe("Allow");
  });

  it("has iam:GetRole on the datastore-resolver role", () => {
    const stmt = findStatementWithAction(statements, "iam:GetRole");
    expect(stmt).toBeDefined();
    expect(stmt!.Effect).toBe("Allow");
  });

  it("has aoss:TagResource", () => {
    const stmt = findStatementWithAction(statements, "aoss:TagResource");
    expect(stmt).toBeDefined();
    expect(stmt!.Effect).toBe("Allow");
  });

  it("has aoss:ListTagsForResource", () => {
    const stmt = findStatementWithAction(
      statements,
      "aoss:ListTagsForResource",
    );
    expect(stmt).toBeDefined();
    expect(stmt!.Effect).toBe("Allow");
  });

  it("has aoss:BatchGetCollection", () => {
    const stmt = findStatementWithAction(statements, "aoss:BatchGetCollection");
    expect(stmt).toBeDefined();
    expect(stmt!.Effect).toBe("Allow");
  });

  it("has bedrock:TagResource", () => {
    const stmt = findStatementWithAction(statements, "bedrock:TagResource");
    expect(stmt).toBeDefined();
    expect(stmt!.Effect).toBe("Allow");
  });

  it("has bedrock:ListTagsForResource", () => {
    const stmt = findStatementWithAction(
      statements,
      "bedrock:ListTagsForResource",
    );
    expect(stmt).toBeDefined();
    expect(stmt!.Effect).toBe("Allow");
  });
});
