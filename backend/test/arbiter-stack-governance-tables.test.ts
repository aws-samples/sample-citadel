/**
 * US-ARB-002 — Governance authority/ledger tables (Δ8)
 *
 * Verifies that ArbiterStack synthesizes the five governance DynamoDB
 * tables specified in the story:
 *   - citadel-authority-units-test       (config, RETAIN, PITR)
 *   - citadel-composition-contracts-test (config, RETAIN, PITR)
 *   - citadel-case-law-test              (config, RETAIN, PITR)
 *   - citadel-constitutional-layers-test (config, RETAIN, PITR)
 *   - citadel-governance-ledger-test     (ledger, DESTROY, PITR, TTL=ttl,
 *                                         GSI workflow-index)
 *
 * Style mirrors the working parts of `arbiter-stack-step-runner.test.ts`
 * and `arbiter-stack-supervisor-apps-table.test.ts`: bootstrap a minimal
 * MockBackendStack for cross-stack inputs, instantiate ArbiterStack, then
 * assert via `Template.fromStack(...)`.
 */
import * as cdk from "aws-cdk-lib";
import { Template, Match } from "aws-cdk-lib/assertions";
import * as dynamodb from "aws-cdk-lib/aws-dynamodb";
import * as events from "aws-cdk-lib/aws-events";
import { Bucket } from "aws-cdk-lib/aws-s3";
import {
  scaffoldBackendAssetDirs,
  scaffoldArbiterStubs,
} from "./helpers/scaffold-stub-assets";

// Ensure asset directories exist for CDK synthesis (CI + clean-checkout safety).
scaffoldBackendAssetDirs(["dist/lambda", "src/schema"]);

// PythonFunction entry paths resolve from backend/lib/ via a repo-anchored
// root. Stub the resolved paths so CDK can compute the asset hash without
// requiring a full repo checkout.
scaffoldArbiterStubs();

import { ArbiterStack } from "../lib/arbiter-stack";

describe("ArbiterStack — US-ARB-002 governance tables (Δ8)", () => {
  let template: Template;

  beforeAll(() => {
    const app = new cdk.App();

    // Minimal mock BackendStack to supply the cross-stack props required
    // by ArbiterStackProps (agentEventBus, agentConfigTable, codeBucket,
    // executionSpecificationsTable). We only need a synthable graph; the
    // Lambdas and EventBridge rules inside ArbiterStack are not the subject
    // of this test, so we do not wire the optional props (workflowsTable,
    // executionsTable, fanoutFunction, appSyncEndpoint, appsTable).
    const backendStack = new cdk.Stack(app, "MockBackendStack", {
      env: { account: "123456789012", region: "us-east-1" },
    });

    const agentEventBus = new events.EventBus(backendStack, "AgentEventBus", {
      eventBusName: "citadel-agents-test",
    });

    const agentConfigTable = new dynamodb.Table(
      backendStack,
      "AgentConfigTable",
      {
        tableName: "citadel-agents-test",
        partitionKey: { name: "agentId", type: dynamodb.AttributeType.STRING },
        billingMode: dynamodb.BillingMode.PAY_PER_REQUEST,
        removalPolicy: cdk.RemovalPolicy.DESTROY,
      },
    );

    const codeBucket = new Bucket(backendStack, "CodeBucket", {
      bucketName: "citadel-code-test",
    });

    const executionSpecificationsTable = new dynamodb.Table(
      backendStack,
      "ExecutionSpecificationsTable",
      {
        tableName: "citadel-execution-specifications-test",
        partitionKey: { name: "specId", type: dynamodb.AttributeType.STRING },
        billingMode: dynamodb.BillingMode.PAY_PER_REQUEST,
        removalPolicy: cdk.RemovalPolicy.DESTROY,
      },
    );

    const arbiterStack = new ArbiterStack(app, "TestArbiterStack", {
      environment: "test",
      env: { account: "123456789012", region: "us-east-1" },
      agentEventBus,
      agentConfigTable,
      codeBucket,
      executionSpecificationsTable,
    });

    template = Template.fromStack(arbiterStack);
  });

  // ----------------------------------------------------------------
  // Presence: all 5 tables with the env-suffixed physical names
  // ----------------------------------------------------------------
  describe("table presence", () => {
    const expectedNames = [
      "citadel-authority-units-test",
      "citadel-composition-contracts-test",
      "citadel-case-law-test",
      "citadel-constitutional-layers-test",
      "citadel-governance-ledger-test",
    ];

    test.each(expectedNames)(
      "table %s exists with PAY_PER_REQUEST billing",
      (name) => {
        template.hasResourceProperties("AWS::DynamoDB::Table", {
          TableName: name,
          BillingMode: "PAY_PER_REQUEST",
        });
      },
    );
  });

  // ----------------------------------------------------------------
  // DeletionPolicy: Retain on config tables, Delete on the ledger
  // ----------------------------------------------------------------
  describe("DeletionPolicy", () => {
    const retainedNames = [
      "citadel-authority-units-test",
      "citadel-composition-contracts-test",
      "citadel-case-law-test",
      "citadel-constitutional-layers-test",
    ];

    test.each(retainedNames)(
      "%s has DeletionPolicy=Retain and UpdateReplacePolicy=Retain",
      (name) => {
        const tables = template.findResources("AWS::DynamoDB::Table", {
          Properties: { TableName: name },
        });
        const logicalIds = Object.keys(tables);
        expect(logicalIds).toHaveLength(1);
        const resource = tables[logicalIds[0]];
        expect(resource.DeletionPolicy).toBe("Retain");
        expect(resource.UpdateReplacePolicy).toBe("Retain");
      },
    );

    test("ledger table has DeletionPolicy=Delete", () => {
      const tables = template.findResources("AWS::DynamoDB::Table", {
        Properties: { TableName: "citadel-governance-ledger-test" },
      });
      const logicalIds = Object.keys(tables);
      expect(logicalIds).toHaveLength(1);
      const resource = tables[logicalIds[0]];
      expect(resource.DeletionPolicy).toBe("Delete");
      expect(resource.UpdateReplacePolicy).toBe("Delete");
    });
  });

  // ----------------------------------------------------------------
  // DeletionProtection on the 4 config tables (ledger may or may not
  // emit the property; TTL handles its lifecycle).
  // ----------------------------------------------------------------
  describe("DeletionProtection", () => {
    const protectedNames = [
      "citadel-authority-units-test",
      "citadel-composition-contracts-test",
      "citadel-case-law-test",
      "citadel-constitutional-layers-test",
    ];

    test.each(protectedNames)(
      "%s has DeletionProtectionEnabled=true",
      (name) => {
        template.hasResourceProperties("AWS::DynamoDB::Table", {
          TableName: name,
          DeletionProtectionEnabled: true,
        });
      },
    );
  });

  // ----------------------------------------------------------------
  // PITR enabled on all 5 new tables
  // ----------------------------------------------------------------
  describe("Point-in-time recovery", () => {
    const allFive = [
      "citadel-authority-units-test",
      "citadel-composition-contracts-test",
      "citadel-case-law-test",
      "citadel-constitutional-layers-test",
      "citadel-governance-ledger-test",
    ];

    test.each(allFive)("%s has PITR enabled", (name) => {
      template.hasResourceProperties("AWS::DynamoDB::Table", {
        TableName: name,
        PointInTimeRecoverySpecification: {
          PointInTimeRecoveryEnabled: true,
        },
      });
    });
  });

  // ----------------------------------------------------------------
  // Ledger-only: partition key, TTL, and the workflow-index GSI
  // ----------------------------------------------------------------
  describe("GovernanceLedgerTable", () => {
    test("partition key is findingId (S)", () => {
      template.hasResourceProperties("AWS::DynamoDB::Table", {
        TableName: "citadel-governance-ledger-test",
        KeySchema: Match.arrayWith([
          { AttributeName: "findingId", KeyType: "HASH" },
        ]),
        AttributeDefinitions: Match.arrayWith([
          { AttributeName: "findingId", AttributeType: "S" },
        ]),
      });
    });

    test('TimeToLiveSpecification targets attribute "ttl" and is enabled', () => {
      template.hasResourceProperties("AWS::DynamoDB::Table", {
        TableName: "citadel-governance-ledger-test",
        TimeToLiveSpecification: {
          AttributeName: "ttl",
          Enabled: true,
        },
      });
    });

    test("workflow-index GSI has workflowId HASH + timestamp RANGE (N)", () => {
      template.hasResourceProperties("AWS::DynamoDB::Table", {
        TableName: "citadel-governance-ledger-test",
        GlobalSecondaryIndexes: Match.arrayWith([
          Match.objectLike({
            IndexName: "workflow-index",
            KeySchema: [
              { AttributeName: "workflowId", KeyType: "HASH" },
              { AttributeName: "timestamp", KeyType: "RANGE" },
            ],
            Projection: { ProjectionType: "ALL" },
          }),
        ]),
        AttributeDefinitions: Match.arrayWith([
          { AttributeName: "workflowId", AttributeType: "S" },
          { AttributeName: "timestamp", AttributeType: "N" },
        ]),
      });
    });
  });

  // ----------------------------------------------------------------
  // Sanity: config tables do NOT declare the ledger's TTL attribute.
  // Guards against accidental copy-paste that leaves TTL on a table
  // whose cleanup policy is RETAIN.
  // ----------------------------------------------------------------
  describe("config tables have no TTL", () => {
    const configNames = [
      "citadel-authority-units-test",
      "citadel-composition-contracts-test",
      "citadel-case-law-test",
      "citadel-constitutional-layers-test",
    ];

    test.each(configNames)("%s has no TimeToLiveSpecification", (name) => {
      const tables = template.findResources("AWS::DynamoDB::Table", {
        Properties: { TableName: name },
      });
      const logicalIds = Object.keys(tables);
      expect(logicalIds).toHaveLength(1);
      const props = tables[logicalIds[0]].Properties;
      expect(props.TimeToLiveSpecification).toBeUndefined();
    });
  });
});
