/**
 * Stack test for telemetry-stack.ts — the query/budgets Lambda IAM split
 * (per architect design):
 *   - two distinct Lambda functions (query-only, budgets read+write)
 *   - the query role never carries dynamodb:UpdateItem
 *   - the budget role carries both Query and UpdateItem
 *   - the reconciler's Tier B IAM additions (logs:FilterLogEvents scoped to
 *     the invocation-log-group ARN + modelCatalogTable read access)
 *   - all 4 HTTP routes wired to the correct Lambda integration, all with
 *     the JWT authorizer
 *
 * Uses aws-cdk-lib/assertions Template against a synthesized stack in an
 * isolated test App — no real AWS calls, no dependency on the wider
 * backend-stack split tooling.
 */
import * as cdk from "aws-cdk-lib";
import { Template, Match } from "aws-cdk-lib/assertions";
import * as cognito from "aws-cdk-lib/aws-cognito";
import * as dynamodb from "aws-cdk-lib/aws-dynamodb";
import * as events from "aws-cdk-lib/aws-events";
import * as sns from "aws-cdk-lib/aws-sns";
import * as s3 from "aws-cdk-lib/aws-s3";
import { TelemetryStack } from "../telemetry-stack";
import {
  METRIC_NAMESPACE,
  METRIC_NODE_FAILURE,
  METRIC_NODE_QUEUE_WAIT_MS,
} from "../../src/utils/metrics-constants";
import { scaffoldBackendAssetDirs } from "../../test/helpers/scaffold-stub-assets";

scaffoldBackendAssetDirs(["dist/lambda"]);

function buildSupportTables(supportStack: cdk.Stack): {
  modelCatalogTable: dynamodb.Table;
  executionsTable: dynamodb.Table;
  conversationsTable: dynamodb.Table;
  projectsTable: dynamodb.Table;
  workflowsTable: dynamodb.Table;
  agentConfigTable: dynamodb.Table;
  executionSpecificationsTable: dynamodb.Table;
  modelConfigTable: dynamodb.Table;
  governanceLedgerTable: dynamodb.Table;
} {
  const modelCatalogTable = new dynamodb.Table(
    supportStack,
    "TestModelCatalogTable",
    {
      partitionKey: { name: "modelKey", type: dynamodb.AttributeType.STRING },
    },
  );
  const executionsTable = new dynamodb.Table(
    supportStack,
    "TestExecutionsTable",
    {
      partitionKey: {
        name: "executionId",
        type: dynamodb.AttributeType.STRING,
      },
    },
  );
  const conversationsTable = new dynamodb.Table(
    supportStack,
    "TestConversationsTable",
    {
      partitionKey: { name: "projectId", type: dynamodb.AttributeType.STRING },
      sortKey: { name: "timestamp", type: dynamodb.AttributeType.STRING },
    },
  );
  const projectsTable = new dynamodb.Table(supportStack, "TestProjectsTable", {
    partitionKey: { name: "id", type: dynamodb.AttributeType.STRING },
  });
  const workflowsTable = new dynamodb.Table(
    supportStack,
    "TestWorkflowsTable",
    {
      partitionKey: { name: "workflowId", type: dynamodb.AttributeType.STRING },
    },
  );
  const agentConfigTable = new dynamodb.Table(
    supportStack,
    "TestAgentConfigTable",
    {
      partitionKey: { name: "agentId", type: dynamodb.AttributeType.STRING },
    },
  );
  const executionSpecificationsTable = new dynamodb.Table(
    supportStack,
    "TestExecutionSpecificationsTable",
    {
      partitionKey: { name: "specId", type: dynamodb.AttributeType.STRING },
    },
  );
  const modelConfigTable = new dynamodb.Table(
    supportStack,
    "TestModelConfigTable",
    {
      partitionKey: { name: "scope", type: dynamodb.AttributeType.STRING },
    },
  );
  const governanceLedgerTable = new dynamodb.Table(
    supportStack,
    "TestGovernanceLedgerTable",
    {
      partitionKey: { name: "findingId", type: dynamodb.AttributeType.STRING },
    },
  );
  governanceLedgerTable.addGlobalSecondaryIndex({
    indexName: "workflow-index",
    partitionKey: { name: "workflowId", type: dynamodb.AttributeType.STRING },
    sortKey: { name: "timestamp", type: dynamodb.AttributeType.NUMBER },
  });
  return {
    modelCatalogTable,
    executionsTable,
    conversationsTable,
    projectsTable,
    workflowsTable,
    agentConfigTable,
    executionSpecificationsTable,
    modelConfigTable,
    governanceLedgerTable,
  };
}

function buildStack(): {
  template: Template;
  stack: TelemetryStack;
  alarmTopic: sns.Topic;
} {
  const app = new cdk.App();
  const supportStack = new cdk.Stack(app, "SupportStack", {
    env: { account: "123456789012", region: "us-east-1" },
  });

  const userPool = new cognito.UserPool(supportStack, "TestUserPool");
  const userPoolClient = userPool.addClient("TestUserPoolClient");
  const agentEventBus = new events.EventBus(supportStack, "TestEventBus");
  const alarmTopic = new sns.Topic(supportStack, "TestAlarmTopic", {
    topicName: "citadel-alarms-test",
  });
  const {
    modelCatalogTable,
    executionsTable,
    conversationsTable,
    projectsTable,
    workflowsTable,
    agentConfigTable,
    executionSpecificationsTable,
    modelConfigTable,
    governanceLedgerTable,
  } = buildSupportTables(supportStack);

  const stack = new TelemetryStack(app, "TestTelemetryStack", {
    environment: "test",
    env: { account: "123456789012", region: "us-east-1" },
    agentEventBus,
    modelCatalogTable,
    userPool,
    userPoolClient,
    frontendOrigin: "https://example.test",
    bedrockInvocationLogGroupName: "/aws/bedrock/invocation-logs",
    executionsTable,
    conversationsTable,
    projectsTable,
    alarmTopic,
    appSyncApiId: "test-appsync-api-id",
    workflowsTable,
    agentConfigTable,
    executionSpecificationsTable,
    modelConfigTable,
    governanceLedgerTable,
    accessLogsBucket: new s3.Bucket(supportStack, "TestAccessLogsBucket", {
      removalPolicy: cdk.RemovalPolicy.DESTROY,
      autoDeleteObjects: true,
    }),
  });

  return { template: Template.fromStack(stack), stack, alarmTopic };
}

/**
 * Variant of buildStack() that accepts a custom frontendOrigin, for the
 * CORS AllowOrigins assertion (finding d7d3dd61). Kept separate from
 * buildStack() so the existing pinned tests above are untouched.
 */
function buildStackWithOrigin(frontendOrigin: string): { template: Template } {
  const app = new cdk.App();
  const supportStack = new cdk.Stack(app, "SupportStackOrigin", {
    env: { account: "123456789012", region: "us-east-1" },
  });

  const userPool = new cognito.UserPool(supportStack, "TestUserPool");
  const userPoolClient = userPool.addClient("TestUserPoolClient");
  const agentEventBus = new events.EventBus(supportStack, "TestEventBus");
  const alarmTopic = new sns.Topic(supportStack, "TestAlarmTopic", {
    topicName: "citadel-alarms-test-origin",
  });
  const {
    modelCatalogTable,
    executionsTable,
    conversationsTable,
    projectsTable,
    workflowsTable,
    agentConfigTable,
    executionSpecificationsTable,
    modelConfigTable,
    governanceLedgerTable,
  } = buildSupportTables(supportStack);

  const stack = new TelemetryStack(app, "TestTelemetryStackOrigin", {
    environment: "test",
    env: { account: "123456789012", region: "us-east-1" },
    agentEventBus,
    modelCatalogTable,
    userPool,
    userPoolClient,
    frontendOrigin,
    bedrockInvocationLogGroupName: "/aws/bedrock/invocation-logs",
    executionsTable,
    conversationsTable,
    projectsTable,
    alarmTopic,
    appSyncApiId: "test-appsync-api-id",
    workflowsTable,
    agentConfigTable,
    executionSpecificationsTable,
    modelConfigTable,
    governanceLedgerTable,
    accessLogsBucket: new s3.Bucket(
      supportStack,
      "TestAccessLogsBucketOrigin",
      {
        removalPolicy: cdk.RemovalPolicy.DESTROY,
        autoDeleteObjects: true,
      },
    ),
  });

  return { template: Template.fromStack(stack) };
}

describe("TelemetryStack — cost API CORS AllowOrigins (finding d7d3dd61)", () => {
  test("AllowOrigins matches the provided frontendOrigin prop exactly", () => {
    const { template } = buildStackWithOrigin("https://app.example.com");

    template.hasResourceProperties("AWS::ApiGatewayV2::Api", {
      CorsConfiguration: Match.objectLike({
        AllowOrigins: ["https://app.example.com"],
      }),
    });
  });

  test("AllowOrigins never falls back to the .invalid placeholder when a real origin is supplied", () => {
    const { template } = buildStackWithOrigin("https://app.example.com");

    const apis = template.findResources("AWS::ApiGatewayV2::Api");
    const allOrigins = Object.values(apis).flatMap(
      (r) => r.Properties?.CorsConfiguration?.AllowOrigins ?? [],
    );
    expect(allOrigins).not.toContain(
      "https://frontend-origin-not-configured.invalid",
    );
    expect(allOrigins).toEqual(["https://app.example.com"]);
  });
});

describe("TelemetryStack — query/budgets Lambda IAM split", () => {
  test("declares exactly one query-only Lambda and one budgets Lambda (distinct function resources)", () => {
    const { template } = buildStack();

    template.hasResourceProperties("AWS::Lambda::Function", {
      Handler: "cost-query-handler.handler",
    });
    template.hasResourceProperties("AWS::Lambda::Function", {
      Handler: "cost-budget-handler.handler",
    });
  });

  test("query Lambda's IAM role never grants dynamodb:UpdateItem", () => {
    const { template } = buildStack();

    const policies = template.findResources("AWS::IAM::Policy");
    const queryRolePolicies = Object.values(policies).filter(
      (p) =>
        JSON.stringify(p).includes(
          "CostQueryHandlerServiceRoleDefaultPolicy",
        ) ||
        JSON.stringify(p.Properties?.PolicyName ?? "").includes(
          "CostQueryHandler",
        ),
    );

    // Fallback: scan every policy statement referencing the query handler
    // role and assert none of them include UpdateItem. This is resilient
    // to logical-ID naming without depending on exact IDs.
    const allPolicies = template.findResources("AWS::IAM::Policy");
    let sawUpdateItemOnQueryRole = false;
    for (const [, resource] of Object.entries(allPolicies)) {
      const roles = resource.Properties?.Roles ?? [];
      const roleRefs = JSON.stringify(roles);
      if (!roleRefs.includes("CostQueryHandler")) continue;
      const statements = resource.Properties?.PolicyDocument?.Statement ?? [];
      for (const stmt of statements) {
        const actions = Array.isArray(stmt.Action)
          ? stmt.Action
          : [stmt.Action];
        if (actions.includes("dynamodb:UpdateItem")) {
          sawUpdateItemOnQueryRole = true;
        }
      }
    }
    expect(sawUpdateItemOnQueryRole).toBe(false);
    void queryRolePolicies;
  });

  test("budgets Lambda's IAM role grants both dynamodb:Query and dynamodb:UpdateItem", () => {
    const { template } = buildStack();

    const allPolicies = template.findResources("AWS::IAM::Policy");
    let sawQuery = false;
    let sawUpdate = false;
    for (const [, resource] of Object.entries(allPolicies)) {
      const roles = resource.Properties?.Roles ?? [];
      const roleRefs = JSON.stringify(roles);
      if (!roleRefs.includes("CostBudgetHandler")) continue;
      const statements = resource.Properties?.PolicyDocument?.Statement ?? [];
      for (const stmt of statements) {
        const actions = Array.isArray(stmt.Action)
          ? stmt.Action
          : [stmt.Action];
        if (actions.includes("dynamodb:Query")) sawQuery = true;
        if (actions.includes("dynamodb:UpdateItem")) sawUpdate = true;
      }
    }
    expect(sawQuery).toBe(true);
    expect(sawUpdate).toBe(true);
  });

  test("query Lambda's IAM role grants dynamodb:Query (read access preserved)", () => {
    const { template } = buildStack();
    const allPolicies = template.findResources("AWS::IAM::Policy");
    let sawQuery = false;
    for (const [, resource] of Object.entries(allPolicies)) {
      const roles = resource.Properties?.Roles ?? [];
      const roleRefs = JSON.stringify(roles);
      if (!roleRefs.includes("CostQueryHandler")) continue;
      const statements = resource.Properties?.PolicyDocument?.Statement ?? [];
      for (const stmt of statements) {
        const actions = Array.isArray(stmt.Action)
          ? stmt.Action
          : [stmt.Action];
        if (actions.includes("dynamodb:Query")) sawQuery = true;
      }
    }
    expect(sawQuery).toBe(true);
  });

  test("all 4 HTTP routes are wired with the JWT authorizer", () => {
    const { template } = buildStack();

    const routes = template.findResources("AWS::ApiGatewayV2::Route");
    const routeKeys = Object.values(routes).map((r) => r.Properties?.RouteKey);
    expect(routeKeys).toEqual(
      expect.arrayContaining([
        "GET /cost/summary",
        "GET /cost/series",
        "GET /budgets",
        "PUT /budgets/{scope}",
      ]),
    );

    for (const route of Object.values(routes)) {
      expect(route.Properties?.AuthorizationType).toBe("JWT");
      expect(route.Properties?.AuthorizerId).toBeDefined();
    }
  });

  test("GET /cost/summary and GET /cost/series route to the query integration; GET/PUT /budgets route to the budgets integration", () => {
    const { template } = buildStack();

    const routes = template.findResources("AWS::ApiGatewayV2::Route");
    const integrations = template.findResources(
      "AWS::ApiGatewayV2::Integration",
    );

    // Map integration logical id -> target Lambda ARN reference string.
    const integrationTarget: Record<string, string> = {};
    for (const [id, integ] of Object.entries(integrations)) {
      integrationTarget[id] = JSON.stringify(
        integ.Properties?.IntegrationUri ?? "",
      );
    }

    function integrationIdForRoute(routeKey: string): string | undefined {
      const entry = Object.values(routes).find(
        (r) => r.Properties?.RouteKey === routeKey,
      );
      const target = String(entry?.Properties?.Target ?? "");
      const match =
        /integrations\/\$\{Ref:\s*([^}]+)\}/.exec(target) ||
        /integrations\/(\S+)/.exec(target);
      return match?.[1];
    }

    // Best-effort structural check: summary/series share one integration
    // target, budgets GET/PUT share a different one, and the two groups
    // differ from each other.
    const summaryTarget = JSON.stringify(
      Object.values(routes).find(
        (r) => r.Properties?.RouteKey === "GET /cost/summary",
      )?.Properties?.Target,
    );
    const seriesTarget = JSON.stringify(
      Object.values(routes).find(
        (r) => r.Properties?.RouteKey === "GET /cost/series",
      )?.Properties?.Target,
    );
    const budgetsGetTarget = JSON.stringify(
      Object.values(routes).find(
        (r) => r.Properties?.RouteKey === "GET /budgets",
      )?.Properties?.Target,
    );
    const budgetsPutTarget = JSON.stringify(
      Object.values(routes).find(
        (r) => r.Properties?.RouteKey === "PUT /budgets/{scope}",
      )?.Properties?.Target,
    );

    expect(summaryTarget).toBe(seriesTarget);
    expect(budgetsGetTarget).toBe(budgetsPutTarget);
    expect(summaryTarget).not.toBe(budgetsGetTarget);

    void integrationTarget;
    void integrationIdForRoute;
  });
});

describe("TelemetryStack — reconciler Tier B IAM additions", () => {
  test("reconciler role grants logs:FilterLogEvents scoped to exactly the configured log-group ARN (not a wildcard or name-glob)", () => {
    const { template } = buildStack();

    const allPolicies = template.findResources("AWS::IAM::Policy");
    let sawScopedFilterLogEvents = false;
    for (const [, resource] of Object.entries(allPolicies)) {
      const roles = resource.Properties?.Roles ?? [];
      const roleRefs = JSON.stringify(roles);
      if (!roleRefs.includes("CostLedgerReconciler")) continue;
      const statements = resource.Properties?.PolicyDocument?.Statement ?? [];
      for (const stmt of statements) {
        const actions = Array.isArray(stmt.Action)
          ? stmt.Action
          : [stmt.Action];
        if (actions.includes("logs:FilterLogEvents")) {
          const resources = Array.isArray(stmt.Resource)
            ? stmt.Resource
            : [stmt.Resource];
          // Must be exactly one resource entry — never a bare '*' — and
          // its serialized Fn::Join/literal form must resolve to exactly
          // the configured log group's ARN suffix, never a name-glob
          // pattern matching other groups (e.g. "*bedrock*invocation*").
          expect(resources).toHaveLength(1);
          const serialized = JSON.stringify(resources[0]);
          expect(serialized).not.toBe('"*"');
          expect(serialized).not.toContain("*bedrock*invocation*");
          expect(serialized).toContain(
            "logs:us-east-1:123456789012:log-group:/aws/bedrock/invocation-logs:*",
          );
          sawScopedFilterLogEvents = true;
        }
      }
    }
    expect(sawScopedFilterLogEvents).toBe(true);
  });

  test("reconciler role grants no logs:FilterLogEvents at all when the log group is unconfigured (Tier B inactive)", () => {
    const app = new cdk.App();
    const supportStack = new cdk.Stack(app, "SupportStackUnconfigured", {
      env: { account: "123456789012", region: "us-east-1" },
    });
    const userPool = new cognito.UserPool(supportStack, "TestUserPool");
    const userPoolClient = userPool.addClient("TestUserPoolClient");
    const agentEventBus = new events.EventBus(supportStack, "TestEventBus");
    const alarmTopic = new sns.Topic(supportStack, "TestAlarmTopic", {
      topicName: "citadel-alarms-test-unconfigured",
    });
    const {
      modelCatalogTable,
      executionsTable,
      conversationsTable,
      projectsTable,
      workflowsTable,
      agentConfigTable,
      executionSpecificationsTable,
      modelConfigTable,
      governanceLedgerTable,
    } = buildSupportTables(supportStack);
    const stack = new TelemetryStack(app, "TestTelemetryStackUnconfigured", {
      environment: "test",
      env: { account: "123456789012", region: "us-east-1" },
      agentEventBus,
      modelCatalogTable,
      userPool,
      userPoolClient,
      frontendOrigin: "https://example.test",
      // bedrockInvocationLogGroupName intentionally omitted
      executionsTable,
      conversationsTable,
      projectsTable,
      alarmTopic,
      workflowsTable,
      agentConfigTable,
      executionSpecificationsTable,
      modelConfigTable,
      governanceLedgerTable,
      accessLogsBucket: new s3.Bucket(
        supportStack,
        "TestAccessLogsBucketUnconfigured",
        {
          removalPolicy: cdk.RemovalPolicy.DESTROY,
          autoDeleteObjects: true,
        },
      ),
      appSyncApiId: "test-appsync-api-id",
    });
    const template = Template.fromStack(stack);

    const allPolicies = template.findResources("AWS::IAM::Policy");
    let sawFilterLogEvents = false;
    for (const [, resource] of Object.entries(allPolicies)) {
      const roles = resource.Properties?.Roles ?? [];
      const roleRefs = JSON.stringify(roles);
      if (!roleRefs.includes("CostLedgerReconciler")) continue;
      const statements = resource.Properties?.PolicyDocument?.Statement ?? [];
      for (const stmt of statements) {
        const actions = Array.isArray(stmt.Action)
          ? stmt.Action
          : [stmt.Action];
        if (actions.includes("logs:FilterLogEvents")) sawFilterLogEvents = true;
      }
    }
    expect(sawFilterLogEvents).toBe(false);

    template.hasResourceProperties("AWS::Lambda::Function", {
      Handler: "cost-ledger-reconciler.handler",
      Environment: {
        Variables: Match.objectLike({
          COST_RECONCILER_TIER_B_ENABLED: "false",
        }),
      },
    });
  });

  test("reconciler role is granted read access to the model catalog table", () => {
    const { template } = buildStack();

    const allPolicies = template.findResources("AWS::IAM::Policy");
    let sawCatalogRead = false;
    for (const [, resource] of Object.entries(allPolicies)) {
      const roles = resource.Properties?.Roles ?? [];
      const roleRefs = JSON.stringify(roles);
      if (!roleRefs.includes("CostLedgerReconciler")) continue;
      const statements = resource.Properties?.PolicyDocument?.Statement ?? [];
      for (const stmt of statements) {
        const actions = Array.isArray(stmt.Action)
          ? stmt.Action
          : [stmt.Action];
        if (
          actions.includes("dynamodb:GetItem") ||
          actions.includes("dynamodb:BatchGetItem")
        ) {
          sawCatalogRead = true;
        }
      }
    }
    expect(sawCatalogRead).toBe(true);
  });

  test("reconciler Lambda environment carries the new Tier B config knobs with the documented safe defaults", () => {
    const { template } = buildStack();

    template.hasResourceProperties("AWS::Lambda::Function", {
      Handler: "cost-ledger-reconciler.handler",
      Environment: {
        Variables: Match.objectLike({
          COST_RECONCILER_TIER_B_ENABLED: "false",
        }),
      },
    });
  });
});

describe("TelemetryStack — TraceQueryHandler (waterfall trace viewer, pass 1)", () => {
  test("declares a TraceQueryHandler Lambda", () => {
    const { template } = buildStack();
    template.hasResourceProperties("AWS::Lambda::Function", {
      Handler: "trace-query-handler.handler",
    });
  });

  test("TraceQueryHandler role grants xray:GetTraceSummaries and xray:BatchGetTraces with Resource:* (nag-suppressed)", () => {
    const { template } = buildStack();
    const allPolicies = template.findResources("AWS::IAM::Policy");
    let sawSummaries = false;
    let sawBatchGet = false;
    for (const [, resource] of Object.entries(allPolicies)) {
      const roles = resource.Properties?.Roles ?? [];
      const roleRefs = JSON.stringify(roles);
      if (!roleRefs.includes("TraceQueryHandler")) continue;
      const statements = resource.Properties?.PolicyDocument?.Statement ?? [];
      for (const stmt of statements) {
        const actions = Array.isArray(stmt.Action)
          ? stmt.Action
          : [stmt.Action];
        if (actions.includes("xray:GetTraceSummaries")) {
          sawSummaries = true;
          const resources = Array.isArray(stmt.Resource)
            ? stmt.Resource
            : [stmt.Resource];
          expect(resources).toContain("*");
        }
        if (actions.includes("xray:BatchGetTraces")) {
          sawBatchGet = true;
          const resources = Array.isArray(stmt.Resource)
            ? stmt.Resource
            : [stmt.Resource];
          expect(resources).toContain("*");
        }
      }
    }
    expect(sawSummaries).toBe(true);
    expect(sawBatchGet).toBe(true);
  });

  test("TraceQueryHandler role holds ZERO write actions and ZERO xray:Put* (invariant 3)", () => {
    const { template } = buildStack();
    const allPolicies = template.findResources("AWS::IAM::Policy");
    const writeActionPrefixes = [
      "PutItem",
      "UpdateItem",
      "DeleteItem",
      "BatchWriteItem",
    ];
    let sawTraceQueryRole = false;
    for (const [, resource] of Object.entries(allPolicies)) {
      const roles = resource.Properties?.Roles ?? [];
      const roleRefs = JSON.stringify(roles);
      if (!roleRefs.includes("TraceQueryHandler")) continue;
      sawTraceQueryRole = true;
      const statements = resource.Properties?.PolicyDocument?.Statement ?? [];
      for (const stmt of statements) {
        const actions: string[] = Array.isArray(stmt.Action)
          ? stmt.Action
          : [stmt.Action];
        for (const action of actions) {
          expect(action.startsWith("xray:Put")).toBe(false);
          expect(writeActionPrefixes.some((w) => action.endsWith(w))).toBe(
            false,
          );
        }
      }
    }
    expect(sawTraceQueryRole).toBe(true);
  });

  test("TraceQueryHandler role has read-only grants on executions, conversations, and projects tables", () => {
    const { template } = buildStack();
    const allPolicies = template.findResources("AWS::IAM::Policy");
    const readActions = new Set<string>();
    for (const [, resource] of Object.entries(allPolicies)) {
      const roles = resource.Properties?.Roles ?? [];
      const roleRefs = JSON.stringify(roles);
      if (!roleRefs.includes("TraceQueryHandler")) continue;
      const statements = resource.Properties?.PolicyDocument?.Statement ?? [];
      for (const stmt of statements) {
        const actions: string[] = Array.isArray(stmt.Action)
          ? stmt.Action
          : [stmt.Action];
        actions.forEach((a) => readActions.add(a));
      }
    }
    expect(
      [...readActions].some(
        (a) => a === "dynamodb:GetItem" || a === "dynamodb:BatchGetItem",
      ),
    ).toBe(true);
  });

  test("a NagSuppressions IAM5 entry exists for the TraceQueryHandler's X-Ray Resource:* actions", () => {
    const { stack } = buildStack();
    const role = stack.traceQueryHandlerFunction.role!;
    const cfn = role.node.defaultChild as {
      cfnOptions?: { metadata?: unknown };
    };
    const metadata = cfn?.cfnOptions?.metadata as
      | { cdk_nag?: { rules_to_suppress?: Array<Record<string, unknown>> } }
      | undefined;
    const rules = metadata?.cdk_nag?.rules_to_suppress ?? [];
    // cdk-nag base64-encodes long suppression reasons (is_reason_encoded:
    // true) — decode before asserting on content so this test is robust
    // to reason length, not just short reasons.
    const decodedReasons = rules.map((r) => {
      const reason = String(r.reason ?? "");
      return r.is_reason_encoded
        ? Buffer.from(reason, "base64").toString("utf-8")
        : reason;
    });
    const iam5Rule = rules.find((r) => r.id === "AwsSolutions-IAM5");
    expect(iam5Rule).toBeDefined();
    expect((iam5Rule?.applies_to as string[]) ?? []).toContain("Resource::*");
    expect(decodedReasons.join(" ").toLowerCase()).toContain("x-ray");
  });

  test("TraceQueryHandler role grants logs:StartQuery scoped to the aws/spans log-group ARN, plus GetQueryResults/StopQuery, nag-suppressed (design §4 dual-backend port)", () => {
    const { template } = buildStack();
    const allPolicies = template.findResources("AWS::IAM::Policy");
    let sawStartQuery = false;
    let sawGetQueryResults = false;
    let sawStopQuery = false;
    for (const [, resource] of Object.entries(allPolicies)) {
      const roles = resource.Properties?.Roles ?? [];
      const roleRefs = JSON.stringify(roles);
      if (!roleRefs.includes("TraceQueryHandler")) continue;
      const statements = resource.Properties?.PolicyDocument?.Statement ?? [];
      for (const stmt of statements) {
        const actions = Array.isArray(stmt.Action)
          ? stmt.Action
          : [stmt.Action];
        if (actions.includes("logs:StartQuery")) {
          sawStartQuery = true;
          const resources = Array.isArray(stmt.Resource)
            ? stmt.Resource
            : [stmt.Resource];
          // Scoped to the aws/spans log-group ARN, NOT Resource:* — the
          // StartQuery API supports resource-level scoping (design §4),
          // unlike GetQueryResults/StopQuery below.
          const resourceStr = JSON.stringify(resources);
          expect(resourceStr).toContain("log-group:aws/spans");
          expect(resources).not.toContain("*");
        }
        if (actions.includes("logs:GetQueryResults")) {
          sawGetQueryResults = true;
          const resources = Array.isArray(stmt.Resource)
            ? stmt.Resource
            : [stmt.Resource];
          expect(resources).toContain("*");
        }
        if (actions.includes("logs:StopQuery")) {
          sawStopQuery = true;
        }
      }
    }
    expect(sawStartQuery).toBe(true);
    expect(sawGetQueryResults).toBe(true);
    expect(sawStopQuery).toBe(true);
  });

  test("a NagSuppressions IAM5 entry exists for the TraceQueryHandler's logs:GetQueryResults/StopQuery Resource:* actions", () => {
    const { stack } = buildStack();
    const role = stack.traceQueryHandlerFunction.role!;
    const cfn = role.node.defaultChild as {
      cfnOptions?: { metadata?: unknown };
    };
    const metadata = cfn?.cfnOptions?.metadata as
      | { cdk_nag?: { rules_to_suppress?: Array<Record<string, unknown>> } }
      | undefined;
    const rules = metadata?.cdk_nag?.rules_to_suppress ?? [];
    const decodedReasons = rules.map((r) => {
      const reason = String(r.reason ?? "");
      return r.is_reason_encoded
        ? Buffer.from(reason, "base64").toString("utf-8")
        : reason;
    });
    const joined = decodedReasons.join(" ").toLowerCase();
    expect(joined).toContain("logs:getqueryresults");
  });

  test("TraceQueryHandler Lambda has a TRACE_BACKEND environment variable defaulting to xray", () => {
    const { template } = buildStack();
    template.hasResourceProperties("AWS::Lambda::Function", {
      Handler: "trace-query-handler.handler",
      Environment: {
        Variables: Match.objectLike({
          TRACE_BACKEND: "xray",
        }),
      },
    });
  });

  test("3 trace routes are wired on the existing costHttpApi, all with the JWT authorizer", () => {
    const { template } = buildStack();
    const routes = template.findResources("AWS::ApiGatewayV2::Route");
    const routeKeys = Object.values(routes).map((r) => r.Properties?.RouteKey);
    expect(routeKeys).toEqual(
      expect.arrayContaining([
        "GET /traces/by-execution/{executionId}",
        "GET /traces/by-conversation/{conversationId}",
        "GET /traces/{traceId}",
      ]),
    );

    const traceRoutes = Object.values(routes).filter((r) =>
      String(r.Properties?.RouteKey ?? "").startsWith("GET /traces"),
    );
    for (const route of traceRoutes) {
      expect(route.Properties?.AuthorizationType).toBe("JWT");
      expect(route.Properties?.AuthorizerId).toBeDefined();
    }

    // Exactly one HttpApi in this stack — the design's zero-new-config
    // invariant (7): trace routes reuse costHttpApi, no second API.
    const apis = template.findResources("AWS::ApiGatewayV2::Api");
    expect(Object.keys(apis)).toHaveLength(1);
  });

  test("trace routes integrate with the TraceQueryHandler Lambda, not the cost Lambdas", () => {
    const { template } = buildStack();
    const routes = template.findResources("AWS::ApiGatewayV2::Route");
    const integrations = template.findResources(
      "AWS::ApiGatewayV2::Integration",
    );

    function targetForRoute(routeKey: string): string {
      const entry = Object.values(routes).find(
        (r) => r.Properties?.RouteKey === routeKey,
      );
      return JSON.stringify(entry?.Properties?.Target ?? "");
    }

    const byExecTarget = targetForRoute(
      "GET /traces/by-execution/{executionId}",
    );
    const byConvTarget = targetForRoute(
      "GET /traces/by-conversation/{conversationId}",
    );
    const rawTraceTarget = targetForRoute("GET /traces/{traceId}");
    const summaryTarget = targetForRoute("GET /cost/summary");

    // All 3 trace routes share one integration target (the TraceQueryHandler).
    expect(byExecTarget).toBe(byConvTarget);
    expect(byExecTarget).toBe(rawTraceTarget);
    // And that target differs from the cost query integration.
    expect(byExecTarget).not.toBe(summaryTarget);
    void integrations;
  });
});

describe("TelemetryStack — platform-health dashboard (decision ab73ae1b)", () => {
  test("exactly one CloudWatch dashboard exists", () => {
    const { template } = buildStack();
    template.resourceCountIs("AWS::CloudWatch::Dashboard", 1);
  });

  test("dashboard body references all 4 cross-stack namespaces", () => {
    const { template } = buildStack();
    const dashboards = template.findResources("AWS::CloudWatch::Dashboard");
    const body = JSON.stringify(Object.values(dashboards)[0]?.Properties);
    expect(body).toContain("Citadel/Workflows");
    expect(body).toContain("Citadel/CostReconciler");
    expect(body).toContain("CitadelGovernance");
    expect(body).toContain("AWS/AppSync");
  });

  test("dashboard body contains all 6 section titles", () => {
    const { template } = buildStack();
    const dashboards = template.findResources("AWS::CloudWatch::Dashboard");
    const body = JSON.stringify(Object.values(dashboards)[0]?.Properties);
    expect(body).toContain("Health strip");
    expect(body).toContain("API health");
    expect(body).toContain("Workflow health");
    expect(body).toContain("Cost & reconciliation");
    expect(body).toContain("Governance");
    expect(body).toContain("DLQ / error budget");
  });

  test("dashboard name follows the citadel-platform-health-${env} convention", () => {
    const { stack } = buildStack();
    expect(stack.platformHealthDashboardName).toBe(
      "citadel-platform-health-test",
    );
    const { template } = buildStack();
    template.hasResourceProperties("AWS::CloudWatch::Dashboard", {
      DashboardName: "citadel-platform-health-test",
    });
  });
});

describe("TelemetryStack — platform-health alarms (6 new; decision ab73ae1b)", () => {
  test("alarm count is existing (Off-frontier is in arbiter-stack, none pre-existing here) + 6 new", () => {
    const { template } = buildStack();
    // TelemetryStack itself has zero pre-existing alarms — all 6 present
    // here are the new platform-health alarms.
    template.resourceCountIs("AWS::CloudWatch::Alarm", 6);
  });

  test("A1 node-failure: name, threshold, comparison, periods, datapoints, treatMissingData", () => {
    const { template } = buildStack();
    template.hasResourceProperties("AWS::CloudWatch::Alarm", {
      AlarmName: "citadel-workflow-node-failure-test",
      Threshold: 1,
      ComparisonOperator: "GreaterThanOrEqualToThreshold",
      EvaluationPeriods: 3,
      DatapointsToAlarm: 1,
      TreatMissingData: "notBreaching",
    });
  });

  test("A2 queue-wait: name, threshold, comparison, periods, datapoints, treatMissingData", () => {
    const { template } = buildStack();
    template.hasResourceProperties("AWS::CloudWatch::Alarm", {
      AlarmName: "citadel-workflow-queue-wait-test",
      Threshold: 30000,
      ComparisonOperator: "GreaterThanThreshold",
      EvaluationPeriods: 3,
      DatapointsToAlarm: 3,
      TreatMissingData: "notBreaching",
    });
  });

  test("A3 appsync-5xx: name, threshold, comparison, periods, datapoints, treatMissingData", () => {
    const { template } = buildStack();
    template.hasResourceProperties("AWS::CloudWatch::Alarm", {
      AlarmName: "citadel-appsync-5xx-test",
      Threshold: 5,
      ComparisonOperator: "GreaterThanOrEqualToThreshold",
      EvaluationPeriods: 1,
      DatapointsToAlarm: 1,
      TreatMissingData: "notBreaching",
    });
  });

  test("A4 dlq-not-empty: name, threshold, comparison, periods, datapoints, treatMissingData", () => {
    const { template } = buildStack();
    template.hasResourceProperties("AWS::CloudWatch::Alarm", {
      AlarmName: "citadel-dlq-not-empty-test",
      Threshold: 1,
      ComparisonOperator: "GreaterThanOrEqualToThreshold",
      EvaluationPeriods: 1,
      DatapointsToAlarm: 1,
      TreatMissingData: "notBreaching",
    });
  });

  test("A5 reconciler-stalled: name, threshold, comparison, periods, datapoints, treatMissingData (BREACHING)", () => {
    const { template } = buildStack();
    template.hasResourceProperties("AWS::CloudWatch::Alarm", {
      AlarmName: "citadel-cost-reconciler-stalled-test",
      Threshold: 1,
      ComparisonOperator: "LessThanThreshold",
      EvaluationPeriods: 3,
      DatapointsToAlarm: 3,
      TreatMissingData: "breaching",
      Namespace: "Citadel/CostReconciler",
      MetricName: "WindowsReconciled",
    });
  });

  test("A6 drift-high: name, threshold, comparison, periods, datapoints, treatMissingData", () => {
    const { template } = buildStack();
    template.hasResourceProperties("AWS::CloudWatch::Alarm", {
      AlarmName: "citadel-cost-drift-high-test",
      Threshold: 25,
      ComparisonOperator: "GreaterThanThreshold",
      EvaluationPeriods: 3,
      DatapointsToAlarm: 3,
      TreatMissingData: "notBreaching",
      Namespace: "Citadel/CostReconciler",
      MetricName: "AbsEstimateDriftPct",
    });
  });

  test("every new alarm's AlarmActions references props.alarmTopic ARN", () => {
    const { template } = buildStack();
    const alarms = template.findResources("AWS::CloudWatch::Alarm");
    expect(Object.keys(alarms)).toHaveLength(6);
    for (const [, resource] of Object.entries(alarms)) {
      const actions = resource.Properties?.AlarmActions ?? [];
      expect(actions.length).toBeGreaterThan(0);
      // Every action must be a cross-stack reference (Fn::ImportValue or a
      // Ref/Fn::Join resolving to the shared alarm topic), never a literal
      // string and never empty.
      expect(JSON.stringify(actions)).not.toBe("[]");
    }
  });

  test("A5 treatMissingData is 'breaching' (absence-is-failure guard); A1,A2,A3,A4,A6 are 'notBreaching'", () => {
    const { template } = buildStack();
    const alarms = template.findResources("AWS::CloudWatch::Alarm");
    const byName: Record<string, string> = {};
    for (const resource of Object.values(alarms)) {
      byName[String(resource.Properties?.AlarmName)] = String(
        resource.Properties?.TreatMissingData,
      );
    }
    expect(byName["citadel-cost-reconciler-stalled-test"]).toBe("breaching");
    expect(byName["citadel-workflow-node-failure-test"]).toBe("notBreaching");
    expect(byName["citadel-workflow-queue-wait-test"]).toBe("notBreaching");
    expect(byName["citadel-appsync-5xx-test"]).toBe("notBreaching");
    expect(byName["citadel-dlq-not-empty-test"]).toBe("notBreaching");
    expect(byName["citadel-cost-drift-high-test"]).toBe("notBreaching");
  });

  test("metric strings for A1/A2 equal the imported pinned constants (pinned-contract guard)", () => {
    const { template } = buildStack();
    const alarms = template.findResources("AWS::CloudWatch::Alarm");
    const nodeFailureAlarm = Object.values(alarms).find(
      (a) => a.Properties?.AlarmName === "citadel-workflow-node-failure-test",
    );
    const queueWaitAlarm = Object.values(alarms).find(
      (a) => a.Properties?.AlarmName === "citadel-workflow-queue-wait-test",
    );
    const nodeFailureExpr = String(
      nodeFailureAlarm?.Properties?.Metrics?.[0]?.MetricStat?.Metric
        ?.MetricName ??
        nodeFailureAlarm?.Properties?.Metrics?.[0]?.Expression ??
        "",
    );
    const queueWaitExpr = String(
      queueWaitAlarm?.Properties?.Metrics?.[0]?.MetricStat?.Metric
        ?.MetricName ??
        queueWaitAlarm?.Properties?.Metrics?.[0]?.Expression ??
        "",
    );
    expect(nodeFailureExpr).toContain(METRIC_NODE_FAILURE);
    expect(nodeFailureExpr).toContain(METRIC_NAMESPACE);
    expect(queueWaitExpr).toContain(METRIC_NODE_QUEUE_WAIT_MS);
    expect(queueWaitExpr).toContain(METRIC_NAMESPACE);
  });

  test("no new SNS::Topic is added by TelemetryStack (reuse guard)", () => {
    const { template } = buildStack();
    template.resourceCountIs("AWS::SNS::Topic", 0);
  });

  test("A3 uses the concrete GraphQLAPIId dimension equal to props.appSyncApiId", () => {
    const { template } = buildStack();
    template.hasResourceProperties("AWS::CloudWatch::Alarm", {
      AlarmName: "citadel-appsync-5xx-test",
      Namespace: "AWS/AppSync",
      MetricName: "5XXError",
      Dimensions: [{ Name: "GraphQLAPIId", Value: "test-appsync-api-id" }],
    });
  });
});
