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

  // Phase 2 — EvalProdSamplesTable (B1 regression pins, taskId 316427f2).
  //
  // B1's root cause was a CROSS-LAYER schema mismatch: eval-sample-scorer's
  // applyProdJudgedResult issued a Get on {orgId, runId} while the table's
  // real key schema is (PK, SK) — invisible to the Lambda unit tests because
  // aws-sdk-client-mock is schema-agnostic. The Lambda-side tests
  // (eval-sample-scorer.test.ts) pin the literal attribute names the code
  // sends; the pins below anchor the OTHER side of that contract — the
  // template's literal KeySchema and the SampleIdIndex GSI the fixed code
  // Queries — so neither side can drift without a test failing.
  describe("EvalProdSamplesTable (Phase 2 — production sampling)", () => {
    test("real key schema is literally PK (HASH) / SK (RANGE) — the attributes applyProdJudgedResult's UpdateCommand must use", () => {
      template.hasResourceProperties("AWS::DynamoDB::Table", {
        TableName: "citadel-eval-prod-samples-test",
        KeySchema: [
          { AttributeName: "PK", KeyType: "HASH" },
          { AttributeName: "SK", KeyType: "RANGE" },
        ],
      });
    });

    test("declares the sparse SampleIdIndex GSI (sampleId HASH, no range key, ProjectionType ALL) that applyProdJudgedResult Queries by caseId", () => {
      const tables = template.findResources("AWS::DynamoDB::Table", {
        Properties: { TableName: "citadel-eval-prod-samples-test" },
      });
      const logicalId = Object.keys(tables)[0];
      expect(logicalId).toBeDefined();

      const gsis: Array<{
        IndexName: string;
        KeySchema: Array<{ AttributeName: string; KeyType: string }>;
        Projection: { ProjectionType: string };
      }> = tables[logicalId].Properties.GlobalSecondaryIndexes;
      const sampleIdIndex = gsis.find((g) => g.IndexName === "SampleIdIndex");

      expect(sampleIdIndex).toBeDefined();
      // Partition key MUST be the literal `sampleId` attribute (the judged
      // event's caseId under the prod-sample carrier convention) and MUST
      // NOT have a range key — the lookup is a point Query, never a Scan.
      expect(sampleIdIndex!.KeySchema).toEqual([
        { AttributeName: "sampleId", KeyType: "HASH" },
      ]);
      expect(sampleIdIndex!.Projection.ProjectionType).toBe("ALL");
    });

    test("has RETAIN removal policy, DeletionProtection, and PITR (same evidence posture as the eval-suite tables)", () => {
      template.hasResource("AWS::DynamoDB::Table", {
        Properties: Match.objectLike({
          TableName: "citadel-eval-prod-samples-test",
          DeletionProtectionEnabled: true,
          PointInTimeRecoverySpecification: {
            PointInTimeRecoveryEnabled: true,
          },
        }),
        DeletionPolicy: "Retain",
        UpdateReplacePolicy: "Retain",
      });
    });
  });
});
