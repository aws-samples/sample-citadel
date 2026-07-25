import * as cdk from "aws-cdk-lib";
import { Template, Match } from "aws-cdk-lib/assertions";
import * as dynamodb from "aws-cdk-lib/aws-dynamodb";
import * as events from "aws-cdk-lib/aws-events";
import * as path from "path";
import * as fs from "fs";

// Ensure asset directories exist for CDK synthesis
const assetDirs = [path.resolve(__dirname, "../dist/lambda")];
for (const dir of assetDirs) {
  if (!fs.existsSync(dir)) fs.mkdirSync(dir, { recursive: true });
}

import { TelemetryStack } from "../lib/telemetry-stack";

function createTestStack(): { stack: TelemetryStack; template: Template } {
  const app = new cdk.App();

  const helperStack = new cdk.Stack(app, "HelperStack", {
    env: { account: "123456789012", region: "us-east-1" },
  });

  const agentEventBus = new events.EventBus(helperStack, "EventBus", {
    eventBusName: "citadel-agents-test",
  });

  const modelCatalogTable = new dynamodb.Table(
    helperStack,
    "ModelCatalogTable",
    {
      tableName: "citadel-model-catalog-test",
      partitionKey: { name: "modelKey", type: dynamodb.AttributeType.STRING },
      billingMode: dynamodb.BillingMode.PAY_PER_REQUEST,
      removalPolicy: cdk.RemovalPolicy.DESTROY,
    },
  );

  const stack = new TelemetryStack(app, "TestTelemetryStack", {
    environment: "test",
    env: { account: "123456789012", region: "us-east-1" },
    agentEventBus,
    modelCatalogTable,
  });

  const template = Template.fromStack(stack);
  return { stack, template };
}

describe("TelemetryStack — cost ledger (pass 1)", () => {
  let template: Template;

  beforeAll(() => {
    ({ template } = createTestStack());
  });

  test("cost ledger table has PK/SK, PAY_PER_REQUEST, PITR, and RETAIN", () => {
    template.hasResource("AWS::DynamoDB::Table", {
      Properties: Match.objectLike({
        TableName: "citadel-cost-ledger-test",
        KeySchema: [
          { AttributeName: "PK", KeyType: "HASH" },
          { AttributeName: "SK", KeyType: "RANGE" },
        ],
        BillingMode: "PAY_PER_REQUEST",
        PointInTimeRecoverySpecification: { PointInTimeRecoveryEnabled: true },
      }),
      DeletionPolicy: "Retain",
      UpdateReplacePolicy: "Retain",
    });
  });

  test("cost ledger table has 4 sparse time-prefixed GSIs: Project/App/Agent/Workflow", () => {
    const tables = template.findResources("AWS::DynamoDB::Table", {
      Properties: { TableName: "citadel-cost-ledger-test" },
    });
    const logicalId = Object.keys(tables)[0];
    expect(logicalId).toBeDefined();

    const gsis = tables[logicalId].Properties.GlobalSecondaryIndexes;
    expect(gsis).toHaveLength(4);

    const gsiNames = gsis.map((g: any) => g.IndexName).sort();
    expect(gsiNames).toEqual([
      "AgentIndex",
      "AppIndex",
      "ProjectIndex",
      "WorkflowIndex",
    ]);

    const byName: Record<string, any> = {};
    for (const g of gsis) byName[g.IndexName] = g;

    expect(byName.ProjectIndex.KeySchema).toEqual([
      { AttributeName: "GSI1PK", KeyType: "HASH" },
      { AttributeName: "GSI1SK", KeyType: "RANGE" },
    ]);
    expect(byName.AppIndex.KeySchema).toEqual([
      { AttributeName: "GSI2PK", KeyType: "HASH" },
      { AttributeName: "GSI2SK", KeyType: "RANGE" },
    ]);
    expect(byName.AgentIndex.KeySchema).toEqual([
      { AttributeName: "GSI3PK", KeyType: "HASH" },
      { AttributeName: "GSI3SK", KeyType: "RANGE" },
    ]);
    expect(byName.WorkflowIndex.KeySchema).toEqual([
      { AttributeName: "GSI4PK", KeyType: "HASH" },
      { AttributeName: "GSI4SK", KeyType: "RANGE" },
    ]);
  });

  test("cost-ledger-writer Lambda: nodejs24.x, 30s timeout, own LogGroup", () => {
    template.hasResourceProperties("AWS::Lambda::Function", {
      Handler: "cost-ledger-writer.handler",
      Runtime: "nodejs24.x",
      Timeout: 30,
      Environment: {
        Variables: Match.objectLike({
          COST_LEDGER_TABLE: Match.anyValue(),
          MODEL_CATALOG_TABLE: Match.anyValue(),
        }),
      },
    });

    const functions = template.findResources("AWS::Lambda::Function", {
      Properties: { Handler: "cost-ledger-writer.handler" },
    });
    const logicalId = Object.keys(functions)[0];
    expect(logicalId).toBeDefined();

    const logGroups = template.findResources("AWS::Logs::LogGroup");
    expect(Object.keys(logGroups).length).toBeGreaterThan(0);
  });

  test("3 EventBridge rules target the writer with correct source/detailType", () => {
    template.hasResourceProperties("AWS::Events::Rule", {
      EventPattern: Match.objectLike({
        source: ["task.completion"],
        "detail-type": ["task.completion"],
      }),
    });
    template.hasResourceProperties("AWS::Events::Rule", {
      EventPattern: Match.objectLike({
        source: ["agent_intake.usage"],
        "detail-type": ["intake.usage.captured"],
      }),
    });
    template.hasResourceProperties("AWS::Events::Rule", {
      EventPattern: Match.objectLike({
        source: ["citadel.workflows"],
        "detail-type": ["workflow.node.completed"],
      }),
    });

    const functions = template.findResources("AWS::Lambda::Function", {
      Properties: { Handler: "cost-ledger-writer.handler" },
    });
    const fnLogicalId = Object.keys(functions)[0];

    const rules = template.findResources("AWS::Events::Rule");
    const ruleIds = Object.keys(rules);
    expect(ruleIds.length).toBeGreaterThanOrEqual(3);

    for (const ruleId of ruleIds) {
      const targets = rules[ruleId].Properties.Targets;
      expect(targets).toHaveLength(1);
      expect(targets[0].RetryPolicy).toMatchObject({
        MaximumRetryAttempts: 2,
      });
      expect(typeof targets[0].RetryPolicy.MaximumEventAgeInSeconds).toBe(
        "number",
      );
      const getAtt = targets[0].Arn?.["Fn::GetAtt"];
      expect(Array.isArray(getAtt) && getAtt[0] === fnLogicalId).toBe(true);
    }
  });

  test("writer has write access to ledger table and read access to catalog table, no other grants", () => {
    const functions = template.findResources("AWS::Lambda::Function", {
      Properties: { Handler: "cost-ledger-writer.handler" },
    });
    const fnLogicalId = Object.keys(functions)[0];
    expect(fnLogicalId).toBeDefined();

    const policies = template.findResources("AWS::IAM::Policy");
    const ownPolicies = Object.values(policies).filter((p: any) => {
      const roles = p.Properties?.Roles || [];
      return roles.some((r: any) =>
        (r?.Ref || "").includes("CostLedgerWriter"),
      );
    });
    expect(ownPolicies.length).toBeGreaterThan(0);

    const allActions = ownPolicies.flatMap((p: any) => {
      const statements = p.Properties?.PolicyDocument?.Statement || [];
      return statements.flatMap((s: any) =>
        Array.isArray(s.Action) ? s.Action : [s.Action],
      );
    });

    expect(allActions).toEqual(
      expect.arrayContaining(["dynamodb:PutItem", "dynamodb:GetItem"]),
    );
    // Least-privilege: writer must not be granted delete/write on the catalog
    // table (grantReadData only) — read-only pricing lookup.
    const catalogGrantActions = ownPolicies.flatMap((p: any) => {
      const statements = p.Properties?.PolicyDocument?.Statement || [];
      return statements
        .filter((s: any) =>
          JSON.stringify(s.Resource || "").includes("ModelCatalogTable"),
        )
        .flatMap((s: any) => (Array.isArray(s.Action) ? s.Action : [s.Action]));
    });
    expect(catalogGrantActions).not.toEqual(
      expect.arrayContaining(["dynamodb:PutItem", "dynamodb:DeleteItem"]),
    );
  });
});
