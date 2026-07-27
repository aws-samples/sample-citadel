import * as cdk from "aws-cdk-lib";
import * as apigatewayv2 from "aws-cdk-lib/aws-apigatewayv2";
import * as apigatewayv2Authorizers from "aws-cdk-lib/aws-apigatewayv2-authorizers";
import * as apigatewayv2Integrations from "aws-cdk-lib/aws-apigatewayv2-integrations";
import * as cognito from "aws-cdk-lib/aws-cognito";
import * as dynamodb from "aws-cdk-lib/aws-dynamodb";
import * as events from "aws-cdk-lib/aws-events";
import * as targets from "aws-cdk-lib/aws-events-targets";
import * as iam from "aws-cdk-lib/aws-iam";
import * as lambda from "aws-cdk-lib/aws-lambda";
import * as logs from "aws-cdk-lib/aws-logs";
import { Construct } from "constructs";
import { NagSuppressions } from "cdk-nag";

export interface TelemetryStackProps extends cdk.StackProps {
  environment: string;
  /** Shared EventBridge bus (from BackendStack) — telemetry now PUBLISHES cost.budget.* here too (pass 1), in addition to consuming usage events. */
  agentEventBus: events.IEventBus;
  /** Model catalog table (from BackendStack) — read access for pass-2 pricing lookup. */
  modelCatalogTable: dynamodb.ITable;
  /** Cognito user pool backing the cost-query HttpApi's JWT authorizer. */
  userPool: cognito.IUserPool;
  /** Cognito user pool client — becomes the authorizer's audience. */
  userPoolClient: cognito.IUserPoolClient;
  /**
   * Deploy-time frontend origin for CORS (e.g. the CloudFront domain).
   * Sourced from env/CDK context, NOT the FrontendStack construct, to
   * avoid a Telemetry<->Frontend circular stack dependency.
   */
  frontendOrigin: string;
  /**
   * Name of the CloudWatch log group receiving Bedrock model-invocation
   * logs (an account-level, operator opt-in feature provisioned outside
   * this stack). Sourced from env/CDK context like `frontendOrigin`
   * above. When unset, Tier B reconciliation stays inactive: no IAM
   * grant is added and the reconciler's `BEDROCK_INVOCATION_LOG_GROUP`
   * env var is left unset, which the reconciler already treats as
   * "log_group_unconfigured". Never a wildcard/glob — the IAM grant
   * below is scoped to exactly this one log group's ARN.
   */
  bedrockInvocationLogGroupName?: string;
}

/**
 * TelemetryStack — Invocation cost ledger (pass 1: usage-only, no pricing math).
 *
 * Deliberate convention deviation: the cost-ledger table uses
 * `removalPolicy: RETAIN` (not the project-wide DESTROY default) because it
 * is a financial/audit record a later reconciler compares against; losing
 * it on `cdk destroy` is unacceptable. PITR remains enabled regardless.
 */
export class TelemetryStack extends cdk.Stack {
  public readonly costLedgerTable: dynamodb.Table;
  public readonly costLedgerWriterFunction: lambda.Function;
  public readonly costLedgerReconcilerFunction: lambda.Function;
  public readonly costQueryHandlerFunction: lambda.Function;
  public readonly costBudgetHandlerFunction: lambda.Function;
  public readonly costBudgetEvaluatorFunction: lambda.Function;
  public readonly costHttpApi: apigatewayv2.HttpApi;
  /** HttpApi endpoint URL — threaded into FrontendStack (pass 2) as `aws_cost_api_url`. */
  public readonly costApiUrl: string;

  constructor(scope: Construct, id: string, props: TelemetryStackProps) {
    super(scope, id, props);

    // --- Cost ledger table -------------------------------------------------
    // PK = ORG#<orgId> (unknown -> ORG#UNKNOWN), SK = <capturedAt>#<eventId>:<callIndex>.
    // Time-prefixed SK on the base table AND every GSI means org/project/app/
    // agent/workflow time-range rollups are all plain `Query`s — no separate
    // global time-bucket GSI (that would create a hot partition).
    this.costLedgerTable = new dynamodb.Table(this, "CostLedgerTable", {
      tableName: `citadel-cost-ledger-${props.environment}`,
      partitionKey: { name: "PK", type: dynamodb.AttributeType.STRING },
      sortKey: { name: "SK", type: dynamodb.AttributeType.STRING },
      billingMode: dynamodb.BillingMode.PAY_PER_REQUEST,
      pointInTimeRecoverySpecification: { pointInTimeRecoveryEnabled: true },
      removalPolicy: cdk.RemovalPolicy.RETAIN,
    });

    // 4 sparse GSIs — key attrs are only written on rows that have that
    // dimension (writer's responsibility), so e.g. a non-workflow invocation
    // never appears in WorkflowIndex. Projection ALL: report queries need
    // cost + tokens + modelKey without a base-table hydrate.
    this.costLedgerTable.addGlobalSecondaryIndex({
      indexName: "ProjectIndex",
      partitionKey: { name: "GSI1PK", type: dynamodb.AttributeType.STRING },
      sortKey: { name: "GSI1SK", type: dynamodb.AttributeType.STRING },
      projectionType: dynamodb.ProjectionType.ALL,
    });
    this.costLedgerTable.addGlobalSecondaryIndex({
      indexName: "AppIndex",
      partitionKey: { name: "GSI2PK", type: dynamodb.AttributeType.STRING },
      sortKey: { name: "GSI2SK", type: dynamodb.AttributeType.STRING },
      projectionType: dynamodb.ProjectionType.ALL,
    });
    this.costLedgerTable.addGlobalSecondaryIndex({
      indexName: "AgentIndex",
      partitionKey: { name: "GSI3PK", type: dynamodb.AttributeType.STRING },
      sortKey: { name: "GSI3SK", type: dynamodb.AttributeType.STRING },
      projectionType: dynamodb.ProjectionType.ALL,
    });
    this.costLedgerTable.addGlobalSecondaryIndex({
      indexName: "WorkflowIndex",
      partitionKey: { name: "GSI4PK", type: dynamodb.AttributeType.STRING },
      sortKey: { name: "GSI4SK", type: dynamodb.AttributeType.STRING },
      projectionType: dynamodb.ProjectionType.ALL,
    });

    // Sparse BudgetIndex GSI — written ONLY on budget rows (GSI5PK/GSI5SK
    // set exclusively by the PUT /budgets/{scope} handler). Lets the
    // scheduled evaluator enumerate every budget across every org via a
    // single `Query GSI5PK='BUDGET'` instead of a table Scan, keeping
    // "never Scan on any cost-surface access path" true as the ledger grows.
    this.costLedgerTable.addGlobalSecondaryIndex({
      indexName: "BudgetIndex",
      partitionKey: { name: "GSI5PK", type: dynamodb.AttributeType.STRING },
      sortKey: { name: "GSI5SK", type: dynamodb.AttributeType.STRING },
      projectionType: dynamodb.ProjectionType.ALL,
    });

    // --- Writer Lambda -------------------------------------------------
    // Reuses the shared `dist/lambda` asset root every other TS Lambda in
    // this codebase compiles into (backend/src/lambda convention) — no new
    // telemetry-specific src dir / bundling config.
    this.costLedgerWriterFunction = new lambda.Function(
      this,
      "CostLedgerWriter",
      {
        functionName: `citadel-cost-ledger-writer-${props.environment}`,
        runtime: lambda.Runtime.NODEJS_24_X,
        handler: "cost-ledger-writer.handler",
        code: lambda.Code.fromAsset("dist/lambda"),
        timeout: cdk.Duration.seconds(30),
        environment: {
          COST_LEDGER_TABLE: this.costLedgerTable.tableName,
          MODEL_CATALOG_TABLE: props.modelCatalogTable.tableName,
          ENVIRONMENT: props.environment,
        },
        logGroup: new logs.LogGroup(this, "CostLedgerWriterLogs", {
          retention: logs.RetentionDays.ONE_WEEK,
          removalPolicy: cdk.RemovalPolicy.DESTROY,
        }),
      },
    );

    // Least-privilege: writer may write the ledger table and read pricing
    // from the model catalog. Nothing else.
    this.costLedgerTable.grantWriteData(this.costLedgerWriterFunction);
    props.modelCatalogTable.grantReadData(this.costLedgerWriterFunction);

    // --- EventBridge rules (3, all targeting the same writer) -------------
    // Writer branches on `source`/`detail-type` internally; patterns can't
    // correlate across sources, so the dedupe rule is enforced in the writer.
    const retryProps = { retryAttempts: 2, maxEventAge: cdk.Duration.hours(2) };

    const taskCompletionRule = new events.Rule(this, "TaskCompletionRule", {
      eventBus: props.agentEventBus,
      description:
        "Routes worker task-completion usage events to the cost-ledger writer",
      eventPattern: {
        source: ["task.completion"],
        detailType: ["task.completion"],
      },
    });
    taskCompletionRule.addTarget(
      new targets.LambdaFunction(this.costLedgerWriterFunction, retryProps),
    );

    const intakeUsageRule = new events.Rule(this, "IntakeUsageRule", {
      eventBus: props.agentEventBus,
      description:
        "Routes intake-runtime usage events to the cost-ledger writer",
      eventPattern: {
        source: ["agent_intake.usage"],
        detailType: ["intake.usage.captured"],
      },
    });
    intakeUsageRule.addTarget(
      new targets.LambdaFunction(this.costLedgerWriterFunction, retryProps),
    );

    const workflowNodeCompletedRule = new events.Rule(
      this,
      "WorkflowNodeCompletedRule",
      {
        eventBus: props.agentEventBus,
        description:
          "Routes workflow-node-completed usage events to the cost-ledger writer",
        eventPattern: {
          source: ["citadel.workflows"],
          detailType: ["workflow.node.completed"],
        },
      },
    );
    workflowNodeCompletedRule.addTarget(
      new targets.LambdaFunction(this.costLedgerWriterFunction, retryProps),
    );

    // --- Cost ledger reconciler (Tier A aggregate drift, Tier B skeleton) --
    // Scheduled hourly: compares aggregate ledger token totals against
    // AWS/Bedrock CloudWatch token metrics per model per hour-aligned
    // window and emits a drift metric. Never flips a ledger row's
    // `estimate:true` — an aggregate comparison cannot honestly produce a
    // per-row actual (Tier B, which would, is a feature-flagged-off
    // skeleton this story).
    this.costLedgerReconcilerFunction = new lambda.Function(
      this,
      "CostLedgerReconciler",
      {
        functionName: `citadel-cost-ledger-reconciler-${props.environment}`,
        runtime: lambda.Runtime.NODEJS_24_X,
        handler: "cost-ledger-reconciler.handler",
        code: lambda.Code.fromAsset("dist/lambda"),
        timeout: cdk.Duration.minutes(5),
        environment: {
          COST_LEDGER_TABLE: this.costLedgerTable.tableName,
          MODEL_CATALOG_TABLE: props.modelCatalogTable.tableName,
          ENVIRONMENT: props.environment,
          SETTLE_LAG_MINUTES: "15",
          MAX_WINDOWS_PER_RUN: "6",
          METRIC_NAMESPACE: "Citadel/CostReconciler",
          // Tier B activation is a SEPARATE operational toggle from this
          // IAM/plumbing pass — kept off by default. Setting it to "true"
          // without also configuring BEDROCK_INVOCATION_LOG_GROUP leaves
          // Tier B cleanly inactive (logged, never Scans/Filters).
          COST_RECONCILER_TIER_B_ENABLED: "false",
          // Bedrock model-invocation logging is an opt-in, account-level
          // setting; its destination log group is env-configured (not SSM)
          // to match every other reconciler knob above — set once per
          // deploy once Tier B is actually being turned on. Left unset by
          // default: absence is exactly what keeps Tier B "inactive when
          // unconfigured" even if the enable flag above is flipped.
          ...(props.bedrockInvocationLogGroupName
            ? {
                BEDROCK_INVOCATION_LOG_GROUP:
                  props.bedrockInvocationLogGroupName,
              }
            : {}),
          MAX_LOG_EVENTS_PER_WINDOW: "10000",
        },
        logGroup: new logs.LogGroup(this, "CostLedgerReconcilerLogs", {
          retention: logs.RetentionDays.ONE_WEEK,
          removalPolicy: cdk.RemovalPolicy.DESTROY,
        }),
      },
    );

    // Least-privilege inline policy — deliberately NOT
    // `grantReadWriteData`, which would also grant Delete/BatchWrite the
    // reconciler never needs. Read-modify-write only, via conditional
    // Put/Update, so a reconciler failure can never corrupt a ledger row.
    this.costLedgerReconcilerFunction.addToRolePolicy(
      new iam.PolicyStatement({
        effect: iam.Effect.ALLOW,
        actions: [
          "dynamodb:Query",
          "dynamodb:Scan",
          "dynamodb:PutItem",
          "dynamodb:UpdateItem",
        ],
        resources: [
          this.costLedgerTable.tableArn,
          `${this.costLedgerTable.tableArn}/index/*`,
        ],
      }),
    );
    this.costLedgerReconcilerFunction.addToRolePolicy(
      new iam.PolicyStatement({
        effect: iam.Effect.ALLOW,
        actions: ["cloudwatch:GetMetricData"],
        // GetMetricData has no resource-level permission support.
        resources: ["*"],
      }),
    );
    this.costLedgerReconcilerFunction.addToRolePolicy(
      new iam.PolicyStatement({
        effect: iam.Effect.ALLOW,
        actions: ["cloudwatch:PutMetricData"],
        resources: ["*"],
        conditions: {
          StringEquals: { "cloudwatch:namespace": "Citadel/CostReconciler" },
        },
      }),
    );

    // Tier B: FilterLogEvents against the Bedrock model-invocation log
    // group, scoped to that specific log group's ARN (never '*' or a
    // name-glob pattern). The log group itself is provisioned by the
    // OPERATOR's Bedrock model-invocation-logging opt-in (outside this
    // stack — it's an account-level Bedrock setting, not a CDK-managed
    // resource here). Grant is added ONLY when the log group name is
    // configured (props.bedrockInvocationLogGroupName), which mirrors
    // the reconciler's own "inactive when unconfigured" contract: no
    // grant means no possible IAM-side over-scoping to guard against.
    if (props.bedrockInvocationLogGroupName) {
      this.costLedgerReconcilerFunction.addToRolePolicy(
        new iam.PolicyStatement({
          effect: iam.Effect.ALLOW,
          actions: ["logs:FilterLogEvents"],
          resources: [
            cdk.Arn.format(
              {
                service: "logs",
                resource: "log-group",
                resourceName: `${props.bedrockInvocationLogGroupName}:*`,
                arnFormat: cdk.ArnFormat.COLON_RESOURCE_NAME,
              },
              this,
            ),
          ],
        }),
      );
    }
    // Tier B recompute reuses the writer's cost-compute pricing lookup —
    // read-only access to the model catalog table, same grant shape the
    // writer already holds.
    props.modelCatalogTable.grantReadData(this.costLedgerReconcilerFunction);

    // cdk-nag: GetMetricData has no resource-level permission support (AWS
    // requires '*'); PutMetricData is narrowed via a namespace condition
    // instead of a resource ARN (CloudWatch metric APIs are not ARN-
    // addressable). Both statements are already scoped as tightly as the
    // service allows.
    NagSuppressions.addResourceSuppressions(
      this.costLedgerReconcilerFunction.role!,
      [
        {
          id: "AwsSolutions-IAM5",
          reason:
            "cloudwatch:GetMetricData has no resource-level scoping (AWS " +
            "requires Resource:* for this action); cloudwatch:PutMetricData " +
            "is narrowed via a StringEquals cloudwatch:namespace condition " +
            "instead of a resource ARN, since CloudWatch metrics are not " +
            "ARN-addressable.",
          appliesTo: ["Resource::*"],
        },
      ],
      true,
    );

    const costReconcilerScheduleRule = new events.Rule(
      this,
      "CostReconcilerScheduleRule",
      {
        description:
          "Hourly trigger for the cost-ledger reconciler (Tier A aggregate drift)",
        schedule: events.Schedule.rate(cdk.Duration.hours(1)),
      },
    );
    costReconcilerScheduleRule.addTarget(
      new targets.LambdaFunction(this.costLedgerReconcilerFunction),
    );

    // --- Cost query API (org-scoped summary/series; budgets is a
    // separate Lambda below) --------------------------------------------
    // HttpApi + HttpUserPoolAuthorizer are stable (graduated) L2 constructs
    // at aws-cdk-lib ^2.260 — no alpha package needed.
    this.costQueryHandlerFunction = new lambda.Function(
      this,
      "CostQueryHandler",
      {
        functionName: `citadel-cost-query-handler-${props.environment}`,
        runtime: lambda.Runtime.NODEJS_24_X,
        handler: "cost-query-handler.handler",
        code: lambda.Code.fromAsset("dist/lambda"),
        timeout: cdk.Duration.seconds(30),
        environment: {
          COST_LEDGER_TABLE: this.costLedgerTable.tableName,
          ENVIRONMENT: props.environment,
        },
        logGroup: new logs.LogGroup(this, "CostQueryHandlerLogs", {
          retention: logs.RetentionDays.ONE_WEEK,
          removalPolicy: cdk.RemovalPolicy.DESTROY,
        }),
      },
    );

    // Read-only role: this Lambda now serves ONLY GET /cost/summary and
    // GET /cost/series (budgets moved to CostBudgetHandler below), so its
    // role carries dynamodb:Query and nothing else — never UpdateItem,
    // never Delete, never Scan.
    this.costQueryHandlerFunction.addToRolePolicy(
      new iam.PolicyStatement({
        effect: iam.Effect.ALLOW,
        actions: ["dynamodb:Query"],
        resources: [this.costLedgerTable.tableArn],
      }),
    );

    // --- Cost budgets API (GET /budgets + PUT /budgets/{scope}) -----------
    // Split into its own Lambda (query/budgets IAM split, per architect
    // design) so the read-only query role above can never call
    // UpdateItem. This Lambda owns the entire BUDGET# SK domain
    // (list + upsert), co-locating that domain's read+write behind one
    // role rather than splitting it further.
    //
    // HONEST LIMITATION: IAM cannot scope UpdateItem to the BUDGET# SK
    // namespace — dynamodb:LeadingKeys constrains the PARTITION key only,
    // and PK=ORG#<org> comes from a verified JWT claim (this Lambda serves
    // every org), so neither SK-level nor per-org IAM scoping of the write
    // is possible. This grant is table-wide at the IAM layer; the real
    // guarantee this split provides is a ROLE-LEVEL read-vs-write
    // separation — the query Lambda's role can never call UpdateItem at
    // all, full stop. Within this Lambda, the app-level
    // validatePutBudgetBody + parseBudgetScope guard (cost-budget-handler.ts)
    // is what stands between this grant and an accidental overwrite of a
    // rollup row, by rejecting anything that doesn't resolve to a
    // BUDGET# SK before an UpdateCommand is ever built.
    this.costBudgetHandlerFunction = new lambda.Function(
      this,
      "CostBudgetHandler",
      {
        functionName: `citadel-cost-budget-handler-${props.environment}`,
        runtime: lambda.Runtime.NODEJS_24_X,
        handler: "cost-budget-handler.handler",
        code: lambda.Code.fromAsset("dist/lambda"),
        timeout: cdk.Duration.seconds(30),
        environment: {
          COST_LEDGER_TABLE: this.costLedgerTable.tableName,
          ENVIRONMENT: props.environment,
        },
        logGroup: new logs.LogGroup(this, "CostBudgetHandlerLogs", {
          retention: logs.RetentionDays.ONE_WEEK,
          removalPolicy: cdk.RemovalPolicy.DESTROY,
        }),
      },
    );

    this.costBudgetHandlerFunction.addToRolePolicy(
      new iam.PolicyStatement({
        effect: iam.Effect.ALLOW,
        actions: ["dynamodb:Query", "dynamodb:UpdateItem"],
        resources: [this.costLedgerTable.tableArn],
      }),
    );

    // AwsSolutions-APIG1: the default (auto-created) HttpApi stage needs its
    // own access-log destination — reuses the same
    // ONE_WEEK-retention/DESTROY-on-delete LogGroup convention as every other
    // Lambda log group in this stack, scoped to just this API.
    const costHttpApiAccessLogs = new logs.LogGroup(
      this,
      "CostHttpApiAccessLogs",
      {
        retention: logs.RetentionDays.ONE_WEEK,
        removalPolicy: cdk.RemovalPolicy.DESTROY,
      },
    );

    this.costHttpApi = new apigatewayv2.HttpApi(this, "CostHttpApi", {
      apiName: `citadel-cost-api-${props.environment}`,
      corsPreflight: {
        // Wildcard origin is refused outright — this is a JWT-authorized
        // API, and pairing `Access-Control-Allow-Origin: *` with bearer
        // tokens is a broad-CORS anti-pattern regardless of token
        // validation happening server-side. `frontendOrigin` must be a
        // concrete origin (enforced in bin/app.ts, which fails fast rather
        // than silently defaulting to '*').
        allowOrigins: [props.frontendOrigin],
        allowMethods: [
          apigatewayv2.CorsHttpMethod.GET,
          apigatewayv2.CorsHttpMethod.PUT,
          apigatewayv2.CorsHttpMethod.OPTIONS,
        ],
        allowHeaders: ["Authorization", "Content-Type"],
        maxAge: cdk.Duration.hours(1),
      },
    });

    // AwsSolutions-APIG1 requires access logging on every stage. HttpApi's
    // default stage is created implicitly by the L2 construct with no
    // logging hook exposed on `HttpApiProps`, so it's reached via the L1
    // escape hatch on the default stage's CfnStage.
    const cfnDefaultStage = this.costHttpApi.defaultStage!.node
      .defaultChild as apigatewayv2.CfnStage;
    cfnDefaultStage.accessLogSettings = {
      destinationArn: costHttpApiAccessLogs.logGroupArn,
      format: JSON.stringify({
        requestId: "$context.requestId",
        ip: "$context.identity.sourceIp",
        requestTime: "$context.requestTime",
        httpMethod: "$context.httpMethod",
        routeKey: "$context.routeKey",
        status: "$context.status",
        integrationErrorMessage: "$context.integrationErrorMessage",
        authorizerError: "$context.authorizer.error",
      }),
    };
    costHttpApiAccessLogs.grantWrite(
      new iam.ServicePrincipal("apigateway.amazonaws.com"),
    );

    const costJwtAuthorizer =
      new apigatewayv2Authorizers.HttpUserPoolAuthorizer(
        "CostJwtAuthorizer",
        props.userPool,
        { userPoolClients: [props.userPoolClient] },
      );

    const costQueryIntegration =
      new apigatewayv2Integrations.HttpLambdaIntegration(
        "CostQueryIntegration",
        this.costQueryHandlerFunction,
      );
    const costBudgetIntegration =
      new apigatewayv2Integrations.HttpLambdaIntegration(
        "CostBudgetIntegration",
        this.costBudgetHandlerFunction,
      );

    // All 4 routes carry the JWT authorizer — org-scoping inside each
    // handler relies on every request having already been through it.
    // summary/series route to the read-only query Lambda; budgets GET/PUT
    // route to the dedicated budgets Lambda.
    this.costHttpApi.addRoutes({
      path: "/cost/summary",
      methods: [apigatewayv2.HttpMethod.GET],
      integration: costQueryIntegration,
      authorizer: costJwtAuthorizer,
    });
    this.costHttpApi.addRoutes({
      path: "/cost/series",
      methods: [apigatewayv2.HttpMethod.GET],
      integration: costQueryIntegration,
      authorizer: costJwtAuthorizer,
    });
    this.costHttpApi.addRoutes({
      path: "/budgets",
      methods: [apigatewayv2.HttpMethod.GET],
      integration: costBudgetIntegration,
      authorizer: costJwtAuthorizer,
    });
    this.costHttpApi.addRoutes({
      path: "/budgets/{scope}",
      methods: [apigatewayv2.HttpMethod.PUT],
      integration: costBudgetIntegration,
      authorizer: costJwtAuthorizer,
    });

    this.costApiUrl = this.costHttpApi.apiEndpoint;
    new cdk.CfnOutput(this, "CostApiUrl", {
      value: this.costApiUrl,
      description:
        "Cost query HttpApi endpoint (consumed by FrontendStack pass 2)",
    });

    // --- Cost budget evaluator (separate Lambda + separate hourly rule) ---
    // Distinct from the reconciler: different purpose (budget breach vs
    // token drift), independent failure isolation, and needs
    // events:PutEvents (reconciler is metric-only, never publishes).
    this.costBudgetEvaluatorFunction = new lambda.Function(
      this,
      "CostBudgetEvaluator",
      {
        functionName: `citadel-cost-budget-evaluator-${props.environment}`,
        runtime: lambda.Runtime.NODEJS_24_X,
        handler: "cost-budget-evaluator.handler",
        code: lambda.Code.fromAsset("dist/lambda"),
        timeout: cdk.Duration.minutes(5),
        environment: {
          COST_LEDGER_TABLE: this.costLedgerTable.tableName,
          ENVIRONMENT: props.environment,
          EVENT_BUS_NAME: props.agentEventBus.eventBusName,
        },
        logGroup: new logs.LogGroup(this, "CostBudgetEvaluatorLogs", {
          retention: logs.RetentionDays.ONE_WEEK,
          removalPolicy: cdk.RemovalPolicy.DESTROY,
        }),
      },
    );

    // Least-privilege: enumerate budgets via the sparse BudgetIndex GSI,
    // read period-to-date spend via the base table, and conditionally
    // UpdateItem the dedupe/notified map on the budget row itself. Never
    // Scan, never Delete, never write a ledger usage row.
    this.costBudgetEvaluatorFunction.addToRolePolicy(
      new iam.PolicyStatement({
        effect: iam.Effect.ALLOW,
        actions: ["dynamodb:Query", "dynamodb:UpdateItem"],
        resources: [
          this.costLedgerTable.tableArn,
          `${this.costLedgerTable.tableArn}/index/BudgetIndex`,
        ],
      }),
    );

    // Telemetry becomes an EventBridge *publisher* for the first time
    // (previously consume-only) — scoped to the shared bus only.
    props.agentEventBus.grantPutEventsTo(this.costBudgetEvaluatorFunction);

    const costBudgetEvaluatorScheduleRule = new events.Rule(
      this,
      "CostBudgetEvaluatorScheduleRule",
      {
        description:
          "Hourly trigger for the cost budget evaluator (breach/threshold detection)",
        schedule: events.Schedule.rate(cdk.Duration.hours(1)),
      },
    );
    costBudgetEvaluatorScheduleRule.addTarget(
      new targets.LambdaFunction(this.costBudgetEvaluatorFunction),
    );
  }
}
