import * as cdk from "aws-cdk-lib";
import * as appsync from "@aws-cdk/aws-appsync-alpha";
import * as cognito from "aws-cdk-lib/aws-cognito";
import * as dynamodb from "aws-cdk-lib/aws-dynamodb";
import * as lambda from "aws-cdk-lib/aws-lambda";
import * as events from "aws-cdk-lib/aws-events";
import * as targets from "aws-cdk-lib/aws-events-targets";
import * as iam from "aws-cdk-lib/aws-iam";
import * as sqs from "aws-cdk-lib/aws-sqs";
import * as logs from "aws-cdk-lib/aws-logs";
import * as ssm from "aws-cdk-lib/aws-ssm";
import * as cloudwatch from "aws-cdk-lib/aws-cloudwatch";
import * as sns from "aws-cdk-lib/aws-sns";
import { BlockPublicAccess, Bucket } from 'aws-cdk-lib/aws-s3';
import { Asset } from "aws-cdk-lib/aws-s3-assets";
import { CfnGraphQLSchema } from "aws-cdk-lib/aws-appsync";
import * as path from 'path';
import { Construct } from "constructs";
import { Provider } from "aws-cdk-lib/custom-resources";
import { CustomResource, Duration } from "aws-cdk-lib";
import { NagSuppressions } from "cdk-nag";
import { buildImportDiscoveryPolicy } from "../src/utils/agent-import-policy";

interface BackendStackProps extends cdk.StackProps {
  environment: string;
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
  public readonly executionsTable: dynamodb.Table;
  public readonly adrsTable: dynamodb.Table;
  public readonly agentDesignAssessmentsTable: dynamodb.Table;
  public readonly executionSpecificationsTable: dynamodb.Table;
  public readonly workflowProgressFanoutFunction: lambda.Function;
  public readonly idempotencyTable: dynamodb.Table;
  public readonly interrogationRoundsTable: dynamodb.Table;
  public readonly programReviewsTable: dynamodb.Table;
  public readonly adrReopenAttemptsTable: dynamodb.Table;
  public readonly registryArn: string;
  public readonly registryId: string;

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
      indexName: 'OrganizationIndex',
      partitionKey: { name: 'organization', type: dynamodb.AttributeType.STRING },
      sortKey: { name: 'createdAt', type: dynamodb.AttributeType.STRING },
      projectionType: dynamodb.ProjectionType.ALL,
    });

    this.conversationsTable = new dynamodb.Table(this, 'ConversationsTable', {
      tableName: `citadel-conversations-${props.environment}`,
      partitionKey: { name: 'projectId', type: dynamodb.AttributeType.STRING },
      sortKey: { name: 'timestamp', type: dynamodb.AttributeType.STRING },
      billingMode: dynamodb.BillingMode.PAY_PER_REQUEST,
      removalPolicy: cdk.RemovalPolicy.DESTROY,
      pointInTimeRecoverySpecification: { pointInTimeRecoveryEnabled: true },
    });

    this.accessLogsBucket = new Bucket(this, 'AccessLogsBucket', {
          bucketName: `citadel-s3-logs-${props.environment}-${this.account}-${this.region}`,
          encryption: cdk.aws_s3.BucketEncryption.S3_MANAGED,
          blockPublicAccess: BlockPublicAccess.BLOCK_ALL,
          enforceSSL: true,
          removalPolicy: cdk.RemovalPolicy.DESTROY,
          autoDeleteObjects: true,
          lifecycleRules: [{ expiration: cdk.Duration.days(90) }],
        });
    const accessLogsBucket = this.accessLogsBucket;

        this.documentBucket = new Bucket(this, 'DocumentBucket', {
              bucketName: `citadel-documents-${props.environment}-${this.account}-${this.region}`,
              versioned: true,
              encryption: cdk.aws_s3.BucketEncryption.S3_MANAGED,
              blockPublicAccess: BlockPublicAccess.BLOCK_ALL,
              enforceSSL: true,
              serverAccessLogsBucket: accessLogsBucket,
              serverAccessLogsPrefix: 'documents/',
              removalPolicy: cdk.RemovalPolicy.DESTROY,
              autoDeleteObjects: true,
              cors: [
                {
                  allowedHeaders: ['*'],
                  allowedMethods: [cdk.aws_s3.HttpMethods.GET, cdk.aws_s3.HttpMethods.PUT, cdk.aws_s3.HttpMethods.POST],
                  allowedOrigins: [process.env.ALLOWED_ORIGIN || `https://*.cloudfront.net`],
                  maxAge: 3000,
                },
              ],
            });

    this.codeBucket = new Bucket(this, 'CodeBucket', {
              bucketName: `citadel-code-${props.environment}-${this.account}-${this.region}`,
              removalPolicy: cdk.RemovalPolicy.DESTROY,
              autoDeleteObjects: true,
              blockPublicAccess: BlockPublicAccess.BLOCK_ALL,
              enforceSSL: true,
              serverAccessLogsBucket: accessLogsBucket,
              serverAccessLogsPrefix: 'code/',
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

    const agentStatusTable = new dynamodb.Table(this, "AgentStatusTable", {
      tableName: `citadel-agent-status-${props.environment}`,
      partitionKey: { name: "projectId", type: dynamodb.AttributeType.STRING },
      sortKey: { name: "agentId", type: dynamodb.AttributeType.STRING },
      billingMode: dynamodb.BillingMode.PAY_PER_REQUEST,
      removalPolicy: cdk.RemovalPolicy.DESTROY,
      pointInTimeRecoverySpecification: { pointInTimeRecoveryEnabled: true },
    });

    this.agentConfigTable = new dynamodb.Table(this, 'AgentConfigTable', {
      tableName: `citadel-agents-${props.environment}`,
      partitionKey: { name: 'agentId', type: dynamodb.AttributeType.STRING },
      billingMode: dynamodb.BillingMode.PAY_PER_REQUEST,
      removalPolicy: cdk.RemovalPolicy.DESTROY,
      pointInTimeRecoverySpecification: { pointInTimeRecoveryEnabled: true },
    });

    // Model Catalog Table — inventory of invokable foundation models. Additive and
    // not yet wired into any runtime/Lambda env; operators curate rows over time.
    const modelCatalogTable = new dynamodb.Table(this, 'ModelCatalogTable', {
      tableName: `citadel-model-catalog-${props.environment}`,
      partitionKey: { name: 'modelKey', type: dynamodb.AttributeType.STRING },
      billingMode: dynamodb.BillingMode.PAY_PER_REQUEST,
      removalPolicy: cdk.RemovalPolicy.DESTROY,
      pointInTimeRecoverySpecification: { pointInTimeRecoveryEnabled: true },
    });

    // Model Config Table — resolved model-selection defaults/overrides. Additive and
    // not yet wired into any runtime/Lambda env.
    const modelConfigTable = new dynamodb.Table(this, 'ModelConfigTable', {
      tableName: `citadel-model-config-${props.environment}`,
      partitionKey: { name: 'scope', type: dynamodb.AttributeType.STRING },
      billingMode: dynamodb.BillingMode.PAY_PER_REQUEST,
      removalPolicy: cdk.RemovalPolicy.DESTROY,
      pointInTimeRecoverySpecification: { pointInTimeRecoveryEnabled: true },
    });

    // Integrations Table
    const integrationsTable = new dynamodb.Table(this, 'IntegrationsTable', {
      tableName: `citadel-integrations-${props.environment}`,
      partitionKey: { name: 'PK', type: dynamodb.AttributeType.STRING },
      sortKey: { name: 'SK', type: dynamodb.AttributeType.STRING },
      billingMode: dynamodb.BillingMode.PAY_PER_REQUEST,
      removalPolicy: cdk.RemovalPolicy.DESTROY,
      pointInTimeRecoverySpecification: { pointInTimeRecoveryEnabled: true },
    });

    integrationsTable.addGlobalSecondaryIndex({
      indexName: 'IntegrationIdIndex',
      partitionKey: { name: 'integrationId', type: dynamodb.AttributeType.STRING },
      projectionType: dynamodb.ProjectionType.ALL,
    });

    // Workflows Table
    this.workflowsTable = new dynamodb.Table(this, 'WorkflowsTable', {
      tableName: `citadel-workflows-${props.environment}`,
      partitionKey: { name: 'workflowId', type: dynamodb.AttributeType.STRING },
      billingMode: dynamodb.BillingMode.PAY_PER_REQUEST,
      removalPolicy: cdk.RemovalPolicy.DESTROY,
      pointInTimeRecoverySpecification: { pointInTimeRecoveryEnabled: true },
    });

    this.workflowsTable.addGlobalSecondaryIndex({
      indexName: 'OrgStatusIndex',
      partitionKey: { name: 'orgId', type: dynamodb.AttributeType.STRING },
      sortKey: { name: 'status', type: dynamodb.AttributeType.STRING },
      projectionType: dynamodb.ProjectionType.ALL,
    });

    this.workflowsTable.addGlobalSecondaryIndex({
      indexName: 'BlueprintIndex',
      partitionKey: { name: 'isBlueprint', type: dynamodb.AttributeType.STRING },
      sortKey: { name: 'updatedAt', type: dynamodb.AttributeType.STRING },
      projectionType: dynamodb.ProjectionType.ALL,
    });

    // Apps Table
    this.appsTable = new dynamodb.Table(this, 'AppsTable', {
      tableName: `citadel-apps-${props.environment}`,
      partitionKey: { name: 'appId', type: dynamodb.AttributeType.STRING },
      billingMode: dynamodb.BillingMode.PAY_PER_REQUEST,
      removalPolicy: cdk.RemovalPolicy.DESTROY,
      pointInTimeRecoverySpecification: { pointInTimeRecoveryEnabled: true },
    });

    this.appsTable.addGlobalSecondaryIndex({
      indexName: 'OrgIndex',
      partitionKey: { name: 'orgId', type: dynamodb.AttributeType.STRING },
      sortKey: { name: 'createdAt', type: dynamodb.AttributeType.STRING },
      projectionType: dynamodb.ProjectionType.ALL,
    });

    this.appsTable.addGlobalSecondaryIndex({
      indexName: 'GroupIndex',
      partitionKey: { name: 'groupId', type: dynamodb.AttributeType.STRING },
      sortKey: { name: 'sortId', type: dynamodb.AttributeType.STRING },
      projectionType: dynamodb.ProjectionType.ALL,
    });

    // Executions Table
    this.executionsTable = new dynamodb.Table(this, 'ExecutionsTable', {
      tableName: `citadel-executions-${props.environment}`,
      partitionKey: { name: 'executionId', type: dynamodb.AttributeType.STRING },
      billingMode: dynamodb.BillingMode.PAY_PER_REQUEST,
      removalPolicy: cdk.RemovalPolicy.DESTROY,
      pointInTimeRecoverySpecification: { pointInTimeRecoveryEnabled: true },
    });

    this.executionsTable.addGlobalSecondaryIndex({
      indexName: 'WorkflowIndex',
      partitionKey: { name: 'workflowId', type: dynamodb.AttributeType.STRING },
      sortKey: { name: 'startedAt', type: dynamodb.AttributeType.STRING },
      projectionType: dynamodb.ProjectionType.ALL,
    });

    // --- AgentCore Registry (Custom Resource — no CloudFormation type yet) ---
    const registryAutoApproval = this.node.tryGetContext('registryAutoApproval') ?? 'true';

    const registryProvisionerFunction = new lambda.Function(this, 'RegistryProvisionerFunction', {
      runtime: lambda.Runtime.NODEJS_24_X,
      handler: 'registry-provisioner.handler',
      code: lambda.Code.fromAsset('dist/lambda'),
      timeout: cdk.Duration.minutes(5),
      logGroup: new logs.LogGroup(this, 'RegistryProvisionerFunctionLogs', {
        retention: logs.RetentionDays.ONE_WEEK,
        removalPolicy: cdk.RemovalPolicy.DESTROY,
      }),
    });

    registryProvisionerFunction.addToRolePolicy(
      new iam.PolicyStatement({
        effect: iam.Effect.ALLOW,
        actions: [
          'bedrock-agentcore:CreateRegistry',
          'bedrock-agentcore:DeleteRegistry',
          'bedrock-agentcore:GetRegistry',
          'bedrock-agentcore:ListRegistries',
          'bedrock-agentcore:CreateWorkloadIdentity',
          'bedrock-agentcore:DeleteWorkloadIdentity',
          'bedrock-agentcore:GetWorkloadIdentity',
        ],
        resources: ['*'],
      }),
    );
    registryProvisionerFunction.addToRolePolicy(
      new iam.PolicyStatement({
        effect: iam.Effect.ALLOW,
        actions: ['iam:CreateServiceLinkedRole'],
        resources: ['arn:aws:iam::*:role/aws-service-role/bedrock-agentcore.amazonaws.com/*'],
        conditions: {
          StringEquals: { 'iam:AWSServiceName': 'bedrock-agentcore.amazonaws.com' },
        },
      }),
    );

    const agentCoreRegistry = new cdk.CustomResource(this, 'AgentCoreRegistry', {
      serviceToken: registryProvisionerFunction.functionArn,
      properties: {
        RegistryName: `citadel-registry-${props.environment}`,
        AutoApproval: String(registryAutoApproval),
        Description: `Citadel agent and tool registry for ${props.environment}`,
        ForceRecreate: '2026-05-03b',
      },
    });

    const registryArn = agentCoreRegistry.getAttString('RegistryArn');
    const registryId = agentCoreRegistry.getAttString('RegistryId');
    this.registryArn = registryArn;
    this.registryId = registryId;

    new cdk.CfnOutput(this, 'AgentCoreRegistryArn', {
      value: registryArn,
      description: 'AgentCore Registry ARN',
      exportName: `${this.stackName}-RegistryArn`,
    });

    new cdk.CfnOutput(this, 'AgentCoreRegistryId', {
      value: registryId,
      description: 'AgentCore Registry ID',
      exportName: `${this.stackName}-RegistryId`,
    });

    // EventBridge rule for Registry change events (sync to DynamoDB cache)
    const registrySyncRule = new events.Rule(this, 'RegistrySyncRule', {
      description: 'Captures AgentCore Registry resource changes for DynamoDB cache sync',
      eventPattern: {
        source: ['aws.bedrock-agentcore'],
        detailType: ['AgentCore Registry Resource Change'],
        detail: {
          registryId: [registryId],
        },
      },
    });

    // Dead-letter queue for failed sync events
    const registrySyncDlq = new sqs.Queue(this, 'RegistrySyncDLQ', {
      queueName: `citadel-registry-sync-dlq-${props.environment}`,
      retentionPeriod: cdk.Duration.days(14),
      enforceSSL: true,
    });

    // Sync Lambda — processes Registry change events into DynamoDB cache
    const registrySyncLambda = new lambda.Function(this, 'RegistrySyncLambda', {
      runtime: lambda.Runtime.NODEJS_24_X,
      handler: 'registry-sync.handler',
      code: lambda.Code.fromAsset('dist/lambda'),
      environment: {
        AGENT_CONFIG_TABLE: this.agentConfigTable.tableName,
        TOOLS_CONFIG_TABLE: `citadel-tools-${props.environment}`,
        REGISTRY_ID: registryId,
      },
      timeout: cdk.Duration.seconds(30),
      logGroup: new logs.LogGroup(this, 'RegistrySyncLambdaLogs', {
        retention: logs.RetentionDays.ONE_WEEK,
        removalPolicy: cdk.RemovalPolicy.DESTROY,
      }),
    });

    // Grant Sync Lambda write access to both DynamoDB cache tables
    this.agentConfigTable.grantReadWriteData(registrySyncLambda);
    registrySyncLambda.addToRolePolicy(
      new iam.PolicyStatement({
        effect: iam.Effect.ALLOW,
        actions: [
          'dynamodb:GetItem',
          'dynamodb:PutItem',
          'dynamodb:DeleteItem',
        ],
        resources: [
          `arn:aws:dynamodb:${this.region}:${this.account}:table/citadel-tools-${props.environment}`,
        ],
      }),
    );

    // Grant Sync Lambda permission to call Registry APIs
    registrySyncLambda.addToRolePolicy(
      new iam.PolicyStatement({
        effect: iam.Effect.ALLOW,
        actions: [
          'bedrock-agentcore:CreateRegistryRecord',
          'bedrock-agentcore:UpdateRegistryRecord',
          'bedrock-agentcore:UpdateRegistryRecordStatus',
          'bedrock-agentcore:DeleteRegistryRecord',
          'bedrock-agentcore:GetRegistryRecord',
          'bedrock-agentcore:ListRegistryRecords',
        ],
        resources: [registryArn, `${registryArn}/*`],
      }),
    );

    // Grant Sync Lambda permission to send failed events to DLQ
    registrySyncDlq.grantSendMessages(registrySyncLambda);

    // Wire EventBridge rule → Sync Lambda with DLQ on failure
    registrySyncRule.addTarget(
      new targets.LambdaFunction(registrySyncLambda, {
        deadLetterQueue: registrySyncDlq,
        retryAttempts: 2,
      }),
    );

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
      'ReconcileAppsMetaScheduledFunction',
      {
        runtime: lambda.Runtime.NODEJS_24_X,
        handler: 'reconcile-apps-meta-scheduled-handler.handler',
        code: lambda.Code.fromAsset('dist/lambda'),
        environment: {
          REGISTRY_ID: registryId,
          APPS_TABLE: this.appsTable.tableName,
        },
        timeout: cdk.Duration.minutes(5),
        logGroup: new logs.LogGroup(
          this,
          'ReconcileAppsMetaScheduledFunctionLogs',
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
          'bedrock-agentcore:GetRegistryRecord',
          'bedrock-agentcore:ListRegistryRecords',
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
      'ReconcileAppsMetaSchedule',
      {
        description:
          'Reconciles AppsTable #META rows against Registry every 6 hours',
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
      'ModelCatalogSyncFunction',
      {
        runtime: lambda.Runtime.NODEJS_24_X,
        handler: 'model-catalog-sync.handler',
        code: lambda.Code.fromAsset('dist/lambda'),
        environment: {
          MODEL_CATALOG_TABLE: modelCatalogTable.tableName,
          EVENT_BUS_NAME: this.agentEventBus.eventBusName,
          ENVIRONMENT: props.environment,
        },
        timeout: cdk.Duration.minutes(5),
        logGroup: new logs.LogGroup(this, 'ModelCatalogSyncFunctionLogs', {
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
          'bedrock:ListFoundationModels',
          'bedrock:ListInferenceProfiles',
          'bedrock:GetFoundationModel',
          'bedrock:GetInferenceProfile',
        ],
        resources: ['*'],
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
          id: 'AwsSolutions-IAM5',
          reason:
            'Bedrock discovery actions (ListFoundationModels/ListInferenceProfiles/' +
            'GetFoundationModel/GetInferenceProfile) are read-only and have no ' +
            'resource-level scoping; the model set is discovered dynamically each ' +
            'run, so target ARNs are not known ahead of time.',
          appliesTo: ['Resource::*'],
        },
      ],
      true,
    );

    // Catalog read/write to upsert discovered rows; event bus to emit summaries.
    modelCatalogTable.grantReadWriteData(modelCatalogSyncFunction);
    this.agentEventBus.grantPutEventsTo(modelCatalogSyncFunction);

    // Daily EventBridge schedule.
    const modelCatalogSyncRule = new events.Rule(this, 'ModelCatalogSyncRule', {
      description: 'Daily sync of the Bedrock model catalog',
      schedule: events.Schedule.rate(cdk.Duration.hours(24)),
    });

    modelCatalogSyncRule.addTarget(
      new targets.LambdaFunction(modelCatalogSyncFunction, {
        retryAttempts: 1,
        maxEventAge: cdk.Duration.minutes(30),
      }),
    );

    // Pre-token-generation trigger: promotes `custom:organization` and
    // `custom:role` attributes onto JWT claims so downstream resolvers can
    // read org/role identity without an AdminGetUserCommand per request.
    // Phase 1 org-scoping foundation.
    const preTokenGenerationLambda = new lambda.Function(this, 'PreTokenGenerationFunction', {
      runtime: lambda.Runtime.NODEJS_24_X,
      handler: 'pre-token-generation.handler',
      code: lambda.Code.fromAsset('dist/lambda'),
      functionName: `citadel-pre-token-gen-${props.environment}`,
      timeout: cdk.Duration.seconds(5),
      logGroup: new logs.LogGroup(this, 'PreTokenGenerationFunctionLogs', {
        retention: logs.RetentionDays.ONE_WEEK,
        removalPolicy: cdk.RemovalPolicy.DESTROY,
      }),
    });

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
      accountRecovery: cognito.AccountRecovery.EMAIL_ONLY, featurePlan: cognito.FeaturePlan.ESSENTIALS,
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

    const projectManagerGroup = new cognito.CfnUserPoolGroup(this, "ProjectManagerGroup", {
        userPoolId: this.userPool.userPoolId,
        groupName: "project_manager",
        description: "Project management access",
    });

    const architectGroup = new cognito.CfnUserPoolGroup(this, "ArchitectGroup", {
        userPoolId: this.userPool.userPoolId,
        groupName: "architect",
        description: "Architecture and design access",
    });

    const developerGroup = new cognito.CfnUserPoolGroup(this, "DeveloperGroup", {
        userPoolId: this.userPool.userPoolId,
        groupName: "developer",
        description: "Development access",
    });

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
    const projectResolverFunction = new lambda.Function(
      this,
      "ProjectResolverFunction",
      {
        runtime: lambda.Runtime.NODEJS_24_X,
        handler: "project-resolver.handler",
        code: lambda.Code.fromAsset("dist/lambda"),
        environment: {
          PROJECTS_TABLE: this.projectsTable.tableName,
          ENVIRONMENT: props.environment,
          // ADRS_TABLE, EXECUTION_SPECS_TABLE, and
          // AGENT_DESIGN_ASSESSMENTS_TABLE are injected via addEnvironment()
          // after their tables are instantiated later in the constructor.
          CONVERSATIONS_TABLE: this.conversationsTable.tableName,
          AGENT_STATUS_TABLE: agentStatusTable.tableName,
          EVENT_BUS_NAME: this.agentEventBus.eventBusName,
          USER_POOL_ID: this.userPool.userPoolId,
        },
        timeout: cdk.Duration.seconds(30),
        logGroup: new logs.LogGroup(this, 'ProjectResolverFunctionLogs', { retention: logs.RetentionDays.ONE_WEEK, removalPolicy: cdk.RemovalPolicy.DESTROY }),
      }
    );

    // Grant Cognito permissions to project resolver
    projectResolverFunction.addToRolePolicy(
      new iam.PolicyStatement({
        effect: iam.Effect.ALLOW,
        actions: ['cognito-idp:AdminGetUser'],
        resources: [this.userPool.userPoolArn],
      })
    );

    const conversationResolverFunction = new lambda.Function(
      this,
      "ConversationResolverFunction",
      {
        runtime: lambda.Runtime.NODEJS_24_X,
        handler: "conversation-resolver.handler",
        code: lambda.Code.fromAsset("dist/lambda"),
        environment: {
          PROJECTS_TABLE: this.projectsTable.tableName,
          CONVERSATIONS_TABLE: this.conversationsTable.tableName,
          AGENT_STATUS_TABLE: agentStatusTable.tableName,
          EVENT_BUS_NAME: this.agentEventBus.eventBusName,
        },
        timeout: cdk.Duration.seconds(30),
        logGroup: new logs.LogGroup(this, 'ConversationResolverFunctionLogs', { retention: logs.RetentionDays.ONE_WEEK, removalPolicy: cdk.RemovalPolicy.DESTROY }),
      }
    );

    const agentResolverFunction = new lambda.Function(
      this,
      "AgentResolverFunction",
      {
        runtime: lambda.Runtime.NODEJS_24_X,
        handler: "agent-resolver.handler",
        code: lambda.Code.fromAsset("dist/lambda"),
        environment: {
          PROJECTS_TABLE: this.projectsTable.tableName,
          CONVERSATIONS_TABLE: this.conversationsTable.tableName,
          AGENT_STATUS_TABLE: agentStatusTable.tableName,
          EVENT_BUS_NAME: this.agentEventBus.eventBusName,
        },
        timeout: cdk.Duration.seconds(30),
        logGroup: new logs.LogGroup(this, 'AgentResolverFunctionLogs', { retention: logs.RetentionDays.ONE_WEEK, removalPolicy: cdk.RemovalPolicy.DESTROY }),
      }
    );

    const documentUploadResolverFunction = new lambda.Function(
      this,
      "DocumentUploadResolverFunction",
      {
        runtime: lambda.Runtime.NODEJS_24_X,
        handler: "document-upload-resolver.handler",
        code: lambda.Code.fromAsset("dist/lambda"),
        environment: {
          DOCUMENT_BUCKET: this.documentBucket.bucketName,
          KB_ID_PARAM: `/citadel/knowledge-base-id-${props.environment}`,
          DS_ID_PARAM: `/citadel/knowledge-base-datasource-id-${props.environment}`,
          EVENT_BUS_NAME: this.agentEventBus.eventBusName,
          // Source-of-truth jobs table (created in ServicesStack). Referenced by
          // deterministic name — NOT a cross-stack construct import — because
          // ServicesStack already depends ON BackendStack (it consumes
          // props.documentBucket / props.agentEventBus); importing the table
          // construct here would create a circular stack dependency. The
          // resolver reads this table first and degrades to a Bedrock KB query
          // if the var/table is absent.
          INGESTION_TABLE: `citadel-document-ingestion-${props.environment}`,
        },
        timeout: cdk.Duration.seconds(30),
        logGroup: new logs.LogGroup(this, 'DocumentUploadResolverFunctionLogs', { retention: logs.RetentionDays.ONE_WEEK, removalPolicy: cdk.RemovalPolicy.DESTROY }),
      }
    );

    const documentResolverFunction = new lambda.Function(
          this,
          "DocumentResolverFunction",
          {
            runtime: lambda.Runtime.NODEJS_24_X,
            handler: "document-resolver.handler",
            code: lambda.Code.fromAsset("dist/lambda"),
            environment: {
              SESSION_BUCKET: `citadel-sessions-${props.environment}-${this.account}-${this.region}`,
              PDF_GENERATOR_FUNCTION: `citadel-pdf-generator-${props.environment}`,
            },
            timeout: cdk.Duration.minutes(6), // PDF generation can take up to 5 min
            logGroup: new logs.LogGroup(this, 'DocumentResolverFunctionLogs', { retention: logs.RetentionDays.ONE_WEEK, removalPolicy: cdk.RemovalPolicy.DESTROY }),
          }
        );

    const agentConfigResolverFunction = new lambda.Function(
      this,
      "AgentConfigResolverFunction",
      {
        runtime: lambda.Runtime.NODEJS_24_X,
        handler: "agent-config-resolver.handler",
        code: lambda.Code.fromAsset("dist/lambda"),
        environment: {
          AGENT_CONFIG_TABLE: this.agentConfigTable.tableName,
          REGISTRY_ENABLED: 'true',
          REGISTRY_ID: registryId,
          // Governance activation gate (US-IMP): ENVIRONMENT selects the
          // governance rollout SSM parameter path (getGovernanceEnforce);
          // EVENT_BUS_NAME targets the shared bus for best-effort gate
          // telemetry. Both mirror the agent-import resolver. Scoped IAM
          // grants below; getGovernanceEnforce fails open to 'permissive'.
          ENVIRONMENT: props.environment,
          EVENT_BUS_NAME: this.agentEventBus.eventBusName,
          // Phase-2 cross-account trust-path: the deploying account id powers
          // isCrossAccountRoleArn so the resolver can tell when an imported
          // agent's invocation.roleArn lives in a DIFFERENT account and route to
          // the operator analysis-role assume path (sts:AssumeRole grant below).
          ACCOUNT_ID: this.account,
        },
        timeout: cdk.Duration.seconds(30),
        logGroup: new logs.LogGroup(this, 'AgentConfigResolverFunctionLogs', { retention: logs.RetentionDays.ONE_WEEK, removalPolicy: cdk.RemovalPolicy.DESTROY }),
      }
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
        logGroup: new logs.LogGroup(this, 'ModelConfigResolverFunctionLogs', { retention: logs.RetentionDays.ONE_WEEK, removalPolicy: cdk.RemovalPolicy.DESTROY }),
      }
    );

    // Scoped grants: read/write both model tables + emit MODEL_CONFIG_CHANGED.
    modelCatalogTable.grantReadWriteData(modelConfigResolverFunction);
    modelConfigTable.grantReadWriteData(modelConfigResolverFunction);
    this.agentEventBus.grantPutEventsTo(modelConfigResolverFunction);

    // Agent Import Resolver - registers externally-owned agents (importAgent
    // mutation). Same runtime/bundling/env as the agent-config resolver; it
    // reuses that resolver's RegistryService + import-descriptor validator.
    const agentImportResolverFunction = new lambda.Function(
      this,
      "AgentImportResolverFunction",
      {
        runtime: lambda.Runtime.NODEJS_24_X,
        handler: "agent-import-resolver.handler",
        code: lambda.Code.fromAsset("dist/lambda"),
        environment: {
          AGENT_CONFIG_TABLE: this.agentConfigTable.tableName,
          REGISTRY_ENABLED: 'true',
          REGISTRY_ID: registryId,
          // Best-effort agent.import.{discovered,registered,failed} emission via
          // backend/src/utils/events.ts (source citadel.backend). Scoped grant below.
          EVENT_BUS_NAME: this.agentEventBus.eventBusName,
          // Governance attestation: imported agents request one fabricator
          // authority unit. AuthorityUnitsTable lives on ArbiterStack; we use the
          // deterministic table name to avoid a circular cross-stack dep (mirrors
          // RegistryAgentRecordResolverFunction). Scoped IAM grant below.
          AUTHORITY_UNITS_TABLE: `citadel-authority-units-${props.environment}`,
          // Phase-2 cross-account INVOKE: the deploying account id powers
          // isCrossAccountRoleArn so the test-invoke/probe paths detect when an
          // import candidate's invocation.roleArn lives in a DIFFERENT account and
          // assume the operator-supplied invoke role (sts:AssumeRole grant below)
          // instead of using this Lambda's identity. Mirrors the
          // agent-message-handler + agent-config-resolver.
          ACCOUNT_ID: this.account,
          // Tier-3 agent-import B2: the import resolver's proposeAgentManifestTier3
          // mutation enqueues a `manifest-proposal` job to the Fabricator queue.
          // The queue is owned by ArbiterStack; we use the deterministic URL
          // (not fabricatorQueue.queueUrl) to avoid a circular cross-stack
          // dependency — the SAME no-cross-ref mechanism the fabricator-request
          // resolver uses. Scoped sqs:SendMessage grant below.
          FABRICATOR_QUEUE_URL: `https://sqs.${this.region}.amazonaws.com/${this.account}/citadel-fabricator-queue-${props.environment}`,
        },
        timeout: cdk.Duration.seconds(30),
        logGroup: new logs.LogGroup(this, 'AgentImportResolverFunctionLogs', { retention: logs.RetentionDays.ONE_WEEK, removalPolicy: cdk.RemovalPolicy.DESTROY }),
      }
    );

    // Least-privilege: events:PutEvents scoped to the shared agent event bus
    // ARN, mirroring the other emitting resolvers.
    this.agentEventBus.grantPutEventsTo(agentImportResolverFunction);

    // Governance attestation: Write access (PutItem/UpdateItem) to the per-env
    // AuthorityUnitsTable owned by ArbiterStack so an import can grant its
    // fabricator authority unit. Referenced by explicit ARN pattern to avoid the
    // circular cross-stack dependency a Table.grantWriteData would introduce —
    // identical to RegistryAgentRecordResolverFunction's grant.
    agentImportResolverFunction.addToRolePolicy(
      new iam.PolicyStatement({
        effect: iam.Effect.ALLOW,
        actions: ['dynamodb:PutItem', 'dynamodb:UpdateItem'],
        resources: [
          `arn:aws:dynamodb:${this.region}:${this.account}:table/citadel-authority-units-${props.environment}`,
        ],
      })
    );

    // Import-side auth-secret storage (US-IMP): a caller may submit a RAW
    // invocation secret with an imported agent. It is persisted to Secrets
    // Manager via credential-manager.storeAgentInvocationSecret and the Registry
    // record stores ONLY the returned secretRef (never the raw value). Least
    // privilege: WRITE-only (CreateSecret/PutSecretValue/TagResource) scoped to
    // the agent secret-path convention /citadel/agents/*. No GetSecretValue here.
    // TODO(agent-import): invoke-side secretRef resolution (GetSecretValue) is a
    // follow-up on the invoke path (agent-message-handler), not this resolver.
    agentImportResolverFunction.addToRolePolicy(
      new iam.PolicyStatement({
        effect: iam.Effect.ALLOW,
        actions: [
          'secretsmanager:CreateSecret',
          'secretsmanager:PutSecretValue',
          'secretsmanager:TagResource',
        ],
        resources: [
          `arn:aws:secretsmanager:${this.region}:${this.account}:secret:/citadel/agents/*`,
        ],
      })
    );

    // Pre-activation TEST-INVOKE (testImportedAgent): the admin/architect-gated
    // dry-run actually invokes an operator-supplied import CANDIDATE through the
    // existing per-protocol adapters and returns a sanitized result WITHOUT
    // persisting anything. Because the target is operator-supplied/arbitrary,
    // the invoke actions are scoped to THIS ACCOUNT (never bare '*' where an
    // account-scoped ARN exists). The residual ':*'/'/*' wildcards are suppressed
    // (AwsSolutions-IAM5) in bin/app.ts with this justification.
    agentImportResolverFunction.addToRolePolicy(
      new iam.PolicyStatement({
        effect: iam.Effect.ALLOW,
        actions: [
          'bedrock-agentcore:InvokeAgentRuntime',
          'lambda:InvokeFunction',
          'bedrock:InvokeAgent',
          'execute-api:Invoke',
        ],
        resources: [
          `arn:aws:bedrock-agentcore:*:${this.account}:runtime/*`,
          `arn:aws:lambda:*:${this.account}:function:*`,
          `arn:aws:bedrock:*:${this.account}:agent-alias/*`,
          `arn:aws:execute-api:*:${this.account}:*`,
        ],
      })
    );
    // READ a pre-existing invocation secret for the test-invoke. Scoped to the
    // agent secret-path convention /citadel/agents/* (the same scope as the
    // import-time write grant above). A raw inline secret needs no AWS read.
    agentImportResolverFunction.addToRolePolicy(
      new iam.PolicyStatement({
        effect: iam.Effect.ALLOW,
        actions: ['secretsmanager:GetSecretValue'],
        resources: [
          `arn:aws:secretsmanager:${this.region}:${this.account}:secret:/citadel/agents/*`,
        ],
      })
    );

    // Phase-2 cross-account INVOKE (testImportedAgent / probeAgentCandidate):
    // when an import candidate's invocation.roleArn is in a DIFFERENT account,
    // the admin/architect-gated dry-run assumes that operator-supplied invoke
    // role (reusing vendImportCredentials) and runs the AWS-native protocol
    // invoke under the assumed credentials. The invoke role is operator-supplied
    // and may live in ANY account, so the assume cannot be account-scoped; it is
    // scoped to the cross-account IAM role namespace (arn:aws:iam::*:role/*). The
    // runtime confused-deputy control is the externalId threaded into the
    // AssumeRole call — the target role must trust Citadel under sts:ExternalId.
    // Same-account invokes never assume. The role/* wildcard is suppressed
    // (AwsSolutions-IAM5) in bin/app.ts. Mirrors the agent-message-handler grant.
    agentImportResolverFunction.addToRolePolicy(
      new iam.PolicyStatement({
        effect: iam.Effect.ALLOW,
        actions: ['sts:AssumeRole'],
        resources: ['arn:aws:iam::*:role/*'],
      })
    );

    // Tier-3 agent-import B2 (proposeAgentManifestTier3): enqueue a
    // `manifest-proposal` job to the Fabricator queue. Least privilege:
    // sqs:SendMessage ONLY (the URL is constructed, so no GetQueueUrl is
    // needed), scoped to the single fully-qualified queue ARN (no wildcard ⇒ no
    // AwsSolutions-IAM5 nag). Mirrors the fabricator-request resolver's grant
    // and references the queue by ARN string (not arbiter-stack's queueArn) so
    // no cross-stack dependency cycle is introduced.
    agentImportResolverFunction.addToRolePolicy(
      new iam.PolicyStatement({
        effect: iam.Effect.ALLOW,
        actions: ['sqs:SendMessage'],
        resources: [
          `arn:aws:sqs:${this.region}:${this.account}:citadel-fabricator-queue-${props.environment}`,
        ],
      })
    );

    // ── Agent Import — Manifest RESULT handler (Tier-3 agent import, B1) ─────
    // Consumes an ASYNC, LLM-proposed manifest from the Fabricator on the shared
    // agent bus and parks it on the DRAFT import record as UNTRUSTED /
    // low-confidence / pending-review (NEVER activated). Mirrors the
    // EventBridge-triggered handler convention: NODEJS_24_X, dist/lambda esbuild
    // bundle, idempotency table, scoped Registry perms.
    const agentImportManifestResultHandler = new lambda.Function(
      this,
      'AgentImportManifestResultHandler',
      {
        runtime: lambda.Runtime.NODEJS_24_X,
        handler: 'agent-import-manifest-result-handler.handler',
        code: lambda.Code.fromAsset('dist/lambda'),
        environment: {
          REGISTRY_ENABLED: 'true',
          REGISTRY_ID: registryId,
          IDEMPOTENCY_TABLE: this.idempotencyTable.tableName,
        },
        timeout: cdk.Duration.seconds(30),
        logGroup: new logs.LogGroup(this, 'AgentImportManifestResultHandlerLogs', { retention: logs.RetentionDays.ONE_WEEK, removalPolicy: cdk.RemovalPolicy.DESTROY }),
      }
    );

    // Idempotency table: dedupe on correlationId||requestId (duplicate emits).
    this.idempotencyTable.grantReadWriteData(agentImportManifestResultHandler);

    // Least privilege: READ the DRAFT import record and UPDATE only its custom
    // metadata. NO status/approval/delete/create — this handler never activates
    // an agent; it only parks a pending-review proposal under
    // customMetadata.proposedManifest. Scoped to the registry + its records. The
    // residual ${registryArn}/* wildcard is covered by the stack-level
    // AwsSolutions-IAM5 suppression (citadel-scoped bedrock-agentcore ARNs).
    agentImportManifestResultHandler.addToRolePolicy(
      new iam.PolicyStatement({
        effect: iam.Effect.ALLOW,
        actions: [
          'bedrock-agentcore:GetRegistryRecord',
          'bedrock-agentcore:UpdateRegistryRecord',
        ],
        resources: [registryArn, `${registryArn}/*`],
      })
    );

    // EventBridge rule on the shared agent bus: route the proposed/failed
    // manifest-result detail-types to the handler. Detail-type-only match
    // mirrors FabricationRegistrationRule. This is the CONTRACT anchor — B2 and
    // the arbiter Fabricator branch MUST emit these detail-types on this bus.
    const agentImportManifestResultRule = new events.Rule(
      this,
      'AgentImportManifestResultRule',
      {
        eventBus: this.agentEventBus,
        ruleName: `citadel-agent-import-manifest-result-${props.environment}`,
        description:
          'Routes async LLM-proposed agent-import manifest results (proposed/failed) to the result handler',
        eventPattern: {
          detailType: [
            'agent.import.manifest.proposed',
            'agent.import.manifest.failed',
          ],
        },
      }
    );
    agentImportManifestResultRule.addTarget(
      new targets.LambdaFunction(agentImportManifestResultHandler, {
        retryAttempts: 2,
        maxEventAge: cdk.Duration.hours(2),
      })
    );

    // Agent Code Resolver - for reading/writing agent code from S3
    const agentCodeResolverFunction = new lambda.Function(
      this,
      "AgentCodeResolverFunction",
      {
        runtime: lambda.Runtime.NODEJS_24_X,
        handler: "agent-code-resolver.handler",
        code: lambda.Code.fromAsset("dist/lambda"),
        environment: {
          AGENT_BUCKET_NAME: `citadel-code-${props.environment}-${this.account}-${this.region}`,
          AGENT_CONFIG_TABLE: this.agentConfigTable.tableName,
        },
        timeout: cdk.Duration.seconds(30),
        logGroup: new logs.LogGroup(this, 'AgentCodeResolverFunctionLogs', { retention: logs.RetentionDays.ONE_WEEK, removalPolicy: cdk.RemovalPolicy.DESTROY }),
      }
    );

    const toolConfigResolverFunction = new lambda.Function(
      this,
      "ToolConfigResolverFunction",
      {
        runtime: lambda.Runtime.NODEJS_24_X,
        handler: "tool-config-resolver.handler",
        code: lambda.Code.fromAsset("dist/lambda"),
        environment: {
          TOOLS_CONFIG_TABLE: `citadel-tools-${props.environment}`,
          REGISTRY_ENABLED: 'true',
          REGISTRY_ID: registryId,
        },
        timeout: cdk.Duration.seconds(30),
        logGroup: new logs.LogGroup(this, 'ToolConfigResolverFunctionLogs', { retention: logs.RetentionDays.ONE_WEEK, removalPolicy: cdk.RemovalPolicy.DESTROY }),
      }
    );

    const fabricatorRequestResolverFunction = new lambda.Function(
      this,
      "FabricatorRequestResolverFunction",
      {
        runtime: lambda.Runtime.NODEJS_24_X,
        handler: "fabricator-request-resolver.handler",
        code: lambda.Code.fromAsset("dist/lambda"),
        environment: {
          FABRICATOR_QUEUE_URL: `https://sqs.${this.region}.amazonaws.com/${this.account}/citadel-fabricator-queue-${props.environment}`,
          FABRICATION_JOBS_TABLE: `citadel-fabrication-jobs-${props.environment}`,
        },
        timeout: cdk.Duration.seconds(30),
        logGroup: new logs.LogGroup(this, 'FabricatorRequestResolverFunctionLogs', { retention: logs.RetentionDays.ONE_WEEK, removalPolicy: cdk.RemovalPolicy.DESTROY }),
      }
    );

    const fabricatorQueueResolverFunction = new lambda.Function(
      this,
      "FabricatorQueueResolverFunction",
      {
        runtime: lambda.Runtime.NODEJS_24_X,
        handler: "fabricator-queue-resolver.handler",
        code: lambda.Code.fromAsset("dist/lambda"),
        environment: {
          FABRICATOR_QUEUE_URL: `https://sqs.${this.region}.amazonaws.com/${this.account}/citadel-fabricator-queue-${props.environment}`,
          FABRICATION_JOBS_TABLE: `citadel-fabrication-jobs-${props.environment}`,
        },
        timeout: cdk.Duration.seconds(30),
        logGroup: new logs.LogGroup(this, 'FabricatorQueueResolverFunctionLogs', { retention: logs.RetentionDays.ONE_WEEK, removalPolicy: cdk.RemovalPolicy.DESTROY }),
      }
    );

    // Grant permissions to Lambda functions
    this.projectsTable.grantReadWriteData(projectResolverFunction);
    // adrsTable, executionSpecificationsTable, and
    // agentDesignAssessmentsTable grants are issued after the tables are
    // instantiated later in the constructor.
    this.conversationsTable.grantReadWriteData(projectResolverFunction);
    agentStatusTable.grantReadWriteData(projectResolverFunction);

    this.conversationsTable.grantReadWriteData(conversationResolverFunction);
    agentStatusTable.grantReadWriteData(conversationResolverFunction);
    this.projectsTable.grantReadData(conversationResolverFunction);

    agentStatusTable.grantReadWriteData(agentResolverFunction);
    this.projectsTable.grantReadData(agentResolverFunction);

    // Grant S3 permissions for document upload
    this.documentBucket.grantPut(documentUploadResolverFunction);
    this.documentBucket.grantRead(documentUploadResolverFunction);
    this.documentBucket.grantDelete(documentUploadResolverFunction);
    documentUploadResolverFunction.addToRolePolicy(new iam.PolicyStatement({
      actions: ['bedrock:GetKnowledgeBaseDocuments', 'bedrock:DeleteKnowledgeBaseDocuments'],
      resources: ['*'],
    }));
    documentUploadResolverFunction.addToRolePolicy(new iam.PolicyStatement({
      actions: ['ssm:GetParameter'],
      resources: [
        `arn:aws:ssm:${this.region}:${this.account}:parameter/citadel/knowledge-base-id-${props.environment}`,
        `arn:aws:ssm:${this.region}:${this.account}:parameter/citadel/knowledge-base-datasource-id-${props.environment}`,
      ],
    }));
    this.agentEventBus.grantPutEventsTo(documentUploadResolverFunction);

    // Read-only access to the authoritative document-ingestion jobs table
    // (source of truth for per-document ingestion status). The resolver only
    // READS this table (GetItem on the base table, Query on the base table /
    // status-index GSI), so grant the minimum required actions. ARNs are built
    // from account/region/name rather than importing the ServicesStack table
    // construct, which would create a circular stack dependency (ServicesStack
    // already depends ON BackendStack).
    const ingestionTableName = `citadel-document-ingestion-${props.environment}`;
    const ingestionTableArn = `arn:aws:dynamodb:${this.region}:${this.account}:table/${ingestionTableName}`;
    documentUploadResolverFunction.addToRolePolicy(new iam.PolicyStatement({
      effect: iam.Effect.ALLOW,
      actions: ['dynamodb:GetItem', 'dynamodb:Query'],
      resources: [ingestionTableArn, `${ingestionTableArn}/index/status-index`],
    }));

    // ── Durable fabrication-jobs status table ────────────────────────────────
    // Source of truth for per-agent fabrication status, replacing the old
    // SQS-peek queue read. Owned HERE in BackendStack because it is the
    // dependency root (services→backend, arbiter→services→backend): owning it
    // here lets the two fabricator resolvers below use scoped grants, ensures
    // the table is provisioned before any cross-stack writer (the services
    // intake runtime and the arbiter fabricator Lambda) deploys, and makes a
    // circular stack dependency impossible because those stacks reference the
    // table only by deterministic name + constructed ARN.
    // PK orchestrationId (intake session id, or '0' for direct UI requests) /
    // SK agentUseId (agent name / requestId). On-demand + PITR per conventions;
    // a `ttl` attribute (epoch seconds, ~7 days) keeps the table self-pruning.
    new dynamodb.Table(this, 'FabricationJobsTable', {
      tableName: `citadel-fabrication-jobs-${props.environment}`,
      partitionKey: { name: 'orchestrationId', type: dynamodb.AttributeType.STRING },
      sortKey: { name: 'agentUseId', type: dynamodb.AttributeType.STRING },
      billingMode: dynamodb.BillingMode.PAY_PER_REQUEST,
      pointInTimeRecoverySpecification: { pointInTimeRecoveryEnabled: true },
      timeToLiveAttribute: 'ttl',
      removalPolicy: cdk.RemovalPolicy.DESTROY,
    });

    // Grants use the deterministic name + constructed ARN so the wiring is
    // uniform with the cross-stack writers in ServicesStack / ArbiterStack,
    // which cannot import this construct without a circular dependency. Least
    // privilege: the request resolver only writes PENDING rows; the queue
    // resolver only reads (Query for a given project, Scan otherwise).
    const fabricationJobsTableArn = `arn:aws:dynamodb:${this.region}:${this.account}:table/citadel-fabrication-jobs-${props.environment}`;
    fabricatorRequestResolverFunction.addToRolePolicy(new iam.PolicyStatement({
      effect: iam.Effect.ALLOW,
      actions: ['dynamodb:PutItem'],
      resources: [fabricationJobsTableArn],
    }));
    fabricatorQueueResolverFunction.addToRolePolicy(new iam.PolicyStatement({
      effect: iam.Effect.ALLOW,
      actions: ['dynamodb:Query', 'dynamodb:Scan'],
      resources: [fabricationJobsTableArn],
    }));

    // Grant S3 + Lambda permissions for document resolver
    const sessionBucketArn = `arn:aws:s3:::citadel-sessions-${props.environment}-${this.account}-${this.region}`;
    documentResolverFunction.addToRolePolicy(new iam.PolicyStatement({
      actions: ['s3:GetObject', 's3:ListBucket', 's3:ListBucketVersions', 's3:GetObjectVersion'],
      resources: [sessionBucketArn, `${sessionBucketArn}/*`],
    }));
    documentResolverFunction.addToRolePolicy(new iam.PolicyStatement({
      actions: ['s3:PutObject'],
      resources: [`${sessionBucketArn}/*`],
    }));
    documentResolverFunction.addToRolePolicy(new iam.PolicyStatement({
      actions: ['lambda:InvokeFunction'],
      resources: [`arn:aws:lambda:${this.region}:${this.account}:function:citadel-pdf-generator-${props.environment}`],
    }));

    // Grant permissions for agent config
    this.agentConfigTable.grantReadWriteData(agentConfigResolverFunction);

    // Grant agent-config-resolver permission to call Registry APIs
    agentConfigResolverFunction.addToRolePolicy(
      new iam.PolicyStatement({
        effect: iam.Effect.ALLOW,
        actions: [
          'bedrock-agentcore:CreateRegistryRecord',
          'bedrock-agentcore:UpdateRegistryRecord',
          'bedrock-agentcore:UpdateRegistryRecordStatus',
          'bedrock-agentcore:SubmitRegistryRecordForApproval',
          'bedrock-agentcore:DeleteRegistryRecord',
          'bedrock-agentcore:GetRegistryRecord',
          'bedrock-agentcore:ListRegistryRecords',
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
    // getGovernanceEnforce fails open to 'permissive' internally, so a missing
    // parameter or denied read can never hard-fail an activation.
    this.agentEventBus.grantPutEventsTo(agentConfigResolverFunction);
    agentConfigResolverFunction.addToRolePolicy(
      new iam.PolicyStatement({
        effect: iam.Effect.ALLOW,
        actions: ['ssm:GetParameter'],
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
          'iam:GetRole',
          'iam:GetRolePolicy',
          'iam:ListRolePolicies',
          'iam:ListAttachedRolePolicies',
        ],
        resources: [`arn:aws:iam::${this.account}:role/*`],
      }),
    );
    agentConfigResolverFunction.addToRolePolicy(
      new iam.PolicyStatement({
        effect: iam.Effect.ALLOW,
        actions: ['iam:GetPolicy', 'iam:GetPolicyVersion'],
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
        actions: ['sts:AssumeRole'],
        resources: ['arn:aws:iam::*:role/*'],
      }),
    );

    // Grant permissions for agent import (same DynamoDB + Registry grants as
    // agent-config-resolver; the import resolver reuses RegistryService).
    this.agentConfigTable.grantReadWriteData(agentImportResolverFunction);
    agentImportResolverFunction.addToRolePolicy(
      new iam.PolicyStatement({
        effect: iam.Effect.ALLOW,
        actions: [
          'bedrock-agentcore:CreateRegistryRecord',
          'bedrock-agentcore:UpdateRegistryRecord',
          'bedrock-agentcore:UpdateRegistryRecordStatus',
          'bedrock-agentcore:SubmitRegistryRecordForApproval',
          'bedrock-agentcore:DeleteRegistryRecord',
          'bedrock-agentcore:GetRegistryRecord',
          'bedrock-agentcore:ListRegistryRecords',
        ],
        resources: [registryArn, `${registryArn}/*`],
      }),
    );

    // Grant read-only discovery permissions for the discoverAgents /
    // describeAgentCandidate queries. buildImportDiscoveryPolicy() is the
    // single source of truth for the List/Describe/Get actions across the
    // phase-1 substrates (lambda, bedrock, bedrock-agentcore, ecs, ec2, eks,
    // apigateway, tag). These are read-only and use Resource '*' (List/Describe
    // has no resource-level scoping); the cdk-nag IAM5 finding on this role's
    // DefaultPolicy is suppressed with that justification in bin/app.ts.
    for (const statement of buildImportDiscoveryPolicy().Statement) {
      agentImportResolverFunction.addToRolePolicy(
        new iam.PolicyStatement({
          effect: iam.Effect.ALLOW,
          actions: statement.Action,
          resources: statement.Resource,
        }),
      );
    }

    // US-IMP-018 (ECS) + US-IMP-019 (EKS) + US-IMP-020 (EC2): three DISCOVERY
    // SUBSTRATES that resolve an agent's HTTP endpoint via a load balancer. ECS
    // follows its service's target group (loadBalancers -> targetGroupArn ->
    // DescribeTargetGroups -> LoadBalancerArns -> DescribeLoadBalancers ->
    // DNSName); EKS enumerates load balancers and matches one tagged for the
    // cluster (DescribeLoadBalancers + DescribeTags -> kubernetes.io/cluster/
    // <name>=owned|shared or elbv2.k8s.aws/cluster=<name> -> DNSName); EC2
    // enumerates target groups and matches one the instance is a REGISTERED
    // target of (DescribeTargetGroups -> DescribeTargetHealth match on the
    // InstanceId -> DescribeLoadBalancers -> DNSName). The ECS reads
    // (ecs:ListClusters/ListServices/DescribeServices/DescribeTaskDefinition),
    // the EKS reads (eks:ListClusters/eks:DescribeCluster) and the EC2 reads
    // (ec2:DescribeInstances/DescribeTags) are ALREADY granted by
    // buildImportDiscoveryPolicy() above; this adds the companion read-only ELBv2
    // Describe actions (DescribeTags is required by the EKS LB->cluster match;
    // DescribeTargetHealth by the EC2 instance->target-group match). All four
    // ELBv2 calls are List/Describe-class reads with no resource-level scoping,
    // so Resource '*' (the cdk-nag IAM5 finding on this role's DefaultPolicy is
    // suppressed with the read-only ECS/ELB discovery justification in
    // bin/app.ts).
    agentImportResolverFunction.addToRolePolicy(
      new iam.PolicyStatement({
        effect: iam.Effect.ALLOW,
        actions: [
          'elasticloadbalancing:DescribeTargetGroups',
          'elasticloadbalancing:DescribeTargetHealth',
          'elasticloadbalancing:DescribeLoadBalancers',
          'elasticloadbalancing:DescribeTags',
        ],
        resources: ['*'],
      }),
    );

    // Grant S3 permissions for agent code
    // The bucket is created in the arbiter stack, so we grant permissions by ARN
    agentCodeResolverFunction.addToRolePolicy(
      new iam.PolicyStatement({
        effect: iam.Effect.ALLOW,
        actions: ['s3:GetObject', 's3:PutObject', 's3:GetObjectVersion', 's3:ListBucket'],
        resources: [
          `arn:aws:s3:::citadel-code-${props.environment}-${this.account}-${this.region}`,
          `arn:aws:s3:::citadel-code-${props.environment}-${this.account}-${this.region}/agents/*`,
        ],
      })
    );

    // Grant DynamoDB read permissions to get agent config (for filename)
    this.agentConfigTable.grantReadData(agentCodeResolverFunction);

    // Grant permissions for tool config
    toolConfigResolverFunction.addToRolePolicy(
      new iam.PolicyStatement({
        effect: iam.Effect.ALLOW,
        actions: [
          'dynamodb:GetItem',
          'dynamodb:PutItem',
          'dynamodb:DeleteItem',
          'dynamodb:Scan',
        ],
        resources: [
          `arn:aws:dynamodb:${this.region}:${this.account}:table/citadel-tools-${props.environment}`,
        ],
      })
    );

    // Grant tool-config-resolver permission to call Registry APIs
    toolConfigResolverFunction.addToRolePolicy(
      new iam.PolicyStatement({
        effect: iam.Effect.ALLOW,
        actions: [
          'bedrock-agentcore:CreateRegistryRecord',
          'bedrock-agentcore:UpdateRegistryRecord',
          'bedrock-agentcore:UpdateRegistryRecordStatus',
          'bedrock-agentcore:SubmitRegistryRecordForApproval',
          'bedrock-agentcore:DeleteRegistryRecord',
          'bedrock-agentcore:GetRegistryRecord',
          'bedrock-agentcore:ListRegistryRecords',
        ],
        resources: [registryArn, `${registryArn}/*`],
      }),
    );

    // Grant permissions for fabricator request
    fabricatorRequestResolverFunction.addToRolePolicy(
      new iam.PolicyStatement({
        effect: iam.Effect.ALLOW,
        actions: ['sqs:SendMessage', 'sqs:GetQueueUrl'],
        resources: [
          `arn:aws:sqs:${this.region}:${this.account}:citadel-fabricator-queue-${props.environment}`,
        ],
      })
    );

    // Grant permissions for fabricator queue query
    fabricatorQueueResolverFunction.addToRolePolicy(
      new iam.PolicyStatement({
        effect: iam.Effect.ALLOW,
        actions: ['sqs:ReceiveMessage', 'sqs:GetQueueAttributes'],
        resources: [
          `arn:aws:sqs:${this.region}:${this.account}:citadel-fabricator-queue-${props.environment}`,
        ],
      })
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
        logGroup: new logs.LogGroup(this, 'TaskRunnerResolverFunctionLogs', { retention: logs.RetentionDays.ONE_WEEK, removalPolicy: cdk.RemovalPolicy.DESTROY }),
      }
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
        logGroup: new logs.LogGroup(this, 'UserManagementResolverFunctionLogs', { retention: logs.RetentionDays.ONE_WEEK, removalPolicy: cdk.RemovalPolicy.DESTROY }),
      }
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
    const oauthReturnUrlParam = new ssm.StringParameter(this, 'OAuthReturnUrlParam', {
      parameterName: oauthReturnUrlParamName,
      stringValue: 'https://app.citadel.example.com/integrations/connected',
      description:
        'Default redirect target presented to end-users after the AgentCore-hosted ' +
        'OAuth2 callback completes for an integration. Consumed by integration-resolver ' +
        'and gateway-registration-handler Lambdas via the OAUTH_DEFAULT_RETURN_URL env var.',
      tier: ssm.ParameterTier.STANDARD,
      dataType: ssm.ParameterDataType.TEXT,
    });
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
        logGroup: new logs.LogGroup(this, 'IntegrationResolverFunctionLogs', { retention: logs.RetentionDays.ONE_WEEK, removalPolicy: cdk.RemovalPolicy.DESTROY }),
      }
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
        logGroup: new logs.LogGroup(this, 'GatewayRegistrationHandlerLogs', { retention: logs.RetentionDays.ONE_WEEK, removalPolicy: cdk.RemovalPolicy.DESTROY }),
      }
    );

    this.idempotencyTable.grantReadWriteData(gatewayRegistrationHandler);

    // Grant permissions to integration resolver
    integrationsTable.grantReadWriteData(integrationResolverFunction);
    integrationResolverFunction.addToRolePolicy(
      new iam.PolicyStatement({
        effect: iam.Effect.ALLOW,
        actions: [
          'secretsmanager:CreateSecret',
          'secretsmanager:UpdateSecret',
          'secretsmanager:DeleteSecret',
          'secretsmanager:GetSecretValue',
          'secretsmanager:TagResource',
        ],
        resources: [
          `arn:aws:secretsmanager:${this.region}:${this.account}:secret:/citadel/integrations/*`,
        ],
      })
    );
    integrationResolverFunction.addToRolePolicy(
      new iam.PolicyStatement({
        effect: iam.Effect.ALLOW,
        actions: [
          'ssm:PutParameter',
          'ssm:GetParameter',
          'ssm:DeleteParameter',
          'ssm:AddTagsToResource',
        ],
        resources: [
          `arn:aws:ssm:${this.region}:${this.account}:parameter/citadel/integrations/*`,
          `arn:aws:ssm:${this.region}:${this.account}:parameter/citadel/gateway/*`,
        ],
      })
    );
    this.agentEventBus.grantPutEventsTo(integrationResolverFunction);

    // Grant AgentCore Gateway permissions to integration resolver
    integrationResolverFunction.addToRolePolicy(
      new iam.PolicyStatement({
        effect: iam.Effect.ALLOW,
        actions: [
          'bedrock-agentcore:CreateGatewayTarget',
          'bedrock-agentcore:DeleteGatewayTarget',
          'bedrock-agentcore:GetGatewayTarget',
          'bedrock-agentcore:UpdateGatewayTarget',
          'bedrock-agentcore:CreateCredentialProvider',
          'bedrock-agentcore:DeleteCredentialProvider',
        ],
        resources: [
          `arn:aws:bedrock-agentcore:${this.region}:${this.account}:gateway/*`,
          `arn:aws:bedrock-agentcore:${this.region}:${this.account}:token-vault/default/apikeycredentialprovider/*`,
        ],
      })
    );

    // Grant AgentCore Identity credential-provider permissions for OAuth2 +
    // ApiKey provisioning performed by `provisionCredentialProvider`. ARN
    // suffix `credential-provider/integration-*` matches the
    // `integration-<integrationId>` naming used by CredentialProviderManager.
    integrationResolverFunction.addToRolePolicy(
      new iam.PolicyStatement({
        effect: iam.Effect.ALLOW,
        actions: [
          'bedrock-agentcore:CreateOauth2CredentialProvider',
          'bedrock-agentcore:UpdateOauth2CredentialProvider',
          'bedrock-agentcore:GetOauth2CredentialProvider',
          'bedrock-agentcore:DeleteOauth2CredentialProvider',
          'bedrock-agentcore:CreateApiKeyCredentialProvider',
          'bedrock-agentcore:UpdateApiKeyCredentialProvider',
          'bedrock-agentcore:GetApiKeyCredentialProvider',
          'bedrock-agentcore:DeleteApiKeyCredentialProvider',
          'bedrock-agentcore:ListOauth2CredentialProviders',
          'bedrock-agentcore:ListApiKeyCredentialProviders',
        ],
        resources: [
          `arn:aws:bedrock-agentcore:${this.region}:${this.account}:credential-provider/integration-*`,
        ],
      })
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
          'iam:CreateRole',
          'iam:DeleteRole',
          'iam:GetRole',
          'iam:PutRolePolicy',
          'iam:DeleteRolePolicy',
          'iam:TagRole',
        ],
        resources: [
          `arn:aws:iam::${this.account}:role/citadel-int-*`,
        ],
      })
    );

    // Grant STS permissions for PolicyManager (integration scope)
    integrationResolverFunction.addToRolePolicy(
          new iam.PolicyStatement({
            effect: iam.Effect.ALLOW,
            actions: ['sts:AssumeRole'],
            resources: [`arn:aws:iam::${this.account}:role/citadel-int-*`],
          })
        );
        integrationResolverFunction.addToRolePolicy(
          new iam.PolicyStatement({
            effect: iam.Effect.ALLOW,
            actions: ['sts:GetCallerIdentity'],
            resources: ['*'],
          })
        );

    // Gateway registration handler permissions
    integrationsTable.grantReadWriteData(gatewayRegistrationHandler);
    gatewayRegistrationHandler.addToRolePolicy(
      new iam.PolicyStatement({
        effect: iam.Effect.ALLOW,
        actions: [
          'ssm:GetParameter',
          'ssm:PutParameter',
          'ssm:DeleteParameter',
          'ssm:AddTagsToResource',
        ],
        resources: [
          `arn:aws:ssm:${this.region}:${this.account}:parameter/citadel/gateway/*`,
          `arn:aws:ssm:${this.region}:${this.account}:parameter/citadel/gateway-id-*`,
        ],
      })
    );
    gatewayRegistrationHandler.addToRolePolicy(
      new iam.PolicyStatement({
        effect: iam.Effect.ALLOW,
        actions: ['secretsmanager:GetSecretValue'],
        resources: [
          `arn:aws:secretsmanager:${this.region}:${this.account}:secret:/citadel/integrations/*`,
        ],
      })
    );
    gatewayRegistrationHandler.addToRolePolicy(
      new iam.PolicyStatement({
        effect: iam.Effect.ALLOW,
        actions: [
          'bedrock-agentcore:CreateGatewayTarget',
          'bedrock-agentcore:DeleteGatewayTarget',
          'bedrock-agentcore:GetGatewayTarget',
        ],
        resources: [
          `arn:aws:bedrock-agentcore:${this.region}:${this.account}:gateway/*`,
          `arn:aws:bedrock-agentcore:${this.region}:${this.account}:gateway/*/target/*`,
        ],
      })
    );

    // Credential-provider read + delete for disconnect cleanup. The handler
    // looks up the OAUTH2 / API_KEY credential provider for an integration to
    // populate the gateway target payload (read), and deletes the provider
    // when an integration is disconnected (delete cleanup path).
    gatewayRegistrationHandler.addToRolePolicy(
      new iam.PolicyStatement({
        effect: iam.Effect.ALLOW,
        actions: [
          'bedrock-agentcore:GetOauth2CredentialProvider',
          'bedrock-agentcore:GetApiKeyCredentialProvider',
          'bedrock-agentcore:DeleteOauth2CredentialProvider',
          'bedrock-agentcore:DeleteApiKeyCredentialProvider',
        ],
        resources: [
          `arn:aws:bedrock-agentcore:${this.region}:${this.account}:credential-provider/integration-*`,
        ],
      })
    );

    // Read access to the OAuth return-URL SSM parameter (mirrors the grant on
    // the integration-resolver role; the handler also reads this env var when
    // building OAUTH2 gateway target payloads).
    oauthReturnUrlParam.grantRead(gatewayRegistrationHandler);
    gatewayRegistrationHandler.addToRolePolicy(
      new iam.PolicyStatement({
        effect: iam.Effect.ALLOW,
        actions: ['s3:GetObject'],
        resources: [`arn:aws:s3:::citadel-schemas-${props.environment}-${this.account}-${this.region}/*`],
      })
    );

    // ── US-IMP-031: MCP Gateway publish/unpublish for the import resolver ────
    // The admin/architect-gated publishImportToGateway / unpublishImportFromGateway
    // mutations publish a PUBLICLY-REACHABLE, governance-ATTESTED, MCP-substrate
    // imported agent as an `mcpServer` target on the shared AgentCore Gateway and
    // tear it down. Least-privilege grants MIRRORING the gateway-registration
    // handler (the only other gateway-target lifecycle path):
    //   • CreateGatewayTarget / DeleteGatewayTarget on the gateway + its targets.
    //   • Create/Update/DeleteApiKeyCredentialProvider for API_KEY/BEARER auth
    //     offload, scoped to the `integration-*` provider namespace the reused
    //     credential-provider-manager uses (provider integration-<importId>-api-key).
    //   • ssm:GetParameter on the EXACT gateway-id parameter (owned by
    //     ServicesStack), resolved at RUNTIME — the same mechanism the
    //     gateway-registration handler uses; the resolver bridges the value into
    //     AGENTCORE_GATEWAY_ID for the reused gateway-target-manager delete helper.
    // GetSecretValue on /citadel/agents/* (the offload secret) is ALREADY granted
    // by the test-invoke READ grant above (no second grant). The wildcard ARNs
    // here (bedrock-agentcore gateway/* + credential-provider/integration-*) are
    // covered by the stack-level IAM5 suppression in bin/app.ts; the SSM ARN is
    // exact (no wildcard ⇒ no finding).
    agentImportResolverFunction.addEnvironment('GATEWAY_ID_PARAM', gatewayIdParamName);
    agentImportResolverFunction.addToRolePolicy(
      new iam.PolicyStatement({
        effect: iam.Effect.ALLOW,
        actions: [
          'bedrock-agentcore:CreateGatewayTarget',
          'bedrock-agentcore:DeleteGatewayTarget',
        ],
        resources: [
          `arn:aws:bedrock-agentcore:${this.region}:${this.account}:gateway/*`,
          `arn:aws:bedrock-agentcore:${this.region}:${this.account}:gateway/*/target/*`,
        ],
      })
    );
    agentImportResolverFunction.addToRolePolicy(
      new iam.PolicyStatement({
        effect: iam.Effect.ALLOW,
        actions: [
          'bedrock-agentcore:CreateApiKeyCredentialProvider',
          'bedrock-agentcore:UpdateApiKeyCredentialProvider',
          'bedrock-agentcore:DeleteApiKeyCredentialProvider',
        ],
        resources: [
          `arn:aws:bedrock-agentcore:${this.region}:${this.account}:credential-provider/integration-*`,
        ],
      })
    );
    agentImportResolverFunction.addToRolePolicy(
      new iam.PolicyStatement({
        effect: iam.Effect.ALLOW,
        actions: ['ssm:GetParameter'],
        resources: [
          `arn:aws:ssm:${this.region}:${this.account}:parameter${gatewayIdParamName}`,
        ],
      })
    );

    // EventBridge rule for gateway registration
    const gatewayRegistrationRule = new events.Rule(
      this,
      'GatewayRegistrationRule',
      {
        eventBus: this.agentEventBus,
        ruleName: `citadel-gateway-registration-${props.environment}`,
        description: 'Triggers gateway registration when integration connects/disconnects',
        eventPattern: {
          detailType: ['integration.connect.requested', 'integration.disconnect.requested'],
          source: ['citadel.integrations'],
        },
      }
    );

    gatewayRegistrationRule.addTarget(
      new targets.LambdaFunction(gatewayRegistrationHandler, {
        retryAttempts: 2,
        maxEventAge: cdk.Duration.hours(2),
      })
    );

    // Grant Cognito permissions to user management function
    userManagementResolverFunction.addToRolePolicy(
      new iam.PolicyStatement({
        effect: iam.Effect.ALLOW,
        actions: [
          'cognito-idp:ListUsers',
          'cognito-idp:AdminGetUser',
          'cognito-idp:AdminCreateUser',
          'cognito-idp:AdminAddUserToGroup',
          'cognito-idp:AdminRemoveUserFromGroup',
          'cognito-idp:AdminUpdateUserAttributes',
          'cognito-idp:AdminListGroupsForUser',
          'cognito-idp:ListGroups',
          'cognito-idp:AdminSetUserPassword',
        ],
        resources: [this.userPool.userPoolArn],
      })
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
        logGroup: new logs.LogGroup(this, 'OrganizationResolverFunctionLogs', { retention: logs.RetentionDays.ONE_WEEK, removalPolicy: cdk.RemovalPolicy.DESTROY }),
      }
    );

    // Grant DynamoDB permissions to organization management function
    organisationTable.grantReadWriteData(organizationResolverFunction);

    // Grant Cognito ListUsers for orphan-user verification before
    // deleteOrganization. Scoped to the user pool ARN — least privilege.
    organizationResolverFunction.addToRolePolicy(
      new iam.PolicyStatement({
        effect: iam.Effect.ALLOW,
        actions: ['cognito-idp:ListUsers'],
        resources: [this.userPool.userPoolArn],
      })
    );

    // Seed Organizations Custom Resource
    const seedOrganizationsLambda = new lambda.Function(this, "SeedOrganizationsFunction", {
        runtime: lambda.Runtime.PYTHON_3_14,
        handler: "index.handler",
        code: lambda.Code.fromAsset(path.join(__dirname,"../../src/lambda/seed-organizations")),
        timeout: cdk.Duration.seconds(30),
        environment: {
          ORGANISATION_TABLE: organisationTable.tableName,
        },
        logGroup: new logs.LogGroup(this, 'SeedOrganizationsFunctionLogs', { retention: logs.RetentionDays.ONE_WEEK, removalPolicy: cdk.RemovalPolicy.DESTROY }),
      });

    organisationTable.grantWriteData(seedOrganizationsLambda);

    // Create Custom Resource to seed organizations
    const seedOrganizationsResource = new cdk.CustomResource(
      this,
      "SeedOrganizationsResource",
      {
        serviceToken: seedOrganizationsLambda.functionArn,
        properties: {
          // O-05: Use content hash instead of Date.now() to avoid unnecessary re-runs
          Version: 'v1.0.0',
        },
      }
    );

    // Ensure the Custom Resource runs after the table is created
    seedOrganizationsResource.node.addDependency(organisationTable);

    // Seed Blueprints Custom Resource
    const seedBlueprintsLambda = new lambda.Function(this, "SeedBlueprintsFunction", {
      runtime: lambda.Runtime.NODEJS_24_X,
      handler: "seed-blueprints/index.handler",
      code: lambda.Code.fromAsset("dist/lambda"),
      timeout: cdk.Duration.seconds(30),
      environment: {
        WORKFLOWS_TABLE: this.workflowsTable.tableName,
      },
      logGroup: new logs.LogGroup(this, 'SeedBlueprintsFunctionLogs', { retention: logs.RetentionDays.ONE_WEEK, removalPolicy: cdk.RemovalPolicy.DESTROY }),
    });

    this.workflowsTable.grantWriteData(seedBlueprintsLambda);

    const seedBlueprintsResource = new cdk.CustomResource(
      this,
      "SeedBlueprintsResource",
      {
        serviceToken: seedBlueprintsLambda.functionArn,
        properties: {
          Version: 'v1.0.0',
        },
      }
    );

    seedBlueprintsResource.node.addDependency(this.workflowsTable);

    // Seed Model Catalog Custom Resource
    const seedModelCatalogLambda = new lambda.Function(this, "SeedModelCatalogFunction", {
      runtime: lambda.Runtime.NODEJS_24_X,
      handler: "seed-model-catalog/index.handler",
      code: lambda.Code.fromAsset("dist/lambda"),
      timeout: cdk.Duration.seconds(30),
      environment: {
        MODEL_CATALOG_TABLE: modelCatalogTable.tableName,
        MODEL_CONFIG_TABLE: modelConfigTable.tableName,
      },
      logGroup: new logs.LogGroup(this, 'SeedModelCatalogFunctionLogs', { retention: logs.RetentionDays.ONE_WEEK, removalPolicy: cdk.RemovalPolicy.DESTROY }),
    });

    modelCatalogTable.grantWriteData(seedModelCatalogLambda);
    modelConfigTable.grantWriteData(seedModelCatalogLambda);

    const seedModelCatalogResource = new cdk.CustomResource(
      this,
      "SeedModelCatalogResource",
      {
        serviceToken: seedModelCatalogLambda.functionArn,
        properties: {
          Version: 'v1.0.0',
        },
      }
    );

    seedModelCatalogResource.node.addDependency(modelCatalogTable);
    seedModelCatalogResource.node.addDependency(modelConfigTable);

    // Admin email: prefer CDK context param, fall back to env var
    const adminEmail = this.node.tryGetContext('adminEmail') || process.env.ADMIN_EMAIL || '';

    // Auto-generate admin password via Secrets Manager (never stored in code or env vars)
    const adminPasswordSecret = new cdk.aws_secretsmanager.Secret(this, 'AdminPasswordSecret', {
      secretName: `citadel/admin-password-${props.environment}`,
      description: 'Auto-generated admin user password for initial seed',
      generateSecretString: {
        secretStringTemplate: JSON.stringify({ email: adminEmail }),
        generateStringKey: 'password',
        passwordLength: 16,
        excludePunctuation: false,
      },
    });

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
          ADMIN_FIRST_NAME: process.env.ADMIN_FIRST_NAME || 'Admin',
          ADMIN_LAST_NAME: process.env.ADMIN_LAST_NAME || 'User',
          ADMIN_PASSWORD_SECRET_ARN: adminPasswordSecret.secretArn,
        },
        logGroup: new logs.LogGroup(this, 'SeedAdminUserFunctionLogs', { retention: logs.RetentionDays.ONE_WEEK, removalPolicy: cdk.RemovalPolicy.DESTROY }),
      }
    );

    // Grant read access to the admin password secret
    adminPasswordSecret.grantRead(seedAdminUserLambda);

    // Grant Cognito permissions to seed admin user function
    seedAdminUserLambda.addToRolePolicy(
      new iam.PolicyStatement({
        effect: iam.Effect.ALLOW,
        actions: [
          'cognito-idp:AdminCreateUser',
          'cognito-idp:AdminGetUser',
          'cognito-idp:AdminAddUserToGroup',
          'cognito-idp:AdminUpdateUserAttributes',
        ],
        resources: [this.userPool.userPoolArn],
      })
    );

    // Create Custom Resource to seed admin user
    const seedAdminUserResource = new cdk.CustomResource(
      this,
      "SeedAdminUserResource",
      {
        serviceToken: seedAdminUserLambda.functionArn,
        properties: {
          // O-05: Use content hash instead of Date.now() to avoid unnecessary re-runs
          Version: 'v2.0.0',
          AdminEmail: adminEmail,
        },
      }
    );

    // Output the secret ARN so deployers can retrieve the generated password
    new cdk.CfnOutput(this, 'AdminPasswordSecretArn', {
      value: adminPasswordSecret.secretArn,
      description: 'Retrieve admin password: aws secretsmanager get-secret-value --secret-id <this-arn> --query SecretString --output text',
    });

    // Ensure the Custom Resource runs after user pool and admin group are created
    seedAdminUserResource.node.addDependency(this.userPool);
    seedAdminUserResource.node.addDependency(adminGroup);

    // Grant EventBridge permissions
    this.agentEventBus.grantPutEventsTo(projectResolverFunction);
    this.agentEventBus.grantPutEventsTo(conversationResolverFunction);
    this.agentEventBus.grantPutEventsTo(agentResolverFunction);
    this.agentEventBus.grantPutEventsTo(taskRunnerResolverFunction);

    // --- Workflow, App, Execution Resolver Lambdas ---

    // Workflow Resolver Lambda
    const workflowResolverFunction = new lambda.Function(
      this,
      'WorkflowResolverFunction',
      {
        runtime: lambda.Runtime.NODEJS_24_X,
        handler: 'workflow-resolver.handler',
        code: lambda.Code.fromAsset('dist/lambda'),
        environment: {
          WORKFLOWS_TABLE: this.workflowsTable.tableName,
          APPS_TABLE: this.appsTable.tableName,
          AGENT_CONFIG_TABLE: this.agentConfigTable.tableName,
          EVENT_BUS_NAME: this.agentEventBus.eventBusName,
          USER_POOL_ID: this.userPool.userPoolId,
        },
        timeout: cdk.Duration.seconds(30),
        logGroup: new logs.LogGroup(this, 'WorkflowResolverFunctionLogs', { retention: logs.RetentionDays.ONE_WEEK, removalPolicy: cdk.RemovalPolicy.DESTROY }),
      }
    );

    // Workflow Resolver IAM — least-privilege per design 8.2
    this.workflowsTable.grantReadWriteData(workflowResolverFunction);
    this.appsTable.grantReadWriteData(workflowResolverFunction);
    this.agentConfigTable.grantReadData(workflowResolverFunction);
    this.agentEventBus.grantPutEventsTo(workflowResolverFunction);
    workflowResolverFunction.addToRolePolicy(
      new iam.PolicyStatement({
        effect: iam.Effect.ALLOW,
        actions: ['cognito-idp:AdminGetUser'],
        resources: [this.userPool.userPoolArn],
      })
    );

    // Registry Agent Record Resolver Lambda (registry-native AgentApp-shape
    // resolver — PR 6a rename of the previous `agent-app-shim-resolver.ts`).
    const registryAgentRecordResolverFunction = new lambda.Function(
      this,
      'RegistryAgentRecordResolverFunction',
      {
        runtime: lambda.Runtime.NODEJS_24_X,
        handler: 'registry-agent-record-resolver.handler',
        code: lambda.Code.fromAsset('dist/lambda'),
        functionName: `citadel-registry-agent-record-resolver-${props.environment}`,
        environment: {
          APPS_TABLE: this.appsTable.tableName,
          WORKFLOWS_TABLE: this.workflowsTable.tableName,
          AGENT_CONFIG_TABLE: this.agentConfigTable.tableName,
          EVENT_BUS_NAME: this.agentEventBus.eventBusName,
          USER_POOL_ID: this.userPool.userPoolId,
          REGISTRY_ID: registryId,
          // US-ARB-014: AuthorityUnitsTable lives on ArbiterStack. We use the
          // deterministic table name here to avoid a circular cross-stack dep
          // (ArbiterStack already depends on BackendStack outputs). The IAM
          // grant below references the table by explicit ARN pattern.
          AUTHORITY_UNITS_TABLE: `citadel-authority-units-${props.environment}`,
        },
        timeout: cdk.Duration.seconds(30),
        logGroup: new logs.LogGroup(this, 'RegistryAgentRecordResolverFunctionLogs', { retention: logs.RetentionDays.ONE_WEEK, removalPolicy: cdk.RemovalPolicy.DESTROY }),
      }
    );

    // Registry Agent Record Resolver IAM — least-privilege per design 8.2
    this.appsTable.grantReadWriteData(registryAgentRecordResolverFunction);
    this.workflowsTable.grantReadWriteData(registryAgentRecordResolverFunction);
    this.agentConfigTable.grantReadData(registryAgentRecordResolverFunction);
    this.agentEventBus.grantPutEventsTo(registryAgentRecordResolverFunction);
    // US-ARB-014: Write access (PutItem/UpdateItem) to the per-env AuthorityUnitsTable
    // owned by ArbiterStack. Referenced by explicit ARN pattern to avoid the
    // circular cross-stack dependency that a Table.grantWriteData would introduce.
    registryAgentRecordResolverFunction.addToRolePolicy(
      new iam.PolicyStatement({
        effect: iam.Effect.ALLOW,
        actions: ['dynamodb:PutItem', 'dynamodb:UpdateItem'],
        resources: [
          `arn:aws:dynamodb:${this.region}:${this.account}:table/citadel-authority-units-${props.environment}`,
        ],
      })
    );
    registryAgentRecordResolverFunction.addToRolePolicy(
      new iam.PolicyStatement({
        effect: iam.Effect.ALLOW,
        actions: ['cognito-idp:AdminGetUser'],
        resources: [this.userPool.userPoolArn],
      })
    );
    // PolicyManager needs IAM permissions to create/delete app-scoped roles (Req 4.3, 4.6)
    registryAgentRecordResolverFunction.addToRolePolicy(
      new iam.PolicyStatement({
        effect: iam.Effect.ALLOW,
        actions: [
          'iam:CreateRole',
          'iam:DeleteRole',
          'iam:PutRolePolicy',
          'iam:DeleteRolePolicy',
          'iam:GetRole',
          'iam:PassRole',
          'iam:TagRole',
          'iam:UntagRole',
        ],
        resources: [
          `arn:aws:iam::${this.account}:role/citadel-agent-*`,
          `arn:aws:iam::${this.account}:role/citadel-agent-*`,
        ],
      })
    );
    registryAgentRecordResolverFunction.addToRolePolicy(
      new iam.PolicyStatement({
        effect: iam.Effect.ALLOW,
        actions: ['sts:GetCallerIdentity'],
        resources: ['*'],
      })
    );

    // Registry API access — registryAgentRecordResolverFunction performs
    // CRUD on registry records via RegistryService (createResource,
    // getResource, updateResource, deleteResource, listResources).
    // Mirrors the policy set used by FabricatorAgent in arbiter-stack.
    registryAgentRecordResolverFunction.addToRolePolicy(
      new iam.PolicyStatement({
        effect: iam.Effect.ALLOW,
        actions: [
          'bedrock-agentcore:CreateRegistryRecord',
          'bedrock-agentcore:UpdateRegistryRecord',
          'bedrock-agentcore:UpdateRegistryRecordStatus',
          'bedrock-agentcore:SubmitRegistryRecordForApproval',
          'bedrock-agentcore:DeleteRegistryRecord',
          'bedrock-agentcore:GetRegistryRecord',
          'bedrock-agentcore:ListRegistryRecords',
        ],
        resources: [registryArn, `${registryArn}/*`],
      }),
    );

    // App Component Registration Handler — subscribes to fabrication events (Req 6.3)
    const appComponentRegistrationHandler = new lambda.Function(
      this,
      'AppComponentRegistrationHandler',
      {
        runtime: lambda.Runtime.NODEJS_24_X,
        handler: 'app-component-registration-handler.handler',
        code: lambda.Code.fromAsset('dist/lambda'),
        environment: {
          APPS_TABLE: this.appsTable.tableName,
        },
        timeout: cdk.Duration.seconds(30),
        logGroup: new logs.LogGroup(this, 'AppComponentRegistrationHandlerLogs', { retention: logs.RetentionDays.ONE_WEEK, removalPolicy: cdk.RemovalPolicy.DESTROY }),
      }
    );

    this.appsTable.grantReadWriteData(appComponentRegistrationHandler);

    const fabricationRegistrationRule = new events.Rule(this, 'FabricationRegistrationRule', {
      eventBus: this.agentEventBus,
      eventPattern: {
        detailType: ['agent.fabricated', 'tool.fabricated'],
      },
    });

    fabricationRegistrationRule.addTarget(
      new targets.LambdaFunction(appComponentRegistrationHandler, {
        retryAttempts: 2,
        maxEventAge: cdk.Duration.hours(2),
      })
    );

    // Execution Resolver Lambda
    const executionResolverFunction = new lambda.Function(
      this,
      'ExecutionResolverFunction',
      {
        runtime: lambda.Runtime.NODEJS_24_X,
        handler: 'execution-resolver.handler',
        code: lambda.Code.fromAsset('dist/lambda'),
        environment: {
          EXECUTIONS_TABLE: this.executionsTable.tableName,
          WORKFLOWS_TABLE: this.workflowsTable.tableName,
          EVENT_BUS_NAME: this.agentEventBus.eventBusName,
          USER_POOL_ID: this.userPool.userPoolId,
        },
        timeout: cdk.Duration.seconds(30),
        logGroup: new logs.LogGroup(this, 'ExecutionResolverFunctionLogs', { retention: logs.RetentionDays.ONE_WEEK, removalPolicy: cdk.RemovalPolicy.DESTROY }),
      }
    );

    // Execution Resolver IAM — least-privilege per design 8.2
    this.executionsTable.grantReadWriteData(executionResolverFunction);
    this.workflowsTable.grantReadData(executionResolverFunction);
    this.agentEventBus.grantPutEventsTo(executionResolverFunction);
    executionResolverFunction.addToRolePolicy(
      new iam.PolicyStatement({
        effect: iam.Effect.ALLOW,
        actions: ['cognito-idp:AdminGetUser'],
        resources: [this.userPool.userPoolArn],
      })
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
      schema: appsync.SchemaFile.fromAsset("src/schema/schema.graphql"),
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
    const schemaAsset = new Asset(this, 'AgenticAIApiSchemaAsset', {
      path: 'src/schema/schema.graphql',
    });
    const cfnSchema = this.appSyncApi.node.findChild('Schema') as CfnGraphQLSchema;
    cfnSchema.addPropertyDeletionOverride('Definition');
    cfnSchema.definitionS3Location = schemaAsset.s3ObjectUrl;

    // Workflow Progress Fan-out Lambda (needs AppSync endpoint)
    this.workflowProgressFanoutFunction = new lambda.Function(
      this,
      'WorkflowProgressFanoutFunction',
      {
        runtime: lambda.Runtime.NODEJS_24_X,
        handler: 'workflow-progress-fanout.handler',
        code: lambda.Code.fromAsset('dist/lambda'),
        environment: {
          APPSYNC_ENDPOINT: this.appSyncApi.graphqlUrl,
        },
        timeout: cdk.Duration.seconds(30),
        logGroup: new logs.LogGroup(this, 'WorkflowProgressFanoutFunctionLogs', { retention: logs.RetentionDays.ONE_WEEK, removalPolicy: cdk.RemovalPolicy.DESTROY }),
      }
    );

    // Fan-out IAM — least-privilege per design 8.2: appsync:GraphQL on publishWorkflowProgress
    this.workflowProgressFanoutFunction.addToRolePolicy(
      new iam.PolicyStatement({
        effect: iam.Effect.ALLOW,
        actions: ['appsync:GraphQL'],
        resources: [
          `${this.appSyncApi.arn}/types/Mutation/fields/publishWorkflowProgress`,
        ],
      })
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
        logGroup: new logs.LogGroup(this, 'AgentMessageHandlerFunctionLogs', { retention: logs.RetentionDays.ONE_WEEK, removalPolicy: cdk.RemovalPolicy.DESTROY }),
      }
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
      })
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
      })
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
      })
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
      })
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
      })
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
      }
    );

    // Add Lambda as target for the rule
    messageSentToAgentRule.addTarget(
      new targets.LambdaFunction(agentMessageHandlerFunction, {
        retryAttempts: 2,
        maxEventAge: cdk.Duration.hours(2),
      })
    );

    // Project Progress Updater Lambda
    const projectProgressUpdater = new lambda.Function(
      this,
      'ProjectProgressUpdater',
      {
        runtime: lambda.Runtime.NODEJS_24_X,
        handler: 'project-progress-updater.handler',
        code: lambda.Code.fromAsset('dist/lambda'),
        environment: {
          PROJECTS_TABLE: this.projectsTable.tableName,
          IDEMPOTENCY_TABLE: this.idempotencyTable.tableName,
        },
        timeout: cdk.Duration.seconds(30),
        logGroup: new logs.LogGroup(this, 'ProjectProgressUpdaterLogs', { retention: logs.RetentionDays.ONE_WEEK, removalPolicy: cdk.RemovalPolicy.DESTROY }),
      }
    );

    this.projectsTable.grantReadWriteData(projectProgressUpdater);
    this.idempotencyTable.grantReadWriteData(projectProgressUpdater);

    // Assessment Completion Notifier Lambda
    const assessmentCompletionNotifier = new lambda.Function(
      this,
      'AssessmentCompletionNotifier',
      {
        runtime: lambda.Runtime.NODEJS_24_X,
        handler: 'assessment-completion-notifier.handler',
        code: lambda.Code.fromAsset('dist/lambda'),
        environment: {
          APPSYNC_ENDPOINT: this.appSyncApi.graphqlUrl,
        },
        timeout: cdk.Duration.seconds(30),
        logGroup: new logs.LogGroup(this, 'AssessmentCompletionNotifierLogs', { retention: logs.RetentionDays.ONE_WEEK, removalPolicy: cdk.RemovalPolicy.DESTROY }),
      }
    );

    this.appSyncApi.grantMutation(assessmentCompletionNotifier, 'publishAssessmentCompletion');

    // Fabrication Event Handler Lambda
    const fabricationEventHandlerFunction = new lambda.Function(
      this,
      "FabricationEventHandlerFunction",
      {
        runtime: lambda.Runtime.NODEJS_24_X,
        handler: "fabrication-event-handler.handler",
        code: lambda.Code.fromAsset("dist/lambda"),
        environment: {
          APPSYNC_ENDPOINT: this.appSyncApi.graphqlUrl,
        },
        timeout: cdk.Duration.seconds(30),
        logGroup: new logs.LogGroup(this, 'FabricationEventHandlerFunctionLogs', { retention: logs.RetentionDays.ONE_WEEK, removalPolicy: cdk.RemovalPolicy.DESTROY }),
      }
    );

    // Grant AppSync permissions for fabrication event handler
    fabricationEventHandlerFunction.addToRolePolicy(
      new iam.PolicyStatement({
        effect: iam.Effect.ALLOW,
        actions: ["appsync:GraphQL"],
        resources: [
          `${this.appSyncApi.arn}/types/Mutation/fields/publishFabricationEvent`,
        ],
      })
    );

    // Create AppSync data source for fabrication event handler
    const fabricationEventLambdaDataSource = this.appSyncApi.addLambdaDataSource(
      "FabricationEventLambdaDataSource",
      fabricationEventHandlerFunction
    );

    // EventBridge rule for assessment completion
    const assessmentCompletionRule = new events.Rule(
      this,
      'AssessmentCompletionRule',
      {
        eventBus: this.agentEventBus,
        ruleName: `citadel-assessment-completion-${props.environment}`,
        description: 'Triggers when all assessment dimensions are complete',
        eventPattern: {
          detailType: ['assessment.completed'],
          source: ['citadel.assessment'],
        },
      }
    );

    assessmentCompletionRule.addTarget(
      new targets.LambdaFunction(assessmentCompletionNotifier, {
        retryAttempts: 2,
        maxEventAge: cdk.Duration.hours(2),
      })
    );

    // Design Progress Notifier Lambda
    const designProgressNotifier = new lambda.Function(
      this,
      'DesignProgressNotifier',
      {
        runtime: lambda.Runtime.NODEJS_24_X,
        handler: 'design-progress-notifier.handler',
        code: lambda.Code.fromAsset('dist/lambda'),
        environment: {
          APPSYNC_ENDPOINT: this.appSyncApi.graphqlUrl,
        },
        timeout: cdk.Duration.seconds(30),
        logGroup: new logs.LogGroup(this, 'DesignProgressNotifierLogs', { retention: logs.RetentionDays.ONE_WEEK, removalPolicy: cdk.RemovalPolicy.DESTROY }),
      }
    );

    this.appSyncApi.grantMutation(designProgressNotifier, 'publishDesignProgress');

    // EventBridge rule for design progress updates
    const designProgressRule = new events.Rule(
      this,
      'DesignProgressRule',
      {
        eventBus: this.agentEventBus,
        ruleName: `citadel-design-progress-${props.environment}`,
        description: 'Triggers when design section progress is updated',
        eventPattern: {
          detailType: ['design.progress.updated'],
          source: ['agent2.design'],
        },
      }
    );

    designProgressRule.addTarget(
      new targets.LambdaFunction(designProgressNotifier, {
        retryAttempts: 2,
        maxEventAge: cdk.Duration.hours(2),
      })
    );

    // Chatter Publisher Lambda - publishes all EventBridge messages to AppSync
    const chatterPublisherFunction = new lambda.Function(
      this,
      "ChatterPublisherFunction",
      {
        runtime: lambda.Runtime.NODEJS_24_X,
        handler: "chatter-publisher.handler",
        code: lambda.Code.fromAsset("dist/lambda"),
        environment: {
          APPSYNC_ENDPOINT: this.appSyncApi.graphqlUrl,
        },
        timeout: cdk.Duration.seconds(30),
        logGroup: new logs.LogGroup(this, 'ChatterPublisherFunctionLogs', { retention: logs.RetentionDays.ONE_WEEK, removalPolicy: cdk.RemovalPolicy.DESTROY }),
      }
    );

    // Grant AppSync permissions to chatter publisher
    chatterPublisherFunction.addToRolePolicy(
      new iam.PolicyStatement({
        effect: iam.Effect.ALLOW,
        actions: ["appsync:GraphQL"],
        resources: [
          `${this.appSyncApi.arn}/types/Mutation/fields/publishChatter`,
        ],
      })
    );

    // Chatter Resolver Lambda
    const chatterResolverFunction = new lambda.Function(
      this,
      "ChatterResolverFunction",
      {
        runtime: lambda.Runtime.NODEJS_24_X,
        handler: "chatter-resolver.handler",
        code: lambda.Code.fromAsset("dist/lambda"),
        timeout: cdk.Duration.seconds(30),
        logGroup: new logs.LogGroup(this, 'ChatterResolverFunctionLogs', { retention: logs.RetentionDays.ONE_WEEK, removalPolicy: cdk.RemovalPolicy.DESTROY }),
      }
    );

    // EventBridge rule for ALL agent chatter - captures all messages on the bus
    const chatterRule = new events.Rule(
      this,
      'ChatterRule',
      {
        eventBus: this.agentEventBus,
        ruleName: `citadel-chatter-${props.environment}`,
        description: 'Captures all agent communication for real-time display',
        // Match all events on this bus by not specifying a pattern
        eventPattern: {
          source: [ { prefix: ''} ] as any[]
        },
      }
    );

    chatterRule.addTarget(
      new targets.LambdaFunction(chatterPublisherFunction, {
        retryAttempts: 2,
        maxEventAge: cdk.Duration.hours(2),
      })
    );

    // EventBridge rule for fabrication events
    const fabricationEventRule = new events.Rule(
      this,
      'FabricationEventRule',
      {
        eventBus: this.agentEventBus,
        ruleName: `citadel-fabrication-${props.environment}`,
        description: 'Captures agent fabrication completion and error events',
        eventPattern: {
          source: ['agent.fabricated', 'agent.fabrication.failed'],
        },
      }
    );

    fabricationEventRule.addTarget(
      new targets.LambdaFunction(fabricationEventHandlerFunction, {
        retryAttempts: 2,
        maxEventAge: cdk.Duration.hours(2),
      })
    );

    // EventBridge rule for progress updates
    const progressUpdateRule = new events.Rule(
      this,
      'ProgressUpdateRule',
      {
        eventBus: this.agentEventBus,
        ruleName: `citadel-progress-update-${props.environment}`,
        description: 'Updates project progress from agent events',
        eventPattern: {
          detailType: ['intake.progress.updated'],
          source: ['agent_intake.assessment', 'agent_intake.design', 'agent_intake.planning', 'agent_intake.implementation'],
        },
      }
    );

    progressUpdateRule.addTarget(
      new targets.LambdaFunction(projectProgressUpdater, {
        retryAttempts: 2,
        maxEventAge: cdk.Duration.hours(2),
      })
    );

    // Data sources
    const projectsDataSource = this.appSyncApi.addDynamoDbDataSource(
      "ProjectsDataSource",
      this.projectsTable
    );
    const conversationsDataSource = this.appSyncApi.addDynamoDbDataSource(
      "ConversationsDataSource",
      this.conversationsTable
    );
    const agentStatusDataSource = this.appSyncApi.addDynamoDbDataSource(
      "AgentStatusDataSource",
      agentStatusTable
    );
    const projectLambdaDataSource = this.appSyncApi.addLambdaDataSource(
      "ProjectLambdaDataSource",
      projectResolverFunction
    );
    const conversationLambdaDataSource = this.appSyncApi.addLambdaDataSource(
      "ConversationLambdaDataSource",
      conversationResolverFunction
    );
    const agentLambdaDataSource = this.appSyncApi.addLambdaDataSource(
      "AgentLambdaDataSource",
      agentResolverFunction
    );
    const documentUploadLambdaDataSource = this.appSyncApi.addLambdaDataSource(
      "DocumentUploadLambdaDataSource",
      documentUploadResolverFunction
    );
    const documentLambdaDataSource = this.appSyncApi.addLambdaDataSource(
      "DocumentLambdaDataSource",
      documentResolverFunction
    );
    const agentConfigLambdaDataSource = this.appSyncApi.addLambdaDataSource(
      "AgentConfigLambdaDataSource",
      agentConfigResolverFunction
    );
    const modelConfigLambdaDataSource = this.appSyncApi.addLambdaDataSource(
      "ModelConfigLambdaDataSource",
      modelConfigResolverFunction
    );
    const agentImportLambdaDataSource = this.appSyncApi.addLambdaDataSource(
      "AgentImportLambdaDataSource",
      agentImportResolverFunction
    );
    const agentCodeLambdaDataSource = this.appSyncApi.addLambdaDataSource(
      "AgentCodeLambdaDataSource",
      agentCodeResolverFunction
    );
    const toolConfigLambdaDataSource = this.appSyncApi.addLambdaDataSource(
      "ToolConfigLambdaDataSource",
      toolConfigResolverFunction
    );
    const fabricatorRequestLambdaDataSource = this.appSyncApi.addLambdaDataSource(
      "FabricatorRequestLambdaDataSource",
      fabricatorRequestResolverFunction
    );
    const fabricatorQueueLambdaDataSource = this.appSyncApi.addLambdaDataSource(
      "FabricatorQueueLambdaDataSource",
      fabricatorQueueResolverFunction
    );
    const taskRunnerLambdaDataSource = this.appSyncApi.addLambdaDataSource(
      "TaskRunnerLambdaDataSource",
      taskRunnerResolverFunction
    );
    const userManagementLambdaDataSource = this.appSyncApi.addLambdaDataSource(
      "UserManagementLambdaDataSource",
      userManagementResolverFunction
    );
    const organizationLambdaDataSource = this.appSyncApi.addLambdaDataSource(
      "OrganizationLambdaDataSource",
      organizationResolverFunction
    );
    const chatterLambdaDataSource = this.appSyncApi.addLambdaDataSource(
      "ChatterLambdaDataSource",
      chatterResolverFunction
    );
    const integrationLambdaDataSource = this.appSyncApi.addLambdaDataSource(
      "IntegrationLambdaDataSource",
      integrationResolverFunction
    );

    // Query resolvers
    projectLambdaDataSource.createResolver("GetProjectResolver", {
      typeName: "Query",
      fieldName: "getProject",
      requestMappingTemplate: appsync.MappingTemplate.lambdaRequest(),
      responseMappingTemplate: appsync.MappingTemplate.lambdaResult(),
    });

    projectLambdaDataSource.createResolver("ListProjectsResolver", {
      typeName: "Query",
      fieldName: "listProjects",
      requestMappingTemplate: appsync.MappingTemplate.lambdaRequest(),
      responseMappingTemplate: appsync.MappingTemplate.lambdaResult(),
    });

    agentLambdaDataSource.createResolver("GetAgentStatusResolver", {
      typeName: "Query",
      fieldName: "getAgentStatus",
      requestMappingTemplate: appsync.MappingTemplate.lambdaRequest(),
      responseMappingTemplate: appsync.MappingTemplate.lambdaResult(),
    });

    conversationLambdaDataSource.createResolver(
      "GetConversationHistoryResolver",
      {
        typeName: "Query",
        fieldName: "getConversationHistory",
        requestMappingTemplate: appsync.MappingTemplate.lambdaRequest(),
        responseMappingTemplate: appsync.MappingTemplate.lambdaResult(),
      }
    );

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

    modelConfigLambdaDataSource.createResolver("SetModelCatalogEntryStatusResolver", {
      typeName: "Mutation",
      fieldName: "setModelCatalogEntryStatus",
      requestMappingTemplate: appsync.MappingTemplate.lambdaRequest(),
      responseMappingTemplate: appsync.MappingTemplate.lambdaResult(),
    });

    agentCodeLambdaDataSource.createResolver("GetAgentCodeResolver", {
      typeName: "Query",
      fieldName: "getAgentCode",
      requestMappingTemplate: appsync.MappingTemplate.lambdaRequest(),
      responseMappingTemplate: appsync.MappingTemplate.lambdaResult(),
    });

    conversationLambdaDataSource.createResolver("SendMessageResolver", {
      typeName: "Mutation",
      fieldName: "sendMessage",
      requestMappingTemplate: appsync.MappingTemplate.lambdaRequest(),
      responseMappingTemplate: appsync.MappingTemplate.lambdaResult(),
    });

    conversationLambdaDataSource.createResolver(
      "PublishConversationMessageResolver",
      {
        typeName: "Mutation",
        fieldName: "publishConversationMessage",
        requestMappingTemplate: appsync.MappingTemplate.lambdaRequest(),
        responseMappingTemplate: appsync.MappingTemplate.lambdaResult(),
      }
    );

    // Mutation resolvers
    projectLambdaDataSource.createResolver("CreateProjectResolver", {
      typeName: "Mutation",
      fieldName: "createProject",
      requestMappingTemplate: appsync.MappingTemplate.lambdaRequest(),
      responseMappingTemplate: appsync.MappingTemplate.lambdaResult(),
    });

    projectLambdaDataSource.createResolver("UpdateProjectResolver", {
      typeName: "Mutation",
      fieldName: "updateProject",
      requestMappingTemplate: appsync.MappingTemplate.lambdaRequest(),
      responseMappingTemplate: appsync.MappingTemplate.lambdaResult(),
    });

    conversationLambdaDataSource.createResolver("SendMessageToAgentResolver", {
      typeName: "Mutation",
      fieldName: "sendMessageToAgent",
      requestMappingTemplate: appsync.MappingTemplate.lambdaRequest(),
      responseMappingTemplate: appsync.MappingTemplate.lambdaResult(),
    });

    projectLambdaDataSource.createResolver("UploadDocumentResolver", {
      typeName: "Mutation",
      fieldName: "uploadDocument",
      requestMappingTemplate: appsync.MappingTemplate.lambdaRequest(),
      responseMappingTemplate: appsync.MappingTemplate.lambdaResult(),
    });

    documentUploadLambdaDataSource.createResolver("GenerateDocumentUploadUrlResolver", {
      typeName: "Mutation",
      fieldName: "generateDocumentUploadUrl",
      requestMappingTemplate: appsync.MappingTemplate.lambdaRequest(),
      responseMappingTemplate: appsync.MappingTemplate.lambdaResult(),
    });

    documentUploadLambdaDataSource.createResolver("GetDocumentIngestionStatusResolver", {
      typeName: "Query",
      fieldName: "getDocumentIngestionStatus",
      requestMappingTemplate: appsync.MappingTemplate.lambdaRequest(),
      responseMappingTemplate: appsync.MappingTemplate.lambdaResult(),
    });

    documentUploadLambdaDataSource.createResolver("ListProjectDocumentsResolver", {
      typeName: "Query",
      fieldName: "listProjectDocuments",
      requestMappingTemplate: appsync.MappingTemplate.lambdaRequest(),
      responseMappingTemplate: appsync.MappingTemplate.lambdaResult(),
    });

    documentUploadLambdaDataSource.createResolver("DeleteDocumentResolver", {
      typeName: "Mutation",
      fieldName: "deleteDocument",
      requestMappingTemplate: appsync.MappingTemplate.lambdaRequest(),
      responseMappingTemplate: appsync.MappingTemplate.lambdaResult(),
    });

    documentLambdaDataSource.createResolver("GetProjectDocumentResolver", {
      typeName: "Query",
      fieldName: "getProjectDocument",
      requestMappingTemplate: appsync.MappingTemplate.lambdaRequest(),
      responseMappingTemplate: appsync.MappingTemplate.lambdaResult(),
    });

    documentLambdaDataSource.createResolver("ListDocumentVersionsResolver", {
      typeName: "Query",
      fieldName: "listDocumentVersions",
      requestMappingTemplate: appsync.MappingTemplate.lambdaRequest(),
      responseMappingTemplate: appsync.MappingTemplate.lambdaResult(),
    });

    documentLambdaDataSource.createResolver("GetDocumentVersionResolver", {
      typeName: "Query",
      fieldName: "getDocumentVersion",
      requestMappingTemplate: appsync.MappingTemplate.lambdaRequest(),
      responseMappingTemplate: appsync.MappingTemplate.lambdaResult(),
    });

    documentLambdaDataSource.createResolver("GenerateDocumentPdfResolver", {
      typeName: "Mutation",
      fieldName: "generateDocumentPdf",
      requestMappingTemplate: appsync.MappingTemplate.lambdaRequest(),
      responseMappingTemplate: appsync.MappingTemplate.lambdaResult(),
    });

    agentConfigLambdaDataSource.createResolver("CreateAgentConfigResolver", {
      typeName: "Mutation",
      fieldName: "createAgentConfig",
      requestMappingTemplate: appsync.MappingTemplate.lambdaRequest(),
      responseMappingTemplate: appsync.MappingTemplate.lambdaResult(),
    });

    agentImportLambdaDataSource.createResolver("ImportAgentResolver", {
      typeName: "Mutation",
      fieldName: "importAgent",
      requestMappingTemplate: appsync.MappingTemplate.lambdaRequest(),
      responseMappingTemplate: appsync.MappingTemplate.lambdaResult(),
    });

    // Reuses the existing AgentImport data source — the import resolver already
    // has Registry CRUD + events:PutEvents, so no new Lambda/data source/perms.
    agentImportLambdaDataSource.createResolver("AttestAgentImportResolver", {
      typeName: "Mutation",
      fieldName: "attestAgentImport",
      requestMappingTemplate: appsync.MappingTemplate.lambdaRequest(),
      responseMappingTemplate: appsync.MappingTemplate.lambdaResult(),
    });

    agentImportLambdaDataSource.createResolver("DiscoverAgentsResolver", {
      typeName: "Query",
      fieldName: "discoverAgents",
      requestMappingTemplate: appsync.MappingTemplate.lambdaRequest(),
      responseMappingTemplate: appsync.MappingTemplate.lambdaResult(),
    });

    agentImportLambdaDataSource.createResolver("DescribeAgentCandidateResolver", {
      typeName: "Query",
      fieldName: "describeAgentCandidate",
      requestMappingTemplate: appsync.MappingTemplate.lambdaRequest(),
      responseMappingTemplate: appsync.MappingTemplate.lambdaResult(),
    });

    // Pre-activation test-invoke. Reuses the existing AgentImport data source —
    // the import resolver now also carries the account-scoped invoke +
    // GetSecretValue grants needed to invoke an operator-supplied candidate.
    agentImportLambdaDataSource.createResolver("TestImportedAgentResolver", {
      typeName: "Mutation",
      fieldName: "testImportedAgent",
      requestMappingTemplate: appsync.MappingTemplate.lambdaRequest(),
      responseMappingTemplate: appsync.MappingTemplate.lambdaResult(),
    });

    // Tier-2 sandboxed probe (probeAgentCandidate): describe() + a single
    // guarded dry-run that enriches the descriptor at confidence='medium'.
    // Reuses the existing AgentImport data source — the import resolver already
    // carries the account-scoped invoke + GetSecretValue grants (test-invoke),
    // so no new Lambda/data source/perms are required.
    agentImportLambdaDataSource.createResolver("ProbeAgentCandidateResolver", {
      typeName: "Mutation",
      fieldName: "probeAgentCandidate",
      requestMappingTemplate: appsync.MappingTemplate.lambdaRequest(),
      responseMappingTemplate: appsync.MappingTemplate.lambdaResult(),
    });

    // US-IMP-017 post-import reachability probe (probeImportReachability).
    // Reuses the existing AgentImport data source — the import resolver already
    // implements this field (agent-import-resolver.ts) and carries the Registry
    // CRUD grants it needs, so no new Lambda/data source/perms are required.
    agentImportLambdaDataSource.createResolver("ProbeImportReachabilityResolver", {
      typeName: "Mutation",
      fieldName: "probeImportReachability",
      requestMappingTemplate: appsync.MappingTemplate.lambdaRequest(),
      responseMappingTemplate: appsync.MappingTemplate.lambdaResult(),
    });

    // Tier-3 agent-import B2 — manifest-proposal REQUEST + human-gated ACCEPT.
    // Both reuse the existing AgentImport data source: the import resolver now
    // also carries the scoped sqs:SendMessage grant (propose) and already has
    // Registry CRUD (accept), so no new Lambda/data source/perms are required.
    agentImportLambdaDataSource.createResolver("ProposeAgentManifestTier3Resolver", {
      typeName: "Mutation",
      fieldName: "proposeAgentManifestTier3",
      requestMappingTemplate: appsync.MappingTemplate.lambdaRequest(),
      responseMappingTemplate: appsync.MappingTemplate.lambdaResult(),
    });

    agentImportLambdaDataSource.createResolver("AcceptProposedManifestTier3Resolver", {
      typeName: "Mutation",
      fieldName: "acceptProposedManifestTier3",
      requestMappingTemplate: appsync.MappingTemplate.lambdaRequest(),
      responseMappingTemplate: appsync.MappingTemplate.lambdaResult(),
    });

    // US-IMP-031 MCP Gateway publish/unpublish. Reuse the existing AgentImport
    // data source — the import resolver now also has the gateway-target +
    // credential-provider + gateway-id grants (see the gateway-publish IAM block
    // above), so no new Lambda/data source is required.
    agentImportLambdaDataSource.createResolver("PublishImportToGatewayResolver", {
      typeName: "Mutation",
      fieldName: "publishImportToGateway",
      requestMappingTemplate: appsync.MappingTemplate.lambdaRequest(),
      responseMappingTemplate: appsync.MappingTemplate.lambdaResult(),
    });

    agentImportLambdaDataSource.createResolver("UnpublishImportFromGatewayResolver", {
      typeName: "Mutation",
      fieldName: "unpublishImportFromGateway",
      requestMappingTemplate: appsync.MappingTemplate.lambdaRequest(),
      responseMappingTemplate: appsync.MappingTemplate.lambdaResult(),
    });

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

    agentConfigLambdaDataSource.createResolver("ActivateProjectAgentsResolver", {
      typeName: "Mutation",
      fieldName: "activateProjectAgents",
      requestMappingTemplate: appsync.MappingTemplate.lambdaRequest(),
      responseMappingTemplate: appsync.MappingTemplate.lambdaResult(),
    });

    agentConfigLambdaDataSource.createResolver("PublishAgentManifestResolver", {
      typeName: "Mutation",
      fieldName: "publishAgentManifest",
      requestMappingTemplate: appsync.MappingTemplate.lambdaRequest(),
      responseMappingTemplate: appsync.MappingTemplate.lambdaResult(),
    });

    agentCodeLambdaDataSource.createResolver("UpdateAgentCodeResolver", {
      typeName: "Mutation",
      fieldName: "updateAgentCode",
      requestMappingTemplate: appsync.MappingTemplate.lambdaRequest(),
      responseMappingTemplate: appsync.MappingTemplate.lambdaResult(),
    });

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

    // Fabricator Request Resolvers
    fabricatorRequestLambdaDataSource.createResolver("RequestAgentCreationResolver", {
      typeName: "Mutation",
      fieldName: "requestAgentCreation",
      requestMappingTemplate: appsync.MappingTemplate.lambdaRequest(),
      responseMappingTemplate: appsync.MappingTemplate.lambdaResult(),
    });

    fabricatorRequestLambdaDataSource.createResolver("RequestToolCreationResolver", {
      typeName: "Mutation",
      fieldName: "requestToolCreation",
      requestMappingTemplate: appsync.MappingTemplate.lambdaRequest(),
      responseMappingTemplate: appsync.MappingTemplate.lambdaResult(),
    });

    // Fabricator Queue Resolver
    fabricatorQueueLambdaDataSource.createResolver("GetFabricatorQueueResolver", {
      typeName: "Query",
      fieldName: "getFabricatorQueue",
      requestMappingTemplate: appsync.MappingTemplate.lambdaRequest(),
      responseMappingTemplate: appsync.MappingTemplate.lambdaResult(),
    });

    // Fabrication Event Resolver
    fabricationEventLambdaDataSource.createResolver("PublishFabricationEventResolver", {
      typeName: "Mutation",
      fieldName: "publishFabricationEvent",
      requestMappingTemplate: appsync.MappingTemplate.lambdaRequest(),
      responseMappingTemplate: appsync.MappingTemplate.lambdaResult(),
    });

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

    userManagementLambdaDataSource.createResolver("GetCurrentUserProfileResolver", {
      typeName: "Query",
      fieldName: "getCurrentUserProfile",
      requestMappingTemplate: appsync.MappingTemplate.lambdaRequest(),
      responseMappingTemplate: appsync.MappingTemplate.lambdaResult(),
    });

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

    userManagementLambdaDataSource.createResolver("ListAvailableRolesResolver", {
      typeName: "Query",
      fieldName: "listAvailableRoles",
      requestMappingTemplate: appsync.MappingTemplate.lambdaRequest(),
      responseMappingTemplate: appsync.MappingTemplate.lambdaResult(),
    });

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

    userManagementLambdaDataSource.createResolver("AdminResetUserPasswordResolver", {
      typeName: "Mutation",
      fieldName: "adminResetUserPassword",
      requestMappingTemplate: appsync.MappingTemplate.lambdaRequest(),
      responseMappingTemplate: appsync.MappingTemplate.lambdaResult(),
    });

    userManagementLambdaDataSource.createResolver("AdminCreateUserResolver", {
      typeName: "Mutation",
      fieldName: "adminCreateUser",
      requestMappingTemplate: appsync.MappingTemplate.lambdaRequest(),
      responseMappingTemplate: appsync.MappingTemplate.lambdaResult(),
    });

    userManagementLambdaDataSource.createResolver("AdminResendInvitationResolver", {
      typeName: "Mutation",
      fieldName: "adminResendInvitation",
      requestMappingTemplate: appsync.MappingTemplate.lambdaRequest(),
      responseMappingTemplate: appsync.MappingTemplate.lambdaResult(),
    });

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

    // Chatter Resolver
    chatterLambdaDataSource.createResolver("PublishChatterResolver", {
      typeName: "Mutation",
      fieldName: "publishChatter",
      requestMappingTemplate: appsync.MappingTemplate.lambdaRequest(),
      responseMappingTemplate: appsync.MappingTemplate.lambdaResult(),
    });

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

    integrationLambdaDataSource.createResolver("DisconnectIntegrationResolver", {
      typeName: "Mutation",
      fieldName: "disconnectIntegration",
      requestMappingTemplate: appsync.MappingTemplate.lambdaRequest(),
      responseMappingTemplate: appsync.MappingTemplate.lambdaResult(),
    });

    // Assessment Completion Resolver
    const assessmentCompletionResolverFunction = new lambda.Function(
      this,
      "AssessmentCompletionResolverFunction",
      {
        runtime: lambda.Runtime.NODEJS_24_X,
        handler: "assessment-completion-resolver.handler",
        code: lambda.Code.fromAsset("dist/lambda"),
        timeout: cdk.Duration.seconds(30),
        logGroup: new logs.LogGroup(this, 'AssessmentCompletionResolverFunctionLogs', { retention: logs.RetentionDays.ONE_WEEK, removalPolicy: cdk.RemovalPolicy.DESTROY }),
      }
    );

    const assessmentCompletionLambdaDataSource = this.appSyncApi.addLambdaDataSource(
      "AssessmentCompletionLambdaDataSource",
      assessmentCompletionResolverFunction
    );

    assessmentCompletionLambdaDataSource.createResolver("PublishAssessmentCompletionResolver", {
      typeName: "Mutation",
      fieldName: "publishAssessmentCompletion",
      requestMappingTemplate: appsync.MappingTemplate.lambdaRequest(),
      responseMappingTemplate: appsync.MappingTemplate.lambdaResult(),
    });

    // Assessment Progress Resolver
    const sessionMemoryTableName = `citadel-session-memory-${props.environment}`;
    const sessionMemoryTableArn = `arn:aws:dynamodb:${this.region}:${this.account}:table/citadel-session-memory-${props.environment}`;

    const assessmentProgressResolverFunction = new lambda.Function(
      this,
      "AssessmentProgressResolverFunction",
      {
        runtime: lambda.Runtime.NODEJS_24_X,
        handler: "assessment-progress-resolver.handler",
        code: lambda.Code.fromAsset("dist/lambda"),
        environment: {
          SESSION_MEMORY_TABLE: sessionMemoryTableName,
        },
        timeout: cdk.Duration.seconds(30),
        logGroup: new logs.LogGroup(this, 'AssessmentProgressResolverFunctionLogs', { retention: logs.RetentionDays.ONE_WEEK, removalPolicy: cdk.RemovalPolicy.DESTROY }),
      }
    );

    assessmentProgressResolverFunction.addToRolePolicy(
      new iam.PolicyStatement({
        effect: iam.Effect.ALLOW,
        actions: ['dynamodb:GetItem', 'dynamodb:Query'],
        resources: [sessionMemoryTableArn],
      })
    );

    const assessmentProgressLambdaDataSource = this.appSyncApi.addLambdaDataSource(
      "AssessmentProgressLambdaDataSource",
      assessmentProgressResolverFunction
    );

    assessmentProgressLambdaDataSource.createResolver("GetAssessmentProgressResolver", {
      typeName: "Query",
      fieldName: "getAssessmentProgress",
      requestMappingTemplate: appsync.MappingTemplate.lambdaRequest(),
      responseMappingTemplate: appsync.MappingTemplate.lambdaResult(),
    });

    // Design Progress Resolver
    const designProgressResolverFunction = new lambda.Function(
      this,
      "DesignProgressResolverFunction",
      {
        runtime: lambda.Runtime.NODEJS_24_X,
        handler: "design-progress-resolver.handler",
        code: lambda.Code.fromAsset("dist/lambda"),
        timeout: cdk.Duration.seconds(30),
        logGroup: new logs.LogGroup(this, 'DesignProgressResolverFunctionLogs', { retention: logs.RetentionDays.ONE_WEEK, removalPolicy: cdk.RemovalPolicy.DESTROY }),
      }
    );

    const designProgressLambdaDataSource = this.appSyncApi.addLambdaDataSource(
      "DesignProgressLambdaDataSource",
      designProgressResolverFunction
    );

    designProgressLambdaDataSource.createResolver("PublishDesignProgressResolver", {
      typeName: "Mutation",
      fieldName: "publishDesignProgress",
      requestMappingTemplate: appsync.MappingTemplate.lambdaRequest(),
      responseMappingTemplate: appsync.MappingTemplate.lambdaResult(),
    });

    // Report Download URL Generator
    const sessionBucketName = `citadel-sessions-${props.environment}-${this.account}-${this.region}`;

    const generateReportUrlFunction = new lambda.Function(
      this,
      "GenerateReportUrlFunction",
      {
        runtime: lambda.Runtime.NODEJS_24_X,
        handler: "generate-report-url.handler",
        code: lambda.Code.fromAsset("dist/lambda"),
        environment: {
          SESSION_BUCKET: sessionBucketName,
          PROJECTS_TABLE: this.projectsTable.tableName,
        },
        timeout: cdk.Duration.seconds(30),
        logGroup: new logs.LogGroup(this, 'GenerateReportUrlFunctionLogs', { retention: logs.RetentionDays.ONE_WEEK, removalPolicy: cdk.RemovalPolicy.DESTROY }),
      }
    );

    generateReportUrlFunction.addToRolePolicy(
      new iam.PolicyStatement({
        effect: iam.Effect.ALLOW,
        actions: ['s3:GetObject', 's3:ListBucket'],
        resources: [
          `arn:aws:s3:::${sessionBucketName}/*`,
          `arn:aws:s3:::${sessionBucketName}`
        ],
      })
    );
    this.projectsTable.grantReadData(generateReportUrlFunction);

    const generateReportUrlDataSource = this.appSyncApi.addLambdaDataSource(
      "GenerateReportUrlDataSource",
      generateReportUrlFunction
    );

    generateReportUrlDataSource.createResolver("GenerateReportDownloadUrlResolver", {
      typeName: "Query",
      fieldName: "generateReportDownloadUrl",
      requestMappingTemplate: appsync.MappingTemplate.lambdaRequest(),
      responseMappingTemplate: appsync.MappingTemplate.lambdaResult(),
    });

    // DataStores Table
    const dataStoresTable = new dynamodb.Table(this, 'DataStoresTable', {
      tableName: `citadel-datastores-${props.environment}`,
      partitionKey: { name: 'dataStoreId', type: dynamodb.AttributeType.STRING },
      billingMode: dynamodb.BillingMode.PAY_PER_REQUEST,
      removalPolicy: cdk.RemovalPolicy.DESTROY,
      pointInTimeRecoverySpecification: { pointInTimeRecoveryEnabled: true },
    });

    dataStoresTable.addGlobalSecondaryIndex({
      indexName: 'OrgIndex',
      partitionKey: { name: 'orgId', type: dynamodb.AttributeType.STRING },
      sortKey: { name: 'createdAt', type: dynamodb.AttributeType.STRING },
      projectionType: dynamodb.ProjectionType.ALL,
    });

    // DataStore Resolver Lambda
    const dataStoreResolverFunction = new lambda.Function(
      this,
      'DataStoreResolverFunction',
      {
        runtime: lambda.Runtime.NODEJS_24_X,
        handler: 'datastore-resolver.handler',
        code: lambda.Code.fromAsset('dist/lambda'),
        environment: {
          DATASTORES_TABLE: dataStoresTable.tableName,
          ENVIRONMENT: props.environment,
          HEALTH_MONITOR_ROLE_PARAM: `/citadel/health-monitor-role-${props.environment}`,
        },
        timeout: cdk.Duration.minutes(10),
        memorySize: 256,
        logGroup: new logs.LogGroup(this, 'DataStoreResolverFunctionLogs', { retention: logs.RetentionDays.ONE_WEEK, removalPolicy: cdk.RemovalPolicy.DESTROY }),
      }
    );

    // Grant DynamoDB permissions
    dataStoresTable.grantReadWriteData(dataStoreResolverFunction);

    // Grant Secrets Manager permissions
    dataStoreResolverFunction.addToRolePolicy(
      new iam.PolicyStatement({
        effect: iam.Effect.ALLOW,
        actions: [
          'secretsmanager:CreateSecret',
          'secretsmanager:UpdateSecret',
          'secretsmanager:DeleteSecret',
          'secretsmanager:GetSecretValue',
        ],
        resources: [
          `arn:aws:secretsmanager:${this.region}:${this.account}:secret:/citadel/datastores/*`,
        ],
      })
    );

    // Grant IAM permissions for PolicyManager
    dataStoreResolverFunction.addToRolePolicy(
      new iam.PolicyStatement({
        effect: iam.Effect.ALLOW,
        actions: [
          'iam:CreateRole',
          'iam:DeleteRole',
          'iam:GetRole',
          'iam:PutRolePolicy',
          'iam:DeleteRolePolicy',
          'iam:TagRole',
          'iam:PassRole',
        ],
        resources: [
          `arn:aws:iam::${this.account}:role/citadel-ds-*`,
        ],
      })
    );

    // Grant STS permissions for PolicyManager
    dataStoreResolverFunction.addToRolePolicy(
          new iam.PolicyStatement({
            effect: iam.Effect.ALLOW,
            actions: ['sts:AssumeRole'],
            resources: [`arn:aws:iam::${this.account}:role/citadel-ds-*`],
          })
        );
        dataStoreResolverFunction.addToRolePolicy(
          new iam.PolicyStatement({
            effect: iam.Effect.ALLOW,
            actions: ['sts:GetCallerIdentity'],
            resources: ['*'],
          })
        );

    // Grant SSM read for health monitor role ARN lookup
    dataStoreResolverFunction.addToRolePolicy(
      new iam.PolicyStatement({
        effect: iam.Effect.ALLOW,
        actions: ['ssm:GetParameter'],
        resources: [`arn:aws:ssm:${this.region}:${this.account}:parameter/citadel/health-monitor-role-${props.environment}`],
      })
    );

    // Grant Bedrock permissions for Knowledge Base adapter (uses Lambda creds directly)
    dataStoreResolverFunction.addToRolePolicy(
      new iam.PolicyStatement({
        effect: iam.Effect.ALLOW,
        actions: [
          'bedrock:CreateKnowledgeBase',
          'bedrock:DeleteKnowledgeBase',
          'bedrock:GetKnowledgeBase',
          'bedrock:Retrieve',
          'bedrock:AssociateThirdPartyKnowledgeBase',
        ],
        resources: ['*'],
      })
    );

    // Grant OpenSearch Serverless permissions for Knowledge Base vector store provisioning
    dataStoreResolverFunction.addToRolePolicy(
      new iam.PolicyStatement({
        effect: iam.Effect.ALLOW,
        actions: [
          'aoss:CreateCollection',
          'aoss:DeleteCollection',
          'aoss:BatchGetCollection',
          'aoss:CreateSecurityPolicy',
          'aoss:GetSecurityPolicy',
          'aoss:CreateAccessPolicy',
          'aoss:GetAccessPolicy',
          'aoss:APIAccessAll',
        ],
        resources: ['*'],
      })
    );

    // DataStore AppSync data source and resolvers
    const dataStoreLambdaDataSource = this.appSyncApi.addLambdaDataSource(
      'DataStoreLambdaDataSource',
      dataStoreResolverFunction
    );

    // Query resolvers (3)
    dataStoreLambdaDataSource.createResolver('ListDataStoresResolver', {
      typeName: 'Query',
      fieldName: 'listDataStores',
      requestMappingTemplate: appsync.MappingTemplate.lambdaRequest(),
      responseMappingTemplate: appsync.MappingTemplate.lambdaResult(),
    });

    dataStoreLambdaDataSource.createResolver('GetDataStoreResolver', {
      typeName: 'Query',
      fieldName: 'getDataStore',
      requestMappingTemplate: appsync.MappingTemplate.lambdaRequest(),
      responseMappingTemplate: appsync.MappingTemplate.lambdaResult(),
    });

    dataStoreLambdaDataSource.createResolver('GetDataStoreStatsResolver', {
      typeName: 'Query',
      fieldName: 'getDataStoreStats',
      requestMappingTemplate: appsync.MappingTemplate.lambdaRequest(),
      responseMappingTemplate: appsync.MappingTemplate.lambdaResult(),
    });

    // Mutation resolvers (7)
    dataStoreLambdaDataSource.createResolver('CreateDataStoreResolver', {
      typeName: 'Mutation',
      fieldName: 'createDataStore',
      requestMappingTemplate: appsync.MappingTemplate.lambdaRequest(),
      responseMappingTemplate: appsync.MappingTemplate.lambdaResult(),
    });

    dataStoreLambdaDataSource.createResolver('UpdateDataStoreResolver', {
      typeName: 'Mutation',
      fieldName: 'updateDataStore',
      requestMappingTemplate: appsync.MappingTemplate.lambdaRequest(),
      responseMappingTemplate: appsync.MappingTemplate.lambdaResult(),
    });

    dataStoreLambdaDataSource.createResolver('DeleteDataStoreResolver', {
      typeName: 'Mutation',
      fieldName: 'deleteDataStore',
      requestMappingTemplate: appsync.MappingTemplate.lambdaRequest(),
      responseMappingTemplate: appsync.MappingTemplate.lambdaResult(),
    });

    dataStoreLambdaDataSource.createResolver('ConnectDataStoreResolver', {
      typeName: 'Mutation',
      fieldName: 'connectDataStore',
      requestMappingTemplate: appsync.MappingTemplate.lambdaRequest(),
      responseMappingTemplate: appsync.MappingTemplate.lambdaResult(),
    });

    dataStoreLambdaDataSource.createResolver('DisconnectDataStoreResolver', {
      typeName: 'Mutation',
      fieldName: 'disconnectDataStore',
      requestMappingTemplate: appsync.MappingTemplate.lambdaRequest(),
      responseMappingTemplate: appsync.MappingTemplate.lambdaResult(),
    });

    dataStoreLambdaDataSource.createResolver('TestDataStoreConnectionResolver', {
      typeName: 'Mutation',
      fieldName: 'testDataStoreConnection',
      requestMappingTemplate: appsync.MappingTemplate.lambdaRequest(),
      responseMappingTemplate: appsync.MappingTemplate.lambdaResult(),
    });

    // Subscription resolvers (handled by AppSync automatically with proper schema)

    // --- Workflow, App, Execution AppSync Data Sources & Resolvers ---

    const workflowLambdaDataSource = this.appSyncApi.addLambdaDataSource(
      'WorkflowLambdaDataSource',
      workflowResolverFunction
    );

    const registryAgentRecordLambdaDataSource = this.appSyncApi.addLambdaDataSource(
      'RegistryAgentRecordLambdaDataSource',
      registryAgentRecordResolverFunction
    );

    const executionLambdaDataSource = this.appSyncApi.addLambdaDataSource(
      'ExecutionLambdaDataSource',
      executionResolverFunction
    );

    // Workflow Resolver — Query resolvers
    workflowLambdaDataSource.createResolver('GetWorkflowResolver', {
      typeName: 'Query',
      fieldName: 'getWorkflow',
      requestMappingTemplate: appsync.MappingTemplate.lambdaRequest(),
      responseMappingTemplate: appsync.MappingTemplate.lambdaResult(),
    });

    workflowLambdaDataSource.createResolver('ListWorkflowsResolver', {
      typeName: 'Query',
      fieldName: 'listWorkflows',
      requestMappingTemplate: appsync.MappingTemplate.lambdaRequest(),
      responseMappingTemplate: appsync.MappingTemplate.lambdaResult(),
    });

    workflowLambdaDataSource.createResolver('ListBlueprintsResolver', {
      typeName: 'Query',
      fieldName: 'listBlueprints',
      requestMappingTemplate: appsync.MappingTemplate.lambdaRequest(),
      responseMappingTemplate: appsync.MappingTemplate.lambdaResult(),
    });

    workflowLambdaDataSource.createResolver('ExportWorkflowResolver', {
      typeName: 'Query',
      fieldName: 'exportWorkflow',
      requestMappingTemplate: appsync.MappingTemplate.lambdaRequest(),
      responseMappingTemplate: appsync.MappingTemplate.lambdaResult(),
    });

    workflowLambdaDataSource.createResolver('GetWorkflowVersionResolver', {
      typeName: 'Query',
      fieldName: 'getWorkflowVersion',
      requestMappingTemplate: appsync.MappingTemplate.lambdaRequest(),
      responseMappingTemplate: appsync.MappingTemplate.lambdaResult(),
    });

    workflowLambdaDataSource.createResolver('ListAppWorkflowsResolver', {
      typeName: 'Query',
      fieldName: 'listAppWorkflows',
      requestMappingTemplate: appsync.MappingTemplate.lambdaRequest(),
      responseMappingTemplate: appsync.MappingTemplate.lambdaResult(),
    });

    // Workflow Resolver — Mutation resolvers
    workflowLambdaDataSource.createResolver('CreateWorkflowResolver', {
      typeName: 'Mutation',
      fieldName: 'createWorkflow',
      requestMappingTemplate: appsync.MappingTemplate.lambdaRequest(),
      responseMappingTemplate: appsync.MappingTemplate.lambdaResult(),
    });

    workflowLambdaDataSource.createResolver('UpdateWorkflowResolver', {
      typeName: 'Mutation',
      fieldName: 'updateWorkflow',
      requestMappingTemplate: appsync.MappingTemplate.lambdaRequest(),
      responseMappingTemplate: appsync.MappingTemplate.lambdaResult(),
    });

    workflowLambdaDataSource.createResolver('DeleteWorkflowResolver', {
      typeName: 'Mutation',
      fieldName: 'deleteWorkflow',
      requestMappingTemplate: appsync.MappingTemplate.lambdaRequest(),
      responseMappingTemplate: appsync.MappingTemplate.lambdaResult(),
    });

    workflowLambdaDataSource.createResolver('PublishWorkflowResolver', {
      typeName: 'Mutation',
      fieldName: 'publishWorkflow',
      requestMappingTemplate: appsync.MappingTemplate.lambdaRequest(),
      responseMappingTemplate: appsync.MappingTemplate.lambdaResult(),
    });

    workflowLambdaDataSource.createResolver('UpdateWorkflowConfigurationResolver', {
      typeName: 'Mutation',
      fieldName: 'updateWorkflowConfiguration',
      requestMappingTemplate: appsync.MappingTemplate.lambdaRequest(),
      responseMappingTemplate: appsync.MappingTemplate.lambdaResult(),
    });

    workflowLambdaDataSource.createResolver('ImportBlueprintResolver', {
      typeName: 'Mutation',
      fieldName: 'importBlueprint',
      requestMappingTemplate: appsync.MappingTemplate.lambdaRequest(),
      responseMappingTemplate: appsync.MappingTemplate.lambdaResult(),
    });

    workflowLambdaDataSource.createResolver('ImportWorkflowResolver', {
      typeName: 'Mutation',
      fieldName: 'importWorkflow',
      requestMappingTemplate: appsync.MappingTemplate.lambdaRequest(),
      responseMappingTemplate: appsync.MappingTemplate.lambdaResult(),
    });

    // App Resolver — Query resolvers
    registryAgentRecordLambdaDataSource.createResolver('GetAppResolver', {
      typeName: 'Query',
      fieldName: 'getApp',
      requestMappingTemplate: appsync.MappingTemplate.lambdaRequest(),
      responseMappingTemplate: appsync.MappingTemplate.lambdaResult(),
    });

    registryAgentRecordLambdaDataSource.createResolver('ListAppsResolver', {
      typeName: 'Query',
      fieldName: 'listApps',
      requestMappingTemplate: appsync.MappingTemplate.lambdaRequest(),
      responseMappingTemplate: appsync.MappingTemplate.lambdaResult(),
    });

    // App Resolver — Mutation resolvers
    registryAgentRecordLambdaDataSource.createResolver('CreateAppResolver', {
      typeName: 'Mutation',
      fieldName: 'createApp',
      requestMappingTemplate: appsync.MappingTemplate.lambdaRequest(),
      responseMappingTemplate: appsync.MappingTemplate.lambdaResult(),
    });

    registryAgentRecordLambdaDataSource.createResolver('UpdateAppResolver', {
      typeName: 'Mutation',
      fieldName: 'updateApp',
      requestMappingTemplate: appsync.MappingTemplate.lambdaRequest(),
      responseMappingTemplate: appsync.MappingTemplate.lambdaResult(),
    });

    registryAgentRecordLambdaDataSource.createResolver('DeleteAppResolver', {
      typeName: 'Mutation',
      fieldName: 'deleteApp',
      requestMappingTemplate: appsync.MappingTemplate.lambdaRequest(),
      responseMappingTemplate: appsync.MappingTemplate.lambdaResult(),
    });

    registryAgentRecordLambdaDataSource.createResolver('BindWorkflowToAppResolver', {
      typeName: 'Mutation',
      fieldName: 'bindWorkflowToApp',
      requestMappingTemplate: appsync.MappingTemplate.lambdaRequest(),
      responseMappingTemplate: appsync.MappingTemplate.lambdaResult(),
    });

    registryAgentRecordLambdaDataSource.createResolver('UnbindWorkflowFromAppResolver', {
      typeName: 'Mutation',
      fieldName: 'unbindWorkflowFromApp',
      requestMappingTemplate: appsync.MappingTemplate.lambdaRequest(),
      responseMappingTemplate: appsync.MappingTemplate.lambdaResult(),
    });

    registryAgentRecordLambdaDataSource.createResolver('UpdateAgentBindingResolver', {
      typeName: 'Mutation',
      fieldName: 'updateAgentBinding',
      requestMappingTemplate: appsync.MappingTemplate.lambdaRequest(),
      responseMappingTemplate: appsync.MappingTemplate.lambdaResult(),
    });

    registryAgentRecordLambdaDataSource.createResolver('AddAppComponentResolver', {
      typeName: 'Mutation',
      fieldName: 'addAppComponent',
      requestMappingTemplate: appsync.MappingTemplate.lambdaRequest(),
      responseMappingTemplate: appsync.MappingTemplate.lambdaResult(),
    });

    registryAgentRecordLambdaDataSource.createResolver('RemoveAppComponentResolver', {
      typeName: 'Mutation',
      fieldName: 'removeAppComponent',
      requestMappingTemplate: appsync.MappingTemplate.lambdaRequest(),
      responseMappingTemplate: appsync.MappingTemplate.lambdaResult(),
    });

    registryAgentRecordLambdaDataSource.createResolver('SetAppConfigSchemaResolver', {
      typeName: 'Mutation',
      fieldName: 'setAppConfigSchema',
      requestMappingTemplate: appsync.MappingTemplate.lambdaRequest(),
      responseMappingTemplate: appsync.MappingTemplate.lambdaResult(),
    });

    registryAgentRecordLambdaDataSource.createResolver('SetAppConfigValuesResolver', {
      typeName: 'Mutation',
      fieldName: 'setAppConfigValues',
      requestMappingTemplate: appsync.MappingTemplate.lambdaRequest(),
      responseMappingTemplate: appsync.MappingTemplate.lambdaResult(),
    });

    registryAgentRecordLambdaDataSource.createResolver('PublishAppStatusEventResolver', {
      typeName: 'Mutation',
      fieldName: 'publishAppStatusEvent',
      requestMappingTemplate: appsync.MappingTemplate.lambdaRequest(),
      responseMappingTemplate: appsync.MappingTemplate.lambdaResult(),
    });

    // API Key Management resolvers
    registryAgentRecordLambdaDataSource.createResolver('CreateAppApiKeyResolver', {
      typeName: 'Mutation',
      fieldName: 'createAppApiKey',
      requestMappingTemplate: appsync.MappingTemplate.lambdaRequest(),
      responseMappingTemplate: appsync.MappingTemplate.lambdaResult(),
    });

    registryAgentRecordLambdaDataSource.createResolver('RevokeAppApiKeyResolver', {
      typeName: 'Mutation',
      fieldName: 'revokeAppApiKey',
      requestMappingTemplate: appsync.MappingTemplate.lambdaRequest(),
      responseMappingTemplate: appsync.MappingTemplate.lambdaResult(),
    });

    registryAgentRecordLambdaDataSource.createResolver('RotateAppApiKeyResolver', {
      typeName: 'Mutation',
      fieldName: 'rotateAppApiKey',
      requestMappingTemplate: appsync.MappingTemplate.lambdaRequest(),
      responseMappingTemplate: appsync.MappingTemplate.lambdaResult(),
    });

    registryAgentRecordLambdaDataSource.createResolver('ListAppApiKeysResolver', {
      typeName: 'Query',
      fieldName: 'listAppApiKeys',
      requestMappingTemplate: appsync.MappingTemplate.lambdaRequest(),
      responseMappingTemplate: appsync.MappingTemplate.lambdaResult(),
    });

    // Auth Config resolver
    registryAgentRecordLambdaDataSource.createResolver('SetAppAuthConfigResolver', {
      typeName: 'Mutation',
      fieldName: 'setAppAuthConfig',
      requestMappingTemplate: appsync.MappingTemplate.lambdaRequest(),
      responseMappingTemplate: appsync.MappingTemplate.lambdaResult(),
    });

    // Access Control resolvers
    registryAgentRecordLambdaDataSource.createResolver('GrantAppAccessResolver', {
      typeName: 'Mutation',
      fieldName: 'grantAppAccess',
      requestMappingTemplate: appsync.MappingTemplate.lambdaRequest(),
      responseMappingTemplate: appsync.MappingTemplate.lambdaResult(),
    });

    registryAgentRecordLambdaDataSource.createResolver('RevokeAppAccessResolver', {
      typeName: 'Mutation',
      fieldName: 'revokeAppAccess',
      requestMappingTemplate: appsync.MappingTemplate.lambdaRequest(),
      responseMappingTemplate: appsync.MappingTemplate.lambdaResult(),
    });

    registryAgentRecordLambdaDataSource.createResolver('ListAppAccessEntriesResolver', {
      typeName: 'Query',
      fieldName: 'listAppAccessEntries',
      requestMappingTemplate: appsync.MappingTemplate.lambdaRequest(),
      responseMappingTemplate: appsync.MappingTemplate.lambdaResult(),
    });

    // Metrics resolver
    registryAgentRecordLambdaDataSource.createResolver('GetAppMetricsResolver', {
      typeName: 'Query',
      fieldName: 'getAppMetrics',
      requestMappingTemplate: appsync.MappingTemplate.lambdaRequest(),
      responseMappingTemplate: appsync.MappingTemplate.lambdaResult(),
    });

    // Execution Resolver — Query resolvers
    executionLambdaDataSource.createResolver('GetExecutionResolver', {
      typeName: 'Query',
      fieldName: 'getExecution',
      requestMappingTemplate: appsync.MappingTemplate.lambdaRequest(),
      responseMappingTemplate: appsync.MappingTemplate.lambdaResult(),
    });

    executionLambdaDataSource.createResolver('ListExecutionsResolver', {
      typeName: 'Query',
      fieldName: 'listExecutions',
      requestMappingTemplate: appsync.MappingTemplate.lambdaRequest(),
      responseMappingTemplate: appsync.MappingTemplate.lambdaResult(),
    });

    // Execution Resolver — Mutation resolvers
    executionLambdaDataSource.createResolver('StartExecutionResolver', {
      typeName: 'Mutation',
      fieldName: 'startExecution',
      requestMappingTemplate: appsync.MappingTemplate.lambdaRequest(),
      responseMappingTemplate: appsync.MappingTemplate.lambdaResult(),
    });

    executionLambdaDataSource.createResolver('CancelExecutionResolver', {
      typeName: 'Mutation',
      fieldName: 'cancelExecution',
      requestMappingTemplate: appsync.MappingTemplate.lambdaRequest(),
      responseMappingTemplate: appsync.MappingTemplate.lambdaResult(),
    });

    // publishWorkflowProgress — IAM-only mutation called by fan-out Lambda
    executionLambdaDataSource.createResolver('PublishWorkflowProgressResolver', {
      typeName: 'Mutation',
      fieldName: 'publishWorkflowProgress',
      requestMappingTemplate: appsync.MappingTemplate.lambdaRequest(),
      responseMappingTemplate: appsync.MappingTemplate.lambdaResult(),
    });

    // Outputs
    new cdk.CfnOutput(this, "GraphQLApiUrl", {
      value: this.appSyncApi.graphqlUrl,
      description: "GraphQL API URL",
    });

    // O-03: Enable X-Ray active tracing on all Lambda functions
    // O-02: Add Powertools structured logging env vars to all Lambda functions
    this.node.findAll().forEach((child) => {
      if (child instanceof lambda.Function) {
        child.addEnvironment('POWERTOOLS_LOG_LEVEL', 'INFO');
        child.addEnvironment('POWERTOOLS_SERVICE_NAME', 'citadel');
        (child as lambda.Function).addEnvironment('AWS_LAMBDA_EXEC_WRAPPER', '');
        const cfnFunction = child.node.defaultChild as lambda.CfnFunction;
        if (cfnFunction &&!cfnFunction.tracingConfig) {
          cfnFunction.addPropertyOverride('TracingConfig', { Mode: 'Active' });
        }
      }
    });

    // O-01: CloudWatch alarms for operational visibility
    const alarmTopic = new sns.Topic(this, 'AlarmTopic', {
          topicName: `citadel-alarms-${props.environment}`,
          displayName: 'Citadel Alarms',
          enforceSSL: true,
        });

    // Lambda error alarms for critical functions
    const criticalFunctions = [
      { fn: projectResolverFunction, name: 'ProjectResolver' },
      { fn: agentMessageHandlerFunction, name: 'AgentMessageHandler' },
      { fn: gatewayRegistrationHandler, name: 'GatewayRegistration' },
      { fn: integrationResolverFunction, name: 'IntegrationResolver' },
    ];

    for (const { fn, name } of criticalFunctions) {
      new cloudwatch.Alarm(this, `${name}ErrorAlarm`, {
        alarmName: `citadel-${name}-errors-${props.environment}`,
        metric: fn.metricErrors({ period: cdk.Duration.minutes(5) }),
        threshold: 5,
        evaluationPeriods: 1,
        comparisonOperator: cloudwatch.ComparisonOperator.GREATER_THAN_OR_EQUAL_TO_THRESHOLD,
        treatMissingData: cloudwatch.TreatMissingData.NOT_BREACHING,
        alarmDescription: `${name} Lambda error rate exceeded threshold`,
      });

      new cloudwatch.Alarm(this, `${name}ThrottleAlarm`, {
        alarmName: `citadel-${name}-throttles-${props.environment}`,
        metric: fn.metricThrottles({ period: cdk.Duration.minutes(5) }),
        threshold: 3,
        evaluationPeriods: 1,
        comparisonOperator: cloudwatch.ComparisonOperator.GREATER_THAN_OR_EQUAL_TO_THRESHOLD,
        treatMissingData: cloudwatch.TreatMissingData.NOT_BREACHING,
        alarmDescription: `${name} Lambda throttle rate exceeded threshold`,
      });
    }

    // DynamoDB throttle alarms for critical tables
    const criticalTables = [
      { table: this.projectsTable, name: 'Projects' },
      { table: this.conversationsTable, name: 'Conversations' },
      { table: this.agentConfigTable, name: 'AgentConfig' },
      { table: integrationsTable, name: 'Integrations' },
    ];

    for (const { table, name } of criticalTables) {
      new cloudwatch.Alarm(this, `${name}ReadThrottleAlarm`, {
        alarmName: `citadel-${name}-read-throttles-${props.environment}`,
        metric: table.metricThrottledRequestsForOperation('GetItem', { period: cdk.Duration.minutes(5) }),
        threshold: 5,
        evaluationPeriods: 2,
        comparisonOperator: cloudwatch.ComparisonOperator.GREATER_THAN_OR_EQUAL_TO_THRESHOLD,
        treatMissingData: cloudwatch.TreatMissingData.NOT_BREACHING,
        alarmDescription: `${name} DynamoDB read throttles exceeded threshold`,
      });
    }

    // AppSync 4xx/5xx alarms
    new cloudwatch.Alarm(this, 'AppSync4xxAlarm', {
      alarmName: `citadel-appsync-4xx-${props.environment}`,
      metric: new cloudwatch.Metric({
        namespace: 'AWS/AppSync',
        metricName: '4XXError',
        dimensionsMap: { GraphQLAPIId: this.appSyncApi.apiId },
        period: cdk.Duration.minutes(5),
        statistic: 'Sum',
      }),
      threshold: 50,
      evaluationPeriods: 2,
      comparisonOperator: cloudwatch.ComparisonOperator.GREATER_THAN_OR_EQUAL_TO_THRESHOLD,
      treatMissingData: cloudwatch.TreatMissingData.NOT_BREACHING,
      alarmDescription: 'AppSync 4xx error rate exceeded threshold',
    });

    new cloudwatch.Alarm(this, 'AppSync5xxAlarm', {
      alarmName: `citadel-appsync-5xx-${props.environment}`,
      metric: new cloudwatch.Metric({
        namespace: 'AWS/AppSync',
        metricName: '5XXError',
        dimensionsMap: { GraphQLAPIId: this.appSyncApi.apiId },
        period: cdk.Duration.minutes(5),
        statistic: 'Sum',
      }),
      threshold: 10,
      evaluationPeriods: 1,
      comparisonOperator: cloudwatch.ComparisonOperator.GREATER_THAN_OR_EQUAL_TO_THRESHOLD,
      treatMissingData: cloudwatch.TreatMissingData.NOT_BREACHING,
      alarmDescription: 'AppSync 5xx error rate exceeded threshold',
    });

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
    this.adrsTable = new dynamodb.Table(this, 'ADRsTable', {
      tableName: `citadel-adrs-${props.environment}`,
      partitionKey: { name: 'adrId', type: dynamodb.AttributeType.STRING },
      billingMode: dynamodb.BillingMode.PAY_PER_REQUEST,
      removalPolicy: cdk.RemovalPolicy.RETAIN,
      deletionProtection: true,
      pointInTimeRecoverySpecification: { pointInTimeRecoveryEnabled: true },
    });
    this.adrsTable.addGlobalSecondaryIndex({
      indexName: 'project-index',
      partitionKey: { name: 'projectId', type: dynamodb.AttributeType.STRING },
      sortKey: { name: 'createdAt', type: dynamodb.AttributeType.STRING },
      projectionType: dynamodb.ProjectionType.ALL,
    });

    // ADR Reopen Attempts (append-only audit log)
    this.adrReopenAttemptsTable = new dynamodb.Table(this, 'ADRReopenAttemptsTable', {
      tableName: `citadel-adr-reopen-attempts-${props.environment}`,
      partitionKey: { name: 'attemptId', type: dynamodb.AttributeType.STRING },
      billingMode: dynamodb.BillingMode.PAY_PER_REQUEST,
      removalPolicy: cdk.RemovalPolicy.RETAIN,
      deletionProtection: true,
      pointInTimeRecoverySpecification: { pointInTimeRecoveryEnabled: true },
    });
    this.adrReopenAttemptsTable.addGlobalSecondaryIndex({
      indexName: 'adr-index',
      partitionKey: { name: 'adrId', type: dynamodb.AttributeType.STRING },
      sortKey: { name: 'attemptedAt', type: dynamodb.AttributeType.STRING },
      projectionType: dynamodb.ProjectionType.ALL,
    });

    // ExecutionSpecifications — also consumed by ArbiterStack
    // (worker + fabricator) for dispatch-time spec-status validation.
    this.executionSpecificationsTable = new dynamodb.Table(this, 'ExecutionSpecificationsTable', {
      tableName: `citadel-execution-specifications-${props.environment}`,
      partitionKey: { name: 'specId', type: dynamodb.AttributeType.STRING },
      billingMode: dynamodb.BillingMode.PAY_PER_REQUEST,
      removalPolicy: cdk.RemovalPolicy.RETAIN,
      deletionProtection: true,
      pointInTimeRecoverySpecification: { pointInTimeRecoveryEnabled: true },
    });
    this.executionSpecificationsTable.addGlobalSecondaryIndex({
      indexName: 'project-index',
      partitionKey: { name: 'projectId', type: dynamodb.AttributeType.STRING },
      sortKey: { name: 'createdAt', type: dynamodb.AttributeType.STRING },
      projectionType: dynamodb.ProjectionType.ALL,
    });

    // InterrogationRounds
    this.interrogationRoundsTable = new dynamodb.Table(this, 'InterrogationRoundsTable', {
      tableName: `citadel-interrogation-rounds-${props.environment}`,
      partitionKey: { name: 'projectId', type: dynamodb.AttributeType.STRING },
      sortKey: { name: 'roundN', type: dynamodb.AttributeType.NUMBER },
      billingMode: dynamodb.BillingMode.PAY_PER_REQUEST,
      removalPolicy: cdk.RemovalPolicy.RETAIN,
      deletionProtection: true,
      pointInTimeRecoverySpecification: { pointInTimeRecoveryEnabled: true },
    });

    // AgentDesignAssessments
    this.agentDesignAssessmentsTable = new dynamodb.Table(this, 'AgentDesignAssessmentsTable', {
      tableName: `citadel-agent-design-assessments-${props.environment}`,
      partitionKey: { name: 'projectId', type: dynamodb.AttributeType.STRING },
      billingMode: dynamodb.BillingMode.PAY_PER_REQUEST,
      removalPolicy: cdk.RemovalPolicy.RETAIN,
      deletionProtection: true,
      pointInTimeRecoverySpecification: { pointInTimeRecoveryEnabled: true },
    });

    // ProgramReviews (Δ12)
    this.programReviewsTable = new dynamodb.Table(this, 'ProgramReviewsTable', {
      tableName: `citadel-program-reviews-${props.environment}`,
      partitionKey: { name: 'reviewId', type: dynamodb.AttributeType.STRING },
      billingMode: dynamodb.BillingMode.PAY_PER_REQUEST,
      removalPolicy: cdk.RemovalPolicy.RETAIN,
      deletionProtection: true,
      pointInTimeRecoverySpecification: { pointInTimeRecoveryEnabled: true },
    });
    this.programReviewsTable.addGlobalSecondaryIndex({
      indexName: 'project-index',
      partitionKey: { name: 'projectId', type: dynamodb.AttributeType.STRING },
      sortKey: { name: 'createdAt', type: dynamodb.AttributeType.STRING },
      projectionType: dynamodb.ProjectionType.ALL,
    });

    // wire projectResolverFunction to the governance-gate tables.
    // These env vars and grants are deferred to this point because the tables
    // are instantiated later in the constructor than the function itself.
    // Gates C3 (assessment), C7 (ADR), C10 (ExecutionSpec) read from these
    // tables during updateProject phase transitions.
    projectResolverFunction.addEnvironment('ADRS_TABLE', this.adrsTable.tableName);
    projectResolverFunction.addEnvironment('EXECUTION_SPECS_TABLE', this.executionSpecificationsTable.tableName);
    projectResolverFunction.addEnvironment('AGENT_DESIGN_ASSESSMENTS_TABLE', this.agentDesignAssessmentsTable.tableName);
    this.adrsTable.grantReadData(projectResolverFunction);
    this.executionSpecificationsTable.grantReadData(projectResolverFunction);
    this.agentDesignAssessmentsTable.grantReadData(projectResolverFunction);

    // ADR-on-import (US-IMP): the agent import resolver records a
    // system-generated ADR keyed to the synthetic GLOBAL import project. Write-
    // only grant — it creates ADRs (createADR → PutItem) and never reads them.
    // Deferred to here, mirroring projectResolverFunction's ADRS_TABLE wiring,
    // because adrsTable is instantiated later in the constructor than the
    // function. Same-stack reference (ADRsTable lives in this BackendStack); the
    // resulting GSI /index/* wildcard is covered by the stack-level
    // AwsSolutions-IAM5 suppression in bin/app.ts.
    agentImportResolverFunction.addEnvironment('ADRS_TABLE', this.adrsTable.tableName);
    this.adrsTable.grantWriteData(agentImportResolverFunction);
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
      'ImportedPublishHandler',
      {
        functionArn: publishHandlerArn,
        sameEnvironment: true,
      }
    );

    const publishHandlerDataSource = this.appSyncApi.addLambdaDataSource(
      'PublishHandlerLambdaDataSource',
      publishHandlerFn
    );

    publishHandlerDataSource.createResolver('PublishAppResolver', {
      typeName: 'Mutation',
      fieldName: 'publishApp',
      requestMappingTemplate: appsync.MappingTemplate.lambdaRequest(),
      responseMappingTemplate: appsync.MappingTemplate.lambdaResult(),
    });

    publishHandlerDataSource.createResolver('UnpublishAppResolver', {
      typeName: 'Mutation',
      fieldName: 'unpublishApp',
      requestMappingTemplate: appsync.MappingTemplate.lambdaRequest(),
      responseMappingTemplate: appsync.MappingTemplate.lambdaResult(),
    });
  }
}
