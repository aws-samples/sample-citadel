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
import * as cloudwatch from "aws-cdk-lib/aws-cloudwatch";
import * as cw_actions from "aws-cdk-lib/aws-cloudwatch-actions";
import * as sns from "aws-cdk-lib/aws-sns";
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
  // Agent release bundles (slices 1-2) — owned by BackendStack. The
  // release-resolver Lambda ASSUMES agentReleaseWriterRole (the sole
  // Put/Get/Query-only IAM floor for this table, see backend-stack.ts's
  // AgentReleasesTable construction site) rather than being granted
  // grantReadWriteData — no principal may hold UpdateItem/DeleteItem on
  // this table, by design.
  agentReleasesTable: dynamodb.ITable;
  agentReleaseWriterRole: iam.IRole;
  /** AgentCore Registry handles — release-resolver reads the registry
   * record (agent config) being released via GetRegistryRecord only. */
  registryArn: string;
  registryId: string;
  // Environment release pointer (follow-on to slices 1-2) — owned by
  // BackendStack, consumed here by environment-release-pointer-resolver.
  // Deliberately a SEPARATE table AND a SEPARATE role from
  // agentReleasesTable/agentReleaseWriterRole above — see the invariant
  // documented on backend-stack.ts's EnvironmentReleasePointersTable
  // construction site: this role's write capability must never be
  // co-granted on AgentReleasesTable.
  environmentReleasePointersTable: dynamodb.ITable;
  environmentReleasePointerWriterRole: iam.IRole;
  // Decision ada70113 (promotion policy becomes per-org config) — owned
  // by BackendStack, consumed here by the new admin
  // promotion-policy-resolver (getPromotionPolicy/setPromotionPolicy).
  // The READ side used by validateReleaseGate itself is wired via the
  // ALREADY-passed environmentReleasePointerWriterRole above (that role
  // carries an additional scoped GetItem statement for this table — see
  // backend-stack.ts's construction site); this prop pair is for the
  // SEPARATE admin resolver Lambda only.
  promotionPolicyConfigTable: dynamodb.ITable;
  promotionPolicyConfigWriterRole: iam.IRole;
  /** Shared SLO alarm topic (from BackendStack) — the auto-rollback
   * evaluator's finding-write-failure alarm (decision D6) posts here so a
   * committed-but-unrecorded rollback pages. Optional so existing test
   * scaffolds that omit it still synth. */
  alarmTopic?: sns.ITopic;
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
    // AgentRelease Resolver (cutAgentRelease reachability, wiring only)
    // ============================================================
    //
    // release-resolver.ts (slice 2, already implemented/tested) is wired
    // here rather than created in BackendStack, mirroring the eval-run
    // resolver's home: governance-grade audit records live in
    // GovernanceStack alongside their AppSync wiring. Two invariants:
    //  - This function's execution role IS agentReleaseWriterRole
    //    (`role:` prop below), ASSUMED rather than granted via
    //    grantReadWriteData — the sole Put/Get/Query-only IAM floor for
    //    AgentReleasesTable (backend-stack.ts). No additional grant is
    //    issued against that table from this stack.
    //  - Every other table this resolver reads for cross-validation
    //    (execution specs, eval runs, eval suites, projects) receives a
    //    SEPARATE, narrower read-side grant. Eval suites additionally
    //    need write access for the suite-reference freeze step
    //    (markEvalSuiteReferencedForRelease), but this MUST NOT be a
    //    grantReadWriteData call: the function's role is the SHARED
    //    AgentReleaseWriterRole, so a table-level grantReadWriteData
    //    would hand DeleteItem/BatchWriteItem/UpdateItem on that table
    //    to every principal that assumes the role. Instead: a plain
    //    read-only grant plus one hand-written UpdateItem-only
    //    PolicyStatement, scoped to exactly the action the resolver
    //    issues (a single UpdateCommand by primary key).
    const agentReleaseResolverFunction = new lambda.Function(
      this,
      "AgentReleaseResolverFunction",
      {
        runtime: lambda.Runtime.NODEJS_24_X,
        handler: "release-resolver.handler",
        code: lambda.Code.fromAsset("dist/lambda"),
        role: props.agentReleaseWriterRole,
        environment: {
          AGENT_RELEASES_TABLE: props.agentReleasesTable.tableName,
          EXECUTION_SPECS_TABLE: props.executionSpecificationsTable.tableName,
          EVAL_RUNS_TABLE: props.evalRunsTable.tableName,
          EVAL_SUITES_TABLE: props.evalSuitesTable.tableName,
          PROJECTS_TABLE: props.projectsTable.tableName,
          REGISTRY_ID: props.registryId,
        },
        timeout: cdk.Duration.seconds(30),
        logGroup: new logs.LogGroup(this, "AgentReleaseResolverFunctionLogs", {
          retention: logs.RetentionDays.ONE_WEEK,
          removalPolicy: cdk.RemovalPolicy.DESTROY,
        }),
      },
    );

    props.executionSpecificationsTable.grantReadData(
      agentReleaseResolverFunction,
    );
    props.evalRunsTable.grantReadData(agentReleaseResolverFunction);
    // Read: general suite lookups performed by the resolver.
    props.evalSuitesTable.grantReadData(agentReleaseResolverFunction);
    // Write: markEvalSuiteReferencedForRelease issues a single UpdateCommand
    // (by primary key) against EvalSuitesTable to freeze the referenced
    // suite's `references` attribute. A scoped UpdateItem-only statement is
    // used deliberately instead of grantReadWriteData — this function's
    // role is the SHARED AgentReleaseWriterRole (assumed, not a fresh
    // per-function role), so a grantReadWriteData call here would also
    // hand that role dynamodb:DeleteItem/BatchWriteItem/UpdateItem on
    // EvalSuitesTable, widening every principal that can assume the role.
    // This statement only ever needs UpdateItem.
    agentReleaseResolverFunction.addToRolePolicy(
      new iam.PolicyStatement({
        effect: iam.Effect.ALLOW,
        actions: ["dynamodb:UpdateItem"],
        resources: [props.evalSuitesTable.tableArn],
      }),
    );
    props.projectsTable.grantReadData(agentReleaseResolverFunction);
    agentReleaseResolverFunction.addToRolePolicy(
      new iam.PolicyStatement({
        effect: iam.Effect.ALLOW,
        actions: ["bedrock-agentcore:GetRegistryRecord"],
        resources: [props.registryArn, `${props.registryArn}/*`],
      }),
    );

    const agentReleaseDataSourceRole = new iam.Role(
      this,
      "AgentReleaseDataSourceRole",
      {
        assumedBy: new iam.ServicePrincipal("appsync.amazonaws.com"),
      },
    );
    agentReleaseResolverFunction.grantInvoke(agentReleaseDataSourceRole);

    const agentReleaseLambdaDataSource = new appsyncCfn.CfnDataSource(
      this,
      "AgentReleaseLambdaDataSource",
      {
        apiId: props.appSyncApi.apiId,
        name: "AgentReleaseLambdaDataSource",
        type: "AWS_LAMBDA",
        serviceRoleArn: agentReleaseDataSourceRole.roleArn,
        lambdaConfig: {
          lambdaFunctionArn: agentReleaseResolverFunction.functionArn,
        },
      },
    );

    const cutAgentReleaseResolver = new appsyncCfn.CfnResolver(
      this,
      "CutAgentReleaseResolver",
      {
        apiId: props.appSyncApi.apiId,
        typeName: "Mutation",
        fieldName: "cutAgentRelease",
        dataSourceName: agentReleaseLambdaDataSource.attrName,
        requestMappingTemplate: LAMBDA_REQUEST_MAPPING,
        responseMappingTemplate: LAMBDA_RESPONSE_MAPPING,
      },
    );
    cutAgentReleaseResolver.addResourceDependency(agentReleaseLambdaDataSource);

    // ============================================================
    // ReleaseDiff Resolver (releaseDiff query — read-only)
    // ============================================================
    //
    // Deliberately its OWN function, OWN least-privilege role, and OWN
    // AppSync data source — never reuses agentReleaseWriterRole (that
    // role's Put/Get/Query-only floor is scoped to being the SOLE
    // *writer* for AgentReleasesTable per release-store.ts's choke-point
    // doctrine; a read-only diff query has no business assuming a writer
    // role) and never reuses environmentReleasePointerWriterRole either
    // (that role's grant surface is scoped to promotion/canary
    // mutations, not an arbitrary two-release read). This function's
    // role carries GetItem-ONLY on AgentReleasesTable and EvalRunsTable
    // — release-diff-resolver.ts never issues any other DynamoDB action.
    const releaseDiffResolverFunction = new lambda.Function(
      this,
      "ReleaseDiffResolverFunction",
      {
        runtime: lambda.Runtime.NODEJS_24_X,
        handler: "release-diff-resolver.handler",
        code: lambda.Code.fromAsset("dist/lambda"),
        environment: {
          AGENT_RELEASES_TABLE: props.agentReleasesTable.tableName,
          EVAL_RUNS_TABLE: props.evalRunsTable.tableName,
        },
        timeout: cdk.Duration.seconds(30),
        logGroup: new logs.LogGroup(this, "ReleaseDiffResolverFunctionLogs", {
          retention: logs.RetentionDays.ONE_WEEK,
          removalPolicy: cdk.RemovalPolicy.DESTROY,
        }),
      },
    );

    releaseDiffResolverFunction.addToRolePolicy(
      new iam.PolicyStatement({
        effect: iam.Effect.ALLOW,
        actions: ["dynamodb:GetItem"],
        resources: [props.agentReleasesTable.tableArn],
      }),
    );
    releaseDiffResolverFunction.addToRolePolicy(
      new iam.PolicyStatement({
        effect: iam.Effect.ALLOW,
        actions: ["dynamodb:GetItem"],
        resources: [props.evalRunsTable.tableArn],
      }),
    );

    const releaseDiffDataSourceRole = new iam.Role(
      this,
      "ReleaseDiffDataSourceRole",
      {
        assumedBy: new iam.ServicePrincipal("appsync.amazonaws.com"),
      },
    );
    releaseDiffResolverFunction.grantInvoke(releaseDiffDataSourceRole);

    const releaseDiffLambdaDataSource = new appsyncCfn.CfnDataSource(
      this,
      "ReleaseDiffLambdaDataSource",
      {
        apiId: props.appSyncApi.apiId,
        name: "ReleaseDiffLambdaDataSource",
        type: "AWS_LAMBDA",
        serviceRoleArn: releaseDiffDataSourceRole.roleArn,
        lambdaConfig: {
          lambdaFunctionArn: releaseDiffResolverFunction.functionArn,
        },
      },
    );

    const releaseDiffResolver = new appsyncCfn.CfnResolver(
      this,
      "ReleaseDiffResolver",
      {
        apiId: props.appSyncApi.apiId,
        typeName: "Query",
        fieldName: "releaseDiff",
        dataSourceName: releaseDiffLambdaDataSource.attrName,
        requestMappingTemplate: LAMBDA_REQUEST_MAPPING,
        responseMappingTemplate: LAMBDA_RESPONSE_MAPPING,
      },
    );
    releaseDiffResolver.addResourceDependency(releaseDiffLambdaDataSource);

    // ============================================================
    // Environment Release Pointer Resolver (mutable per-environment cursor)
    // ============================================================
    //
    // Own function, own AppSync data source, and — the invariant this
    // slice is delicate about — its OWN, SEPARATE execution role
    // (environmentReleasePointerWriterRole), never
    // agentReleaseWriterRole. This function's role is granted
    // PutItem/GetItem/Query on EnvironmentReleasePointersTable ONLY (see
    // backend-stack.ts's construction site); AgentReleasesTable access
    // (to validate the target release exists and belongs to the caller's
    // org) is a SEPARATE, narrower grantReadData call below —
    // grantReadData only ever adds GetItem/Query/BatchGetItem, never a
    // write action, so it cannot widen either table's write floor. No
    // statement anywhere names both tables, which
    // backend-stack-environment-release-pointer-table.test.ts asserts
    // directly.
    //
    // G6 — append-only promotion history table (provisioned here per the
    // design's file-by-file change map). PK orgId, SK historySortKey
    // (`${agentTargetId}#${environment}#${promotedAt}#${version}`). Same
    // durable posture as the pointer table (RETAIN + deletionProtection +
    // PITR): the time-series of every move is deployment history that
    // must survive stack updates. Written ATOMICALLY with the pointer
    // move by the sole pointer writer; the writer role's grant lives in
    // backend-stack.ts (deterministic ARN string, cycle-free — see
    // there). No construct-based grant is issued here (that would create
    // a governance→backend→governance cycle via the imported role).
    const environmentReleasePointerHistoryTable = new dynamodb.Table(
      this,
      "EnvironmentReleasePointerHistoryTable",
      {
        tableName: `citadel-environment-release-pointer-history-${props.environment}`,
        partitionKey: { name: "orgId", type: dynamodb.AttributeType.STRING },
        sortKey: {
          name: "historySortKey",
          type: dynamodb.AttributeType.STRING,
        },
        billingMode: dynamodb.BillingMode.PAY_PER_REQUEST,
        removalPolicy: cdk.RemovalPolicy.RETAIN,
        deletionProtection: true,
        pointInTimeRecoverySpecification: { pointInTimeRecoveryEnabled: true },
      },
    );

    const environmentReleasePointerResolverFunction = new lambda.Function(
      this,
      "EnvironmentReleasePointerResolverFunction",
      {
        runtime: lambda.Runtime.NODEJS_24_X,
        handler: "environment-release-pointer-resolver.handler",
        code: lambda.Code.fromAsset("dist/lambda"),
        role: props.environmentReleasePointerWriterRole,
        environment: {
          ENVIRONMENT_RELEASE_POINTERS_TABLE:
            props.environmentReleasePointersTable.tableName,
          // G6 — append-only promotion history. Written ATOMICALLY with
          // the pointer move (TransactWriteItems) by the sole pointer
          // writer, and read by the environmentReleasePointerHistory
          // query. The writer role's PutItem/GetItem/Query grant on this
          // table is added in backend-stack.ts by deterministic ARN
          // string (the table is provisioned in THIS stack, which is
          // instantiated after BackendStack — a construct reference from
          // there would be a cyclic dependency, same pattern as the
          // GOVERNANCE_LEDGER_TABLE grant). Deterministic name matches
          // the string ARN backend-stack.ts grants against.
          ENVIRONMENT_RELEASE_POINTER_HISTORY_TABLE:
            environmentReleasePointerHistoryTable.tableName,
          AGENT_RELEASES_TABLE: props.agentReleasesTable.tableName,
          // Decision ada70113: validateReleaseGate resolves the
          // per-org/per-agent promotion policy via
          // promotion-policy-store.ts's resolvePromotionPolicy before
          // any evidence read. This role (environmentReleasePointerWriterRole)
          // carries an ADDITIONAL scoped GetItem-only statement for this
          // table (backend-stack.ts construction site) — no PutItem, the
          // gate never authors policy.
          PROMOTION_POLICY_CONFIG_TABLE:
            props.promotionPolicyConfigTable.tableName,
          // Finding 23971f32: this function calls
          // writeReleaseGateFinding (release-gate-finding-writer.ts) in
          // BOTH shadow and strict mode before the pointer moves — the
          // env var was previously missing entirely, so every write
          // failed with a runtime `GOVERNANCE_LEDGER_TABLE!` crash
          // (non-null assertion on `undefined`). Deterministic name,
          // same string arbiter-stack.ts uses to construct the actual
          // table (`citadel-governance-ledger-${environment}`) — see
          // backend-stack.ts's environmentReleasePointerWriterRole PutItem
          // grant for why this is a literal string, not a construct
          // reference.
          GOVERNANCE_LEDGER_TABLE: `citadel-governance-ledger-${props.environment}`,
          // G5 — best-effort RELEASE_POINTER_MOVED emit target. The
          // writer role's PutEvents grant on this bus is added in
          // backend-stack.ts (bus is BackendStack-owned).
          EVENT_BUS_NAME: props.agentEventBus.eventBusName,
          // Additive candidate-vs-stable diff embedding
          // (resolveCandidateVsStableDiff in
          // environment-release-pointer-resolver.ts calls into
          // release-diff-resolver.ts's releaseDiff, which resolves each
          // side's score vector from EvalRunsTable). GetItem-only grant
          // below — the diff path never writes to this table.
          EVAL_RUNS_TABLE: props.evalRunsTable.tableName,
        },
        timeout: cdk.Duration.seconds(30),
        logGroup: new logs.LogGroup(
          this,
          "EnvironmentReleasePointerResolverFunctionLogs",
          {
            retention: logs.RetentionDays.ONE_WEEK,
            removalPolicy: cdk.RemovalPolicy.DESTROY,
          },
        ),
      },
    );

    // Read-only: existence + org-ownership check against the target
    // release, via a single GetCommand by primary key (never a batch or
    // scan). A hand-scoped PolicyStatement is used here instead of
    // grantReadData deliberately — grantReadData's standard action set
    // includes BatchGetItem, which would violate this table's
    // established narrow allowlist (PutItem/GetItem/Query only, enforced
    // by backend-stack-agent-releases-table.test.ts /
    // governance-stack-agent-release.test.ts) even though BatchGetItem is
    // itself a read-only action. GetItem is all this resolver's
    // getAgentRelease() ever issues.
    environmentReleasePointerResolverFunction.addToRolePolicy(
      new iam.PolicyStatement({
        effect: iam.Effect.ALLOW,
        actions: ["dynamodb:GetItem"],
        resources: [props.agentReleasesTable.tableArn],
      }),
    );

    // Additive: resolveCandidateVsStableDiff's best-effort releaseDiff
    // call reads EvalRunsTable (to resolve each side's score vector) —
    // GetItem-only, same narrow-statement convention as the
    // AgentReleasesTable grant directly above.
    environmentReleasePointerResolverFunction.addToRolePolicy(
      new iam.PolicyStatement({
        effect: iam.Effect.ALLOW,
        actions: ["dynamodb:GetItem"],
        resources: [props.evalRunsTable.tableArn],
      }),
    );

    // ========================================================================

    // --- Shared per-stack async DLQ (CIT-125 slice A) ----------------------
    // Function-level Lambda DeadLetterConfig, matching governance-notifier's
    // established shape (governanceNotifierDlq above) — catches
    // handler-throw drops that Lambda's internal async retry exhausts,
    // which an EventBridge target-level DLQ cannot see. Every consumer
    // Lambda defined in THIS stack (excluding governance-notifier and
    // evalConversationWorker's SQS-ESM, which already have dedicated DLQs)
    // sets `deadLetterQueue: governanceAsyncDlq`.
    const governanceAsyncDlq = new sqs.Queue(this, "GovernanceAsyncDlq", {
      queueName: `citadel-governance-async-dlq-${props.environment}`,
      retentionPeriod: Duration.days(14),
      encryption: sqs.QueueEncryption.SQS_MANAGED,
      enforceSSL: true,
    });

    // Auto-rollback evaluator (decisions D1–D9) — scheduled 1-minute poll
    // (D2: poll ONLY in v1; no SNS/alarm subscription for TRIGGERING). Homed
    // here alongside the pointer resolver because it needs the pointer table
    // (+ its ActiveCanaryIndex GSI), the history table (written atomically on
    // the abort), the promotion-policy table (rollbackPolicy sub-object, D1),
    // the governance ledger (finding, D6), and the cost ledger (per-arm cost
    // + latency, D3). The cost/governance ledgers are referenced by
    // deterministic ARN string — same cycle-free indirection this stack uses
    // for GOVERNANCE_LEDGER_TABLE (their owning stacks instantiate after this
    // one).
    const governanceLedgerTableArn = `arn:aws:dynamodb:${this.region}:${this.account}:table/citadel-governance-ledger-${props.environment}`;
    const costLedgerTableName = `citadel-cost-ledger-${props.environment}`;
    const costLedgerTableArn = `arn:aws:dynamodb:${this.region}:${this.account}:table/${costLedgerTableName}`;

    // Dedicated least-privilege role (INV-1: the auto-actor has NO promote
    // path). DynamoDB IAM cannot express "only abort-shaped writes", so the
    // pointer PutItem grant below is the minimal DynamoDB action needed for
    // the conditional TransactWrite; the abort-ONLY bound is enforced in code
    // by the shared store helper performAutoAbortCanary, which mints
    // AUTO_ABORT_CANARY + the system principal server-side and never touches
    // the stable releaseId. No release-promotion resolver or mutation is
    // reachable from this role.
    const rollbackEvaluatorRole = new iam.Role(
      this,
      "AgentReleaseRollbackEvaluatorRole",
      { assumedBy: new iam.ServicePrincipal("lambda.amazonaws.com") },
    );
    rollbackEvaluatorRole.addManagedPolicy(
      iam.ManagedPolicy.fromAwsManagedPolicyName(
        "service-role/AWSLambdaBasicExecutionRole",
      ),
    );
    // Pointer table: Query (enumerate via ActiveCanaryIndex + base) + PutItem
    // (the conditional abort TransactWrite). No DeleteItem/UpdateItem.
    rollbackEvaluatorRole.addToPolicy(
      new iam.PolicyStatement({
        effect: iam.Effect.ALLOW,
        actions: ["dynamodb:Query", "dynamodb:PutItem"],
        resources: [
          props.environmentReleasePointersTable.tableArn,
          `${props.environmentReleasePointersTable.tableArn}/index/ActiveCanaryIndex`,
        ],
      }),
    );
    // History table: PutItem only (the atomic history row of the abort).
    rollbackEvaluatorRole.addToPolicy(
      new iam.PolicyStatement({
        effect: iam.Effect.ALLOW,
        actions: ["dynamodb:PutItem"],
        resources: [environmentReleasePointerHistoryTable.tableArn],
      }),
    );
    // Promotion-policy table: GetItem only (rollbackPolicy read, D1).
    rollbackEvaluatorRole.addToPolicy(
      new iam.PolicyStatement({
        effect: iam.Effect.ALLOW,
        actions: ["dynamodb:GetItem"],
        resources: [props.promotionPolicyConfigTable.tableArn],
      }),
    );
    // Cost ledger: Query only (per-arm cost/latency window read, D3). Never
    // Scan, never write.
    rollbackEvaluatorRole.addToPolicy(
      new iam.PolicyStatement({
        effect: iam.Effect.ALLOW,
        actions: ["dynamodb:Query"],
        resources: [costLedgerTableArn],
      }),
    );
    // Governance ledger: PutItem only (write-once finding, D6). Explicit
    // statement, not grantWriteData (no Update/Delete/BatchWrite widening).
    rollbackEvaluatorRole.addToPolicy(
      new iam.PolicyStatement({
        effect: iam.Effect.ALLOW,
        actions: ["dynamodb:PutItem"],
        resources: [governanceLedgerTableArn],
      }),
    );

    const agentReleaseRollbackEvaluatorFunction = new lambda.Function(
      this,
      "AgentReleaseRollbackEvaluatorFunction",
      {
        functionName: `citadel-agent-release-rollback-evaluator-${props.environment}`,
        runtime: lambda.Runtime.NODEJS_24_X,
        handler: "agent-release-rollback-evaluator.handler",
        code: lambda.Code.fromAsset("dist/lambda"),
        role: rollbackEvaluatorRole,
        timeout: cdk.Duration.minutes(1),
        environment: {
          ENVIRONMENT_RELEASE_POINTERS_TABLE:
            props.environmentReleasePointersTable.tableName,
          ENVIRONMENT_RELEASE_POINTER_HISTORY_TABLE:
            environmentReleasePointerHistoryTable.tableName,
          PROMOTION_POLICY_CONFIG_TABLE:
            props.promotionPolicyConfigTable.tableName,
          COST_LEDGER_TABLE: costLedgerTableName,
          GOVERNANCE_LEDGER_TABLE: `citadel-governance-ledger-${props.environment}`,
          EVENT_BUS_NAME: props.agentEventBus.eventBusName,
          ENVIRONMENT: props.environment,
        },
        logGroup: new logs.LogGroup(
          this,
          "AgentReleaseRollbackEvaluatorFunctionLogs",
          {
            retention: logs.RetentionDays.ONE_WEEK,
            removalPolicy: cdk.RemovalPolicy.DESTROY,
          },
        ),
        deadLetterQueueEnabled: true,
        deadLetterQueue: governanceAsyncDlq,
      },
    );
    // Best-effort governance.release.auto_rollback emit target (D6/§7).
    props.agentEventBus.grantPutEventsTo(agentReleaseRollbackEvaluatorFunction);

    // D2 — scheduled 1-minute poll (the ONLY trigger in v1; no SNS/alarm
    // subscription). Tight cycle satisfies "roll back within one evaluation
    // cycle".
    const rollbackEvaluatorScheduleRule = new events.Rule(
      this,
      "AgentReleaseRollbackEvaluatorScheduleRule",
      {
        description:
          "1-minute poll for the agent-release auto-rollback evaluator (canary breach → AUTO_ABORT_CANARY)",
        schedule: events.Schedule.rate(cdk.Duration.minutes(1)),
      },
    );
    rollbackEvaluatorScheduleRule.addTarget(
      new targets.LambdaFunction(agentReleaseRollbackEvaluatorFunction),
    );

    // D6 — alarmable metric: a post-commit finding-write failure emits the
    // EMF metric Citadel/Governance AutoRollbackFindingWriteFailure so a
    // committed-but-unrecorded rollback pages rather than passing silently.
    const autoRollbackFindingFailureAlarm = new cloudwatch.Alarm(
      this,
      "AutoRollbackFindingWriteFailureAlarm",
      {
        alarmName: `citadel-auto-rollback-finding-write-failure-${props.environment}`,
        alarmDescription:
          "An auto-rollback pointer move committed but its GovernanceFinding write failed — the move is audited via the history row, but the analyst-facing finding is missing. See docs/RELEASE_RUNBOOK.md (auto-rollback).",
        metric: new cloudwatch.Metric({
          namespace: "Citadel/Governance",
          metricName: "AutoRollbackFindingWriteFailure",
          dimensionsMap: { Environment: props.environment },
          statistic: "Sum",
          period: cdk.Duration.minutes(5),
        }),
        threshold: 1,
        evaluationPeriods: 1,
        comparisonOperator:
          cloudwatch.ComparisonOperator.GREATER_THAN_OR_EQUAL_TO_THRESHOLD,
        treatMissingData: cloudwatch.TreatMissingData.NOT_BREACHING,
      },
    );
    if (props.alarmTopic) {
      autoRollbackFindingFailureAlarm.addAlarmAction(
        new cw_actions.SnsAction(props.alarmTopic),
      );
    }

    const environmentReleasePointerDataSourceRole = new iam.Role(
      this,
      "EnvironmentReleasePointerDataSourceRole",
      {
        assumedBy: new iam.ServicePrincipal("appsync.amazonaws.com"),
      },
    );
    environmentReleasePointerResolverFunction.grantInvoke(
      environmentReleasePointerDataSourceRole,
    );

    const environmentReleasePointerLambdaDataSource =
      new appsyncCfn.CfnDataSource(
        this,
        "EnvironmentReleasePointerLambdaDataSource",
        {
          apiId: props.appSyncApi.apiId,
          name: "EnvironmentReleasePointerLambdaDataSource",
          type: "AWS_LAMBDA",
          serviceRoleArn: environmentReleasePointerDataSourceRole.roleArn,
          lambdaConfig: {
            lambdaFunctionArn:
              environmentReleasePointerResolverFunction.functionArn,
          },
        },
      );

    const promoteEnvironmentReleasePointerResolver = new appsyncCfn.CfnResolver(
      this,
      "PromoteEnvironmentReleasePointerResolver",
      {
        apiId: props.appSyncApi.apiId,
        typeName: "Mutation",
        fieldName: "promoteEnvironmentReleasePointer",
        dataSourceName: environmentReleasePointerLambdaDataSource.attrName,
        requestMappingTemplate: LAMBDA_REQUEST_MAPPING,
        responseMappingTemplate: LAMBDA_RESPONSE_MAPPING,
      },
    );
    promoteEnvironmentReleasePointerResolver.addResourceDependency(
      environmentReleasePointerLambdaDataSource,
    );

    // Canary agent releases (attribution-only, decision D2). All four
    // mutations are backed by the SAME environment-release-pointer
    // resolver function and data source as promoteEnvironmentReleasePointer
    // — they read/write the same pointer + history tables and resolve the
    // same promotion policy, so no new IAM surface is introduced.
    const environmentReleasePointerCanaryMutationFields = [
      { id: "StartCanaryResolver", fieldName: "startCanary" },
      { id: "ReweightCanaryResolver", fieldName: "reweightCanary" },
      { id: "PromoteCanaryResolver", fieldName: "promoteCanary" },
      { id: "AbortCanaryResolver", fieldName: "abortCanary" },
    ];
    for (const {
      id,
      fieldName,
    } of environmentReleasePointerCanaryMutationFields) {
      const resolver = new appsyncCfn.CfnResolver(this, id, {
        apiId: props.appSyncApi.apiId,
        typeName: "Mutation",
        fieldName,
        dataSourceName: environmentReleasePointerLambdaDataSource.attrName,
        requestMappingTemplate: LAMBDA_REQUEST_MAPPING,
        responseMappingTemplate: LAMBDA_RESPONSE_MAPPING,
      });
      resolver.addResourceDependency(environmentReleasePointerLambdaDataSource);
    }

    const environmentReleasePointerQueryFields = [
      {
        id: "GetCurrentEnvironmentReleasePointerResolver",
        fieldName: "getCurrentEnvironmentReleasePointer",
      },
      {
        id: "ListEnvironmentReleasePointersResolver",
        fieldName: "listEnvironmentReleasePointers",
      },
      {
        id: "EnvironmentReleasePointerHistoryResolver",
        fieldName: "environmentReleasePointerHistory",
      },
    ];
    for (const { id, fieldName } of environmentReleasePointerQueryFields) {
      const resolver = new appsyncCfn.CfnResolver(this, id, {
        apiId: props.appSyncApi.apiId,
        typeName: "Query",
        fieldName,
        dataSourceName: environmentReleasePointerLambdaDataSource.attrName,
        requestMappingTemplate: LAMBDA_REQUEST_MAPPING,
        responseMappingTemplate: LAMBDA_RESPONSE_MAPPING,
      });
      resolver.addResourceDependency(environmentReleasePointerLambdaDataSource);
    }

    // ============================================================
    // PromotionPolicy Resolver (decision ada70113 — per-org config)
    // ============================================================
    //
    // Own function, own AppSync data source, own execution role
    // (promotionPolicyConfigWriterRole — GetItem+PutItem on
    // PromotionPolicyConfigTable ONLY, see backend-stack.ts's
    // construction site), mirroring the EnvironmentReleasePointer
    // resolver's own-role convention above. This role is entirely
    // separate from environmentReleasePointerWriterRole: the admin write
    // path (this resolver) and the promotion-gate read path
    // (environment-release-pointer-resolver.ts, which carries its OWN
    // scoped GetItem-only statement for this same table, added directly
    // on its existing role in backend-stack.ts) must never share a role,
    // so a compromised/buggy admin-resolver deploy can never inherit the
    // pointer-mutation capability, and vice versa.
    const promotionPolicyResolverFunction = new lambda.Function(
      this,
      "PromotionPolicyResolverFunction",
      {
        runtime: lambda.Runtime.NODEJS_24_X,
        handler: "promotion-policy-resolver.handler",
        code: lambda.Code.fromAsset("dist/lambda"),
        role: props.promotionPolicyConfigWriterRole,
        environment: {
          PROMOTION_POLICY_CONFIG_TABLE:
            props.promotionPolicyConfigTable.tableName,
        },
        timeout: cdk.Duration.seconds(30),
        logGroup: new logs.LogGroup(
          this,
          "PromotionPolicyResolverFunctionLogs",
          {
            retention: logs.RetentionDays.ONE_WEEK,
            removalPolicy: cdk.RemovalPolicy.DESTROY,
          },
        ),
      },
    );

    const promotionPolicyDataSourceRole = new iam.Role(
      this,
      "PromotionPolicyDataSourceRole",
      {
        assumedBy: new iam.ServicePrincipal("appsync.amazonaws.com"),
      },
    );
    promotionPolicyResolverFunction.grantInvoke(promotionPolicyDataSourceRole);

    const promotionPolicyLambdaDataSource = new appsyncCfn.CfnDataSource(
      this,
      "PromotionPolicyLambdaDataSource",
      {
        apiId: props.appSyncApi.apiId,
        name: "PromotionPolicyLambdaDataSource",
        type: "AWS_LAMBDA",
        serviceRoleArn: promotionPolicyDataSourceRole.roleArn,
        lambdaConfig: {
          lambdaFunctionArn: promotionPolicyResolverFunction.functionArn,
        },
      },
    );

    const setPromotionPolicyResolver = new appsyncCfn.CfnResolver(
      this,
      "SetPromotionPolicyResolver",
      {
        apiId: props.appSyncApi.apiId,
        typeName: "Mutation",
        fieldName: "setPromotionPolicy",
        dataSourceName: promotionPolicyLambdaDataSource.attrName,
        requestMappingTemplate: LAMBDA_REQUEST_MAPPING,
        responseMappingTemplate: LAMBDA_RESPONSE_MAPPING,
      },
    );
    setPromotionPolicyResolver.addResourceDependency(
      promotionPolicyLambdaDataSource,
    );

    const getPromotionPolicyResolver = new appsyncCfn.CfnResolver(
      this,
      "GetPromotionPolicyResolver",
      {
        apiId: props.appSyncApi.apiId,
        typeName: "Query",
        fieldName: "getPromotionPolicy",
        dataSourceName: promotionPolicyLambdaDataSource.attrName,
        requestMappingTemplate: LAMBDA_REQUEST_MAPPING,
        responseMappingTemplate: LAMBDA_RESPONSE_MAPPING,
      },
    );
    getPromotionPolicyResolver.addResourceDependency(
      promotionPolicyLambdaDataSource,
    );

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
      deadLetterQueueEnabled: true,
      deadLetterQueue: governanceAsyncDlq,
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
