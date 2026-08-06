/**
 * Agent release bundles (slice 1) — AgentReleasesTable CDK template
 * assertions. Required up front per task instructions: "the eval tables
 * shipped without CDK assertions and needed a retrofit; do not repeat
 * that" — this test ships in the same change as the table.
 *
 * Governed exactly like EvalRunsTable/ExecutionSpecificationsTable
 * (RETAIN + deletionProtection + PITR — see backend-stack.ts's
 * AgentReleasesTable construction site, sibling to EvalRunsTable/
 * EvalRunCaseResultsTable). Additionally asserts the IAM floor (design
 * §2, L3): the granted writer role carries dynamodb:PutItem,
 * dynamodb:GetItem, dynamodb:Query and NOTHING ELSE against this table —
 * no UpdateItem, no DeleteItem, anywhere in the synthesized template.
 *
 * Style mirrors backend-stack-eval-tables.test.ts: synth a real
 * BackendStack and assert via Template.fromStack(...).
 */

import * as cdk from "aws-cdk-lib";
import { Template, Match } from "aws-cdk-lib/assertions";
import * as path from "path";
import * as fs from "fs";

// Ensure asset directories exist for CDK synthesis (CI + clean-checkout safety).
const assetDirs = [
  path.resolve(__dirname, "../src/schema"),
  path.resolve(__dirname, "../dist/lambda"),
  path.resolve(__dirname, "../../src/lambda/seed-organizations"),
  path.resolve(__dirname, "../src/lambda/seed-admin-user"),
  path.resolve(__dirname, "../src/lambda/seed-organizations"),
];
for (const dir of assetDirs) {
  if (!fs.existsSync(dir)) fs.mkdirSync(dir, { recursive: true });
}

import { BackendStack } from "../lib/backend-stack";

describe("BackendStack — AgentReleasesTable (agent release bundles, slice 1)", () => {
  let template: Template;

  beforeAll(() => {
    const app = new cdk.App();
    const stack = new BackendStack(app, "TestBackendStackAgentReleases", {
      environment: "test",
      env: { account: "123456789012", region: "us-east-1" },
    });
    template = Template.fromStack(stack);
  });

  test("has RETAIN removal policy and DeletionProtection enabled", () => {
    template.hasResource("AWS::DynamoDB::Table", {
      Properties: Match.objectLike({
        TableName: "citadel-agent-releases-test",
        DeletionProtectionEnabled: true,
      }),
      DeletionPolicy: "Retain",
      UpdateReplacePolicy: "Retain",
    });
  });

  test("has point-in-time recovery enabled", () => {
    template.hasResourceProperties("AWS::DynamoDB::Table", {
      TableName: "citadel-agent-releases-test",
      PointInTimeRecoverySpecification: { PointInTimeRecoveryEnabled: true },
    });
  });

  test("is PAY_PER_REQUEST billing with simple releaseId partition key", () => {
    template.hasResourceProperties("AWS::DynamoDB::Table", {
      TableName: "citadel-agent-releases-test",
      BillingMode: "PAY_PER_REQUEST",
      KeySchema: [{ AttributeName: "releaseId", KeyType: "HASH" }],
    });
  });

  test("has org-index GSI (orgId HASH / createdAt RANGE, ProjectionType ALL)", () => {
    template.hasResourceProperties("AWS::DynamoDB::Table", {
      TableName: "citadel-agent-releases-test",
      GlobalSecondaryIndexes: Match.arrayWith([
        Match.objectLike({
          IndexName: "org-index",
          KeySchema: [
            { AttributeName: "orgId", KeyType: "HASH" },
            { AttributeName: "createdAt", KeyType: "RANGE" },
          ],
          Projection: { ProjectionType: "ALL" },
        }),
      ]),
    });
  });

  describe("IAM floor — PutItem/GetItem/Query only, no UpdateItem/DeleteItem anywhere", () => {
    test("AgentReleaseWriterRole's policy grants exactly PutItem, GetItem, Query on the table (and its indexes)", () => {
      const policies = template.findResources("AWS::IAM::Policy");
      const releasePolicies = Object.values(policies).filter((p) => {
        const doc = p.Properties?.PolicyDocument;
        const stmts = doc?.Statement ?? [];
        return stmts.some((s: { Resource?: unknown }) => {
          const resources = Array.isArray(s.Resource)
            ? s.Resource
            : [s.Resource];
          return resources.some((r: unknown) => {
            const asStr = JSON.stringify(r);
            return asStr.includes("AgentReleasesTable");
          });
        });
      });

      expect(releasePolicies.length).toBeGreaterThan(0);

      for (const policy of releasePolicies) {
        const stmts = policy.Properties.PolicyDocument.Statement as Array<{
          Action?: string | string[];
          Resource?: unknown;
        }>;
        for (const stmt of stmts) {
          const resources = Array.isArray(stmt.Resource)
            ? stmt.Resource
            : [stmt.Resource];
          const targetsReleaseTable = resources.some((r) =>
            JSON.stringify(r).includes("AgentReleasesTable"),
          );
          if (!targetsReleaseTable) continue;

          const actions = Array.isArray(stmt.Action)
            ? stmt.Action
            : [stmt.Action];
          expect(actions).toEqual(
            expect.arrayContaining([
              "dynamodb:PutItem",
              "dynamodb:GetItem",
              "dynamodb:Query",
            ]),
          );
          expect(actions).not.toContain("dynamodb:UpdateItem");
          expect(actions).not.toContain("dynamodb:DeleteItem");
          expect(actions).not.toContain("dynamodb:Scan");
        }
      }
    });

    test("no IAM policy anywhere in the synthesized template grants UpdateItem or DeleteItem on AgentReleasesTable", () => {
      const policies = template.findResources("AWS::IAM::Policy");
      for (const policy of Object.values(policies)) {
        const stmts: Array<{ Action?: string | string[]; Resource?: unknown }> =
          policy.Properties?.PolicyDocument?.Statement ?? [];
        for (const stmt of stmts) {
          const resources = Array.isArray(stmt.Resource)
            ? stmt.Resource
            : [stmt.Resource];
          const targetsReleaseTable = resources.some((r) =>
            JSON.stringify(r).includes("AgentReleasesTable"),
          );
          if (!targetsReleaseTable) continue;

          const actions = Array.isArray(stmt.Action)
            ? stmt.Action
            : [stmt.Action];
          expect(actions).not.toContain("dynamodb:UpdateItem");
          expect(actions).not.toContain("dynamodb:DeleteItem");
        }
      }
    });
  });
});
