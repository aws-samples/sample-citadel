import * as cdk from "aws-cdk-lib";
import * as dynamodb from "aws-cdk-lib/aws-dynamodb";
import * as lambda from "aws-cdk-lib/aws-lambda";
import * as events from "aws-cdk-lib/aws-events";
import * as targets from "aws-cdk-lib/aws-events-targets";
import * as cloudwatch from "aws-cdk-lib/aws-cloudwatch";
import * as cw_actions from "aws-cdk-lib/aws-cloudwatch-actions";
import * as sns from "aws-cdk-lib/aws-sns";
import * as kms from "aws-cdk-lib/aws-kms";
import * as iam from "aws-cdk-lib/aws-iam";
import * as logs from "aws-cdk-lib/aws-logs";
import * as ssm from "aws-cdk-lib/aws-ssm";
import * as appsync from '@aws-cdk/aws-appsync-alpha';
// Cfn L1 AppSync constructs — used cross-stack to attach a data source +
// resolvers to BackendStack's GraphQL API without creating those resources
// in BackendStack (which would force a stack dependency cycle, since the
// governance ledger table is owned here in ArbiterStack). Same pattern as
// governance-stack.ts.
import { aws_appsync as appsyncCfn } from 'aws-cdk-lib';
import { PythonFunction } from '@aws-cdk/aws-lambda-python-alpha';
import { PolicyStatement, Effect } from 'aws-cdk-lib/aws-iam';
import { Queue } from 'aws-cdk-lib/aws-sqs';
import { SqsEventSource } from 'aws-cdk-lib/aws-lambda-event-sources';
import { BlockPublicAccess, Bucket } from 'aws-cdk-lib/aws-s3';
import { Construct } from "constructs";
import { NagSuppressions } from 'cdk-nag';
import path = require('path');
import * as fs from 'fs';

// Resolve the repo-root `arbiter/` directory regardless of whether this
// module is loaded from source (`backend/lib/`) via ts-jest or from the
// compiled output (`backend/dist/lib/`) via `node dist/bin/app.js`.
// The correct `arbiter/` directory is the one containing the `catalog/`
// subfolder (the shared Python layer source) — the sibling `arbiter/`
// that sometimes appears one level above the repo only holds unused
// stub `index.py` files and must NOT be selected.
function resolveArbiterRoot(startDir: string): string {
  const candidates = [
    path.join(startDir, '..', '..', 'arbiter'),           // source: backend/lib/ -> repo/arbiter
    path.join(startDir, '..', '..', '..', 'arbiter'),     // dist:   backend/dist/lib/ -> repo/arbiter
  ];
  for (const candidate of candidates) {
    if (fs.existsSync(path.join(candidate, 'catalog'))) {
      return candidate;
    }
  }
  throw new Error(
    `Unable to locate repo-root arbiter/ directory from ${startDir}. ` +
    `Tried: ${candidates.join(', ')}`,
  );
}
const ARBITER_ROOT = resolveArbiterRoot(__dirname);

interface ArbiterStackProps extends cdk.StackProps {
  agentEventBus: events.EventBus;
  agentConfigTable: dynamodb.Table;
  codeBucket: Bucket;
  environment: string;
  workflowsTable?: dynamodb.Table;
  executionsTable?: dynamodb.Table;
  fanoutFunction?: lambda.Function;
  appSyncEndpoint?: string;
  appsTable?: dynamodb.Table;
  // QT3-6: shared read handle on the ExecutionSpecifications
  // table so both the fabricator (fabrication-time) and worker (dispatch-time)
  // Lambdas can resolve spec status without a cross-service HTTP call.
  executionSpecificationsTable: dynamodb.Table;
  // US-ARB-017: optional read handle on the AgentDesignAssessments table
  // so the fabricator's design-assessment precondition gate can verify a
  // completed assessment exists before fabricating. Optional because the
  // gate is forward-compatible -- when the table/prop is absent the
  // gate's env-var fallback simply no-ops.
  agentDesignAssessmentsTable?: dynamodb.Table;
  registryArn?: string;
  registryId?: string;
  // Governance UI Wave 1: optional AppSync API handle so the new
  // governance-ui-resolver can be wired as a data source + resolvers on
  // the BackendStack-owned API. Optional because some test paths
  // construct ArbiterStack without an API; production wiring lives in
  // backend/bin/app.ts.
  appSyncApi?: appsync.GraphqlApi;
  // Governance UI Wave 1: optional Cognito user pool ARN so the
  // governance-ui-resolver Lambda can scope its `cognito-idp:AdminGetUser`
  // permission to the actual pool. When omitted, the policy falls back to
  // the broader `userpool/*` ARN scope (with a TODO comment in the
  // attaching code).
  userPoolArn?: string;
}

export class ArbiterStack extends cdk.Stack {
  public readonly orchestrationTable: dynamodb.Table;

  // ============================================================
  // US-ARB-002: Governance authority/ledger tables (Δ8)
  // ============================================================
  // Exposed as public readonly so downstream stories (US-ARB-003
  // hierarchy loader, US-ARB-004 ledger writer) can grant read/write
  // access from other Lambdas without reaching into stack internals.
  public readonly authorityUnitsTable: dynamodb.Table;
  public readonly compositionContractsTable: dynamodb.Table;
  public readonly caseLawTable: dynamodb.Table;
  public readonly constitutionalLayersTable: dynamodb.Table;
  public readonly governanceLedgerTable: dynamodb.Table;
  // Wave 4.E.A — daily snapshot table for the authority graph history
  // scrubber. Default OFF (operators opt in via the settings card on the
  // Graph page). Marked public so both the snapshot Lambda and the
  // governance-ui-resolver can grant on it without reaching into stack
  // internals.
  public readonly governanceGraphSnapshotsTable: dynamodb.Table;
  // Wave 4.E.A.2 — on-change snapshot Lambda. Mirrors the scheduled
  // GovernanceGraphSnapshotFn but is triggered by DynamoDB streams on
  // the four authority source tables instead of an EventBridge cron.
  public readonly governanceGraphSnapshotOnChangeFn: lambda.Function;

  constructor(scope: Construct, id: string, props: ArbiterStackProps) {
    super(scope, id, props);

    this.orchestrationTable = new dynamodb.Table(this, 'OrchestrationTable', {
          tableName: `citadel-agent-orchestration-${props.environment}`,
          partitionKey: { name: 'orchestrationId', type: dynamodb.AttributeType.STRING },
          billingMode: dynamodb.BillingMode.PAY_PER_REQUEST,
          removalPolicy: cdk.RemovalPolicy.DESTROY,
          pointInTimeRecoverySpecification: { pointInTimeRecoveryEnabled: true },
        });

    const workerStateTable = new dynamodb.Table(this, 'WorkerStateTable', {
          tableName: `citadel-worker-state-${props.environment}`,
          partitionKey: { name: 'requestId', type: dynamodb.AttributeType.STRING },
          billingMode: dynamodb.BillingMode.PAY_PER_REQUEST,
          removalPolicy: cdk.RemovalPolicy.DESTROY,
          pointInTimeRecoverySpecification: { pointInTimeRecoveryEnabled: true },
        });

    // Shared layer for arbiter root packages so all arbiter PythonFunctions
    // can `from catalog.registry_client import ...` and `from common.region
    // import ...`. The layer structures catalog/ at /opt/python/catalog/ and
    // common/ at /opt/python/common/ per the Python Lambda layer convention.
    const catalogLayer = new lambda.LayerVersion(this, 'ArbiterCatalogLayer', {
      layerVersionName: `citadel-arbiter-catalog-${props.environment}`,
      code: lambda.Code.fromAsset(ARBITER_ROOT, {
        bundling: {
          image: lambda.Runtime.PYTHON_3_14.bundlingImage,
          command: [
            'bash', '-c',
            'mkdir -p /asset-output/python && cp -r /asset-input/catalog /asset-output/python/catalog && cp -r /asset-input/common /asset-output/python/common',
          ],
        },
      }),
      compatibleRuntimes: [lambda.Runtime.PYTHON_3_14],
      description:
        'Shared arbiter Python packages (catalog: registry_client and utilities; ' +
        'common: cross-region prefix helper).',
    });

    const supervisorLambda = new PythonFunction(this, 'SupervisorAgent', {
      runtime: lambda.Runtime.PYTHON_3_14,
      entry: path.join(ARBITER_ROOT, 'supervisor'),
      handler: 'handler',
      layers: [catalogLayer],
      bundling: { assetHashType: cdk.AssetHashType.SOURCE },
      timeout: cdk.Duration.seconds(30),
      memorySize: 1024,
      environment: {
        ORCHESTRATION_TABLE: this.orchestrationTable.tableName,
        COMPLETION_BUS_NAME: props.agentEventBus.eventBusName,
        EVENT_BUS_NAME: props.agentEventBus.eventBusName,
        WORKER_STATE_TABLE: workerStateTable.tableName,
        AGENT_CONFIG_TABLE: props.agentConfigTable.tableName,
        // Configurable model selection: the supervisor resolves its model
        // from these two tables via the shared pure resolver, falling back to
        // its previous default on any miss.
        MODEL_CONFIG_TABLE: `citadel-model-config-${props.environment}`,
        MODEL_CATALOG_TABLE: `citadel-model-catalog-${props.environment}`,
        CODE_VERSION: '2', // Force Lambda code update
        ...(props.appsTable && { APPS_TABLE: props.appsTable.tableName }),
        ...(props.registryId && { REGISTRY_ID: props.registryId }),
        ...(props.registryId && { REGISTRY_ENABLED: 'true' }),
      },
      initialPolicy: [
        new PolicyStatement({
          effect: Effect.ALLOW,
          actions: ['bedrock:InvokeModel', 'bedrock:InvokeModelWithResponseStream'],
          resources: [
            `arn:aws:bedrock:*::foundation-model/anthropic.claude-*`,
            `arn:aws:bedrock:*::foundation-model/amazon.*`,
            `arn:aws:bedrock:*:${this.account}:inference-profile/*`,
          ],
        }),
      ],
    });

    this.orchestrationTable.grantReadWriteData(supervisorLambda);
    props.agentEventBus.grantPutEventsTo(supervisorLambda);
    workerStateTable.grantReadWriteData(supervisorLambda);
    props.agentConfigTable.grantReadData(supervisorLambda);
    if (props.appsTable) {
      props.appsTable.grantReadData(supervisorLambda);
    }

    // Configurable model selection (read-only). The supervisor reads the
    // platform model-config + model-catalog tables to resolve its model via
    // the shared pure resolver, with a bulletproof fallback to its previous
    // default. Least privilege: grantReadData only — the supervisor never
    // writes these tables. Referenced by deterministic name via fromTableName
    // (owned elsewhere) to avoid a cross-stack construct dependency.
    const modelConfigTable = dynamodb.Table.fromTableName(this, 'SupervisorModelConfigTableRef', `citadel-model-config-${props.environment}`);
    const modelCatalogTable = dynamodb.Table.fromTableName(this, 'SupervisorModelCatalogTableRef', `citadel-model-catalog-${props.environment}`);
    modelConfigTable.grantReadData(supervisorLambda);
    modelCatalogTable.grantReadData(supervisorLambda);

    // Grant Supervisor read-only access to Registry APIs so it can
    // resolve agent/app identifiers during orchestration. Full CRUD
    // stays on the Fabricator per least-privilege.
    if (props.registryArn) {
      supervisorLambda.addToRolePolicy(
        new PolicyStatement({
          effect: Effect.ALLOW,
          actions: [
            'bedrock-agentcore:GetRegistryRecord',
            'bedrock-agentcore:ListRegistryRecords',
          ],
          resources: [props.registryArn, `${props.registryArn}/*`],
        }),
      );
    }

    // SQS permissions are granted below after queue creation (see workerAgentQueue / fabricatorQueue grants)

    const taskRequestRule = new events.Rule(this, 'TaskRequestRule', {
      eventBus: props.agentEventBus,
      eventPattern: {
        source: ['task.request'],
      },
    });

    const completionRule = new events.Rule(this, 'TaskCompletionRule', {
      eventBus: props.agentEventBus,
      eventPattern: {
        source: ['task.completion'],
      },
    });

    taskRequestRule.addTarget(new targets.LambdaFunction(supervisorLambda));
    completionRule.addTarget(new targets.LambdaFunction(supervisorLambda));

    // Dead letter queue for failed worker messages
    const workerAgentDLQ = new Queue(this, `workerAgentDLQ`, {
          queueName: `citadel-worker-agent-dlq-${props.environment}`,
          retentionPeriod: cdk.Duration.days(14),
          enforceSSL: true,
        });

    const workerAgentQueue = new Queue(this, `workerAgentQueue`, {
          queueName: `citadel-worker-agent-queue-${props.environment}`,
          visibilityTimeout: cdk.Duration.minutes(15),
          retentionPeriod: cdk.Duration.days(7),
          enforceSSL: true,
          deadLetterQueue: {
            queue: workerAgentDLQ,
            maxReceiveCount: 3, // Retry 3 times before sending to DLQ
          },
        });

    // Agent Credential Vender — lightweight TypeScript Lambda that
    // creates scoped IAM roles and returns temporary credentials
    const credentialVenderLambda = new lambda.Function(this, 'AgentCredentialVender', {
      runtime: lambda.Runtime.NODEJS_24_X,
      handler: 'agent-credential-vender.handler',
      code: lambda.Code.fromAsset('dist/lambda'),
      timeout: cdk.Duration.seconds(30),
      memorySize: 256,
      environment: {
        ENVIRONMENT: props.environment,
      },
      initialPolicy: [
        new PolicyStatement({
          effect: Effect.ALLOW,
          actions: [
            'iam:CreateRole',
            'iam:DeleteRole',
            'iam:GetRole',
            'iam:PutRolePolicy',
            'iam:DeleteRolePolicy',
            'iam:TagRole',
          ],
          resources: [
            `arn:aws:iam::${this.account}:role/citadel-agent-*`,
          ],
        }),
        new PolicyStatement({
                  effect: Effect.ALLOW,
                  actions: ['sts:AssumeRole'],
                  resources: [`arn:aws:iam::${this.account}:role/citadel-agent-*`],
                }),
                new PolicyStatement({
                  effect: Effect.ALLOW,
                  actions: ['sts:GetCallerIdentity'],
                  resources: ['*'],
                }),
      ],
    });

    const workerAgentWrapperLambda = new PythonFunction(this, 'WorkerAgentWrapper', {
      runtime: lambda.Runtime.PYTHON_3_14,
      entry: path.join(ARBITER_ROOT, 'workerWrapper'),
      handler: 'lambda_handler',
      layers: [catalogLayer],
      bundling: { assetHashType: cdk.AssetHashType.SOURCE },
      timeout: cdk.Duration.minutes(15),
      memorySize: 1024,
      environment: {
        COMPLETION_BUS_NAME: props.agentEventBus.eventBusName,
        AGENT_CONFIG_TABLE: props.agentConfigTable.tableName,
        AGENT_BUCKET_NAME: props.codeBucket.bucketName,
        CREDENTIAL_VENDER_FUNCTION: credentialVenderLambda.functionName,
        // QT3-6: dispatch-time spec status validation.
        EXECUTION_SPECS_TABLE: props.executionSpecificationsTable.tableName,
        ...(props.registryId && { REGISTRY_ID: props.registryId }),
        ...(props.registryId && { REGISTRY_ENABLED: 'true' }),
      },
      initialPolicy: [
        new PolicyStatement({
          effect: Effect.ALLOW,
          actions: ['bedrock:InvokeModel', 'bedrock:InvokeModelWithResponseStream'],
          resources: ['*'],
        }),
      ],
    });

    props.agentEventBus.grantPutEventsTo(workerAgentWrapperLambda);
    props.agentConfigTable.grantReadData(workerAgentWrapperLambda);
    props.codeBucket.grantRead(workerAgentWrapperLambda);
    credentialVenderLambda.grantInvoke(workerAgentWrapperLambda);
    // read-only access to ExecutionSpecifications for dispatch-time
    // status checks. Never written to from the worker.
    props.executionSpecificationsTable.grantReadData(workerAgentWrapperLambda);

    // Grant IAM permissions for PolicyManager (agent scope)
    workerAgentWrapperLambda.addToRolePolicy(
      new PolicyStatement({
        effect: Effect.ALLOW,
        actions: [
          'iam:CreateRole',
          'iam:DeleteRole',
          'iam:GetRole',
          'iam:PutRolePolicy',
          'iam:DeleteRolePolicy',
          'iam:TagRole',
        ],
        resources: [
          `arn:aws:iam::${this.account}:role/citadel-agent-*`,
        ],
      })
    );

    // Grant STS permissions for PolicyManager (agent scope)
    workerAgentWrapperLambda.addToRolePolicy(
          new PolicyStatement({
            effect: Effect.ALLOW,
            actions: ['sts:AssumeRole'],
            resources: [`arn:aws:iam::${this.account}:role/citadel-agent-*`],
          })
        );
        workerAgentWrapperLambda.addToRolePolicy(
          new PolicyStatement({
            effect: Effect.ALLOW,
            actions: ['sts:GetCallerIdentity'],
            resources: ['*'],
          })
        );

    // Grant WorkerAgentWrapper read-only access to Registry APIs so it
    // can resolve agent/app identifiers at dispatch time. Full CRUD
    // stays on the Fabricator per least-privilege.
    if (props.registryArn) {
      workerAgentWrapperLambda.addToRolePolicy(
        new PolicyStatement({
          effect: Effect.ALLOW,
          actions: [
            'bedrock-agentcore:GetRegistryRecord',
            'bedrock-agentcore:ListRegistryRecords',
          ],
          resources: [props.registryArn, `${props.registryArn}/*`],
        }),
      );
    }

    workerAgentWrapperLambda.addEventSource(new SqsEventSource(workerAgentQueue, {
      batchSize: 1, // Process one message at a time
      reportBatchItemFailures: true, // Enable partial batch responses
    }));

    const toolsConfigTable = new dynamodb.Table(this, 'ToolsConfigTable', {
          tableName: `citadel-tools-${props.environment}`,
          partitionKey: { name: 'toolId', type: dynamodb.AttributeType.STRING },
          billingMode: dynamodb.BillingMode.PAY_PER_REQUEST,
          removalPolicy: cdk.RemovalPolicy.DESTROY,
          pointInTimeRecoverySpecification: { pointInTimeRecoveryEnabled: true },
        });

    const fabricatorDLQ = new Queue(this, `fabricatorDLQ`, {
          queueName: `citadel-fabricator-dlq-${props.environment}`,
          retentionPeriod: cdk.Duration.days(14),
          enforceSSL: true,
        });

        const fabricatorQueue = new Queue(this, `fabricatorQueue`, {
          queueName: `citadel-fabricator-queue-${props.environment}`,
          // Reliability hardening: visibilityTimeout MUST strictly exceed the
          // FabricatorAgent Lambda timeout (15 min, below). When they are
          // equal, an invocation that runs near the function timeout causes
          // SQS to redeliver the same message — stacking duplicate
          // fabrications and prematurely draining the DLQ. AWS guidance for
          // SQS->Lambda is visibilityTimeout >= 6x the function timeout to
          // absorb retries/throttling, i.e. 6 x 15 min = 90 min. With
          // batchSize=1 (see SqsEventSource below) each invocation handles a
          // single fabrication (~11 min observed worst case), so the message
          // is well within one visibility window. Tradeoff: a genuinely
          // poison message takes up to maxReceiveCount(3) x 90 min before it
          // lands in the DLQ — acceptable because real fabrication failures
          // surface via the agent.fabrication.failed event and the
          // FabricatorErrorAlarm, not via DLQ latency. Never set this equal
          // to (or below) the function timeout.
          visibilityTimeout: cdk.Duration.minutes(90),
          retentionPeriod: cdk.Duration.days(7),
          enforceSSL: true,
          deadLetterQueue: {
            queue: fabricatorDLQ,
            maxReceiveCount: 3,
          },
        });

    const fabricatorLambda = new PythonFunction(this, 'FabricatorAgent', {
      runtime: lambda.Runtime.PYTHON_3_14,
      entry: path.join(ARBITER_ROOT, 'fabricator'),
      handler: 'lambda_handler',
      layers: [catalogLayer],
      bundling: { assetHashType: cdk.AssetHashType.SOURCE },
      timeout: cdk.Duration.minutes(15),
      memorySize: 1024,
      environment: {
        COMPLETION_BUS_NAME: props.agentEventBus.eventBusName,
        WORKFLOW_STATE_TABLE: workerStateTable.tableName,
        AGENT_CONFIG_TABLE: props.agentConfigTable.tableName,
        // Configurable model selection: the fabricator resolves its model
        // from these two tables via the shared pure resolver, falling back to
        // its previous default on any miss.
        MODEL_CONFIG_TABLE: `citadel-model-config-${props.environment}`,
        MODEL_CATALOG_TABLE: `citadel-model-catalog-${props.environment}`,
        TOOL_CONFIG_TABLE: toolsConfigTable.tableName,
        AGENT_BUCKET_NAME: props.codeBucket.bucketName,
        WORKER_QUEUE_URL: workerAgentQueue.queueUrl,
        // Durable per-agent fabrication status table (owned by BackendStack).
        // The consumer writes PROCESSING/COMPLETED/FAILED transitions. Empty
        // string keeps the write a no-op when the table isn't provisioned.
        FABRICATION_JOBS_TABLE: `citadel-fabrication-jobs-${props.environment}`,
        CODE_VERSION: '2', // Force Lambda code update
        // QT3-6: fabrication-time spec status validation.
        EXECUTION_SPECS_TABLE: props.executionSpecificationsTable.tableName,
        // fabrication-time design-assessment precondition.
        // Empty-string fallback keeps the gate's no-op path active when
        // the table is not provisioned in a given environment.
        AGENT_DESIGN_ASSESSMENTS_TABLE: props.agentDesignAssessmentsTable?.tableName?? '',
        // Phase 3 Step 2: enables the synchronous AppsTable #META mirror
        // write inside store_agent_config_registry. listApps reads from
        // AppsTable.OrgIndex, so without this env var fabricated agents
        // would only become visible after the reconciler runs.
        ...(props.appsTable && { APPS_TABLE: props.appsTable.tableName }),
        ...(props.registryId && { REGISTRY_ID: props.registryId }),
        ...(props.registryId && { REGISTRY_ENABLED: 'true' }),
      },
      initialPolicy: [
        new PolicyStatement({
          effect: Effect.ALLOW,
          actions: ['bedrock:InvokeModel', 'bedrock:InvokeModelWithResponseStream'],
          resources: [
            `arn:aws:bedrock:*::foundation-model/anthropic.claude-*`,
            `arn:aws:bedrock:*::foundation-model/amazon.*`,
            `arn:aws:bedrock:*:${this.account}:inference-profile/*`,
          ],
        }),
      ],
    });

    props.agentEventBus.grantPutEventsTo(fabricatorLambda);
    workerStateTable.grantReadWriteData(fabricatorLambda);
    props.agentConfigTable.grantReadWriteData(fabricatorLambda);
    toolsConfigTable.grantReadWriteData(fabricatorLambda);
    props.codeBucket.grantReadWrite(fabricatorLambda);
    // read-only access to ExecutionSpecifications so
    // assert_spec_approved can verify the bound spec_id is APPROVED.
    props.executionSpecificationsTable.grantReadData(fabricatorLambda);

    // Configurable model selection (read-only). Mirrors the supervisor: the
    // fabricator reads the platform model-config + model-catalog tables to
    // resolve its model via the shared pure resolver, with a bulletproof
    // fallback to its previous default. Least privilege: grantReadData only —
    // the fabricator never writes these tables. Referenced by deterministic
    // name via fromTableName (owned elsewhere) to avoid a cross-stack
    // construct dependency. Construct ids are Fabricator-prefixed so they
    // don't collide with the supervisor's SupervisorModel*TableRef refs.
    const fabricatorModelConfigTable = dynamodb.Table.fromTableName(this, 'FabricatorModelConfigTableRef', `citadel-model-config-${props.environment}`);
    const fabricatorModelCatalogTable = dynamodb.Table.fromTableName(this, 'FabricatorModelCatalogTableRef', `citadel-model-catalog-${props.environment}`);
    fabricatorModelConfigTable.grantReadData(fabricatorLambda);
    fabricatorModelCatalogTable.grantReadData(fabricatorLambda);

    // PutItem/UpdateItem on the durable fabrication-jobs table (owned by
    // BackendStack) so the consumer can upsert PROCESSING/COMPLETED/FAILED
    // status. Referenced by deterministic name + constructed ARN — importing
    // the BackendStack table construct here would create a circular dependency
    // (ArbiterStack already depends ON ServicesStack which depends ON
    // BackendStack). Least privilege: PutItem + UpdateItem only.
    fabricatorLambda.addToRolePolicy(new PolicyStatement({
      effect: Effect.ALLOW,
      actions: ['dynamodb:PutItem', 'dynamodb:UpdateItem'],
      resources: [`arn:aws:dynamodb:${this.region}:${this.account}:table/citadel-fabrication-jobs-${props.environment}`],
    }));

    // Phase 3 Step 2: write-only grant on AppsTable so the fabricator can
    // synchronously mirror new Registry agent records into the #META row
    // consumed by listApps via OrgIndex. Eventually-consistent — failures
    // are swallowed in the Python helper; the reconciler is the safety net.
    if (props.appsTable) {
      props.appsTable.grantWriteData(fabricatorLambda);
    }

    // read-only access to AgentDesignAssessments so the
    // design-assessment precondition gate can verify a completed
    // assessment exists for the referenced projectId. Conditional
    // because the prop is optional (forward-compatible wiring).
    if (props.agentDesignAssessmentsTable) {
      props.agentDesignAssessmentsTable.grantReadData(fabricatorLambda);
    }

    // Grant Fabricator permission to call Registry APIs
    if (props.registryArn) {
      fabricatorLambda.addToRolePolicy(
        new PolicyStatement({
          effect: Effect.ALLOW,
          actions: [
            'bedrock-agentcore:CreateRegistryRecord',
            'bedrock-agentcore:UpdateRegistryRecord',
            'bedrock-agentcore:UpdateRegistryRecordStatus',
            'bedrock-agentcore:SubmitRegistryRecordForApproval',
            'bedrock-agentcore:DeleteRegistryRecord',
            'bedrock-agentcore:GetRegistryRecord',
            'bedrock-agentcore:ListRegistryRecords',
          ],
          resources: [props.registryArn, `${props.registryArn}/*`],
        }),
      );
    }

    // Reliability hardening: batchSize=1 so each Lambda invocation processes
    // exactly ONE fabrication message. The SQS default (up to 10) lets a
    // single invocation stack many agents and blow past the 15-min function
    // timeout, triggering redelivery + duplicate fabrication. One message per
    // invocation bounds the invocation to a single agent fabrication.
    fabricatorLambda.addEventSource(new SqsEventSource(fabricatorQueue, { batchSize: 1 }));

    // Grant scoped SQS permissions to Supervisor (S-02 fix)
    supervisorLambda.addToRolePolicy(new PolicyStatement({
      effect: Effect.ALLOW,
      actions: ['sqs:SendMessage', 'sqs:ReceiveMessage', 'sqs:DeleteMessage'],
      resources: [workerAgentQueue.queueArn, fabricatorQueue.queueArn],
    }));

    // Seed initial agent configuration
    const seedAgentConfigLambda = new lambda.Function(this, 'SeedAgentConfigFunction', {
      runtime: lambda.Runtime.PYTHON_3_14,
      handler: 'index.handler',
      code: lambda.Code.fromAsset(path.join(ARBITER_ROOT, 'seedConfig')),
      timeout: cdk.Duration.seconds(30),
      environment: {
        AGENT_CONFIG_TABLE: props.agentConfigTable.tableName,
        WORKER_QUEUE_URL: workerAgentQueue.queueUrl,
        FABRICATOR_QUEUE_URL: fabricatorQueue.queueUrl,
      },
    });

    props.agentConfigTable.grantWriteData(seedAgentConfigLambda);

    // Invoke the Custom Resource to seed agent config table
    // This must come after fabricatorQueue is created since we pass its URL.
    // Bumped Version v1.0.0 → v1.1.0 so the CFN Update event fires
    // on the next deploy and the governance corpus (authority units +
    // constitutional layer) is seeded. Additional dependencies on the
    // governance tables are wired below, after those tables are declared.
    const seedAgentConfigResource = new cdk.CustomResource(this, 'SeedAgentConfigResource', {
      serviceToken: seedAgentConfigLambda.functionArn,
      properties: {
        // O-05: Use content hash instead of Date.now() to avoid unnecessary re-runs
        Version: 'v1.1.0',
      },
    });

    // Ensure the Custom Resource runs after the table and queue are created
    seedAgentConfigResource.node.addDependency(props.agentConfigTable);
    seedAgentConfigResource.node.addDependency(fabricatorQueue);

    // ============================================================
    // Activator Lambda + agent.activate EventBridge rule
    // ============================================================
    //
    // Consumes EventBridge events with source='agent.activate' and
    // flips the agent's lifecycle state on the AgentConfigTable:
    //   action='activate' → state='active'  (+ activatedAt / activatedBy)
    //   action='suspend'  → state='suspended' (+ suspendedAt / suspendedBy)
    //
    // The ConditionExpression `attribute_exists(agentId)` prevents the
    // lambda from creating a phantom record when an unknown agentId
    // arrives; a ConditionalCheckFailed turns into statusCode 404 in the
    // handler. Duplicate events are idempotent by construction since
    // UpdateItem overwrites with the same attribute value.
    const activatorLambda = new PythonFunction(this, 'ActivatorAgent', {
      runtime: lambda.Runtime.PYTHON_3_14,
      entry: path.join(ARBITER_ROOT, 'activator'),
      handler: 'handler',
      layers: [catalogLayer],
      bundling: { assetHashType: cdk.AssetHashType.SOURCE },
      timeout: cdk.Duration.seconds(30),
      memorySize: 512,
      environment: {
        AGENT_CONFIG_TABLE: props.agentConfigTable.tableName,
      },
    });

    props.agentConfigTable.grantReadWriteData(activatorLambda);

    const agentActivateRule = new events.Rule(this, 'AgentActivateRule', {
      eventBus: props.agentEventBus,
      eventPattern: { source: ['agent.activate'] },
    });
    agentActivateRule.addTarget(new targets.LambdaFunction(activatorLambda));

    // --- Step Runner Lambda (Task 1.6) ---
    if (props.workflowsTable && props.executionsTable && props.appSyncEndpoint) {
      const stepRunnerFunction = new lambda.Function(this, 'StepRunnerFunction', {
        runtime: lambda.Runtime.PYTHON_3_14,
        handler: 'index.handler',
        code: lambda.Code.fromAsset(path.join(ARBITER_ROOT, 'stepRunner')),
        timeout: cdk.Duration.minutes(5),
        memorySize: 1024,
        environment: {
          EXECUTIONS_TABLE: props.executionsTable.tableName,
          WORKFLOWS_TABLE: props.workflowsTable.tableName,
          AGENT_CONFIG_TABLE: props.agentConfigTable.tableName,
          TOOLS_CONFIG_TABLE: toolsConfigTable.tableName,
          EVENT_BUS_NAME: props.agentEventBus.eventBusName,
          APPSYNC_ENDPOINT: props.appSyncEndpoint,
        },
      });

      // Least-privilege IAM per design 8.2
      props.executionsTable.grantReadWriteData(stepRunnerFunction);
      props.workflowsTable.grantReadData(stepRunnerFunction);
      props.agentConfigTable.grantReadData(stepRunnerFunction);
      toolsConfigTable.grantReadData(stepRunnerFunction);
      props.agentEventBus.grantPutEventsTo(stepRunnerFunction);

      // EventBridge rules targeting StepRunner
      const stepRunnerStartRule = new events.Rule(this, 'StepRunnerStartRule', {
        eventBus: props.agentEventBus,
        eventPattern: {
          detailType: ['execution.start.requested'],
        },
      });
      stepRunnerStartRule.addTarget(new targets.LambdaFunction(stepRunnerFunction));

      const stepRunnerNodeCompletedRule = new events.Rule(this, 'StepRunnerNodeCompletedRule', {
        eventBus: props.agentEventBus,
        eventPattern: {
          detailType: ['workflow.node.completed'],
        },
      });
      stepRunnerNodeCompletedRule.addTarget(new targets.LambdaFunction(stepRunnerFunction));

      const stepRunnerNodeFailedRule = new events.Rule(this, 'StepRunnerNodeFailedRule', {
        eventBus: props.agentEventBus,
        eventPattern: {
          detailType: ['workflow.node.failed'],
        },
      });
      stepRunnerNodeFailedRule.addTarget(new targets.LambdaFunction(stepRunnerFunction));

      const stepRunnerCancelRule = new events.Rule(this, 'StepRunnerCancelRule', {
        eventBus: props.agentEventBus,
        eventPattern: {
          detailType: ['execution.cancel.requested'],
        },
      });
      stepRunnerCancelRule.addTarget(new targets.LambdaFunction(stepRunnerFunction));

      // WorkflowProgressFanoutRule — matches workflow.* events → FanoutFunction
      if (props.fanoutFunction) {
        const workflowProgressFanoutRule = new events.Rule(this, 'WorkflowProgressFanoutRule', {
          eventBus: props.agentEventBus,
          eventPattern: {
            source: ['citadel.workflows'],
            detailType: [
              'workflow.started',
              'workflow.node.started',
              'workflow.node.completed',
              'workflow.node.failed',
              'workflow.node.retrying',
              'workflow.completed',
              'workflow.failed',
            ],
          },
        });
        workflowProgressFanoutRule.addTarget(new targets.LambdaFunction(props.fanoutFunction));
      }
    }

    // O-03: Enable X-Ray active tracing on all Lambda functions
    // O-02: Add Powertools structured logging env vars
    this.node.findAll().forEach((child) => {
      if (child instanceof lambda.Function || child instanceof PythonFunction) {
        const fn = child as lambda.Function;
        fn.addEnvironment('POWERTOOLS_LOG_LEVEL', 'INFO');
        fn.addEnvironment('POWERTOOLS_SERVICE_NAME', 'citadel');
        const cfnFunction = fn.node.defaultChild as lambda.CfnFunction;
        if (cfnFunction &&!cfnFunction.tracingConfig) {
          cfnFunction.addPropertyOverride('TracingConfig', { Mode: 'Active' });
        }
      }
    });

    // O-01: CloudWatch alarms for DLQ depth and critical Lambda errors
    new cloudwatch.Alarm(this, 'WorkerDLQDepthAlarm', {
      alarmName: `citadel-worker-dlq-depth-${props.environment}`,
      metric: workerAgentDLQ.metricApproximateNumberOfMessagesVisible({
        period: cdk.Duration.minutes(5),
      }),
      threshold: 1,
      evaluationPeriods: 1,
      comparisonOperator: cloudwatch.ComparisonOperator.GREATER_THAN_OR_EQUAL_TO_THRESHOLD,
      treatMissingData: cloudwatch.TreatMissingData.NOT_BREACHING,
      alarmDescription: 'Worker agent DLQ has messages — indicates failed processing',
    });

    new cloudwatch.Alarm(this, 'SupervisorErrorAlarm', {
      alarmName: `citadel-supervisor-errors-${props.environment}`,
      metric: supervisorLambda.metricErrors({ period: cdk.Duration.minutes(5) }),
      threshold: 3,
      evaluationPeriods: 1,
      comparisonOperator: cloudwatch.ComparisonOperator.GREATER_THAN_OR_EQUAL_TO_THRESHOLD,
      treatMissingData: cloudwatch.TreatMissingData.NOT_BREACHING,
      alarmDescription: 'Supervisor Lambda error rate exceeded threshold',
    });

    new cloudwatch.Alarm(this, 'FabricatorErrorAlarm', {
          alarmName: `citadel-fabricator-errors-${props.environment}`,
          metric: fabricatorLambda.metricErrors({ period: cdk.Duration.minutes(5) }),
          threshold: 3,
          evaluationPeriods: 1,
          comparisonOperator: cloudwatch.ComparisonOperator.GREATER_THAN_OR_EQUAL_TO_THRESHOLD,
          treatMissingData: cloudwatch.TreatMissingData.NOT_BREACHING,
          alarmDescription: 'Fabricator Lambda error rate exceeded threshold',
        });

        // ============================================================
        // Jagged-Frontier escalation alarm (follow-up #8)
        // ============================================================
        // Every invocation of the ``escalate`` tool in
        // ``arbiter/workerWrapper/tools/escalate.py`` emits one
        // ``CitadelGovernance/OffFrontierEscalations`` metric increment
        // (dimension ``ProjectId``) and one ``governance.offfrontier.escalated``
        // EventBridge event. Escalations are rare by design — the C12
        // Jagged-Frontier principle says agents should escalate only tasks
        // outside AI-analytical scope — so even a single escalation in an
        // hour is notable and should page operators.
        //
        // Threshold: Sum > 0 over 1 hour. Treat missing data as not-breaching
        // so quiet environments don't fire phantom alarms.
        //
        // Routes to a dedicated KMS-encrypted SNS topic (ESCALATION_TOPIC_ARN)
        // that operators can subscribe to (email / Slack / PagerDuty bridge).
        // The topic ARN is also exposed as an env var on both the supervisor
        // and worker Lambdas so a future change can wire escalate() to
        // publish to SNS directly in addition to the current CloudWatch +
        // EventBridge emission path.
        //
        // No dimension filter on the alarm — any ProjectId that escalates
        // triggers it. A future refinement could split per-project alarms
        // using metric math, but for the MVP the aggregate is the right
        // signal.
        const escalationTopicKey = new kms.Key(this, 'EscalationTopicKey', {
          description: `Citadel Jagged-Frontier escalation SNS topic CMK (${props.environment})`,
          enableKeyRotation: true,
          removalPolicy: cdk.RemovalPolicy.DESTROY,
        });

        // ``enforceSSL: true`` tells CDK 2.100+ to emit the
        // ``AllowPublishThroughSSLOnly`` DENY statement into the auto-created
        // TopicPolicy — that alone satisfies AwsSolutions-SNS3. An earlier
        // version of this block also added the same statement explicitly via
        // ``addToResourcePolicy`` as a belt-and-braces guard for older CDK
        // versions; that produced two statements sharing the same SID in one
        // policy, which SNS rejects with:
        // "Invalid parameter: Every policy statement must have a unique ID"
        // Do NOT re-add the explicit statement.
        const escalationTopic = new sns.Topic(this, 'EscalationTopic', {
          topicName: `citadel-governance-escalations-${props.environment}`,
          displayName: `Citadel Governance Escalations (${props.environment})`,
          masterKey: escalationTopicKey,
          enforceSSL: true,
        });

        new cloudwatch.Alarm(this, 'OffFrontierEscalationAlarm', {
          alarmName: `citadel-offfrontier-escalations-${props.environment}`,
          metric: new cloudwatch.Metric({
            namespace: 'CitadelGovernance',
            metricName: 'OffFrontierEscalations',
            statistic: 'Sum',
            period: cdk.Duration.hours(1),
          }),
          threshold: 0,
          evaluationPeriods: 1,
          datapointsToAlarm: 1,
          comparisonOperator: cloudwatch.ComparisonOperator.GREATER_THAN_THRESHOLD,
          treatMissingData: cloudwatch.TreatMissingData.NOT_BREACHING,
          alarmDescription:
            'Any Jagged-Frontier escalation within the last hour. ' +
            'Routes to citadel-governance-escalations-<env> SNS topic — operators ' +
            'should investigate why an agent escalated and whether the underlying ' +
            'task belongs on the AI-analytical frontier.',
        }).addAlarmAction(new cw_actions.SnsAction(escalationTopic));

        // Expose the topic ARN to both Lambdas that can legitimately emit
        // escalations in the future (today only the worker emits via the
        // escalate tool; supervisor reserves the env var for a routing
        // refactor). Grant Publish on both so neither path needs a follow-up
        // IAM change when wiring lands.
        workerAgentWrapperLambda.addEnvironment('ESCALATION_TOPIC_ARN', escalationTopic.topicArn);
        supervisorLambda.addEnvironment('ESCALATION_TOPIC_ARN', escalationTopic.topicArn);
        escalationTopic.grantPublish(workerAgentWrapperLambda);
        escalationTopic.grantPublish(supervisorLambda);

            // cdk-nag suppressions: Topic.grantPublish() on a
            // KMS-encrypted topic auto-attaches kms:GenerateDataKey* (covers
            // GenerateDataKey and GenerateDataKeyWithoutPlaintext) and
            // kms:ReEncrypt* to the caller's DefaultPolicy. Standard AWS
            // pattern — cannot be narrowed without losing SNS publish
            // functionality. Tracked: AAF-NAG-IAM5-kms. reviewBy: 2026-10-22.
            const kmsPublishSuppression = [{
              id: 'AwsSolutions-IAM5',
              reason:
                'Topic.grantPublish() on KMS-encrypted SNS topic attaches ' +
                'kms:GenerateDataKey* and kms:ReEncrypt* wildcards via AWS SDK ' +
                'defaults; these cannot be narrowed without breaking publish. ' +
                'Resource is scoped to the escalation topic CMK only.',
              appliesTo: [
                'Action::kms:GenerateDataKey*',
                'Action::kms:ReEncrypt*',
              ],
            }];
            NagSuppressions.addResourceSuppressions(
              supervisorLambda.role!,
              kmsPublishSuppression,
              true,
            );
            NagSuppressions.addResourceSuppressions(
              workerAgentWrapperLambda.role!,
              kmsPublishSuppression,
              true,
            );

    // ============================================================
    // Governance authority/ledger tables (Δ8)
    // ============================================================
    //
    // Four governance-critical configuration tables (authority units,
    // composition contracts, case law, constitutional layers) plus one
    // append-only ledger. The four config tables carry DeletionProtection
    // and RemovalPolicy.RETAIN so the corpus survives stack deletion; the
    // ledger uses RemovalPolicy.DESTROY with a 90-day TTL (`ttl` attr)
    // since its lifecycle is governed by TTL rather than table retention.
    // All five enable PITR to satisfy AwsSolutions-DDB3 (cdk-nag).
    //
    // Tables are exposed as public readonly fields on ArbiterStack so
    // downstream stories (US-ARB-003 hierarchy loader, US-ARB-004 ledger
    // writer) can grantReadData / grantWriteData from other Lambdas
    // without reaching into constructor-local scope. The alias-const
    // pattern (see /016 in backend-stack.ts) keeps any
    // downstream in-constructor references terse.

    this.authorityUnitsTable = new dynamodb.Table(this, 'AuthorityUnitsTable', {
      tableName: `citadel-authority-units-${props.environment}`,
      partitionKey: { name: 'unitId', type: dynamodb.AttributeType.STRING },
      billingMode: dynamodb.BillingMode.PAY_PER_REQUEST,
      removalPolicy: cdk.RemovalPolicy.RETAIN,
      deletionProtection: true,
      pointInTimeRecoverySpecification: { pointInTimeRecoveryEnabled: true },
      // Wave 4.E.A.2: enable DynamoDB streams so governance-graph-snapshot-on-change
      // produces a fresh snapshot row whenever this table changes.
      stream: dynamodb.StreamViewType.NEW_AND_OLD_IMAGES,
    });

    this.compositionContractsTable = new dynamodb.Table(this, 'CompositionContractsTable', {
      tableName: `citadel-composition-contracts-${props.environment}`,
      partitionKey: { name: 'contractId', type: dynamodb.AttributeType.STRING },
      billingMode: dynamodb.BillingMode.PAY_PER_REQUEST,
      removalPolicy: cdk.RemovalPolicy.RETAIN,
      deletionProtection: true,
      pointInTimeRecoverySpecification: { pointInTimeRecoveryEnabled: true },
      // Wave 4.E.A.2: enable DynamoDB streams so governance-graph-snapshot-on-change
      // produces a fresh snapshot row whenever this table changes.
      stream: dynamodb.StreamViewType.NEW_AND_OLD_IMAGES,
    });

    this.caseLawTable = new dynamodb.Table(this, 'CaseLawTable', {
      tableName: `citadel-case-law-${props.environment}`,
      partitionKey: { name: 'entryId', type: dynamodb.AttributeType.STRING },
      billingMode: dynamodb.BillingMode.PAY_PER_REQUEST,
      removalPolicy: cdk.RemovalPolicy.RETAIN,
      deletionProtection: true,
      pointInTimeRecoverySpecification: { pointInTimeRecoveryEnabled: true },
      // Wave 4.E.A.2: enable DynamoDB streams so governance-graph-snapshot-on-change
      // produces a fresh snapshot row whenever this table changes.
      stream: dynamodb.StreamViewType.NEW_AND_OLD_IMAGES,
    });

    this.constitutionalLayersTable = new dynamodb.Table(this, 'ConstitutionalLayersTable', {
      tableName: `citadel-constitutional-layers-${props.environment}`,
      partitionKey: { name: 'layerId', type: dynamodb.AttributeType.STRING },
      billingMode: dynamodb.BillingMode.PAY_PER_REQUEST,
      removalPolicy: cdk.RemovalPolicy.RETAIN,
      deletionProtection: true,
      pointInTimeRecoverySpecification: { pointInTimeRecoveryEnabled: true },
      // Wave 4.E.A.2: enable DynamoDB streams so governance-graph-snapshot-on-change
      // produces a fresh snapshot row whenever this table changes.
      stream: dynamodb.StreamViewType.NEW_AND_OLD_IMAGES,
    });

    // Wave 4.E.A — authority graph snapshots table. Stores daily snapshots
    // of the four source tables (authorityUnits, compositionContracts,
    // constitutionalLayers, caseLaw) so the Wave 4.E.B time scrubber can
    // pivot between historical points. Snapshots are reproducible from
    // the source tables, so RemovalPolicy.DESTROY is intentional —
    // RETAIN here would orphan storage that has no off-stack restore
    // value. TTL via `expiresAt` enforces the operator-selected
    // retention window without manual cleanup.
    this.governanceGraphSnapshotsTable = new dynamodb.Table(this, 'GovernanceGraphSnapshotsTable', {
      tableName: `citadel-governance-graph-snapshots-${props.environment}`,
      partitionKey: { name: 'snapshotId', type: dynamodb.AttributeType.STRING },
      sortKey: { name: 'timestamp', type: dynamodb.AttributeType.NUMBER },
      billingMode: dynamodb.BillingMode.PAY_PER_REQUEST,
      removalPolicy: cdk.RemovalPolicy.DESTROY,
      pointInTimeRecoverySpecification: { pointInTimeRecoveryEnabled: true },
      timeToLiveAttribute: 'expiresAt',
    });
    this.governanceGraphSnapshotsTable.addGlobalSecondaryIndex({
      indexName: 'kind-timestamp-index',
      partitionKey: { name: 'kind', type: dynamodb.AttributeType.STRING },
      sortKey: { name: 'timestamp', type: dynamodb.AttributeType.NUMBER },
      projectionType: dynamodb.ProjectionType.ALL,
    });

    this.governanceLedgerTable = new dynamodb.Table(this, 'GovernanceLedgerTable', {
      tableName: `citadel-governance-ledger-${props.environment}`,
      partitionKey: { name: 'findingId', type: dynamodb.AttributeType.STRING },
      billingMode: dynamodb.BillingMode.PAY_PER_REQUEST,
      removalPolicy: cdk.RemovalPolicy.DESTROY,
      timeToLiveAttribute: 'ttl',
      pointInTimeRecoverySpecification: { pointInTimeRecoveryEnabled: true },
      // Wave 3.C: enable DynamoDB streams so the governance-finding-fanout
      // Lambda can project new ledger rows into the AppSync
      // `publishGovernanceFinding` mutation. Adding StreamSpecification
      // is an in-place table update per AWS::DynamoDB::Table CloudFormation
      // spec (no Replacement: True), so this is safe even though the
      // existing table is in production. The stream view is
      // NEW_AND_OLD_IMAGES for forward-compatibility (a future
      // delete/update fanout could read OldImage); the current Lambda
      // reads NewImage only.
      stream: dynamodb.StreamViewType.NEW_AND_OLD_IMAGES,
    });
    const governanceLedgerTable = this.governanceLedgerTable;

    governanceLedgerTable.addGlobalSecondaryIndex({
      indexName: 'workflow-index',
      partitionKey: { name: 'workflowId', type: dynamodb.AttributeType.STRING },
      sortKey: { name: 'timestamp', type: dynamodb.AttributeType.NUMBER },
      projectionType: dynamodb.ProjectionType.ALL,
    });

    // ============================================================
    // wire governance seed into SeedAgentConfigFunction
    // ============================================================
    // The seed lambda is declared earlier in the stack (before the
    // governance tables exist as constructs) so we patch in the extra
    // env vars / grants / construct dependencies here. The table
    // existence is further enforced at deploy time via
    // CustomResource.addDependency so the put_items cannot race the
    // CreateTable calls.
    seedAgentConfigLambda.addEnvironment(
      'AUTHORITY_UNITS_TABLE', this.authorityUnitsTable.tableName,
    );
    seedAgentConfigLambda.addEnvironment(
      'CONSTITUTIONAL_LAYERS_TABLE', this.constitutionalLayersTable.tableName,
    );

    this.authorityUnitsTable.grantWriteData(seedAgentConfigLambda);
    this.constitutionalLayersTable.grantWriteData(seedAgentConfigLambda);

    seedAgentConfigResource.node.addDependency(this.authorityUnitsTable);
    seedAgentConfigResource.node.addDependency(this.constitutionalLayersTable);

    // ============================================================
    // Governance UI Wave 1 — read-only resolver for the ledger table
    // ============================================================
    //
    // The ledger table (governanceLedgerTable) lives in this stack, so the
    // resolver Lambda + AppSync data source must too. Putting the
    // CfnDataSource/CfnResolver on the BackendStack-owned API via
    // L2 `addLambdaDataSource()` would stamp the Lambda's ARN into
    // BackendStack's template and create a BackendStack → ArbiterStack
    // dependency edge — a cycle, since ArbiterStack already depends on
    // BackendStack via every other prop on ArbiterStackProps.
    //
    // The fix is the same as governance-stack.ts: reference
    // props.appSyncApi.apiId (a string token) from L1
    // `appsyncCfn.CfnDataSource` + `CfnResolver`, which materialises the
    // resources in *this* stack and only creates a one-way string-token
    // dependency. The `LAMBDA_REQUEST_MAPPING` / `LAMBDA_RESPONSE_MAPPING`
    // literals match the L2 defaults so the runtime payload shape is
    // identical to other resolvers.
    const LAMBDA_REQUEST_MAPPING = `{
  "version": "2017-02-28",
  "operation": "Invoke",
  "payload": $util.toJson($context)
}`;
    const LAMBDA_RESPONSE_MAPPING = `$util.toJson($ctx.result)`;

    const governanceUiResolverFn = new lambda.Function(this, 'GovernanceUiResolverFn', {
      runtime: lambda.Runtime.NODEJS_24_X,
      handler: 'governance-ui-resolver.handler',
      code: lambda.Code.fromAsset('dist/lambda'),
      timeout: cdk.Duration.seconds(30),
      environment: {
        ENVIRONMENT: props.environment,
        GOVERNANCE_LEDGER_TABLE: this.governanceLedgerTable.tableName,
        AUTHORITY_UNITS_TABLE: this.authorityUnitsTable.tableName,
        // Wave 4.A: listCompositionContracts reads the composition
        // contracts table for the authority graph projection. Admin-only
        // path; the resolver throws when unset.
        COMPOSITION_CONTRACTS_TABLE: this.compositionContractsTable.tableName,
        // Wave 4.C: listConstitutionalLayers reads the constitutional
        // layers table for the rule tree page. Admin-only; the resolver
        // throws when unset.
        CONSTITUTIONAL_LAYERS_TABLE: this.constitutionalLayersTable.tableName,
        // Wave 4.D: listCaseLaw reads the case-law table for the
        // precedence timeline page. Admin-only (read-only); the
        // resolver throws when unset. Encode/revoke admin actions ship
        // in Wave 4.D.2 — no write grant in this wave.
        CASE_LAW_TABLE: this.caseLawTable.tableName,
        // Wave 4.E.A: getAuthorityGraphHistorySettings scans the
        // snapshots table to count snapshots within the retention
        // window. Same table is also written by the scheduled
        // governance-graph-snapshot Lambda below.
        GRAPH_SNAPSHOTS_TABLE: this.governanceGraphSnapshotsTable.tableName,
        // Wave 2.E: setGovernanceMode emits a governance.mode.transition
        // EventBridge event via the shared notifier-base helper. The Lambda
        // needs the bus name on the env so the EventBridgeClient targets the
        // correct bus (default fallback is 'default', which would silently
        // drop the audit event on accounts where the agent bus is the only
        // bus the governance rule is subscribed to).
        EVENT_BUS_NAME: props.agentEventBus.eventBusName,
        // Wave 2.B: data-2 + data-3 read from the AgentCore Registry. Only
        // wire REGISTRY_ID / REGISTRY_ENABLED when an actual registry is
        // provisioned; the resolver tolerates an unset REGISTRY_ID by
        // returning UNKNOWN for those checks.
        ...(props.registryId && { REGISTRY_ID: props.registryId }),
        ...(props.registryId && { REGISTRY_ENABLED: 'true' }),
      },
      logGroup: new logs.LogGroup(this, 'GovernanceUiResolverFnLogs', {
        retention: logs.RetentionDays.ONE_WEEK,
        removalPolicy: cdk.RemovalPolicy.DESTROY,
      }),
    });

    // Wave 5.C.1: getTrustPath uses LAMBDA_EXEC_ROLE_ARN as the assumer
    // anchor for hop 1 of the trust chain. Resolved post-construction
    // because the role ARN is a Function attribute. Names of the
    // datastores + integrations tables are passed as env vars so the
    // resolver can read resources by id without re-deriving the table
    // name from the environment string.
    governanceUiResolverFn.addEnvironment(
      'LAMBDA_EXEC_ROLE_ARN',
      governanceUiResolverFn.role!.roleArn,
    );
    governanceUiResolverFn.addEnvironment(
      'DATASTORES_TABLE',
      `citadel-datastores-${props.environment}`,
    );
    governanceUiResolverFn.addEnvironment(
      'INTEGRATIONS_TABLE',
      `citadel-integrations-${props.environment}`,
    );

    this.governanceLedgerTable.grantReadData(governanceUiResolverFn);
    // Wave 2.A: data-1 readiness check scans the authority units table.
    this.authorityUnitsTable.grantReadData(governanceUiResolverFn);
    // Wave 4.A: listCompositionContracts scans the composition contracts
    // table. Read-only — the resolver only ever calls Scan on this table.
    this.compositionContractsTable.grantReadData(governanceUiResolverFn);
    // Wave 4.C: listConstitutionalLayers scans the constitutional layers
    // table. Read-only — the resolver only ever calls Scan on this table.
    this.constitutionalLayersTable.grantReadData(governanceUiResolverFn);
    // Wave 4.C.2: addConstitutionalRule / updateConstitutionalRule /
    // deleteConstitutionalRule write the new rules JSON list back via
    // PutItem (we read the row then overwrite with the new rules).
    // GetItem is also required (pre-write reconnaissance + final
    // re-projection). Scoped to the same table only.
    governanceUiResolverFn.addToRolePolicy(new iam.PolicyStatement({
      effect: iam.Effect.ALLOW,
      actions: [
        'dynamodb:GetItem',
        'dynamodb:PutItem',
        'dynamodb:UpdateItem',
      ],
      resources: [this.constitutionalLayersTable.tableArn],
    }));
    // Wave 4.D: listCaseLaw scans the case-law table. Read-only —
    // the resolver only ever calls Scan on this table; encode/revoke
    // admin actions ship in Wave 4.D.2 with their own write grants.
    this.caseLawTable.grantReadData(governanceUiResolverFn);
    // Wave 4.D.2: revokeCaseLaw / unrevokeCaseLaw / updateCaseLawPrecedence
    // mutate the soft-delete + precedence fields via UpdateItem. Scoped
    // to the case-law table only. GetItem is already covered by
    // grantReadData above; only UpdateItem is added here.
    governanceUiResolverFn.addToRolePolicy(new iam.PolicyStatement({
      effect: iam.Effect.ALLOW,
      actions: [
        'dynamodb:UpdateItem',
      ],
      resources: [this.caseLawTable.tableArn],
    }));
    // Allow the GSI to be queried as well — grantReadData covers the base
    // table only; index reads need an explicit /index/* resource grant.
    governanceUiResolverFn.addToRolePolicy(new iam.PolicyStatement({
      effect: iam.Effect.ALLOW,
      actions: ['dynamodb:Query'],
      resources: [`${this.governanceLedgerTable.tableArn}/index/*`],
    }));

    // Wave 4.E.A: getAuthorityGraphHistorySettings scans the snapshots
    // table to count rows within the retention window. Read-only on
    // the snapshots table from the resolver — writes happen exclusively
    // from the scheduled snapshot Lambda.
    //
    // Wave 4.E.B: listAuthorityGraphSnapshots queries the
    // `kind-timestamp-index` GSI to enumerate snapshot summaries; the
    // GSI requires its own /index/* resource grant.
    // getAuthorityGraphSnapshot uses a Query on the base table keyed
    // on the partition key only.
    governanceUiResolverFn.addToRolePolicy(new iam.PolicyStatement({
      effect: iam.Effect.ALLOW,
      actions: ['dynamodb:Scan', 'dynamodb:Query', 'dynamodb:GetItem'],
      resources: [
        this.governanceGraphSnapshotsTable.tableArn,
        `${this.governanceGraphSnapshotsTable.tableArn}/index/*`,
      ],
    }));

    // SSM read scope: getReconcilerStatus / governance-flag helper reads,
    // rb-1 readiness check (GetParameter on enforce mode), and rb-2
    // readiness check (GetParameterHistory on enforce mode for transition
    // detection in the last 7 days).
    governanceUiResolverFn.addToRolePolicy(new iam.PolicyStatement({
      effect: iam.Effect.ALLOW,
      actions: ['ssm:GetParameter', 'ssm:GetParameterHistory'],
      resources: [
        `arn:aws:ssm:${this.region}:${this.account}:parameter/citadel/governance/*`,
      ],
    }));

    // Wave 2.E: setGovernanceMode mutates the enforce + effective_at SSM
    // parameters. Scoped to the two exact ARNs (one per parameter) — never
    // wildcarded over /citadel/governance/* because nothing else under that
    // prefix should be writable from this resolver.
    governanceUiResolverFn.addToRolePolicy(new iam.PolicyStatement({
      effect: iam.Effect.ALLOW,
      actions: ['ssm:PutParameter'],
      resources: [
        `arn:aws:ssm:${this.region}:${this.account}:parameter/citadel/governance/enforce/${props.environment}`,
        `arn:aws:ssm:${this.region}:${this.account}:parameter/citadel/governance/effective_at/${props.environment}`,
        // Wave 4.E.A: updateAuthorityGraphHistorySettings writes the
        // authority-graph-history JSON blob. Scoped to the exact ARN
        // for this env so no other parameter under /citadel/governance/
        // becomes writable.
        `arn:aws:ssm:${this.region}:${this.account}:parameter/citadel/governance/authority-graph-history/${props.environment}`,
      ],
    }));

    // Wave 2.B.2: markReadinessCheckVerified writes operator attestation
    // blobs to /citadel/governance/readiness/manual/<env>/<checkId>. The
    // resolver's allowlist constrains <checkId> to the 6 manual stubs,
    // so the wildcard at the end of the ARN is bounded by code rather
    // than IAM. Nag suppression below documents why the trailing `*` is
    // acceptable here.
    governanceUiResolverFn.addToRolePolicy(new iam.PolicyStatement({
      effect: iam.Effect.ALLOW,
      actions: ['ssm:PutParameter'],
      resources: [
        `arn:aws:ssm:${this.region}:${this.account}:parameter/citadel/governance/readiness/manual/*`,
      ],
    }));
    NagSuppressions.addResourceSuppressions(
      governanceUiResolverFn.role!,
      [
        {
          id: 'AwsSolutions-IAM5',
          reason:
            'ssm:PutParameter on /citadel/governance/readiness/manual/* is ' +
            'narrowed in code to a 6-item allowlist of manual checkIds ' +
            '(tel-1, tel-2, rb-2, own-1, own-2, own-3) and the four-value ' +
            'expiresInDays allowlist; broader IAM scoping would require one ' +
            'statement per (env, checkId) pair, which adds complexity without ' +
            'reducing blast radius.',
          appliesTo: [
            'Resource::arn:<AWS::Partition>:ssm:<AWS::Region>:<AWS::AccountId>:parameter/citadel/governance/readiness/manual/*',
          ],
        },
      ],
      true,
    );

    // Wave 2.E: setGovernanceMode emits a governance.mode.transition
    // EventBridge event on the agent event bus via the shared
    // emitGovernanceEvent helper. Mirrors the Supervisor / Worker grant
    // pattern (PutEvents on the bus ARN).
    props.agentEventBus.grantPutEventsTo(governanceUiResolverFn);

    // Wave 2.B tel-3: GetMetricStatistics for RegistrySync/SyncFailure
    // over the last 48h. CloudWatch metrics do not support resource-level
    // scoping — the action must be granted on '*'. The metric query is
    // narrowly bound to the RegistrySync namespace and SyncFailure metric
    // in the resolver.
    governanceUiResolverFn.addToRolePolicy(new iam.PolicyStatement({
      effect: iam.Effect.ALLOW,
      actions: ['cloudwatch:GetMetricStatistics'],
      resources: ['*'],
    }));
    NagSuppressions.addResourceSuppressions(
      governanceUiResolverFn.role!,
      [
        {
          id: 'AwsSolutions-IAM5',
          reason:
            'cloudwatch:GetMetricStatistics has no resource-level scoping; ' +
            'the resolver narrows the query to namespace=RegistrySync, ' +
            'metric=SyncFailure for the tel-3 readiness check.',
          appliesTo: ['Resource::*'],
        },
      ],
      true,
    );

    // Wave 2.B data-2 + data-3: read the AgentCore Registry. Mirrors the
    // Supervisor / Worker grants — never CRUD, just Get + List. Only attach
    // the policy when the registry ARN is provided; in test paths the
    // resolver tolerates UNKNOWN for these two checks.
    if (props.registryArn) {
      governanceUiResolverFn.addToRolePolicy(new iam.PolicyStatement({
        effect: iam.Effect.ALLOW,
        actions: [
          'bedrock-agentcore:GetRegistryRecord',
          'bedrock-agentcore:ListRegistryRecords',
        ],
        resources: [props.registryArn, `${props.registryArn}/*`],
      }));
    }

    // Cognito AdminGetUser scope for isAdminFromEvent's fallback path.
    // Prefer the precise user-pool ARN when supplied; otherwise fall back
    // to the broader userpool/* path with a TODO so the wiring can be
    // tightened when bin/app.ts always passes the ARN.
    if (props.userPoolArn) {
      governanceUiResolverFn.addToRolePolicy(new iam.PolicyStatement({
        effect: iam.Effect.ALLOW,
        actions: ['cognito-idp:AdminGetUser'],
        resources: [props.userPoolArn],
      }));
    } else {
      // TODO(governance-ui): tighten this scope to the BackendStack user pool
      // ARN once bin/app.ts always wires `userPoolArn` into ArbiterStackProps.
      governanceUiResolverFn.addToRolePolicy(new iam.PolicyStatement({
        effect: iam.Effect.ALLOW,
        actions: ['cognito-idp:AdminGetUser'],
        resources: [`arn:aws:cognito-idp:${this.region}:${this.account}:userpool/*`],
      }));
    }

    // Wave 5.C.1: getTrustPath inspects the IAM assume chain that the
    // governance UI resolver follows to reach a target resource. Per
    // hop the resolver calls iam:GetRole + iam:GetRolePolicy. Scope is
    // the three citadel scoped-role prefixes plus the Lambda's own
    // execution role ARN — never wildcarded across all roles.
    governanceUiResolverFn.addToRolePolicy(new iam.PolicyStatement({
      effect: iam.Effect.ALLOW,
      actions: ['iam:GetRole', 'iam:GetRolePolicy'],
      resources: [
        `arn:aws:iam::${this.account}:role/citadel-ds-*`,
        `arn:aws:iam::${this.account}:role/citadel-int-*`,
        `arn:aws:iam::${this.account}:role/citadel-agent-*`,
        governanceUiResolverFn.role!.roleArn,
      ],
    }));
    NagSuppressions.addResourceSuppressions(
      governanceUiResolverFn.role!,
      [
        {
          id: 'AwsSolutions-IAM5',
          reason:
            'iam:GetRole / iam:GetRolePolicy on citadel-{ds,int,agent}-* ' +
            'wildcards a single resourceId suffix per scope, mirroring the ' +
            'PolicyManager naming convention. Read-only inspection used by ' +
            'the Wave 5.C.1 IAM trust path page; no write actions. The ' +
            'fourth resource is the Lambda\'s own role ARN (exact).',
          appliesTo: [
            'Resource::arn:aws:iam::<AWS::AccountId>:role/citadel-ds-*',
            'Resource::arn:aws:iam::<AWS::AccountId>:role/citadel-int-*',
            'Resource::arn:aws:iam::<AWS::AccountId>:role/citadel-agent-*',
          ],
        },
      ],
      true,
    );

    // Wave 5.C.1: getTrustPath uses sts:GetCallerIdentity to resolve the
    // account id for scoped role ARN construction. Already implicitly
    // allowed via the AWS SDK default, but granted explicitly here so
    // the IAM blast radius is documented next to the other governance
    // UI grants.
    governanceUiResolverFn.addToRolePolicy(new iam.PolicyStatement({
      effect: iam.Effect.ALLOW,
      actions: ['sts:GetCallerIdentity'],
      resources: ['*'],
    }));
    NagSuppressions.addResourceSuppressions(
      governanceUiResolverFn.role!,
      [
        {
          id: 'AwsSolutions-IAM5',
          reason:
            'sts:GetCallerIdentity has no resource-level scoping; it returns ' +
            'the caller\'s own identity and grants no access beyond what is ' +
            'already implicitly available to the Lambda execution role.',
          appliesTo: ['Resource::*'],
        },
      ],
      true,
    );

    // Wave 5.C.1: getTrustPath reads the datastores + integrations tables
    // to look up an optional crossAccountRoleArn. Read-only, scoped to the
    // exact table ARNs (and the integrations GSI used by the resolver
    // read path). Audit: neither table is granted on the governance UI
    // resolver in earlier waves.
    governanceUiResolverFn.addToRolePolicy(new iam.PolicyStatement({
      effect: iam.Effect.ALLOW,
      actions: ['dynamodb:GetItem'],
      resources: [
        `arn:aws:dynamodb:${this.region}:${this.account}:table/citadel-datastores-${props.environment}`,
      ],
    }));
    governanceUiResolverFn.addToRolePolicy(new iam.PolicyStatement({
      effect: iam.Effect.ALLOW,
      actions: ['dynamodb:Query'],
      resources: [
        `arn:aws:dynamodb:${this.region}:${this.account}:table/citadel-integrations-${props.environment}`,
        `arn:aws:dynamodb:${this.region}:${this.account}:table/citadel-integrations-${props.environment}/index/IntegrationIdIndex`,
      ],
    }));

    // Only attach the AppSync data source + resolvers when an API is
    // actually wired. Existing arbiter-stack-*.test.ts paths construct the
    // stack without an API, and that should remain a valid synthesis.
    if (props.appSyncApi) {
      const governanceUiDataSourceRole = new iam.Role(this, 'GovernanceUiDataSourceRole', {
        assumedBy: new iam.ServicePrincipal('appsync.amazonaws.com'),
      });
      governanceUiResolverFn.grantInvoke(governanceUiDataSourceRole);

      const governanceUiLambdaDataSource = new appsyncCfn.CfnDataSource(this, 'GovernanceUiLambdaDataSource', {
        apiId: props.appSyncApi.apiId,
        name: 'GovernanceUiLambdaDataSource',
        type: 'AWS_LAMBDA',
        serviceRoleArn: governanceUiDataSourceRole.roleArn,
        lambdaConfig: {
          lambdaFunctionArn: governanceUiResolverFn.functionArn,
        },
      });

      const governanceUiResolverFields = [
        'getGovernanceMode',
        'listGovernanceFindings',
        'getGovernanceFinding',
        'getReconcilerStatus',
        'getRolloutReadiness',
        'getMismatchHeatmap',
        'getEscalationMetricSeries',
        // Wave 3.B: 10th resolver — `getDecisionTrace` on the Query type.
        // Same Lambda + data source as the other reads. The resolver
        // composes a finding's reason / scope / contract fields into the
        // engine's 8-step pipeline state for the tracer page.
        'getDecisionTrace',
        // Wave 4.A: 11th + 12th resolvers — `listAuthorityUnits` and
        // `listCompositionContracts` on the Query type. Read-only
        // projections of the authority graph, admin-only via the resolver
        // dispatch (defence in depth on top of the AppSync auth layer).
        'listAuthorityUnits',
        'listCompositionContracts',
        // Wave 4.B: 13th resolver — `getRevokeImpact` on the Query type.
        // Blast-radius approximation that scans the governance ledger
        // for permit findings where the supplied unitId was the matched
        // scope. No new IAM (already has Scan on the ledger). Admin-only
        // via the resolver dispatch.
        'getRevokeImpact',
        // Wave 4.C: 14th + 15th resolvers — `listConstitutionalLayers`
        // and `getConstitutionalRuleStats` on the Query type. Read-only
        // projection of the constitutional rule tree + per-rule
        // override statistics. Admin-only via the resolver dispatch.
        'listConstitutionalLayers',
        'getConstitutionalRuleStats',
        // Wave 4.D: 16th resolver — `listCaseLaw` on the Query type.
        // Read-only projection of the case-law timeline. Admin-only
        // via the resolver dispatch. Encode/revoke admin actions ship
        // in Wave 4.D.2 as additional Mutation-typed resolvers.
        'listCaseLaw',
      ];
      for (const fieldName of governanceUiResolverFields) {
        const resolver = new appsyncCfn.CfnResolver(this, `GovernanceUi_${fieldName}_Resolver`, {
          apiId: props.appSyncApi.apiId,
          typeName: 'Query',
          fieldName,
          dataSourceName: governanceUiLambdaDataSource.attrName,
          requestMappingTemplate: LAMBDA_REQUEST_MAPPING,
          responseMappingTemplate: LAMBDA_RESPONSE_MAPPING,
        });
        resolver.addDependency(governanceUiLambdaDataSource);
      }

      // Wave 2.E: 8th resolver — `setGovernanceMode` on the Mutation type.
      // Mirrors the 7 query resolvers' shape with typeName flipped to
      // 'Mutation'. Kept as a separate CfnResolver entry rather than
      // expanding the loop because this is the only Mutation-typed
      // resolver wired by the governance UI Lambda; bundling it into the
      // generic loop above would force a typeName branch for one entry.
      const setGovernanceModeResolver = new appsyncCfn.CfnResolver(
        this,
        'GovernanceUi_setGovernanceMode_Resolver',
        {
          apiId: props.appSyncApi.apiId,
          typeName: 'Mutation',
          fieldName: 'setGovernanceMode',
          dataSourceName: governanceUiLambdaDataSource.attrName,
          requestMappingTemplate: LAMBDA_REQUEST_MAPPING,
          responseMappingTemplate: LAMBDA_RESPONSE_MAPPING,
        },
      );
      setGovernanceModeResolver.addDependency(governanceUiLambdaDataSource);

      // Wave 2.B.2: 9th resolver — `markReadinessCheckVerified` on the
      // Mutation type. Same Lambda data source as the queries because the
      // verification write piggybacks on the existing governance UI
      // resolver dispatch.
      const markReadinessCheckVerifiedResolver = new appsyncCfn.CfnResolver(
        this,
        'GovernanceUi_markReadinessCheckVerified_Resolver',
        {
          apiId: props.appSyncApi.apiId,
          typeName: 'Mutation',
          fieldName: 'markReadinessCheckVerified',
          dataSourceName: governanceUiLambdaDataSource.attrName,
          requestMappingTemplate: LAMBDA_REQUEST_MAPPING,
          responseMappingTemplate: LAMBDA_RESPONSE_MAPPING,
        },
      );
      markReadinessCheckVerifiedResolver.addDependency(
        governanceUiLambdaDataSource,
      );

      // Wave 3.C: 10th resolver — `publishGovernanceFinding` on the
      // Mutation type. The mutation is `@aws_iam` only; the resolver
      // performs an additional defence-in-depth identity check and
      // returns the input as-is so the @aws_subscribe-driven
      // `onGovernanceFinding` subscription receives the right shape.
      const publishGovernanceFindingResolver = new appsyncCfn.CfnResolver(
        this,
        'GovernanceUi_publishGovernanceFinding_Resolver',
        {
          apiId: props.appSyncApi.apiId,
          typeName: 'Mutation',
          fieldName: 'publishGovernanceFinding',
          dataSourceName: governanceUiLambdaDataSource.attrName,
          requestMappingTemplate: LAMBDA_REQUEST_MAPPING,
          responseMappingTemplate: LAMBDA_RESPONSE_MAPPING,
        },
      );
      publishGovernanceFindingResolver.addDependency(
        governanceUiLambdaDataSource,
      );

      // Wave 4.C.2: 11th, 12th, 13th Mutation-typed resolvers —
      // `addConstitutionalRule`, `updateConstitutionalRule`,
      // `deleteConstitutionalRule`. All three pipe through the same
      // governance UI Lambda data source; admin gating + the
      // acknowledgement check happen inside the resolver dispatch.
      const constitutionalRuleMutationFields: ReadonlyArray<string> = [
        'addConstitutionalRule',
        'updateConstitutionalRule',
        'deleteConstitutionalRule',
      ];
      for (const fieldName of constitutionalRuleMutationFields) {
        const resolver = new appsyncCfn.CfnResolver(
          this,
          `GovernanceUi_${fieldName}_Resolver`,
          {
            apiId: props.appSyncApi.apiId,
            typeName: 'Mutation',
            fieldName,
            dataSourceName: governanceUiLambdaDataSource.attrName,
            requestMappingTemplate: LAMBDA_REQUEST_MAPPING,
            responseMappingTemplate: LAMBDA_RESPONSE_MAPPING,
          },
        );
        resolver.addDependency(governanceUiLambdaDataSource);
      }

      // Wave 4.D.2: 14th, 15th, 16th Mutation-typed resolvers —
      // `revokeCaseLaw`, `unrevokeCaseLaw`, `updateCaseLawPrecedence`.
      // Same pattern as the constitutional rule editor: admin gating +
      // the verbatim acknowledgement check happen inside the resolver
      // dispatch. Each mutation is idempotent (revoke on an already-
      // revoked row no-ops with emittedEventDetailType=null).
      const caseLawMutationFields: ReadonlyArray<string> = [
        'revokeCaseLaw',
        'unrevokeCaseLaw',
        'updateCaseLawPrecedence',
      ];
      for (const fieldName of caseLawMutationFields) {
        const resolver = new appsyncCfn.CfnResolver(
          this,
          `GovernanceUi_${fieldName}_Resolver`,
          {
            apiId: props.appSyncApi.apiId,
            typeName: 'Mutation',
            fieldName,
            dataSourceName: governanceUiLambdaDataSource.attrName,
            requestMappingTemplate: LAMBDA_REQUEST_MAPPING,
            responseMappingTemplate: LAMBDA_RESPONSE_MAPPING,
          },
        );
        resolver.addDependency(governanceUiLambdaDataSource);
      }

      // Wave 4.E.A: 17th Query-typed resolver — `getAuthorityGraphHistorySettings`
      // (admin-only). Reads the SSM-backed settings + counts snapshots
      // within the retention window. Same Lambda data source as the
      // other governance UI reads.
      const getAuthorityGraphHistorySettingsResolver = new appsyncCfn.CfnResolver(
        this,
        'GovernanceUi_getAuthorityGraphHistorySettings_Resolver',
        {
          apiId: props.appSyncApi.apiId,
          typeName: 'Query',
          fieldName: 'getAuthorityGraphHistorySettings',
          dataSourceName: governanceUiLambdaDataSource.attrName,
          requestMappingTemplate: LAMBDA_REQUEST_MAPPING,
          responseMappingTemplate: LAMBDA_RESPONSE_MAPPING,
        },
      );
      getAuthorityGraphHistorySettingsResolver.addDependency(
        governanceUiLambdaDataSource,
      );

      // Wave 4.E.B: 18th + 19th Query-typed resolvers (admin-only) —
      // `listAuthorityGraphSnapshots` and `getAuthorityGraphSnapshot`.
      // Back the time scrubber on the governance Graph page; both are
      // read-only and pipe through the same governance UI Lambda data
      // source.
      const wave4EbQueryFields: ReadonlyArray<string> = [
        'listAuthorityGraphSnapshots',
        'getAuthorityGraphSnapshot',
      ];
      for (const fieldName of wave4EbQueryFields) {
        const resolver = new appsyncCfn.CfnResolver(
          this,
          `GovernanceUi_${fieldName}_Resolver`,
          {
            apiId: props.appSyncApi.apiId,
            typeName: 'Query',
            fieldName,
            dataSourceName: governanceUiLambdaDataSource.attrName,
            requestMappingTemplate: LAMBDA_REQUEST_MAPPING,
            responseMappingTemplate: LAMBDA_RESPONSE_MAPPING,
          },
        );
        resolver.addDependency(governanceUiLambdaDataSource);
      }

      // Wave 4.E.A: 17th Mutation-typed resolver —
      // `updateAuthorityGraphHistorySettings` (admin-only). Writes the
      // SSM blob and emits a governance.authority-graph-history.config.changed
      // audit event (best-effort).
      const updateAuthorityGraphHistorySettingsResolver = new appsyncCfn.CfnResolver(
        this,
        'GovernanceUi_updateAuthorityGraphHistorySettings_Resolver',
        {
          apiId: props.appSyncApi.apiId,
          typeName: 'Mutation',
          fieldName: 'updateAuthorityGraphHistorySettings',
          dataSourceName: governanceUiLambdaDataSource.attrName,
          requestMappingTemplate: LAMBDA_REQUEST_MAPPING,
          responseMappingTemplate: LAMBDA_RESPONSE_MAPPING,
        },
      );
      updateAuthorityGraphHistorySettingsResolver.addDependency(
        governanceUiLambdaDataSource,
      );

      // Wave 5.A: 27th Query-typed resolver — `getD4RetrospectiveReport`
      // (admin-only). Ports `arbiter/governance/d4_retrospective.py` to
      // an on-demand AppSync read with a 5-minute in-process cache.
      // Same Lambda + data source as the other governance UI reads;
      // no new IAM (the resolver Scans the existing governance ledger).
      const getD4RetrospectiveReportResolver = new appsyncCfn.CfnResolver(
        this,
        'GovernanceUi_getD4RetrospectiveReport_Resolver',
        {
          apiId: props.appSyncApi.apiId,
          typeName: 'Query',
          fieldName: 'getD4RetrospectiveReport',
          dataSourceName: governanceUiLambdaDataSource.attrName,
          requestMappingTemplate: LAMBDA_REQUEST_MAPPING,
          responseMappingTemplate: LAMBDA_RESPONSE_MAPPING,
        },
      );
      getD4RetrospectiveReportResolver.addDependency(
        governanceUiLambdaDataSource,
      );

      // Wave 5.C.1: 28th Query-typed resolver — `getTrustPath`
      // (admin-only). Computes the IAM assume chain (Lambda exec role
      // → optional cross-account role → scoped role) for a target
      // resource (datastore / integration / agent). Same Lambda + data
      // source as the other governance UI reads; the IAM Get* + STS
      // grants are attached to the Lambda role above.
      const getTrustPathResolver = new appsyncCfn.CfnResolver(
        this,
        'GovernanceUi_getTrustPath_Resolver',
        {
          apiId: props.appSyncApi.apiId,
          typeName: 'Query',
          fieldName: 'getTrustPath',
          dataSourceName: governanceUiLambdaDataSource.attrName,
          requestMappingTemplate: LAMBDA_REQUEST_MAPPING,
          responseMappingTemplate: LAMBDA_RESPONSE_MAPPING,
        },
      );
      getTrustPathResolver.addDependency(governanceUiLambdaDataSource);

      // Wave 5.C.1: 29th Query-typed resolver — `getResourceIamDrift`
      // (admin-only). Compares the recorded baseline IAM trust/policy
      // posture against the live IAM state for a target resource and
      // returns the diff. Same Lambda + data source as the other
      // governance UI reads; reuses the IAM Get* grants attached to
      // the Lambda role above.
      const getResourceIamDriftResolver = new appsyncCfn.CfnResolver(
        this,
        'GovernanceUi_getResourceIamDrift_Resolver',
        {
          apiId: props.appSyncApi.apiId,
          typeName: 'Query',
          fieldName: 'getResourceIamDrift',
          dataSourceName: governanceUiLambdaDataSource.attrName,
          requestMappingTemplate: LAMBDA_REQUEST_MAPPING,
          responseMappingTemplate: LAMBDA_RESPONSE_MAPPING,
        },
      );
      getResourceIamDriftResolver.addDependency(
        governanceUiLambdaDataSource,
      );
    }

    // ============================================================
    // Wave 4.E.A — authority graph history (snapshot infrastructure)
    // ============================================================
    //
    // Default OFF. Operators opt in via the settings card on the
    // governance Graph page. The SSM parameter below is provisioned
    // with the safe-default JSON so the read path always finds a
    // well-formed value; the resolver still tolerates a missing
    // parameter by returning the same defaults inline. The scheduled
    // Lambda (see below) reads this parameter and either skips early
    // (`enabled: false`) or scans the four authority source tables
    // and writes a snapshot row.
    //
    // The snapshots table uses RemovalPolicy.DESTROY because snapshots
    // are reproducible from the source tables — RETAIN here would
    // orphan storage that has no off-stack restore value. TTL via
    // `expiresAt` enforces the operator-selected retention window.

    new ssm.StringParameter(this, 'AuthorityGraphHistorySettingsParam', {
      parameterName: `/citadel/governance/authority-graph-history/${props.environment}`,
      stringValue: '{"enabled":false,"retentionDays":30,"captureMode":"daily"}',
      description:
        'Authority graph history settings (Wave 4.E.A). Default OFF. ' +
        'JSON shape: {enabled, retentionDays, captureMode}.',
    });

    const governanceGraphSnapshotFn = new lambda.Function(this, 'GovernanceGraphSnapshotFn', {
      runtime: lambda.Runtime.NODEJS_24_X,
      handler: 'governance-graph-snapshot.handler',
      code: lambda.Code.fromAsset('dist/lambda'),
      timeout: cdk.Duration.minutes(5),
      memorySize: 512,
      environment: {
        ENVIRONMENT: props.environment,
        AUTHORITY_GRAPH_HISTORY_PARAM: `/citadel/governance/authority-graph-history/${props.environment}`,
        AUTHORITY_UNITS_TABLE: this.authorityUnitsTable.tableName,
        COMPOSITION_CONTRACTS_TABLE: this.compositionContractsTable.tableName,
        CONSTITUTIONAL_LAYERS_TABLE: this.constitutionalLayersTable.tableName,
        CASE_LAW_TABLE: this.caseLawTable.tableName,
        GRAPH_SNAPSHOTS_TABLE: this.governanceGraphSnapshotsTable.tableName,
      },
      logGroup: new logs.LogGroup(this, 'GovernanceGraphSnapshotFnLogs', {
        retention: logs.RetentionDays.ONE_WEEK,
        removalPolicy: cdk.RemovalPolicy.DESTROY,
      }),
    });

    // SSM read scope — single exact ARN.
    governanceGraphSnapshotFn.addToRolePolicy(new iam.PolicyStatement({
      effect: iam.Effect.ALLOW,
      actions: ['ssm:GetParameter'],
      resources: [
        `arn:aws:ssm:${this.region}:${this.account}:parameter/citadel/governance/authority-graph-history/${props.environment}`,
      ],
    }));

    // DDB scans on the four source tables — read-only.
    this.authorityUnitsTable.grantReadData(governanceGraphSnapshotFn);
    this.compositionContractsTable.grantReadData(governanceGraphSnapshotFn);
    this.constitutionalLayersTable.grantReadData(governanceGraphSnapshotFn);
    this.caseLawTable.grantReadData(governanceGraphSnapshotFn);

    // DDB write on the snapshots table.
    this.governanceGraphSnapshotsTable.grantWriteData(governanceGraphSnapshotFn);

    // CloudWatch metrics — namespace narrowed in code; no resource-level
    // scoping is available for PutMetricData.
    governanceGraphSnapshotFn.addToRolePolicy(new iam.PolicyStatement({
      effect: iam.Effect.ALLOW,
      actions: ['cloudwatch:PutMetricData'],
      resources: ['*'],
    }));
    NagSuppressions.addResourceSuppressions(
      governanceGraphSnapshotFn.role!,
      [
        {
          id: 'AwsSolutions-IAM5',
          reason:
            'cloudwatch:PutMetricData has no resource-level scoping; the ' +
            'governance-graph-snapshot Lambda narrows the call to the ' +
            'Citadel/Governance/GraphSnapshot namespace.',
          appliesTo: ['Resource::*'],
        },
      ],
      true,
    );

    // EventBridge schedule rule firing daily at 03:00 UTC. Same
    // schedule pattern as governance-mode-refresher (event-driven), but
    // here we use a cron expression because there's no triggering event
    // — the snapshot is intrinsically time-based.
    const governanceGraphSnapshotSchedule = new events.Rule(this, 'GovernanceGraphSnapshotSchedule', {
      ruleName: `citadel-governance-graph-snapshot-${props.environment}`,
      description:
        'Triggers the governance-graph-snapshot Lambda daily at 03:00 UTC (Wave 4.E.A).',
      schedule: events.Schedule.cron({ hour: '3', minute: '0' }),
    });
    governanceGraphSnapshotSchedule.addTarget(
      new targets.LambdaFunction(governanceGraphSnapshotFn),
    );

    // ============================================================
    // Wave 4.E.A.2 — on-change snapshot Lambda (DDB streams → snapshot)
    // ============================================================
    //
    // Mirrors the scheduled GovernanceGraphSnapshotFn body but is
    // triggered by DynamoDB streams on the four authority source
    // tables (authorityUnits, compositionContracts, caseLaw,
    // constitutionalLayers) so a fresh snapshot row appears whenever
    // the authority graph mutates between the daily 03:00 UTC cron
    // runs. The scheduled Lambda continues to act as the
    // backfill/reconciliation path; this Lambda is purely the
    // change-driven path.
    //
    // Memory is 256MB (heavier than the 128MB fanout because the
    // handler runs four DynamoDB scans per invocation, lighter than
    // the 5-min schedule's 512MB because we don't backfill the full
    // history on each invocation). Timeout 1 minute is the upper
    // bound for four small scans.
    //
    // Filter criteria narrow the trigger to data-changing events
    // (INSERT / MODIFY / REMOVE). DynamoDB streams have no other
    // eventName values today, but explicit filtering future-proofs
    // against new event types and keeps the Lambda's invocation
    // count tied to actual graph mutations.

    const governanceGraphSnapshotOnChangeDLQ = new Queue(this, 'GovernanceGraphSnapshotOnChangeDLQ', {
      queueName: `citadel-governance-graph-snapshot-on-change-dlq-${props.environment}`,
      retentionPeriod: cdk.Duration.days(14),
      encryption: cdk.aws_sqs.QueueEncryption.SQS_MANAGED,
      enforceSSL: true,
    });
    // The DLQ is itself the dead-letter target for the four
    // EventSourceMappings; a DLQ for a DLQ would loop on its own
    // failures (same pattern as governanceFindingFanoutDLQ).
    NagSuppressions.addResourceSuppressions(
      governanceGraphSnapshotOnChangeDLQ,
      [
        {
          id: 'AwsSolutions-SQS3',
          reason:
            'This queue IS the dead-letter destination for the ' +
            'governance-graph-snapshot-on-change DDB stream ' +
            'EventSourceMappings (one per authority source table). ' +
            'A DLQ for a DLQ would loop on its own failures.',
        },
      ],
    );

    this.governanceGraphSnapshotOnChangeFn = new lambda.Function(this, 'GovernanceGraphSnapshotOnChangeFn', {
      functionName: `citadel-governance-graph-snapshot-on-change-${props.environment}`,
      runtime: lambda.Runtime.NODEJS_24_X,
      handler: 'governance-graph-snapshot-on-change.handler',
      code: lambda.Code.fromAsset('dist/lambda'),
      timeout: cdk.Duration.minutes(1),
      memorySize: 256,
      environment: {
        ENVIRONMENT: props.environment,
        GRAPH_SNAPSHOTS_TABLE: this.governanceGraphSnapshotsTable.tableName,
        AUTHORITY_UNITS_TABLE: this.authorityUnitsTable.tableName,
        COMPOSITION_CONTRACTS_TABLE: this.compositionContractsTable.tableName,
        CONSTITUTIONAL_LAYERS_TABLE: this.constitutionalLayersTable.tableName,
        CASE_LAW_TABLE: this.caseLawTable.tableName,
      },
      logGroup: new logs.LogGroup(this, 'GovernanceGraphSnapshotOnChangeFnLogs', {
        retention: logs.RetentionDays.ONE_WEEK,
        removalPolicy: cdk.RemovalPolicy.DESTROY,
      }),
    });
    const governanceGraphSnapshotOnChangeFn = this.governanceGraphSnapshotOnChangeFn;

    // SSM read scope — single exact ARN, mirrors the scheduled Lambda.
    governanceGraphSnapshotOnChangeFn.addToRolePolicy(new iam.PolicyStatement({
      effect: iam.Effect.ALLOW,
      actions: ['ssm:GetParameter'],
      resources: [
        `arn:aws:ssm:${this.region}:${this.account}:parameter/citadel/governance/authority-graph-history/${props.environment}`,
      ],
    }));

    // DDB scans on the four source tables — read-only.
    this.authorityUnitsTable.grantReadData(governanceGraphSnapshotOnChangeFn);
    this.compositionContractsTable.grantReadData(governanceGraphSnapshotOnChangeFn);
    this.constitutionalLayersTable.grantReadData(governanceGraphSnapshotOnChangeFn);
    this.caseLawTable.grantReadData(governanceGraphSnapshotOnChangeFn);

    // DDB write on the snapshots table.
    this.governanceGraphSnapshotsTable.grantWriteData(governanceGraphSnapshotOnChangeFn);

    // CloudWatch metrics — namespace narrowed in code; no resource-level
    // scoping is available for PutMetricData.
    governanceGraphSnapshotOnChangeFn.addToRolePolicy(new iam.PolicyStatement({
      effect: iam.Effect.ALLOW,
      actions: ['cloudwatch:PutMetricData'],
      resources: ['*'],
    }));
    NagSuppressions.addResourceSuppressions(
      governanceGraphSnapshotOnChangeFn.role!,
      [
        {
          id: 'AwsSolutions-IAM5',
          reason:
            'Two scoped wildcards on the on-change snapshot Lambda role: ' +
            '(1) cloudwatch:PutMetricData has no resource-level scoping; the ' +
            'handler narrows calls to the Citadel/Governance/GraphSnapshot ' +
            'namespace. (2) DynamoDB stream ARNs include a timestamp suffix ' +
            'that CFN cannot resolve at template time; the wildcards are ' +
            'bounded to the four authority source-table stream sub-resources ' +
            'via their tableArn prefixes, so no other table is reachable.',
          appliesTo: [
            'Resource::*',
            'Resource::<AuthorityUnitsTableC4FCD799.Arn>/stream/*',
            'Resource::<CompositionContractsTable03389A48.Arn>/stream/*',
            'Resource::<CaseLawTable6F50F1D2.Arn>/stream/*',
            'Resource::<ConstitutionalLayersTable20D1ED32.Arn>/stream/*',
          ],
        },
      ],
      true,
    );

    // DDB stream read permissions — one combined statement listing all
    // four source-table stream ARNs in the Resource array (mirrors the
    // governance-finding-fanout pattern at L1922 but bounded to four
    // table stream sub-resources rather than one). The /stream/*
    // suffix is unavoidable because the stream ARN includes a
    // timestamp suffix CFN cannot resolve at template time.
    governanceGraphSnapshotOnChangeFn.addToRolePolicy(new iam.PolicyStatement({
      effect: iam.Effect.ALLOW,
      actions: [
        'dynamodb:DescribeStream',
        'dynamodb:GetRecords',
        'dynamodb:GetShardIterator',
        'dynamodb:ListStreams',
      ],
      resources: [
        `${this.authorityUnitsTable.tableArn}/stream/*`,
        `${this.compositionContractsTable.tableArn}/stream/*`,
        `${this.caseLawTable.tableArn}/stream/*`,
        `${this.constitutionalLayersTable.tableArn}/stream/*`,
      ],
    }));

    // SendMessage on the DLQ — the EventSourceMappings need this for
    // their on-failure target.
    governanceGraphSnapshotOnChangeDLQ.grantSendMessages(governanceGraphSnapshotOnChangeFn);

    // Four EventSourceMappings — one per authority source table.
    // batchSize 100 + maxBatchingWindow 5s amortises Lambda cold starts
    // across small change bursts; retryAttempts 2 gives three total
    // attempts before the DLQ catches a permanently broken event.
    // Filter criteria use three separate FilterCriteria entries
    // (INSERT/MODIFY/REMOVE) because lambda.FilterRule has no .or()
    // helper — multiple filter entries are OR'd at the EventSourceMapping
    // level per the Lambda filter-criteria spec.
    new lambda.EventSourceMapping(this, 'GovernanceGraphSnapshotOnChangeAuthorityUnitsESM', {
      target: governanceGraphSnapshotOnChangeFn,
      eventSourceArn: this.authorityUnitsTable.tableStreamArn,
      startingPosition: lambda.StartingPosition.LATEST,
      batchSize: 100,
      maxBatchingWindow: cdk.Duration.seconds(5),
      retryAttempts: 2,
      onFailure: new cdk.aws_lambda_event_sources.SqsDlq(governanceGraphSnapshotOnChangeDLQ),
      filters: [
        lambda.FilterCriteria.filter({ eventName: lambda.FilterRule.isEqual('INSERT') }),
        lambda.FilterCriteria.filter({ eventName: lambda.FilterRule.isEqual('MODIFY') }),
        lambda.FilterCriteria.filter({ eventName: lambda.FilterRule.isEqual('REMOVE') }),
      ],
    });

    new lambda.EventSourceMapping(this, 'GovernanceGraphSnapshotOnChangeCompositionContractsESM', {
      target: governanceGraphSnapshotOnChangeFn,
      eventSourceArn: this.compositionContractsTable.tableStreamArn,
      startingPosition: lambda.StartingPosition.LATEST,
      batchSize: 100,
      maxBatchingWindow: cdk.Duration.seconds(5),
      retryAttempts: 2,
      onFailure: new cdk.aws_lambda_event_sources.SqsDlq(governanceGraphSnapshotOnChangeDLQ),
      filters: [
        lambda.FilterCriteria.filter({ eventName: lambda.FilterRule.isEqual('INSERT') }),
        lambda.FilterCriteria.filter({ eventName: lambda.FilterRule.isEqual('MODIFY') }),
        lambda.FilterCriteria.filter({ eventName: lambda.FilterRule.isEqual('REMOVE') }),
      ],
    });

    new lambda.EventSourceMapping(this, 'GovernanceGraphSnapshotOnChangeCaseLawESM', {
      target: governanceGraphSnapshotOnChangeFn,
      eventSourceArn: this.caseLawTable.tableStreamArn,
      startingPosition: lambda.StartingPosition.LATEST,
      batchSize: 100,
      maxBatchingWindow: cdk.Duration.seconds(5),
      retryAttempts: 2,
      onFailure: new cdk.aws_lambda_event_sources.SqsDlq(governanceGraphSnapshotOnChangeDLQ),
      filters: [
        lambda.FilterCriteria.filter({ eventName: lambda.FilterRule.isEqual('INSERT') }),
        lambda.FilterCriteria.filter({ eventName: lambda.FilterRule.isEqual('MODIFY') }),
        lambda.FilterCriteria.filter({ eventName: lambda.FilterRule.isEqual('REMOVE') }),
      ],
    });

    new lambda.EventSourceMapping(this, 'GovernanceGraphSnapshotOnChangeConstitutionalLayersESM', {
      target: governanceGraphSnapshotOnChangeFn,
      eventSourceArn: this.constitutionalLayersTable.tableStreamArn,
      startingPosition: lambda.StartingPosition.LATEST,
      batchSize: 100,
      maxBatchingWindow: cdk.Duration.seconds(5),
      retryAttempts: 2,
      onFailure: new cdk.aws_lambda_event_sources.SqsDlq(governanceGraphSnapshotOnChangeDLQ),
      filters: [
        lambda.FilterCriteria.filter({ eventName: lambda.FilterRule.isEqual('INSERT') }),
        lambda.FilterCriteria.filter({ eventName: lambda.FilterRule.isEqual('MODIFY') }),
        lambda.FilterCriteria.filter({ eventName: lambda.FilterRule.isEqual('REMOVE') }),
      ],
    });

    // ============================================================
    // Wave 3.A — governance-mode propagation refresher
    // ============================================================
    //
    // EventBridge-triggered Lambda that listens for the
    // `governance.mode.transition` event emitted by the Wave 2.E
    // setGovernanceMode resolver. On each event it bumps the
    // MODE_GENERATION env var on every governance-aware Lambda via
    // UpdateFunctionConfiguration, forcing AWS Lambda to recycle warm
    // containers as in-flight requests finish. Container recycling
    // typically completes within 1–3 minutes under traffic; new
    // invocations after UpdateFunctionConfiguration returns use the
    // bumped MODE_GENERATION env var (and therefore re-fetch the SSM
    // mode on first read) immediately.
    //
    // The function-name list is supplied via GOVERNANCE_AWARE_FUNCTIONS
    // (JSON-encoded array). For Wave 3.A the only governance-aware
    // Lambda reading governance-flag.ts is governance-ui-resolver
    // itself; subsequent waves (Supervisor / worker-wrapper /
    // fabricator etc.) will extend the list as they adopt the helper.
    //
    // See `.kiro/specs/governance-ui/waves-2-5-roadmap.md` §3.5 for the
    // design + acceptance criteria.

    const governanceModeRefresherFn = new lambda.Function(this, 'GovernanceModeRefresherFn', {
      runtime: lambda.Runtime.NODEJS_24_X,
      handler: 'governance-mode-refresher.handler',
      code: lambda.Code.fromAsset('dist/lambda'),
      timeout: cdk.Duration.seconds(60),
      environment: {
        ENVIRONMENT: props.environment,
        GOVERNANCE_AWARE_FUNCTIONS: JSON.stringify([
          // For Wave 3.A, the only Lambda reading governance-flag.ts is
          // governance-ui-resolver itself. As Supervisor /
          // worker-wrapper / fabricator etc. adopt the helper, add
          // their function names here.
          governanceUiResolverFn.functionName,
        ]),
      },
      logGroup: new logs.LogGroup(this, 'GovernanceModeRefresherFnLogs', {
        retention: logs.RetentionDays.ONE_WEEK,
        removalPolicy: cdk.RemovalPolicy.DESTROY,
      }),
    });

    // IAM: GetFunctionConfiguration + UpdateFunctionConfiguration scoped
    // to the exact ARNs of the governance-aware functions in the env-var
    // list above. As that list grows, add the corresponding ARNs here.
    governanceModeRefresherFn.addToRolePolicy(new iam.PolicyStatement({
      effect: iam.Effect.ALLOW,
      actions: [
        'lambda:GetFunctionConfiguration',
        'lambda:UpdateFunctionConfiguration',
      ],
      resources: [
        governanceUiResolverFn.functionArn,
        // TODO(Wave 3.B+): add additional governance-aware Lambda ARNs
        // here as they adopt governance-flag.ts (Supervisor,
        // worker-wrapper, fabricator, etc.) and are appended to the
        // GOVERNANCE_AWARE_FUNCTIONS env var above.
      ],
    }));

    // CloudWatch metrics — the Citadel/Governance/Refresher namespace
    // does not support resource-level scoping (PutMetricData has no
    // resource ARN). The action stays narrow because the resolver
    // emits only into this single namespace.
    governanceModeRefresherFn.addToRolePolicy(new iam.PolicyStatement({
      effect: iam.Effect.ALLOW,
      actions: ['cloudwatch:PutMetricData'],
      resources: ['*'],
    }));
    NagSuppressions.addResourceSuppressions(
      governanceModeRefresherFn.role!,
      [
        {
          id: 'AwsSolutions-IAM5',
          reason:
            'cloudwatch:PutMetricData has no resource-level scoping; the ' +
            'governance-mode-refresher Lambda narrows the call to the ' +
            'Citadel/Governance/Refresher namespace and only emits ' +
            'RefreshAttempt / RefreshSuccess / RefreshFailure counters.',
          appliesTo: ['Resource::*'],
        },
      ],
      true,
    );

    // EventBridge rule on the agent event bus — fires on every
    // governance.mode.transition event emitted by setGovernanceMode.
    const governanceModeTransitionRule = new events.Rule(this, 'GovernanceModeTransitionRule', {
      eventBus: props.agentEventBus,
      ruleName: `citadel-governance-mode-transition-${props.environment}`,
      description: 'Triggers the governance-mode-refresher Lambda on every governance.mode.transition event.',
      eventPattern: {
        source: ['citadel.governance'],
        detailType: ['governance.mode.transition'],
      },
    });
    governanceModeTransitionRule.addTarget(new targets.LambdaFunction(governanceModeRefresherFn));

    // ============================================================
    // Wave 3.C — governance-finding fanout (DDB stream → AppSync)
    // ============================================================
    //
    // PATH A (DynamoDB streams) was selected over PATH B (EventBridge
    // emission from the Python ledger writer). Rationale:
    //   * governanceLedgerTable previously had no stream; adding
    //     `StreamSpecification` is an in-place CFN update (NO
    //     Replacement: True) per AWS::DynamoDB::Table update behaviour.
    //     `cdk synth` is inspected at deploy time to confirm.
    //   * The Python ledger writer stays untouched — the DDB write is
    //     the single authoritative event and the stream guarantees
    //     at-least-once delivery without a parallel `put_events` call
    //     that could partially fail mid-write.
    //   * Best-effort by design: Lambda failures surface as
    //     `Citadel/Governance/Fanout/PublishFailure` counts but never
    //     redrive the stream — the ledger row is already durable and
    //     the next-page poll on the Ledger UI surfaces the same
    //     finding.
    //
    // The fanout Lambda has only two grants beyond default Lambda
    // execution: `appsync:GraphQL` on the single mutation field, and
    // `cloudwatch:PutMetricData` on `*` (CloudWatch metrics has no
    // resource-level scoping). The latter is documented with a
    // NagSuppression citing namespace narrowing.
    //
    // The DLQ catches the rare cases where the Lambda itself crashes
    // (timeout, OOM, init failure) before the handler even runs;
    // per-record failures inside the handler are absorbed by the
    // best-effort metric and never propagate.

    if (props.appSyncApi) {
      // Dead-letter queue for stream events that cannot reach the
      // Lambda (init failures, throttling beyond retries). Not for
      // per-record errors — those are absorbed inside the handler and
      // metricised on PublishFailure.
      const governanceFindingFanoutDLQ = new Queue(this, 'GovernanceFindingFanoutDLQ', {
        queueName: `citadel-governance-finding-fanout-dlq-${props.environment}`,
        retentionPeriod: cdk.Duration.days(14),
        encryption: cdk.aws_sqs.QueueEncryption.SQS_MANAGED,
        enforceSSL: true,
      });
      // The DLQ is itself the dead-letter target for the
      // EventSourceMapping; suppressing AwsSolutions-SQS3 here is the
      // standard pattern (a DLQ for a DLQ would create an infinite
      // failure regress and accomplish nothing).
      NagSuppressions.addResourceSuppressions(
        governanceFindingFanoutDLQ,
        [
          {
            id: 'AwsSolutions-SQS3',
            reason:
              'This queue IS the dead-letter destination for the ' +
              'governance-finding-fanout DDB stream EventSourceMapping. ' +
              'A DLQ for a DLQ would loop on its own failures.',
          },
        ],
      );

      const governanceFindingFanoutFn = new lambda.Function(this, 'GovernanceFindingFanoutFn', {
        runtime: lambda.Runtime.NODEJS_24_X,
        handler: 'governance-finding-fanout.handler',
        code: lambda.Code.fromAsset('dist/lambda'),
        timeout: cdk.Duration.seconds(30),
        // Keep the Lambda small — it only signs + posts a single GraphQL
        // mutation per record. 256MB handles up to ~10 INSERT records
        // per batch comfortably.
        memorySize: 256,
        environment: {
          ENVIRONMENT: props.environment,
          APPSYNC_ENDPOINT: props.appSyncApi.graphqlUrl,
        },
        logGroup: new logs.LogGroup(this, 'GovernanceFindingFanoutFnLogs', {
          retention: logs.RetentionDays.ONE_WEEK,
          removalPolicy: cdk.RemovalPolicy.DESTROY,
        }),
      });

      // appsync:GraphQL grant scoped to the single mutation field. The
      // ARN format `${apiArn}/types/Mutation/fields/<field>` is per
      // AppSync's IAM authorization spec — broader scopes (e.g. the
      // whole API arn) would let this Lambda call any other mutation,
      // which is unnecessary.
      governanceFindingFanoutFn.addToRolePolicy(new iam.PolicyStatement({
        effect: iam.Effect.ALLOW,
        actions: ['appsync:GraphQL'],
        resources: [
          `${props.appSyncApi.arn}/types/Mutation/fields/publishGovernanceFinding`,
        ],
      }));

      // CloudWatch PutMetricData has no resource-level scoping; the
      // Lambda narrows the call to a single namespace + metric name.
      governanceFindingFanoutFn.addToRolePolicy(new iam.PolicyStatement({
        effect: iam.Effect.ALLOW,
        actions: ['cloudwatch:PutMetricData'],
        resources: ['*'],
      }));
      NagSuppressions.addResourceSuppressions(
        governanceFindingFanoutFn.role!,
        [
          {
            id: 'AwsSolutions-IAM5',
            reason:
              'cloudwatch:PutMetricData has no resource-level scoping; the ' +
              'governance-finding-fanout Lambda narrows the call to the ' +
              'Citadel/Governance/Fanout namespace and only emits the ' +
              'PublishFailure counter.',
            appliesTo: ['Resource::*'],
          },
        ],
        true,
      );

      // DynamoDB stream → Lambda event source mapping. Filtered to
      // INSERT-only at the source level so MODIFY (TTL refresh, etc.)
      // and REMOVE (TTL expiry) events never reach the Lambda. BatchSize
      // 10 keeps cold-start overhead amortised; retryAttempts 2 is the
      // sweet spot — three total attempts before the DLQ catches a
      // permanently broken event.
      new lambda.EventSourceMapping(this, 'GovernanceFindingFanoutEventSourceMapping', {
        target: governanceFindingFanoutFn,
        eventSourceArn: this.governanceLedgerTable.tableStreamArn,
        startingPosition: lambda.StartingPosition.LATEST,
        batchSize: 10,
        retryAttempts: 2,
        onFailure: new cdk.aws_lambda_event_sources.SqsDlq(governanceFindingFanoutDLQ),
        // EventSourceMapping FilterCriteria narrows the trigger to INSERT
        // events only. The handler also defensively checks
        // record.eventName so a future filter-criteria change (e.g.
        // backfill replay) doesn't accidentally project a MODIFY/REMOVE
        // row.
        filters: [
          lambda.FilterCriteria.filter({ eventName: lambda.FilterRule.isEqual('INSERT') }),
        ],
      });

      // Grant the Lambda permission to read the DDB stream. CDK's
      // EventSourceMapping wires the trigger but does not implicitly
      // grant the read permission on the stream ARN — that requires
      // an explicit IAM statement.
      governanceFindingFanoutFn.addToRolePolicy(new iam.PolicyStatement({
        effect: iam.Effect.ALLOW,
        actions: [
          'dynamodb:DescribeStream',
          'dynamodb:GetRecords',
          'dynamodb:GetShardIterator',
          'dynamodb:ListStreams',
        ],
        resources: [
          `${this.governanceLedgerTable.tableArn}/stream/*`,
        ],
      }));
      // The /stream/* suffix is unavoidable: the stream ARN includes a
      // timestamp suffix (e.g. /stream/2026-05-19T...) that CFN does
      // not surface at template time. The wildcard is bounded to the
      // single ledger table's stream sub-resource — broader scopes
      // (e.g. account-wide dynamodb:GetRecords) are not granted.
      NagSuppressions.addResourceSuppressions(
        governanceFindingFanoutFn.role!,
        [
          {
            id: 'AwsSolutions-IAM5',
            reason:
              'DynamoDB stream ARNs include a timestamp suffix that CFN ' +
              'cannot resolve at template time. The wildcard is bounded ' +
              'to the governanceLedgerTable stream sub-resource via the ' +
              'tableArn prefix; no other table is reachable.',
            appliesTo: [
              'Resource::<GovernanceLedgerTable6CB53D06.Arn>/stream/*',
            ],
          },
        ],
        true,
      );

      // SendMessage on the DLQ — the EventSourceMapping needs this for
      // its on-failure target.
      governanceFindingFanoutDLQ.grantSendMessages(governanceFindingFanoutFn);
    }

  }
}