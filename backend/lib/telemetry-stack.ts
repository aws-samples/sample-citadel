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
import * as cloudwatch from "aws-cdk-lib/aws-cloudwatch";
import * as cw_actions from "aws-cdk-lib/aws-cloudwatch-actions";
import * as sns from "aws-cdk-lib/aws-sns";
import { Construct } from "constructs";
import { NagSuppressions } from "cdk-nag";
import {
  METRIC_NAMESPACE,
  METRIC_NODE_COLD_START,
  METRIC_NODE_DURATION_MS,
  METRIC_NODE_FAILURE,
  METRIC_NODE_QUEUE_WAIT_MS,
  DIMENSION_WORKFLOW_ID,
  DIMENSION_AGENT_ID,
} from "../src/utils/metrics-constants";

// --- Cost-reconciler metric contract (pinned literals; see
// cost-ledger-reconciler.ts `emitMetrics`). Not exported from
// metrics-constants.ts because that module is the TS-mirror of the
// Python arbiter tier's Citadel/Workflows contract specifically; the
// cost-reconciler metrics are TS-only and namespaced separately
// (Citadel/CostReconciler), so they are pinned locally here instead of
// being retyped ad hoc below.
const COST_RECONCILER_NAMESPACE = "Citadel/CostReconciler";
const METRIC_ABS_ESTIMATE_DRIFT_PCT = "AbsEstimateDriftPct";
const METRIC_WINDOWS_RECONCILED = "WindowsReconciled";
const METRIC_UNMATCHED_LEDGER_MODELS = "UnmatchedLedgerModels";
const METRIC_LEDGER_TOKENS = "LedgerTokens";
const METRIC_METRIC_TOKENS = "MetricTokens";
const METRIC_TIER_B_ACTIVE = "TierBActive";
const DIMENSION_ENVIRONMENT = "Environment";

// --- Governance escalation metric contract (pinned literal; see
// arbiter/workerWrapper/tools/escalate.py). Already alarmed by
// arbiter-stack's OffFrontierEscalationAlarm — surfaced on the dashboard
// only, never re-alarmed here.
const GOVERNANCE_NAMESPACE = "CitadelGovernance";
const METRIC_OFF_FRONTIER_ESCALATIONS = "OffFrontierEscalations";

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
  /**
   * Executions table (from BackendStack/ArbiterStack) — read-only
   * ownership resolution for GET /traces/by-execution/{executionId}
   * (design §1: executions.orgId is the direct ownership check).
   */
  executionsTable: dynamodb.ITable;
  /**
   * Conversations table (from ProjectsStack) — threaded for
   * completeness/future use; the current ownership check for
   * GET /traces/by-conversation/{conversationId} resolves directly via
   * projectsTable (conversations are keyed by projectId, no separate
   * conversationId indirection to look up).
   */
  conversationsTable: dynamodb.ITable;
  /**
   * Projects table (from ProjectsStack) — read-only ownership resolution
   * for GET /traces/by-conversation/{conversationId} (design §1:
   * conversation -> projectId -> projects.orgId).
   */
  projectsTable: dynamodb.ITable;
  /**
   * Reused platform alarm topic (from BackendStack, decision ab73ae1b's
   * notifier-reuse call) — every new platform-health alarm below attaches
   * here. No new SNS topic is created by this stack.
   */
  alarmTopic: sns.ITopic;
  /**
   * The single AppSync API's id (from BackendStack) — the concrete
   * `GraphQLAPIId` dimension for the AppSync 5XX alarm and dashboard
   * widgets (design §2 API health / §3 alarm A3).
   */
  appSyncApiId: string;
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
  public readonly traceQueryHandlerFunction: lambda.Function;
  public readonly costHttpApi: apigatewayv2.HttpApi;
  /** HttpApi endpoint URL — threaded into FrontendStack (pass 2) as `aws_cost_api_url`. */
  public readonly costApiUrl: string;
  /** Platform-health dashboard name (design §2; decision ab73ae1b). */
  public readonly platformHealthDashboardName: string;

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

    // --- Trace query API (waterfall trace viewer, pass 1) -----------------
    // Reuses the SAME costHttpApi/JWT authorizer (design §4 "CONFIG
    // DECISION" — zero new frontend/CDK config, invariant 7). Read-only
    // role: dynamodb:GetItem/BatchGetItem on the 3 ownership tables +
    // xray:GetTraceSummaries/BatchGetTraces — NEVER a write action, NEVER
    // xray:Put* (invariant 3). Ownership (execution/conversation -> org)
    // is checked in-Lambda BEFORE any X-Ray call (invariant 1); the raw
    // /traces/{traceId} route is admin-only (invariant 2) — see
    // trace-query-handler.ts.
    this.traceQueryHandlerFunction = new lambda.Function(
      this,
      "TraceQueryHandler",
      {
        functionName: `citadel-trace-query-handler-${props.environment}`,
        runtime: lambda.Runtime.NODEJS_24_X,
        handler: "trace-query-handler.handler",
        code: lambda.Code.fromAsset("dist/lambda"),
        timeout: cdk.Duration.seconds(30),
        environment: {
          EXECUTIONS_TABLE: props.executionsTable.tableName,
          CONVERSATIONS_TABLE: props.conversationsTable.tableName,
          PROJECTS_TABLE: props.projectsTable.tableName,
          ENVIRONMENT: props.environment,
        },
        logGroup: new logs.LogGroup(this, "TraceQueryHandlerLogs", {
          retention: logs.RetentionDays.ONE_WEEK,
          removalPolicy: cdk.RemovalPolicy.DESTROY,
        }),
      },
    );

    // Read-only ownership lookups — GetItem only, on exactly the 3 tables
    // the design's ownership resolution needs. grantReadData (not a
    // broader grantReadWriteData) so this role can never mutate any of
    // them.
    props.executionsTable.grantReadData(this.traceQueryHandlerFunction);
    props.conversationsTable.grantReadData(this.traceQueryHandlerFunction);
    props.projectsTable.grantReadData(this.traceQueryHandlerFunction);

    // X-Ray read APIs have no resource-level IAM scoping — AWS requires
    // Resource:* for GetTraceSummaries/BatchGetTraces (design §1
    // "Justification"). This is the ONLY Resource:* on this role; it
    // carries zero write actions and zero xray:Put* (invariant 3).
    this.traceQueryHandlerFunction.addToRolePolicy(
      new iam.PolicyStatement({
        effect: iam.Effect.ALLOW,
        actions: ["xray:GetTraceSummaries", "xray:BatchGetTraces"],
        resources: ["*"],
      }),
    );

    NagSuppressions.addResourceSuppressions(
      this.traceQueryHandlerFunction.role!,
      [
        {
          id: "AwsSolutions-IAM5",
          reason:
            "X-Ray read APIs (xray:GetTraceSummaries, xray:BatchGetTraces) " +
            "have no resource-level IAM scoping — AWS requires Resource:* " +
            "for these actions. The trace handler's IAM role carries no " +
            "other Resource:* grant and zero write/xray:Put* actions; " +
            "authorization is enforced in-Lambda via entry-key ownership " +
            "(execution/conversation -> org) checked BEFORE any X-Ray call, " +
            "plus an admin-only gate on the raw trace-id route.",
          appliesTo: ["Resource::*"],
        },
      ],
      true,
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

    // Waterfall trace viewer routes (pass 1) — same costHttpApi, same JWT
    // authorizer, new TraceQueryHandler integration. All 3 routes are
    // GET-only; the handler itself enforces ownership/admin gating
    // in-Lambda (design §1) — the authorizer only proves WHO is calling,
    // not WHAT org/trace they may see.
    const traceQueryIntegration =
      new apigatewayv2Integrations.HttpLambdaIntegration(
        "TraceQueryIntegration",
        this.traceQueryHandlerFunction,
      );

    this.costHttpApi.addRoutes({
      path: "/traces/by-execution/{executionId}",
      methods: [apigatewayv2.HttpMethod.GET],
      integration: traceQueryIntegration,
      authorizer: costJwtAuthorizer,
    });
    this.costHttpApi.addRoutes({
      path: "/traces/by-conversation/{conversationId}",
      methods: [apigatewayv2.HttpMethod.GET],
      integration: traceQueryIntegration,
      authorizer: costJwtAuthorizer,
    });
    this.costHttpApi.addRoutes({
      path: "/traces/{traceId}",
      methods: [apigatewayv2.HttpMethod.GET],
      integration: traceQueryIntegration,
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

    // ========================================================================
    // Platform-health dashboard + SLO alarms (dashboards + alarms story,
    // decision ab73ae1b: TelemetryStack owns them). ONE dashboard;
    // per-stack dashboards deliberately DEFERRED (architect design §1).
    // All 6 new alarms reuse props.alarmTopic — no new SNS topic (§5).
    // ========================================================================

    this.platformHealthDashboardName = `citadel-platform-health-${props.environment}`;

    // --- Section 0: health strip (SingleValue widgets, 1h) -----------------
    const workflowFailuresStripWidget = new cloudwatch.TextWidget({
      markdown: "## Section 0 — Health strip (1h)",
      width: 24,
      height: 1,
    });

    const nodeFailureInsightsQuery = `SELECT SUM("${METRIC_NODE_FAILURE}") FROM SCHEMA("${METRIC_NAMESPACE}", ${DIMENSION_WORKFLOW_ID}, ${DIMENSION_AGENT_ID})`;
    const dlqDepthInsightsQuery = `SELECT MAX("ApproximateNumberOfMessagesVisible") FROM SCHEMA("AWS/SQS", QueueName) WHERE QueueName LIKE 'citadel-%dlq%'`;

    const healthStripWidgets = [
      new cloudwatch.SingleValueWidget({
        title: "Workflow failures (1h)",
        metrics: [
          new cloudwatch.MathExpression({
            expression: nodeFailureInsightsQuery,
            usingMetrics: {},
            label: "NodeFailure (Sum)",
            period: cdk.Duration.hours(1),
          }),
        ],
        width: 5,
        height: 4,
      }),
      new cloudwatch.SingleValueWidget({
        title: "AppSync 5XX (1h)",
        metrics: [
          new cloudwatch.Metric({
            namespace: "AWS/AppSync",
            metricName: "5XXError",
            dimensionsMap: { GraphQLAPIId: props.appSyncApiId },
            statistic: "Sum",
            period: cdk.Duration.hours(1),
          }),
        ],
        width: 5,
        height: 4,
      }),
      new cloudwatch.SingleValueWidget({
        title: "Max DLQ depth",
        metrics: [
          new cloudwatch.MathExpression({
            expression: dlqDepthInsightsQuery,
            usingMetrics: {},
            label: "Max DLQ ApproxMessagesVisible",
            period: cdk.Duration.hours(1),
          }),
        ],
        width: 5,
        height: 4,
      }),
      new cloudwatch.SingleValueWidget({
        title: "Cost-reconciler windows reconciled (1h)",
        metrics: [
          new cloudwatch.Metric({
            namespace: COST_RECONCILER_NAMESPACE,
            metricName: METRIC_WINDOWS_RECONCILED,
            dimensionsMap: { [DIMENSION_ENVIRONMENT]: props.environment },
            statistic: "Sum",
            period: cdk.Duration.hours(1),
          }),
        ],
        setPeriodToTimeRange: true,
        width: 5,
        height: 4,
      }),
      new cloudwatch.SingleValueWidget({
        title: "Escalations (1h)",
        metrics: [
          new cloudwatch.Metric({
            namespace: GOVERNANCE_NAMESPACE,
            metricName: METRIC_OFF_FRONTIER_ESCALATIONS,
            statistic: "Sum",
            period: cdk.Duration.hours(1),
          }),
        ],
        width: 4,
        height: 4,
      }),
    ];

    // --- Section 1: API health ---------------------------------------------
    const apiHealthWidgets = [
      new cloudwatch.TextWidget({
        markdown: "## Section 1 — API health",
        width: 24,
        height: 1,
      }),
      new cloudwatch.GraphWidget({
        title: "AppSync errors (4XX/5XX)",
        left: [
          new cloudwatch.Metric({
            namespace: "AWS/AppSync",
            metricName: "4XXError",
            dimensionsMap: { GraphQLAPIId: props.appSyncApiId },
            statistic: "Sum",
            period: cdk.Duration.minutes(5),
          }),
          new cloudwatch.Metric({
            namespace: "AWS/AppSync",
            metricName: "5XXError",
            dimensionsMap: { GraphQLAPIId: props.appSyncApiId },
            statistic: "Sum",
            period: cdk.Duration.minutes(5),
          }),
        ],
        width: 12,
        height: 6,
      }),
      new cloudwatch.GraphWidget({
        title: "AppSync latency (p50/p90) & requests",
        left: [
          new cloudwatch.Metric({
            namespace: "AWS/AppSync",
            metricName: "Latency",
            dimensionsMap: { GraphQLAPIId: props.appSyncApiId },
            statistic: "p50",
            period: cdk.Duration.minutes(5),
          }),
          new cloudwatch.Metric({
            namespace: "AWS/AppSync",
            metricName: "Latency",
            dimensionsMap: { GraphQLAPIId: props.appSyncApiId },
            statistic: "p90",
            period: cdk.Duration.minutes(5),
          }),
        ],
        right: [
          new cloudwatch.Metric({
            namespace: "AWS/AppSync",
            metricName: "Requests",
            dimensionsMap: { GraphQLAPIId: props.appSyncApiId },
            statistic: "Sum",
            period: cdk.Duration.minutes(5),
          }),
        ],
        width: 12,
        height: 6,
      }),
      new cloudwatch.GraphWidget({
        title: "HTTP APIs (cost + gateway) — 5xx/4xx",
        left: [
          new cloudwatch.Metric({
            namespace: "AWS/ApiGatewayV2",
            metricName: "5xx",
            dimensionsMap: { ApiId: this.costHttpApi.apiId },
            statistic: "Sum",
            period: cdk.Duration.minutes(5),
          }),
          new cloudwatch.Metric({
            namespace: "AWS/ApiGatewayV2",
            metricName: "4xx",
            dimensionsMap: { ApiId: this.costHttpApi.apiId },
            statistic: "Sum",
            period: cdk.Duration.minutes(5),
          }),
        ],
        width: 12,
        height: 6,
      }),
      new cloudwatch.GraphWidget({
        title:
          "Published apps HTTP APIs — 5xx (SEARCH, auto-includes new apps)",
        left: [
          new cloudwatch.MathExpression({
            expression: `SEARCH('{AWS/ApiGateway,ApiId} MetricName="5XXError"', 'Sum', 300)`,
            usingMetrics: {},
            label: "Published app APIs 5XXError",
          }),
        ],
        width: 12,
        height: 6,
      }),
    ];

    // --- Section 2: workflow health (new metrics) ---------------------------
    const workflowHealthWidgets = [
      new cloudwatch.TextWidget({
        markdown: "## Section 2 — Workflow health",
        width: 24,
        height: 1,
      }),
      new cloudwatch.GraphWidget({
        title: "Node duration (p50/p90, ms) — SEARCH across WorkflowId/AgentId",
        left: [
          new cloudwatch.MathExpression({
            expression: `SEARCH('{${METRIC_NAMESPACE},${DIMENSION_WORKFLOW_ID},${DIMENSION_AGENT_ID}} MetricName="${METRIC_NODE_DURATION_MS}"', 'p50', 300)`,
            usingMetrics: {},
            label: "NodeDurationMs p50",
          }),
          new cloudwatch.MathExpression({
            expression: `SEARCH('{${METRIC_NAMESPACE},${DIMENSION_WORKFLOW_ID},${DIMENSION_AGENT_ID}} MetricName="${METRIC_NODE_DURATION_MS}"', 'p90', 300)`,
            usingMetrics: {},
            label: "NodeDurationMs p90",
          }),
        ],
        width: 12,
        height: 6,
      }),
      new cloudwatch.GraphWidget({
        title: "Queue wait (p90, ms) — SEARCH across WorkflowId/AgentId",
        left: [
          new cloudwatch.MathExpression({
            expression: `SEARCH('{${METRIC_NAMESPACE},${DIMENSION_WORKFLOW_ID},${DIMENSION_AGENT_ID}} MetricName="${METRIC_NODE_QUEUE_WAIT_MS}"', 'p90', 300)`,
            usingMetrics: {},
            label: "NodeQueueWaitMs p90",
          }),
        ],
        width: 12,
        height: 6,
      }),
      new cloudwatch.GraphWidget({
        title:
          "Node failures — per-WorkflowId breakdown (SEARCH) + total (Insights)",
        left: [
          new cloudwatch.MathExpression({
            expression: `SEARCH('{${METRIC_NAMESPACE},${DIMENSION_WORKFLOW_ID},${DIMENSION_AGENT_ID}} MetricName="${METRIC_NODE_FAILURE}"', 'Sum', 300)`,
            usingMetrics: {},
            label: "NodeFailure by WorkflowId",
          }),
        ],
        width: 12,
        height: 6,
      }),
      new cloudwatch.GraphWidget({
        title: "Cold starts (Sum) — SEARCH across WorkflowId/AgentId",
        left: [
          new cloudwatch.MathExpression({
            expression: `SEARCH('{${METRIC_NAMESPACE},${DIMENSION_WORKFLOW_ID},${DIMENSION_AGENT_ID}} MetricName="${METRIC_NODE_COLD_START}"', 'Sum', 300)`,
            usingMetrics: {},
            label: "NodeColdStart",
          }),
        ],
        width: 12,
        height: 6,
      }),
      new cloudwatch.GraphWidget({
        title:
          "Worker/Supervisor/Fabricator Lambdas — Errors/Throttles/Concurrency/Duration p90",
        left: [
          new cloudwatch.MathExpression({
            expression: `SEARCH('{AWS/Lambda,FunctionName} MetricName="Errors" FunctionName="citadel-worker-agent-wrapper-${props.environment}" OR FunctionName="citadel-supervisor-agent-${props.environment}" OR FunctionName="citadel-fabricator-agent-${props.environment}"', 'Sum', 300)`,
            usingMetrics: {},
            label: "Errors",
          }),
          new cloudwatch.MathExpression({
            expression: `SEARCH('{AWS/Lambda,FunctionName} MetricName="Throttles" FunctionName="citadel-worker-agent-wrapper-${props.environment}" OR FunctionName="citadel-supervisor-agent-${props.environment}" OR FunctionName="citadel-fabricator-agent-${props.environment}"', 'Sum', 300)`,
            usingMetrics: {},
            label: "Throttles",
          }),
        ],
        right: [
          new cloudwatch.MathExpression({
            expression: `SEARCH('{AWS/Lambda,FunctionName} MetricName="Duration" FunctionName="citadel-worker-agent-wrapper-${props.environment}" OR FunctionName="citadel-supervisor-agent-${props.environment}" OR FunctionName="citadel-fabricator-agent-${props.environment}"', 'p90', 300)`,
            usingMetrics: {},
            label: "Duration p90",
          }),
        ],
        width: 24,
        height: 6,
      }),
    ];

    // --- Section 3: cost & reconciliation ------------------------------------
    const costReconciliationWidgets = [
      new cloudwatch.TextWidget({
        markdown: "## Section 3 — Cost & reconciliation",
        width: 24,
        height: 1,
      }),
      new cloudwatch.GraphWidget({
        title: "Abs estimate drift % (Max) — 25% SLO annotation",
        left: [
          new cloudwatch.Metric({
            namespace: COST_RECONCILER_NAMESPACE,
            metricName: METRIC_ABS_ESTIMATE_DRIFT_PCT,
            dimensionsMap: { [DIMENSION_ENVIRONMENT]: props.environment },
            statistic: "Maximum",
            period: cdk.Duration.hours(1),
          }),
        ],
        leftAnnotations: [
          {
            value: 25,
            label: "25% dev-calibrated SLO threshold",
            color: cloudwatch.Color.RED,
          },
        ],
        width: 12,
        height: 6,
      }),
      new cloudwatch.GraphWidget({
        title: "Windows reconciled (Sum, liveness) & unmatched ledger models",
        left: [
          new cloudwatch.Metric({
            namespace: COST_RECONCILER_NAMESPACE,
            metricName: METRIC_WINDOWS_RECONCILED,
            dimensionsMap: { [DIMENSION_ENVIRONMENT]: props.environment },
            statistic: "Sum",
            period: cdk.Duration.hours(1),
          }),
          new cloudwatch.Metric({
            namespace: COST_RECONCILER_NAMESPACE,
            metricName: METRIC_UNMATCHED_LEDGER_MODELS,
            dimensionsMap: { [DIMENSION_ENVIRONMENT]: props.environment },
            statistic: "Sum",
            period: cdk.Duration.hours(1),
          }),
        ],
        width: 12,
        height: 6,
      }),
      new cloudwatch.GraphWidget({
        title: "Ledger tokens vs metric tokens (drift context) & Tier B active",
        left: [
          new cloudwatch.Metric({
            namespace: COST_RECONCILER_NAMESPACE,
            metricName: METRIC_LEDGER_TOKENS,
            dimensionsMap: { [DIMENSION_ENVIRONMENT]: props.environment },
            statistic: "Sum",
            period: cdk.Duration.hours(1),
          }),
          new cloudwatch.Metric({
            namespace: COST_RECONCILER_NAMESPACE,
            metricName: METRIC_METRIC_TOKENS,
            dimensionsMap: { [DIMENSION_ENVIRONMENT]: props.environment },
            statistic: "Sum",
            period: cdk.Duration.hours(1),
          }),
        ],
        right: [
          new cloudwatch.Metric({
            namespace: COST_RECONCILER_NAMESPACE,
            metricName: METRIC_TIER_B_ACTIVE,
            dimensionsMap: { [DIMENSION_ENVIRONMENT]: props.environment },
            statistic: "Maximum",
            period: cdk.Duration.hours(1),
          }),
        ],
        width: 24,
        height: 6,
      }),
    ];

    // --- Section 4: governance -----------------------------------------------
    const governanceWidgets = [
      new cloudwatch.TextWidget({
        markdown: "## Section 4 — Governance",
        width: 24,
        height: 1,
      }),
      new cloudwatch.GraphWidget({
        title: "Off-frontier escalations (Sum, 1h) — by ProjectId",
        left: [
          new cloudwatch.Metric({
            namespace: GOVERNANCE_NAMESPACE,
            metricName: METRIC_OFF_FRONTIER_ESCALATIONS,
            statistic: "Sum",
            period: cdk.Duration.hours(1),
          }),
        ],
        width: 12,
        height: 6,
      }),
      new cloudwatch.AlarmStatusWidget({
        title: "Existing escalation alarm status",
        alarms: [
          cloudwatch.Alarm.fromAlarmArn(
            this,
            "OffFrontierEscalationAlarmRef",
            cdk.Arn.format(
              {
                service: "cloudwatch",
                resource: "alarm",
                resourceName: `citadel-offfrontier-escalations-${props.environment}`,
                arnFormat: cdk.ArnFormat.COLON_RESOURCE_NAME,
              },
              this,
            ),
          ),
        ],
        width: 12,
        height: 6,
      }),
    ];

    // --- Section 5: DLQ / error budget ---------------------------------------
    const dlqAndErrorBudgetWidgets = [
      new cloudwatch.TextWidget({
        markdown: "## Section 5 — DLQ / error budget",
        width: 24,
        height: 1,
      }),
      new cloudwatch.GraphWidget({
        title: "DLQ depth & oldest-message age (SEARCH, citadel-*dlq*)",
        left: [
          new cloudwatch.MathExpression({
            expression: `SEARCH('{AWS/SQS,QueueName} MetricName="ApproximateNumberOfMessagesVisible" QueueName="citadel-*dlq*"', 'Maximum', 300)`,
            usingMetrics: {},
            label: "DLQ depth",
          }),
        ],
        right: [
          new cloudwatch.MathExpression({
            expression: `SEARCH('{AWS/SQS,QueueName} MetricName="ApproximateAgeOfOldestMessage" QueueName="citadel-*dlq*"', 'Maximum', 300)`,
            usingMetrics: {},
            label: "Oldest message age",
          }),
        ],
        width: 12,
        height: 6,
      }),
      new cloudwatch.GraphWidget({
        title: "DynamoDB throttles/errors — cost ledger + key tables",
        left: [
          this.costLedgerTable.metricThrottledRequestsForOperation("Query", {
            period: cdk.Duration.minutes(5),
          }),
          this.costLedgerTable.metricSystemErrorsForOperations({
            operations: [dynamodb.Operation.QUERY, dynamodb.Operation.PUT_ITEM],
            period: cdk.Duration.minutes(5),
          }),
        ],
        width: 12,
        height: 6,
      }),
    ];

    const allPlatformHealthAlarmNames = [
      `citadel-workflow-node-failure-${props.environment}`,
      `citadel-workflow-queue-wait-${props.environment}`,
      `citadel-appsync-5xx-${props.environment}`,
      `citadel-dlq-not-empty-${props.environment}`,
      `citadel-cost-reconciler-stalled-${props.environment}`,
      `citadel-cost-drift-high-${props.environment}`,
    ];
    const alarmStatusWidget = new cloudwatch.AlarmStatusWidget({
      title: "Platform-health alarms — traffic light",
      alarms: allPlatformHealthAlarmNames.map(
        (name, i) =>
          cloudwatch.Alarm.fromAlarmArn(
            this,
            `PlatformHealthAlarmRef${i}`,
            cdk.Arn.format(
              {
                service: "cloudwatch",
                resource: "alarm",
                resourceName: name,
                arnFormat: cdk.ArnFormat.COLON_RESOURCE_NAME,
              },
              this,
            ),
          ) as cloudwatch.IAlarm,
      ),
      width: 24,
      height: 6,
    });

    new cloudwatch.Dashboard(this, "PlatformHealthDashboard", {
      dashboardName: this.platformHealthDashboardName,
      widgets: [
        [workflowFailuresStripWidget],
        healthStripWidgets,
        apiHealthWidgets,
        workflowHealthWidgets,
        costReconciliationWidgets,
        governanceWidgets,
        [...dlqAndErrorBudgetWidgets, alarmStatusWidget],
      ],
    });

    // --- Alarms (6 new; all -> props.alarmTopic; §3) -------------------------
    // Thresholds below are DEV-CALIBRATED STARTING POINTS, not final SLOs.
    // Tuning path (docs/OBSERVABILITY.md): after 2 weeks of real traffic,
    // pull p90/p99 of NodeDurationMs/NodeQueueWaitMs and the AppSync 5XX
    // rate from CloudWatch, set thresholds to baseline x agreed-multiplier,
    // and record the change as an ADR. No threshold here is final.

    // A1 — node-failure: any terminal node failure in 15m is actionable at
    // dev scale. dev-calibrated; TUNE with prod baseline.
    const nodeFailureAlarm = new cloudwatch.Alarm(this, "NodeFailureAlarm", {
      alarmName: `citadel-workflow-node-failure-${props.environment}`,
      metric: new cloudwatch.MathExpression({
        expression: nodeFailureInsightsQuery,
        usingMetrics: {},
        period: cdk.Duration.minutes(5),
      }),
      threshold: 1, // dev-calibrated; TUNE with prod baseline
      evaluationPeriods: 3,
      datapointsToAlarm: 1,
      comparisonOperator:
        cloudwatch.ComparisonOperator.GREATER_THAN_OR_EQUAL_TO_THRESHOLD,
      treatMissingData: cloudwatch.TreatMissingData.NOT_BREACHING,
      alarmDescription:
        "Terminal workflow node failure detected. Runbook: open the failing " +
        "execution in the trace viewer (/traces/by-execution), check " +
        "citadel-*-dlq-* depth, inspect WorkerAgentWrapper logs.",
    });
    nodeFailureAlarm.addAlarmAction(new cw_actions.SnsAction(props.alarmTopic));

    // A2 — queue-wait: sustained 30s dispatch->worker-start wait indicates
    // concurrency starvation/throttling. dev-calibrated; TUNE with prod baseline.
    const queueWaitAlarm = new cloudwatch.Alarm(this, "QueueWaitAlarm", {
      alarmName: `citadel-workflow-queue-wait-${props.environment}`,
      metric: new cloudwatch.MathExpression({
        expression: `SELECT MAX("${METRIC_NODE_QUEUE_WAIT_MS}") FROM SCHEMA("${METRIC_NAMESPACE}", ${DIMENSION_WORKFLOW_ID}, ${DIMENSION_AGENT_ID})`,
        usingMetrics: {},
        period: cdk.Duration.minutes(5),
      }),
      threshold: 30000, // ms; dev-calibrated; TUNE with prod baseline
      evaluationPeriods: 3,
      datapointsToAlarm: 3,
      comparisonOperator: cloudwatch.ComparisonOperator.GREATER_THAN_THRESHOLD,
      treatMissingData: cloudwatch.TreatMissingData.NOT_BREACHING,
      alarmDescription:
        "Sustained worker dispatch queue wait. Runbook: check " +
        "WorkerAgentWrapper Throttles/ConcurrentExecutions + SQS backlog; " +
        "raise reserved concurrency.",
    });
    queueWaitAlarm.addAlarmAction(new cw_actions.SnsAction(props.alarmTopic));

    // A3 — AppSync 5xx: a burst of server errors on the single control-plane
    // API breaks the acceptance-path chat/resolvers. dev-calibrated; TUNE with prod baseline.
    const appSync5xxAlarm = new cloudwatch.Alarm(this, "AppSync5xxAlarm", {
      alarmName: `citadel-appsync-5xx-${props.environment}`,
      metric: new cloudwatch.Metric({
        namespace: "AWS/AppSync",
        metricName: "5XXError",
        dimensionsMap: { GraphQLAPIId: props.appSyncApiId },
        statistic: "Sum",
        period: cdk.Duration.minutes(5),
      }),
      threshold: 5, // dev-calibrated; TUNE with prod baseline
      evaluationPeriods: 1,
      datapointsToAlarm: 1,
      comparisonOperator:
        cloudwatch.ComparisonOperator.GREATER_THAN_OR_EQUAL_TO_THRESHOLD,
      treatMissingData: cloudwatch.TreatMissingData.NOT_BREACHING,
      alarmDescription:
        "AppSync 5XX burst. Runbook: check resolver CloudWatch logs + " +
        "X-Ray for the failing field; check for a recent deploy.",
    });
    appSync5xxAlarm.addAlarmAction(new cw_actions.SnsAction(props.alarmTopic));

    // A4 — dlq-not-empty: any message in any DLQ means an async handler
    // exhausted retries. dev-calibrated; TUNE with prod baseline.
    const dlqNotEmptyAlarm = new cloudwatch.Alarm(this, "DlqNotEmptyAlarm", {
      alarmName: `citadel-dlq-not-empty-${props.environment}`,
      metric: new cloudwatch.MathExpression({
        expression: dlqDepthInsightsQuery,
        usingMetrics: {},
        period: cdk.Duration.minutes(5),
      }),
      threshold: 1, // dev-calibrated; TUNE with prod baseline
      evaluationPeriods: 1,
      datapointsToAlarm: 1,
      comparisonOperator:
        cloudwatch.ComparisonOperator.GREATER_THAN_OR_EQUAL_TO_THRESHOLD,
      treatMissingData: cloudwatch.TreatMissingData.NOT_BREACHING,
      alarmDescription:
        "A message landed in a citadel-*-dlq-*. Runbook: identify the " +
        "queue, read the message, fix the handler, redrive.",
    });
    dlqNotEmptyAlarm.addAlarmAction(new cw_actions.SnsAction(props.alarmTopic));

    // A5 — reconciler-stalled: the hourly reconciler emits 1 datapoint per
    // run; 3 empty hours means it's broken. Absence IS the failure here, so
    // treatMissingData is BREACHING (the one deliberate exception to the
    // notBreaching default above). dev-calibrated; TUNE with prod baseline.
    const reconcilerStalledAlarm = new cloudwatch.Alarm(
      this,
      "ReconcilerStalledAlarm",
      {
        alarmName: `citadel-cost-reconciler-stalled-${props.environment}`,
        metric: new cloudwatch.Metric({
          namespace: COST_RECONCILER_NAMESPACE,
          metricName: METRIC_WINDOWS_RECONCILED,
          dimensionsMap: { [DIMENSION_ENVIRONMENT]: props.environment },
          statistic: "Sum",
          period: cdk.Duration.hours(1),
        }),
        threshold: 1, // dev-calibrated; TUNE with prod baseline
        evaluationPeriods: 3,
        datapointsToAlarm: 3,
        comparisonOperator: cloudwatch.ComparisonOperator.LESS_THAN_THRESHOLD,
        treatMissingData: cloudwatch.TreatMissingData.BREACHING,
        alarmDescription:
          "Cost-ledger reconciler has not run in 3h — absence IS the " +
          "failure. Runbook: check citadel-cost-ledger-reconciler Lambda " +
          "errors/logs and confirm the hourly schedule rule is enabled.",
      },
    );
    reconcilerStalledAlarm.addAlarmAction(
      new cw_actions.SnsAction(props.alarmTopic),
    );

    // A6 — drift-high: ledger estimate vs Bedrock actual diverging >25%
    // over 3h signals stale pricing catalog / model-key mismatch.
    // dev-calibrated; TUNE with prod baseline (loose 25% to avoid noise on
    // small dev-scale token counts).
    const costDriftHighAlarm = new cloudwatch.Alarm(
      this,
      "CostDriftHighAlarm",
      {
        alarmName: `citadel-cost-drift-high-${props.environment}`,
        metric: new cloudwatch.Metric({
          namespace: COST_RECONCILER_NAMESPACE,
          metricName: METRIC_ABS_ESTIMATE_DRIFT_PCT,
          dimensionsMap: { [DIMENSION_ENVIRONMENT]: props.environment },
          statistic: "Maximum",
          period: cdk.Duration.hours(1),
        }),
        threshold: 25, // percent; dev-calibrated; TUNE with prod baseline
        evaluationPeriods: 3,
        datapointsToAlarm: 3,
        comparisonOperator:
          cloudwatch.ComparisonOperator.GREATER_THAN_THRESHOLD,
        treatMissingData: cloudwatch.TreatMissingData.NOT_BREACHING,
        alarmDescription:
          "Cost-ledger estimate vs Bedrock actual diverging >25% over 3h. " +
          "Runbook: verify model-catalog pricing freshness + UnmatchedLedgerModels.",
      },
    );
    costDriftHighAlarm.addAlarmAction(
      new cw_actions.SnsAction(props.alarmTopic),
    );
  }
}
