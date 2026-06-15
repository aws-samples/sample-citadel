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
import * as cdk from 'aws-cdk-lib';
import { CustomResource, Duration } from 'aws-cdk-lib';
import * as appsync from '@aws-cdk/aws-appsync-alpha';
// Cfn L1 AppSync constructs — used cross-stack to avoid creating data sources
// in the API owner's stack (see governance-stack.ts constructor for rationale).
import { aws_appsync as appsyncCfn } from 'aws-cdk-lib';
import * as dynamodb from 'aws-cdk-lib/aws-dynamodb';
import * as events from 'aws-cdk-lib/aws-events';
import * as targets from 'aws-cdk-lib/aws-events-targets';
import * as iam from 'aws-cdk-lib/aws-iam';
import * as lambda from 'aws-cdk-lib/aws-lambda';
import * as logs from 'aws-cdk-lib/aws-logs';
import { BlockPublicAccess, Bucket } from 'aws-cdk-lib/aws-s3';
import * as sqs from 'aws-cdk-lib/aws-sqs';
import * as ssm from 'aws-cdk-lib/aws-ssm';
import { Provider } from 'aws-cdk-lib/custom-resources';
import { Construct } from 'constructs';
import { NagSuppressions } from 'cdk-nag';

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

    const governanceEnforceParam = new ssm.StringParameter(this, 'GovernanceEnforceParam', {
      parameterName: `/citadel/governance/enforce/${props.environment}`,
      stringValue: 'permissive',
      allowedPattern: '^(permissive|shadow|strict)$',
      description:
        'AI-Accelerated Modernization Governance enforcement mode. ' +
        'permissive = telemetry only (default); shadow = block in logs, allow action; ' +
        'strict = hard block. Flip is data-driven per QD-1; effective_at companion ' +
        'parameter auto-written on first permissive → shadow transition.',
      tier: ssm.ParameterTier.STANDARD,
    });
    this.governanceEnforceParam = governanceEnforceParam;

    const governanceEffectiveAtParam = new ssm.StringParameter(this, 'GovernanceEffectiveAtParam', {
      parameterName: `/citadel/governance/effective_at/${props.environment}`,
      stringValue: '__EMPTY__',
      description:
        'ISO-8601 timestamp of first permissive → shadow flip. ' +
        'Projects with createdAt < effective_at bypass new governance gates (grandfathering). ' +
        '"__EMPTY__" means no cutoff set; all projects grandfathered.',
      tier: ssm.ParameterTier.STANDARD,
    });
    this.governanceEffectiveAtParam = governanceEffectiveAtParam;

    const effectiveAtAutoWriterFn = new lambda.Function(this, 'GovernanceEffectiveAtAutoWriterFn', {
      runtime: lambda.Runtime.NODEJS_24_X,
      handler: 'index.handler',
      timeout: Duration.seconds(30),
      code: lambda.Code.fromInline(`
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
      `.trim()),
      environment: {
        ENFORCE_PARAM_NAME: governanceEnforceParam.parameterName,
        EFFECTIVE_AT_PARAM_NAME: governanceEffectiveAtParam.parameterName,
      },
    });

    effectiveAtAutoWriterFn.addToRolePolicy(new iam.PolicyStatement({
      actions: ['ssm:GetParameter', 'ssm:PutParameter'],
      resources: [
        governanceEnforceParam.parameterArn,
        governanceEffectiveAtParam.parameterArn,
      ],
    }));

    const effectiveAtProvider = new Provider(this, 'GovernanceEffectiveAtProvider', {
      onEventHandler: effectiveAtAutoWriterFn,
    });

    new CustomResource(this, 'GovernanceEffectiveAtTrigger', {
      serviceToken: effectiveAtProvider.serviceToken,
      properties: {
        EnforceParamName: governanceEnforceParam.parameterName,
      },
    });

    NagSuppressions.addResourceSuppressions(
      effectiveAtAutoWriterFn,
      [
        {
          id: 'AwsSolutions-IAM4',
          reason:
            'AWS Lambda basic-execution managed policy is required for CloudWatch Logs; ' +
            'scoped role also carries least-privilege SSM permissions on the two governance parameters only.',
        },
        {
          id: 'AwsSolutions-L1',
          reason:
            'Inline Lambda uses the latest Node.js runtime available to the stack; upgrade is ' +
            'a mechanical follow-up when the project bumps its NodeJS runtime convention.',
        },
      ],
      true,
    );

    NagSuppressions.addResourceSuppressions(
      effectiveAtProvider,
      [
        { id: 'AwsSolutions-IAM4', reason: 'CDK Provider framework internal role — upstream managed.' },
        { id: 'AwsSolutions-IAM5', reason: 'CDK Provider framework internal role — upstream managed.' },
        { id: 'AwsSolutions-L1', reason: 'CDK Provider framework internal Lambda — upstream managed.' },
      ],
      true,
    );

    // ============================================================
    // Governance Transcripts Bucket
    // ============================================================

    // Dedicated KMS key for transcript bucket (SSE-KMS).
    const governanceTranscriptsKey = new cdk.aws_kms.Key(this, 'GovernanceTranscriptsKey', {
      description: 'Citadel Governance Transcripts bucket encryption key',
      enableKeyRotation: true,
      removalPolicy: cdk.RemovalPolicy.RETAIN,
      alias: `alias/citadel-governance-transcripts-${props.environment}`,
    });
    this.governanceTranscriptsKey = governanceTranscriptsKey;

    const governanceTranscriptsBucket = new Bucket(this, 'GovernanceTranscriptsBucket', {
      bucketName: `citadel-governance-transcripts-${props.environment}-${this.account}-${this.region}`,
      encryption: cdk.aws_s3.BucketEncryption.KMS,
      encryptionKey: governanceTranscriptsKey,
      bucketKeyEnabled: true,
      blockPublicAccess: BlockPublicAccess.BLOCK_ALL,
      enforceSSL: true,
      versioned: true,
      removalPolicy: cdk.RemovalPolicy.RETAIN,
      serverAccessLogsBucket: accessLogsBucket,
      serverAccessLogsPrefix: 'governance-transcripts/',
      lifecycleRules: [
        {
          id: 'governance-transcripts-lifecycle',
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
    });
    this.governanceTranscriptsBucket = governanceTranscriptsBucket;

    // Deny any PutObject that is not SSE-KMS encrypted.
    governanceTranscriptsBucket.addToResourcePolicy(new iam.PolicyStatement({
      effect: iam.Effect.DENY,
      principals: [new iam.AnyPrincipal()],
      actions: ['s3:PutObject'],
      resources: [governanceTranscriptsBucket.arnForObjects('*')],
      conditions: {
        StringNotEquals: {
          's3:x-amz-server-side-encryption': 'aws:kms',
        },
      },
    }));

    // Deny any PutObject that uses a different KMS key.
    governanceTranscriptsBucket.addToResourcePolicy(new iam.PolicyStatement({
      effect: iam.Effect.DENY,
      principals: [new iam.AnyPrincipal()],
      actions: ['s3:PutObject'],
      resources: [governanceTranscriptsBucket.arnForObjects('*')],
      conditions: {
        StringNotEqualsIfExists: {
          's3:x-amz-server-side-encryption-aws-kms-key-id': governanceTranscriptsKey.keyArn,
        },
      },
    }));

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
    const governanceNotifierDlq = new sqs.Queue(this, 'GovernanceNotifierDlq', {
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

    const governanceNotifierFn = new lambda.Function(this, 'GovernanceNotifierFn', {
      runtime: lambda.Runtime.NODEJS_24_X,
      handler: 'governance-notifier.handler',
      code: lambda.Code.fromAsset('dist/lambda'),
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
    });

    // Field-scoped IAM grant: only the publishGovernanceEvent mutation
    // is callable. The notifier MUST NOT be able to invoke any other
    // mutation on the API — least privilege per project security
    // standards.
    governanceNotifierFn.addToRolePolicy(
      new iam.PolicyStatement({
        effect: iam.Effect.ALLOW,
        actions: ['appsync:GraphQL'],
        resources: [
          `${props.appSyncApi.arn}/types/Mutation/fields/publishGovernanceEvent`,
        ],
      }),
    );

    new events.Rule(this, 'GovernanceEventsRule', {
      eventBus: props.agentEventBus,
      ruleName: `citadel-governance-events-${props.environment}`,
      description:
        'Routes all 14 governance.* detail-types (the canonical list in ' +
        'GOVERNANCE_DETAIL_TYPES) to the governance-notifier relay Lambda.',
      eventPattern: {
        source: ['citadel.backend'],
        // Keep this list in lock-step with GOVERNANCE_DETAIL_TYPES in
        // backend/src/utils/notifier-base.ts. The handler also drops
        // unknown detail-types as defence in depth, so the rule
        // expanding ahead of the handler is safe.
        detailType: [
          'governance.adr.locked',
          'governance.adr.reopen.attempted',
          'governance.specification.created',
          'governance.specification.approved',
          'governance.specification.rejected',
          'governance.round.started',
          'governance.round.completed',
          'governance.round.transcript.overflow',
          'governance.archetype.classified',
          'governance.offfrontier.escalated',
          'governance.grandfathered.bypass',
          'governance.mode.transition',
          'governance.constitutional.rule.changed',
          'governance.caselaw.changed',
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
          id: 'AwsSolutions-IAM4',
          reason:
            'AWS Lambda basic-execution managed policy is required for CloudWatch Logs. ' +
            'The relay also has a field-scoped appsync:GraphQL grant on the single ' +
            'publishGovernanceEvent mutation — no API-wide permissions.',
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
      'GovernanceEventNoneDataSource',
      {
        apiId: props.appSyncApi.apiId,
        name: 'GovernanceEventNoneDataSource',
        type: 'NONE',
        description:
          'Passthrough data source for the publishGovernanceEvent fanout mutation.',
      },
    );

    const publishGovernanceEventResolver = new appsyncCfn.CfnResolver(
      this,
      'PublishGovernanceEventResolver',
      {
        apiId: props.appSyncApi.apiId,
        typeName: 'Mutation',
        fieldName: 'publishGovernanceEvent',
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
    publishGovernanceEventResolver.addDependency(governanceEventNoneDataSource);

    // ============================================================
    // ADR Resolver
    // ============================================================
    //
    // The ADR and ADR Reopen Attempts tables are owned by BackendStack and
    // passed in via props; the resolver Lambda + data source + resolvers
    // live here so the stack can be redeployed without touching the data
    // plane.

    const adrResolverFunction = new lambda.Function(this, 'ADRResolverFunction', {
      runtime: lambda.Runtime.NODEJS_24_X,
      handler: 'adr-resolver.handler',
      code: lambda.Code.fromAsset('dist/lambda'),
      environment: {
        ADRS_TABLE: props.adrsTable.tableName,
        ADR_REOPEN_ATTEMPTS_TABLE: props.adrReopenAttemptsTable.tableName,
        EVENT_BUS_NAME: props.agentEventBus.eventBusName,
      },
      timeout: Duration.seconds(30),
      logGroup: new logs.LogGroup(this, 'ADRResolverFunctionLogs', {
        retention: logs.RetentionDays.ONE_WEEK,
        removalPolicy: cdk.RemovalPolicy.DESTROY,
      }),
    });

    props.adrsTable.grantReadWriteData(adrResolverFunction);
    props.adrReopenAttemptsTable.grantReadWriteData(adrResolverFunction);
    props.agentEventBus.grantPutEventsTo(adrResolverFunction);

    const adrDataSourceRole = new iam.Role(this, 'ADRDataSourceRole', {
      assumedBy: new iam.ServicePrincipal('appsync.amazonaws.com'),
    });
    adrResolverFunction.grantInvoke(adrDataSourceRole);

    const adrLambdaDataSource = new appsyncCfn.CfnDataSource(this, 'ADRLambdaDataSource', {
      apiId: props.appSyncApi.apiId,
      name: 'ADRLambdaDataSource',
      type: 'AWS_LAMBDA',
      serviceRoleArn: adrDataSourceRole.roleArn,
      lambdaConfig: {
        lambdaFunctionArn: adrResolverFunction.functionArn,
      },
    });

    const createADRResolver = new appsyncCfn.CfnResolver(this, 'CreateADRResolver', {
      apiId: props.appSyncApi.apiId,
      typeName: 'Mutation',
      fieldName: 'createADR',
      dataSourceName: adrLambdaDataSource.attrName,
      requestMappingTemplate: LAMBDA_REQUEST_MAPPING,
      responseMappingTemplate: LAMBDA_RESPONSE_MAPPING,
    });
    createADRResolver.addDependency(adrLambdaDataSource);

    const supersedeADRResolver = new appsyncCfn.CfnResolver(this, 'SupersedeADRResolver', {
      apiId: props.appSyncApi.apiId,
      typeName: 'Mutation',
      fieldName: 'supersedeADR',
      dataSourceName: adrLambdaDataSource.attrName,
      requestMappingTemplate: LAMBDA_REQUEST_MAPPING,
      responseMappingTemplate: LAMBDA_RESPONSE_MAPPING,
    });
    supersedeADRResolver.addDependency(adrLambdaDataSource);

    const getADRResolver = new appsyncCfn.CfnResolver(this, 'GetADRResolver', {
      apiId: props.appSyncApi.apiId,
      typeName: 'Query',
      fieldName: 'getADR',
      dataSourceName: adrLambdaDataSource.attrName,
      requestMappingTemplate: LAMBDA_REQUEST_MAPPING,
      responseMappingTemplate: LAMBDA_RESPONSE_MAPPING,
    });
    getADRResolver.addDependency(adrLambdaDataSource);

    const listADRsForProjectResolver = new appsyncCfn.CfnResolver(this, 'ListADRsForProjectResolver', {
      apiId: props.appSyncApi.apiId,
      typeName: 'Query',
      fieldName: 'listADRsForProject',
      dataSourceName: adrLambdaDataSource.attrName,
      requestMappingTemplate: LAMBDA_REQUEST_MAPPING,
      responseMappingTemplate: LAMBDA_RESPONSE_MAPPING,
    });
    listADRsForProjectResolver.addDependency(adrLambdaDataSource);

    const reopenADRResolver = new appsyncCfn.CfnResolver(this, 'ReopenADRResolver', {
      apiId: props.appSyncApi.apiId,
      typeName: 'Mutation',
      fieldName: 'reopenADR',
      dataSourceName: adrLambdaDataSource.attrName,
      requestMappingTemplate: LAMBDA_REQUEST_MAPPING,
      responseMappingTemplate: LAMBDA_RESPONSE_MAPPING,
    });
    reopenADRResolver.addDependency(adrLambdaDataSource);

    // ============================================================
    // ExecutionSpecification Resolver
    // ============================================================

    const execSpecResolverFunction = new lambda.Function(this, 'ExecSpecResolverFunction', {
      runtime: lambda.Runtime.NODEJS_24_X,
      handler: 'execspec-resolver.handler',
      code: lambda.Code.fromAsset('dist/lambda'),
      environment: {
        EXECUTION_SPECS_TABLE: props.executionSpecificationsTable.tableName,
        EVENT_BUS_NAME: props.agentEventBus.eventBusName,
      },
      timeout: cdk.Duration.seconds(30),
      logGroup: new logs.LogGroup(this, 'ExecSpecResolverFunctionLogs', {
        retention: logs.RetentionDays.ONE_WEEK,
        removalPolicy: cdk.RemovalPolicy.DESTROY,
      }),
    });

    props.executionSpecificationsTable.grantReadWriteData(execSpecResolverFunction);
    props.agentEventBus.grantPutEventsTo(execSpecResolverFunction);

    const execSpecDataSourceRole = new iam.Role(this, 'ExecSpecDataSourceRole', {
      assumedBy: new iam.ServicePrincipal('appsync.amazonaws.com'),
    });
    execSpecResolverFunction.grantInvoke(execSpecDataSourceRole);

    const execSpecLambdaDataSource = new appsyncCfn.CfnDataSource(this, 'ExecSpecLambdaDataSource', {
      apiId: props.appSyncApi.apiId,
      name: 'ExecSpecLambdaDataSource',
      type: 'AWS_LAMBDA',
      serviceRoleArn: execSpecDataSourceRole.roleArn,
      lambdaConfig: {
        lambdaFunctionArn: execSpecResolverFunction.functionArn,
      },
    });

    const createExecSpecResolver = new appsyncCfn.CfnResolver(this, 'CreateExecutionSpecResolver', {
      apiId: props.appSyncApi.apiId,
      typeName: 'Mutation',
      fieldName: 'createExecutionSpecification',
      dataSourceName: execSpecLambdaDataSource.attrName,
      requestMappingTemplate: LAMBDA_REQUEST_MAPPING,
      responseMappingTemplate: LAMBDA_RESPONSE_MAPPING,
    });
    createExecSpecResolver.addDependency(execSpecLambdaDataSource);

    const submitExecSpecResolver = new appsyncCfn.CfnResolver(this, 'SubmitExecutionSpecResolver', {
      apiId: props.appSyncApi.apiId,
      typeName: 'Mutation',
      fieldName: 'submitExecutionSpecification',
      dataSourceName: execSpecLambdaDataSource.attrName,
      requestMappingTemplate: LAMBDA_REQUEST_MAPPING,
      responseMappingTemplate: LAMBDA_RESPONSE_MAPPING,
    });
    submitExecSpecResolver.addDependency(execSpecLambdaDataSource);

    const approveExecSpecResolver = new appsyncCfn.CfnResolver(this, 'ApproveExecutionSpecResolver', {
      apiId: props.appSyncApi.apiId,
      typeName: 'Mutation',
      fieldName: 'approveExecutionSpecification',
      dataSourceName: execSpecLambdaDataSource.attrName,
      requestMappingTemplate: LAMBDA_REQUEST_MAPPING,
      responseMappingTemplate: LAMBDA_RESPONSE_MAPPING,
    });
    approveExecSpecResolver.addDependency(execSpecLambdaDataSource);

    const rejectExecSpecResolver = new appsyncCfn.CfnResolver(this, 'RejectExecutionSpecResolver', {
      apiId: props.appSyncApi.apiId,
      typeName: 'Mutation',
      fieldName: 'rejectExecutionSpecification',
      dataSourceName: execSpecLambdaDataSource.attrName,
      requestMappingTemplate: LAMBDA_REQUEST_MAPPING,
      responseMappingTemplate: LAMBDA_RESPONSE_MAPPING,
    });
    rejectExecSpecResolver.addDependency(execSpecLambdaDataSource);

    const reviseExecSpecResolver = new appsyncCfn.CfnResolver(this, 'ReviseExecutionSpecResolver', {
      apiId: props.appSyncApi.apiId,
      typeName: 'Mutation',
      fieldName: 'reviseExecutionSpecification',
      dataSourceName: execSpecLambdaDataSource.attrName,
      requestMappingTemplate: LAMBDA_REQUEST_MAPPING,
      responseMappingTemplate: LAMBDA_RESPONSE_MAPPING,
    });
    reviseExecSpecResolver.addDependency(execSpecLambdaDataSource);

    const getExecSpecResolver = new appsyncCfn.CfnResolver(this, 'GetExecutionSpecResolver', {
      apiId: props.appSyncApi.apiId,
      typeName: 'Query',
      fieldName: 'getExecutionSpecification',
      dataSourceName: execSpecLambdaDataSource.attrName,
      requestMappingTemplate: LAMBDA_REQUEST_MAPPING,
      responseMappingTemplate: LAMBDA_RESPONSE_MAPPING,
    });
    getExecSpecResolver.addDependency(execSpecLambdaDataSource);

    const listExecSpecsResolver = new appsyncCfn.CfnResolver(this, 'ListExecutionSpecsResolver', {
      apiId: props.appSyncApi.apiId,
      typeName: 'Query',
      fieldName: 'listExecutionSpecifications',
      dataSourceName: execSpecLambdaDataSource.attrName,
      requestMappingTemplate: LAMBDA_REQUEST_MAPPING,
      responseMappingTemplate: LAMBDA_RESPONSE_MAPPING,
    });
    listExecSpecsResolver.addDependency(execSpecLambdaDataSource);

    // ============================================================
    // InterrogationRound Resolver
    // ============================================================

    const interrogationRoundResolverFunction = new lambda.Function(this, 'InterrogationRoundResolverFunction', {
      runtime: lambda.Runtime.NODEJS_24_X,
      handler: 'interrogation-round-resolver.handler',
      code: lambda.Code.fromAsset('dist/lambda'),
      environment: {
        INTERROGATION_ROUNDS_TABLE: props.interrogationRoundsTable.tableName,
        GOVERNANCE_TRANSCRIPTS_BUCKET: governanceTranscriptsBucket.bucketName,
        EVENT_BUS_NAME: props.agentEventBus.eventBusName,
      },
      timeout: cdk.Duration.seconds(30),
      logGroup: new logs.LogGroup(this, 'InterrogationRoundResolverFunctionLogs', {
        retention: logs.RetentionDays.ONE_WEEK,
        removalPolicy: cdk.RemovalPolicy.DESTROY,
      }),
    });

    props.interrogationRoundsTable.grantReadWriteData(interrogationRoundResolverFunction);
    governanceTranscriptsBucket.grantWrite(interrogationRoundResolverFunction);
    governanceTranscriptsKey.grantEncryptDecrypt(interrogationRoundResolverFunction);
    props.agentEventBus.grantPutEventsTo(interrogationRoundResolverFunction);

    const interrogationRoundDataSourceRole = new iam.Role(this, 'InterrogationRoundDataSourceRole', {
      assumedBy: new iam.ServicePrincipal('appsync.amazonaws.com'),
    });
    interrogationRoundResolverFunction.grantInvoke(interrogationRoundDataSourceRole);

    const interrogationRoundLambdaDataSource = new appsyncCfn.CfnDataSource(this, 'InterrogationRoundLambdaDataSource', {
      apiId: props.appSyncApi.apiId,
      name: 'InterrogationRoundLambdaDataSource',
      type: 'AWS_LAMBDA',
      serviceRoleArn: interrogationRoundDataSourceRole.roleArn,
      lambdaConfig: {
        lambdaFunctionArn: interrogationRoundResolverFunction.functionArn,
      },
    });

    const startInterrogationRoundResolver = new appsyncCfn.CfnResolver(this, 'StartInterrogationRoundResolver', {
      apiId: props.appSyncApi.apiId,
      typeName: 'Mutation',
      fieldName: 'startInterrogationRound',
      dataSourceName: interrogationRoundLambdaDataSource.attrName,
      requestMappingTemplate: LAMBDA_REQUEST_MAPPING,
      responseMappingTemplate: LAMBDA_RESPONSE_MAPPING,
    });
    startInterrogationRoundResolver.addDependency(interrogationRoundLambdaDataSource);

    const injectConstraintsResolver = new appsyncCfn.CfnResolver(this, 'InjectConstraintsResolver', {
      apiId: props.appSyncApi.apiId,
      typeName: 'Mutation',
      fieldName: 'injectConstraints',
      dataSourceName: interrogationRoundLambdaDataSource.attrName,
      requestMappingTemplate: LAMBDA_REQUEST_MAPPING,
      responseMappingTemplate: LAMBDA_RESPONSE_MAPPING,
    });
    injectConstraintsResolver.addDependency(interrogationRoundLambdaDataSource);

    const stabiliseRoundResolver = new appsyncCfn.CfnResolver(this, 'StabiliseRoundResolver', {
      apiId: props.appSyncApi.apiId,
      typeName: 'Mutation',
      fieldName: 'stabiliseRound',
      dataSourceName: interrogationRoundLambdaDataSource.attrName,
      requestMappingTemplate: LAMBDA_REQUEST_MAPPING,
      responseMappingTemplate: LAMBDA_RESPONSE_MAPPING,
    });
    stabiliseRoundResolver.addDependency(interrogationRoundLambdaDataSource);

    const getInterrogationRoundResolver = new appsyncCfn.CfnResolver(this, 'GetInterrogationRoundResolver', {
      apiId: props.appSyncApi.apiId,
      typeName: 'Query',
      fieldName: 'getInterrogationRound',
      dataSourceName: interrogationRoundLambdaDataSource.attrName,
      requestMappingTemplate: LAMBDA_REQUEST_MAPPING,
      responseMappingTemplate: LAMBDA_RESPONSE_MAPPING,
    });
    getInterrogationRoundResolver.addDependency(interrogationRoundLambdaDataSource);

    const listInterrogationRoundsResolver = new appsyncCfn.CfnResolver(this, 'ListInterrogationRoundsResolver', {
      apiId: props.appSyncApi.apiId,
      typeName: 'Query',
      fieldName: 'listInterrogationRounds',
      dataSourceName: interrogationRoundLambdaDataSource.attrName,
      requestMappingTemplate: LAMBDA_REQUEST_MAPPING,
      responseMappingTemplate: LAMBDA_RESPONSE_MAPPING,
    });
    listInterrogationRoundsResolver.addDependency(interrogationRoundLambdaDataSource);

    // Suppress the KMS wildcards that grantEncryptDecrypt() on the
    // governanceTranscriptsKey adds to the function's DefaultPolicy. These
    // actions (kms:GenerateDataKey*, kms:ReEncrypt*) are required by the S3
    // SSE-KMS PutObject code path and are already scoped to the single KMS
    // key resource (governanceTranscriptsKey) by CDK's grant method.
    NagSuppressions.addResourceSuppressions(
      interrogationRoundResolverFunction,
      [
        {
          id: 'AwsSolutions-IAM5',
          reason:
            'kms:GenerateDataKey* and kms:ReEncrypt* are required by the S3 SSE-KMS ' +
            'PutObject code path when writing interrogation-round transcripts. The ' +
            'wildcards are action-level only; the resource scope is already narrowed ' +
            'to governanceTranscriptsKey by CDK grantEncryptDecrypt().',
          appliesTo: [
            'Action::kms:GenerateDataKey*',
            'Action::kms:ReEncrypt*',
          ],
        },
      ],
      true,
    );

    // ============================================================
    // AgentDesignAssessment Resolver
    // ============================================================
    // Contract: types/index.ts FourDimension + AgentDesignAssessment + interface

    const agentDesignAssessmentResolverFunction = new lambda.Function(this, 'AgentDesignAssessmentResolverFunction', {
      runtime: lambda.Runtime.NODEJS_24_X,
      handler: 'agent-design-assessment-resolver.handler',
      code: lambda.Code.fromAsset('dist/lambda'),
      environment: {
        AGENT_DESIGN_ASSESSMENTS_TABLE: props.agentDesignAssessmentsTable.tableName,
        PROJECTS_TABLE: props.projectsTable.tableName,
        EVENT_BUS_NAME: props.agentEventBus.eventBusName,
      },
      timeout: cdk.Duration.seconds(30),
      logGroup: new logs.LogGroup(this, 'AgentDesignAssessmentResolverFunctionLogs', {
        retention: logs.RetentionDays.ONE_WEEK,
        removalPolicy: cdk.RemovalPolicy.DESTROY,
      }),
    });

    props.agentDesignAssessmentsTable.grantReadWriteData(agentDesignAssessmentResolverFunction);
    props.projectsTable.grantReadWriteData(agentDesignAssessmentResolverFunction);
    props.agentEventBus.grantPutEventsTo(agentDesignAssessmentResolverFunction);

    const agentDesignAssessmentDataSourceRole = new iam.Role(this, 'AgentDesignAssessmentDataSourceRole', {
      assumedBy: new iam.ServicePrincipal('appsync.amazonaws.com'),
    });
    agentDesignAssessmentResolverFunction.grantInvoke(agentDesignAssessmentDataSourceRole);

    const agentDesignAssessmentLambdaDataSource = new appsyncCfn.CfnDataSource(this, 'AgentDesignAssessmentLambdaDataSource', {
      apiId: props.appSyncApi.apiId,
      name: 'AgentDesignAssessmentLambdaDataSource',
      type: 'AWS_LAMBDA',
      serviceRoleArn: agentDesignAssessmentDataSourceRole.roleArn,
      lambdaConfig: {
        lambdaFunctionArn: agentDesignAssessmentResolverFunction.functionArn,
      },
    });

    const startAgentDesignAssessmentResolver = new appsyncCfn.CfnResolver(this, 'StartAgentDesignAssessmentResolver', {
      apiId: props.appSyncApi.apiId,
      typeName: 'Mutation',
      fieldName: 'startAgentDesignAssessment',
      dataSourceName: agentDesignAssessmentLambdaDataSource.attrName,
      requestMappingTemplate: LAMBDA_REQUEST_MAPPING,
      responseMappingTemplate: LAMBDA_RESPONSE_MAPPING,
    });
    startAgentDesignAssessmentResolver.addDependency(agentDesignAssessmentLambdaDataSource);

    const submitAgentDesignAssessmentResolver = new appsyncCfn.CfnResolver(this, 'SubmitAgentDesignAssessmentResolver', {
      apiId: props.appSyncApi.apiId,
      typeName: 'Mutation',
      fieldName: 'submitAgentDesignAssessment',
      dataSourceName: agentDesignAssessmentLambdaDataSource.attrName,
      requestMappingTemplate: LAMBDA_REQUEST_MAPPING,
      responseMappingTemplate: LAMBDA_RESPONSE_MAPPING,
    });
    submitAgentDesignAssessmentResolver.addDependency(agentDesignAssessmentLambdaDataSource);

    const getAgentDesignAssessmentResolver = new appsyncCfn.CfnResolver(this, 'GetAgentDesignAssessmentResolver', {
      apiId: props.appSyncApi.apiId,
      typeName: 'Query',
      fieldName: 'getAgentDesignAssessment',
      dataSourceName: agentDesignAssessmentLambdaDataSource.attrName,
      requestMappingTemplate: LAMBDA_REQUEST_MAPPING,
      responseMappingTemplate: LAMBDA_RESPONSE_MAPPING,
    });
    getAgentDesignAssessmentResolver.addDependency(agentDesignAssessmentLambdaDataSource);

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

    const programReviewResolverFunction = new lambda.Function(this, 'ProgramReviewResolverFunction', {
      runtime: lambda.Runtime.NODEJS_24_X,
      handler: 'program-review-resolver.handler',
      code: lambda.Code.fromAsset('dist/lambda'),
      environment: {
        PROGRAM_REVIEWS_TABLE: props.programReviewsTable.tableName,
        ADRS_TABLE: props.adrsTable.tableName,
        EXECUTION_SPECS_TABLE: props.executionSpecificationsTable.tableName,
        INTERROGATION_ROUNDS_TABLE: props.interrogationRoundsTable.tableName,
        AGENT_DESIGN_ASSESSMENTS_TABLE: props.agentDesignAssessmentsTable.tableName,
        ENVIRONMENT: props.environment,
      },
      timeout: cdk.Duration.seconds(30),
      logGroup: new logs.LogGroup(this, 'ProgramReviewResolverFunctionLogs', {
        retention: logs.RetentionDays.ONE_WEEK,
        removalPolicy: cdk.RemovalPolicy.DESTROY,
      }),
    });

    props.programReviewsTable.grantReadWriteData(programReviewResolverFunction);
    props.adrsTable.grantReadData(programReviewResolverFunction);
    props.executionSpecificationsTable.grantReadData(programReviewResolverFunction);
    props.interrogationRoundsTable.grantReadData(programReviewResolverFunction);
    props.agentDesignAssessmentsTable.grantReadData(programReviewResolverFunction);

    const programReviewDataSourceRole = new iam.Role(this, 'ProgramReviewDataSourceRole', {
      assumedBy: new iam.ServicePrincipal('appsync.amazonaws.com'),
    });
    programReviewResolverFunction.grantInvoke(programReviewDataSourceRole);

    const programReviewLambdaDataSource = new appsyncCfn.CfnDataSource(this, 'ProgramReviewLambdaDataSource', {
      apiId: props.appSyncApi.apiId,
      name: 'ProgramReviewLambdaDataSource',
      type: 'AWS_LAMBDA',
      serviceRoleArn: programReviewDataSourceRole.roleArn,
      lambdaConfig: {
        lambdaFunctionArn: programReviewResolverFunction.functionArn,
      },
    });

    const runProgramReviewResolver = new appsyncCfn.CfnResolver(this, 'RunProgramReviewResolver', {
      apiId: props.appSyncApi.apiId,
      typeName: 'Mutation',
      fieldName: 'runProgramReview',
      dataSourceName: programReviewLambdaDataSource.attrName,
      requestMappingTemplate: LAMBDA_REQUEST_MAPPING,
      responseMappingTemplate: LAMBDA_RESPONSE_MAPPING,
    });
    runProgramReviewResolver.addDependency(programReviewLambdaDataSource);

    const getProgramReviewResolver = new appsyncCfn.CfnResolver(this, 'GetProgramReviewResolver', {
      apiId: props.appSyncApi.apiId,
      typeName: 'Query',
      fieldName: 'getProgramReview',
      dataSourceName: programReviewLambdaDataSource.attrName,
      requestMappingTemplate: LAMBDA_REQUEST_MAPPING,
      responseMappingTemplate: LAMBDA_RESPONSE_MAPPING,
    });
    getProgramReviewResolver.addDependency(programReviewLambdaDataSource);

    const listProgramReviewsForProjectResolver = new appsyncCfn.CfnResolver(this, 'ListProgramReviewsForProjectResolver', {
      apiId: props.appSyncApi.apiId,
      typeName: 'Query',
      fieldName: 'listProgramReviewsForProject',
      dataSourceName: programReviewLambdaDataSource.attrName,
      requestMappingTemplate: LAMBDA_REQUEST_MAPPING,
      responseMappingTemplate: LAMBDA_RESPONSE_MAPPING,
    });
    listProgramReviewsForProjectResolver.addDependency(programReviewLambdaDataSource);
  }
}
