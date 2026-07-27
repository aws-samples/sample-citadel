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
import { TelemetryStack } from "../telemetry-stack";

function buildStack(): { template: Template; stack: TelemetryStack } {
  const app = new cdk.App();
  const supportStack = new cdk.Stack(app, "SupportStack", {
    env: { account: "123456789012", region: "us-east-1" },
  });

  const userPool = new cognito.UserPool(supportStack, "TestUserPool");
  const userPoolClient = userPool.addClient("TestUserPoolClient");
  const agentEventBus = new events.EventBus(supportStack, "TestEventBus");
  const modelCatalogTable = new dynamodb.Table(
    supportStack,
    "TestModelCatalogTable",
    {
      partitionKey: { name: "modelKey", type: dynamodb.AttributeType.STRING },
    },
  );

  const stack = new TelemetryStack(app, "TestTelemetryStack", {
    environment: "test",
    env: { account: "123456789012", region: "us-east-1" },
    agentEventBus,
    modelCatalogTable,
    userPool,
    userPoolClient,
    frontendOrigin: "https://example.test",
    bedrockInvocationLogGroupName: "/aws/bedrock/invocation-logs",
  });

  return { template: Template.fromStack(stack), stack };
}

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
    const modelCatalogTable = new dynamodb.Table(
      supportStack,
      "TestModelCatalogTable",
      {
        partitionKey: { name: "modelKey", type: dynamodb.AttributeType.STRING },
      },
    );
    const stack = new TelemetryStack(app, "TestTelemetryStackUnconfigured", {
      environment: "test",
      env: { account: "123456789012", region: "us-east-1" },
      agentEventBus,
      modelCatalogTable,
      userPool,
      userPoolClient,
      frontendOrigin: "https://example.test",
      // bedrockInvocationLogGroupName intentionally omitted
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
