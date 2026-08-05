/**
 * CIT-105 Pass 2 — EvalBaselinesTable / EvalComparisonsTable /
 * EvalComparisonConfigTable CDK template assertions.
 *
 * Posture per backend-stack.ts comments: EvalBaselines + EvalComparisons are
 * evidence-adjacent governance records (RETAIN + deletionProtection + PITR,
 * same as EvalRunsTable); EvalComparisonConfig is an admin-authored config
 * table (DESTROY, same as EvalSamplingConfigTable) with PITR.
 *
 * Style mirrors backend-stack-eval-run-tables.test.ts (CIT-102).
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

describe("BackendStack — eval comparison tables (CIT-105)", () => {
  let template: Template;

  beforeAll(() => {
    const app = new cdk.App();
    const stack = new BackendStack(
      app,
      "TestBackendStackEvalComparisonTables",
      {
        environment: "test",
        env: { account: "123456789012", region: "us-east-1" },
      },
    );
    template = Template.fromStack(stack);
  });

  describe("EvalBaselinesTable", () => {
    test("has RETAIN removal policy and DeletionProtection enabled", () => {
      template.hasResource("AWS::DynamoDB::Table", {
        Properties: Match.objectLike({
          TableName: "citadel-eval-baselines-test",
          DeletionProtectionEnabled: true,
        }),
        DeletionPolicy: "Retain",
        UpdateReplacePolicy: "Retain",
      });
    });

    test("has point-in-time recovery enabled", () => {
      template.hasResourceProperties("AWS::DynamoDB::Table", {
        TableName: "citadel-eval-baselines-test",
        PointInTimeRecoverySpecification: { PointInTimeRecoveryEnabled: true },
      });
    });

    test("is PAY_PER_REQUEST billing with orgId partition key and agentTargetId_suiteId sort key (org-scoped point-get + org listing)", () => {
      template.hasResourceProperties("AWS::DynamoDB::Table", {
        TableName: "citadel-eval-baselines-test",
        BillingMode: "PAY_PER_REQUEST",
        KeySchema: [
          { AttributeName: "orgId", KeyType: "HASH" },
          { AttributeName: "agentTargetId_suiteId", KeyType: "RANGE" },
        ],
      });
    });
  });

  describe("EvalComparisonsTable", () => {
    test("has RETAIN removal policy and DeletionProtection enabled", () => {
      template.hasResource("AWS::DynamoDB::Table", {
        Properties: Match.objectLike({
          TableName: "citadel-eval-comparisons-test",
          DeletionProtectionEnabled: true,
        }),
        DeletionPolicy: "Retain",
        UpdateReplacePolicy: "Retain",
      });
    });

    test("has point-in-time recovery enabled", () => {
      template.hasResourceProperties("AWS::DynamoDB::Table", {
        TableName: "citadel-eval-comparisons-test",
        PointInTimeRecoverySpecification: { PointInTimeRecoveryEnabled: true },
      });
    });

    test("is PAY_PER_REQUEST billing with simple comparisonId partition key", () => {
      template.hasResourceProperties("AWS::DynamoDB::Table", {
        TableName: "citadel-eval-comparisons-test",
        BillingMode: "PAY_PER_REQUEST",
        KeySchema: [{ AttributeName: "comparisonId", KeyType: "HASH" }],
      });
    });

    test("has org-index GSI (orgId HASH / createdAt RANGE, ProjectionType ALL)", () => {
      template.hasResourceProperties("AWS::DynamoDB::Table", {
        TableName: "citadel-eval-comparisons-test",
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

    test("has suite-index GSI (suiteId HASH / createdAt RANGE, ProjectionType ALL)", () => {
      template.hasResourceProperties("AWS::DynamoDB::Table", {
        TableName: "citadel-eval-comparisons-test",
        GlobalSecondaryIndexes: Match.arrayWith([
          Match.objectLike({
            IndexName: "suite-index",
            KeySchema: [
              { AttributeName: "suiteId", KeyType: "HASH" },
              { AttributeName: "createdAt", KeyType: "RANGE" },
            ],
            Projection: { ProjectionType: "ALL" },
          }),
        ]),
      });
    });
  });

  describe("EvalComparisonConfigTable", () => {
    test("has DESTROY removal policy (admin-authored config posture, mirrors EvalSamplingConfigTable) with PITR", () => {
      template.hasResource("AWS::DynamoDB::Table", {
        Properties: Match.objectLike({
          TableName: "citadel-eval-comparison-config-test",
          PointInTimeRecoverySpecification: {
            PointInTimeRecoveryEnabled: true,
          },
        }),
        DeletionPolicy: "Delete",
        UpdateReplacePolicy: "Delete",
      });
    });

    test("is PAY_PER_REQUEST billing with orgId partition key and suiteId sort key (org-scoped; `__default__` sentinel row per org)", () => {
      template.hasResourceProperties("AWS::DynamoDB::Table", {
        TableName: "citadel-eval-comparison-config-test",
        BillingMode: "PAY_PER_REQUEST",
        KeySchema: [
          { AttributeName: "orgId", KeyType: "HASH" },
          { AttributeName: "suiteId", KeyType: "RANGE" },
        ],
      });
    });
  });
});
