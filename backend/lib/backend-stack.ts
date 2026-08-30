import * as cdk from "aws-cdk-lib";
import * as appsync from "aws-cdk-lib/aws-appsync";
import * as cognito from "aws-cdk-lib/aws-cognito";
import * as dynamodb from "aws-cdk-lib/aws-dynamodb";
import * as lambda from "aws-cdk-lib/aws-lambda";
import * as events from "aws-cdk-lib/aws-events";
import * as targets from "aws-cdk-lib/aws-events-targets";
import * as iam from "aws-cdk-lib/aws-iam";
import * as logs from "aws-cdk-lib/aws-logs";
import * as ssm from "aws-cdk-lib/aws-ssm";
import * as cloudwatch from "aws-cdk-lib/aws-cloudwatch";
import * as cw_actions from "aws-cdk-lib/aws-cloudwatch-actions";
import * as sns from "aws-cdk-lib/aws-sns";
import {
  attachAlarmDelivery,
  type AlarmDeliveryConfig,
} from "./alarm-delivery";
import { BlockPublicAccess, Bucket } from "aws-cdk-lib/aws-s3";
import { Asset } from "aws-cdk-lib/aws-s3-assets";
import { CfnGraphQLSchema } from "aws-cdk-lib/aws-appsync";
import * as path from "path";
import { Construct } from "constructs";
import { NagSuppressions } from "cdk-nag";

interface BackendStackProps extends cdk.StackProps {
  environment: string;
  /**
   * Resolved alarm-delivery destination (email | slack | none) for the
   * shared alarm topic, resolved ONCE in bin/app.ts from backend/.env / CDK
   * context and passed down (same pattern as the resolved frontendOrigin).
   * Optional so tests synth without it; absent is treated as 'none'.
   */
  alarmDelivery?: AlarmDeliveryConfig;
}

export class BackendStack extends cdk.Stack {
  public readonly appSyncApi: appsync.GraphqlApi;
  public readonly userPool: cognito.UserPool;
  public readonly userPoolClient: cognito.UserPoolClient;
  public readonly agentConfigTable: dynamodb.Table;
  public readonly agentEventBus: events.EventBus;
  public readonly projectsTable: dynamodb.Table;
  public readonly conversationsTable: dynamodb.Table;
  public readonly documentBucket: Bucket;
  public readonly codeBucket: Bucket;
  public readonly accessLogsBucket: Bucket;
  public readonly workflowsTable: dynamodb.Table;
  public readonly appsTable: dynamodb.Table;
  /**
   * Model-config table — exposed publicly (CIT-026 replay package,
   * design §4) so TelemetryStack can grant read-only access for the
   * replay envelope's `modelConfig` section. Previously a local `const`
   * with no cross-stack consumer.
   */
  public readonly modelConfigTable: dynamodb.Table;
  public readonly executionsTable: dynamodb.Table;
  public readonly adrsTable: dynamodb.Table;
  public readonly agentDesignAssessmentsTable: dynamodb.Table;
  public readonly executionSpecificationsTable: dynamodb.Table;
  // CIT-101: eval suites are release evidence, governed like
  // ExecutionSpecifications (RETAIN + deletionProtection + PITR). Passed as
  // dynamodb.ITable props into GovernanceStack, which owns the eval-resolver.
  public readonly evalSuitesTable: dynamodb.Table;
  public readonly evalCasesTable: dynamodb.Table;
  // CIT-102: eval runs are E11 release evidence (an eval run is proof that
  // agentVersion X was validated against suiteVersion Y) — same RETAIN +
  // deletionProtection + PITR posture as EvalSuites/EvalCases, no TTL.
  // Passed as dynamodb.ITable props into GovernanceStack, which owns the
  // eval-run-resolver/eval-runner/eval-conversation-worker.
  public readonly evalRunsTable: dynamodb.Table;
  public readonly evalRunCaseResultsTable: dynamodb.Table;
  // Agent release bundles (slice 1) — content-addressed, immutable audit
  // record pinning an agent's full constituent set (config, prompts,
  // exec spec, model config, tools, policy) plus its non-nullable eval
  // evidence at cut time. Placed here, sibling to EvalRuns/
  // EvalRunCaseResults above, because a release's eval evidence is a
  // pointer into those exact tables — same file, same construction
  // order, same RETAIN + deletionProtection + PITR governance posture.
  // The sole writer is release-store.ts (see
  // release-store-choke-point.guard.test.ts); IAM below grants
  // PutItem/GetItem/Query only — no UpdateItem, no DeleteItem, to any
  // principal.
  public readonly agentReleasesTable: dynamodb.Table;
  /** IAM floor for AgentReleasesTable — PutItem/GetItem/Query only, see
   * construction site below for the full rationale. */
  public readonly agentReleaseWriterRole: iam.Role;
  // Environment release pointer (follow-on to slices 1-2) — the MUTABLE
  // cursor saying which AgentRelease an (org, agentTargetId, environment)
  // triple currently runs. Deliberately separate table AND separate
  // writer role from AgentReleasesTable above: this table needs
  // UpdateItem-equivalent write capability (a Put that moves the pointer,
  // optimistic-locked via a version ConditionExpression at the write
  // boundary — see environment-release-pointer-store.ts), and that
  // capability must never be co-granted on AgentReleasesTable, which
  // Slice 1 guarantees carries zero UpdateItem/DeleteItem from any
  // principal. See backend-stack-environment-release-pointer-table.test.ts
  // for the assertion that no single IAM statement names both tables.
  public readonly environmentReleasePointersTable: dynamodb.Table;
  /** IAM floor for EnvironmentReleasePointersTable — PutItem/GetItem/Query
   * only (the Put IS the mutation; there is no separate UpdateItem call —
   * see environment-release-pointer-store.ts). No DeleteItem anywhere:
   * deleting a pointer would erase deployment history. */
  public readonly environmentReleasePointerWriterRole: iam.Role;
  // Phase 2 (production sampling) — admin-authored per-org sampling
  // config (small, not release evidence — no RETAIN/deletionProtection
  // needed, but PITR kept for consistency) and the captured+scored
  // production-sample rows (RETAIN — an audit/observability record, same
  // posture rationale as EvalRuns).
  public readonly evalSamplingConfigTable: dynamodb.Table;
  public readonly evalProdSamplesTable: dynamodb.Table;
  // Decision ada70113 (promotion policy becomes per-org config) — small
  // admin-authored config table, same posture as EvalSamplingConfigTable
  // (DESTROY-ok, PITR kept for consistency, no RETAIN/deletionProtection —
  // re-authored on next admin write, DEFAULT_PROMOTION_POLICY always
  // available in code as the floor). Two SEPARATE, narrow IAM floors
  // (mirrors AgentReleasesTable/EnvironmentReleasePointersTable's
  // separate-role doctrine): the pointer resolver (read path, gates a
  // promotion) gets GetItem-only; the admin resolver (write path) gets
  // GetItem+PutItem. Neither role is granted on the other table this
  // decision touches.
  public readonly promotionPolicyConfigTable: dynamodb.Table;
  /** IAM floor for PROMOTION_POLICY_CONFIG_TABLE reads+writes from
   * promotion-policy-resolver.ts's admin getPromotionPolicy/
   * setPromotionPolicy — GetItem+PutItem only, explicitly NOT
   * grantWriteData (which would also confer UpdateItem/DeleteItem/
   * BatchWriteItem). The READ side consumed by the promotion gate itself
   * (environment-release-pointer-resolver.ts's validateReleaseGate) is
   * NOT a separate role here — it is a scoped GetItem-only
   * PolicyStatement added directly onto the EXISTING
   * environmentReleasePointerWriterRole below, mirroring how that role
   * already carries a narrow GetItem-only statement for
   * AgentReleasesTable (see its construction site for the identical
   * rationale: a Lambda has exactly one execution role, so a second
   * table's read access is an additional scoped statement on that same
   * role, never a second role the function can't actually assume). */
  public readonly promotionPolicyConfigWriterRole: iam.Role;

  // CIT-105: baseline designation pointer + computed comparison verdicts
  // + threshold config — same RETAIN + deletionProtection + PITR posture
  // as EvalRuns for the two evidence tables (EvalBaselines/EvalComparisons);
  // EvalComparisonConfig is a small admin-authored config table (DESTROY-ok
  // like EvalSamplingConfigTable). Passed as dynamodb.ITable props into
  // GovernanceStack, which owns the eval-comparison-resolver (own file/IAM
  // role per kept-separate doctrine — distinct from eval-run-resolver).
  public readonly evalBaselinesTable: dynamodb.Table;
  public readonly evalComparisonsTable: dynamodb.Table;
  public readonly evalComparisonConfigTable: dynamodb.Table;
  public readonly workflowProgressFanoutFunction: lambda.Function;
  public readonly idempotencyTable: dynamodb.Table;
  public readonly interrogationRoundsTable: dynamodb.Table;
  public readonly programReviewsTable: dynamodb.Table;
  public readonly adrReopenAttemptsTable: dynamodb.Table;
  public readonly registryArn: string;
  public readonly registryId: string;
  // Exposed for TelemetryStack (pass-1 cost ledger): the writer Lambda needs
  // read access to model pricing metadata (pass-2 cost computation).
  public readonly modelCatalogTable: dynamodb.Table;
  // Exposed for ProjectsStack (backend-split phase 1): shared with the
  // unmoved agentMessageHandlerFunction, so it stays in BackendStack and is
  // passed to ProjectsStack as a prop rather than moving.
  public readonly agentStatusTable: dynamodb.Table;
  // Exposed for TelemetryStack (dashboards + alarms story, decision
  // ab73ae1b): the platform-health alarms reuse this existing topic rather
  // than provisioning a second one — on-call is already subscribed here
  // for the Lambda error/throttle alarms below. Was a local `const`;
  // promoted to a public readonly field, zero new resources.
  public readonly alarmTopic: sns.Topic;

  constructor(scope: Construct, id: string, props: BackendStackProps) {
    super(scope, id, props);

    // EventBridge for agent coordination
    this.agentEventBus = new events.EventBus(this, "AgentEventBus", {
      eventBusName: `citadel-agents-${props.environment}`,
    });

    // Idempotency table for EventBridge event deduplication (RE-05)
    this.idempotencyTable = new dynamodb.Table(this, "IdempotencyTable", {
      tableName: `citadel-idempotency-${props.environment}`,
      partitionKey: { name: "eventId", type: dynamodb.AttributeType.STRING },
      billingMode: dynamodb.BillingMode.PAY_PER_REQUEST,
      removalPolicy: cdk.RemovalPolicy.DESTROY,
      timeToLiveAttribute: "ttl",
      pointInTimeRecoverySpecification: { pointInTimeRecoveryEnabled: true },
    });

    // Projects Table
    this.projectsTable = new dynamodb.Table(this, "ProjectsTable", {
      tableName: `citadel-projects-${props.environment}`,
      partitionKey: { name: "id", type: dynamodb.AttributeType.STRING },
      billingMode: dynamodb.BillingMode.PAY_PER_REQUEST,
      removalPolicy: cdk.RemovalPolicy.DESTROY,
      pointInTimeRecoverySpecification: { pointInTimeRecoveryEnabled: true },
      stream: dynamodb.StreamViewType.NEW_AND_OLD_IMAGES,
    });

    this.projectsTable.addGlobalSecondaryIndex({
      indexName: "OrganizationIndex",
      partitionKey: {
        name: "organization",
        type: dynamodb.AttributeType.STRING,
      },
      sortKey: { name: "createdAt", type: dynamodb.AttributeType.STRING },
      projectionType: dynamodb.ProjectionType.ALL,
    });

    this.conversationsTable = new dynamodb.Table(this, "ConversationsTable", {
      tableName: `citadel-conversations-${props.environment}`,
      partitionKey: { name: "projectId", type: dynamodb.AttributeType.STRING },
      sortKey: { name: "timestamp", type: dynamodb.AttributeType.STRING },
      billingMode: dynamodb.BillingMode.PAY_PER_REQUEST,
      removalPolicy: cdk.RemovalPolicy.DESTROY,
      pointInTimeRecoverySpecification: { pointInTimeRecoveryEnabled: true },
    });

    this.accessLogsBucket = new Bucket(this, "AccessLogsBucket", {
      bucketName: `citadel-s3-logs-${props.environment}-${this.account}-${this.region}`,
      encryption: cdk.aws_s3.BucketEncryption.S3_MANAGED,
      blockPublicAccess: BlockPublicAccess.BLOCK_ALL,
      enforceSSL: true,
      removalPolicy: cdk.RemovalPolicy.DESTROY,
      autoDeleteObjects: true,
      lifecycleRules: [{ expiration: cdk.Duration.days(90) }],
    });
    const accessLogsBucket = this.accessLogsBucket;

    this.documentBucket = new Bucket(this, "DocumentBucket", {
      bucketName: `citadel-documents-${props.environment}-${this.account}-${this.region}`,
      versioned: true,
      encryption: cdk.aws_s3.BucketEncryption.S3_MANAGED,
      blockPublicAccess: BlockPublicAccess.BLOCK_ALL,
      enforceSSL: true,
      serverAccessLogsBucket: accessLogsBucket,
      serverAccessLogsPrefix: "documents/",
      removalPolicy: cdk.RemovalPolicy.DESTROY,
      autoDeleteObjects: true,
      cors: [
        {
          allowedHeaders: ["*"],
          allowedMethods: [
            cdk.aws_s3.HttpMethods.GET,
            cdk.aws_s3.HttpMethods.PUT,
            cdk.aws_s3.HttpMethods.POST,
            cdk.aws_s3.HttpMethods.HEAD,
          ],
          // The SPA PUTs documents directly to S3 with a presigned URL, so
          // every origin serving the app must pass the CORS preflight:
          // the deployed CloudFront default domain (wildcard — the
          // distribution lives in FrontendStack, which depends on this
          // stack, so its domain token cannot be referenced here without
          // a circular dependency) and the Vite dev server. An optional
          // synth-time ALLOWED_ORIGIN (custom domain) is APPENDED rather
          // than replacing the baseline list — the previous single-slot
          // design meant localhost never matched, so the preflight
          // OPTIONS was rejected and uploads failed with NetworkError.
          allowedOrigins: [
            "https://*.cloudfront.net",
            "http://localhost:3000",
            "http://127.0.0.1:3000",
            ...(process.env.ALLOWED_ORIGIN ? [process.env.ALLOWED_ORIGIN] : []),
          ],
          maxAge: 3000,
        },
      ],
    });

    this.codeBucket = new Bucket(this, "CodeBucket", {
      bucketName: `citadel-code-${props.environment}-${this.account}-${this.region}`,
      removalPolicy: cdk.RemovalPolicy.DESTROY,
      autoDeleteObjects: true,
      blockPublicAccess: BlockPublicAccess.BLOCK_ALL,
      enforceSSL: true,
      serverAccessLogsBucket: accessLogsBucket,
      serverAccessLogsPrefix: "code/",
      versioned: true, // Enable versioning for code files
    });

    // DynamoDB Tables
    const organisationTable = new dynamodb.Table(this, "OrganisationTable", {
      tableName: `citadel-organisations-${props.environment}`,
      partitionKey: { name: "orgId", type: dynamodb.AttributeType.STRING },
      billingMode: dynamodb.BillingMode.PAY_PER_REQUEST,
      removalPolicy: cdk.RemovalPolicy.DESTROY,
      pointInTimeRecoverySpecification: { pointInTimeRecoveryEnabled: true },
    });

    const agentStatusTable = (this.agentStatusTable = new dynamodb.Table(
      this,
      "AgentStatusTable",
      {
        tableName: `citadel-agent-status-${props.environment}`,
        partitionKey: {
          name: "projectId",
          type: dynamodb.AttributeType.STRING,
        },
        sortKey: { name: "agentId", type: dynamodb.AttributeType.STRING },
        billingMode: dynamodb.BillingMode.PAY_PER_REQUEST,
        removalPolicy: cdk.RemovalPolicy.DESTROY,
        pointInTimeRecoverySpecification: { pointInTimeRecoveryEnabled: true },
      },
    ));

    this.agentConfigTable = new dynamodb.Table(this, "AgentConfigTable", {
      tableName: `citadel-agents-${props.environment}`,
      partitionKey: { name: "agentId", type: dynamodb.AttributeType.STRING },
      billingMode: dynamodb.BillingMode.PAY_PER_REQUEST,
      removalPolicy: cdk.RemovalPolicy.DESTROY,
      pointInTimeRecoverySpecification: { pointInTimeRecoveryEnabled: true },
    });

    // Model Catalog Table — inventory of invokable foundation models. Additive and
    // not yet wired into any runtime/Lambda env; operators curate rows over time.
    const modelCatalogTable = (this.modelCatalogTable = new dynamodb.Table(
      this,
      "ModelCatalogTable",
      {
        tableName: `citadel-model-catalog-${props.environment}`,
        partitionKey: { name: "modelKey", type: dynamodb.AttributeType.STRING },
        billingMode: dynamodb.BillingMode.PAY_PER_REQUEST,
        removalPolicy: cdk.RemovalPolicy.DESTROY,
        pointInTimeRecoverySpecification: { pointInTimeRecoveryEnabled: true },
      },
    ));

    // Model Config Table — resolved model-selection defaults/overrides.
    // Exposed via the public readonly `modelConfigTable` field (see class
    // declaration) so TelemetryStack can read it for the CIT-026 replay
    // package's `modelConfig` section.
    const modelConfigTable = (this.modelConfigTable = new dynamodb.Table(
      this,
      "ModelConfigTable",
      {
        tableName: `citadel-model-config-${props.environment}`,
        partitionKey: { name: "scope", type: dynamodb.AttributeType.STRING },
        billingMode: dynamodb.BillingMode.PAY_PER_REQUEST,
        removalPolicy: cdk.RemovalPolicy.DESTROY,
        pointInTimeRecoverySpecification: { pointInTimeRecoveryEnabled: true },
      },
    ));

    // Integrations Table
    const integrationsTable = new dynamodb.Table(this, "IntegrationsTable", {
      tableName: `citadel-integrations-${props.environment}`,
      partitionKey: { name: "PK", type: dynamodb.AttributeType.STRING },
      sortKey: { name: "SK", type: dynamodb.AttributeType.STRING },
      billingMode: dynamodb.BillingMode.PAY_PER_REQUEST,
      removalPolicy: cdk.RemovalPolicy.DESTROY,
      pointInTimeRecoverySpecification: { pointInTimeRecoveryEnabled: true },
    });

    integrationsTable.addGlobalSecondaryIndex({
      indexName: "IntegrationIdIndex",
      partitionKey: {
        name: "integrationId",
        type: dynamodb.AttributeType.STRING,
      },
      projectionType: dynamodb.ProjectionType.ALL,
    });

    // Workflows Table
    this.workflowsTable = new dynamodb.Table(this, "WorkflowsTable", {
      tableName: `citadel-workflows-${props.environment}`,
      partitionKey: { name: "workflowId", type: dynamodb.AttributeType.STRING },
      billingMode: dynamodb.BillingMode.PAY_PER_REQUEST,
      removalPolicy: cdk.RemovalPolicy.DESTROY,
      pointInTimeRecoverySpecification: { pointInTimeRecoveryEnabled: true },
    });

    this.workflowsTable.addGlobalSecondaryIndex({
      indexName: "OrgStatusIndex",
      partitionKey: { name: "orgId", type: dynamodb.AttributeType.STRING },
      sortKey: { name: "status", type: dynamodb.AttributeType.STRING },
      projectionType: dynamodb.ProjectionType.ALL,
    });

    this.workflowsTable.addGlobalSecondaryIndex({
      indexName: "BlueprintIndex",
      partitionKey: {
        name: "isBlueprint",
        type: dynamodb.AttributeType.STRING,
      },
      sortKey: { name: "updatedAt", type: dynamodb.AttributeType.STRING },
      projectionType: dynamodb.ProjectionType.ALL,
    });

    // Apps Table
    this.appsTable = new dynamodb.Table(this, "AppsTable", {
      tableName: `citadel-apps-${props.environment}`,
      partitionKey: { name: "appId", type: dynamodb.AttributeType.STRING },
      billingMode: dynamodb.BillingMode.PAY_PER_REQUEST,
      removalPolicy: cdk.RemovalPolicy.DESTROY,
      pointInTimeRecoverySpecification: { pointInTimeRecoveryEnabled: true },
    });

    this.appsTable.addGlobalSecondaryIndex({
      indexName: "OrgIndex",
      partitionKey: { name: "orgId", type: dynamodb.AttributeType.STRING },
      sortKey: { name: "createdAt", type: dynamodb.AttributeType.STRING },
      projectionType: dynamodb.ProjectionType.ALL,
    });

    this.appsTable.addGlobalSecondaryIndex({
      indexName: "GroupIndex",
      partitionKey: { name: "groupId", type: dynamodb.AttributeType.STRING },
      sortKey: { name: "sortId", type: dynamodb.AttributeType.STRING },
      projectionType: dynamodb.ProjectionType.ALL,
    });

    // Executions Table
    this.executionsTable = new dynamodb.Table(this, "ExecutionsTable", {
      tableName: `citadel-executions-${props.environment}`,
      partitionKey: {
        name: "executionId",
        type: dynamodb.AttributeType.STRING,
      },
      billingMode: dynamodb.BillingMode.PAY_PER_REQUEST,
      // Deploy-safety (findings 7f42ae86 / 9c92a738): workflow execution
      // records are data-bearing state, not a disposable fixture. RETAIN +
      // deletionProtection so a divergent-branch deploy (which reconciles the
      // environment to the deployed tree) cannot silently DELETE this table
      // and take live execution history with it. Tradeoff: RETAIN converts a
      // silent data loss into an ORPHANED table, which then makes a later
      // deploy that re-adds ExecutionsTable fail LOUDLY with AlreadyExists —
      // recovery (import or rename) is documented in docs/DEPLOYMENT.md.
      removalPolicy: cdk.RemovalPolicy.RETAIN,
      deletionProtection: true,
      pointInTimeRecoverySpecification: { pointInTimeRecoveryEnabled: true },
    });

    this.executionsTable.addGlobalSecondaryIndex({
      indexName: "WorkflowIndex",
      partitionKey: { name: "workflowId", type: dynamodb.AttributeType.STRING },
      sortKey: { name: "startedAt", type: dynamodb.AttributeType.STRING },
      projectionType: dynamodb.ProjectionType.ALL,
    });

    // --- AgentCore Registry (Custom Resource — no CloudFormation type yet) ---
    const registryAutoApproval =
      this.node.tryGetContext("registryAutoApproval") ?? "true";

    const registryProvisionerFunction = new lambda.Function(
      this,
      "RegistryProvisionerFunction",
      {
        runtime: lambda.Runtime.NODEJS_24_X,
        handler: "registry-provisioner.handler",
        code: lambda.Code.fromAsset("dist/lambda"),
        timeout: cdk.Duration.minutes(5),
        logGroup: new logs.LogGroup(this, "RegistryProvisionerFunctionLogs", {
          retention: logs.RetentionDays.ONE_WEEK,
          removalPolicy: cdk.RemovalPolicy.DESTROY,
        }),
      },
    );

    registryProvisionerFunction.addToRolePolicy(
      new iam.PolicyStatement({
        effect: iam.Effect.ALLOW,
        actions: [
          "bedrock-agentcore:CreateRegistry",
          "bedrock-agentcore:DeleteRegistry",
          "bedrock-agentcore:GetRegistry",
          "bedrock-agentcore:ListRegistries",
          "bedrock-agentcore:CreateWorkloadIdentity",
          "bedrock-agentcore:DeleteWorkloadIdentity",
          "bedrock-agentcore:GetWorkloadIdentity",
        ],
        resources: ["*"],
      }),
    );
    registryProvisionerFunction.addToRolePolicy(
      new iam.PolicyStatement({
        effect: iam.Effect.ALLOW,
        actions: ["iam:CreateServiceLinkedRole"],
        resources: [
          "arn:aws:iam::*:role/aws-service-role/bedrock-agentcore.amazonaws.com/*",
        ],
        conditions: {
          StringEquals: {
            "iam:AWSServiceName": "bedrock-agentcore.amazonaws.com",
          },
        },
      }),
    );

    const agentCoreRegistry = new cdk.CustomResource(
      this,
      "AgentCoreRegistry",
      {
        serviceToken: registryProvisionerFunction.functionArn,
        properties: {
          RegistryName: `citadel-registry-${props.environment}`,
          AutoApproval: String(registryAutoApproval),
          Description: `Citadel agent and tool registry for ${props.environment}`,
          ForceRecreate: "2026-05-03b",
        },
      },
    );

    const registryArn = agentCoreRegistry.getAttString("RegistryArn");
    const registryId = agentCoreRegistry.getAttString("RegistryId");
    this.registryArn = registryArn;
    this.registryId = registryId;

    new cdk.CfnOutput(this, "AgentCoreRegistryArn", {
      value: registryArn,
      description: "AgentCore Registry ARN",
      exportName: `${this.stackName}-RegistryArn`,
    });

    new cdk.CfnOutput(this, "AgentCoreRegistryId", {
      value: registryId,
      description: "AgentCore Registry ID",
      exportName: `${this.stackName}-RegistryId`,
    });

    // NOTE: registrySyncRule, registrySyncDlq, and registrySyncLambda moved
    // to CitadelRegistryStack (backend-stack-split phase 2, decision
    // 30e6d067).

    // --- Scheduled AppsTable #META reconciler -------------------------------
    // Runs the existing reconcile-apps-meta logic in --apply mode every 6
    // hours via EventBridge. Mirrors any Registry agent records that don't
    // have an AppsTable #META row (e.g. Fabricator-created agents that
    // bypassed the synchronous resolver write, or drift caused by transient
    // DDB write failures). Stale/orphan rows are logged but not
    // auto-repaired — admins decide. Manual operators can still use the CLI
    // script (`npx ts-node backend/scripts/reconcile-apps-meta.ts --dry-run`)
    // for inspection runs.
    const reconcileAppsMetaScheduledFunction = new lambda.Function(
      this,
      "ReconcileAppsMetaScheduledFunction",
      {
        runtime: lambda.Runtime.NODEJS_24_X,
        handler: "reconcile-apps-meta-scheduled-handler.handler",
        code: lambda.Code.fromAsset("dist/lambda"),
        environment: {
          REGISTRY_ID: registryId,
          APPS_TABLE: this.appsTable.tableName,
        },
        timeout: cdk.Duration.minutes(5),
        logGroup: new logs.LogGroup(
          this,
          "ReconcileAppsMetaScheduledFunctionLogs",
          {
            retention: logs.RetentionDays.ONE_WEEK,
            removalPolicy: cdk.RemovalPolicy.DESTROY,
          },
        ),
      },
    );

    // Registry read access — mirrors the pattern used by RegistrySyncLambda.
    // Only Get/List are needed; the reconciler never mutates the registry.
    reconcileAppsMetaScheduledFunction.addToRolePolicy(
      new iam.PolicyStatement({
        effect: iam.Effect.ALLOW,
        actions: [
          "bedrock-agentcore:GetRegistryRecord",
          "bedrock-agentcore:ListRegistryRecords",
        ],
        resources: [registryArn, `${registryArn}/*`],
      }),
    );

    // AppsTable read/write — required so the reconciler can scan #META rows
    // and upsert any missing ones via the existing apps-table-meta helper.
    this.appsTable.grantReadWriteData(reconcileAppsMetaScheduledFunction);

    // 6-hour EventBridge schedule. Pattern mirrors HealthCheckScheduleRule
    // in services-stack.ts (events.Schedule.rate + targets.LambdaFunction
    // with retryAttempts:1, maxEventAge:30m).
    const reconcileAppsMetaSchedule = new events.Rule(
      this,
      "ReconcileAppsMetaSchedule",
      {
        description:
          "Reconciles AppsTable #META rows against Registry every 6 hours",
        schedule: events.Schedule.rate(cdk.Duration.hours(6)),
      },
    );

    reconcileAppsMetaSchedule.addTarget(
      new targets.LambdaFunction(reconcileAppsMetaScheduledFunction, {
        retryAttempts: 1,
        maxEventAge: cdk.Duration.minutes(30),
      }),
    );

    // --- Scheduled Bedrock model-catalog sync -------------------------------
    // Daily discovery/refresh of the ModelCatalogTable against the live
    // Bedrock inventory. Discovers new foundation models, refreshes
    // API-derived metadata on known ones (preserving operator status), and
    // marks entries Bedrock no longer returns as deprecated. Mirrors the
    // reconcile-apps-meta scheduled-function wiring above.
    const modelCatalogSyncFunction = new lambda.Function(
      this,
      "ModelCatalogSyncFunction",
      {
        runtime: lambda.Runtime.NODEJS_24_X,
        handler: "model-catalog-sync.handler",
        code: lambda.Code.fromAsset("dist/lambda"),
        environment: {
          MODEL_CATALOG_TABLE: modelCatalogTable.tableName,
          EVENT_BUS_NAME: this.agentEventBus.eventBusName,
          ENVIRONMENT: props.environment,
        },
        timeout: cdk.Duration.minutes(5),
        logGroup: new logs.LogGroup(this, "ModelCatalogSyncFunctionLogs", {
          retention: logs.RetentionDays.ONE_WEEK,
          removalPolicy: cdk.RemovalPolicy.DESTROY,
        }),
      },
    );

    // Read-only Bedrock discovery permissions — the sync never mutates Bedrock.
    modelCatalogSyncFunction.addToRolePolicy(
      new iam.PolicyStatement({
        effect: iam.Effect.ALLOW,
        actions: [
          "bedrock:ListFoundationModels",
          "bedrock:ListInferenceProfiles",
          "bedrock:GetFoundationModel",
          "bedrock:GetInferenceProfile",
        ],
        resources: ["*"],
      }),
    );

    // cdk-nag: the Bedrock discovery actions above are account/region-level
    // enumeration APIs. bedrock:ListFoundationModels and
    // bedrock:ListInferenceProfiles have no resource-level scoping (they
    // return the whole catalog and must be granted on '*'), and because this
    // sync is data-driven — it never hardcodes model ids and discovers the
    // model set dynamically each run — the Get* targets are not knowable
    // ahead of time to enumerate as ARNs. All four actions are read-only and
    // the function never mutates Bedrock. Scope is bounded to Bedrock's
    // read-only discovery surface.
    NagSuppressions.addResourceSuppressions(
      modelCatalogSyncFunction.role!,
      [
        {
          id: "AwsSolutions-IAM5",
          reason:
            "Bedrock discovery actions (ListFoundationModels/ListInferenceProfiles/" +
            "GetFoundationModel/GetInferenceProfile) are read-only and have no " +
            "resource-level scoping; the model set is discovered dynamically each " +
            "run, so target ARNs are not known ahead of time.",
          appliesTo: ["Resource::*"],
        },
      ],
      true,
    );

    // Catalog read/write to upsert discovered rows; event bus to emit summaries.
    modelCatalogTable.grantReadWriteData(modelCatalogSyncFunction);
    this.agentEventBus.grantPutEventsTo(modelCatalogSyncFunction);

    // Daily EventBridge schedule.
    const modelCatalogSyncRule = new events.Rule(this, "ModelCatalogSyncRule", {
      description: "Daily sync of the Bedrock model catalog",
      schedule: events.Schedule.rate(cdk.Duration.hours(24)),
    });

    modelCatalogSyncRule.addTarget(
      new targets.LambdaFunction(modelCatalogSyncFunction, {
        retryAttempts: 1,
        maxEventAge: cdk.Duration.minutes(30),
      }),
    );

    // On-demand sync: an event-pattern rule on the CUSTOM agent bus routes a
    // model.catalog.sync_requested event (emitted by the syncModelCatalog
    // mutation) to the SAME discovery Lambda. EventBridge invokes the target
    // via the rule's managed permission — no lambda:InvokeFunction IAM grant.
    const modelCatalogSyncRequestRule = new events.Rule(
      this,
      "ModelCatalogSyncRequestRule",
      {
        eventBus: this.agentEventBus,
        description: "On-demand model catalog sync (operator-triggered)",
        eventPattern: {
          source: ["citadel.backend"],
          detailType: ["model.catalog.sync_requested"],
        },
      },
    );

    modelCatalogSyncRequestRule.addTarget(
      new targets.LambdaFunction(modelCatalogSyncFunction, {
        retryAttempts: 1,
        maxEventAge: cdk.Duration.minutes(30),
      }),
    );

    // Pre-token-generation trigger: promotes `custom:organization` and
    // `custom:role` attributes onto JWT claims so downstream resolvers can
    // read org/role identity without an AdminGetUserCommand per request.
    // Phase 1 org-scoping foundation.
    const preTokenGenerationLambda = new lambda.Function(
      this,
      "PreTokenGenerationFunction",
      {
        runtime: lambda.Runtime.NODEJS_24_X,
        handler: "pre-token-generation.handler",
        code: lambda.Code.fromAsset("dist/lambda"),
        functionName: `citadel-pre-token-gen-${props.environment}`,
        timeout: cdk.Duration.seconds(5),
        logGroup: new logs.LogGroup(this, "PreTokenGenerationFunctionLogs", {
          retention: logs.RetentionDays.ONE_WEEK,
          removalPolicy: cdk.RemovalPolicy.DESTROY,
        }),
      },
    );

    // Cognito User Pool
    this.userPool = new cognito.UserPool(this, "UserPool", {
      userPoolName: `citadel-users-${props.environment}`,
      selfSignUpEnabled: false,
      signInAliases: {
        email: true,
        username: false,
      },
      autoVerify: {
        email: true,
      },
      standardAttributes: {
        email: {
          required: true,
          mutable: true,
        },
        givenName: {
          required: true,
          mutable: true,
        },
        familyName: {
          required: true,
          mutable: true,
        },
      },
      customAttributes: {
        role: new cognito.StringAttribute({ mutable: true }),
        organization: new cognito.StringAttribute({ mutable: true }),
      },
      passwordPolicy: {
        minLength: 8,
        requireLowercase: true,
        requireUppercase: true,
        requireDigits: true,
        requireSymbols: true,
      },
      mfa: cognito.Mfa.OPTIONAL,
      mfaSecondFactor: {
        sms: true,
        otp: true,
      },
      lambdaTriggers: {
        preTokenGeneration: preTokenGenerationLambda,
      },
      accountRecovery: cognito.AccountRecovery.EMAIL_ONLY,
      featurePlan: cognito.FeaturePlan.ESSENTIALS,
      removalPolicy: cdk.RemovalPolicy.DESTROY,
    });

    // cdk-nag: deliberately suppress AwsSolutions-COG2 on the user-facing
    // UserPool. MFA is set to OPTIONAL by default so operators can enforce
    // mandatory MFA per customer deployment requirements rather than at the
    // platform default. This is documented as a customer-deployment decision,
    // not a security oversight.
    NagSuppressions.addResourceSuppressions(this.userPool, [
      {
        id: "AwsSolutions-COG2",
        reason:
          "MFA is set to OPTIONAL by default, allowing operators to enforce per-customer " +
          "requirements. Strongly recommended for production: customers should set MFA to " +
          "REQUIRED via the Cognito console or via a customer-specific deployment override. " +
          "Default left as OPTIONAL because mandatory MFA is a customer-deployment decision " +
          "that depends on auth flow (SMS reachability, TOTP support, MFA-onboarding UX) " +
          "and varies across regulated vs unregulated customer segments.",
      },
    ]);

    // User Pool Groups for RBAC
    const adminGroup = new cognito.CfnUserPoolGroup(this, "AdminGroup", {
      userPoolId: this.userPool.userPoolId,
      groupName: "admin",
      description: "Full system access",
    });

    const _projectManagerGroup = new cognito.CfnUserPoolGroup(
      this,
      "ProjectManagerGroup",
      {
        userPoolId: this.userPool.userPoolId,
        groupName: "project_manager",
        description: "Project management access",
      },
    );

    const _architectGroup = new cognito.CfnUserPoolGroup(
      this,
      "ArchitectGroup",
      {
        userPoolId: this.userPool.userPoolId,
        groupName: "architect",
        description: "Architecture and design access",
      },
    );

    const _developerGroup = new cognito.CfnUserPoolGroup(
      this,
      "DeveloperGroup",
      {
        userPoolId: this.userPool.userPoolId,
        groupName: "developer",
        description: "Development access",
      },
    );

    // User Pool Client
    this.userPoolClient = new cognito.UserPoolClient(this, "UserPoolClient", {
      userPool: this.userPool,
      userPoolClientName: `citadel-client-${props.environment}`,
      generateSecret: false,
      authFlows: {
        userSrp: true,
        userPassword: true,
        adminUserPassword: true,
      },
      oAuth: {
        flows: {
          authorizationCodeGrant: true,
          implicitCodeGrant: true,
        },
        scopes: [
          cognito.OAuthScope.EMAIL,
          cognito.OAuthScope.OPENID,
          cognito.OAuthScope.PROFILE,
        ],
      },
      refreshTokenValidity: cdk.Duration.days(30),
      accessTokenValidity: cdk.Duration.hours(1),
      idTokenValidity: cdk.Duration.hours(1),
    });

    // Lambda functions for resolvers
    //
    // NOTE: projectResolverFunction, conversationResolverFunction,
    // agentResolverFunction, documentUploadResolverFunction, and
    // documentResolverFunction moved to CitadelProjectsStack in the
    // backend-stack-split phase 1 (see backend/lib/projects-stack.ts).
    // agentStatusTable stays here (shared with the unmoved
    // agentMessageHandlerFunction) and is passed to ProjectsStack as a prop.
    const agentConfigResolverFunction = new lambda.Function(
      this,
      "AgentConfigResolverFunction",
      {
        runtime: lambda.Runtime.NODEJS_24_X,
        handler: "agent-config-resolver.handler",
        code: lambda.Code.fromAsset("dist/lambda"),
        environment: {
          AGENT_CONFIG_TABLE: this.agentConfigTable.tableName,
          REGISTRY_ENABLED: "true",
          REGISTRY_ID: registryId,
          // Governance activation gate (US-IMP): ENVIRONMENT selects the
          // governance rollout SSM parameter path (getGovernanceEnforce);
          // EVENT_BUS_NAME targets the shared bus for best-effort gate
          // telemetry. Both mirror the agent-import resolver. Scoped IAM
          // grants below; getGovernanceEnforce defaults to 'shadow'.
          ENVIRONMENT: props.environment,
          EVENT_BUS_NAME: this.agentEventBus.eventBusName,
          // Phase-2 cross-account trust-path: the deploying account id powers
          // isCrossAccountRoleArn so the resolver can tell when an imported
          // agent's invocation.roleArn lives in a DIFFERENT account and route to
          // the operator analysis-role assume path (sts:AssumeRole grant below).
          ACCOUNT_ID: this.account,
        },
        timeout: cdk.Duration.seconds(30),
        logGroup: new logs.LogGroup(this, "AgentConfigResolverFunctionLogs", {
          retention: logs.RetentionDays.ONE_WEEK,
          removalPolicy: cdk.RemovalPolicy.DESTROY,
        }),
      },
    );

    // Model Config Resolver — operator-facing GraphQL surface over the model
    // catalog + resolved model-selection config tables. DATA-DRIVEN: it reads
    // the catalog/config table names from its environment and never hardcodes
    // model ids. Mirrors AgentConfigResolverFunction (runtime/bundling/env).
    const modelConfigResolverFunction = new lambda.Function(
      this,
      "ModelConfigResolverFunction",
      {
        runtime: lambda.Runtime.NODEJS_24_X,
        handler: "model-config-resolver.handler",
        code: lambda.Code.fromAsset("dist/lambda"),
        environment: {
          MODEL_CONFIG_TABLE: modelConfigTable.tableName,
          MODEL_CATALOG_TABLE: modelCatalogTable.tableName,
          EVENT_BUS_NAME: this.agentEventBus.eventBusName,
          ENVIRONMENT: props.environment,
        },
        timeout: cdk.Duration.seconds(30),
        logGroup: new logs.LogGroup(this, "ModelConfigResolverFunctionLogs", {
          retention: logs.RetentionDays.ONE_WEEK,
          removalPolicy: cdk.RemovalPolicy.DESTROY,
        }),
      },
    );

    // Scoped grants: read/write both model tables + emit MODEL_CONFIG_CHANGED.
    modelCatalogTable.grantReadWriteData(modelConfigResolverFunction);
    modelConfigTable.grantReadWriteData(modelConfigResolverFunction);
    this.agentEventBus.grantPutEventsTo(modelConfigResolverFunction);

    // Agent Import Resolver - registers externally-owned agents (importAgent
    // NOTE: agentImportResolverFunction (+ AgentImport data source/resolvers,
    // all its IAM grants incl. Secrets Manager/STS/gateway-target/ADR write,
    // and the FABRICATOR_QUEUE_URL sqs:SendMessage grant),
    // agentImportManifestResultHandler (+ its rule), agentCodeResolverFunction
    // (+ AgentCode data source/resolvers), fabricatorRequestResolverFunction,
    // and fabricatorQueueResolverFunction moved to CitadelRegistryStack
    // (backend-stack-split phase 2, decision 30e6d067).

    const toolConfigResolverFunction = new lambda.Function(
      this,
      "ToolConfigResolverFunction",
      {
        runtime: lambda.Runtime.NODEJS_24_X,
        handler: "tool-config-resolver.handler",
        code: lambda.Code.fromAsset("dist/lambda"),
        environment: {
          TOOLS_CONFIG_TABLE: `citadel-tools-${props.environment}`,
          REGISTRY_ENABLED: "true",
          REGISTRY_ID: registryId,
        },
        timeout: cdk.Duration.seconds(30),
        logGroup: new logs.LogGroup(this, "ToolConfigResolverFunctionLogs", {
          retention: logs.RetentionDays.ONE_WEEK,
          removalPolicy: cdk.RemovalPolicy.DESTROY,
        }),
      },
    );

    // Grant permissions to Lambda functions
    // NOTE: grants for projectResolverFunction, conversationResolverFunction,
    // agentResolverFunction, and documentUploadResolverFunction moved to
    // CitadelProjectsStack (backend-stack-split phase 1).

    // ── Durable fabrication-jobs status table ────────────────────────────────
    // Source of truth for per-agent fabrication status, replacing the old
    // SQS-peek queue read. Owned HERE in BackendStack because it is the
    // dependency root (services→backend, arbiter→services→backend): owning it
    // here lets the fabricator resolvers (now in CitadelRegistryStack) use
    // scoped grants via deterministic ARN, ensures the table is provisioned
    // before any cross-stack writer (the services intake runtime and the
    // arbiter fabricator Lambda) deploys, and makes a circular stack
    // dependency impossible because those stacks reference the table only by
    // deterministic name + constructed ARN.
    // PK orchestrationId (intake session id, or '0' for direct UI requests) /
    // SK agentUseId (agent name / requestId). On-demand + PITR per conventions;
    // a `ttl` attribute (epoch seconds, ~7 days) keeps the table self-pruning.
    new dynamodb.Table(this, "FabricationJobsTable", {
      tableName: `citadel-fabrication-jobs-${props.environment}`,
      partitionKey: {
        name: "orchestrationId",
        type: dynamodb.AttributeType.STRING,
      },
      sortKey: { name: "agentUseId", type: dynamodb.AttributeType.STRING },
      billingMode: dynamodb.BillingMode.PAY_PER_REQUEST,
      pointInTimeRecoverySpecification: { pointInTimeRecoveryEnabled: true },
      timeToLiveAttribute: "ttl",
      removalPolicy: cdk.RemovalPolicy.DESTROY,
    });

    // NOTE: fabricatorRequestResolverFunction/fabricatorQueueResolverFunction
    // grants against FabricationJobsTable (by deterministic ARN) now live in
    // CitadelRegistryStack, following the exact same no-cross-ref pattern.

    // NOTE: documentResolverFunction's S3 session-bucket + pdf-generator
    // invoke grants moved to CitadelProjectsStack along with the function.

    // Grant permissions for agent config
    this.agentConfigTable.grantReadWriteData(agentConfigResolverFunction);

    // Grant agent-config-resolver permission to call Registry APIs
    agentConfigResolverFunction.addToRolePolicy(
      new iam.PolicyStatement({
        effect: iam.Effect.ALLOW,
        actions: [
          "bedrock-agentcore:CreateRegistryRecord",
          "bedrock-agentcore:UpdateRegistryRecord",
          "bedrock-agentcore:UpdateRegistryRecordStatus",
          "bedrock-agentcore:SubmitRegistryRecordForApproval",
          "bedrock-agentcore:DeleteRegistryRecord",
          "bedrock-agentcore:GetRegistryRecord",
          "bedrock-agentcore:ListRegistryRecords",
        ],
        resources: [registryArn, `${registryArn}/*`],
      }),
    );

    // Governance activation gate (US-IMP): the agent-config-resolver now reads
    // the governance rollout flag and emits best-effort "would-block" telemetry
    // on the imported-agent activation path. Mirror the import/event-emitting
    // consumers with the minimal scoped grants:
    //   • events:PutEvents on the shared agent event bus (gate telemetry event)
    //   • ssm:GetParameter on the two governance rollout parameters only
    // getGovernanceEnforce defaults to 'shadow' internally, so a missing
    // parameter or denied read can never hard-fail an activation.
    this.agentEventBus.grantPutEventsTo(agentConfigResolverFunction);
    agentConfigResolverFunction.addToRolePolicy(
      new iam.PolicyStatement({
        effect: iam.Effect.ALLOW,
        actions: ["ssm:GetParameter"],
        resources: [
          `arn:aws:ssm:${this.region}:${this.account}:parameter/citadel/governance/enforce/${props.environment}`,
          `arn:aws:ssm:${this.region}:${this.account}:parameter/citadel/governance/effective_at/${props.environment}`,
        ],
      }),
    );

    // US-IMP lazy IAM trust-path: on the APPROVED activation of an imported
    // agent the resolver calls computeTrustPath (../utils/trust-path), which
    // performs READ-ONLY IAM introspection of the agent's invocation.roleArn.
    // computeTrustPath issues iam:GetRole + iam:GetRolePolicy today; the
    // List*/GetPolicy* actions are granted additively for the richer
    // attached/managed-policy walk. An imported agent's invocation.roleArn is
    // operator-supplied and NOT citadel-prefixed (and may be cross-account), so
    // role/policy reads are scoped to THIS account's IAM namespace rather than a
    // citadel-* prefix; cross-account / unresolvable roles simply fail GetRole
    // and are handled best-effort (attestation left 'pending'). No write or
    // assume is granted. The role/* + policy/* wildcards are suppressed
    // (AwsSolutions-IAM5) in bin/app.ts with this rationale.
    agentConfigResolverFunction.addToRolePolicy(
      new iam.PolicyStatement({
        effect: iam.Effect.ALLOW,
        actions: [
          "iam:GetRole",
          "iam:GetRolePolicy",
          "iam:ListRolePolicies",
          "iam:ListAttachedRolePolicies",
        ],
        resources: [`arn:aws:iam::${this.account}:role/*`],
      }),
    );
    agentConfigResolverFunction.addToRolePolicy(
      new iam.PolicyStatement({
        effect: iam.Effect.ALLOW,
        actions: ["iam:GetPolicy", "iam:GetPolicyVersion"],
        resources: [`arn:aws:iam::${this.account}:policy/*`],
      }),
    );

    // Phase-2 cross-account trust-path: when an imported agent's
    // invocation.roleArn is in a DIFFERENT account and the operator supplied a
    // READ-ONLY invocation.analysisRoleArn in that target account, the resolver
    // assumes that analysis role to run read-only iam:GetRole/GetRolePolicy in
    // the role's home account (assumeAnalysisRoleClient → computeTrustPath). The
    // analysis role is operator-supplied and may live in ANY account, so the
    // assume cannot be account-scoped; it is scoped to the cross-account IAM
    // role namespace (arn:aws:iam::*:role/*). The runtime confused-deputy
    // control is the externalId threaded into every AssumeRole call (the target
    // role must trust Citadel under sts:ExternalId). No write/assume beyond
    // this; failures are handled best-effort (attestation left 'pending'). The
    // role/* wildcard is suppressed (AwsSolutions-IAM5) in bin/app.ts.
    agentConfigResolverFunction.addToRolePolicy(
      new iam.PolicyStatement({
        effect: iam.Effect.ALLOW,
        actions: ["sts:AssumeRole"],
        resources: ["arn:aws:iam::*:role/*"],
      }),
    );

    // NOTE: agentImportResolverFunction's registry-CRUD/discovery/ELB grants,
    // agentCodeResolverFunction's S3/DynamoDB grants, and
    // fabricatorRequestResolverFunction/fabricatorQueueResolverFunction's SQS
    // grants moved to CitadelRegistryStack (backend-stack-split phase 2).

    // Grant permissions for tool config
    toolConfigResolverFunction.addToRolePolicy(
      new iam.PolicyStatement({
        effect: iam.Effect.ALLOW,
        actions: [
          "dynamodb:GetItem",
          "dynamodb:PutItem",
          "dynamodb:DeleteItem",
          "dynamodb:Scan",
        ],
        resources: [
          `arn:aws:dynamodb:${this.region}:${this.account}:table/citadel-tools-${props.environment}`,
        ],
      }),
    );

    // Grant tool-config-resolver permission to call Registry APIs
    toolConfigResolverFunction.addToRolePolicy(
      new iam.PolicyStatement({
        effect: iam.Effect.ALLOW,
        actions: [
          "bedrock-agentcore:CreateRegistryRecord",
          "bedrock-agentcore:UpdateRegistryRecord",
          "bedrock-agentcore:UpdateRegistryRecordStatus",
          "bedrock-agentcore:SubmitRegistryRecordForApproval",
          "bedrock-agentcore:DeleteRegistryRecord",
          "bedrock-agentcore:GetRegistryRecord",
          "bedrock-agentcore:ListRegistryRecords",
        ],
        resources: [registryArn, `${registryArn}/*`],
      }),
    );

    // Task Runner Resolver
    const taskRunnerResolverFunction = new lambda.Function(
      this,
      "TaskRunnerResolverFunction",
      {
        runtime: lambda.Runtime.NODEJS_24_X,
        handler: "task-runner-resolver.handler",
        code: lambda.Code.fromAsset("dist/lambda"),
        environment: {
          AGENT_EVENT_BUS_NAME: this.agentEventBus.eventBusName,
        },
        timeout: cdk.Duration.seconds(30),
        logGroup: new logs.LogGroup(this, "TaskRunnerResolverFunctionLogs", {
          retention: logs.RetentionDays.ONE_WEEK,
          removalPolicy: cdk.RemovalPolicy.DESTROY,
        }),
      },
    );

    // User Management Resolver
    const userManagementResolverFunction = new lambda.Function(
      this,
      "UserManagementResolverFunction",
      {
        runtime: lambda.Runtime.NODEJS_24_X,
        handler: "user-management-resolver.handler",
        code: lambda.Code.fromAsset("dist/lambda"),
        environment: {
          USER_POOL_ID: this.userPool.userPoolId,
          ORGANISATION_TABLE: organisationTable.tableName,
        },
        timeout: cdk.Duration.seconds(30),
        logGroup: new logs.LogGroup(
          this,
          "UserManagementResolverFunctionLogs",
          {
            retention: logs.RetentionDays.ONE_WEEK,
            removalPolicy: cdk.RemovalPolicy.DESTROY,
          },
        ),
      },
    );

    // Gateway ID resolved at runtime from SSM (created by ServicesStack)
    const gatewayIdParamName = `/citadel/gateway-id-${props.environment}`;

    // OAuth return URL parameter — redirect target after the AgentCore-hosted
    // OAuth callback completes. Created here (rather than ServicesStack) because
    // the integration-resolver and gateway-registration-handler Lambdas in this
    // stack are the sole consumers; v1 hardcodes a placeholder per environment
    // and operators may overwrite the value out-of-band without redeploying
    // (Lambda env var is resolved at deploy time via {{resolve:ssm:...}}).
    const oauthReturnUrlParamName = `/citadel/${props.environment}/oauth-return-url`;
    const oauthReturnUrlParam = new ssm.StringParameter(
      this,
      "OAuthReturnUrlParam",
      {
        parameterName: oauthReturnUrlParamName,
        stringValue: "https://app.citadel.example.com/integrations/connected",
        description:
          "Default redirect target presented to end-users after the AgentCore-hosted " +
          "OAuth2 callback completes for an integration. Consumed by integration-resolver " +
          "and gateway-registration-handler Lambdas via the OAUTH_DEFAULT_RETURN_URL env var.",
        tier: ssm.ParameterTier.STANDARD,
        dataType: ssm.ParameterDataType.TEXT,
      },
    );
    // Use the CREATED parameter's stringValue token (resolves to CFN Ref) to
    // establish a deploy-time dependency: CFN updates the parameter resource
    // before the Lambda env var is rendered. Do NOT use
    // StringParameter.valueForStringParameter here — that emits a
    // {{resolve:ssm:...}} dynamic reference which CFN evaluates at change-set
    // creation, before the parameter exists in this stack (chicken-and-egg).
    const oauthReturnUrlValue = oauthReturnUrlParam.stringValue;

    // Integration Resolver
    const integrationResolverFunction = new lambda.Function(
      this,
      "IntegrationResolverFunction",
      {
        runtime: lambda.Runtime.NODEJS_24_X,
        handler: "integration-resolver.handler",
        code: lambda.Code.fromAsset("dist/lambda"),
        environment: {
          INTEGRATIONS_TABLE: integrationsTable.tableName,
          ENVIRONMENT: props.environment,
          ACCOUNT_ID: this.account,
          GATEWAY_ID_PARAM: gatewayIdParamName,
          EVENT_BUS_NAME: this.agentEventBus.eventBusName,
          // OAuth callback redirect target. Populated from SSM
          // (oauthReturnUrlParamName) at deploy time. Also expose the param
          // name itself so the resolver's util layer can re-fetch live without
          // a redeploy if a future runtime SSM read is wired in P3.A.
          OAUTH_DEFAULT_RETURN_URL: oauthReturnUrlValue,
          OAUTH_RETURN_URL_SSM_PARAM: oauthReturnUrlParamName,
        },
        timeout: cdk.Duration.seconds(30),
        logGroup: new logs.LogGroup(this, "IntegrationResolverFunctionLogs", {
          retention: logs.RetentionDays.ONE_WEEK,
          removalPolicy: cdk.RemovalPolicy.DESTROY,
        }),
      },
    );

    // Gateway Registration Handler
    const gatewayRegistrationHandler = new lambda.Function(
      this,
      "GatewayRegistrationHandler",
      {
        runtime: lambda.Runtime.NODEJS_24_X,
        handler: "gateway-registration-handler.handler",
        code: lambda.Code.fromAsset("dist/lambda"),
        environment: {
          ENVIRONMENT: props.environment,
          ACCOUNT_ID: this.account,
          INTEGRATIONS_TABLE: integrationsTable.tableName,
          GATEWAY_ID_PARAM: gatewayIdParamName,
          IDEMPOTENCY_TABLE: this.idempotencyTable.tableName,
          // Same OAuth redirect URL — gateway-registration-handler also
          // forwards `defaultReturnUrl` to the OAUTH2 gateway target payload
          // (see backend/src/lambda/gateway-registration-handler.ts).
          OAUTH_DEFAULT_RETURN_URL: oauthReturnUrlValue,
          OAUTH_RETURN_URL_SSM_PARAM: oauthReturnUrlParamName,
        },
        timeout: cdk.Duration.seconds(30),
        logGroup: new logs.LogGroup(this, "GatewayRegistrationHandlerLogs", {
          retention: logs.RetentionDays.ONE_WEEK,
          removalPolicy: cdk.RemovalPolicy.DESTROY,
        }),
      },
    );

    this.idempotencyTable.grantReadWriteData(gatewayRegistrationHandler);

    // Grant permissions to integration resolver
    integrationsTable.grantReadWriteData(integrationResolverFunction);
    integrationResolverFunction.addToRolePolicy(
      new iam.PolicyStatement({
        effect: iam.Effect.ALLOW,
        actions: [
          "secretsmanager:CreateSecret",
          "secretsmanager:UpdateSecret",
          "secretsmanager:DeleteSecret",
          "secretsmanager:GetSecretValue",
          "secretsmanager:TagResource",
        ],
        resources: [
          `arn:aws:secretsmanager:${this.region}:${this.account}:secret:/citadel/integrations/*`,
        ],
      }),
    );
    integrationResolverFunction.addToRolePolicy(
      new iam.PolicyStatement({
        effect: iam.Effect.ALLOW,
        actions: [
          "ssm:PutParameter",
          "ssm:GetParameter",
          "ssm:DeleteParameter",
          "ssm:AddTagsToResource",
        ],
        resources: [
          `arn:aws:ssm:${this.region}:${this.account}:parameter/citadel/integrations/*`,
          `arn:aws:ssm:${this.region}:${this.account}:parameter/citadel/gateway/*`,
        ],
      }),
    );
    this.agentEventBus.grantPutEventsTo(integrationResolverFunction);

    // Grant AgentCore Gateway permissions to integration resolver
    integrationResolverFunction.addToRolePolicy(
      new iam.PolicyStatement({
        effect: iam.Effect.ALLOW,
        actions: [
          "bedrock-agentcore:CreateGatewayTarget",
          "bedrock-agentcore:DeleteGatewayTarget",
          "bedrock-agentcore:GetGatewayTarget",
          "bedrock-agentcore:UpdateGatewayTarget",
          "bedrock-agentcore:CreateCredentialProvider",
          "bedrock-agentcore:DeleteCredentialProvider",
        ],
        resources: [
          `arn:aws:bedrock-agentcore:${this.region}:${this.account}:gateway/*`,
          `arn:aws:bedrock-agentcore:${this.region}:${this.account}:token-vault/default/apikeycredentialprovider/*`,
        ],
      }),
    );

    // Grant AgentCore Identity credential-provider permissions for OAuth2 +
    // ApiKey provisioning performed by `provisionCredentialProvider`. ARN
    // suffix `credential-provider/integration-*` matches the
    // `integration-<integrationId>` naming used by CredentialProviderManager.
    integrationResolverFunction.addToRolePolicy(
      new iam.PolicyStatement({
        effect: iam.Effect.ALLOW,
        actions: [
          "bedrock-agentcore:CreateOauth2CredentialProvider",
          "bedrock-agentcore:UpdateOauth2CredentialProvider",
          "bedrock-agentcore:GetOauth2CredentialProvider",
          "bedrock-agentcore:DeleteOauth2CredentialProvider",
          "bedrock-agentcore:CreateApiKeyCredentialProvider",
          "bedrock-agentcore:UpdateApiKeyCredentialProvider",
          "bedrock-agentcore:GetApiKeyCredentialProvider",
          "bedrock-agentcore:DeleteApiKeyCredentialProvider",
          "bedrock-agentcore:ListOauth2CredentialProviders",
          "bedrock-agentcore:ListApiKeyCredentialProviders",
        ],
        resources: [
          `arn:aws:bedrock-agentcore:${this.region}:${this.account}:credential-provider/integration-*`,
        ],
      }),
    );

    // Read access to the OAuth return-URL SSM parameter. CDK has already
    // resolved the value into the Lambda env via {{resolve:ssm:...}}; this
    // grant lets the resolver's util layer (or a future P3.A runtime read)
    // re-fetch the live value via the AWS SDK without a redeploy.
    oauthReturnUrlParam.grantRead(integrationResolverFunction);

    // Grant IAM permissions for PolicyManager (integration scope)
    integrationResolverFunction.addToRolePolicy(
      new iam.PolicyStatement({
        effect: iam.Effect.ALLOW,
        actions: [
          "iam:CreateRole",
          "iam:DeleteRole",
          "iam:GetRole",
          "iam:PutRolePolicy",
          "iam:DeleteRolePolicy",
          "iam:TagRole",
        ],
        resources: [`arn:aws:iam::${this.account}:role/citadel-int-*`],
      }),
    );

    // Grant STS permissions for PolicyManager (integration scope)
    integrationResolverFunction.addToRolePolicy(
      new iam.PolicyStatement({
        effect: iam.Effect.ALLOW,
        actions: ["sts:AssumeRole"],
        resources: [`arn:aws:iam::${this.account}:role/citadel-int-*`],
      }),
    );
    integrationResolverFunction.addToRolePolicy(
      new iam.PolicyStatement({
        effect: iam.Effect.ALLOW,
        actions: ["sts:GetCallerIdentity"],
        resources: ["*"],
      }),
    );

    // Gateway registration handler permissions
    integrationsTable.grantReadWriteData(gatewayRegistrationHandler);
    gatewayRegistrationHandler.addToRolePolicy(
      new iam.PolicyStatement({
        effect: iam.Effect.ALLOW,
        actions: [
          "ssm:GetParameter",
          "ssm:PutParameter",
          "ssm:DeleteParameter",
          "ssm:AddTagsToResource",
        ],
        resources: [
          `arn:aws:ssm:${this.region}:${this.account}:parameter/citadel/gateway/*`,
          `arn:aws:ssm:${this.region}:${this.account}:parameter/citadel/gateway-id-*`,
        ],
      }),
    );
    gatewayRegistrationHandler.addToRolePolicy(
      new iam.PolicyStatement({
        effect: iam.Effect.ALLOW,
        actions: ["secretsmanager:GetSecretValue"],
        resources: [
          `arn:aws:secretsmanager:${this.region}:${this.account}:secret:/citadel/integrations/*`,
        ],
      }),
    );
    gatewayRegistrationHandler.addToRolePolicy(
      new iam.PolicyStatement({
        effect: iam.Effect.ALLOW,
        actions: [
          "bedrock-agentcore:CreateGatewayTarget",
          "bedrock-agentcore:DeleteGatewayTarget",
          "bedrock-agentcore:GetGatewayTarget",
        ],
        resources: [
          `arn:aws:bedrock-agentcore:${this.region}:${this.account}:gateway/*`,
          `arn:aws:bedrock-agentcore:${this.region}:${this.account}:gateway/*/target/*`,
        ],
      }),
    );

    // Credential-provider read + delete for disconnect cleanup. The handler
    // looks up the OAUTH2 / API_KEY credential provider for an integration to
    // populate the gateway target payload (read), and deletes the provider
    // when an integration is disconnected (delete cleanup path).
    gatewayRegistrationHandler.addToRolePolicy(
      new iam.PolicyStatement({
        effect: iam.Effect.ALLOW,
        actions: [
          "bedrock-agentcore:GetOauth2CredentialProvider",
          "bedrock-agentcore:GetApiKeyCredentialProvider",
          "bedrock-agentcore:DeleteOauth2CredentialProvider",
          "bedrock-agentcore:DeleteApiKeyCredentialProvider",
        ],
        resources: [
          `arn:aws:bedrock-agentcore:${this.region}:${this.account}:credential-provider/integration-*`,
        ],
      }),
    );

    // Read access to the OAuth return-URL SSM parameter (mirrors the grant on
    // the integration-resolver role; the handler also reads this env var when
    // building OAUTH2 gateway target payloads).
    oauthReturnUrlParam.grantRead(gatewayRegistrationHandler);
    gatewayRegistrationHandler.addToRolePolicy(
      new iam.PolicyStatement({
        effect: iam.Effect.ALLOW,
        actions: ["s3:GetObject"],
        resources: [
          `arn:aws:s3:::citadel-schemas-${props.environment}-${this.account}-${this.region}/*`,
        ],
      }),
    );

    // NOTE: US-IMP-031 MCP Gateway publish/unpublish grants for
    // agentImportResolverFunction (GATEWAY_ID_PARAM env var,
    // CreateGatewayTarget/DeleteGatewayTarget, API-key credential-provider
    // lifecycle, gateway-id ssm:GetParameter) moved to CitadelRegistryStack
    // (backend-stack-split phase 2).

    // EventBridge rule for gateway registration
    const gatewayRegistrationRule = new events.Rule(
      this,
      "GatewayRegistrationRule",
      {
        eventBus: this.agentEventBus,
        ruleName: `citadel-gateway-registration-${props.environment}`,
        description:
          "Triggers gateway registration when integration connects/disconnects",
        eventPattern: {
          detailType: [
            "integration.connect.requested",
            "integration.disconnect.requested",
          ],
          source: ["citadel.integrations"],
        },
      },
    );

    gatewayRegistrationRule.addTarget(
      new targets.LambdaFunction(gatewayRegistrationHandler, {
        retryAttempts: 2,
        maxEventAge: cdk.Duration.hours(2),
      }),
    );

    // Grant Cognito permissions to user management function
    userManagementResolverFunction.addToRolePolicy(
      new iam.PolicyStatement({
        effect: iam.Effect.ALLOW,
        actions: [
          "cognito-idp:ListUsers",
          "cognito-idp:AdminGetUser",
          "cognito-idp:AdminCreateUser",
          "cognito-idp:AdminAddUserToGroup",
          "cognito-idp:AdminRemoveUserFromGroup",
          "cognito-idp:AdminUpdateUserAttributes",
          "cognito-idp:AdminListGroupsForUser",
          "cognito-idp:ListGroups",
          "cognito-idp:AdminSetUserPassword",
        ],
        resources: [this.userPool.userPoolArn],
      }),
    );

    // Grant DynamoDB permissions to user management function
    organisationTable.grantReadData(userManagementResolverFunction);

    // Organization Management Resolver
    const organizationResolverFunction = new lambda.Function(
      this,
      "OrganizationResolverFunction",
      {
        runtime: lambda.Runtime.NODEJS_24_X,
        handler: "organization-resolver.handler",
        code: lambda.Code.fromAsset("dist/lambda"),
        environment: {
          ORGANIZATIONS_TABLE: organisationTable.tableName,
          // Required for orphan-user verification on deleteOrganization
          // (Cognito ListUsers with custom:organization filter).
          USER_POOL_ID: this.userPool.userPoolId,
        },
        timeout: cdk.Duration.seconds(30),
        logGroup: new logs.LogGroup(this, "OrganizationResolverFunctionLogs", {
          retention: logs.RetentionDays.ONE_WEEK,
          removalPolicy: cdk.RemovalPolicy.DESTROY,
        }),
      },
    );

    // Grant DynamoDB permissions to organization management function
    organisationTable.grantReadWriteData(organizationResolverFunction);

    // Grant Cognito ListUsers for orphan-user verification before
    // deleteOrganization. Scoped to the user pool ARN — least privilege.
    organizationResolverFunction.addToRolePolicy(
      new iam.PolicyStatement({
        effect: iam.Effect.ALLOW,
        actions: ["cognito-idp:ListUsers"],
        resources: [this.userPool.userPoolArn],
      }),
    );

    // Seed Organizations Custom Resource
    const seedOrganizationsLambda = new lambda.Function(
      this,
      "SeedOrganizationsFunction",
      {
        runtime: lambda.Runtime.PYTHON_3_14,
        handler: "index.handler",
        code: lambda.Code.fromAsset(
          path.join(__dirname, "../../src/lambda/seed-organizations"),
        ),
        timeout: cdk.Duration.seconds(30),
        environment: {
          ORGANISATION_TABLE: organisationTable.tableName,
        },
        logGroup: new logs.LogGroup(this, "SeedOrganizationsFunctionLogs", {
          retention: logs.RetentionDays.ONE_WEEK,
          removalPolicy: cdk.RemovalPolicy.DESTROY,
        }),
      },
    );

    organisationTable.grantWriteData(seedOrganizationsLambda);

    // Create Custom Resource to seed organizations
    const seedOrganizationsResource = new cdk.CustomResource(
      this,
      "SeedOrganizationsResource",
      {
        serviceToken: seedOrganizationsLambda.functionArn,
        properties: {
          // O-05: Use content hash instead of Date.now() to avoid unnecessary re-runs
          Version: "v1.0.0",
        },
      },
    );

    // Ensure the Custom Resource runs after the table is created
    seedOrganizationsResource.node.addDependency(organisationTable);

    // Seed Blueprints Custom Resource
    // Idempotency-seam smoke fixture (see backend/lib/arbiter-stack.ts for
    // the paired smoke agent + table): gated on the stack's own
    // `props.environment`, independently of ArbiterStack, since the two
    // stacks are not cross-wired for this flag. Non-prod only — a prod
    // deploy never sets SMOKE_FIXTURES_ENABLED, so seed-blueprints/index.ts
    // never appends the smoke workflow to what it seeds.
    const isNonProdSmokeEnv = props.environment !== "prod";
    const seedBlueprintsLambda = new lambda.Function(
      this,
      "SeedBlueprintsFunction",
      {
        runtime: lambda.Runtime.NODEJS_24_X,
        handler: "seed-blueprints/index.handler",
        code: lambda.Code.fromAsset("dist/lambda"),
        timeout: cdk.Duration.seconds(30),
        environment: {
          WORKFLOWS_TABLE: this.workflowsTable.tableName,
          ...(isNonProdSmokeEnv && { SMOKE_FIXTURES_ENABLED: "true" }),
        },
        logGroup: new logs.LogGroup(this, "SeedBlueprintsFunctionLogs", {
          retention: logs.RetentionDays.ONE_WEEK,
          removalPolicy: cdk.RemovalPolicy.DESTROY,
        }),
      },
    );

    this.workflowsTable.grantWriteData(seedBlueprintsLambda);

    // Bumped Version v1.2.0 → v1.3.0 so the CFN Update event re-fires on the
    // next non-prod deploy and seeds the new Idempotency Smoke Workflow row.
    const seedBlueprintsResource = new cdk.CustomResource(
      this,
      "SeedBlueprintsResource",
      {
        serviceToken: seedBlueprintsLambda.functionArn,
        properties: {
          Version: "v1.3.0",
        },
      },
    );

    seedBlueprintsResource.node.addDependency(this.workflowsTable);

    // Seed Model Catalog Custom Resource
    const seedModelCatalogLambda = new lambda.Function(
      this,
      "SeedModelCatalogFunction",
      {
        runtime: lambda.Runtime.NODEJS_24_X,
        handler: "seed-model-catalog/index.handler",
        code: lambda.Code.fromAsset("dist/lambda"),
        timeout: cdk.Duration.seconds(30),
        environment: {
          MODEL_CATALOG_TABLE: modelCatalogTable.tableName,
          MODEL_CONFIG_TABLE: modelConfigTable.tableName,
        },
        logGroup: new logs.LogGroup(this, "SeedModelCatalogFunctionLogs", {
          retention: logs.RetentionDays.ONE_WEEK,
          removalPolicy: cdk.RemovalPolicy.DESTROY,
        }),
      },
    );

    modelCatalogTable.grantWriteData(seedModelCatalogLambda);
    modelConfigTable.grantWriteData(seedModelCatalogLambda);

    const seedModelCatalogResource = new cdk.CustomResource(
      this,
      "SeedModelCatalogResource",
      {
        serviceToken: seedModelCatalogLambda.functionArn,
        properties: {
          Version: "v1.0.0",
        },
      },
    );

    seedModelCatalogResource.node.addDependency(modelCatalogTable);
    seedModelCatalogResource.node.addDependency(modelConfigTable);

    // Admin email: prefer CDK context param, fall back to env var
    const adminEmail =
      this.node.tryGetContext("adminEmail") || process.env.ADMIN_EMAIL || "";

    // Auto-generate admin password via Secrets Manager (never stored in code or env vars)
    const adminPasswordSecret = new cdk.aws_secretsmanager.Secret(
      this,
      "AdminPasswordSecret",
      {
        secretName: `citadel/admin-password-${props.environment}`,
        description: "Auto-generated admin user password for initial seed",
        generateSecretString: {
          secretStringTemplate: JSON.stringify({ email: adminEmail }),
          generateStringKey: "password",
          passwordLength: 16,
          excludePunctuation: false,
        },
      },
    );

    // Seed Admin User Custom Resource
    const seedAdminUserLambda = new lambda.Function(
      this,
      "SeedAdminUserFunction",
      {
        runtime: lambda.Runtime.PYTHON_3_14,
        handler: "index.handler",
        code: lambda.Code.fromAsset("src/lambda/seed-admin-user"),
        timeout: cdk.Duration.seconds(30),
        environment: {
          USER_POOL_ID: this.userPool.userPoolId,
          ADMIN_EMAIL: adminEmail,
          ADMIN_FIRST_NAME: process.env.ADMIN_FIRST_NAME || "Admin",
          ADMIN_LAST_NAME: process.env.ADMIN_LAST_NAME || "User",
          ADMIN_PASSWORD_SECRET_ARN: adminPasswordSecret.secretArn,
        },
        logGroup: new logs.LogGroup(this, "SeedAdminUserFunctionLogs", {
          retention: logs.RetentionDays.ONE_WEEK,
          removalPolicy: cdk.RemovalPolicy.DESTROY,
        }),
      },
    );

    // Grant read access to the admin password secret
    adminPasswordSecret.grantRead(seedAdminUserLambda);

    // Grant Cognito permissions to seed admin user function
    seedAdminUserLambda.addToRolePolicy(
      new iam.PolicyStatement({
        effect: iam.Effect.ALLOW,
        actions: [
          "cognito-idp:AdminCreateUser",
          "cognito-idp:AdminGetUser",
          "cognito-idp:AdminAddUserToGroup",
          "cognito-idp:AdminUpdateUserAttributes",
        ],
        resources: [this.userPool.userPoolArn],
      }),
    );

    // Create Custom Resource to seed admin user
    const seedAdminUserResource = new cdk.CustomResource(
      this,
      "SeedAdminUserResource",
      {
        serviceToken: seedAdminUserLambda.functionArn,
        properties: {
          // O-05: Use content hash instead of Date.now() to avoid unnecessary re-runs
          Version: "v2.0.0",
          AdminEmail: adminEmail,
        },
      },
    );

    // Output the secret ARN so deployers can retrieve the generated password
    new cdk.CfnOutput(this, "AdminPasswordSecretArn", {
      value: adminPasswordSecret.secretArn,
      description:
        "Retrieve admin password: aws secretsmanager get-secret-value --secret-id <this-arn> --query SecretString --output text",
    });

    // Ensure the Custom Resource runs after user pool and admin group are created
    seedAdminUserResource.node.addDependency(this.userPool);
    seedAdminUserResource.node.addDependency(adminGroup);

    // Grant EventBridge permissions
    // NOTE: grants for projectResolverFunction, conversationResolverFunction,
    // and agentResolverFunction moved to CitadelProjectsStack.
    this.agentEventBus.grantPutEventsTo(taskRunnerResolverFunction);

    // --- Workflow, App, Execution Resolver Lambdas ---

    // Workflow Resolver Lambda
    const workflowResolverFunction = new lambda.Function(
      this,
      "WorkflowResolverFunction",
      {
        runtime: lambda.Runtime.NODEJS_24_X,
        handler: "workflow-resolver.handler",
        code: lambda.Code.fromAsset("dist/lambda"),
        environment: {
          WORKFLOWS_TABLE: this.workflowsTable.tableName,
          APPS_TABLE: this.appsTable.tableName,
          AGENT_CONFIG_TABLE: this.agentConfigTable.tableName,
          EVENT_BUS_NAME: this.agentEventBus.eventBusName,
          USER_POOL_ID: this.userPool.userPoolId,
        },
        timeout: cdk.Duration.seconds(30),
        logGroup: new logs.LogGroup(this, "WorkflowResolverFunctionLogs", {
          retention: logs.RetentionDays.ONE_WEEK,
          removalPolicy: cdk.RemovalPolicy.DESTROY,
        }),
      },
    );

    // Workflow Resolver IAM — least-privilege per design 8.2
    this.workflowsTable.grantReadWriteData(workflowResolverFunction);
    this.appsTable.grantReadWriteData(workflowResolverFunction);
    this.agentConfigTable.grantReadData(workflowResolverFunction);
    this.agentEventBus.grantPutEventsTo(workflowResolverFunction);
    workflowResolverFunction.addToRolePolicy(
      new iam.PolicyStatement({
        effect: iam.Effect.ALLOW,
        actions: ["cognito-idp:AdminGetUser"],
        resources: [this.userPool.userPoolArn],
      }),
    );

    // NOTE: registryAgentRecordResolverFunction (the 28-field hot resolver:
    // App CRUD, workflow binding, config, API-key management, auth config,
    // access control, metrics) + all its IAM grants moved to
    // CitadelRegistryStack (backend-stack-split phase 2, decision 30e6d067).

    // App Component Registration Handler — subscribes to fabrication events (Req 6.3)
    const appComponentRegistrationHandler = new lambda.Function(
      this,
      "AppComponentRegistrationHandler",
      {
        runtime: lambda.Runtime.NODEJS_24_X,
        handler: "app-component-registration-handler.handler",
        code: lambda.Code.fromAsset("dist/lambda"),
        environment: {
          APPS_TABLE: this.appsTable.tableName,
        },
        timeout: cdk.Duration.seconds(30),
        logGroup: new logs.LogGroup(
          this,
          "AppComponentRegistrationHandlerLogs",
          {
            retention: logs.RetentionDays.ONE_WEEK,
            removalPolicy: cdk.RemovalPolicy.DESTROY,
          },
        ),
      },
    );

    this.appsTable.grantReadWriteData(appComponentRegistrationHandler);

    const fabricationRegistrationRule = new events.Rule(
      this,
      "FabricationRegistrationRule",
      {
        eventBus: this.agentEventBus,
        eventPattern: {
          detailType: ["agent.fabricated", "tool.fabricated"],
        },
      },
    );

    fabricationRegistrationRule.addTarget(
      new targets.LambdaFunction(appComponentRegistrationHandler, {
        retryAttempts: 2,
        maxEventAge: cdk.Duration.hours(2),
      }),
    );

    // Execution Resolver Lambda
    const executionResolverFunction = new lambda.Function(
      this,
      "ExecutionResolverFunction",
      {
        runtime: lambda.Runtime.NODEJS_24_X,
        handler: "execution-resolver.handler",
        code: lambda.Code.fromAsset("dist/lambda"),
        environment: {
          EXECUTIONS_TABLE: this.executionsTable.tableName,
          WORKFLOWS_TABLE: this.workflowsTable.tableName,
          EVENT_BUS_NAME: this.agentEventBus.eventBusName,
          USER_POOL_ID: this.userPool.userPoolId,
        },
        timeout: cdk.Duration.seconds(30),
        logGroup: new logs.LogGroup(this, "ExecutionResolverFunctionLogs", {
          retention: logs.RetentionDays.ONE_WEEK,
          removalPolicy: cdk.RemovalPolicy.DESTROY,
        }),
      },
    );

    // Execution Resolver IAM — least-privilege per design 8.2
    this.executionsTable.grantReadWriteData(executionResolverFunction);
    this.workflowsTable.grantReadData(executionResolverFunction);
    this.agentEventBus.grantPutEventsTo(executionResolverFunction);
    executionResolverFunction.addToRolePolicy(
      new iam.PolicyStatement({
        effect: iam.Effect.ALLOW,
        actions: ["cognito-idp:AdminGetUser"],
        resources: [this.userPool.userPoolArn],
      }),
    );

    // The resolver emits a best-effort NodeColdStart metric (once per
    // container lifetime) into the Citadel/Workflows namespace — the same
    // namespace/metric-emission shape as the arbiter worker's node-level
    // metrics. PutMetricData has no resource-level scoping; the call is
    // narrowed to that namespace in code.
    executionResolverFunction.addToRolePolicy(
      new iam.PolicyStatement({
        effect: iam.Effect.ALLOW,
        actions: ["cloudwatch:PutMetricData"],
        resources: ["*"],
      }),
    );
    NagSuppressions.addResourceSuppressions(
      executionResolverFunction.role!,
      [
        {
          id: "AwsSolutions-IAM5",
          reason:
            "cloudwatch:PutMetricData has no resource-level scoping; the " +
            "resolver narrows the call to the Citadel/Workflows namespace " +
            "(NodeColdStart cold-start metric).",
          appliesTo: ["Resource::*"],
        },
      ],
      true,
    );

    // AppSync GraphQL API — schema deferred to the L1 escape hatch below so
    // the schema is uploaded to S3 (definitionS3Location) instead of
    // inlined into the CFN template. Inline Definition has a Unicode
    // encoding-downgrade footgun in the CDK→CFN pipeline (em dashes,
    // arrows, section signs become '?') which made schema edits silently
    // no-op for ~9 days in May. S3-backed schemas are content-hashed by
    // the CDK Asset, so any byte-level change forces CFN to diff.
    this.appSyncApi = new appsync.GraphqlApi(this, "AgenticAIApi", {
      name: `citadel-api-${props.environment}`,
      definition: appsync.Definition.fromFile("src/schema/schema.graphql"),
      authorizationConfig: {
        defaultAuthorization: {
          authorizationType: appsync.AuthorizationType.USER_POOL,
          userPoolConfig: {
            userPool: this.userPool,
          },
        },
        additionalAuthorizationModes: [
          {
            authorizationType: appsync.AuthorizationType.IAM,
          },
        ],
      },
      logConfig: {
        fieldLogLevel: appsync.FieldLogLevel.ALL,
        retention: logs.RetentionDays.ONE_WEEK,
      },
      xrayEnabled: true,
    });

    // Override the auto-generated AWS::AppSync::GraphQLSchema to use a
    // content-hashed S3 asset rather than the inline Definition string.
    // The L2 GraphqlApi above still reads the schema file at synth time
    // (so its bind() succeeds), but its inline `Definition` property is
    // deleted from the rendered template and replaced with
    // `DefinitionS3Location`. The Asset content hash forces CFN to diff
    // on any byte-level change, eliminating the silent-no-op footgun.
    const schemaAsset = new Asset(this, "AgenticAIApiSchemaAsset", {
      path: "src/schema/schema.graphql",
    });
    const cfnSchema = this.appSyncApi.node.findChild(
      "Schema",
    ) as CfnGraphQLSchema;
    cfnSchema.addPropertyDeletionOverride("Definition");
    cfnSchema.definitionS3Location = schemaAsset.s3ObjectUrl;

    // Workflow Progress Fan-out Lambda (needs AppSync endpoint)
    this.workflowProgressFanoutFunction = new lambda.Function(
      this,
      "WorkflowProgressFanoutFunction",
      {
        runtime: lambda.Runtime.NODEJS_24_X,
        handler: "workflow-progress-fanout.handler",
        code: lambda.Code.fromAsset("dist/lambda"),
        environment: {
          APPSYNC_ENDPOINT: this.appSyncApi.graphqlUrl,
        },
        timeout: cdk.Duration.seconds(30),
        logGroup: new logs.LogGroup(
          this,
          "WorkflowProgressFanoutFunctionLogs",
          {
            retention: logs.RetentionDays.ONE_WEEK,
            removalPolicy: cdk.RemovalPolicy.DESTROY,
          },
        ),
      },
    );

    // Fan-out IAM — least-privilege per design 8.2: appsync:GraphQL on publishWorkflowProgress
    this.workflowProgressFanoutFunction.addToRolePolicy(
      new iam.PolicyStatement({
        effect: iam.Effect.ALLOW,
        actions: ["appsync:GraphQL"],
        resources: [
          `${this.appSyncApi.arn}/types/Mutation/fields/publishWorkflowProgress`,
        ],
      }),
    );

    // Fan-out failure observability: the fan-out Lambda emits a best-effort
    // Citadel/Workflows FanoutPublishFailure metric whenever a publish fails
    // (non-2xx HTTP status OR a 200 carrying a GraphQL `errors` array).
    // PutMetricData has no resource-level scoping; the call is narrowed to the
    // Citadel/Workflows namespace in code.
    this.workflowProgressFanoutFunction.addToRolePolicy(
      new iam.PolicyStatement({
        effect: iam.Effect.ALLOW,
        actions: ["cloudwatch:PutMetricData"],
        resources: ["*"],
      }),
    );
    NagSuppressions.addResourceSuppressions(
      this.workflowProgressFanoutFunction.role!,
      [
        {
          id: "AwsSolutions-IAM5",
          reason:
            "cloudwatch:PutMetricData has no resource-level scoping; the " +
            "workflow-progress-fanout Lambda narrows the call to the " +
            "Citadel/Workflows namespace (FanoutPublishFailure metric).",
          appliesTo: ["Resource::*"],
        },
      ],
      true,
    );

    // Alarm on the fan-out publish-failure metric so GraphQL-level publish
    // errors (which return HTTP 200) surface, not just Lambda-level exceptions.
    // Actioned to the shared alarm topic below, once it is constructed (the
    // topic is created later in this stack, near the other O-01 alarms).
    const workflowProgressFanoutFailureAlarm = new cloudwatch.Alarm(
      this,
      "WorkflowProgressFanoutFailureAlarm",
      {
        alarmName: `citadel-workflow-fanout-publish-failure-${props.environment}`,
        metric: new cloudwatch.Metric({
          namespace: "Citadel/Workflows",
          metricName: "FanoutPublishFailure",
          period: cdk.Duration.minutes(5),
          statistic: "Sum",
        }),
        threshold: 1,
        evaluationPeriods: 1,
        comparisonOperator:
          cloudwatch.ComparisonOperator.GREATER_THAN_OR_EQUAL_TO_THRESHOLD,
        treatMissingData: cloudwatch.TreatMissingData.NOT_BREACHING,
        alarmDescription:
          "Workflow progress fan-out failed to publish to AppSync (transport or GraphQL error).",
      },
    );

    // Lambda function for handling agent messages
    const agentMessageHandlerFunction = new lambda.Function(
      this,
      "AgentMessageHandlerFunction",
      {
        runtime: lambda.Runtime.NODEJS_24_X,
        handler: "agent-message-handler.handler",
        code: lambda.Code.fromAsset("dist/lambda"),
        environment: {
          PROJECTS_TABLE: this.projectsTable.tableName,
          CONVERSATIONS_TABLE: this.conversationsTable.tableName,
          AGENT_STATUS_TABLE: agentStatusTable.tableName,
          APPSYNC_ENDPOINT: this.appSyncApi.graphqlUrl,
          ENVIRONMENT: props.environment,
          IDEMPOTENCY_TABLE: this.idempotencyTable.tableName,
          // Deployment account id — read by the import-dispatch path via
          // isCrossAccountRoleArn(invocation.roleArn, process.env.ACCOUNT_ID)
          // so a CROSS-ACCOUNT imported invoke assumes the operator-supplied
          // invoke role (externalId-gated) instead of using the handler
          // identity. Same-account invokes are unaffected.
          ACCOUNT_ID: this.account,
        },
        timeout: cdk.Duration.minutes(15), // Max timeout for agent interactions (extraction can be slow)
        // Right-sized from the 128MB default (~1/12 vCPU): this handler does
        // SigV4 request signing and AgentCore response-stream iteration,
        // both CPU-bound. 512MB ≈ ~1/3 vCPU. Pinned by
        // test/backend-stack-message-handler-memory.test.ts.
        memorySize: 512,
        logGroup: new logs.LogGroup(this, "AgentMessageHandlerFunctionLogs", {
          retention: logs.RetentionDays.ONE_WEEK,
          removalPolicy: cdk.RemovalPolicy.DESTROY,
        }),
      },
    );

    this.idempotencyTable.grantReadWriteData(agentMessageHandlerFunction);

    // Grant permissions to read SSM parameters for agent configuration
    agentMessageHandlerFunction.addToRolePolicy(
      new iam.PolicyStatement({
        effect: iam.Effect.ALLOW,
        actions: ["ssm:GetParameter", "ssm:GetParameters"],
        resources: [
          `arn:aws:ssm:${this.region}:${this.account}:parameter/citadel/agents/*`,
        ],
      }),
    );

    // Invoke-side auth-secret resolution for IMPORTED agents: the handler
    // resolves an imported agent's invocation `auth.secretRef`
    // (API_KEY / OAUTH2 / COGNITO) to apply the request Authorization header.
    // Least privilege: READ-only GetSecretValue scoped to the agent secret-path
    // convention /citadel/agents/* (the WRITE-only counterpart —
    // CreateSecret/PutSecretValue/TagResource — lives on the import resolver).
    // The legacy AgentCore path uses no secret and is unaffected.
    agentMessageHandlerFunction.addToRolePolicy(
      new iam.PolicyStatement({
        effect: iam.Effect.ALLOW,
        actions: ["secretsmanager:GetSecretValue"],
        resources: [
          `arn:aws:secretsmanager:${this.region}:${this.account}:secret:/citadel/agents/*`,
        ],
      }),
    );

    // Cross-account invoke-role assume for IMPORTED agents (Phase 2,
    // agent-import). When an imported agent's invocation.roleArn is in a
    // DIFFERENT account, the handler assumes that operator-supplied invoke role
    // (reusing vendImportCredentials) and runs the AWS-native protocol invoke
    // under the assumed credentials. The invoke role is operator-supplied and
    // may live in ANY account, so the assume cannot be account-scoped; it is
    // scoped to the cross-account IAM role namespace (arn:aws:iam::*:role/*).
    // The runtime confused-deputy control is the externalId threaded into the
    // AssumeRole call — the target role must trust Citadel under sts:ExternalId.
    // Same-account invokes never assume. The role/* wildcard is suppressed
    // (AwsSolutions-IAM5) in bin/app.ts.
    agentMessageHandlerFunction.addToRolePolicy(
      new iam.PolicyStatement({
        effect: iam.Effect.ALLOW,
        actions: ["sts:AssumeRole"],
        resources: ["arn:aws:iam::*:role/*"],
      }),
    );

    // Grant permissions to invoke Bedrock AgentCore Runtime
    agentMessageHandlerFunction.addToRolePolicy(
      new iam.PolicyStatement({
        effect: iam.Effect.ALLOW,
        actions: [
          "bedrock-agentcore:InvokeAgentRuntime",
          "bedrock-agentcore:InvokeAgent",
          "bedrock:InvokeModel",
        ],
        resources: ["*"], // AgentCore agents can be in different regions
      }),
    );

    // Grant DynamoDB permissions for storing responses
    this.conversationsTable.grantReadWriteData(agentMessageHandlerFunction);
    agentStatusTable.grantReadWriteData(agentMessageHandlerFunction);

    // Grant AppSync permissions to trigger mutations
    agentMessageHandlerFunction.addToRolePolicy(
      new iam.PolicyStatement({
        effect: iam.Effect.ALLOW,
        actions: ["appsync:GraphQL"],
        resources: [
          `${this.appSyncApi.arn}/types/Mutation/fields/publishConversationMessage`,
        ],
      }),
    );

    // EventBridge rule for message.sent_to_agent events
    const messageSentToAgentRule = new events.Rule(
      this,
      "MessageSentToAgentRule",
      {
        eventBus: this.agentEventBus,
        ruleName: `citadel-message-to-agent-${props.environment}`,
        description: "Triggers Lambda when a message is sent to an agent",
        eventPattern: {
          detailType: ["message.sent_to_agent"],
          source: ["citadel"],
        },
      },
    );

    // Add Lambda as target for the rule
    messageSentToAgentRule.addTarget(
      new targets.LambdaFunction(agentMessageHandlerFunction, {
        retryAttempts: 2,
        maxEventAge: cdk.Duration.hours(2),
      }),
    );

    // --- App Invoke Handler (Agent App invoke-path fix) ---------------------
    // EventBridge consumer for the per-app invoke path. The per-app API
    // Gateway's EventBridge-PutEvents integration (provisionApiGateway in
    // app-publish-handler.ts) emits `app.invoke.requested` on source
    // `citadel.app.invoke` with the AUTHORITATIVE appId carried in
    // event.resources[0] (set via the Resources RequestParameters context
    // expression, never the client body). This handler resolves + validates
    // the bound/PUBLISHED workflow and starts an execution, mirroring
    // execution-resolver.ts startExecution semantics.
    const appInvokeHandlerFunction = new lambda.Function(
      this,
      "AppInvokeHandler",
      {
        runtime: lambda.Runtime.NODEJS_24_X,
        handler: "app-invoke-handler.handler",
        code: lambda.Code.fromAsset("dist/lambda"),
        functionName: `citadel-app-invoke-handler-${props.environment}`,
        environment: {
          APPS_TABLE: this.appsTable.tableName,
          WORKFLOWS_TABLE: this.workflowsTable.tableName,
          EXECUTIONS_TABLE: this.executionsTable.tableName,
          EVENT_BUS_NAME: this.agentEventBus.eventBusName,
          IDEMPOTENCY_TABLE: this.idempotencyTable.tableName,
        },
        timeout: cdk.Duration.seconds(30),
        logGroup: new logs.LogGroup(this, "AppInvokeHandlerLogs", {
          retention: logs.RetentionDays.ONE_WEEK,
          removalPolicy: cdk.RemovalPolicy.DESTROY,
        }),
      },
    );

    // Least-privilege: read app/workflow metadata (incl. GroupIndex for the
    // app METADATA lookup), write new executions, read/write the idempotency
    // table (event.id dedup), and emit execution.start.requested.
    this.appsTable.grantReadData(appInvokeHandlerFunction);
    this.workflowsTable.grantReadData(appInvokeHandlerFunction);
    this.executionsTable.grantWriteData(appInvokeHandlerFunction);
    this.idempotencyTable.grantReadWriteData(appInvokeHandlerFunction);
    this.agentEventBus.grantPutEventsTo(appInvokeHandlerFunction);

    const appInvokeRule = new events.Rule(this, "AppInvokeRule", {
      eventBus: this.agentEventBus,
      description:
        "Routes per-app invoke requests from API Gateway to the app-invoke handler",
      eventPattern: {
        source: ["citadel.app.invoke"],
        detailType: ["app.invoke.requested"],
      },
    });

    appInvokeRule.addTarget(
      new targets.LambdaFunction(appInvokeHandlerFunction, {
        retryAttempts: 2,
        maxEventAge: cdk.Duration.hours(2),
      }),
    );

    // NOTE: projectProgressUpdater and assessmentCompletionNotifier moved to
    // CitadelProjectsStack (backend-stack-split phase 1), along with their
    // ProgressUpdateRule / AssessmentCompletionRule EventBridge targets.

    // NOTE: fabricationEventHandlerFunction (+ its AppSync GraphQL grant,
    // FabricationEventLambdaDataSource, and FabricationEventRule) moved to
    // CitadelRegistryStack (backend-stack-split phase 2, decision 30e6d067) —
    // the rule was left in BackendStack during phase 1 specifically because
    // its target function moves here, in phase 2.

    // Data sources
    // NOTE: ProjectsDataSource/ConversationsDataSource/AgentStatusDataSource
    // (unused DynamoDB data sources — no resolver ever attached) and
    // ProjectLambdaDataSource/ConversationLambdaDataSource/
    // AgentLambdaDataSource/DocumentUploadLambdaDataSource/
    // DocumentLambdaDataSource/ChatterLambdaDataSource moved to
    // CitadelProjectsStack. AgentImportLambdaDataSource/
    // AgentCodeLambdaDataSource/FabricatorRequestLambdaDataSource/
    // FabricatorQueueLambdaDataSource/RegistryAgentRecordLambdaDataSource/
    // FabricationEventLambdaDataSource moved to CitadelRegistryStack
    // (backend-stack-split phase 2).
    const agentConfigLambdaDataSource = this.appSyncApi.addLambdaDataSource(
      "AgentConfigLambdaDataSource",
      agentConfigResolverFunction,
    );
    const modelConfigLambdaDataSource = this.appSyncApi.addLambdaDataSource(
      "ModelConfigLambdaDataSource",
      modelConfigResolverFunction,
    );
    const toolConfigLambdaDataSource = this.appSyncApi.addLambdaDataSource(
      "ToolConfigLambdaDataSource",
      toolConfigResolverFunction,
    );
    const taskRunnerLambdaDataSource = this.appSyncApi.addLambdaDataSource(
      "TaskRunnerLambdaDataSource",
      taskRunnerResolverFunction,
    );
    const userManagementLambdaDataSource = this.appSyncApi.addLambdaDataSource(
      "UserManagementLambdaDataSource",
      userManagementResolverFunction,
    );
    const organizationLambdaDataSource = this.appSyncApi.addLambdaDataSource(
      "OrganizationLambdaDataSource",
      organizationResolverFunction,
    );
    // NOTE: ChatterLambdaDataSource moved to CitadelProjectsStack.
    const integrationLambdaDataSource = this.appSyncApi.addLambdaDataSource(
      "IntegrationLambdaDataSource",
      integrationResolverFunction,
    );

    // NOTE: GetProjectResolver, ListProjectsResolver, GetAgentStatusResolver,
    // GetConversationHistoryResolver, SendMessageResolver,
    // PublishConversationMessageResolver, CreateProjectResolver,
    // UpdateProjectResolver, SendMessageToAgentResolver,
    // UploadDocumentResolver, GenerateDocumentUploadUrlResolver,
    // GetDocumentIngestionStatusResolver, ListProjectDocumentsResolver,
    // DeleteDocumentResolver, GetProjectDocumentResolver,
    // ListDocumentVersionsResolver, GetDocumentVersionResolver, and
    // GenerateDocumentPdfResolver moved to CitadelProjectsStack.

    // Query resolvers
    agentConfigLambdaDataSource.createResolver("ListAgentConfigsResolver", {
      typeName: "Query",
      fieldName: "listAgentConfigs",
      requestMappingTemplate: appsync.MappingTemplate.lambdaRequest(),
      responseMappingTemplate: appsync.MappingTemplate.lambdaResult(),
    });

    agentConfigLambdaDataSource.createResolver("GetAgentConfigResolver", {
      typeName: "Query",
      fieldName: "getAgentConfig",
      requestMappingTemplate: appsync.MappingTemplate.lambdaRequest(),
      responseMappingTemplate: appsync.MappingTemplate.lambdaResult(),
    });

    modelConfigLambdaDataSource.createResolver("ListModelCatalogResolver", {
      typeName: "Query",
      fieldName: "listModelCatalog",
      requestMappingTemplate: appsync.MappingTemplate.lambdaRequest(),
      responseMappingTemplate: appsync.MappingTemplate.lambdaResult(),
    });

    modelConfigLambdaDataSource.createResolver("GetModelConfigResolver", {
      typeName: "Query",
      fieldName: "getModelConfig",
      requestMappingTemplate: appsync.MappingTemplate.lambdaRequest(),
      responseMappingTemplate: appsync.MappingTemplate.lambdaResult(),
    });

    modelConfigLambdaDataSource.createResolver("UpdateModelConfigResolver", {
      typeName: "Mutation",
      fieldName: "updateModelConfig",
      requestMappingTemplate: appsync.MappingTemplate.lambdaRequest(),
      responseMappingTemplate: appsync.MappingTemplate.lambdaResult(),
    });

    modelConfigLambdaDataSource.createResolver(
      "SetModelCatalogEntryStatusResolver",
      {
        typeName: "Mutation",
        fieldName: "setModelCatalogEntryStatus",
        requestMappingTemplate: appsync.MappingTemplate.lambdaRequest(),
        responseMappingTemplate: appsync.MappingTemplate.lambdaResult(),
      },
    );

    modelConfigLambdaDataSource.createResolver("SyncModelCatalogResolver", {
      typeName: "Mutation",
      fieldName: "syncModelCatalog",
      requestMappingTemplate: appsync.MappingTemplate.lambdaRequest(),
      responseMappingTemplate: appsync.MappingTemplate.lambdaResult(),
    });

    // NOTE: GetAgentCodeResolver moved to CitadelRegistryStack.

    // NOTE: SendMessageResolver, PublishConversationMessageResolver moved to
    // CitadelProjectsStack.

    // Mutation resolvers
    // NOTE: CreateProjectResolver, UpdateProjectResolver,
    // SendMessageToAgentResolver, UploadDocumentResolver,
    // GenerateDocumentUploadUrlResolver, GetDocumentIngestionStatusResolver,
    // ListProjectDocumentsResolver, DeleteDocumentResolver,
    // GetProjectDocumentResolver, ListDocumentVersionsResolver,
    // GetDocumentVersionResolver, and GenerateDocumentPdfResolver moved to
    // CitadelProjectsStack.

    agentConfigLambdaDataSource.createResolver("CreateAgentConfigResolver", {
      typeName: "Mutation",
      fieldName: "createAgentConfig",
      requestMappingTemplate: appsync.MappingTemplate.lambdaRequest(),
      responseMappingTemplate: appsync.MappingTemplate.lambdaResult(),
    });

    // NOTE: ImportAgentResolver, AttestAgentImportResolver,
    // DiscoverAgentsResolver, DescribeAgentCandidateResolver,
    // TestImportedAgentResolver, ProbeAgentCandidateResolver,
    // ProbeImportReachabilityResolver, ProposeAgentManifestTier3Resolver,
    // AcceptProposedManifestTier3Resolver, PublishImportToGatewayResolver,
    // UnpublishImportFromGatewayResolver moved to CitadelRegistryStack
    // (backend-stack-split phase 2).

    agentConfigLambdaDataSource.createResolver("UpdateAgentConfigResolver", {
      typeName: "Mutation",
      fieldName: "updateAgentConfig",
      requestMappingTemplate: appsync.MappingTemplate.lambdaRequest(),
      responseMappingTemplate: appsync.MappingTemplate.lambdaResult(),
    });

    agentConfigLambdaDataSource.createResolver("DeleteAgentConfigResolver", {
      typeName: "Mutation",
      fieldName: "deleteAgentConfig",
      requestMappingTemplate: appsync.MappingTemplate.lambdaRequest(),
      responseMappingTemplate: appsync.MappingTemplate.lambdaResult(),
    });

    agentConfigLambdaDataSource.createResolver(
      "ActivateProjectAgentsResolver",
      {
        typeName: "Mutation",
        fieldName: "activateProjectAgents",
        requestMappingTemplate: appsync.MappingTemplate.lambdaRequest(),
        responseMappingTemplate: appsync.MappingTemplate.lambdaResult(),
      },
    );

    agentConfigLambdaDataSource.createResolver("PublishAgentManifestResolver", {
      typeName: "Mutation",
      fieldName: "publishAgentManifest",
      requestMappingTemplate: appsync.MappingTemplate.lambdaRequest(),
      responseMappingTemplate: appsync.MappingTemplate.lambdaResult(),
    });

    // NOTE: UpdateAgentCodeResolver moved to CitadelRegistryStack.

    // Tool Config Resolvers
    toolConfigLambdaDataSource.createResolver("ListToolConfigsResolver", {
      typeName: "Query",
      fieldName: "listToolConfigs",
      requestMappingTemplate: appsync.MappingTemplate.lambdaRequest(),
      responseMappingTemplate: appsync.MappingTemplate.lambdaResult(),
    });

    toolConfigLambdaDataSource.createResolver("GetToolConfigResolver", {
      typeName: "Query",
      fieldName: "getToolConfig",
      requestMappingTemplate: appsync.MappingTemplate.lambdaRequest(),
      responseMappingTemplate: appsync.MappingTemplate.lambdaResult(),
    });

    toolConfigLambdaDataSource.createResolver("CreateToolConfigResolver", {
      typeName: "Mutation",
      fieldName: "createToolConfig",
      requestMappingTemplate: appsync.MappingTemplate.lambdaRequest(),
      responseMappingTemplate: appsync.MappingTemplate.lambdaResult(),
    });

    toolConfigLambdaDataSource.createResolver("UpdateToolConfigResolver", {
      typeName: "Mutation",
      fieldName: "updateToolConfig",
      requestMappingTemplate: appsync.MappingTemplate.lambdaRequest(),
      responseMappingTemplate: appsync.MappingTemplate.lambdaResult(),
    });

    toolConfigLambdaDataSource.createResolver("DeleteToolConfigResolver", {
      typeName: "Mutation",
      fieldName: "deleteToolConfig",
      requestMappingTemplate: appsync.MappingTemplate.lambdaRequest(),
      responseMappingTemplate: appsync.MappingTemplate.lambdaResult(),
    });

    // Search Resolvers — semantic search via AgentCore Registry
    agentConfigLambdaDataSource.createResolver("SearchAgentConfigsResolver", {
      typeName: "Query",
      fieldName: "searchAgentConfigs",
      requestMappingTemplate: appsync.MappingTemplate.lambdaRequest(),
      responseMappingTemplate: appsync.MappingTemplate.lambdaResult(),
    });

    toolConfigLambdaDataSource.createResolver("SearchToolConfigsResolver", {
      typeName: "Query",
      fieldName: "searchToolConfigs",
      requestMappingTemplate: appsync.MappingTemplate.lambdaRequest(),
      responseMappingTemplate: appsync.MappingTemplate.lambdaResult(),
    });

    // NOTE: RequestAgentCreationResolver, RequestToolCreationResolver,
    // GetFabricatorQueueResolver, PublishFabricationEventResolver moved to
    // CitadelRegistryStack (backend-stack-split phase 2).

    // Task Runner Resolver
    taskRunnerLambdaDataSource.createResolver("SubmitTaskResolver", {
      typeName: "Mutation",
      fieldName: "submitTask",
      requestMappingTemplate: appsync.MappingTemplate.lambdaRequest(),
      responseMappingTemplate: appsync.MappingTemplate.lambdaResult(),
    });

    // User Management Resolvers
    userManagementLambdaDataSource.createResolver("ListUsersResolver", {
      typeName: "Query",
      fieldName: "listUsers",
      requestMappingTemplate: appsync.MappingTemplate.lambdaRequest(),
      responseMappingTemplate: appsync.MappingTemplate.lambdaResult(),
    });

    userManagementLambdaDataSource.createResolver("GetUserResolver", {
      typeName: "Query",
      fieldName: "getUser",
      requestMappingTemplate: appsync.MappingTemplate.lambdaRequest(),
      responseMappingTemplate: appsync.MappingTemplate.lambdaResult(),
    });

    userManagementLambdaDataSource.createResolver(
      "GetCurrentUserProfileResolver",
      {
        typeName: "Query",
        fieldName: "getCurrentUserProfile",
        requestMappingTemplate: appsync.MappingTemplate.lambdaRequest(),
        responseMappingTemplate: appsync.MappingTemplate.lambdaResult(),
      },
    );

    userManagementLambdaDataSource.createResolver("AssignUserRoleResolver", {
      typeName: "Mutation",
      fieldName: "assignUserRole",
      requestMappingTemplate: appsync.MappingTemplate.lambdaRequest(),
      responseMappingTemplate: appsync.MappingTemplate.lambdaResult(),
    });

    userManagementLambdaDataSource.createResolver("RemoveUserRoleResolver", {
      typeName: "Mutation",
      fieldName: "removeUserRole",
      requestMappingTemplate: appsync.MappingTemplate.lambdaRequest(),
      responseMappingTemplate: appsync.MappingTemplate.lambdaResult(),
    });

    userManagementLambdaDataSource.createResolver(
      "ListAvailableRolesResolver",
      {
        typeName: "Query",
        fieldName: "listAvailableRoles",
        requestMappingTemplate: appsync.MappingTemplate.lambdaRequest(),
        responseMappingTemplate: appsync.MappingTemplate.lambdaResult(),
      },
    );

    userManagementLambdaDataSource.createResolver("ListOrganizationsResolver", {
      typeName: "Query",
      fieldName: "listOrganizations",
      requestMappingTemplate: appsync.MappingTemplate.lambdaRequest(),
      responseMappingTemplate: appsync.MappingTemplate.lambdaResult(),
    });

    userManagementLambdaDataSource.createResolver("ChangePasswordResolver", {
      typeName: "Mutation",
      fieldName: "changePassword",
      requestMappingTemplate: appsync.MappingTemplate.lambdaRequest(),
      responseMappingTemplate: appsync.MappingTemplate.lambdaResult(),
    });

    userManagementLambdaDataSource.createResolver(
      "AdminResetUserPasswordResolver",
      {
        typeName: "Mutation",
        fieldName: "adminResetUserPassword",
        requestMappingTemplate: appsync.MappingTemplate.lambdaRequest(),
        responseMappingTemplate: appsync.MappingTemplate.lambdaResult(),
      },
    );

    userManagementLambdaDataSource.createResolver("AdminCreateUserResolver", {
      typeName: "Mutation",
      fieldName: "adminCreateUser",
      requestMappingTemplate: appsync.MappingTemplate.lambdaRequest(),
      responseMappingTemplate: appsync.MappingTemplate.lambdaResult(),
    });

    userManagementLambdaDataSource.createResolver(
      "AdminResendInvitationResolver",
      {
        typeName: "Mutation",
        fieldName: "adminResendInvitation",
        requestMappingTemplate: appsync.MappingTemplate.lambdaRequest(),
        responseMappingTemplate: appsync.MappingTemplate.lambdaResult(),
      },
    );

    // Organization Management Resolvers
    organizationLambdaDataSource.createResolver("CreateOrganizationResolver", {
      typeName: "Mutation",
      fieldName: "createOrganization",
      requestMappingTemplate: appsync.MappingTemplate.lambdaRequest(),
      responseMappingTemplate: appsync.MappingTemplate.lambdaResult(),
    });

    organizationLambdaDataSource.createResolver("DeleteOrganizationResolver", {
      typeName: "Mutation",
      fieldName: "deleteOrganization",
      requestMappingTemplate: appsync.MappingTemplate.lambdaRequest(),
      responseMappingTemplate: appsync.MappingTemplate.lambdaResult(),
    });

    // NOTE: PublishChatterResolver moved to CitadelProjectsStack.

    // Integration Resolvers
    integrationLambdaDataSource.createResolver("ListIntegrationsResolver", {
      typeName: "Query",
      fieldName: "listIntegrations",
      requestMappingTemplate: appsync.MappingTemplate.lambdaRequest(),
      responseMappingTemplate: appsync.MappingTemplate.lambdaResult(),
    });

    integrationLambdaDataSource.createResolver("GetIntegrationResolver", {
      typeName: "Query",
      fieldName: "getIntegration",
      requestMappingTemplate: appsync.MappingTemplate.lambdaRequest(),
      responseMappingTemplate: appsync.MappingTemplate.lambdaResult(),
    });

    integrationLambdaDataSource.createResolver("CreateIntegrationResolver", {
      typeName: "Mutation",
      fieldName: "createIntegration",
      requestMappingTemplate: appsync.MappingTemplate.lambdaRequest(),
      responseMappingTemplate: appsync.MappingTemplate.lambdaResult(),
    });

    integrationLambdaDataSource.createResolver("UpdateIntegrationResolver", {
      typeName: "Mutation",
      fieldName: "updateIntegration",
      requestMappingTemplate: appsync.MappingTemplate.lambdaRequest(),
      responseMappingTemplate: appsync.MappingTemplate.lambdaResult(),
    });

    integrationLambdaDataSource.createResolver("DeleteIntegrationResolver", {
      typeName: "Mutation",
      fieldName: "deleteIntegration",
      requestMappingTemplate: appsync.MappingTemplate.lambdaRequest(),
      responseMappingTemplate: appsync.MappingTemplate.lambdaResult(),
    });

    integrationLambdaDataSource.createResolver("TestIntegrationResolver", {
      typeName: "Mutation",
      fieldName: "testIntegration",
      requestMappingTemplate: appsync.MappingTemplate.lambdaRequest(),
      responseMappingTemplate: appsync.MappingTemplate.lambdaResult(),
    });

    integrationLambdaDataSource.createResolver("ConnectIntegrationResolver", {
      typeName: "Mutation",
      fieldName: "connectIntegration",
      requestMappingTemplate: appsync.MappingTemplate.lambdaRequest(),
      responseMappingTemplate: appsync.MappingTemplate.lambdaResult(),
    });

    integrationLambdaDataSource.createResolver(
      "DisconnectIntegrationResolver",
      {
        typeName: "Mutation",
        fieldName: "disconnectIntegration",
        requestMappingTemplate: appsync.MappingTemplate.lambdaRequest(),
        responseMappingTemplate: appsync.MappingTemplate.lambdaResult(),
      },
    );

    // NOTE: assessmentCompletionResolverFunction, assessmentProgressResolverFunction,
    // designProgressResolverFunction, and generateReportUrlFunction (+ their
    // DataSources and resolvers: PublishAssessmentCompletionResolver,
    // GetAssessmentProgressResolver, PublishDesignProgressResolver,
    // GenerateReportDownloadUrlResolver) moved to CitadelProjectsStack
    // (backend-stack-split phase 1).

    // DataStores Table
    const dataStoresTable = new dynamodb.Table(this, "DataStoresTable", {
      tableName: `citadel-datastores-${props.environment}`,
      partitionKey: {
        name: "dataStoreId",
        type: dynamodb.AttributeType.STRING,
      },
      billingMode: dynamodb.BillingMode.PAY_PER_REQUEST,
      removalPolicy: cdk.RemovalPolicy.DESTROY,
      pointInTimeRecoverySpecification: { pointInTimeRecoveryEnabled: true },
    });

    dataStoresTable.addGlobalSecondaryIndex({
      indexName: "OrgIndex",
      partitionKey: { name: "orgId", type: dynamodb.AttributeType.STRING },
      sortKey: { name: "createdAt", type: dynamodb.AttributeType.STRING },
      projectionType: dynamodb.ProjectionType.ALL,
    });

    // DataStore Resolver Lambda
    const dataStoreResolverFunction = new lambda.Function(
      this,
      "DataStoreResolverFunction",
      {
        runtime: lambda.Runtime.NODEJS_24_X,
        handler: "datastore-resolver.handler",
        code: lambda.Code.fromAsset("dist/lambda"),
        environment: {
          DATASTORES_TABLE: dataStoresTable.tableName,
          ENVIRONMENT: props.environment,
          HEALTH_MONITOR_ROLE_PARAM: `/citadel/health-monitor-role-${props.environment}`,
        },
        timeout: cdk.Duration.minutes(10),
        memorySize: 256,
        logGroup: new logs.LogGroup(this, "DataStoreResolverFunctionLogs", {
          retention: logs.RetentionDays.ONE_WEEK,
          removalPolicy: cdk.RemovalPolicy.DESTROY,
        }),
      },
    );

    // Grant DynamoDB permissions
    dataStoresTable.grantReadWriteData(dataStoreResolverFunction);

    // Grant Secrets Manager permissions
    dataStoreResolverFunction.addToRolePolicy(
      new iam.PolicyStatement({
        effect: iam.Effect.ALLOW,
        actions: [
          "secretsmanager:CreateSecret",
          "secretsmanager:UpdateSecret",
          "secretsmanager:DeleteSecret",
          "secretsmanager:GetSecretValue",
        ],
        resources: [
          `arn:aws:secretsmanager:${this.region}:${this.account}:secret:/citadel/datastores/*`,
        ],
      }),
    );

    // Grant IAM permissions for PolicyManager
    dataStoreResolverFunction.addToRolePolicy(
      new iam.PolicyStatement({
        effect: iam.Effect.ALLOW,
        actions: [
          "iam:CreateRole",
          "iam:DeleteRole",
          "iam:GetRole",
          "iam:PutRolePolicy",
          "iam:DeleteRolePolicy",
          "iam:TagRole",
          "iam:PassRole",
        ],
        resources: [`arn:aws:iam::${this.account}:role/citadel-ds-*`],
      }),
    );

    // Grant STS permissions for PolicyManager
    dataStoreResolverFunction.addToRolePolicy(
      new iam.PolicyStatement({
        effect: iam.Effect.ALLOW,
        actions: ["sts:AssumeRole"],
        resources: [`arn:aws:iam::${this.account}:role/citadel-ds-*`],
      }),
    );
    dataStoreResolverFunction.addToRolePolicy(
      new iam.PolicyStatement({
        effect: iam.Effect.ALLOW,
        actions: ["sts:GetCallerIdentity"],
        resources: ["*"],
      }),
    );

    // Grant SSM read for health monitor role ARN lookup
    dataStoreResolverFunction.addToRolePolicy(
      new iam.PolicyStatement({
        effect: iam.Effect.ALLOW,
        actions: ["ssm:GetParameter"],
        resources: [
          `arn:aws:ssm:${this.region}:${this.account}:parameter/citadel/health-monitor-role-${props.environment}`,
        ],
      }),
    );

    // Grant Bedrock permissions for Knowledge Base adapter (uses Lambda creds directly)
    dataStoreResolverFunction.addToRolePolicy(
      new iam.PolicyStatement({
        effect: iam.Effect.ALLOW,
        actions: [
          "bedrock:CreateKnowledgeBase",
          "bedrock:DeleteKnowledgeBase",
          "bedrock:GetKnowledgeBase",
          "bedrock:Retrieve",
          "bedrock:AssociateThirdPartyKnowledgeBase",
        ],
        resources: ["*"],
      }),
    );

    // Grant OpenSearch Serverless permissions for Knowledge Base vector store provisioning
    dataStoreResolverFunction.addToRolePolicy(
      new iam.PolicyStatement({
        effect: iam.Effect.ALLOW,
        actions: [
          "aoss:CreateCollection",
          "aoss:DeleteCollection",
          "aoss:BatchGetCollection",
          "aoss:CreateSecurityPolicy",
          "aoss:GetSecurityPolicy",
          "aoss:CreateAccessPolicy",
          "aoss:GetAccessPolicy",
          "aoss:APIAccessAll",
        ],
        resources: ["*"],
      }),
    );

    // DataStore AppSync data source and resolvers
    const dataStoreLambdaDataSource = this.appSyncApi.addLambdaDataSource(
      "DataStoreLambdaDataSource",
      dataStoreResolverFunction,
    );

    // Query resolvers (3)
    dataStoreLambdaDataSource.createResolver("ListDataStoresResolver", {
      typeName: "Query",
      fieldName: "listDataStores",
      requestMappingTemplate: appsync.MappingTemplate.lambdaRequest(),
      responseMappingTemplate: appsync.MappingTemplate.lambdaResult(),
    });

    dataStoreLambdaDataSource.createResolver("GetDataStoreResolver", {
      typeName: "Query",
      fieldName: "getDataStore",
      requestMappingTemplate: appsync.MappingTemplate.lambdaRequest(),
      responseMappingTemplate: appsync.MappingTemplate.lambdaResult(),
    });

    dataStoreLambdaDataSource.createResolver("GetDataStoreStatsResolver", {
      typeName: "Query",
      fieldName: "getDataStoreStats",
      requestMappingTemplate: appsync.MappingTemplate.lambdaRequest(),
      responseMappingTemplate: appsync.MappingTemplate.lambdaResult(),
    });

    // Mutation resolvers (7)
    dataStoreLambdaDataSource.createResolver("CreateDataStoreResolver", {
      typeName: "Mutation",
      fieldName: "createDataStore",
      requestMappingTemplate: appsync.MappingTemplate.lambdaRequest(),
      responseMappingTemplate: appsync.MappingTemplate.lambdaResult(),
    });

    dataStoreLambdaDataSource.createResolver("UpdateDataStoreResolver", {
      typeName: "Mutation",
      fieldName: "updateDataStore",
      requestMappingTemplate: appsync.MappingTemplate.lambdaRequest(),
      responseMappingTemplate: appsync.MappingTemplate.lambdaResult(),
    });

    dataStoreLambdaDataSource.createResolver("DeleteDataStoreResolver", {
      typeName: "Mutation",
      fieldName: "deleteDataStore",
      requestMappingTemplate: appsync.MappingTemplate.lambdaRequest(),
      responseMappingTemplate: appsync.MappingTemplate.lambdaResult(),
    });

    dataStoreLambdaDataSource.createResolver("ConnectDataStoreResolver", {
      typeName: "Mutation",
      fieldName: "connectDataStore",
      requestMappingTemplate: appsync.MappingTemplate.lambdaRequest(),
      responseMappingTemplate: appsync.MappingTemplate.lambdaResult(),
    });

    dataStoreLambdaDataSource.createResolver("DisconnectDataStoreResolver", {
      typeName: "Mutation",
      fieldName: "disconnectDataStore",
      requestMappingTemplate: appsync.MappingTemplate.lambdaRequest(),
      responseMappingTemplate: appsync.MappingTemplate.lambdaResult(),
    });

    dataStoreLambdaDataSource.createResolver(
      "TestDataStoreConnectionResolver",
      {
        typeName: "Mutation",
        fieldName: "testDataStoreConnection",
        requestMappingTemplate: appsync.MappingTemplate.lambdaRequest(),
        responseMappingTemplate: appsync.MappingTemplate.lambdaResult(),
      },
    );

    // Subscription resolvers (handled by AppSync automatically with proper schema)

    // --- Workflow, App, Execution AppSync Data Sources & Resolvers ---

    const workflowLambdaDataSource = this.appSyncApi.addLambdaDataSource(
      "WorkflowLambdaDataSource",
      workflowResolverFunction,
    );

    // NOTE: RegistryAgentRecordLambdaDataSource moved to CitadelRegistryStack
    // (backend-stack-split phase 2).

    const executionLambdaDataSource = this.appSyncApi.addLambdaDataSource(
      "ExecutionLambdaDataSource",
      executionResolverFunction,
    );

    // Workflow Resolver — Query resolvers
    workflowLambdaDataSource.createResolver("GetWorkflowResolver", {
      typeName: "Query",
      fieldName: "getWorkflow",
      requestMappingTemplate: appsync.MappingTemplate.lambdaRequest(),
      responseMappingTemplate: appsync.MappingTemplate.lambdaResult(),
    });

    workflowLambdaDataSource.createResolver("ListWorkflowsResolver", {
      typeName: "Query",
      fieldName: "listWorkflows",
      requestMappingTemplate: appsync.MappingTemplate.lambdaRequest(),
      responseMappingTemplate: appsync.MappingTemplate.lambdaResult(),
    });

    workflowLambdaDataSource.createResolver("ListBlueprintsResolver", {
      typeName: "Query",
      fieldName: "listBlueprints",
      requestMappingTemplate: appsync.MappingTemplate.lambdaRequest(),
      responseMappingTemplate: appsync.MappingTemplate.lambdaResult(),
    });

    workflowLambdaDataSource.createResolver("ExportWorkflowResolver", {
      typeName: "Query",
      fieldName: "exportWorkflow",
      requestMappingTemplate: appsync.MappingTemplate.lambdaRequest(),
      responseMappingTemplate: appsync.MappingTemplate.lambdaResult(),
    });

    workflowLambdaDataSource.createResolver("GetWorkflowVersionResolver", {
      typeName: "Query",
      fieldName: "getWorkflowVersion",
      requestMappingTemplate: appsync.MappingTemplate.lambdaRequest(),
      responseMappingTemplate: appsync.MappingTemplate.lambdaResult(),
    });

    workflowLambdaDataSource.createResolver("ListAppWorkflowsResolver", {
      typeName: "Query",
      fieldName: "listAppWorkflows",
      requestMappingTemplate: appsync.MappingTemplate.lambdaRequest(),
      responseMappingTemplate: appsync.MappingTemplate.lambdaResult(),
    });

    // Workflow Resolver — Mutation resolvers
    workflowLambdaDataSource.createResolver("CreateWorkflowResolver", {
      typeName: "Mutation",
      fieldName: "createWorkflow",
      requestMappingTemplate: appsync.MappingTemplate.lambdaRequest(),
      responseMappingTemplate: appsync.MappingTemplate.lambdaResult(),
    });

    workflowLambdaDataSource.createResolver("UpdateWorkflowResolver", {
      typeName: "Mutation",
      fieldName: "updateWorkflow",
      requestMappingTemplate: appsync.MappingTemplate.lambdaRequest(),
      responseMappingTemplate: appsync.MappingTemplate.lambdaResult(),
    });

    workflowLambdaDataSource.createResolver("DeleteWorkflowResolver", {
      typeName: "Mutation",
      fieldName: "deleteWorkflow",
      requestMappingTemplate: appsync.MappingTemplate.lambdaRequest(),
      responseMappingTemplate: appsync.MappingTemplate.lambdaResult(),
    });

    workflowLambdaDataSource.createResolver("PublishWorkflowResolver", {
      typeName: "Mutation",
      fieldName: "publishWorkflow",
      requestMappingTemplate: appsync.MappingTemplate.lambdaRequest(),
      responseMappingTemplate: appsync.MappingTemplate.lambdaResult(),
    });

    workflowLambdaDataSource.createResolver(
      "UpdateWorkflowConfigurationResolver",
      {
        typeName: "Mutation",
        fieldName: "updateWorkflowConfiguration",
        requestMappingTemplate: appsync.MappingTemplate.lambdaRequest(),
        responseMappingTemplate: appsync.MappingTemplate.lambdaResult(),
      },
    );

    workflowLambdaDataSource.createResolver("ImportBlueprintResolver", {
      typeName: "Mutation",
      fieldName: "importBlueprint",
      requestMappingTemplate: appsync.MappingTemplate.lambdaRequest(),
      responseMappingTemplate: appsync.MappingTemplate.lambdaResult(),
    });

    workflowLambdaDataSource.createResolver("ImportWorkflowResolver", {
      typeName: "Mutation",
      fieldName: "importWorkflow",
      requestMappingTemplate: appsync.MappingTemplate.lambdaRequest(),
      responseMappingTemplate: appsync.MappingTemplate.lambdaResult(),
    });
    // NOTE: App CRUD/API-key/access-control/metrics resolvers on
    // registryAgentRecordLambdaDataSource (28 fields) moved to
    // CitadelRegistryStack (backend-stack-split phase 2).

    // Execution Resolver — Query resolvers
    executionLambdaDataSource.createResolver("GetExecutionResolver", {
      typeName: "Query",
      fieldName: "getExecution",
      requestMappingTemplate: appsync.MappingTemplate.lambdaRequest(),
      responseMappingTemplate: appsync.MappingTemplate.lambdaResult(),
    });

    executionLambdaDataSource.createResolver("ListExecutionsResolver", {
      typeName: "Query",
      fieldName: "listExecutions",
      requestMappingTemplate: appsync.MappingTemplate.lambdaRequest(),
      responseMappingTemplate: appsync.MappingTemplate.lambdaResult(),
    });

    // Execution Resolver — Mutation resolvers
    executionLambdaDataSource.createResolver("StartExecutionResolver", {
      typeName: "Mutation",
      fieldName: "startExecution",
      requestMappingTemplate: appsync.MappingTemplate.lambdaRequest(),
      responseMappingTemplate: appsync.MappingTemplate.lambdaResult(),
    });

    executionLambdaDataSource.createResolver("CancelExecutionResolver", {
      typeName: "Mutation",
      fieldName: "cancelExecution",
      requestMappingTemplate: appsync.MappingTemplate.lambdaRequest(),
      responseMappingTemplate: appsync.MappingTemplate.lambdaResult(),
    });

    executionLambdaDataSource.createResolver("ResumeExecutionResolver", {
      typeName: "Mutation",
      fieldName: "resumeExecution",
      requestMappingTemplate: appsync.MappingTemplate.lambdaRequest(),
      responseMappingTemplate: appsync.MappingTemplate.lambdaResult(),
    });

    // publishWorkflowProgress — IAM-only mutation called by fan-out Lambda
    executionLambdaDataSource.createResolver(
      "PublishWorkflowProgressResolver",
      {
        typeName: "Mutation",
        fieldName: "publishWorkflowProgress",
        requestMappingTemplate: appsync.MappingTemplate.lambdaRequest(),
        responseMappingTemplate: appsync.MappingTemplate.lambdaResult(),
      },
    );

    // Outputs
    new cdk.CfnOutput(this, "GraphQLApiUrl", {
      value: this.appSyncApi.graphqlUrl,
      description: "GraphQL API URL",
    });

    // O-03: Enable X-Ray active tracing on all Lambda functions
    // O-02: Add Powertools structured logging env vars to all Lambda functions
    this.node.findAll().forEach((child) => {
      if (child instanceof lambda.Function) {
        child.addEnvironment("POWERTOOLS_LOG_LEVEL", "INFO");
        child.addEnvironment("POWERTOOLS_SERVICE_NAME", "citadel");
        (child as lambda.Function).addEnvironment(
          "AWS_LAMBDA_EXEC_WRAPPER",
          "",
        );
        const cfnFunction = child.node.defaultChild as lambda.CfnFunction;
        if (cfnFunction && !cfnFunction.tracingConfig) {
          cfnFunction.addPropertyOverride("TracingConfig", { Mode: "Active" });
        }
      }
    });

    // O-01: CloudWatch alarms for operational visibility
    this.alarmTopic = new sns.Topic(this, "AlarmTopic", {
      topicName: `citadel-alarms-${props.environment}`,
      displayName: "Citadel Alarms",
      enforceSSL: true,
    });

    // Lambda error alarms for critical functions
    // NOTE: ProjectResolver's alarms moved to CitadelProjectsStack along with
    // the function itself.
    const criticalFunctions = [
      { fn: agentMessageHandlerFunction, name: "AgentMessageHandler" },
      { fn: gatewayRegistrationHandler, name: "GatewayRegistration" },
      { fn: integrationResolverFunction, name: "IntegrationResolver" },
    ];

    for (const { fn, name } of criticalFunctions) {
      new cloudwatch.Alarm(this, `${name}ErrorAlarm`, {
        alarmName: `citadel-${name}-errors-${props.environment}`,
        metric: fn.metricErrors({ period: cdk.Duration.minutes(5) }),
        threshold: 5,
        evaluationPeriods: 1,
        comparisonOperator:
          cloudwatch.ComparisonOperator.GREATER_THAN_OR_EQUAL_TO_THRESHOLD,
        treatMissingData: cloudwatch.TreatMissingData.NOT_BREACHING,
        alarmDescription: `${name} Lambda error rate exceeded threshold`,
      }).addAlarmAction(new cw_actions.SnsAction(this.alarmTopic));

      new cloudwatch.Alarm(this, `${name}ThrottleAlarm`, {
        alarmName: `citadel-${name}-throttles-${props.environment}`,
        metric: fn.metricThrottles({ period: cdk.Duration.minutes(5) }),
        threshold: 3,
        evaluationPeriods: 1,
        comparisonOperator:
          cloudwatch.ComparisonOperator.GREATER_THAN_OR_EQUAL_TO_THRESHOLD,
        treatMissingData: cloudwatch.TreatMissingData.NOT_BREACHING,
        alarmDescription: `${name} Lambda throttle rate exceeded threshold`,
      }).addAlarmAction(new cw_actions.SnsAction(this.alarmTopic));
    }

    // DynamoDB throttle alarms for critical tables
    const criticalTables = [
      { table: this.projectsTable, name: "Projects" },
      { table: this.conversationsTable, name: "Conversations" },
      { table: this.agentConfigTable, name: "AgentConfig" },
      { table: integrationsTable, name: "Integrations" },
    ];

    for (const { table, name } of criticalTables) {
      new cloudwatch.Alarm(this, `${name}ReadThrottleAlarm`, {
        alarmName: `citadel-${name}-read-throttles-${props.environment}`,
        metric: table.metricThrottledRequestsForOperation("GetItem", {
          period: cdk.Duration.minutes(5),
        }),
        threshold: 5,
        evaluationPeriods: 2,
        comparisonOperator:
          cloudwatch.ComparisonOperator.GREATER_THAN_OR_EQUAL_TO_THRESHOLD,
        treatMissingData: cloudwatch.TreatMissingData.NOT_BREACHING,
        alarmDescription: `${name} DynamoDB read throttles exceeded threshold`,
      }).addAlarmAction(new cw_actions.SnsAction(this.alarmTopic));
    }

    // AppSync 4xx/5xx alarms
    new cloudwatch.Alarm(this, "AppSync4xxAlarm", {
      alarmName: `citadel-appsync-4xx-${props.environment}`,
      metric: new cloudwatch.Metric({
        namespace: "AWS/AppSync",
        metricName: "4XXError",
        dimensionsMap: { GraphQLAPIId: this.appSyncApi.apiId },
        period: cdk.Duration.minutes(5),
        statistic: "Sum",
      }),
      threshold: 50,
      evaluationPeriods: 2,
      comparisonOperator:
        cloudwatch.ComparisonOperator.GREATER_THAN_OR_EQUAL_TO_THRESHOLD,
      treatMissingData: cloudwatch.TreatMissingData.NOT_BREACHING,
      alarmDescription: "AppSync 4xx error rate exceeded threshold",
    }).addAlarmAction(new cw_actions.SnsAction(this.alarmTopic));

    // Wire the earlier-declared fan-out publish-failure alarm to the topic
    // now that the topic exists (the alarm is constructed near the workflow
    // fan-out Lambda, well before this O-01 block).
    workflowProgressFanoutFailureAlarm.addAlarmAction(
      new cw_actions.SnsAction(this.alarmTopic),
    );

    // Configurable external destination (email | slack | none) for the
    // shared alarm topic. `citadel-alarms-<env>` is NOT CMK-encrypted (no
    // masterKey on the Topic above), so no KMS grant is required here — only
    // the CMK-encrypted escalation topic in ArbiterStack needs that. The
    // unconfigured case is env-scoped: throws for staging/prod, no-op for
    // dev/test/CI (see alarm-delivery.ts).
    attachAlarmDelivery(this, {
      config: props.alarmDelivery ?? { mode: "none" },
      environment: props.environment,
      topics: [{ topic: this.alarmTopic, nameHint: "backend" }],
    });

    // AppSync 5xx alarm intentionally removed from here — TelemetryStack's
    // "AppSync5xxAlarm" (platform-health SLO suite, decision ab73ae1b) owns
    // the physical name `citadel-appsync-5xx-${env}` going forward. Both
    // stacks defined the identical alarmName, which AWS::EarlyValidation::
    // ResourceExistenceCheck rejects on whichever stack's changeset deploys
    // second (see backend/test/duplicate-alarm-name-guard.test.ts). Deploy
    // order is backend -> telemetry, so backend deletes its copy and
    // telemetry recreates it within the same pipeline run; telemetry's
    // definition is a strict superset (SNS alarm action via
    // props.alarmTopic, tighter threshold/description) so no monitoring
    // capability is lost, only a brief (single-deploy-run) alarm gap.

    new cdk.CfnOutput(this, "GraphQLApiId", {
      value: this.appSyncApi.apiId,
      description: "GraphQL API ID",
    });

    new cdk.CfnOutput(this, "UserPoolId", {
      value: this.userPool.userPoolId,
      description: "Cognito User Pool ID",
    });

    new cdk.CfnOutput(this, "UserPoolClientId", {
      value: this.userPoolClient.userPoolClientId,
      description: "Cognito User Pool Client ID",
    });

    // Export outputs for cross-stack references
    new cdk.CfnOutput(this, "GraphQLApiUrlExport", {
      value: this.appSyncApi.graphqlUrl,
      exportName: `${this.stackName}-GraphQLApiUrl`,
    });

    new cdk.CfnOutput(this, "UserPoolIdExport", {
      value: this.userPool.userPoolId,
      exportName: `${this.stackName}-UserPoolId`,
    });

    new cdk.CfnOutput(this, "UserPoolClientIdExport", {
      value: this.userPoolClient.userPoolClientId,
      exportName: `${this.stackName}-UserPoolClientId`,
    });

    new cdk.CfnOutput(this, "AgentMessageHandlerFunctionArn", {
      value: agentMessageHandlerFunction.functionArn,
      description: "Agent Message Handler Lambda Function ARN",
    });

    new cdk.CfnOutput(this, "EventBusName", {
      value: this.agentEventBus.eventBusName,
      description: "EventBridge Event Bus Name",
      exportName: `${this.stackName}-EventBusName`,
    });

    // ============================================================
    // Governance DynamoDB Tables
    // ============================================================
    //
    // These 6 governance tables stay in BackendStack because they are
    // RETAIN + deletionProtection=true; moving them would trigger CFN-level
    // replace. The governance Lambdas, AppSync data sources, resolvers, SSM
    // flags, KMS key, S3 transcripts bucket, and EventBridge notifier rule
    // live in GovernanceStack (backend/lib/governance-stack.ts) and consume
    // these tables via props, producing auto-generated cross-stack Exports.

    // ADRs
    this.adrsTable = new dynamodb.Table(this, "ADRsTable", {
      tableName: `citadel-adrs-${props.environment}`,
      partitionKey: { name: "adrId", type: dynamodb.AttributeType.STRING },
      billingMode: dynamodb.BillingMode.PAY_PER_REQUEST,
      removalPolicy: cdk.RemovalPolicy.RETAIN,
      deletionProtection: true,
      pointInTimeRecoverySpecification: { pointInTimeRecoveryEnabled: true },
    });
    this.adrsTable.addGlobalSecondaryIndex({
      indexName: "project-index",
      partitionKey: { name: "projectId", type: dynamodb.AttributeType.STRING },
      sortKey: { name: "createdAt", type: dynamodb.AttributeType.STRING },
      projectionType: dynamodb.ProjectionType.ALL,
    });

    // ADR Reopen Attempts (append-only audit log)
    this.adrReopenAttemptsTable = new dynamodb.Table(
      this,
      "ADRReopenAttemptsTable",
      {
        tableName: `citadel-adr-reopen-attempts-${props.environment}`,
        partitionKey: {
          name: "attemptId",
          type: dynamodb.AttributeType.STRING,
        },
        billingMode: dynamodb.BillingMode.PAY_PER_REQUEST,
        removalPolicy: cdk.RemovalPolicy.RETAIN,
        deletionProtection: true,
        pointInTimeRecoverySpecification: { pointInTimeRecoveryEnabled: true },
      },
    );
    this.adrReopenAttemptsTable.addGlobalSecondaryIndex({
      indexName: "adr-index",
      partitionKey: { name: "adrId", type: dynamodb.AttributeType.STRING },
      sortKey: { name: "attemptedAt", type: dynamodb.AttributeType.STRING },
      projectionType: dynamodb.ProjectionType.ALL,
    });

    // ExecutionSpecifications — also consumed by ArbiterStack
    // (worker + fabricator) for dispatch-time spec-status validation.
    this.executionSpecificationsTable = new dynamodb.Table(
      this,
      "ExecutionSpecificationsTable",
      {
        tableName: `citadel-execution-specifications-${props.environment}`,
        partitionKey: { name: "specId", type: dynamodb.AttributeType.STRING },
        billingMode: dynamodb.BillingMode.PAY_PER_REQUEST,
        removalPolicy: cdk.RemovalPolicy.RETAIN,
        deletionProtection: true,
        pointInTimeRecoverySpecification: { pointInTimeRecoveryEnabled: true },
      },
    );
    this.executionSpecificationsTable.addGlobalSecondaryIndex({
      indexName: "project-index",
      partitionKey: { name: "projectId", type: dynamodb.AttributeType.STRING },
      sortKey: { name: "createdAt", type: dynamodb.AttributeType.STRING },
      projectionType: dynamodb.ProjectionType.ALL,
    });

    // EvalSuites (CIT-101) — release evidence, governed like
    // ExecutionSpecifications: RETAIN + deletionProtection + PITR. Simple
    // PK (suiteId) mirrors ExecutionSpecificationsTable. Two GSIs:
    // org-index (org-scoped listing, mirrors the org-scoped list
    // convention in datastore-resolver/integration-resolver) and
    // agent-target-index ("list suites for this agent/template target").
    this.evalSuitesTable = new dynamodb.Table(this, "EvalSuitesTable", {
      tableName: `citadel-eval-suites-${props.environment}`,
      partitionKey: { name: "suiteId", type: dynamodb.AttributeType.STRING },
      billingMode: dynamodb.BillingMode.PAY_PER_REQUEST,
      removalPolicy: cdk.RemovalPolicy.RETAIN,
      deletionProtection: true,
      pointInTimeRecoverySpecification: { pointInTimeRecoveryEnabled: true },
    });
    this.evalSuitesTable.addGlobalSecondaryIndex({
      indexName: "org-index",
      partitionKey: { name: "orgId", type: dynamodb.AttributeType.STRING },
      sortKey: { name: "updatedAt", type: dynamodb.AttributeType.STRING },
      projectionType: dynamodb.ProjectionType.ALL,
    });
    this.evalSuitesTable.addGlobalSecondaryIndex({
      indexName: "agent-target-index",
      partitionKey: {
        name: "agentTargetId",
        type: dynamodb.AttributeType.STRING,
      },
      sortKey: { name: "updatedAt", type: dynamodb.AttributeType.STRING },
      projectionType: dynamodb.ProjectionType.ALL,
    });

    // EvalCases (CIT-101) — composite PK (suiteId) / SK (caseId) so all
    // cases of a suite are a single Query, and a case is addressable by
    // {suiteId, caseId}. Same governance posture as EvalSuitesTable. No GSI
    // in v1 — cases are always accessed via their parent suiteId.
    this.evalCasesTable = new dynamodb.Table(this, "EvalCasesTable", {
      tableName: `citadel-eval-cases-${props.environment}`,
      partitionKey: { name: "suiteId", type: dynamodb.AttributeType.STRING },
      sortKey: { name: "caseId", type: dynamodb.AttributeType.STRING },
      billingMode: dynamodb.BillingMode.PAY_PER_REQUEST,
      removalPolicy: cdk.RemovalPolicy.RETAIN,
      deletionProtection: true,
      pointInTimeRecoverySpecification: { pointInTimeRecoveryEnabled: true },
    });

    // Seed Eval Suites Custom Resource (CIT-101) — deploy-time demo data:
    // Suite A (intake-agent) + Suite B (template:monolithic_db), each with
    // >=1 expected-DENY case, landing DRAFT so the app can demo freeze.
    // Placed here (rather than alongside SeedBlueprints earlier in the
    // constructor) because it needs evalSuitesTable/evalCasesTable, which
    // are defined immediately above.
    const seedEvalSuitesLambda = new lambda.Function(
      this,
      "SeedEvalSuitesFunction",
      {
        runtime: lambda.Runtime.NODEJS_24_X,
        handler: "seed-eval-suites/index.handler",
        code: lambda.Code.fromAsset("dist/lambda"),
        timeout: cdk.Duration.seconds(30),
        environment: {
          EVAL_SUITES_TABLE: this.evalSuitesTable.tableName,
          EVAL_CASES_TABLE: this.evalCasesTable.tableName,
        },
        logGroup: new logs.LogGroup(this, "SeedEvalSuitesFunctionLogs", {
          retention: logs.RetentionDays.ONE_WEEK,
          removalPolicy: cdk.RemovalPolicy.DESTROY,
        }),
      },
    );

    this.evalSuitesTable.grantWriteData(seedEvalSuitesLambda);
    this.evalCasesTable.grantWriteData(seedEvalSuitesLambda);

    const seedEvalSuitesResource = new cdk.CustomResource(
      this,
      "SeedEvalSuitesResource",
      {
        serviceToken: seedEvalSuitesLambda.functionArn,
        properties: {
          Version: "v1.0.0",
        },
      },
    );

    seedEvalSuitesResource.node.addDependency(this.evalSuitesTable);
    seedEvalSuitesResource.node.addDependency(this.evalCasesTable);

    // EvalRuns (CIT-102) — release evidence that agentVersion X was
    // validated against suiteVersion Y; consumed by E11 release gating
    // (CIT-105/111). RETAIN + deletionProtection + PITR, NO TTL — same
    // posture as EvalSuites/EvalCases (this is the OPPOSITE of
    // FabricationJobsTable's ephemeral DESTROY+TTL working-doc posture).
    // Simple PK (evalRunId). Two GSIs: org-index ("all runs for this org",
    // mirrors EvalSuites' org-index) and suite-index ("all runs for this
    // suite", E11/CIT-105).
    this.evalRunsTable = new dynamodb.Table(this, "EvalRunsTable", {
      tableName: `citadel-eval-runs-${props.environment}`,
      partitionKey: { name: "evalRunId", type: dynamodb.AttributeType.STRING },
      billingMode: dynamodb.BillingMode.PAY_PER_REQUEST,
      removalPolicy: cdk.RemovalPolicy.RETAIN,
      deletionProtection: true,
      pointInTimeRecoverySpecification: { pointInTimeRecoveryEnabled: true },
    });
    this.evalRunsTable.addGlobalSecondaryIndex({
      indexName: "org-index",
      partitionKey: { name: "orgId", type: dynamodb.AttributeType.STRING },
      sortKey: { name: "startedAt", type: dynamodb.AttributeType.STRING },
      projectionType: dynamodb.ProjectionType.ALL,
    });
    this.evalRunsTable.addGlobalSecondaryIndex({
      indexName: "suite-index",
      partitionKey: { name: "suiteId", type: dynamodb.AttributeType.STRING },
      sortKey: { name: "startedAt", type: dynamodb.AttributeType.STRING },
      projectionType: dynamodb.ProjectionType.ALL,
    });

    // EvalRunCaseResults (CIT-102) — composite PK (evalRunId) / SK (caseId)
    // so every case-result of a run is a single Query (InterrogationRounds
    // shape). Same RETAIN + deletionProtection + PITR posture. No GSI in
    // v1 — always accessed via the parent evalRunId. Holds outcome/dispatch
    // facts only (no scores — CIT-103 owns verdicts).
    this.evalRunCaseResultsTable = new dynamodb.Table(
      this,
      "EvalRunCaseResultsTable",
      {
        tableName: `citadel-eval-run-case-results-${props.environment}`,
        partitionKey: {
          name: "evalRunId",
          type: dynamodb.AttributeType.STRING,
        },
        sortKey: { name: "caseId", type: dynamodb.AttributeType.STRING },
        billingMode: dynamodb.BillingMode.PAY_PER_REQUEST,
        removalPolicy: cdk.RemovalPolicy.RETAIN,
        deletionProtection: true,
        pointInTimeRecoverySpecification: { pointInTimeRecoveryEnabled: true },
      },
    );

    // AgentReleases (slice 1) — content-addressed, immutable release
    // bundle. Simple PK (releaseId = sha256 content hash, computed by
    // release-hash.ts — see release-store.ts, the sole writer). Same
    // RETAIN + deletionProtection + PITR posture as EvalRunsTable/
    // EvalRunCaseResultsTable directly above, since this table's eval
    // evidence fields are pointers into those exact tables. One GSI
    // (org-index) mirrors EvalRunsTable's org-scoped listing convention.
    // NO update/delete IAM is granted on this table to any principal —
    // see the narrow addToRolePolicy grant below (Put/Get/Query only),
    // the layer EvalSuites/EvalRuns lacked at first ship.
    this.agentReleasesTable = new dynamodb.Table(this, "AgentReleasesTable", {
      tableName: `citadel-agent-releases-${props.environment}`,
      partitionKey: {
        name: "releaseId",
        type: dynamodb.AttributeType.STRING,
      },
      billingMode: dynamodb.BillingMode.PAY_PER_REQUEST,
      removalPolicy: cdk.RemovalPolicy.RETAIN,
      deletionProtection: true,
      pointInTimeRecoverySpecification: { pointInTimeRecoveryEnabled: true },
    });
    this.agentReleasesTable.addGlobalSecondaryIndex({
      indexName: "org-index",
      partitionKey: { name: "orgId", type: dynamodb.AttributeType.STRING },
      sortKey: { name: "createdAt", type: dynamodb.AttributeType.STRING },
      projectionType: dynamodb.ProjectionType.ALL,
    });

    // IAM floor (design §2, L3) — the layer EvalSuites/EvalRuns lacked at
    // first ship (the bypass incident: a seed writer's role held
    // UpdateItem/PutItem). This role is the ONLY principal granted write
    // access to AgentReleasesTable, and it carries PutItem + GetItem +
    // Query ONLY — no UpdateItem, no DeleteItem, granted here or anywhere
    // else. Slice 2's cut-release Lambda (release-resolver.ts, deferred)
    // assumes this role rather than being granted broader
    // grantReadWriteData; any future consumer needing read-only access
    // must be granted a SEPARATE, narrower Query/GetItem-only statement,
    // never this role.
    const agentReleaseWriterRole = new iam.Role(
      this,
      "AgentReleaseWriterRole",
      {
        assumedBy: new iam.ServicePrincipal("lambda.amazonaws.com"),
      },
    );
    agentReleaseWriterRole.addToPolicy(
      new iam.PolicyStatement({
        effect: iam.Effect.ALLOW,
        actions: ["dynamodb:PutItem", "dynamodb:GetItem", "dynamodb:Query"],
        resources: [
          this.agentReleasesTable.tableArn,
          `${this.agentReleasesTable.tableArn}/index/*`,
        ],
      }),
    );
    this.agentReleaseWriterRole = agentReleaseWriterRole;

    // Environment release pointer — MUTABLE cursor, deliberately the
    // opposite governance posture from AgentReleasesTable's immutability.
    // PK orgId, SK `agentTargetId_environment` (composite, mirroring
    // EvalBaselinesTable's `agentTargetId_suiteId` sort-key convention)
    // so a point-get is exact for one (agent, environment) and a Query on
    // orgId + begins_with(agentTargetId_environment, `${agentTargetId}#`)
    // lists every environment's pointer for one agent. Still RETAIN +
    // deletionProtection + PITR: even though the row's CONTENT changes on
    // every promotion, the row's non-existence-to-existence-to-history is
    // itself deployment history that must survive stack updates and be
    // recoverable — mutability of content is not a reason to relax
    // durability of the table.
    this.environmentReleasePointersTable = new dynamodb.Table(
      this,
      "EnvironmentReleasePointersTable",
      {
        tableName: `citadel-environment-release-pointers-${props.environment}`,
        partitionKey: { name: "orgId", type: dynamodb.AttributeType.STRING },
        sortKey: {
          name: "agentTargetId_environment",
          type: dynamodb.AttributeType.STRING,
        },
        billingMode: dynamodb.BillingMode.PAY_PER_REQUEST,
        removalPolicy: cdk.RemovalPolicy.RETAIN,
        deletionProtection: true,
        pointInTimeRecoverySpecification: { pointInTimeRecoveryEnabled: true },
      },
    );

    // Sparse ActiveCanaryIndex GSI (decision D8) — the auto-rollback
    // evaluator enumerates active canaries via this index instead of a
    // Scan. The marker attributes (activeCanaryPk / activeCanarySk) are
    // written by the sole pointer writer ONLY when a canary is present
    // (environment-release-pointer-store.ts), so a pointer with no canary
    // is absent from the index; clearing the canary (promote/abort)
    // overwrites the item without the marker in the SAME atomic Put,
    // removing it from the index. Projection ALL so the evaluator reads a
    // full pointer (version/releaseId/canary) without a second GetItem.
    // NOTE (runbook): this is a sparse marker maintained going forward —
    // canaries already active at deploy time have no marker until their
    // next pointer write; a deploy-time backfill gap is documented in
    // docs/RELEASE_RUNBOOK.md.
    this.environmentReleasePointersTable.addGlobalSecondaryIndex({
      indexName: "ActiveCanaryIndex",
      partitionKey: {
        name: "activeCanaryPk",
        type: dynamodb.AttributeType.STRING,
      },
      sortKey: { name: "activeCanarySk", type: dynamodb.AttributeType.STRING },
      projectionType: dynamodb.ProjectionType.ALL,
    });
    // ONLY, granted against ONLY this table's ARN + index ARNs — never
    // co-listed as a resource alongside AgentReleasesTable in the same
    // statement, and never DeleteItem, anywhere. There is no UpdateItem
    // grant either: the pointer's "move" operation is a conditional Put
    // (environment-release-pointer-store.ts), not an UpdateCommand, so
    // PutItem is the only write action this role needs.
    const environmentReleasePointerWriterRole = new iam.Role(
      this,
      "EnvironmentReleasePointerWriterRole",
      {
        assumedBy: new iam.ServicePrincipal("lambda.amazonaws.com"),
      },
    );
    environmentReleasePointerWriterRole.addToPolicy(
      new iam.PolicyStatement({
        effect: iam.Effect.ALLOW,
        actions: ["dynamodb:PutItem", "dynamodb:GetItem", "dynamodb:Query"],
        resources: [
          this.environmentReleasePointersTable.tableArn,
          `${this.environmentReleasePointersTable.tableArn}/index/*`,
        ],
      }),
    );

    // Finding 23971f32 (fail-closed ledger recording): this role also
    // backs environment-release-pointer-resolver.ts, which writes a
    // GovernanceFinding row (release-gate-finding-writer.ts) into
    // GOVERNANCE_LEDGER_TABLE BEFORE the pointer moves — in both shadow
    // and strict mode, per the USER DECISION that recording is
    // fail-closed regardless of mode. That table (governanceLedgerTable)
    // is owned by ArbiterStack, which is instantiated AFTER BackendStack
    // in bin/app.ts (arbiter depends on backend via ServicesStack), so a
    // construct reference here is impossible without a cyclic stack
    // dependency. Referenced instead by deterministic ARN STRING — same
    // no-cross-ref convention as agentCodeResolverFunction's S3 grant in
    // registry-stack.ts and the FabricationJobsTable grants throughout
    // this file — built from the SAME `citadel-governance-ledger-
    // ${environment}` name arbiter-stack.ts uses to construct the table.
    // Explicit dynamodb:PutItem-only PolicyStatement, deliberately NOT
    // grantWriteData: grantWriteData also confers UpdateItem/DeleteItem/
    // BatchWriteItem, a widening rejected twice in prior work on this
    // exact role (see the PutItem-only rationale on this role's
    // construction site above). This writer only ever issues PutCommand
    // (release-gate-finding-writer.ts) — no other action is needed.
    const governanceLedgerTableArn = `arn:aws:dynamodb:${this.region}:${this.account}:table/citadel-governance-ledger-${props.environment}`;
    environmentReleasePointerWriterRole.addToPolicy(
      new iam.PolicyStatement({
        effect: iam.Effect.ALLOW,
        actions: ["dynamodb:PutItem"],
        resources: [governanceLedgerTableArn],
      }),
    );

    // G6 — atomic promotion history. The pointer move + append-only
    // history row are written in ONE TransactWriteItems by the sole
    // pointer writer (environment-release-pointer-store.ts), so this role
    // needs PutItem on the history table for the transactional write,
    // plus GetItem/Query for the read-only history query
    // (environment-release-pointer-history-store.ts). The history table
    // is provisioned in governance-stack.ts, instantiated AFTER
    // BackendStack, so — like the GOVERNANCE_LEDGER grant above — it is
    // referenced by deterministic ARN STRING rather than a construct,
    // avoiding a cyclic stack dependency. PutItem/GetItem/Query only,
    // never DeleteItem/UpdateItem — the history table is append-only.
    const environmentReleasePointerHistoryTableArn = `arn:aws:dynamodb:${this.region}:${this.account}:table/citadel-environment-release-pointer-history-${props.environment}`;
    environmentReleasePointerWriterRole.addToPolicy(
      new iam.PolicyStatement({
        effect: iam.Effect.ALLOW,
        actions: ["dynamodb:PutItem", "dynamodb:GetItem", "dynamodb:Query"],
        resources: [environmentReleasePointerHistoryTableArn],
      }),
    );

    // G5 — best-effort RELEASE_POINTER_MOVED emit (post-commit). The
    // promotion resolver publishes to the shared bus via publishEvent;
    // granted here on the sole-writer role rather than in governance-
    // stack.ts to keep every grant for this role co-located and
    // cross-stack-cycle-free (agentEventBus is BackendStack-owned).
    this.agentEventBus.grantPutEventsTo(environmentReleasePointerWriterRole);

    this.environmentReleasePointerWriterRole =
      environmentReleasePointerWriterRole;

    // Phase 2 (production sampling) — EvalSamplingConfig: admin-authored,
    // one row per org (PK=orgId). Small config table, DESTROY on stack
    // teardown is acceptable (re-authored on next admin write, no
    // historical value once superseded) — deliberately NOT RETAIN/
    // deletionProtection like the release-evidence eval tables above.
    this.evalSamplingConfigTable = new dynamodb.Table(
      this,
      "EvalSamplingConfigTable",
      {
        tableName: `citadel-eval-sampling-config-${props.environment}`,
        partitionKey: { name: "orgId", type: dynamodb.AttributeType.STRING },
        billingMode: dynamodb.BillingMode.PAY_PER_REQUEST,
        removalPolicy: cdk.RemovalPolicy.DESTROY,
        pointInTimeRecoverySpecification: { pointInTimeRecoveryEnabled: true },
      },
    );

    // Decision ada70113 — PromotionPolicyConfig: admin-authored, one row
    // per org (PK=orgId). Same small-config-table posture as
    // EvalSamplingConfigTable above.
    this.promotionPolicyConfigTable = new dynamodb.Table(
      this,
      "PromotionPolicyConfigTable",
      {
        tableName: `citadel-promotion-policy-config-${props.environment}`,
        partitionKey: { name: "orgId", type: dynamodb.AttributeType.STRING },
        billingMode: dynamodb.BillingMode.PAY_PER_REQUEST,
        removalPolicy: cdk.RemovalPolicy.DESTROY,
        pointInTimeRecoverySpecification: { pointInTimeRecoveryEnabled: true },
      },
    );

    // Writer role — promotion-policy-resolver.ts's admin
    // getPromotionPolicy/setPromotionPolicy needs GetItem+PutItem only.
    // Explicit PolicyStatement, deliberately NOT grantWriteData (which
    // would also confer UpdateItem/DeleteItem/BatchWriteItem — a wider
    // floor than this resolver's own two DDB commands ever issue).
    const promotionPolicyConfigWriterRole = new iam.Role(
      this,
      "PromotionPolicyConfigWriterRole",
      {
        assumedBy: new iam.ServicePrincipal("lambda.amazonaws.com"),
      },
    );
    promotionPolicyConfigWriterRole.addToPolicy(
      new iam.PolicyStatement({
        effect: iam.Effect.ALLOW,
        actions: ["dynamodb:GetItem", "dynamodb:PutItem"],
        resources: [this.promotionPolicyConfigTable.tableArn],
      }),
    );
    this.promotionPolicyConfigWriterRole = promotionPolicyConfigWriterRole;

    // Read-only grant for the PROMOTION GATE itself
    // (environment-release-pointer-resolver.ts's validateReleaseGate,
    // via promotion-policy-store.ts's resolvePromotionPolicy). A Lambda
    // has exactly one execution role, and that function already assumes
    // environmentReleasePointerWriterRole (constructed above) — so this
    // is an ADDITIONAL scoped GetItem-only statement on that SAME role,
    // never a second role the function couldn't actually use. Mirrors
    // that role's existing narrow AgentReleasesTable GetItem grant
    // (added in governance-stack.ts directly on the resolver function,
    // which resolves to the same role) — GetItem only, no PutItem: the
    // promotion gate must never be able to author policy, only read it.
    environmentReleasePointerWriterRole.addToPolicy(
      new iam.PolicyStatement({
        effect: iam.Effect.ALLOW,
        actions: ["dynamodb:GetItem"],
        resources: [this.promotionPolicyConfigTable.tableArn],
      }),
    );

    // EvalBaselines (CIT-105) — mutable (orgId, agentTargetId, suiteId)
    // baseline designation pointer, re-baselined on promotion (design §3).
    // PK orgId, SK `${agentTargetId}#${suiteId}` so a point-get is exact
    // and a Query on orgId lists every baseline for that org. RETAIN +
    // deletionProtection + PITR — an evidence-adjacent governance record
    // (which run was designated the release baseline, and when), same
    // posture as EvalRunsTable.
    this.evalBaselinesTable = new dynamodb.Table(this, "EvalBaselinesTable", {
      tableName: `citadel-eval-baselines-${props.environment}`,
      partitionKey: { name: "orgId", type: dynamodb.AttributeType.STRING },
      sortKey: {
        name: "agentTargetId_suiteId",
        type: dynamodb.AttributeType.STRING,
      },
      billingMode: dynamodb.BillingMode.PAY_PER_REQUEST,
      removalPolicy: cdk.RemovalPolicy.RETAIN,
      deletionProtection: true,
      pointInTimeRecoverySpecification: { pointInTimeRecoveryEnabled: true },
    });

    // EvalComparisons (CIT-105) — computed baseline-vs-candidate-cohort
    // regression verdicts, release evidence (design §3). Simple PK
    // (comparisonId) with two GSIs mirroring EvalRunsTable's shape exactly:
    // org-index (org-scoped listing) + suite-index (all comparisons for a
    // suite). RETAIN + deletionProtection + PITR.
    this.evalComparisonsTable = new dynamodb.Table(
      this,
      "EvalComparisonsTable",
      {
        tableName: `citadel-eval-comparisons-${props.environment}`,
        partitionKey: {
          name: "comparisonId",
          type: dynamodb.AttributeType.STRING,
        },
        billingMode: dynamodb.BillingMode.PAY_PER_REQUEST,
        removalPolicy: cdk.RemovalPolicy.RETAIN,
        deletionProtection: true,
        pointInTimeRecoverySpecification: { pointInTimeRecoveryEnabled: true },
      },
    );
    this.evalComparisonsTable.addGlobalSecondaryIndex({
      indexName: "org-index",
      partitionKey: { name: "orgId", type: dynamodb.AttributeType.STRING },
      sortKey: { name: "createdAt", type: dynamodb.AttributeType.STRING },
      projectionType: dynamodb.ProjectionType.ALL,
    });
    this.evalComparisonsTable.addGlobalSecondaryIndex({
      indexName: "suite-index",
      partitionKey: { name: "suiteId", type: dynamodb.AttributeType.STRING },
      sortKey: { name: "createdAt", type: dynamodb.AttributeType.STRING },
      projectionType: dynamodb.ProjectionType.ALL,
    });

    // EvalComparisonConfig (CIT-105) — admin-authored threshold config
    // source of truth (design §4). PK orgId, SK suiteId (SK sentinel
    // `__default__` = org-wide default row). Small config table, DESTROY
    // on stack teardown is acceptable (re-authored on next admin write,
    // hardcoded DEFAULT_COMPARISON_THRESHOLDS always available in code) —
    // same posture as EvalSamplingConfigTable, deliberately NOT RETAIN/
    // deletionProtection like the release-evidence eval tables above.
    this.evalComparisonConfigTable = new dynamodb.Table(
      this,
      "EvalComparisonConfigTable",
      {
        tableName: `citadel-eval-comparison-config-${props.environment}`,
        partitionKey: { name: "orgId", type: dynamodb.AttributeType.STRING },
        sortKey: { name: "suiteId", type: dynamodb.AttributeType.STRING },
        billingMode: dynamodb.BillingMode.PAY_PER_REQUEST,
        removalPolicy: cdk.RemovalPolicy.DESTROY,
        pointInTimeRecoverySpecification: { pointInTimeRecoveryEnabled: true },
      },
    );

    // Phase 2 (production sampling) — EvalProdSamples: captured + scored
    // production samples. PK=PK (ORG#<orgId>), SK=<capturedAt>#<sampleId>
    // so a per-org time-range read is a plain Query. Sparse GSI1
    // (AgentDimTimeIndex naming carried at the attribute level —
    // GSI1PK=AGENT#<agentId>, GSI1SK=<hourBucket>#<sampleId>) makes a
    // per-agent time series a Query too, never a Scan (design §2.4
    // acceptance #1 substrate). RETAIN — this is an audit/observability
    // record of what was actually sampled and judged, same posture
    // rationale as EvalRunsTable (release evidence), not ephemeral
    // working data.
    this.evalProdSamplesTable = new dynamodb.Table(
      this,
      "EvalProdSamplesTable",
      {
        tableName: `citadel-eval-prod-samples-${props.environment}`,
        partitionKey: { name: "PK", type: dynamodb.AttributeType.STRING },
        sortKey: { name: "SK", type: dynamodb.AttributeType.STRING },
        billingMode: dynamodb.BillingMode.PAY_PER_REQUEST,
        removalPolicy: cdk.RemovalPolicy.RETAIN,
        deletionProtection: true,
        pointInTimeRecoverySpecification: { pointInTimeRecoveryEnabled: true },
      },
    );
    this.evalProdSamplesTable.addGlobalSecondaryIndex({
      indexName: "AgentDimTimeIndex",
      partitionKey: { name: "GSI1PK", type: dynamodb.AttributeType.STRING },
      sortKey: { name: "GSI1SK", type: dynamodb.AttributeType.STRING },
      projectionType: dynamodb.ProjectionType.ALL,
    });
    // B1 fix (taskId 316427f2, CRITICAL): a judged event (frozen
    // judge.requested/judged contract) carries only evalRunId/caseId/
    // orgId — never capturedAt, which is embedded in this table's real
    // SK. A point Get on {orgId, runId} does not match this table's key
    // schema (PK/SK) at all and previously threw ValidationException in
    // production (masked by aws-sdk-client-mock in tests). This sparse
    // GSI makes the judged-event correlation ref (caseId, set to the
    // sample's own sampleId by the "prod-sample carrier convention",
    // EVENTBRIDGE_CATALOG.md) a plain Query — NEVER a Scan.
    this.evalProdSamplesTable.addGlobalSecondaryIndex({
      indexName: "SampleIdIndex",
      partitionKey: { name: "sampleId", type: dynamodb.AttributeType.STRING },
      projectionType: dynamodb.ProjectionType.ALL,
    });

    // InterrogationRounds
    this.interrogationRoundsTable = new dynamodb.Table(
      this,
      "InterrogationRoundsTable",
      {
        tableName: `citadel-interrogation-rounds-${props.environment}`,
        partitionKey: {
          name: "projectId",
          type: dynamodb.AttributeType.STRING,
        },
        sortKey: { name: "roundN", type: dynamodb.AttributeType.NUMBER },
        billingMode: dynamodb.BillingMode.PAY_PER_REQUEST,
        removalPolicy: cdk.RemovalPolicy.RETAIN,
        deletionProtection: true,
        pointInTimeRecoverySpecification: { pointInTimeRecoveryEnabled: true },
      },
    );

    // AgentDesignAssessments
    this.agentDesignAssessmentsTable = new dynamodb.Table(
      this,
      "AgentDesignAssessmentsTable",
      {
        tableName: `citadel-agent-design-assessments-${props.environment}`,
        partitionKey: {
          name: "projectId",
          type: dynamodb.AttributeType.STRING,
        },
        billingMode: dynamodb.BillingMode.PAY_PER_REQUEST,
        removalPolicy: cdk.RemovalPolicy.RETAIN,
        deletionProtection: true,
        pointInTimeRecoverySpecification: { pointInTimeRecoveryEnabled: true },
      },
    );

    // ProgramReviews (Δ12)
    this.programReviewsTable = new dynamodb.Table(this, "ProgramReviewsTable", {
      tableName: `citadel-program-reviews-${props.environment}`,
      partitionKey: { name: "reviewId", type: dynamodb.AttributeType.STRING },
      billingMode: dynamodb.BillingMode.PAY_PER_REQUEST,
      removalPolicy: cdk.RemovalPolicy.RETAIN,
      deletionProtection: true,
      pointInTimeRecoverySpecification: { pointInTimeRecoveryEnabled: true },
    });
    this.programReviewsTable.addGlobalSecondaryIndex({
      indexName: "project-index",
      partitionKey: { name: "projectId", type: dynamodb.AttributeType.STRING },
      sortKey: { name: "createdAt", type: dynamodb.AttributeType.STRING },
      projectionType: dynamodb.ProjectionType.ALL,
    });

    // NOTE: projectResolverFunction's governance-gate wiring (ADRS_TABLE,
    // EXECUTION_SPECS_TABLE, AGENT_DESIGN_ASSESSMENTS_TABLE env vars + read
    // grants for gates C3/C7/C10) moved to CitadelProjectsStack, where the
    // function is created directly with those tables passed in as props —
    // no deferred addEnvironment() dance needed there since ProjectsStack
    // receives the already-instantiated tables from BackendStack.

    // NOTE: agentImportResolverFunction's ADRS_TABLE env var + ADRs
    // write grant moved to CitadelRegistryStack (backend-stack-split phase 2).
  }

  /**
   * Adds the publish handler Lambda from GatewayStack as an AppSync data source
   * and creates resolvers for publishApp and unpublishApp mutations.
   * Called from app.ts after both BackendStack and GatewayStack are instantiated.
   * Accepts IFunction to allow cross-stack references without circular dependency.
   */
  public addPublishHandlerResolvers(publishHandlerArn: string): void {
    const publishHandlerFn = lambda.Function.fromFunctionAttributes(
      this,
      "ImportedPublishHandler",
      {
        functionArn: publishHandlerArn,
        sameEnvironment: true,
      },
    );

    const publishHandlerDataSource = this.appSyncApi.addLambdaDataSource(
      "PublishHandlerLambdaDataSource",
      publishHandlerFn,
    );

    publishHandlerDataSource.createResolver("PublishAppResolver", {
      typeName: "Mutation",
      fieldName: "publishApp",
      requestMappingTemplate: appsync.MappingTemplate.lambdaRequest(),
      responseMappingTemplate: appsync.MappingTemplate.lambdaResult(),
    });

    publishHandlerDataSource.createResolver("UnpublishAppResolver", {
      typeName: "Mutation",
      fieldName: "unpublishApp",
      requestMappingTemplate: appsync.MappingTemplate.lambdaRequest(),
      responseMappingTemplate: appsync.MappingTemplate.lambdaResult(),
    });
  }

  /**
   * Phase 2 (production sampling) — cross-stack AppSync wiring for
   * eval-sampling-config-resolver.ts's Lambda, which lives in
   * TelemetryStack (DECISION d36fbbf7 rationale: it needs
   * EvalSamplingConfigTable/EvalProdSamplesTable, both owned by
   * BackendStack, which instantiates BEFORE TelemetryStack — see the
   * section banner in telemetry-stack.ts). Same
   * fromFunctionAttributes+addLambdaDataSource pattern as
   * addPublishHandlerResolvers above. Called from app.ts after both
   * BackendStack and TelemetryStack are instantiated.
   */
  public addEvalSamplingConfigResolvers(resolverFunctionArn: string): void {
    const resolverFn = lambda.Function.fromFunctionAttributes(
      this,
      "ImportedEvalSamplingConfigResolver",
      {
        functionArn: resolverFunctionArn,
        sameEnvironment: true,
      },
    );

    const dataSource = this.appSyncApi.addLambdaDataSource(
      "EvalSamplingConfigLambdaDataSource",
      resolverFn,
    );

    dataSource.createResolver("SetEvalSamplingConfigResolver", {
      typeName: "Mutation",
      fieldName: "setEvalSamplingConfig",
      requestMappingTemplate: appsync.MappingTemplate.lambdaRequest(),
      responseMappingTemplate: appsync.MappingTemplate.lambdaResult(),
    });
    dataSource.createResolver("GetEvalSamplingConfigResolver", {
      typeName: "Query",
      fieldName: "getEvalSamplingConfig",
      requestMappingTemplate: appsync.MappingTemplate.lambdaRequest(),
      responseMappingTemplate: appsync.MappingTemplate.lambdaResult(),
    });
    dataSource.createResolver("ListEvalProdSamplesResolver", {
      typeName: "Query",
      fieldName: "listEvalProdSamples",
      requestMappingTemplate: appsync.MappingTemplate.lambdaRequest(),
      responseMappingTemplate: appsync.MappingTemplate.lambdaResult(),
    });
  }
}
