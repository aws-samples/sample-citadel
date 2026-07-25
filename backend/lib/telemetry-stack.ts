import * as cdk from "aws-cdk-lib";
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
  /** Shared EventBridge bus (from BackendStack) — telemetry only consumes, never publishes this pass. */
  agentEventBus: events.IEventBus;
  /** Model catalog table (from BackendStack) — read access for pass-2 pricing lookup. */
  modelCatalogTable: dynamodb.ITable;
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
          ENVIRONMENT: props.environment,
          SETTLE_LAG_MINUTES: "15",
          MAX_WINDOWS_PER_RUN: "6",
          METRIC_NAMESPACE: "Citadel/CostReconciler",
          COST_RECONCILER_TIER_B_ENABLED: "false",
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
  }
}
