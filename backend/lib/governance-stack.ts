/**
 * GovernanceStack — AI-Accelerated Modernization Governance
 *
 * Stage 2 of the backend-stack split (feat/ai-governance). This stack owns
 * the governance Lambdas, AppSync data sources, resolvers, EventBridge
 * notifier rule, SSM rollout flags, KMS key, S3 transcripts bucket, and the
 * custom resource that auto-writes `effective_at` on first flip.
 *
 * The DynamoDB governance tables (adrs, adr-reopen-attempts,
 * execution-specifications, interrogation-rounds, agent-design-assessments,
 * program-reviews) remain in BackendStack and are passed in as props —
 * splitting them out would trigger table recreation, which is unsafe given
 * their RETAIN + deletion protection policies. Cross-stack grants generate
 * CloudFormation Exports automatically.
 *
 * Contract:
 * Inputs (props): appSyncApi, agentEventBus, accessLogsBucket,
 *                 the 6 governance tables, projectsTable (for design
 *                 assessment's PROJECTS_TABLE env var).
 * Outputs (public): governanceTranscriptsKey, governanceTranscriptsBucket,
 *                   governanceEnforceParam, governanceEffectiveAtParam.
 */
import * as cdk from "aws-cdk-lib";
import { CustomResource, Duration } from "aws-cdk-lib";
import * as appsync from "aws-cdk-lib/aws-appsync";
// Cfn L1 AppSync constructs — used cross-stack to avoid creating data sources
// in the API owner's stack (see governance-stack.ts constructor for rationale).
import { aws_appsync as appsyncCfn } from "aws-cdk-lib";
import * as dynamodb from "aws-cdk-lib/aws-dynamodb";
import * as events from "aws-cdk-lib/aws-events";
import * as targets from "aws-cdk-lib/aws-events-targets";
import * as iam from "aws-cdk-lib/aws-iam";
import * as lambda from "aws-cdk-lib/aws-lambda";
import { SqsEventSource } from "aws-cdk-lib/aws-lambda-event-sources";
import * as logs from "aws-cdk-lib/aws-logs";
import { BlockPublicAccess, Bucket } from "aws-cdk-lib/aws-s3";
import * as sqs from "aws-cdk-lib/aws-sqs";
import * as ssm from "aws-cdk-lib/aws-ssm";
import { Provider } from "aws-cdk-lib/custom-resources";
import { Construct } from "constructs";
import { NagSuppressions } from "cdk-nag";

export interface GovernanceStackProps extends cdk.StackProps {
  environment: string;
  appSyncApi: appsync.GraphqlApi;
  agentEventBus: events.IEventBus;
  /** Shared access-logs bucket from BackendStack (reused for transcripts bucket server-access logging). */
  accessLogsBucket: Bucket;
  /** 6 governance DynamoDB tables owned by BackendStack. */
  adrsTable: dynamodb.ITable;
  adrReopenAttemptsTable: dynamodb.ITable;
  executionSpecificationsTable: dynamodb.ITable;
  interrogationRoundsTable: dynamodb.ITable;
  agentDesignAssessmentsTable: dynamodb.ITable;
  programReviewsTable: dynamodb.ITable;
  /** Core projects table — design-assessment resolver reads/writes project status. */
  projectsTable: dynamodb.ITable;
  // CIT-101: eval suites/cases — owned by BackendStack, consumed here by
  // the eval-resolver (this stack's home per the design's grounding: eval
  // suites are release evidence, governance-grade like
  // ExecutionSpecifications).
  evalSuitesTable: dynamodb.ITable;
  evalCasesTable: dynamodb.ITable;
  // CIT-102: eval runs — same governance posture, owned by BackendStack.
  // Consumed by the eval-run-resolver/eval-runner/eval-conversation-worker,
  // all homed here alongside the eval-resolver.
  evalRunsTable: dynamodb.ITable;
  evalRunCaseResultsTable: dynamodb.ITable;
  // CIT-105: baseline designation pointer + computed comparison verdicts +
  // threshold config — owned by BackendStack, consumed here by the
  // eval-comparison-resolver (own file/IAM role per kept-separate
  // doctrine — distinct from eval-run-resolver/eval-resolver above).
  evalBaselinesTable: dynamodb.ITable;
  evalComparisonsTable: dynamodb.ITable;
  evalComparisonConfigTable: dynamodb.ITable;
  /** Adapter A dispatch target — execution rows for EXECUTION-kind cases. */
  executionsTable: dynamodb.ITable;
  /** Adapter B dispatch target — conversation transcript rows for CONVERSATION-kind cases. */
  conversationsTable: dynamodb.ITable;
}

export class GovernanceStack extends cdk.Stack {
  public readonly governanceTranscriptsKey: cdk.aws_kms.Key;
  public readonly governanceTranscriptsBucket: Bucket;
  public readonly governanceEnforceParam: ssm.StringParameter;
  public readonly governanceEffectiveAtParam: ssm.StringParameter;

  constructor(scope: Construct, id: string, props: GovernanceStackProps) {
    super(scope, id, props);
    const accessLogsBucket = props.accessLogsBucket;

    // ============================================================
    // Cross-stack AppSync pattern — L1 CfnDataSource + CfnResolver
    // ============================================================
    // We reference props.appSyncApi.apiId (a string token) from low-level
    // CfnDataSource/CfnResolver so the resources materialize in this
    // (Governance) stack instead of the API owner (BackendStack). Using the
    // L2 appSyncApi.addLambdaDataSource(..., lambda) would stamp
    // lambda.functionArn into BackendStack's template and create a
    // BackendStack → GovernanceStack dependency edge, completing a cycle
    // with GovernanceStack → BackendStack (via appSyncApi prop).
    //
    // These literals match the CDK L2 defaults for
    // appsync.MappingTemplate.lambdaRequest() and lambdaResult().
    const LAMBDA_REQUEST_MAPPING = `{
  "version": "2017-02-28",
  "operation": "Invoke",
  "payload": $util.toJson($context)
}`;
    const LAMBDA_RESPONSE_MAPPING = `$util.toJson($ctx.result)`;

    // ============================================================
    // Governance Rollout Flags
    // ============================================================

    const governanceEnforceParam = new ssm.StringParameter(
      this,
      "GovernanceEnforceParam",
      {
        parameterName: `/citadel/governance/enforce/${props.environment}`,
        stringValue: "permissive",
        allowedPattern: "^(permissive|shadow|strict)$",
        description:
          "AI-Accelerated Modernization Governance enforcement mode. " +
          "permissive = telemetry only (default); shadow = block in logs, allow action; " +
          "strict = hard block. Flip is data-driven per QD-1; effective_at companion " +
          "parameter auto-written on first permissive → shadow transition.",
        tier: ssm.ParameterTier.STANDARD,
      },
    );
    this.governanceEnforceParam = governanceEnforceParam;

    const governanceEffectiveAtParam = new ssm.StringParameter(
      this,
      "GovernanceEffectiveAtParam",
      {
        parameterName: `/citadel/governance/effective_at/${props.environment}`,
        stringValue: "__EMPTY__",
        description:
          "ISO-8601 timestamp of first permissive → shadow flip. " +
          "Projects with createdAt < effective_at bypass new governance gates (grandfathering). " +
          '"__EMPTY__" means no cutoff set; all projects grandfathered.',
        tier: ssm.ParameterTier.STANDARD,
      },
    );
    this.governanceEffectiveAtParam = governanceEffectiveAtParam;

    const effectiveAtAutoWriterFn = new lambda.Function(
      this,
      "GovernanceEffectiveAtAutoWriterFn",
      {
        runtime: lambda.Runtime.NODEJS_24_X,
        handler: "index.handler",
        timeout: Duration.seconds(30),
        code: lambda.Code.fromInline(
          `
const { SSMClient, GetParameterCommand, PutParameterCommand } = require('@aws-sdk/client-ssm');
const https = require('https');
const url = require('url');

const enforceParamName = process.env.ENFORCE_PARAM_NAME;
const effectiveAtParamName = process.env.EFFECTIVE_AT_PARAM_NAME;

const ssm = new SSMClient({});

async function sendCfnResponse(event, status, reason, data) {
  const body = JSON.stringify({
    Status: status,
    Reason: reason || 'See CloudWatch logs',
    PhysicalResourceId: event.PhysicalResourceId || event.LogicalResourceId,
    StackId: event.StackId,
    RequestId: event.RequestId,
    LogicalResourceId: event.LogicalResourceId,
    NoEcho: false,
    Data: data || {},
  });
  const parsed = url.parse(event.ResponseURL);
  await new Promise((resolve, reject) => {
    const req = https.request({
      hostname: parsed.hostname,
      port: 443,
      path: parsed.path,
      method: 'PUT',
      headers: { 'content-type': '', 'content-length': body.length },
    }, (res) => { res.on('data', () => {}); res.on('end', resolve); });
    req.on('error', reject);
    req.write(body);
    req.end();
  });
}

exports.handler = async (event) => {
  try {
    if (event.RequestType === 'Delete') {
      await sendCfnResponse(event, 'SUCCESS', 'Delete no-op', {});
      return;
    }

    const enforceResp = await ssm.send(new GetParameterCommand({ Name: enforceParamName }));
    const enforceValue = enforceResp.Parameter && enforceResp.Parameter.Value? enforceResp.Parameter.Value: 'permissive';

    const effectiveResp = await ssm.send(new GetParameterCommand({ Name: effectiveAtParamName }));
    const currentEffectiveAt = effectiveResp.Parameter && effectiveResp.Parameter.Value? effectiveResp.Parameter.Value: '__EMPTY__';

    if ((enforceValue === 'shadow' || enforceValue === 'strict') && currentEffectiveAt === '__EMPTY__') {
      const now = new Date().toISOString();
      await ssm.send(new PutParameterCommand({
        Name: effectiveAtParamName,
        Value: now,
        Type: 'String',
        Overwrite: true,
      }));
      await sendCfnResponse(event, 'SUCCESS', 'effective_at written', { EffectiveAt: now });
      return;
    }

    await sendCfnResponse(event, 'SUCCESS', 'no-op', {
      EnforceValue: enforceValue,
      CurrentEffectiveAt: currentEffectiveAt,
    });
  } catch (e) {
    await sendCfnResponse(event, 'FAILED', (e && e.message)? e.message: String(e), {});
  }
};
      `.trim(),
        ),
        environment: {
          ENFORCE_PARAM_NAME: governanceEnforceParam.parameterName,
          EFFECTIVE_AT_PARAM_NAME: governanceEffectiveAtParam.parameterName,
        },
      },
    );

    effectiveAtAutoWriterFn.addToRolePolicy(
      new iam.PolicyStatement({
        actions: ["ssm:GetParameter", "ssm:PutParameter"],
        resources: [
          governanceEnforceParam.parameterArn,
          governanceEffectiveAtParam.parameterArn,
        ],
      }),
    );

    const effectiveAtProvider = new Provider(
      this,
      "GovernanceEffectiveAtProvider",
      {
        onEventHandler: effectiveAtAutoWriterFn,
      },
    );

    new CustomResource(this, "GovernanceEffectiveAtTrigger", {
      serviceToken: effectiveAtProvider.serviceToken,
      properties: {
        EnforceParamName: governanceEnforceParam.parameterName,
      },
    });

    NagSuppressions.addResourceSuppressions(
      effectiveAtAutoWriterFn,
      [
        {
          id: "AwsSolutions-IAM4",
          reason:
            "AWS Lambda basic-execution managed policy is required for CloudWatch Logs; " +
            "scoped role also carries least-privilege SSM permissions on the two governance parameters only.",
        },
        {
          id: "AwsSolutions-L1",
          reason:
            "Inline Lambda uses the latest Node.js runtime available to the stack; upgrade is " +
            "a mechanical follow-up when the project bumps its NodeJS runtime convention.",
        },
      ],
      true,
    );

    NagSuppressions.addResourceSuppressions(
      effectiveAtProvider,
      [
        {
          id: "AwsSolutions-IAM4",
          reason: "CDK Provider framework internal role — upstream managed.",
        },
        {
          id: "AwsSolutions-IAM5",
          reason: "CDK Provider framework internal role — upstream managed.",
        },
        {
          id: "AwsSolutions-L1",
          reason: "CDK Provider framework internal Lambda — upstream managed.",
        },
      ],
      true,
    );

    // ============================================================
    // Governance Transcripts Bucket
    // ============================================================

    // Dedicated KMS key for transcript bucket (SSE-KMS).
    const governanceTranscriptsKey = new cdk.aws_kms.Key(
      this,
      "GovernanceTranscriptsKey",
      {
        description: "Citadel Governance Transcripts bucket encryption key",
        enableKeyRotation: true,
        removalPolicy: cdk.RemovalPolicy.RETAIN,
        alias: `alias/citadel-governance-transcripts-${props.environment}`,
      },
    );
    this.governanceTranscriptsKey = governanceTranscriptsKey;

    const governanceTranscriptsBucket = new Bucket(
      this,
      "GovernanceTranscriptsBucket",
      {
        bucketName: `citadel-governance-transcripts-${props.environment}-${this.account}-${this.region}`,
        encryption: cdk.aws_s3.BucketEncryption.KMS,
        encryptionKey: governanceTranscriptsKey,
        bucketKeyEnabled: true,
        blockPublicAccess: BlockPublicAccess.BLOCK_ALL,
        enforceSSL: true,
        versioned: true,
        removalPolicy: cdk.RemovalPolicy.RETAIN,
        serverAccessLogsBucket: accessLogsBucket,
        serverAccessLogsPrefix: "governance-transcripts/",
        lifecycleRules: [
          {
            id: "governance-transcripts-lifecycle",
            enabled: true,
            transitions: [
              {
                storageClass: cdk.aws_s3.StorageClass.INFREQUENT_ACCESS,
                transitionAfter: Duration.days(90),
              },
              {
                storageClass: cdk.aws_s3.StorageClass.GLACIER,
                transitionAfter: Duration.days(180),
              },
            ],
            expiration: Duration.days(2555),
            noncurrentVersionExpiration: Duration.days(2555),
          },
        ],
      },
    );
    this.governanceTranscriptsBucket = governanceTranscriptsBucket;

    // Deny any PutObject that is not SSE-KMS encrypted.
    governanceTranscriptsBucket.addToResourcePolicy(
      new iam.PolicyStatement({
        effect: iam.Effect.DENY,
        principals: [new iam.AnyPrincipal()],
        actions: ["s3:PutObject"],
        resources: [governanceTranscriptsBucket.arnForObjects("*")],
        conditions: {
          StringNotEquals: {
            "s3:x-amz-server-side-encryption": "aws:kms",
          },
        },
      }),
    );

    // Deny any PutObject that uses a different KMS key.
    governanceTranscriptsBucket.addToResourcePolicy(
      new iam.PolicyStatement({
        effect: iam.Effect.DENY,
        principals: [new iam.AnyPrincipal()],
        actions: ["s3:PutObject"],
        resources: [governanceTranscriptsBucket.arnForObjects("*")],
        conditions: {
          StringNotEqualsIfExists: {
            "s3:x-amz-server-side-encryption-aws-kms-key-id":
              governanceTranscriptsKey.keyArn,
          },
        },
      }),
    );

    // ============================================================
    // Governance Notifier Lambda + EventBridge rule
    // ============================================================
    //
    // The governance-notifier Lambda is the AppSync subscription relay
    // for every governance.* EventBridge detail-type. It signs a
    // `publishGovernanceEvent` mutation with SigV4 and AppSync's
    // @aws_subscribe fans out to admin user-pool subscribers.
    //
    // The 14 detail-types listed below MUST stay in lock-step with
    // GOVERNANCE_DETAIL_TYPES in backend/src/utils/notifier-base.ts.
    // The handler also performs a defence-in-depth re-check against
    // that constant.

    // Dead-letter queue for events the Lambda fails to relay after
    // EventBridge async-invoke retries. Inspected by operators when
    // the live tail subscription drops governance events.
    const governanceNotifierDlq = new sqs.Queue(this, "GovernanceNotifierDlq", {
      queueName: `citadel-governance-notifier-dlq-${props.environment}`,
      // 14 days — the max EventBridge-side retention window plus
      // headroom for human operator triage.
      retentionPeriod: Duration.days(14),
      // Encrypt with AWS-managed SQS keys; the relay payload is the
      // public governance event envelope and need not be customer-CMK
      // encrypted.
      encryption: sqs.QueueEncryption.SQS_MANAGED,
      enforceSSL: true,
    });

    const governanceNotifierFn = new lambda.Function(
      this,
      "GovernanceNotifierFn",
      {
        runtime: lambda.Runtime.NODEJS_24_X,
        handler: "governance-notifier.handler",
        code: lambda.Code.fromAsset("dist/lambda"),
        timeout: Duration.seconds(10),
        environment: {
          EVENT_BUS_NAME: props.agentEventBus.eventBusName,
          APPSYNC_ENDPOINT: props.appSyncApi.graphqlUrl,
        },
        // EventBridge invokes Lambda async; failed invocations land in
        // the DLQ after the default 2 retries (configurable on the
        // EventBridge target as well, but the Lambda-side DLQ also
        // catches init failures and synchronous throws inside the
        // handler).
        deadLetterQueueEnabled: true,
        deadLetterQueue: governanceNotifierDlq,
      },
    );

    // Field-scoped IAM grant: only the publishGovernanceEvent mutation
    // is callable. The notifier MUST NOT be able to invoke any other
    // mutation on the API — least privilege per project security
    // standards.
    governanceNotifierFn.addToRolePolicy(
      new iam.PolicyStatement({
        effect: iam.Effect.ALLOW,
        actions: ["appsync:GraphQL"],
        resources: [
          `${props.appSyncApi.arn}/types/Mutation/fields/publishGovernanceEvent`,
        ],
      }),
    );

    new events.Rule(this, "GovernanceEventsRule", {
      eventBus: props.agentEventBus,
      ruleName: `citadel-governance-events-${props.environment}`,
      description:
        "Routes all 14 governance.* detail-types (the canonical list in " +
        "GOVERNANCE_DETAIL_TYPES) to the governance-notifier relay Lambda.",
      eventPattern: {
        source: ["citadel.backend"],
        // Keep this list in lock-step with GOVERNANCE_DETAIL_TYPES in
        // backend/src/utils/notifier-base.ts. The handler also drops
        // unknown detail-types as defence in depth, so the rule
        // expanding ahead of the handler is safe.
        detailType: [
          "governance.adr.locked",
          "governance.adr.reopen.attempted",
          "governance.specification.created",
          "governance.specification.approved",
          "governance.specification.rejected",
          "governance.round.started",
          "governance.round.completed",
          "governance.round.transcript.overflow",
          "governance.archetype.classified",
          "governance.offfrontier.escalated",
          "governance.grandfathered.bypass",
          "governance.mode.transition",
          "governance.constitutional.rule.changed",
          "governance.caselaw.changed",
        ],
      },
      targets: [
        new targets.LambdaFunction(governanceNotifierFn, {
          // EventBridge-side retries — the Lambda-side DLQ catches
          // anything that still fails after these.
          retryAttempts: 2,
          maxEventAge: Duration.hours(2),
          deadLetterQueue: governanceNotifierDlq,
        }),
      ],
    });

    NagSuppressions.addResourceSuppressions(
      governanceNotifierFn,
      [
        {
          id: "AwsSolutions-IAM4",
          reason:
            "AWS Lambda basic-execution managed policy is required for CloudWatch Logs. " +
            "The relay also has a field-scoped appsync:GraphQL grant on the single " +
            "publishGovernanceEvent mutation — no API-wide permissions.",
        },
      ],
      true,
    );

    // ============================================================
    // AppSync wiring for the relay — NONE-type passthrough resolver
    // ============================================================
    //
    // `publishGovernanceEvent` is a fanout-only mutation: it has no
    // backend other than the @aws_subscribe-driven onGovernanceEvent
    // subscription. A NONE-type data source + a passthrough VTL
    // resolver echoes the input back as the result so AppSync invokes
    // the subscription fanout without touching a Lambda. Mirrors the
    // standard "publish + fanout" pattern documented at
    // https://docs.aws.amazon.com/appsync/latest/devguide/data-source-none.html.

    const governanceEventNoneDataSource = new appsyncCfn.CfnDataSource(
      this,
      "GovernanceEventNoneDataSource",
      {
        apiId: props.appSyncApi.apiId,
        name: "GovernanceEventNoneDataSource",
        type: "NONE",
        description:
          "Passthrough data source for the publishGovernanceEvent fanout mutation.",
      },
    );

    const publishGovernanceEventResolver = new appsyncCfn.CfnResolver(
      this,
      "PublishGovernanceEventResolver",
      {
        apiId: props.appSyncApi.apiId,
        typeName: "Mutation",
        fieldName: "publishGovernanceEvent",
        dataSourceName: governanceEventNoneDataSource.attrName,
        // NONE-type passthrough: echo the input back as the result so
        // the @aws_subscribe-driven subscription fan-outs the same
        // payload that the Lambda posted.
        requestMappingTemplate: `{
  "version": "2017-02-28",
  "payload": $util.toJson($ctx.args.input)
}`,
        responseMappingTemplate: `$util.toJson($ctx.result)`,
      },
    );
    publishGovernanceEventResolver.addResourceDependency(
      governanceEventNoneDataSource,
    );

    // ============================================================
    // ADR Resolver
    // ============================================================
    //
    // The ADR and ADR Reopen Attempts tables are owned by BackendStack and
    // passed in via props; the resolver Lambda + data source + resolvers
    // live here so the stack can be redeployed without touching the data
    // plane.

    const adrResolverFunction = new lambda.Function(
      this,
      "ADRResolverFunction",
      {
        runtime: lambda.Runtime.NODEJS_24_X,
        handler: "adr-resolver.handler",
        code: lambda.Code.fromAsset("dist/lambda"),
        environment: {
          ADRS_TABLE: props.adrsTable.tableName,
          ADR_REOPEN_ATTEMPTS_TABLE: props.adrReopenAttemptsTable.tableName,
          EVENT_BUS_NAME: props.agentEventBus.eventBusName,
        },
        timeout: Duration.seconds(30),
        logGroup: new logs.LogGroup(this, "ADRResolverFunctionLogs", {
          retention: logs.RetentionDays.ONE_WEEK,
          removalPolicy: cdk.RemovalPolicy.DESTROY,
        }),
      },
    );

    props.adrsTable.grantReadWriteData(adrResolverFunction);
    props.adrReopenAttemptsTable.grantReadWriteData(adrResolverFunction);
    props.agentEventBus.grantPutEventsTo(adrResolverFunction);

    const adrDataSourceRole = new iam.Role(this, "ADRDataSourceRole", {
      assumedBy: new iam.ServicePrincipal("appsync.amazonaws.com"),
    });
    adrResolverFunction.grantInvoke(adrDataSourceRole);

    const adrLambdaDataSource = new appsyncCfn.CfnDataSource(
      this,
      "ADRLambdaDataSource",
      {
        apiId: props.appSyncApi.apiId,
        name: "ADRLambdaDataSource",
        type: "AWS_LAMBDA",
        serviceRoleArn: adrDataSourceRole.roleArn,
        lambdaConfig: {
          lambdaFunctionArn: adrResolverFunction.functionArn,
        },
      },
    );

    const createADRResolver = new appsyncCfn.CfnResolver(
      this,
      "CreateADRResolver",
      {
        apiId: props.appSyncApi.apiId,
        typeName: "Mutation",
        fieldName: "createADR",
        dataSourceName: adrLambdaDataSource.attrName,
        requestMappingTemplate: LAMBDA_REQUEST_MAPPING,
        responseMappingTemplate: LAMBDA_RESPONSE_MAPPING,
      },
    );
    createADRResolver.addResourceDependency(adrLambdaDataSource);

    const supersedeADRResolver = new appsyncCfn.CfnResolver(
      this,
      "SupersedeADRResolver",
      {
        apiId: props.appSyncApi.apiId,
        typeName: "Mutation",
        fieldName: "supersedeADR",
        dataSourceName: adrLambdaDataSource.attrName,
        requestMappingTemplate: LAMBDA_REQUEST_MAPPING,
        responseMappingTemplate: LAMBDA_RESPONSE_MAPPING,
      },
    );
    supersedeADRResolver.addResourceDependency(adrLambdaDataSource);

    const getADRResolver = new appsyncCfn.CfnResolver(this, "GetADRResolver", {
      apiId: props.appSyncApi.apiId,
      typeName: "Query",
      fieldName: "getADR",
      dataSourceName: adrLambdaDataSource.attrName,
      requestMappingTemplate: LAMBDA_REQUEST_MAPPING,
      responseMappingTemplate: LAMBDA_RESPONSE_MAPPING,
    });
    getADRResolver.addResourceDependency(adrLambdaDataSource);

    const listADRsForProjectResolver = new appsyncCfn.CfnResolver(
      this,
      "ListADRsForProjectResolver",
      {
        apiId: props.appSyncApi.apiId,
        typeName: "Query",
        fieldName: "listADRsForProject",
        dataSourceName: adrLambdaDataSource.attrName,
        requestMappingTemplate: LAMBDA_REQUEST_MAPPING,
        responseMappingTemplate: LAMBDA_RESPONSE_MAPPING,
      },
    );
    listADRsForProjectResolver.addResourceDependency(adrLambdaDataSource);

    const reopenADRResolver = new appsyncCfn.CfnResolver(
      this,
      "ReopenADRResolver",
      {
        apiId: props.appSyncApi.apiId,
        typeName: "Mutation",
        fieldName: "reopenADR",
        dataSourceName: adrLambdaDataSource.attrName,
        requestMappingTemplate: LAMBDA_REQUEST_MAPPING,
        responseMappingTemplate: LAMBDA_RESPONSE_MAPPING,
      },
    );
    reopenADRResolver.addResourceDependency(adrLambdaDataSource);

    // ============================================================
    // ExecutionSpecification Resolver
    // ============================================================

    const execSpecResolverFunction = new lambda.Function(
      this,
      "ExecSpecResolverFunction",
      {
        runtime: lambda.Runtime.NODEJS_24_X,
        handler: "execspec-resolver.handler",
        code: lambda.Code.fromAsset("dist/lambda"),
        environment: {
          EXECUTION_SPECS_TABLE: props.executionSpecificationsTable.tableName,
          EVENT_BUS_NAME: props.agentEventBus.eventBusName,
        },
        timeout: cdk.Duration.seconds(30),
        logGroup: new logs.LogGroup(this, "ExecSpecResolverFunctionLogs", {
          retention: logs.RetentionDays.ONE_WEEK,
          removalPolicy: cdk.RemovalPolicy.DESTROY,
        }),
      },
    );

    props.executionSpecificationsTable.grantReadWriteData(
      execSpecResolverFunction,
    );
    props.agentEventBus.grantPutEventsTo(execSpecResolverFunction);

    const execSpecDataSourceRole = new iam.Role(
      this,
      "ExecSpecDataSourceRole",
      {
        assumedBy: new iam.ServicePrincipal("appsync.amazonaws.com"),
      },
    );
    execSpecResolverFunction.grantInvoke(execSpecDataSourceRole);

    const execSpecLambdaDataSource = new appsyncCfn.CfnDataSource(
      this,
      "ExecSpecLambdaDataSource",
      {
        apiId: props.appSyncApi.apiId,
        name: "ExecSpecLambdaDataSource",
        type: "AWS_LAMBDA",
        serviceRoleArn: execSpecDataSourceRole.roleArn,
        lambdaConfig: {
          lambdaFunctionArn: execSpecResolverFunction.functionArn,
        },
      },
    );

    const createExecSpecResolver = new appsyncCfn.CfnResolver(
      this,
      "CreateExecutionSpecResolver",
      {
        apiId: props.appSyncApi.apiId,
        typeName: "Mutation",
        fieldName: "createExecutionSpecification",
        dataSourceName: execSpecLambdaDataSource.attrName,
        requestMappingTemplate: LAMBDA_REQUEST_MAPPING,
        responseMappingTemplate: LAMBDA_RESPONSE_MAPPING,
      },
    );
    createExecSpecResolver.addResourceDependency(execSpecLambdaDataSource);

    const submitExecSpecResolver = new appsyncCfn.CfnResolver(
      this,
      "SubmitExecutionSpecResolver",
      {
        apiId: props.appSyncApi.apiId,
        typeName: "Mutation",
        fieldName: "submitExecutionSpecification",
        dataSourceName: execSpecLambdaDataSource.attrName,
        requestMappingTemplate: LAMBDA_REQUEST_MAPPING,
        responseMappingTemplate: LAMBDA_RESPONSE_MAPPING,
      },
    );
    submitExecSpecResolver.addResourceDependency(execSpecLambdaDataSource);

    const approveExecSpecResolver = new appsyncCfn.CfnResolver(
      this,
      "ApproveExecutionSpecResolver",
      {
        apiId: props.appSyncApi.apiId,
        typeName: "Mutation",
        fieldName: "approveExecutionSpecification",
        dataSourceName: execSpecLambdaDataSource.attrName,
        requestMappingTemplate: LAMBDA_REQUEST_MAPPING,
        responseMappingTemplate: LAMBDA_RESPONSE_MAPPING,
      },
    );
    approveExecSpecResolver.addResourceDependency(execSpecLambdaDataSource);

    const rejectExecSpecResolver = new appsyncCfn.CfnResolver(
      this,
      "RejectExecutionSpecResolver",
      {
        apiId: props.appSyncApi.apiId,
        typeName: "Mutation",
        fieldName: "rejectExecutionSpecification",
        dataSourceName: execSpecLambdaDataSource.attrName,
        requestMappingTemplate: LAMBDA_REQUEST_MAPPING,
        responseMappingTemplate: LAMBDA_RESPONSE_MAPPING,
      },
    );
    rejectExecSpecResolver.addResourceDependency(execSpecLambdaDataSource);

    const reviseExecSpecResolver = new appsyncCfn.CfnResolver(
      this,
      "ReviseExecutionSpecResolver",
      {
        apiId: props.appSyncApi.apiId,
        typeName: "Mutation",
        fieldName: "reviseExecutionSpecification",
        dataSourceName: execSpecLambdaDataSource.attrName,
        requestMappingTemplate: LAMBDA_REQUEST_MAPPING,
        responseMappingTemplate: LAMBDA_RESPONSE_MAPPING,
      },
    );
    reviseExecSpecResolver.addResourceDependency(execSpecLambdaDataSource);

    const getExecSpecResolver = new appsyncCfn.CfnResolver(
      this,
      "GetExecutionSpecResolver",
      {
        apiId: props.appSyncApi.apiId,
        typeName: "Query",
        fieldName: "getExecutionSpecification",
        dataSourceName: execSpecLambdaDataSource.attrName,
        requestMappingTemplate: LAMBDA_REQUEST_MAPPING,
        responseMappingTemplate: LAMBDA_RESPONSE_MAPPING,
      },
    );
    getExecSpecResolver.addResourceDependency(execSpecLambdaDataSource);

    const listExecSpecsResolver = new appsyncCfn.CfnResolver(
      this,
      "ListExecutionSpecsResolver",
      {
        apiId: props.appSyncApi.apiId,
        typeName: "Query",
        fieldName: "listExecutionSpecifications",
        dataSourceName: execSpecLambdaDataSource.attrName,
        requestMappingTemplate: LAMBDA_REQUEST_MAPPING,
        responseMappingTemplate: LAMBDA_RESPONSE_MAPPING,
      },
    );
    listExecSpecsResolver.addResourceDependency(execSpecLambdaDataSource);

    // ============================================================
    // EvalSuite / EvalCase Resolver (CIT-101)
    // ============================================================

    const evalResolverFunction = new lambda.Function(
      this,
      "EvalResolverFunction",
      {
        runtime: lambda.Runtime.NODEJS_24_X,
        handler: "eval-resolver.handler",
        code: lambda.Code.fromAsset("dist/lambda"),
        environment: {
          EVAL_SUITES_TABLE: props.evalSuitesTable.tableName,
          EVAL_CASES_TABLE: props.evalCasesTable.tableName,
          EVENT_BUS_NAME: props.agentEventBus.eventBusName,
        },
        timeout: cdk.Duration.seconds(30),
        logGroup: new logs.LogGroup(this, "EvalResolverFunctionLogs", {
          retention: logs.RetentionDays.ONE_WEEK,
          removalPolicy: cdk.RemovalPolicy.DESTROY,
        }),
      },
    );

    props.evalSuitesTable.grantReadWriteData(evalResolverFunction);
    props.evalCasesTable.grantReadWriteData(evalResolverFunction);
    props.agentEventBus.grantPutEventsTo(evalResolverFunction);

    const evalDataSourceRole = new iam.Role(this, "EvalDataSourceRole", {
      assumedBy: new iam.ServicePrincipal("appsync.amazonaws.com"),
    });
    evalResolverFunction.grantInvoke(evalDataSourceRole);

    const evalLambdaDataSource = new appsyncCfn.CfnDataSource(
      this,
      "EvalLambdaDataSource",
      {
        apiId: props.appSyncApi.apiId,
        name: "EvalLambdaDataSource",
        type: "AWS_LAMBDA",
        serviceRoleArn: evalDataSourceRole.roleArn,
        lambdaConfig: {
          lambdaFunctionArn: evalResolverFunction.functionArn,
        },
      },
    );

    const evalMutationFields = [
      { id: "CreateEvalSuiteResolver", fieldName: "createEvalSuite" },
      { id: "UpdateEvalSuiteResolver", fieldName: "updateEvalSuite" },
      { id: "FreezeEvalSuiteResolver", fieldName: "freezeEvalSuite" },
      { id: "ArchiveEvalSuiteResolver", fieldName: "archiveEvalSuite" },
      { id: "CloneEvalSuiteResolver", fieldName: "cloneEvalSuite" },
      {
        id: "MarkEvalSuiteReferencedResolver",
        fieldName: "markEvalSuiteReferenced",
      },
      { id: "AddEvalCaseResolver", fieldName: "addEvalCase" },
      { id: "UpdateEvalCaseResolver", fieldName: "updateEvalCase" },
      { id: "DeleteEvalCaseResolver", fieldName: "deleteEvalCase" },
      {
        id: "ImportReplayAsEvalCaseResolver",
        fieldName: "importReplayAsEvalCase",
      },
    ];
    for (const { id, fieldName } of evalMutationFields) {
      const resolver = new appsyncCfn.CfnResolver(this, id, {
        apiId: props.appSyncApi.apiId,
        typeName: "Mutation",
        fieldName,
        dataSourceName: evalLambdaDataSource.attrName,
        requestMappingTemplate: LAMBDA_REQUEST_MAPPING,
        responseMappingTemplate: LAMBDA_RESPONSE_MAPPING,
      });
      resolver.addResourceDependency(evalLambdaDataSource);
    }

    const evalQueryFields = [
      { id: "GetEvalSuiteResolver", fieldName: "getEvalSuite" },
      { id: "ListEvalSuitesResolver", fieldName: "listEvalSuites" },
      { id: "ListEvalCasesResolver", fieldName: "listEvalCases" },
    ];
    for (const { id, fieldName } of evalQueryFields) {
      const resolver = new appsyncCfn.CfnResolver(this, id, {
        apiId: props.appSyncApi.apiId,
        typeName: "Query",
        fieldName,
        dataSourceName: evalLambdaDataSource.attrName,
        requestMappingTemplate: LAMBDA_REQUEST_MAPPING,
        responseMappingTemplate: LAMBDA_RESPONSE_MAPPING,
      });
      resolver.addResourceDependency(evalLambdaDataSource);
    }

    // ============================================================
    // EvalRun / EvalRunCaseResult Resolver + eval-runner + worker (CIT-102)
    // ============================================================
    //
    // Dedicated event-driven eval-run driver (design §1) — a SQS
    // EvalDispatchQueue + DLQ (design's "remember the duplicate-alarm-name
    // guard + DLQ drift-guard test will need the new DLQ added" note; this
    // DLQ is threaded into telemetry-stack.ts's allDlqQueueNames list
    // separately). visibilityTimeout matches the conversation worker's own
    // 15-minute timeout (design §1 "eval-conversation-worker, timeout
    // <=15min") so SQS cannot re-deliver mid-flight.

    const evalDispatchDLQ = new sqs.Queue(this, "EvalDispatchDLQ", {
      queueName: `citadel-eval-dispatch-dlq-${props.environment}`,
      retentionPeriod: cdk.Duration.days(14),
      enforceSSL: true,
    });
    // This DLQ is itself the dead-letter target for EvalDispatchQueue's
    // consumer; a DLQ for a DLQ would loop on its own failures (same
    // pattern as governanceFindingFanoutDLQ / governanceGraphSnapshotOnChangeDLQ).
    NagSuppressions.addResourceSuppressions(evalDispatchDLQ, [
      {
        id: "AwsSolutions-SQS3",
        reason:
          "EvalDispatchDLQ is itself a dead-letter queue for the eval-conversation-worker's event source mapping. Adding a DLQ to a DLQ would loop on its own failures.",
      },
    ]);

    const evalDispatchQueue = new sqs.Queue(this, "EvalDispatchQueue", {
      queueName: `citadel-eval-dispatch-${props.environment}`,
      visibilityTimeout: cdk.Duration.minutes(15),
      retentionPeriod: cdk.Duration.days(7),
      enforceSSL: true,
      deadLetterQueue: {
        queue: evalDispatchDLQ,
        maxReceiveCount: 3,
      },
    });

    const evalRunResolverFunction = new lambda.Function(
      this,
      "EvalRunResolverFunction",
      {
        runtime: lambda.Runtime.NODEJS_24_X,
        handler: "eval-run-resolver.handler",
        code: lambda.Code.fromAsset("dist/lambda"),
        environment: {
          EVAL_SUITES_TABLE: props.evalSuitesTable.tableName,
          EVAL_CASES_TABLE: props.evalCasesTable.tableName,
          EVAL_RUNS_TABLE: props.evalRunsTable.tableName,
          EVAL_RUN_CASE_RESULTS_TABLE: props.evalRunCaseResultsTable.tableName,
          EXECUTIONS_TABLE: props.executionsTable.tableName,
          EVAL_DISPATCH_QUEUE_URL: evalDispatchQueue.queueUrl,
          EVENT_BUS_NAME: props.agentEventBus.eventBusName,
        },
        timeout: cdk.Duration.seconds(30),
        logGroup: new logs.LogGroup(this, "EvalRunResolverFunctionLogs", {
          retention: logs.RetentionDays.ONE_WEEK,
          removalPolicy: cdk.RemovalPolicy.DESTROY,
        }),
      },
    );

    props.evalSuitesTable.grantReadData(evalRunResolverFunction);
    props.evalCasesTable.grantReadData(evalRunResolverFunction);
    props.evalRunsTable.grantReadWriteData(evalRunResolverFunction);
    props.evalRunCaseResultsTable.grantReadWriteData(evalRunResolverFunction);
    props.executionsTable.grantReadWriteData(evalRunResolverFunction);
    props.agentEventBus.grantPutEventsTo(evalRunResolverFunction);
    evalDispatchQueue.grantSendMessages(evalRunResolverFunction);

    const evalRunDataSourceRole = new iam.Role(this, "EvalRunDataSourceRole", {
      assumedBy: new iam.ServicePrincipal("appsync.amazonaws.com"),
    });
    evalRunResolverFunction.grantInvoke(evalRunDataSourceRole);

    const evalRunLambdaDataSource = new appsyncCfn.CfnDataSource(
      this,
      "EvalRunLambdaDataSource",
      {
        apiId: props.appSyncApi.apiId,
        name: "EvalRunLambdaDataSource",
        type: "AWS_LAMBDA",
        serviceRoleArn: evalRunDataSourceRole.roleArn,
        lambdaConfig: {
          lambdaFunctionArn: evalRunResolverFunction.functionArn,
        },
      },
    );

    const evalRunMutationFields = [
      { id: "StartEvalRunResolver", fieldName: "startEvalRun" },
    ];
    for (const { id, fieldName } of evalRunMutationFields) {
      const resolver = new appsyncCfn.CfnResolver(this, id, {
        apiId: props.appSyncApi.apiId,
        typeName: "Mutation",
        fieldName,
        dataSourceName: evalRunLambdaDataSource.attrName,
        requestMappingTemplate: LAMBDA_REQUEST_MAPPING,
        responseMappingTemplate: LAMBDA_RESPONSE_MAPPING,
      });
      resolver.addResourceDependency(evalRunLambdaDataSource);
    }

    const evalRunQueryFields = [
      { id: "GetEvalRunResolver", fieldName: "getEvalRun" },
      { id: "ListEvalRunsResolver", fieldName: "listEvalRuns" },
      {
        id: "ListEvalRunCaseResultsResolver",
        fieldName: "listEvalRunCaseResults",
      },
    ];
    for (const { id, fieldName } of evalRunQueryFields) {
      const resolver = new appsyncCfn.CfnResolver(this, id, {
        apiId: props.appSyncApi.apiId,
        typeName: "Query",
        fieldName,
        dataSourceName: evalRunLambdaDataSource.attrName,
        requestMappingTemplate: LAMBDA_REQUEST_MAPPING,
        responseMappingTemplate: LAMBDA_RESPONSE_MAPPING,
      });
      resolver.addResourceDependency(evalRunLambdaDataSource);
    }

    // ============================================================
    // EvalBaseline / EvalComparison Resolver (CIT-105)
    // ============================================================
    //
    // Own file + own IAM role (kept-separate doctrine, mirrors
    // EvalRunResolverFunction vs EvalResolverFunction above) — distinct
    // tables (EvalBaselinesTable/EvalComparisonsTable/
    // EvalComparisonConfigTable) + distinct AppSync data source. Reads
    // EvalSuites/EvalCases/EvalRuns/EvalRunCaseResults (read-only — never
    // mutates run/suite state), reads+writes its own three tables, PutEvents,
    // and S3 get/put on the shared replay bucket's eval-comparisons/*
    // prefix (design §3) via the SAME grantEvalArtifactAccess helper used
    // by EvalRunResolverFunction/EvalRunnerFunction above.

    const evalComparisonResolverFunction = new lambda.Function(
      this,
      "EvalComparisonResolverFunction",
      {
        runtime: lambda.Runtime.NODEJS_24_X,
        handler: "eval-comparison-resolver.handler",
        code: lambda.Code.fromAsset("dist/lambda"),
        environment: {
          EVAL_BASELINES_TABLE: props.evalBaselinesTable.tableName,
          EVAL_COMPARISONS_TABLE: props.evalComparisonsTable.tableName,
          EVAL_COMPARISON_CONFIG_TABLE:
            props.evalComparisonConfigTable.tableName,
          EVAL_SUITES_TABLE: props.evalSuitesTable.tableName,
          EVAL_CASES_TABLE: props.evalCasesTable.tableName,
          EVAL_RUNS_TABLE: props.evalRunsTable.tableName,
          EVAL_RUN_CASE_RESULTS_TABLE: props.evalRunCaseResultsTable.tableName,
          EVENT_BUS_NAME: props.agentEventBus.eventBusName,
          ENVIRONMENT: props.environment,
        },
        timeout: cdk.Duration.seconds(30),
        logGroup: new logs.LogGroup(
          this,
          "EvalComparisonResolverFunctionLogs",
          {
            retention: logs.RetentionDays.ONE_WEEK,
            removalPolicy: cdk.RemovalPolicy.DESTROY,
          },
        ),
      },
    );

    props.evalSuitesTable.grantReadData(evalComparisonResolverFunction);
    props.evalCasesTable.grantReadData(evalComparisonResolverFunction);
    props.evalRunsTable.grantReadData(evalComparisonResolverFunction);
    props.evalRunCaseResultsTable.grantReadWriteData(
      evalComparisonResolverFunction,
    );
    props.evalBaselinesTable.grantReadWriteData(evalComparisonResolverFunction);
    props.evalComparisonsTable.grantReadWriteData(
      evalComparisonResolverFunction,
    );
    props.evalComparisonConfigTable.grantReadWriteData(
      evalComparisonResolverFunction,
    );
    props.agentEventBus.grantPutEventsTo(evalComparisonResolverFunction);
    this.grantEvalArtifactAccess(
      evalComparisonResolverFunction,
      props.environment,
      ["eval-runs/*", "eval-comparisons/*"],
    );

    const evalComparisonDataSourceRole = new iam.Role(
      this,
      "EvalComparisonDataSourceRole",
      {
        assumedBy: new iam.ServicePrincipal("appsync.amazonaws.com"),
      },
    );
    evalComparisonResolverFunction.grantInvoke(evalComparisonDataSourceRole);

    const evalComparisonLambdaDataSource = new appsyncCfn.CfnDataSource(
      this,
      "EvalComparisonLambdaDataSource",
      {
        apiId: props.appSyncApi.apiId,
        name: "EvalComparisonLambdaDataSource",
        type: "AWS_LAMBDA",
        serviceRoleArn: evalComparisonDataSourceRole.roleArn,
        lambdaConfig: {
          lambdaFunctionArn: evalComparisonResolverFunction.functionArn,
        },
      },
    );

    const evalComparisonMutationFields = [
      {
        id: "DesignateEvalBaselineResolver",
        fieldName: "designateEvalBaseline",
      },
      {
        id: "ComputeEvalComparisonResolver",
        fieldName: "computeEvalComparison",
      },
      {
        id: "SetEvalComparisonThresholdConfigResolver",
        fieldName: "setEvalComparisonThresholdConfig",
      },
    ];
    for (const { id, fieldName } of evalComparisonMutationFields) {
      const resolver = new appsyncCfn.CfnResolver(this, id, {
        apiId: props.appSyncApi.apiId,
        typeName: "Mutation",
        fieldName,
        dataSourceName: evalComparisonLambdaDataSource.attrName,
        requestMappingTemplate: LAMBDA_REQUEST_MAPPING,
        responseMappingTemplate: LAMBDA_RESPONSE_MAPPING,
      });
      resolver.addResourceDependency(evalComparisonLambdaDataSource);
    }

    const evalComparisonQueryFields = [
      { id: "GetEvalBaselineResolver", fieldName: "getEvalBaseline" },
      { id: "ListEvalBaselinesResolver", fieldName: "listEvalBaselines" },
      { id: "GetEvalComparisonResolver", fieldName: "getEvalComparison" },
      { id: "ListEvalComparisonsResolver", fieldName: "listEvalComparisons" },
      {
        id: "GetEvalComparisonThresholdConfigResolver",
        fieldName: "getEvalComparisonThresholdConfig",
      },
      {
        id: "GetEvalCaseArtifactDiffResolver",
        fieldName: "getEvalCaseArtifactDiff",
      },
    ];
    for (const { id, fieldName } of evalComparisonQueryFields) {
      const resolver = new appsyncCfn.CfnResolver(this, id, {
        apiId: props.appSyncApi.apiId,
        typeName: "Query",
        fieldName,
        dataSourceName: evalComparisonLambdaDataSource.attrName,
        requestMappingTemplate: LAMBDA_REQUEST_MAPPING,
        responseMappingTemplate: LAMBDA_RESPONSE_MAPPING,
      });
      resolver.addResourceDependency(evalComparisonLambdaDataSource);
    }

    // eval-conversation-worker — Adapter B (CONVERSATION-kind cases), SQS
    // consumer of EvalDispatchQueue. 15-minute timeout bounds the inline
    // InvokeAgentRuntimeCommand await (design §1/§3). batchSize=1 mirrors
    // the worker-agent queue precedent (arbiter-stack.ts workerAgentQueue):
    // one case per invocation, so a single slow/failing case never blocks
    // a batch of others. reportBatchItemFailures is NOT enabled — a
    // failure inside dispatchConversationCase is caught internally and
    // recorded as a FAILED case rather than thrown, so the message is
    // always acked (no redelivery loop for application-level failures);
    // only a Lambda-runtime crash would redeliver, which the DLQ catches
    // after maxReceiveCount.
    const evalConversationWorkerFunction = new lambda.Function(
      this,
      "EvalConversationWorkerFunction",
      {
        runtime: lambda.Runtime.NODEJS_24_X,
        handler: "eval-conversation-worker.handler",
        code: lambda.Code.fromAsset("dist/lambda"),
        environment: {
          CONVERSATIONS_TABLE: props.conversationsTable.tableName,
          EVAL_RUNS_TABLE: props.evalRunsTable.tableName,
          EVAL_RUN_CASE_RESULTS_TABLE: props.evalRunCaseResultsTable.tableName,
          EVENT_BUS_NAME: props.agentEventBus.eventBusName,
          ENVIRONMENT: props.environment,
        },
        timeout: cdk.Duration.minutes(15),
        memorySize: 512,
        logGroup: new logs.LogGroup(
          this,
          "EvalConversationWorkerFunctionLogs",
          {
            retention: logs.RetentionDays.ONE_WEEK,
            removalPolicy: cdk.RemovalPolicy.DESTROY,
          },
        ),
      },
    );

    props.conversationsTable.grantReadWriteData(evalConversationWorkerFunction);
    props.evalRunsTable.grantReadWriteData(evalConversationWorkerFunction);
    props.evalRunCaseResultsTable.grantReadWriteData(
      evalConversationWorkerFunction,
    );
    // Required so eval-run-completion.ts's best-effort
    // governance.eval.run.completed emission (fired from this worker on the
    // terminating case of a run) does not AccessDenied in prod — mirrors
    // the identical grant on evalRunResolverFunction above.
    props.agentEventBus.grantPutEventsTo(evalConversationWorkerFunction);
    evalConversationWorkerFunction.addToRolePolicy(
      new iam.PolicyStatement({
        effect: iam.Effect.ALLOW,
        actions: [
          "bedrock-agentcore:InvokeAgentRuntime",
          "bedrock-agentcore:InvokeAgent",
        ],
        resources: ["*"],
      }),
    );
    evalConversationWorkerFunction.addToRolePolicy(
      new iam.PolicyStatement({
        effect: iam.Effect.ALLOW,
        actions: ["ssm:GetParameter"],
        resources: [
          `arn:aws:ssm:${this.region}:${this.account}:parameter/citadel/agents/*`,
        ],
      }),
    );
    // F4 (design §6) — resolve the replay-package bucket name (published by
    // TelemetryStack, DECISION d36fbbf7) + write per-case artifacts under
    // eval-runs/*. See EvalRunnerFunction's identical grant below for the
    // shared rationale (this stack cannot reference TelemetryStack's bucket
    // by construct — TelemetryStack instantiates AFTER GovernanceStack).
    this.grantEvalArtifactAccess(
      evalConversationWorkerFunction,
      props.environment,
    );

    evalConversationWorkerFunction.addEventSource(
      new SqsEventSource(evalDispatchQueue, {
        batchSize: 1,
        maxConcurrency: 10,
      }),
    );
    // Resource::* is required here: an eval case's agentTargetId resolves
    // to an AgentCore runtime ARN discovered at RUNTIME via SSM (mirrors
    // AgentMessageHandlerFunction's identical InvokeAgentRuntime grant,
    // backend-stack.ts).
    NagSuppressions.addResourceSuppressionsByPath(
      this,
      `/${this.stackName}/EvalConversationWorkerFunction/ServiceRole/DefaultPolicy/Resource`,
      [
        {
          id: "AwsSolutions-IAM5",
          reason:
            "InvokeAgentRuntime target ARN is resolved at runtime per eval " +
            "case (agentTargetId -> SSM-stored AgentCore runtime ARN, " +
            "potentially cross-region), not known at synth time. Mirrors " +
            "AgentMessageHandlerFunction's identical grant.",
          appliesTo: ["Resource::*"],
        },
      ],
    );

    // eval-runner — Adapter A completion + timeout-sweep entry point
    // (design §1/§3; F3 fix: this Lambda was previously defined only as
    // exported functions with no provisioned handler, so
    // handleWorkflowCompletion/sweepTimeouts were unreachable). Two
    // EventBridge triggers:
    //  - workflow.completed / workflow.failed (Source citadel.workflows,
    //    emitted unchanged by arbiter/stepRunner for EVERY execution, eval
    //    or not — handleWorkflowCompletion itself no-ops on a non-eval
    //    execution by reading the execution row's evalRunId).
    //  - a periodic schedule (5 min) invoking the same Lambda with no
    //    detail-type, which eval-runner.ts's handler routes to
    //    sweepTimeouts (the deadlineAt safety net, design §3).
    const evalRunnerFunction = new lambda.Function(this, "EvalRunnerFunction", {
      runtime: lambda.Runtime.NODEJS_24_X,
      handler: "eval-runner.handler",
      code: lambda.Code.fromAsset("dist/lambda"),
      environment: {
        EVAL_RUNS_TABLE: props.evalRunsTable.tableName,
        EVAL_RUN_CASE_RESULTS_TABLE: props.evalRunCaseResultsTable.tableName,
        EVAL_CASES_TABLE: props.evalCasesTable.tableName,
        EXECUTIONS_TABLE: props.executionsTable.tableName,
        EVENT_BUS_NAME: props.agentEventBus.eventBusName,
        EVAL_DISPATCH_QUEUE_URL: evalDispatchQueue.queueUrl,
        ENVIRONMENT: props.environment,
      },
      timeout: cdk.Duration.minutes(2),
      memorySize: 512,
      logGroup: new logs.LogGroup(this, "EvalRunnerFunctionLogs", {
        retention: logs.RetentionDays.ONE_WEEK,
        removalPolicy: cdk.RemovalPolicy.DESTROY,
      }),
    });

    props.evalRunsTable.grantReadWriteData(evalRunnerFunction);
    props.evalRunCaseResultsTable.grantReadWriteData(evalRunnerFunction);
    props.evalCasesTable.grantReadData(evalRunnerFunction);
    props.executionsTable.grantReadData(evalRunnerFunction);
    props.agentEventBus.grantPutEventsTo(evalRunnerFunction);
    // F4: same rationale as evalConversationWorkerFunction's identical
    // grant above — handleWorkflowCompletion (Adapter A completion path)
    // also calls recordCaseCompletion, which materializes EXECUTION-kind
    // case artifacts.
    this.grantEvalArtifactAccess(evalRunnerFunction, props.environment);

    new events.Rule(this, "EvalWorkflowCompletionRule", {
      eventBus: props.agentEventBus,
      ruleName: `citadel-eval-workflow-completion-${props.environment}`,
      description:
        "Routes workflow.completed/workflow.failed (Source citadel.workflows, " +
        "emitted by arbiter/stepRunner for every execution) to eval-runner " +
        "so EXECUTION-kind eval cases record completion. No-ops on " +
        "non-eval executions inside the handler.",
      eventPattern: {
        source: ["citadel.workflows"],
        detailType: ["workflow.completed", "workflow.failed"],
      },
      targets: [
        new targets.LambdaFunction(evalRunnerFunction, {
          retryAttempts: 2,
        }),
      ],
    });

    new events.Rule(this, "EvalTimeoutSweepRule", {
      ruleName: `citadel-eval-timeout-sweep-${props.environment}`,
      description:
        "Periodic safety net (design §3): invokes eval-runner with no " +
        "detail-type, which sweepTimeouts marks any DISPATCHED/RUNNING " +
        "case past its deadlineAt as TIMEOUT.",
      schedule: events.Schedule.rate(cdk.Duration.minutes(5)),
      targets: [new targets.LambdaFunction(evalRunnerFunction)],
    });

    // ============================================================
    // InterrogationRound Resolver
    // ============================================================

    const interrogationRoundResolverFunction = new lambda.Function(
      this,
      "InterrogationRoundResolverFunction",
      {
        runtime: lambda.Runtime.NODEJS_24_X,
        handler: "interrogation-round-resolver.handler",
        code: lambda.Code.fromAsset("dist/lambda"),
        environment: {
          INTERROGATION_ROUNDS_TABLE: props.interrogationRoundsTable.tableName,
          GOVERNANCE_TRANSCRIPTS_BUCKET: governanceTranscriptsBucket.bucketName,
          EVENT_BUS_NAME: props.agentEventBus.eventBusName,
        },
        timeout: cdk.Duration.seconds(30),
        logGroup: new logs.LogGroup(
          this,
          "InterrogationRoundResolverFunctionLogs",
          {
            retention: logs.RetentionDays.ONE_WEEK,
            removalPolicy: cdk.RemovalPolicy.DESTROY,
          },
        ),
      },
    );

    props.interrogationRoundsTable.grantReadWriteData(
      interrogationRoundResolverFunction,
    );
    governanceTranscriptsBucket.grantWrite(interrogationRoundResolverFunction);
    governanceTranscriptsKey.grantEncryptDecrypt(
      interrogationRoundResolverFunction,
    );
    props.agentEventBus.grantPutEventsTo(interrogationRoundResolverFunction);

    const interrogationRoundDataSourceRole = new iam.Role(
      this,
      "InterrogationRoundDataSourceRole",
      {
        assumedBy: new iam.ServicePrincipal("appsync.amazonaws.com"),
      },
    );
    interrogationRoundResolverFunction.grantInvoke(
      interrogationRoundDataSourceRole,
    );

    const interrogationRoundLambdaDataSource = new appsyncCfn.CfnDataSource(
      this,
      "InterrogationRoundLambdaDataSource",
      {
        apiId: props.appSyncApi.apiId,
        name: "InterrogationRoundLambdaDataSource",
        type: "AWS_LAMBDA",
        serviceRoleArn: interrogationRoundDataSourceRole.roleArn,
        lambdaConfig: {
          lambdaFunctionArn: interrogationRoundResolverFunction.functionArn,
        },
      },
    );

    const startInterrogationRoundResolver = new appsyncCfn.CfnResolver(
      this,
      "StartInterrogationRoundResolver",
      {
        apiId: props.appSyncApi.apiId,
        typeName: "Mutation",
        fieldName: "startInterrogationRound",
        dataSourceName: interrogationRoundLambdaDataSource.attrName,
        requestMappingTemplate: LAMBDA_REQUEST_MAPPING,
        responseMappingTemplate: LAMBDA_RESPONSE_MAPPING,
      },
    );
    startInterrogationRoundResolver.addResourceDependency(
      interrogationRoundLambdaDataSource,
    );

    const injectConstraintsResolver = new appsyncCfn.CfnResolver(
      this,
      "InjectConstraintsResolver",
      {
        apiId: props.appSyncApi.apiId,
        typeName: "Mutation",
        fieldName: "injectConstraints",
        dataSourceName: interrogationRoundLambdaDataSource.attrName,
        requestMappingTemplate: LAMBDA_REQUEST_MAPPING,
        responseMappingTemplate: LAMBDA_RESPONSE_MAPPING,
      },
    );
    injectConstraintsResolver.addResourceDependency(
      interrogationRoundLambdaDataSource,
    );

    const stabiliseRoundResolver = new appsyncCfn.CfnResolver(
      this,
      "StabiliseRoundResolver",
      {
        apiId: props.appSyncApi.apiId,
        typeName: "Mutation",
        fieldName: "stabiliseRound",
        dataSourceName: interrogationRoundLambdaDataSource.attrName,
        requestMappingTemplate: LAMBDA_REQUEST_MAPPING,
        responseMappingTemplate: LAMBDA_RESPONSE_MAPPING,
      },
    );
    stabiliseRoundResolver.addResourceDependency(
      interrogationRoundLambdaDataSource,
    );

    const getInterrogationRoundResolver = new appsyncCfn.CfnResolver(
      this,
      "GetInterrogationRoundResolver",
      {
        apiId: props.appSyncApi.apiId,
        typeName: "Query",
        fieldName: "getInterrogationRound",
        dataSourceName: interrogationRoundLambdaDataSource.attrName,
        requestMappingTemplate: LAMBDA_REQUEST_MAPPING,
        responseMappingTemplate: LAMBDA_RESPONSE_MAPPING,
      },
    );
    getInterrogationRoundResolver.addResourceDependency(
      interrogationRoundLambdaDataSource,
    );

    const listInterrogationRoundsResolver = new appsyncCfn.CfnResolver(
      this,
      "ListInterrogationRoundsResolver",
      {
        apiId: props.appSyncApi.apiId,
        typeName: "Query",
        fieldName: "listInterrogationRounds",
        dataSourceName: interrogationRoundLambdaDataSource.attrName,
        requestMappingTemplate: LAMBDA_REQUEST_MAPPING,
        responseMappingTemplate: LAMBDA_RESPONSE_MAPPING,
      },
    );
    listInterrogationRoundsResolver.addResourceDependency(
      interrogationRoundLambdaDataSource,
    );

    // Suppress the KMS wildcards that grantEncryptDecrypt() on the
    // governanceTranscriptsKey adds to the function's DefaultPolicy. These
    // actions (kms:GenerateDataKey*, kms:ReEncrypt*) are required by the S3
    // SSE-KMS PutObject code path and are already scoped to the single KMS
    // key resource (governanceTranscriptsKey) by CDK's grant method.
    NagSuppressions.addResourceSuppressions(
      interrogationRoundResolverFunction,
      [
        {
          id: "AwsSolutions-IAM5",
          reason:
            "kms:GenerateDataKey* and kms:ReEncrypt* are required by the S3 SSE-KMS " +
            "PutObject code path when writing interrogation-round transcripts. The " +
            "wildcards are action-level only; the resource scope is already narrowed " +
            "to governanceTranscriptsKey by CDK grantEncryptDecrypt().",
          appliesTo: ["Action::kms:GenerateDataKey*", "Action::kms:ReEncrypt*"],
        },
      ],
      true,
    );

    // ============================================================
    // AgentDesignAssessment Resolver
    // ============================================================
    // Contract: types/index.ts FourDimension + AgentDesignAssessment + interface

    const agentDesignAssessmentResolverFunction = new lambda.Function(
      this,
      "AgentDesignAssessmentResolverFunction",
      {
        runtime: lambda.Runtime.NODEJS_24_X,
        handler: "agent-design-assessment-resolver.handler",
        code: lambda.Code.fromAsset("dist/lambda"),
        environment: {
          AGENT_DESIGN_ASSESSMENTS_TABLE:
            props.agentDesignAssessmentsTable.tableName,
          PROJECTS_TABLE: props.projectsTable.tableName,
          EVENT_BUS_NAME: props.agentEventBus.eventBusName,
        },
        timeout: cdk.Duration.seconds(30),
        logGroup: new logs.LogGroup(
          this,
          "AgentDesignAssessmentResolverFunctionLogs",
          {
            retention: logs.RetentionDays.ONE_WEEK,
            removalPolicy: cdk.RemovalPolicy.DESTROY,
          },
        ),
      },
    );

    props.agentDesignAssessmentsTable.grantReadWriteData(
      agentDesignAssessmentResolverFunction,
    );
    props.projectsTable.grantReadWriteData(
      agentDesignAssessmentResolverFunction,
    );
    props.agentEventBus.grantPutEventsTo(agentDesignAssessmentResolverFunction);

    const agentDesignAssessmentDataSourceRole = new iam.Role(
      this,
      "AgentDesignAssessmentDataSourceRole",
      {
        assumedBy: new iam.ServicePrincipal("appsync.amazonaws.com"),
      },
    );
    agentDesignAssessmentResolverFunction.grantInvoke(
      agentDesignAssessmentDataSourceRole,
    );

    const agentDesignAssessmentLambdaDataSource = new appsyncCfn.CfnDataSource(
      this,
      "AgentDesignAssessmentLambdaDataSource",
      {
        apiId: props.appSyncApi.apiId,
        name: "AgentDesignAssessmentLambdaDataSource",
        type: "AWS_LAMBDA",
        serviceRoleArn: agentDesignAssessmentDataSourceRole.roleArn,
        lambdaConfig: {
          lambdaFunctionArn: agentDesignAssessmentResolverFunction.functionArn,
        },
      },
    );

    const startAgentDesignAssessmentResolver = new appsyncCfn.CfnResolver(
      this,
      "StartAgentDesignAssessmentResolver",
      {
        apiId: props.appSyncApi.apiId,
        typeName: "Mutation",
        fieldName: "startAgentDesignAssessment",
        dataSourceName: agentDesignAssessmentLambdaDataSource.attrName,
        requestMappingTemplate: LAMBDA_REQUEST_MAPPING,
        responseMappingTemplate: LAMBDA_RESPONSE_MAPPING,
      },
    );
    startAgentDesignAssessmentResolver.addResourceDependency(
      agentDesignAssessmentLambdaDataSource,
    );

    const submitAgentDesignAssessmentResolver = new appsyncCfn.CfnResolver(
      this,
      "SubmitAgentDesignAssessmentResolver",
      {
        apiId: props.appSyncApi.apiId,
        typeName: "Mutation",
        fieldName: "submitAgentDesignAssessment",
        dataSourceName: agentDesignAssessmentLambdaDataSource.attrName,
        requestMappingTemplate: LAMBDA_REQUEST_MAPPING,
        responseMappingTemplate: LAMBDA_RESPONSE_MAPPING,
      },
    );
    submitAgentDesignAssessmentResolver.addResourceDependency(
      agentDesignAssessmentLambdaDataSource,
    );

    const getAgentDesignAssessmentResolver = new appsyncCfn.CfnResolver(
      this,
      "GetAgentDesignAssessmentResolver",
      {
        apiId: props.appSyncApi.apiId,
        typeName: "Query",
        fieldName: "getAgentDesignAssessment",
        dataSourceName: agentDesignAssessmentLambdaDataSource.attrName,
        requestMappingTemplate: LAMBDA_REQUEST_MAPPING,
        responseMappingTemplate: LAMBDA_RESPONSE_MAPPING,
      },
    );
    getAgentDesignAssessmentResolver.addResourceDependency(
      agentDesignAssessmentLambdaDataSource,
    );

    // ============================================================
    // ProgramReview Resolver (Δ12)
    // ============================================================
    // Checklist: backend/src/lambda/governance-checklist.md (20 questions, 5 clusters)
    //
    // runProgramReview is a read-only evaluation that joins evidence across
    // ADRs, ExecutionSpecifications, InterrogationRounds, and
    // AgentDesignAssessments, then persists a ProgramReview row. No governance
    // EventBridge event is emitted — see docs/EVENTBRIDGE_CATALOG.md.
    //
    // The checklist markdown is bundled next to the handler in dist/lambda/
    // by the `copy:templates` npm script so the resolver can parse it at
    // cold-start via path.join(__dirname, 'governance-checklist.md').

    const programReviewResolverFunction = new lambda.Function(
      this,
      "ProgramReviewResolverFunction",
      {
        runtime: lambda.Runtime.NODEJS_24_X,
        handler: "program-review-resolver.handler",
        code: lambda.Code.fromAsset("dist/lambda"),
        environment: {
          PROGRAM_REVIEWS_TABLE: props.programReviewsTable.tableName,
          ADRS_TABLE: props.adrsTable.tableName,
          EXECUTION_SPECS_TABLE: props.executionSpecificationsTable.tableName,
          INTERROGATION_ROUNDS_TABLE: props.interrogationRoundsTable.tableName,
          AGENT_DESIGN_ASSESSMENTS_TABLE:
            props.agentDesignAssessmentsTable.tableName,
          ENVIRONMENT: props.environment,
        },
        timeout: cdk.Duration.seconds(30),
        logGroup: new logs.LogGroup(this, "ProgramReviewResolverFunctionLogs", {
          retention: logs.RetentionDays.ONE_WEEK,
          removalPolicy: cdk.RemovalPolicy.DESTROY,
        }),
      },
    );

    props.programReviewsTable.grantReadWriteData(programReviewResolverFunction);
    props.adrsTable.grantReadData(programReviewResolverFunction);
    props.executionSpecificationsTable.grantReadData(
      programReviewResolverFunction,
    );
    props.interrogationRoundsTable.grantReadData(programReviewResolverFunction);
    props.agentDesignAssessmentsTable.grantReadData(
      programReviewResolverFunction,
    );

    const programReviewDataSourceRole = new iam.Role(
      this,
      "ProgramReviewDataSourceRole",
      {
        assumedBy: new iam.ServicePrincipal("appsync.amazonaws.com"),
      },
    );
    programReviewResolverFunction.grantInvoke(programReviewDataSourceRole);

    const programReviewLambdaDataSource = new appsyncCfn.CfnDataSource(
      this,
      "ProgramReviewLambdaDataSource",
      {
        apiId: props.appSyncApi.apiId,
        name: "ProgramReviewLambdaDataSource",
        type: "AWS_LAMBDA",
        serviceRoleArn: programReviewDataSourceRole.roleArn,
        lambdaConfig: {
          lambdaFunctionArn: programReviewResolverFunction.functionArn,
        },
      },
    );

    const runProgramReviewResolver = new appsyncCfn.CfnResolver(
      this,
      "RunProgramReviewResolver",
      {
        apiId: props.appSyncApi.apiId,
        typeName: "Mutation",
        fieldName: "runProgramReview",
        dataSourceName: programReviewLambdaDataSource.attrName,
        requestMappingTemplate: LAMBDA_REQUEST_MAPPING,
        responseMappingTemplate: LAMBDA_RESPONSE_MAPPING,
      },
    );
    runProgramReviewResolver.addResourceDependency(
      programReviewLambdaDataSource,
    );

    const getProgramReviewResolver = new appsyncCfn.CfnResolver(
      this,
      "GetProgramReviewResolver",
      {
        apiId: props.appSyncApi.apiId,
        typeName: "Query",
        fieldName: "getProgramReview",
        dataSourceName: programReviewLambdaDataSource.attrName,
        requestMappingTemplate: LAMBDA_REQUEST_MAPPING,
        responseMappingTemplate: LAMBDA_RESPONSE_MAPPING,
      },
    );
    getProgramReviewResolver.addResourceDependency(
      programReviewLambdaDataSource,
    );

    const listProgramReviewsForProjectResolver = new appsyncCfn.CfnResolver(
      this,
      "ListProgramReviewsForProjectResolver",
      {
        apiId: props.appSyncApi.apiId,
        typeName: "Query",
        fieldName: "listProgramReviewsForProject",
        dataSourceName: programReviewLambdaDataSource.attrName,
        requestMappingTemplate: LAMBDA_REQUEST_MAPPING,
        responseMappingTemplate: LAMBDA_RESPONSE_MAPPING,
      },
    );
    listProgramReviewsForProjectResolver.addResourceDependency(
      programReviewLambdaDataSource,
    );
  }

  /**
   * F4 (CIT-102 design §6, DECISION d36fbbf7 binding): grants an eval
   * Lambda `ssm:GetParameter` on the RUNTIME-published replay-package
   * bucket-name parameter, plus S3 Put/Get scoped to that bucket's
   * `eval-runs/*` prefix.
   *
   * Both resource ARNs are necessarily WILDCARD-shaped rather than exact
   * matches, for two independent, narrowly-scoped reasons:
   *
   *  - The parameter ARN's NAME segment is fully known at synth time
   *    (`/citadel/eval-replay-bucket-${environment}`, the exact literal
   *    TelemetryStack publishes it under — see telemetry-stack.ts
   *    ReplayPackageBucketNameParam) so this grant does NOT need
   *    Resource:* for SSM; it is a single exact parameter ARN.
   *  - The BUCKET ARN, by contrast, genuinely cannot be pinned exactly:
   *    the bucket itself has no explicit `bucketName` in TelemetryStack
   *    (see telemetry-stack.ts ReplayPackageBucket), so CloudFormation
   *    appends a random unique suffix at stack-create time — precisely
   *    BECAUSE TelemetryStack cannot be constructed before GovernanceStack
   *    (the reason SSM publication was chosen at all). The stack-name and
   *    logical-id prefix (`citadel-telemetry-${environment}-` +
   *    `replaypackagebucket`, CloudFormation's own deterministic
   *    auto-naming convention, confirmed against
   *    cdk.out/citadel-telemetry-test.template.json) ARE synth-time
   *    literals, so only the random suffix is wildcarded — the SAME
   *    precedent as backend-stack.ts's `citadel-schemas-*` /
   *    registry-stack.ts's `citadel-code-*` synth-time-composed bucket
   *    ARNs, except here the composition happens at RUNTIME (inside
   *    eval-artifact-store.ts, via the resolved SSM value) rather than at
   *    synth time, so the IAM policy is the one place that must still
   *    accept a suffix wildcard rather than a full literal. The S3 actions
   *    are scoped to the `eval-runs/*` object prefix (not a bucket-wide
   *    grant), and further scoped to Put/Get only (no Delete/List) —
   *    narrowest permission set that satisfies "write one case artifact,
   *    then optionally read it back" (design §6 does not require listing).
   */
  private grantEvalArtifactAccess(
    fn: lambda.Function,
    environment: string,
    objectPrefixes: string[] = ["eval-runs/*"],
  ): void {
    const paramArn = `arn:aws:ssm:${this.region}:${this.account}:parameter/citadel/eval-replay-bucket-${environment}`;
    // CloudFormation's own deterministic naming convention for an S3 bucket
    // with no explicit `BucketName` (telemetry-stack.ts ReplayPackageBucket
    // sets none, confirmed via cdk.out/citadel-telemetry-test.template.json):
    // `{stack-name-lowercased}-{logical-id-lowercased}-{unique-suffix}`. The
    // stack name (`citadel-telemetry-${environment}`, cdk.Stack's own naming
    // convention — bin/app.ts `citadel-telemetry-${environment}`) and the
    // logical id (`ReplayPackageBucket`) are BOTH synth-time literals, so
    // the wildcard only needs to absorb the random CFN-generated suffix —
    // it is not a bare `*`.
    const bucketArnPattern = `arn:aws:s3:::citadel-telemetry-${environment}-replaypackagebucket*`;

    fn.addToRolePolicy(
      new iam.PolicyStatement({
        effect: iam.Effect.ALLOW,
        actions: ["ssm:GetParameter"],
        resources: [paramArn],
      }),
    );
    const objectResources = objectPrefixes.map(
      (prefix) => `${bucketArnPattern}/${prefix}`,
    );
    fn.addToRolePolicy(
      new iam.PolicyStatement({
        effect: iam.Effect.ALLOW,
        actions: ["s3:PutObject", "s3:GetObject"],
        resources: objectResources,
      }),
    );

    NagSuppressions.addResourceSuppressionsByPath(
      this,
      `/${this.stackName}/${fn.node.id}/ServiceRole/DefaultPolicy/Resource`,
      [
        {
          id: "AwsSolutions-IAM5",
          reason:
            "S3 object ARN uses a bucket-name wildcard because the replay-" +
            "package bucket (owned by TelemetryStack, which instantiates " +
            "AFTER this stack in bin/app.ts) is not referenceable as a CDK " +
            "construct here; its name is published to SSM and resolved at " +
            "RUNTIME (DECISION d36fbbf7). The wildcard absorbs only " +
            "CloudFormation's own random bucket-name suffix — the stack-" +
            "name and logical-id prefix (citadel-telemetry-{env}-" +
            "replaypackagebucket) are synth-time literals, and the pattern " +
            "is further scoped to a specific object prefix (eval-runs/* " +
            "and/or eval-comparisons/*, per caller) with just " +
            "s3:PutObject/s3:GetObject (no Delete/List) — mirrors the " +
            "existing synth-time-composed wildcard bucket ARN precedents " +
            "(backend-stack.ts citadel-schemas-*, registry-stack.ts " +
            "citadel-code-*), applied here at the IAM-resource-pattern " +
            "level since the bucket's random suffix cannot be synth-time-" +
            "literal for the stack-ordering reason above.",
          appliesTo: objectResources.map((resource) => `Resource::${resource}`),
        },
      ],
    );
  }
}
