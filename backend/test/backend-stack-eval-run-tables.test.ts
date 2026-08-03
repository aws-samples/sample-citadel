/**
 * CIT-102 Pass A — EvalRunsTable / EvalRunCaseResultsTable CDK template
 * assertions.
 *
 * Governed exactly like EvalSuitesTable/EvalCasesTable (RETAIN +
 * deletionProtection + PITR, no TTL) — see architect design §2: eval runs
 * are E11 release evidence, not ephemeral working state, so the
 * FabricationJobs DESTROY+TTL posture does NOT apply here.
 *
 * Style mirrors backend-stack-eval-tables.test.ts (CIT-101).
 */

import * as cdk from "aws-cdk-lib";
import { Template, Match } from "aws-cdk-lib/assertions";
import * as path from "path";
import * as fs from "fs";

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

describe("BackendStack — EvalRunsTable / EvalRunCaseResultsTable (CIT-102)", () => {
  let template: Template;

  beforeAll(() => {
    const app = new cdk.App();
    const stack = new BackendStack(app, "TestBackendStackEvalRunTables", {
      environment: "test",
      env: { account: "123456789012", region: "us-east-1" },
    });
    template = Template.fromStack(stack);
  });

  describe("EvalRunsTable", () => {
    test("has RETAIN removal policy and DeletionProtection enabled", () => {
      template.hasResource("AWS::DynamoDB::Table", {
        Properties: Match.objectLike({
          TableName: "citadel-eval-runs-test",
          DeletionProtectionEnabled: true,
        }),
        DeletionPolicy: "Retain",
        UpdateReplacePolicy: "Retain",
      });
    });

    test("has point-in-time recovery enabled and no TTL attribute", () => {
      template.hasResourceProperties("AWS::DynamoDB::Table", {
        TableName: "citadel-eval-runs-test",
        PointInTimeRecoverySpecification: { PointInTimeRecoveryEnabled: true },
      });
      const tables = template.findResources("AWS::DynamoDB::Table", {
        Properties: { TableName: "citadel-eval-runs-test" },
      });
      const [table] = Object.values(tables) as Array<{
        Properties: Record<string, unknown>;
      }>;
      expect(table.Properties.TimeToLiveSpecification).toBeUndefined();
    });

    test("is PAY_PER_REQUEST billing with simple evalRunId partition key", () => {
      template.hasResourceProperties("AWS::DynamoDB::Table", {
        TableName: "citadel-eval-runs-test",
        BillingMode: "PAY_PER_REQUEST",
        KeySchema: [{ AttributeName: "evalRunId", KeyType: "HASH" }],
      });
    });

    test("has org-index GSI (orgId HASH / startedAt RANGE, ProjectionType ALL)", () => {
      template.hasResourceProperties("AWS::DynamoDB::Table", {
        TableName: "citadel-eval-runs-test",
        GlobalSecondaryIndexes: Match.arrayWith([
          Match.objectLike({
            IndexName: "org-index",
            KeySchema: [
              { AttributeName: "orgId", KeyType: "HASH" },
              { AttributeName: "startedAt", KeyType: "RANGE" },
            ],
            Projection: { ProjectionType: "ALL" },
          }),
        ]),
      });
    });

    test("has suite-index GSI (suiteId HASH / startedAt RANGE, ProjectionType ALL)", () => {
      template.hasResourceProperties("AWS::DynamoDB::Table", {
        TableName: "citadel-eval-runs-test",
        GlobalSecondaryIndexes: Match.arrayWith([
          Match.objectLike({
            IndexName: "suite-index",
            KeySchema: [
              { AttributeName: "suiteId", KeyType: "HASH" },
              { AttributeName: "startedAt", KeyType: "RANGE" },
            ],
            Projection: { ProjectionType: "ALL" },
          }),
        ]),
      });
    });
  });

  describe("EvalRunCaseResultsTable", () => {
    test("has RETAIN removal policy and DeletionProtection enabled", () => {
      template.hasResource("AWS::DynamoDB::Table", {
        Properties: Match.objectLike({
          TableName: "citadel-eval-run-case-results-test",
          DeletionProtectionEnabled: true,
        }),
        DeletionPolicy: "Retain",
        UpdateReplacePolicy: "Retain",
      });
    });

    test("has point-in-time recovery enabled", () => {
      template.hasResourceProperties("AWS::DynamoDB::Table", {
        TableName: "citadel-eval-run-case-results-test",
        PointInTimeRecoverySpecification: { PointInTimeRecoveryEnabled: true },
      });
    });

    test("is PAY_PER_REQUEST billing with composite evalRunId/caseId key", () => {
      template.hasResourceProperties("AWS::DynamoDB::Table", {
        TableName: "citadel-eval-run-case-results-test",
        BillingMode: "PAY_PER_REQUEST",
        KeySchema: [
          { AttributeName: "evalRunId", KeyType: "HASH" },
          { AttributeName: "caseId", KeyType: "RANGE" },
        ],
      });
    });
  });
});
