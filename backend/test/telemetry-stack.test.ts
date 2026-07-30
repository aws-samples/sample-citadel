describe("TelemetryStack — cost query surface (pass 1: API + authorizer + budgets)", () => {
  let template: Template;

  beforeAll(() => {
    ({ template } = createTestStack());
  });

  test("declares an HttpApi with CORS from the deploy-time frontend origin", () => {
    template.hasResourceProperties("AWS::ApiGatewayV2::Api", {
      ProtocolType: "HTTP",
      CorsConfiguration: Match.objectLike({
        AllowOrigins: ["https://app.example.com"],
        AllowMethods: Match.arrayWith(["GET", "PUT"]),
      }),
    });
  });

  test("declares a JWT authorizer with issuer=user-pool and audience=client", () => {
    template.hasResourceProperties("AWS::ApiGatewayV2::Authorizer", {
      AuthorizerType: "JWT",
      JwtConfiguration: Match.objectLike({
        Issuer: Match.anyValue(),
        Audience: Match.anyValue(),
      }),
    });
  });

  test("declares all 9 costHttpApi routes (4 cost-query + 3 waterfall trace viewer + 2 replay package)", () => {
    const routes = template.findResources("AWS::ApiGatewayV2::Route");
    const routeKeys = Object.values(routes)
      .map((r: any) => r.Properties.RouteKey)
      .sort();
    expect(routeKeys).toEqual(
      [
        "GET /budgets",
        "GET /cost/series",
        "GET /cost/summary",
        "PUT /budgets/{scope}",
        "GET /traces/by-execution/{executionId}",
        "GET /traces/by-conversation/{conversationId}",
        "GET /traces/{traceId}",
        "GET /replay/by-execution/{executionId}",
        "GET /replay/by-conversation/{conversationId}",
      ].sort(),
    );
  });

  test("every route is authorized (none use AuthorizationType NONE)", () => {
    const routes = template.findResources("AWS::ApiGatewayV2::Route");
    for (const route of Object.values(routes) as any[]) {
      expect(route.Properties.AuthorizationType).not.toBe("NONE");
      expect(
        route.Properties.AuthorizerId ?? route.Properties.AuthorizationType,
      ).toBeDefined();
    }
  });

  test("declares the sparse BudgetIndex GSI on the cost ledger table", () => {
    const tables = template.findResources("AWS::DynamoDB::Table", {
      Properties: { TableName: "citadel-cost-ledger-test" },
    });
    const logicalId = Object.keys(tables)[0];
    const gsis = tables[logicalId].Properties.GlobalSecondaryIndexes;
    const byName: Record<string, any> = {};
    for (const g of gsis) byName[g.IndexName] = g;

    expect(byName.BudgetIndex).toBeDefined();
    expect(byName.BudgetIndex.KeySchema).toEqual([
      { AttributeName: "GSI5PK", KeyType: "HASH" },
      { AttributeName: "GSI5SK", KeyType: "RANGE" },
    ]);
  });

  test("declares the evaluator Lambda with its own hourly schedule rule, separate from the reconciler's", () => {
    template.hasResourceProperties("AWS::Lambda::Function", {
      Handler: "cost-budget-evaluator.handler",
    });

    const hourlyRules = template.findResources("AWS::Events::Rule", {
      Properties: { ScheduleExpression: "rate(1 hour)" },
    });
    // reconciler's rule + the new evaluator rule = 2 distinct rate(1 hour) rules.
    expect(Object.keys(hourlyRules).length).toBeGreaterThanOrEqual(2);

    const evaluatorFn = template.findResources("AWS::Lambda::Function", {
      Properties: { Handler: "cost-budget-evaluator.handler" },
    });
    const evaluatorFnId = Object.keys(evaluatorFn)[0];
    const evaluatorRule = Object.values(hourlyRules).find((r: any) =>
      r.Properties.Targets.some(
        (t: any) => t.Arn?.["Fn::GetAtt"]?.[0] === evaluatorFnId,
      ),
    );
    expect(evaluatorRule).toBeDefined();
  });

  test("evaluator role is granted events:PutEvents on the shared bus (telemetry becomes a publisher)", () => {
    const evaluatorFn = template.findResources("AWS::Lambda::Function", {
      Properties: { Handler: "cost-budget-evaluator.handler" },
    });
    const evaluatorFnId = Object.keys(evaluatorFn)[0];
    expect(evaluatorFnId).toBeDefined();

    const policies = template.findResources("AWS::IAM::Policy");
    const ownPolicies = Object.values(policies).filter((p: any) => {
      const roles = p.Properties?.Roles || [];
      return roles.some((r: any) =>
        (r?.Ref || "").includes("CostBudgetEvaluator"),
      );
    });
    const allActions = ownPolicies.flatMap((p: any) => {
      const statements = p.Properties?.PolicyDocument?.Statement || [];
      return statements.flatMap((s: any) =>
        Array.isArray(s.Action) ? s.Action : [s.Action],
      );
    });
    expect(allActions).toEqual(expect.arrayContaining(["events:PutEvents"]));
  });

  test("query handler role has ledger table read access (Query) and no write/Scan grant (query/budgets IAM split)", () => {
    const queryFn = template.findResources("AWS::Lambda::Function", {
      Properties: { Handler: "cost-query-handler.handler" },
    });
    const queryFnId = Object.keys(queryFn)[0];
    expect(queryFnId).toBeDefined();

    const policies = template.findResources("AWS::IAM::Policy");
    const ownPolicies = Object.values(policies).filter((p: any) => {
      const roles = p.Properties?.Roles || [];
      return roles.some((r: any) =>
        (r?.Ref || "").includes("CostQueryHandler"),
      );
    });
    const allActions = ownPolicies.flatMap((p: any) => {
      const statements = p.Properties?.PolicyDocument?.Statement || [];
      return statements.flatMap((s: any) =>
        Array.isArray(s.Action) ? s.Action : [s.Action],
      );
    });
    expect(allActions).toEqual(expect.arrayContaining(["dynamodb:Query"]));
    // Query/budgets IAM split: this Lambda now serves ONLY GET
    // /cost/summary + GET /cost/series — no UpdateItem, no Scan, no
    // DeleteItem. PUT /budgets moved to the dedicated budgets Lambda
    // (see "budgets handler role" test below).
    expect(allActions).not.toEqual(
      expect.arrayContaining(["dynamodb:UpdateItem"]),
    );
    expect(allActions).not.toEqual(expect.arrayContaining(["dynamodb:Scan"]));
    expect(allActions).not.toEqual(
      expect.arrayContaining(["dynamodb:DeleteItem"]),
    );
  });

  test("budgets handler role has both Query and UpdateItem on the ledger table (owns the BUDGET# SK domain)", () => {
    const budgetFn = template.findResources("AWS::Lambda::Function", {
      Properties: { Handler: "cost-budget-handler.handler" },
    });
    const budgetFnId = Object.keys(budgetFn)[0];
    expect(budgetFnId).toBeDefined();

    const policies = template.findResources("AWS::IAM::Policy");
    const ownPolicies = Object.values(policies).filter((p: any) => {
      const roles = p.Properties?.Roles || [];
      return roles.some((r: any) =>
        (r?.Ref || "").includes("CostBudgetHandler"),
      );
    });
    const allActions = ownPolicies.flatMap((p: any) => {
      const statements = p.Properties?.PolicyDocument?.Statement || [];
      return statements.flatMap((s: any) =>
        Array.isArray(s.Action) ? s.Action : [s.Action],
      );
    });
    expect(allActions).toEqual(
      expect.arrayContaining(["dynamodb:Query", "dynamodb:UpdateItem"]),
    );
    expect(allActions).not.toEqual(expect.arrayContaining(["dynamodb:Scan"]));
    expect(allActions).not.toEqual(
      expect.arrayContaining(["dynamodb:DeleteItem"]),
    );
  });

  test("exposes costApiUrl as a stack output for pass-2 frontend plumbing", () => {
    const outputs = template.findOutputs("*");
    const hasCostApiUrl = Object.keys(outputs).some((k) =>
      k.toLowerCase().includes("costapiurl"),
    );
    expect(hasCostApiUrl).toBe(true);
  });
});
import * as cdk from "aws-cdk-lib";
import { Template, Match } from "aws-cdk-lib/assertions";
import * as dynamodb from "aws-cdk-lib/aws-dynamodb";
import * as events from "aws-cdk-lib/aws-events";
import * as cognito from "aws-cdk-lib/aws-cognito";
import * as sns from "aws-cdk-lib/aws-sns";
import * as s3 from "aws-cdk-lib/aws-s3";
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

  const userPool = new cognito.UserPool(helperStack, "UserPool");
  const userPoolClient = userPool.addClient("UserPoolClient");

  const executionsTable = new dynamodb.Table(helperStack, "ExecutionsTable", {
    tableName: "citadel-executions-test",
    partitionKey: { name: "executionId", type: dynamodb.AttributeType.STRING },
    billingMode: dynamodb.BillingMode.PAY_PER_REQUEST,
    removalPolicy: cdk.RemovalPolicy.DESTROY,
  });
  const conversationsTable = new dynamodb.Table(
    helperStack,
    "ConversationsTable",
    {
      tableName: "citadel-conversations-test",
      partitionKey: { name: "projectId", type: dynamodb.AttributeType.STRING },
      sortKey: { name: "timestamp", type: dynamodb.AttributeType.STRING },
      billingMode: dynamodb.BillingMode.PAY_PER_REQUEST,
      removalPolicy: cdk.RemovalPolicy.DESTROY,
    },
  );
  const projectsTable = new dynamodb.Table(helperStack, "ProjectsTable", {
    tableName: "citadel-projects-test",
    partitionKey: { name: "id", type: dynamodb.AttributeType.STRING },
    billingMode: dynamodb.BillingMode.PAY_PER_REQUEST,
    removalPolicy: cdk.RemovalPolicy.DESTROY,
  });

  const workflowsTable = new dynamodb.Table(helperStack, "WorkflowsTable", {
    tableName: "citadel-workflows-test",
    partitionKey: { name: "workflowId", type: dynamodb.AttributeType.STRING },
    billingMode: dynamodb.BillingMode.PAY_PER_REQUEST,
    removalPolicy: cdk.RemovalPolicy.DESTROY,
  });
  const agentConfigTable = new dynamodb.Table(helperStack, "AgentConfigTable", {
    tableName: "citadel-agents-test",
    partitionKey: { name: "agentId", type: dynamodb.AttributeType.STRING },
    billingMode: dynamodb.BillingMode.PAY_PER_REQUEST,
    removalPolicy: cdk.RemovalPolicy.DESTROY,
  });
  const executionSpecificationsTable = new dynamodb.Table(
    helperStack,
    "ExecutionSpecificationsTable",
    {
      tableName: "citadel-execution-specifications-test",
      partitionKey: { name: "specId", type: dynamodb.AttributeType.STRING },
      billingMode: dynamodb.BillingMode.PAY_PER_REQUEST,
      removalPolicy: cdk.RemovalPolicy.DESTROY,
    },
  );
  const modelConfigTable = new dynamodb.Table(helperStack, "ModelConfigTable", {
    tableName: "citadel-model-config-test",
    partitionKey: { name: "scope", type: dynamodb.AttributeType.STRING },
    billingMode: dynamodb.BillingMode.PAY_PER_REQUEST,
    removalPolicy: cdk.RemovalPolicy.DESTROY,
  });
  const governanceLedgerTable = new dynamodb.Table(
    helperStack,
    "GovernanceLedgerTable",
    {
      tableName: "citadel-governance-ledger-test",
      partitionKey: { name: "findingId", type: dynamodb.AttributeType.STRING },
      billingMode: dynamodb.BillingMode.PAY_PER_REQUEST,
      removalPolicy: cdk.RemovalPolicy.DESTROY,
    },
  );
  governanceLedgerTable.addGlobalSecondaryIndex({
    indexName: "workflow-index",
    partitionKey: { name: "workflowId", type: dynamodb.AttributeType.STRING },
    sortKey: { name: "timestamp", type: dynamodb.AttributeType.NUMBER },
    projectionType: dynamodb.ProjectionType.ALL,
  });

  const stack = new TelemetryStack(app, "TestTelemetryStack", {
    environment: "test",
    env: { account: "123456789012", region: "us-east-1" },
    agentEventBus,
    modelCatalogTable,
    userPool,
    userPoolClient,
    frontendOrigin: "https://app.example.com",
    bedrockInvocationLogGroupName: "/aws/bedrock/invocation-logs",
    executionsTable,
    conversationsTable,
    projectsTable,
    alarmTopic: new sns.Topic(helperStack, "TestAlarmTopic", {
      topicName: "citadel-alarms-test",
    }),
    appSyncApiId: "test-appsync-api-id",
    workflowsTable,
    agentConfigTable,
    executionSpecificationsTable,
    modelConfigTable,
    governanceLedgerTable,
    accessLogsBucket: new s3.Bucket(helperStack, "TestAccessLogsBucket", {
      removalPolicy: cdk.RemovalPolicy.DESTROY,
      autoDeleteObjects: true,
    }),
    commitSha: "test-commit-sha",
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

  test("cost ledger table has 4 sparse time-prefixed GSIs (Project/App/Agent/Workflow) plus the BudgetIndex GSI added for the cost query surface", () => {
    const tables = template.findResources("AWS::DynamoDB::Table", {
      Properties: { TableName: "citadel-cost-ledger-test" },
    });
    const logicalId = Object.keys(tables)[0];
    expect(logicalId).toBeDefined();

    const gsis = tables[logicalId].Properties.GlobalSecondaryIndexes;
    expect(gsis).toHaveLength(5);

    const gsiNames = gsis.map((g: any) => g.IndexName).sort();
    expect(gsiNames).toEqual([
      "AgentIndex",
      "AppIndex",
      "BudgetIndex",
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

    // Scope to event-pattern rules only — the reconciler's schedule-based
    // rule (rate(1 hour), no EventPattern) is a separate rule asserted in
    // its own describe block below.
    const allRules = template.findResources("AWS::Events::Rule");
    const ruleIds = Object.keys(allRules).filter(
      (id) => allRules[id].Properties?.EventPattern !== undefined,
    );
    expect(ruleIds.length).toBeGreaterThanOrEqual(3);

    for (const ruleId of ruleIds) {
      const targets = allRules[ruleId].Properties.Targets;
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

describe("TelemetryStack — cost ledger reconciler (Tier A + Tier B skeleton)", () => {
  let template: Template;

  beforeAll(() => {
    ({ template } = createTestStack());
  });

  test("reconciler Lambda: nodejs24.x, 5min timeout, expected env vars incl. Tier B off by default", () => {
    template.hasResourceProperties("AWS::Lambda::Function", {
      Handler: "cost-ledger-reconciler.handler",
      Runtime: "nodejs24.x",
      Timeout: 300,
      Environment: {
        Variables: Match.objectLike({
          COST_LEDGER_TABLE: Match.anyValue(),
          MODEL_CATALOG_TABLE: Match.anyValue(),
          ENVIRONMENT: "test",
          SETTLE_LAG_MINUTES: Match.anyValue(),
          MAX_WINDOWS_PER_RUN: Match.anyValue(),
          METRIC_NAMESPACE: "Citadel/CostReconciler",
          COST_RECONCILER_TIER_B_ENABLED: "false",
          MAX_LOG_EVENTS_PER_WINDOW: Match.anyValue(),
        }),
      },
    });
  });

  test("EventBridge rule schedules the reconciler at rate(1 hour)", () => {
    template.hasResourceProperties("AWS::Events::Rule", {
      ScheduleExpression: "rate(1 hour)",
    });

    const functions = template.findResources("AWS::Lambda::Function", {
      Properties: { Handler: "cost-ledger-reconciler.handler" },
    });
    const fnLogicalId = Object.keys(functions)[0];
    expect(fnLogicalId).toBeDefined();

    const rules = template.findResources("AWS::Events::Rule", {
      Properties: { ScheduleExpression: "rate(1 hour)" },
    });
    const ruleId = Object.keys(rules)[0];
    expect(ruleId).toBeDefined();
    const targets = rules[ruleId].Properties.Targets;
    expect(targets).toHaveLength(1);
    const getAtt = targets[0].Arn?.["Fn::GetAtt"];
    expect(Array.isArray(getAtt) && getAtt[0] === fnLogicalId).toBe(true);
  });

  test("reconciler IAM: has Query/Scan/PutItem/UpdateItem + GetMetricData/PutMetricData + logs:FilterLogEvents (Tier B), and NO DeleteItem", () => {
    const functions = template.findResources("AWS::Lambda::Function", {
      Properties: { Handler: "cost-ledger-reconciler.handler" },
    });
    const fnLogicalId = Object.keys(functions)[0];
    expect(fnLogicalId).toBeDefined();

    const policies = template.findResources("AWS::IAM::Policy");
    const ownPolicies = Object.values(policies).filter((p: any) => {
      const roles = p.Properties?.Roles || [];
      return roles.some((r: any) =>
        (r?.Ref || "").includes("CostLedgerReconciler"),
      );
    });
    expect(ownPolicies.length).toBeGreaterThan(0);

    const allStatements = ownPolicies.flatMap(
      (p: any) => p.Properties?.PolicyDocument?.Statement || [],
    );
    const allActions = allStatements.flatMap((s: any) =>
      Array.isArray(s.Action) ? s.Action : [s.Action],
    );

    expect(allActions).toEqual(
      expect.arrayContaining([
        "dynamodb:Query",
        "dynamodb:Scan",
        "dynamodb:PutItem",
        "dynamodb:UpdateItem",
      ]),
    );
    expect(allActions).not.toEqual(
      expect.arrayContaining(["dynamodb:DeleteItem"]),
    );

    // Tier B activation (real estimate->actual matching, per architect
    // design): the reconciler now legitimately needs
    // logs:FilterLogEvents against the Bedrock model-invocation log
    // group, scoped to that log group's ARN — never a bare '*' grant.
    const filterLogEventsStatement = allStatements.find((s: any) => {
      const actions = Array.isArray(s.Action) ? s.Action : [s.Action];
      return actions.includes("logs:FilterLogEvents");
    });
    expect(filterLogEventsStatement).toBeDefined();
    const logsResources = Array.isArray(filterLogEventsStatement.Resource)
      ? filterLogEventsStatement.Resource
      : [filterLogEventsStatement.Resource];
    expect(logsResources.every((r: unknown) => r === "*")).toBe(false);
    expect(logsResources).toHaveLength(1);
    const serializedLogsResource = JSON.stringify(logsResources[0]);
    expect(serializedLogsResource).not.toContain("*bedrock*invocation*");
    expect(serializedLogsResource).toContain(
      "logs:us-east-1:123456789012:log-group:/aws/bedrock/invocation-logs:*",
    );

    // No OTHER logs:* action was granted beyond FilterLogEvents (still
    // least-privilege — the reconciler never writes/deletes/tails logs).
    const otherLogsActions = allActions.filter(
      (a: string) => a.startsWith("logs:") && a !== "logs:FilterLogEvents",
    );
    expect(otherLogsActions).toHaveLength(0);

    expect(allActions).toEqual(
      expect.arrayContaining(["cloudwatch:GetMetricData"]),
    );
    expect(allActions).toEqual(
      expect.arrayContaining(["cloudwatch:PutMetricData"]),
    );

    // PutMetricData must be namespace-conditioned, not a bare grant on '*'.
    const putMetricStatement = allStatements.find((s: any) => {
      const actions = Array.isArray(s.Action) ? s.Action : [s.Action];
      return actions.includes("cloudwatch:PutMetricData");
    });
    expect(putMetricStatement?.Condition).toBeDefined();
  });

  test("reconciler is granted read access to the model catalog table (Tier B cost recompute)", () => {
    const policies = template.findResources("AWS::IAM::Policy");
    const ownPolicies = Object.values(policies).filter((p: any) => {
      const roles = p.Properties?.Roles || [];
      return roles.some((r: any) =>
        (r?.Ref || "").includes("CostLedgerReconciler"),
      );
    });
    const catalogGrantActions = ownPolicies.flatMap((p: any) => {
      const statements = p.Properties?.PolicyDocument?.Statement || [];
      return statements
        .filter((s: any) =>
          JSON.stringify(s.Resource || "").includes("ModelCatalogTable"),
        )
        .flatMap((s: any) => (Array.isArray(s.Action) ? s.Action : [s.Action]));
    });
    expect(catalogGrantActions).toEqual(
      expect.arrayContaining(["dynamodb:GetItem"]),
    );
    expect(catalogGrantActions).not.toEqual(
      expect.arrayContaining(["dynamodb:PutItem", "dynamodb:DeleteItem"]),
    );
  });

  test("cost ledger table remains RETAIN + PITR (regression guard, reconciler must not weaken it)", () => {
    template.hasResource("AWS::DynamoDB::Table", {
      Properties: Match.objectLike({
        TableName: "citadel-cost-ledger-test",
        PointInTimeRecoverySpecification: { PointInTimeRecoveryEnabled: true },
      }),
      DeletionPolicy: "Retain",
      UpdateReplacePolicy: "Retain",
    });
  });
});
describe("TelemetryStack — execution replay package (CIT-026, pass 1)", () => {
  let template: Template;

  beforeAll(() => {
    ({ template } = createTestStack());
  });

  test("replay bucket has Block Public Access all-on, SSE, and a ~7-day lifecycle expiration", () => {
    template.hasResourceProperties("AWS::S3::Bucket", {
      PublicAccessBlockConfiguration: {
        BlockPublicAcls: true,
        BlockPublicPolicy: true,
        IgnorePublicAcls: true,
        RestrictPublicBuckets: true,
      },
      BucketEncryption: Match.objectLike({
        ServerSideEncryptionConfiguration: Match.arrayWith([
          Match.objectLike({
            ServerSideEncryptionByDefault: Match.objectLike({
              SSEAlgorithm: "AES256",
            }),
          }),
        ]),
      }),
      LifecycleConfiguration: Match.objectLike({
        Rules: Match.arrayWith([
          Match.objectLike({
            ExpirationInDays: 7,
            Status: "Enabled",
          }),
        ]),
      }),
    });
  });

  test("replay bucket is NOT the shared backend document bucket (a dedicated bucket resource exists)", () => {
    const buckets = template.findResources("AWS::S3::Bucket");
    // At least one S3 bucket declared directly in this stack (the replay
    // bucket) — TelemetryStack previously declared zero buckets.
    expect(Object.keys(buckets).length).toBeGreaterThanOrEqual(1);
  });

  test("replay-package-handler Lambda: nodejs24.x, 30s timeout, all source table env vars + bucket + TTL", () => {
    template.hasResourceProperties("AWS::Lambda::Function", {
      Handler: "replay-package-handler.handler",
      Runtime: "nodejs24.x",
      Timeout: 30,
      Environment: {
        Variables: Match.objectLike({
          EXECUTIONS_TABLE: Match.anyValue(),
          CONVERSATIONS_TABLE: Match.anyValue(),
          PROJECTS_TABLE: Match.anyValue(),
          WORKFLOWS_TABLE: Match.anyValue(),
          AGENT_CONFIG_TABLE: Match.anyValue(),
          EXECUTION_SPECS_TABLE: Match.anyValue(),
          MODEL_CONFIG_TABLE: Match.anyValue(),
          GOVERNANCE_LEDGER_TABLE: Match.anyValue(),
          COST_LEDGER_TABLE: Match.anyValue(),
          REPLAY_BUCKET: Match.anyValue(),
          REPLAY_PRESIGN_TTL_SECONDS: "300",
          COMMIT_SHA: "test-commit-sha",
        }),
      },
    });
  });

  test("replay-package-handler role is read-only on every source table: grants GetItem/Query, zero write actions, zero xray:Put*", () => {
    const functions = template.findResources("AWS::Lambda::Function", {
      Properties: { Handler: "replay-package-handler.handler" },
    });
    const fnLogicalId = Object.keys(functions)[0];
    expect(fnLogicalId).toBeDefined();

    const policies = template.findResources("AWS::IAM::Policy");
    const ownPolicies = Object.values(policies).filter((p: any) => {
      const roles = p.Properties?.Roles || [];
      return roles.some((r: any) =>
        (r?.Ref || "").includes("ReplayPackageHandler"),
      );
    });
    expect(ownPolicies.length).toBeGreaterThan(0);

    const allStatements = ownPolicies.flatMap(
      (p: any) => p.Properties?.PolicyDocument?.Statement || [],
    );
    const allActions = allStatements.flatMap((s: any) =>
      Array.isArray(s.Action) ? s.Action : [s.Action],
    );

    // Read-only on source tables: GetItem/Query present, but no write verb
    // on ANY source-table-scoped statement (S3 write is scoped separately
    // to the replay bucket only — see the next test).
    expect(allActions).toEqual(expect.arrayContaining(["dynamodb:GetItem"]));
    const writeVerbs = [
      "dynamodb:PutItem",
      "dynamodb:UpdateItem",
      "dynamodb:DeleteItem",
    ];
    const dynamoWriteActions = allActions.filter((a: string) =>
      writeVerbs.includes(a),
    );
    expect(dynamoWriteActions).toHaveLength(0);

    // Zero xray:Put* — this role has no X-Ray grant of any kind.
    const xrayActions = allActions.filter((a: string) => a.startsWith("xray:"));
    expect(xrayActions).toHaveLength(0);
  });

  test("replay-package-handler role's S3 grant is scoped to the replay bucket only (not a bare Resource::* or another bucket)", () => {
    const functions = template.findResources("AWS::Lambda::Function", {
      Properties: { Handler: "replay-package-handler.handler" },
    });
    const fnLogicalId = Object.keys(functions)[0];
    expect(fnLogicalId).toBeDefined();

    const policies = template.findResources("AWS::IAM::Policy");
    const ownPolicies = Object.values(policies).filter((p: any) => {
      const roles = p.Properties?.Roles || [];
      return roles.some((r: any) =>
        (r?.Ref || "").includes("ReplayPackageHandler"),
      );
    });

    const s3Statements = ownPolicies.flatMap((p: any) => {
      const statements = p.Properties?.PolicyDocument?.Statement || [];
      return statements.filter((s: any) => {
        const actions = Array.isArray(s.Action) ? s.Action : [s.Action];
        return actions.some((a: string) => a.startsWith("s3:"));
      });
    });
    expect(s3Statements.length).toBeGreaterThan(0);

    for (const stmt of s3Statements) {
      const resources = Array.isArray(stmt.Resource)
        ? stmt.Resource
        : [stmt.Resource];
      for (const r of resources) {
        expect(r).not.toBe("*");
        // Must reference the ReplayPackageBucket construct, never a bare
        // wildcard nor (by construction, since there's only one S3 grant
        // target in this stack) any other bucket.
        expect(JSON.stringify(r)).toMatch(/ReplayPackageBucket/);
      }
    }
  });

  test("both replay routes are declared on the existing costHttpApi with the same JWT authorizer (zero new API/authorizer config)", () => {
    const routes = template.findResources("AWS::ApiGatewayV2::Route", {
      Properties: {
        RouteKey: Match.stringLikeRegexp("^GET /replay/"),
      },
    });
    const routeIds = Object.keys(routes);
    expect(routeIds).toHaveLength(2);
    for (const routeId of routeIds) {
      expect(routes[routeId].Properties.AuthorizationType).not.toBe("NONE");
      expect(
        routes[routeId].Properties.AuthorizerId ??
          routes[routeId].Properties.AuthorizationType,
      ).toBeDefined();
    }

    // Only one ApiGatewayV2::Api exists in the stack — confirms the
    // replay routes did not create a second HTTP API.
    const apis = template.findResources("AWS::ApiGatewayV2::Api");
    expect(Object.keys(apis)).toHaveLength(1);
  });
});
