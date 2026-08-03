/**
 * CIT-101 — EvalSuitesTable / EvalCasesTable CDK template assertions.
 *
 * Eval suites are release evidence, governed exactly like
 * ExecutionSpecifications (RETAIN + deletionProtection + PITR — see
 * backend-stack.ts:3080-3097 ExecutionSpecificationsTable precedent and the
 * CIT-101 design's guiding principle). No baseline (split-gates rail2)
 * covers these new tables, so this test is the only machine guard against a
 * future edit silently downgrading the removal/backup posture.
 *
 * Style mirrors backend-stack-workflows.test.ts: synth a real BackendStack
 * and assert via Template.fromStack(...).
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

describe("BackendStack — EvalSuitesTable / EvalCasesTable (CIT-101)", () => {
  let template: Template;

  beforeAll(() => {
    const app = new cdk.App();
    const stack = new BackendStack(app, "TestBackendStackEvalTables", {
      environment: "test",
      env: { account: "123456789012", region: "us-east-1" },
    });
    template = Template.fromStack(stack);
  });

  describe("EvalSuitesTable", () => {
    test("has RETAIN removal policy and DeletionProtection enabled", () => {
      template.hasResource("AWS::DynamoDB::Table", {
        Properties: Match.objectLike({
          TableName: "citadel-eval-suites-test",
          DeletionProtectionEnabled: true,
        }),
        DeletionPolicy: "Retain",
        UpdateReplacePolicy: "Retain",
      });
    });

    test("has point-in-time recovery enabled", () => {
      template.hasResourceProperties("AWS::DynamoDB::Table", {
        TableName: "citadel-eval-suites-test",
        PointInTimeRecoverySpecification: { PointInTimeRecoveryEnabled: true },
      });
    });

    test("is PAY_PER_REQUEST billing with simple suiteId partition key", () => {
      template.hasResourceProperties("AWS::DynamoDB::Table", {
        TableName: "citadel-eval-suites-test",
        BillingMode: "PAY_PER_REQUEST",
        KeySchema: [{ AttributeName: "suiteId", KeyType: "HASH" }],
      });
    });

    test("has org-index GSI (orgId HASH / updatedAt RANGE, ProjectionType ALL)", () => {
      template.hasResourceProperties("AWS::DynamoDB::Table", {
        TableName: "citadel-eval-suites-test",
        GlobalSecondaryIndexes: Match.arrayWith([
          Match.objectLike({
            IndexName: "org-index",
            KeySchema: [
              { AttributeName: "orgId", KeyType: "HASH" },
              { AttributeName: "updatedAt", KeyType: "RANGE" },
            ],
            Projection: { ProjectionType: "ALL" },
          }),
        ]),
      });
    });

    test("has agent-target-index GSI (agentTargetId HASH / updatedAt RANGE, ProjectionType ALL)", () => {
      template.hasResourceProperties("AWS::DynamoDB::Table", {
        TableName: "citadel-eval-suites-test",
        GlobalSecondaryIndexes: Match.arrayWith([
          Match.objectLike({
            IndexName: "agent-target-index",
            KeySchema: [
              { AttributeName: "agentTargetId", KeyType: "HASH" },
              { AttributeName: "updatedAt", KeyType: "RANGE" },
            ],
            Projection: { ProjectionType: "ALL" },
          }),
        ]),
      });
    });
  });

  describe("EvalCasesTable", () => {
    test("has RETAIN removal policy and DeletionProtection enabled", () => {
      template.hasResource("AWS::DynamoDB::Table", {
        Properties: Match.objectLike({
          TableName: "citadel-eval-cases-test",
          DeletionProtectionEnabled: true,
        }),
        DeletionPolicy: "Retain",
        UpdateReplacePolicy: "Retain",
      });
    });

    test("has point-in-time recovery enabled", () => {
      template.hasResourceProperties("AWS::DynamoDB::Table", {
        TableName: "citadel-eval-cases-test",
        PointInTimeRecoverySpecification: { PointInTimeRecoveryEnabled: true },
      });
    });

    test("is PAY_PER_REQUEST billing with composite suiteId/caseId key", () => {
      template.hasResourceProperties("AWS::DynamoDB::Table", {
        TableName: "citadel-eval-cases-test",
        BillingMode: "PAY_PER_REQUEST",
        KeySchema: [
          { AttributeName: "suiteId", KeyType: "HASH" },
          { AttributeName: "caseId", KeyType: "RANGE" },
        ],
      });
    });
  });
});
