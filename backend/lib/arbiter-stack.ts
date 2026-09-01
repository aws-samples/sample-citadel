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
import * as appsync from "aws-cdk-lib/aws-appsync";
// Cfn L1 AppSync constructs — used cross-stack to attach a data source +
// resolvers to BackendStack's GraphQL API without creating those resources
// in BackendStack (which would force a stack dependency cycle, since the
// governance ledger table is owned here in ArbiterStack). Same pattern as
// governance-stack.ts.
import { aws_appsync as appsyncCfn } from "aws-cdk-lib";
import { PythonFunction } from "@aws-cdk/aws-lambda-python-alpha";
import { PolicyStatement, Effect } from "aws-cdk-lib/aws-iam";
import { Queue } from "aws-cdk-lib/aws-sqs";
import { SqsEventSource } from "aws-cdk-lib/aws-lambda-event-sources";
import { BlockPublicAccess, Bucket } from "aws-cdk-lib/aws-s3";
import { Construct } from "constructs";
import { NagSuppressions } from "cdk-nag";
import {
  attachAlarmDelivery,
  grantCloudWatchAlarmPublish,
  type AlarmDeliveryConfig,
} from "./alarm-delivery";
import * as path from "path";
import * as fs from "fs";

// Resolve the repo-root `arbiter/` directory regardless of whether this
// module is loaded from source (`backend/lib/`) via ts-jest or from the
// compiled output (`backend/dist/lib/`) via `node dist/bin/app.js`.
// The correct `arbiter/` directory is the one containing the `catalog/`
// subfolder (the shared Python layer source) — the sibling `arbiter/`
// that sometimes appears one level above the repo only holds unused
// stub `index.py` files and must NOT be selected.
function resolveArbiterRoot(startDir: string): string {
  const candidates = [
    path.join(startDir, "..", "..", "arbiter"), // source: backend/lib/ -> repo/arbiter
    path.join(startDir, "..", "..", "..", "arbiter"), // dist:   backend/dist/lib/ -> repo/arbiter
  ];
  for (const candidate of candidates) {
    if (fs.existsSync(path.join(candidate, "catalog"))) {
      return candidate;
    }
  }
  throw new Error(
    `Unable to locate repo-root arbiter/ directory from ${startDir}. ` +
      `Tried: ${candidates.join(", ")}`,
  );
}
const ARBITER_ROOT = resolveArbiterRoot(__dirname);

// ---------------------------------------------------------------------------
// Seed-module content digest (finding 588c7fb8)
// ---------------------------------------------------------------------------
// The seed custom resource (SeedAgentConfigResource, below) uploads agent
// module files from arbiter/seedConfig/ to the code bucket at
// agents/<filename> — today demo_echo_agent.py AND smoke_idempotency_agent.py
// (both ride this exact path), plus any future sibling module the seed handler
// uploads. Historically the custom resource's ONLY change-detection input was
// a hand-bumped `Version` string, so editing a module's SOURCE changed no
// custom-resource property: CloudFormation reported the resource unchanged and
// never re-invoked the handler, so a repository fix to a module never reached
// S3 (the module stayed at whatever bytes were last uploaded). This is the
// finding-588c7fb8 defect.
//
// Making a content digest of the seed source part of the custom resource's
// properties forces a re-upload on the next deploy whenever ANY seed source
// file changes. The digest uses CDK's own source-fingerprint primitive
// (cdk.FileSystem.fingerprint) — the same content-addressing CDK uses for
// AssetHashType.SOURCE assets (the established idiom in this stack, used by
// the PythonFunctions above) — over the WHOLE seedConfig directory, so the
// digest covers EVERY uploaded module file (not just one entry point) plus the
// handler itself. __pycache__/__tests__/*.pyc are excluded so byte-compiled
// caches and local test runs never churn the digest.
export const SEED_MODULE_FINGERPRINT_EXCLUDES: readonly string[] = [
  "__pycache__",
  "__tests__",
  "*.pyc",
];

export function computeSeedModuleDigest(seedConfigDir: string): string {
  return cdk.FileSystem.fingerprint(seedConfigDir, {
    exclude: [...SEED_MODULE_FINGERPRINT_EXCLUDES],
  });
}

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
  // Release-aware dispatch (this story): optional read-only handles on the
  // two release tables (both owned by BackendStack — see
  // backend-stack.ts's AgentReleasesTable / EnvironmentReleasePointersTable
  // construction sites) so the Supervisor and Step Runner Lambdas can
  // resolve the (org, agent, environment) pointer at dispatch time.
  // Optional because the release-resolution gate is forward-compatible —
  // when either table/prop is absent, the corresponding env var is simply
  // omitted and release_resolution.py's own table-name-unset check
  // resolves every lookup to NO_POINTER (see that module's docstring),
  // never a crash. GetItem/Query ONLY — see the grantReadData calls below;
  // neither Lambda is ever granted PutItem/UpdateItem/DeleteItem on either
  // table (the releases table must never gain a write grant beyond its
  // sole writer role in backend-stack.ts/governance-stack.ts, and the
  // pointer table's write grant is confined to the promotion resolver
  // there too).
  agentReleasesTable?: dynamodb.Table;
  environmentReleasePointersTable?: dynamodb.Table;
  // G3 — the named org seam for release-aware dispatch. resolve_release
  // resolves pointers for this single org per deployment
  // (RELEASE_DEFAULT_ORG_ID); the switch itself is RELEASE_DISPATCH_
  // ENVIRONMENT, derived from `environment` at synth time. Optional and
  // operator-provisioned (env/CDK context in bin/app.ts): when absent,
  // RELEASE_DEFAULT_ORG_ID is omitted and every resolve_release lookup
  // falls to NO_POINTER (see release_resolution.py) — never a crash.
  releaseDefaultOrgId?: string;
  /**
   * Shared platform alarm topic (`citadel-alarms-<env>`, owned by
   * BackendStack). The six operational Lambda/DLQ alarms below (Step Runner,
   * timeout watchdog, worker DLQ depth, supervisor, fabricator, worker error
   * rate) page to it. Optional so test paths that construct ArbiterStack in
   * isolation still synth; when absent, those alarms fall back to the
   * in-stack CMK-encrypted escalation topic so no alarm is ever left muted.
   */
  alarmTopic?: sns.ITopic;
  /**
   * Resolved alarm-delivery destination (email | slack | none) for the
   * CMK-encrypted escalation topic, resolved ONCE in bin/app.ts and passed
   * down (same pattern as BackendStack). Optional so tests synth without it;
   * absent is treated as 'none'.
   */
  alarmDelivery?: AlarmDeliveryConfig;
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

    this.orchestrationTable = new dynamodb.Table(this, "OrchestrationTable", {
      tableName: `citadel-agent-orchestration-${props.environment}`,
      partitionKey: {
        name: "orchestrationId",
        type: dynamodb.AttributeType.STRING,
      },
      billingMode: dynamodb.BillingMode.PAY_PER_REQUEST,
      removalPolicy: cdk.RemovalPolicy.DESTROY,
      pointInTimeRecoverySpecification: { pointInTimeRecoveryEnabled: true },
    });

    const workerStateTable = new dynamodb.Table(this, "WorkerStateTable", {
      tableName: `citadel-worker-state-${props.environment}`,
      partitionKey: { name: "requestId", type: dynamodb.AttributeType.STRING },
      billingMode: dynamodb.BillingMode.PAY_PER_REQUEST,
      removalPolicy: cdk.RemovalPolicy.DESTROY,
      pointInTimeRecoverySpecification: { pointInTimeRecoveryEnabled: true },
    });

    // Shared layer for arbiter root packages so all arbiter PythonFunctions
    // can `from catalog.registry_client import ...` and `from common.region
    // import ...`. The layer structures catalog/ at /opt/python/catalog/,
    // common/ at /opt/python/common/, and governance/ at
    // /opt/python/governance/ per the Python Lambda layer convention.
    //
    // governance/ was added for release-aware dispatch (this story): the
    // Step Runner's Lambda asset is `code.fromAsset(ARBITER_ROOT/stepRunner)`
    // ONLY (see StepRunnerFunction below) — unlike the Supervisor, which
    // widens `entry` to the arbiter/ root specifically so its own
    // `_load_governance_package()` can reach the sibling governance/
    // directory. Without this layer addition, executor.py's equivalent
    // dynamic governance-package loader would have nothing to load in a
    // deployed stepRunner Lambda, and its own fail-closed refusal (mirrors
    // the Supervisor's _GOVERNANCE_AVAILABLE gate) would fire on every
    // dispatch once RELEASE_DISPATCH_ENVIRONMENT is set. Bundled here
    // (rather than widening the Step Runner's own `code.fromAsset` root the
    // way the Supervisor does) because the layer is already the
    // established sharing mechanism between the Step Runner and the
    // catalog/common packages, and staging governance/ alongside them
    // keeps a single copy shared by every governance-aware Python Lambda
    // rather than duplicating the package per-function asset.
    const catalogLayer = new lambda.LayerVersion(this, "ArbiterCatalogLayer", {
      layerVersionName: `citadel-arbiter-catalog-${props.environment}`,
      code: lambda.Code.fromAsset(ARBITER_ROOT, {
        bundling: {
          image: lambda.Runtime.PYTHON_3_14.bundlingImage,
          command: [
            "bash",
            "-c",
            "mkdir -p /asset-output/python && cp -r /asset-input/catalog /asset-output/python/catalog && cp -r /asset-input/common /asset-output/python/common && cp -r /asset-input/governance /asset-output/python/governance",
          ],
        },
      }),
      compatibleRuntimes: [lambda.Runtime.PYTHON_3_14],
      description:
        "Shared arbiter Python packages (catalog: registry_client and utilities; " +
        "common: cross-region prefix helper; governance: release resolution + " +
        "grandfathering for release-aware dispatch).",
    });

    // --- Shared per-stack async DLQ (CIT-125 slice A) ----------------------
    // Function-level Lambda DeadLetterConfig, matching governance-notifier's
    // established shape — catches handler-throw drops that Lambda's
    // internal async retry exhausts, which an EventBridge target-level DLQ
    // cannot see. Every consumer Lambda defined in THIS stack sets
    // `deadLetterQueue: arbiterAsyncDlq`. Raw EventBridge envelope lands on
    // the queue so a redrive can re-publish it verbatim
    // (docs/runbooks/DLQ_REDRIVE.md, slice C). Declared before the first
    // consumer (supervisorLambda) since deadLetterQueue is a construction
    // prop, not settable post-construction.
    const arbiterAsyncDlq = new Queue(this, "ArbiterAsyncDlq", {
      queueName: `citadel-arbiter-async-dlq-${props.environment}`,
      retentionPeriod: cdk.Duration.days(14),
      encryption: cdk.aws_sqs.QueueEncryption.SQS_MANAGED,
      enforceSSL: true,
    });

    const supervisorLambda = new PythonFunction(this, "SupervisorAgent", {
      runtime: lambda.Runtime.PYTHON_3_14,
      // Widened to the arbiter/ root (rather than arbiter/supervisor/) so
      // the governance package and the common package — both siblings of
      // supervisor/ that `_load_governance_package()` and the
      // `from common.region import ...` line in arbiter/supervisor/index.py
      // resolve at runtime — are inside the bundling container's mounted
      // input dir and can be included in the asset directly. A prior
      // commandHooks.afterBundling approach tried to `cp -r
      // ${inputDir}/../governance` post-bundling, but only `entry` itself is
      // mounted into the Docker/Finch bundling container, so `../governance`
      // never existed there and every synth failed with
      // FailedToBundleAsset. assetExcludes below strips everything under
      // arbiter/ that the supervisor does not need at runtime, while
      // keeping supervisor/, governance/, and common/.
      entry: ARBITER_ROOT,
      index: "supervisor/index.py",
      handler: "handler",
      layers: [catalogLayer],
      bundling: {
        assetHashType: cdk.AssetHashType.SOURCE,
        assetExcludes: [
          "fabricator",
          "stepRunner",
          "workerWrapper",
          "activator",
          "seedConfig",
          "catalog",
          "__tests__",
          "__pycache__",
          "conftest.py",
          "*.md",
        ],
      },
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
        CODE_VERSION: "2", // Force Lambda code update
        ...(props.appsTable && { APPS_TABLE: props.appsTable.tableName }),
        ...(props.registryId && { REGISTRY_ID: props.registryId }),
        ...(props.registryId && { REGISTRY_ENABLED: "true" }),
        // Release-aware dispatch (this story): table names only, omitted
        // entirely when the tables aren't provisioned (forward-compatible
        // no-op — see ArbiterStackProps's agentReleasesTable/
        // environmentReleasePointersTable doc comment). G3: this stack now
        // ALSO sets RELEASE_DISPATCH_ENVIRONMENT (the feature switch,
        // uppercased to match EnvironmentLiteral / pointer SK) and
        // RELEASE_DEFAULT_ORG_ID (the named org seam) so each env's stack
        // resolves its OWN pointer set at dispatch time.
        ...(props.agentReleasesTable && {
          AGENT_RELEASES_TABLE: props.agentReleasesTable.tableName,
        }),
        ...(props.environmentReleasePointersTable && {
          ENVIRONMENT_RELEASE_POINTERS_TABLE:
            props.environmentReleasePointersTable.tableName,
          RELEASE_DISPATCH_ENVIRONMENT: props.environment.toUpperCase(),
        }),
        ...(props.releaseDefaultOrgId && {
          RELEASE_DEFAULT_ORG_ID: props.releaseDefaultOrgId,
        }),
      },
      initialPolicy: [
        new PolicyStatement({
          effect: Effect.ALLOW,
          actions: [
            "bedrock:InvokeModel",
            "bedrock:InvokeModelWithResponseStream",
          ],
          resources: [
            `arn:aws:bedrock:*::foundation-model/anthropic.claude-*`,
            `arn:aws:bedrock:*::foundation-model/amazon.*`,
            `arn:aws:bedrock:*:${this.account}:inference-profile/*`,
          ],
        }),
      ],
      deadLetterQueueEnabled: true,
      deadLetterQueue: arbiterAsyncDlq,
    });

    this.orchestrationTable.grantReadWriteData(supervisorLambda);
    props.agentEventBus.grantPutEventsTo(supervisorLambda);
    workerStateTable.grantReadWriteData(supervisorLambda);
    props.agentConfigTable.grantReadData(supervisorLambda);
    if (props.appsTable) {
      props.appsTable.grantReadData(supervisorLambda);
    }
    // Release-aware dispatch (this story): GetItem/Query ONLY. This floor
    // has been broken twice already in this story — grantReadData() never
    // grants Put/Update/Delete, and no other statement below adds them.
    // Do not widen this beyond grantReadData for either table.
    if (props.agentReleasesTable) {
      props.agentReleasesTable.grantReadData(supervisorLambda);
    }
    if (props.environmentReleasePointersTable) {
      props.environmentReleasePointersTable.grantReadData(supervisorLambda);
    }

    // Configurable model selection (read-only). The supervisor reads the
    // platform model-config + model-catalog tables to resolve its model via
    // the shared pure resolver, with a bulletproof fallback to its previous
    // default. Least privilege: grantReadData only — the supervisor never
    // writes these tables. Referenced by deterministic name via fromTableName
    // (owned elsewhere) to avoid a cross-stack construct dependency.
    const modelConfigTable = dynamodb.Table.fromTableName(
      this,
      "SupervisorModelConfigTableRef",
      `citadel-model-config-${props.environment}`,
    );
    const modelCatalogTable = dynamodb.Table.fromTableName(
      this,
      "SupervisorModelCatalogTableRef",
      `citadel-model-catalog-${props.environment}`,
    );
    modelConfigTable.grantReadData(supervisorLambda);
    modelCatalogTable.grantReadData(supervisorLambda);

    // CIT-125 slice B: event.id dedupe (at-least-once delivery + DLQ
    // redrive safety). Reuses the existing shared idempotency table
    // (BackendStack, `citadel-idempotency-${env}`, PK `eventId`, TTL attr
    // `ttl`) — no new table. Referenced by NAME (fromTableName), same
    // no-cross-stack-construct-dependency pattern as the model tables
    // immediately above, since ArbiterStack already depends on ServicesStack
    // which depends on BackendStack. Least privilege: RW only on this table
    // (PutItem for the claim, GetItem/UpdateItem not needed by the
    // supervisor's single-claim guard).
    const supervisorIdempotencyTable = dynamodb.Table.fromTableName(
      this,
      "SupervisorIdempotencyTableRef",
      `citadel-idempotency-${props.environment}`,
    );
    supervisorIdempotencyTable.grantReadWriteData(supervisorLambda);
    supervisorLambda.addEnvironment(
      "IDEMPOTENCY_TABLE",
      `citadel-idempotency-${props.environment}`,
    );

    // Grant Supervisor read-only access to Registry APIs so it can
    // resolve agent/app identifiers during orchestration. Full CRUD
    // stays on the Fabricator per least-privilege.
    if (props.registryArn) {
      supervisorLambda.addToRolePolicy(
        new PolicyStatement({
          effect: Effect.ALLOW,
          actions: [
            "bedrock-agentcore:GetRegistryRecord",
            "bedrock-agentcore:ListRegistryRecords",
          ],
          resources: [props.registryArn, `${props.registryArn}/*`],
        }),
      );
    }

    // SQS permissions are granted below after queue creation (see workerAgentQueue / fabricatorQueue grants)

    const taskRequestRule = new events.Rule(this, "TaskRequestRule", {
      eventBus: props.agentEventBus,
      eventPattern: {
        source: ["task.request"],
      },
    });

    const completionRule = new events.Rule(this, "TaskCompletionRule", {
      eventBus: props.agentEventBus,
      eventPattern: {
        source: ["task.completion"],
      },
    });

    taskRequestRule.addTarget(
      new targets.LambdaFunction(supervisorLambda, {
        // CIT-125 slice A: without retryProps, an undeliverable event sits
        // in EventBridge's default 24h/185-attempt retry storm before
        // ever reaching the DLQ. 2 attempts / 2h mirrors the cost-ledger
        // writer's retryProps (telemetry-stack.ts) — the same "reach the
        // DLQ in minutes, not a day" rationale, now applied to supervisor.
        retryAttempts: 2,
        maxEventAge: cdk.Duration.hours(2),
      }),
    );
    completionRule.addTarget(
      new targets.LambdaFunction(supervisorLambda, {
        retryAttempts: 2,
        maxEventAge: cdk.Duration.hours(2),
      }),
    );

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
    const credentialVenderLambda = new lambda.Function(
      this,
      "AgentCredentialVender",
      {
        runtime: lambda.Runtime.NODEJS_24_X,
        handler: "agent-credential-vender.handler",
        code: lambda.Code.fromAsset("dist/lambda"),
        timeout: cdk.Duration.seconds(30),
        memorySize: 256,
        environment: {
          ENVIRONMENT: props.environment,
        },
        initialPolicy: [
          new PolicyStatement({
            effect: Effect.ALLOW,
            actions: [
              "iam:CreateRole",
              "iam:DeleteRole",
              "iam:GetRole",
              "iam:PutRolePolicy",
              "iam:DeleteRolePolicy",
              "iam:TagRole",
            ],
            resources: [`arn:aws:iam::${this.account}:role/citadel-agent-*`],
          }),
          new PolicyStatement({
            effect: Effect.ALLOW,
            actions: ["sts:AssumeRole"],
            resources: [`arn:aws:iam::${this.account}:role/citadel-agent-*`],
          }),
          new PolicyStatement({
            effect: Effect.ALLOW,
            actions: ["sts:GetCallerIdentity"],
            resources: ["*"],
          }),
        ],
      },
    );

    // Tool-call idempotency ledger (PR1). Org-scoped, TTL'd operational
    // dedupe table — NOT an audit artifact (distinct from the 90-day
    // governance ledger). PK = orgId#executionId, SK =
    // nodeId#callIndex#toolName#argsHash. TTL (attribute `ttl`) is 48h,
    // derived server-side at write time by the worker; it exists to bound
    // storage, not to retain accountability records. Encrypted at rest with
    // an AWS-managed KMS key and PITR on.
    const toolExecutionLedgerTable = new dynamodb.Table(
      this,
      "ToolExecutionLedgerTable",
      {
        tableName: `citadel-tool-execution-ledger-${props.environment}`,
        partitionKey: { name: "pk", type: dynamodb.AttributeType.STRING },
        sortKey: { name: "sk", type: dynamodb.AttributeType.STRING },
        billingMode: dynamodb.BillingMode.PAY_PER_REQUEST,
        timeToLiveAttribute: "ttl",
        encryption: dynamodb.TableEncryption.AWS_MANAGED,
        pointInTimeRecoverySpecification: { pointInTimeRecoveryEnabled: true },
        // Deploy-safety (findings 7f42ae86 / 9c92a738): this is an operational
        // idempotency store (short TTL, not an audit artifact) — but its rows
        // are LIVE in-flight state, and a divergent-branch deploy that silently
        // DELETES the whole table would break idempotency guarantees for every
        // reservation currently inside its TTL window (the finding-9c92a738
        // DELETE_COMPLETE path). RETAIN + deletionProtection guard the TABLE;
        // the `ttl` attribute above still expires individual rows, so the
        // operational self-cleaning this store was designed around is
        // unchanged. This deliberately reverses the prior DESTROY intent per
        // the approved finding. Orphaned-table-on-re-add recovery (AlreadyExists
        // -> import or rename) is documented in docs/DEPLOYMENT.md.
        removalPolicy: cdk.RemovalPolicy.RETAIN,
        deletionProtection: true,
      },
    );

    // Per-target tool circuit-breaker state (task 28d624b1). One item per
    // external target (PK = orgId#targetKind#targetId, SK = "STATE"), so each
    // target is its own partition. Shared across the short-lived worker
    // subprocesses via conditional writes (single-prober HALF_OPEN lease,
    // stateVersion-guarded transitions). RETAIN + deletionProtection like the
    // ledger, but the justification is STRONGER: these rows are LIVE OPEN state
    // that concurrent workers depend on for the fast-fail — a silent
    // whole-table delete on a divergent-branch deploy would drop every OPEN
    // state and let the fleet stampede a known-bad target. The `ttl` attribute
    // still self-cleans idle rows, so RETAIN only blocks silent teardown, not
    // operational cleanup.
    const toolBreakerStateTable = new dynamodb.Table(
      this,
      "ToolBreakerStateTable",
      {
        tableName: `citadel-tool-breaker-state-${props.environment}`,
        partitionKey: { name: "pk", type: dynamodb.AttributeType.STRING },
        sortKey: { name: "sk", type: dynamodb.AttributeType.STRING },
        billingMode: dynamodb.BillingMode.PAY_PER_REQUEST,
        timeToLiveAttribute: "ttl",
        encryption: dynamodb.TableEncryption.AWS_MANAGED,
        pointInTimeRecoverySpecification: { pointInTimeRecoveryEnabled: true },
        removalPolicy: cdk.RemovalPolicy.RETAIN,
        deletionProtection: true,
      },
    );
    // Tool-result offload (PR2). Oversized tool results (> inline cap) are
    // offloaded here instead of being truncated, so a deduped/replayed caller
    // receives the FULL recorded body. Security condition C3: a dedicated CMK
    // (SSE-KMS enforced, non-KMS + wrong-key puts DENIED by the bucket policy
    // below, mirroring the governance-transcripts precedent), block-public,
    // TLS-only. Object keys are org/execution-prefixed
    // (tool-results/{orgId}/{executionId}/…) and the worker's grant is
    // prefix-scoped with NO cross-org path and NO DeleteObject; the stored
    // resultRef is additionally re-checked against the caller's org prefix on
    // read in tool_execution_ledger._fetch_result_ref. A short TTL keeps this
    // an operational store, not an audit artifact (matches the ledger table).
    const toolResultsKey = new kms.Key(this, "ToolResultsKey", {
      description: "Citadel tool-result offload bucket encryption key",
      enableKeyRotation: true,
      removalPolicy: cdk.RemovalPolicy.RETAIN,
      alias: `alias/citadel-tool-results-${props.environment}`,
    });
    const toolResultsBucket = new Bucket(this, "ToolResultsBucket", {
      bucketName: `citadel-tool-results-${props.environment}-${this.account}-${this.region}`,
      encryption: cdk.aws_s3.BucketEncryption.KMS,
      encryptionKey: toolResultsKey,
      bucketKeyEnabled: true,
      blockPublicAccess: BlockPublicAccess.BLOCK_ALL,
      enforceSSL: true,
      // Deploy-safety (findings 7f42ae86 / 9c92a738): oversized tool results
      // offloaded here are LIVE state referenced by not-yet-expired ledger
      // rows; a divergent-branch deploy that silently DELETES the bucket would
      // make those resultRefs unresolvable (the finding-9c92a738 path applied
      // to a bucket). RETAIN so the bucket survives stack teardown/reconcile.
      // S3 has no per-bucket deletionProtection flag; the KMS CMK above is
      // already RETAIN, so the objects stay decryptable. The 7-day lifecycle
      // rule below still expires individual objects, so this stays an
      // operational store — RETAIN only blocks silent whole-bucket teardown.
      // This deliberately reverses the prior DESTROY intent per the approved
      // finding; orphaned-bucket-on-re-add recovery is in docs/DEPLOYMENT.md.
      removalPolicy: cdk.RemovalPolicy.RETAIN,
      lifecycleRules: [
        {
          id: "tool-results-operational-ttl",
          enabled: true,
          expiration: cdk.Duration.days(7),
        },
      ],
    });
    // Deny any PutObject that is not SSE-KMS encrypted.
    toolResultsBucket.addToResourcePolicy(
      new iam.PolicyStatement({
        effect: iam.Effect.DENY,
        principals: [new iam.AnyPrincipal()],
        actions: ["s3:PutObject"],
        resources: [toolResultsBucket.arnForObjects("*")],
        conditions: {
          StringNotEquals: { "s3:x-amz-server-side-encryption": "aws:kms" },
        },
      }),
    );
    // Deny any PutObject that uses a different KMS key than our CMK.
    toolResultsBucket.addToResourcePolicy(
      new iam.PolicyStatement({
        effect: iam.Effect.DENY,
        principals: [new iam.AnyPrincipal()],
        actions: ["s3:PutObject"],
        resources: [toolResultsBucket.arnForObjects("*")],
        conditions: {
          StringNotEqualsIfExists: {
            "s3:x-amz-server-side-encryption-aws-kms-key-id":
              toolResultsKey.keyArn,
          },
        },
      }),
    );
    NagSuppressions.addResourceSuppressions(toolResultsBucket, [
      {
        id: "AwsSolutions-S1",
        reason:
          "Operational, short-TTL tool-result offload bucket (not an audit " +
          "artifact); server-access logging is not wired in the arbiter stack " +
          "(no shared access-logs bucket prop). Access is loopback of the " +
          "worker role only, prefix-scoped, and object keys are org-isolated.",
      },
    ]);

    // ------------------------------------------------------------------
    // Idempotency-seam smoke fixture — DIAGNOSTIC ONLY, non-prod exclusive.
    // ------------------------------------------------------------------
    // No existing conditional-resource-creation-by-environment pattern was
    // found anywhere in this CDK codebase (see the repo's operational-
    // lessons note on this task) — every other env-scoped construct here
    // varies a NAME by `props.environment` but is still created in every
    // environment. This block introduces the first "absent entirely in
    // prod" gate, on the stack's own `environment` prop, per this task's
    // instruction to gate on the stack's environment prop when no existing
    // pattern exists.
    //
    // A dedicated table (not a shared one) so the worker's smoke grant can
    // be scoped to exactly one ARN with exactly one action
    // (dynamodb:PutItem) — no Query/Scan/Update/Delete, no wildcard, and no
    // path that could reach any product table. Org-scoped partition key
    // (`orgId`) + TTL (`ttl`, 24h) so it self-cleans; this is an operational
    // smoke fixture, not an audit record (mirrors the tool-execution
    // ledger's TTL rationale). PAY_PER_REQUEST + DESTROY removal policy:
    // this table holds no data worth retaining past stack teardown.
    const isNonProdSmokeEnv = props.environment !== "prod";
    const smokeIdempotencyTable = isNonProdSmokeEnv
      ? new dynamodb.Table(this, "SmokeIdempotencyTable", {
          tableName: `citadel-smoke-idempotency-${props.environment}`,
          partitionKey: { name: "orgId", type: dynamodb.AttributeType.STRING },
          sortKey: { name: "markerId", type: dynamodb.AttributeType.STRING },
          billingMode: dynamodb.BillingMode.PAY_PER_REQUEST,
          timeToLiveAttribute: "ttl",
          encryption: dynamodb.TableEncryption.AWS_MANAGED,
          removalPolicy: cdk.RemovalPolicy.DESTROY,
        })
      : undefined;
    if (smokeIdempotencyTable) {
      NagSuppressions.addResourceSuppressions(smokeIdempotencyTable, [
        {
          id: "AwsSolutions-DDB3",
          reason:
            "Diagnostic, 24h-TTL'd smoke fixture holding no data worth " +
            "recovering (rows are freshly-uuid'd markers written by a " +
            "manual smoke run, never product data). PITR is unwarranted " +
            "for a table designed to self-clean; mirrors the accepted " +
            "tradeoff on the tool-execution ledger's own operational TTL " +
            "rationale. Non-prod only — never created in production.",
        },
      ]);
    }

    const workerAgentWrapperLambda = new PythonFunction(
      this,
      "WorkerAgentWrapper",
      {
        runtime: lambda.Runtime.PYTHON_3_14,
        entry: path.join(ARBITER_ROOT, "workerWrapper"),
        handler: "lambda_handler",
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
          // Write-then-signal (decision O2): the worker persists a completed
          // node's result to the executions table BEFORE emitting
          // workflow.node.completed. Env is set only when the executions table
          // is wired; the worker no-ops the durable write when it is absent.
          ...(props.executionsTable && {
            EXECUTIONS_TABLE: props.executionsTable.tableName,
          }),
          // Tool-call idempotency (PR1): the ledger the worker reserves/
          // finalizes tool executions against. Always wired; the worker's
          // idempotency hook is itself gated on per-node execution/node
          // context, so a missing key context is a back-compat no-op.
          TOOL_EXECUTION_LEDGER_TABLE: toolExecutionLedgerTable.tableName,
          // Tool-result offload (PR2): oversized results are written here
          // (SSE-KMS, org-prefixed) instead of being truncated; the worker
          // no-ops offload when unset and small results always stay inline.
          TOOL_RESULT_BUCKET: toolResultsBucket.bucketName,
          TOOL_RESULT_KMS_KEY_ID: toolResultsKey.keyArn,
          // Per-target circuit breaker (task 28d624b1). Table + tunables
          // delivered CDK -> function env -> build_subprocess_env -> worker
          // subprocess (NEVER the S3 tool module). Always wired; the breaker is
          // itself gated on a per-dispatch external-binding target map
          // (TOOL_BREAKER_TARGETS), so a dispatch with only local tools is a
          // no-op. THROTTLE is excluded from opening by default (D4) — it
          // surfaces as a distinct metric; TRANSIENT/TIMEOUT are the health
          // signals. Fail-open: if this table is unreachable the worker
          // proceeds (a breaker-store outage never becomes a fleet outage).
          TOOL_BREAKER_TABLE: toolBreakerStateTable.tableName,
          TOOL_BREAKER_FAILURE_THRESHOLD: "5",
          TOOL_BREAKER_WINDOW_SECONDS: "60",
          TOOL_BREAKER_RECOVERY_SECONDS: "30",
          TOOL_BREAKER_PROBE_LEASE_SECONDS: "30",
          TOOL_BREAKER_CACHE_TTL_SECONDS: "3",
          ...(props.registryId && { REGISTRY_ID: props.registryId }),
          ...(props.registryId && { REGISTRY_ENABLED: "true" }),
          // Idempotency-seam smoke fixture (non-prod only): the worker's
          // smoke tool refuses to run (raises, never silently no-ops) if
          // SMOKE_IDEMPOTENCY_TABLE is unset — so a prod deploy, which never
          // sets this var, structurally cannot write to a smoke table that
          // does not exist there.
          ...(smokeIdempotencyTable && {
            SMOKE_IDEMPOTENCY_TABLE: smokeIdempotencyTable.tableName,
          }),
        },
        initialPolicy: [
          new PolicyStatement({
            effect: Effect.ALLOW,
            actions: [
              "bedrock:InvokeModel",
              "bedrock:InvokeModelWithResponseStream",
            ],
            // Scoped to the same foundation models + inference profiles the
            // supervisor/fabricator are granted — never a blanket '*'. This keeps
            // the worker role's residual AwsSolutions-IAM5 suppression (below)
            // pointed ONLY at the unavoidable cloudwatch:PutMetricData /
            // sts:GetCallerIdentity Resource::*, not at Bedrock. These scoped
            // Bedrock ARNs are covered by the app-level IAM5 regex suppression
            // (foundation-model/*, inference-profile/*).
            resources: [
              `arn:aws:bedrock:*::foundation-model/anthropic.claude-*`,
              `arn:aws:bedrock:*::foundation-model/amazon.*`,
              `arn:aws:bedrock:*:${this.account}:inference-profile/*`,
            ],
          }),
        ],
      },
    );

    props.agentEventBus.grantPutEventsTo(workerAgentWrapperLambda);
    props.agentConfigTable.grantReadData(workerAgentWrapperLambda);
    props.codeBucket.grantRead(workerAgentWrapperLambda);
    credentialVenderLambda.grantInvoke(workerAgentWrapperLambda);
    // read-only access to ExecutionSpecifications for dispatch-time
    // status checks. Never written to from the worker.
    props.executionSpecificationsTable.grantReadData(workerAgentWrapperLambda);

    // Write-then-signal durable write (decision O2, HARD GATE). The worker's
    // access to the executions table is deliberately NOT a bare
    // grantWriteData (which would grant Put/Delete/BatchWrite on every
    // attribute — a full multi-tenant read/write/delete blast radius if the
    // worker, which runs untrusted/semi-trusted agent bodies, is compromised).
    // Instead it is:
    //   * ACTION-SCOPED to dynamodb:UpdateItem ONLY (no Put/Delete/BatchWrite).
    //   * ATTRIBUTE-SCOPED via FGAC (dynamodb:Attributes) to the nodeResults
    //     map + the executionId key. nodeResults is a TOP-LEVEL attribute and
    //     DynamoDB FGAC scopes at the top level, so this STRUCTURALLY prevents
    //     the worker from ever writing execution-level status / orgId / output
    //     / error / runId — even a fully compromised worker cannot flip an
    //     execution's status or cross into another tenant's execution fields.
    //   * ReturnValues-restricted so the worker cannot exfiltrate other
    //     attributes via ALL_OLD/ALL_NEW.
    // The application-level ConditionExpression (status <> completed) is a
    // correctness first-write-wins guard, NOT a security boundary (a
    // compromised worker can omit it) — the IAM narrowing above is the boundary.
    // Residual (accepted, documented): the worker can still write SOME node's
    // nodeResults on any execution (item-level LeadingKeys pinning is not
    // possible since it handles arbitrary executions); a per-dispatch scoped
    // STS session keyed to the executionId is the follow-up to close that.
    if (props.executionsTable) {
      workerAgentWrapperLambda.addToRolePolicy(
        new iam.PolicyStatement({
          effect: iam.Effect.ALLOW,
          actions: ["dynamodb:UpdateItem"],
          resources: [props.executionsTable.tableArn],
          conditions: {
            "ForAllValues:StringEquals": {
              "dynamodb:Attributes": ["nodeResults", "executionId"],
            },
            StringEqualsIfExists: {
              "dynamodb:ReturnValues": ["NONE", "UPDATED_NEW", "UPDATED_OLD"],
            },
          },
        }),
      );
      // PR2 dispatch-generation fence: the tool-call reserve is a
      // TransactWriteItems that Puts the ledger row AND performs a
      // ConditionCheck on this execution row's
      // nodeResults.<nodeId>.dispatchGeneration in the SAME atomic write
      // (security condition C2 — the guard is in the reserve's condition, no
      // read-then-check TOCTOU window). ConditionCheck is a read-only
      // condition (no write), scoped to the same nodeResults/executionId
      // attributes as the UpdateItem grant above — it does not widen the
      // worker's write surface.
      workerAgentWrapperLambda.addToRolePolicy(
        new iam.PolicyStatement({
          effect: iam.Effect.ALLOW,
          actions: ["dynamodb:ConditionCheckItem"],
          resources: [props.executionsTable.tableArn],
          conditions: {
            "ForAllValues:StringEquals": {
              "dynamodb:Attributes": ["nodeResults", "executionId"],
            },
          },
        }),
      );
      // Tool-call idempotency (PR1) server-side org resolution: the worker
      // reads the execution row (exact-key GetItem on executionId) to resolve
      // orgId SERVER-SIDE — the ledger PK prefix and cross-org isolation seam,
      // which the design REQUIRES be read from the trusted row and NEVER taken
      // from the subprocess-supplied dispatch payload (see
      // _resolve_execution_org_id in arbiter/workerWrapper/index.py). Without
      // this the read AccessDenied'd (idempotency_org_resolve_failed in the
      // first real smoke run). This is a DISTINCT, READ-ONLY statement scoped
      // to this one table ARN — it deliberately does NOT touch, widen, or
      // relax the UpdateItem / ConditionCheckItem FGAC statements above (which
      // remain attribute-scoped to nodeResults/executionId). No wildcard, no
      // Query/Scan — exact-key GetItem only, the minimum org resolution needs.
      workerAgentWrapperLambda.addToRolePolicy(
        new iam.PolicyStatement({
          effect: iam.Effect.ALLOW,
          actions: ["dynamodb:GetItem"],
          resources: [props.executionsTable.tableArn],
        }),
      );
    }

    // Tool-call idempotency (PR1): least-privilege grant on the tool-execution
    // ledger. The worker reserves (conditional PutItem), reads recorded
    // results (GetItem), and finalizes/releases/reclaims (UpdateItem). It is
    // DELIBERATELY NOT grantReadWriteData: no dynamodb:DeleteItem (release is a
    // status transition, not a delete) and no dynamodb:Scan/Query (all access
    // is by exact key). Scoped to this one table ARN.
    workerAgentWrapperLambda.addToRolePolicy(
      new iam.PolicyStatement({
        effect: iam.Effect.ALLOW,
        actions: [
          "dynamodb:PutItem",
          "dynamodb:GetItem",
          "dynamodb:UpdateItem",
        ],
        resources: [toolExecutionLedgerTable.tableArn],
      }),
    );

    // Per-target circuit breaker (task 28d624b1): least-privilege grant on the
    // breaker-state table. The worker reads state (GetItem), and transitions it
    // via conditional writes (PutItem/UpdateItem). DELIBERATELY NOT
    // grantReadWriteData: NO dynamodb:DeleteItem (transitions are conditional
    // updates; the `ttl` attribute handles row expiry, mirroring the ledger
    // grant) and NO dynamodb:Scan/Query (all access is by exact key). Scoped to
    // this one table ARN, as a DISTINCT statement.
    workerAgentWrapperLambda.addToRolePolicy(
      new iam.PolicyStatement({
        effect: iam.Effect.ALLOW,
        actions: [
          "dynamodb:PutItem",
          "dynamodb:GetItem",
          "dynamodb:UpdateItem",
        ],
        resources: [toolBreakerStateTable.tableArn],
      }),
    );

    // Tool-result offload (PR2), least-privilege: PutObject + GetObject on the
    // tool-results/* prefix ONLY — no DeleteObject, no cross-bucket, no
    // ListBucket. Per-org isolation is by the org/execution key prefix plus
    // the read-time resultRef org re-check in the ledger; a per-dispatch scoped
    // STS session pinning a single org prefix is the follow-up to close the
    // residual (mirrors the executions-table item-level pinning note above).
    workerAgentWrapperLambda.addToRolePolicy(
      new iam.PolicyStatement({
        effect: iam.Effect.ALLOW,
        actions: ["s3:PutObject", "s3:GetObject"],
        resources: [toolResultsBucket.arnForObjects("tool-results/*")],
      }),
    );

    // Idempotency-seam smoke fixture, least-privilege: dynamodb:PutItem
    // ONLY on the one dedicated smoke table — no GetItem/Query/Scan/
    // UpdateItem/DeleteItem, no wildcard. The smoke tool never reads back
    // its own writes (a manual smoke check reads the table via the console/
    // CLI under an operator's own credentials, never the worker role), so
    // Put-only is sufficient and strictly narrower than the ledger grant
    // above. Only wired at all when the table exists (non-prod).
    if (smokeIdempotencyTable) {
      workerAgentWrapperLambda.addToRolePolicy(
        new iam.PolicyStatement({
          effect: iam.Effect.ALLOW,
          actions: ["dynamodb:PutItem"],
          resources: [smokeIdempotencyTable.tableArn],
        }),
      );
    }
    // SSE-KMS on the offload bucket needs GenerateDataKey (put) + Decrypt (get)
    // on the CMK. grantEncryptDecrypt covers both; scoped to this one key.
    toolResultsKey.grantEncryptDecrypt(workerAgentWrapperLambda);

    // The worker emits best-effort node-level metrics (NodeDurationMs /
    // NodeFailure) into the Citadel/Workflows namespace after running each
    // workflow node. PutMetricData has no resource-level scoping; the call is
    // narrowed to that namespace in code.
    workerAgentWrapperLambda.addToRolePolicy(
      new iam.PolicyStatement({
        effect: iam.Effect.ALLOW,
        actions: ["cloudwatch:PutMetricData"],
        resources: ["*"],
      }),
    );
    NagSuppressions.addResourceSuppressions(
      workerAgentWrapperLambda.role!,
      [
        {
          id: "AwsSolutions-IAM5",
          reason:
            "cloudwatch:PutMetricData has no resource-level scoping; the " +
            "worker narrows the call to the Citadel/Workflows namespace " +
            "(node duration/failure metrics).",
          appliesTo: ["Resource::*"],
        },
        {
          id: "AwsSolutions-IAM5",
          reason:
            "Tool-result offload (PR2): the worker Put/Get is scoped to the " +
            "tool-results/* key prefix of the dedicated offload bucket only " +
            "(no DeleteObject, no ListBucket, no cross-bucket). The object-path " +
            "prefix wildcard (Resource::<bucket.Arn>/tool-results/*) is " +
            "suppressed at the app level (bin/app.ts appLambdaSuppressions); " +
            "per-org isolation is enforced by the org key prefix plus the " +
            "read-time resultRef org re-check.",
          appliesTo: ["Action::s3:GetObject", "Action::s3:PutObject"],
        },
        {
          id: "AwsSolutions-IAM5",
          reason:
            "SSE-KMS on the tool-results offload bucket requires the AWS SDK " +
            "GenerateDataKey*/ReEncrypt* wildcard actions on the single " +
            "dedicated CMK (grantEncryptDecrypt), scoped to that key only.",
          appliesTo: ["Action::kms:GenerateDataKey*", "Action::kms:ReEncrypt*"],
        },
      ],
      true,
    );

    // Grant IAM permissions for PolicyManager (agent scope)
    workerAgentWrapperLambda.addToRolePolicy(
      new PolicyStatement({
        effect: Effect.ALLOW,
        actions: [
          "iam:CreateRole",
          "iam:DeleteRole",
          "iam:GetRole",
          "iam:PutRolePolicy",
          "iam:DeleteRolePolicy",
          "iam:TagRole",
        ],
        resources: [`arn:aws:iam::${this.account}:role/citadel-agent-*`],
      }),
    );

    // Grant STS permissions for PolicyManager (agent scope)
    workerAgentWrapperLambda.addToRolePolicy(
      new PolicyStatement({
        effect: Effect.ALLOW,
        actions: ["sts:AssumeRole"],
        resources: [`arn:aws:iam::${this.account}:role/citadel-agent-*`],
      }),
    );
    workerAgentWrapperLambda.addToRolePolicy(
      new PolicyStatement({
        effect: Effect.ALLOW,
        actions: ["sts:GetCallerIdentity"],
        resources: ["*"],
      }),
    );

    // Grant WorkerAgentWrapper read-only access to Registry APIs so it
    // can resolve agent/app identifiers at dispatch time. Full CRUD
    // stays on the Fabricator per least-privilege.
    if (props.registryArn) {
      workerAgentWrapperLambda.addToRolePolicy(
        new PolicyStatement({
          effect: Effect.ALLOW,
          actions: [
            "bedrock-agentcore:GetRegistryRecord",
            "bedrock-agentcore:ListRegistryRecords",
          ],
          resources: [props.registryArn, `${props.registryArn}/*`],
        }),
      );
    }

    workerAgentWrapperLambda.addEventSource(
      new SqsEventSource(workerAgentQueue, {
        batchSize: 1, // Process one message at a time
        reportBatchItemFailures: true, // Enable partial batch responses
      }),
    );

    const toolsConfigTable = new dynamodb.Table(this, "ToolsConfigTable", {
      tableName: `citadel-tools-${props.environment}`,
      partitionKey: { name: "toolId", type: dynamodb.AttributeType.STRING },
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

    const fabricatorLambda = new PythonFunction(this, "FabricatorAgent", {
      runtime: lambda.Runtime.PYTHON_3_14,
      entry: path.join(ARBITER_ROOT, "fabricator"),
      handler: "lambda_handler",
      layers: [catalogLayer],
      bundling: { assetHashType: cdk.AssetHashType.SOURCE },
      // Platform max reached — Lambda's hard cap is 900s (15 min): verified
      // against the installed generated service models (aws-cdk-lib 2.261.0
      // lambda.generated.d.ts and @aws-sdk/client-lambda 3.1071.0
      // models_0.d.ts: "The maximum allowed value is 900 seconds"). Do not
      // raise. Headroom is owned by the runtime deadline guard
      // (arbiter/fabricator/deadline.py, 60s safety margin); worst observed
      // successful build is 748s.
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
        CODE_VERSION: "2", // Force Lambda code update
        // QT3-6: fabrication-time spec status validation.
        EXECUTION_SPECS_TABLE: props.executionSpecificationsTable.tableName,
        // fabrication-time design-assessment precondition.
        // Empty-string fallback keeps the gate's no-op path active when
        // the table is not provisioned in a given environment.
        AGENT_DESIGN_ASSESSMENTS_TABLE:
          props.agentDesignAssessmentsTable?.tableName ?? "",
        // Phase 3 Step 2: enables the synchronous AppsTable #META mirror
        // write inside store_agent_config_registry. listApps reads from
        // AppsTable.OrgIndex, so without this env var fabricated agents
        // would only become visible after the reconciler runs.
        ...(props.appsTable && { APPS_TABLE: props.appsTable.tableName }),
        ...(props.registryId && { REGISTRY_ID: props.registryId }),
        ...(props.registryId && { REGISTRY_ENABLED: "true" }),
      },
      initialPolicy: [
        new PolicyStatement({
          effect: Effect.ALLOW,
          actions: [
            "bedrock:InvokeModel",
            "bedrock:InvokeModelWithResponseStream",
          ],
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
    const fabricatorModelConfigTable = dynamodb.Table.fromTableName(
      this,
      "FabricatorModelConfigTableRef",
      `citadel-model-config-${props.environment}`,
    );
    const fabricatorModelCatalogTable = dynamodb.Table.fromTableName(
      this,
      "FabricatorModelCatalogTableRef",
      `citadel-model-catalog-${props.environment}`,
    );
    fabricatorModelConfigTable.grantReadData(fabricatorLambda);
    fabricatorModelCatalogTable.grantReadData(fabricatorLambda);

    // CIT-125 slice B: dedupe on message id (at-least-once delivery + DLQ
    // redrive safety). Reuses the same shared idempotency table as the
    // supervisor (BackendStack, `citadel-idempotency-${env}`) — no new
    // table. Referenced by NAME, construct id Fabricator-prefixed so it
    // doesn't collide with SupervisorIdempotencyTableRef. Least privilege:
    // RW only on this table — the fabricator's two-phase claim needs
    // PutItem (claim), GetItem (resolve PENDING vs DONE on a duplicate),
    // and UpdateItem (promote to DONE).
    const fabricatorIdempotencyTable = dynamodb.Table.fromTableName(
      this,
      "FabricatorIdempotencyTableRef",
      `citadel-idempotency-${props.environment}`,
    );
    fabricatorIdempotencyTable.grantReadWriteData(fabricatorLambda);
    fabricatorLambda.addEnvironment(
      "IDEMPOTENCY_TABLE",
      `citadel-idempotency-${props.environment}`,
    );

    // PutItem/UpdateItem on the durable fabrication-jobs table (owned by
    // BackendStack) so the consumer can upsert PROCESSING/COMPLETED/FAILED
    // status. Referenced by deterministic name + constructed ARN — importing
    // the BackendStack table construct here would create a circular dependency
    // (ArbiterStack already depends ON ServicesStack which depends ON
    // BackendStack). Least privilege: PutItem + UpdateItem only.
    fabricatorLambda.addToRolePolicy(
      new PolicyStatement({
        effect: Effect.ALLOW,
        actions: ["dynamodb:PutItem", "dynamodb:UpdateItem"],
        resources: [
          `arn:aws:dynamodb:${this.region}:${this.account}:table/citadel-fabrication-jobs-${props.environment}`,
        ],
      }),
    );

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
            "bedrock-agentcore:CreateRegistryRecord",
            "bedrock-agentcore:UpdateRegistryRecord",
            "bedrock-agentcore:UpdateRegistryRecordStatus",
            "bedrock-agentcore:SubmitRegistryRecordForApproval",
            "bedrock-agentcore:DeleteRegistryRecord",
            "bedrock-agentcore:GetRegistryRecord",
            "bedrock-agentcore:ListRegistryRecords",
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
    fabricatorLambda.addEventSource(
      new SqsEventSource(fabricatorQueue, { batchSize: 1 }),
    );

    // Grant scoped SQS permissions to Supervisor (S-02 fix)
    supervisorLambda.addToRolePolicy(
      new PolicyStatement({
        effect: Effect.ALLOW,
        actions: ["sqs:SendMessage", "sqs:ReceiveMessage", "sqs:DeleteMessage"],
        resources: [workerAgentQueue.queueArn, fabricatorQueue.queueArn],
      }),
    );

    // Seed initial agent configuration
    const seedAgentConfigLambda = new lambda.Function(
      this,
      "SeedAgentConfigFunction",
      {
        runtime: lambda.Runtime.PYTHON_3_14,
        handler: "index.handler",
        code: lambda.Code.fromAsset(path.join(ARBITER_ROOT, "seedConfig")),
        // Catalog layer so the seed can `from catalog.registry_client import
        // list_agent_records` for the demo agent registry-record idempotency
        // lookup (the seed degrades to DDB-only seeding when unavailable).
        layers: [catalogLayer],
        timeout: cdk.Duration.seconds(30),
        environment: {
          AGENT_CONFIG_TABLE: props.agentConfigTable.tableName,
          WORKER_QUEUE_URL: workerAgentQueue.queueUrl,
          FABRICATOR_QUEUE_URL: fabricatorQueue.queueUrl,
          // Lets the seed upload the runnable demo agent module to the code
          // bucket so the seeded agent config's ``filename`` is reachable.
          AGENT_BUCKET_NAME: props.codeBucket.bucketName,
          // Dual-store agent seam: the seed also creates the demo agent's
          // AgentCore Registry record (the app-publish readiness gate resolves
          // agents by name in the registry). Same conditional pattern as the
          // fabricator — unset in registry-less environments, where the seed
          // logs and skips the registry write.
          ...(props.registryId && { REGISTRY_ID: props.registryId }),
          ...(props.registryId && { REGISTRY_ENABLED: "true" }),
          // Idempotency-seam smoke agent (non-prod only): gates whether the
          // seed writes the diagnostic smoke-idempotency-agent row at all.
          // A prod deploy leaves this unset, and the seed's own
          // SMOKE_FIXTURES_ENABLED check (arbiter/seedConfig/index.py) skips
          // the whole block.
          ...(isNonProdSmokeEnv && { SMOKE_FIXTURES_ENABLED: "true" }),
        },
      },
    );

    props.agentConfigTable.grantWriteData(seedAgentConfigLambda);

    // Minimal registry surface for the demo-agent record seed: the seed path
    // calls ONLY ListRegistryRecords (idempotency lookup via
    // catalog.registry_client.list_agent_records) and CreateRegistryRecord.
    // No status/update/delete APIs — the record is left in its post-create
    // DRAFT status, mirroring fabricator-created records. Scoped to the
    // registry ARN like the fabricator's grant, and only wired when a
    // registry is provisioned.
    if (props.registryArn) {
      seedAgentConfigLambda.addToRolePolicy(
        new PolicyStatement({
          effect: Effect.ALLOW,
          actions: [
            "bedrock-agentcore:CreateRegistryRecord",
            "bedrock-agentcore:ListRegistryRecords",
          ],
          resources: [props.registryArn, `${props.registryArn}/*`],
        }),
      );
      // Same residual wildcard as every other registry-wired role (see the
      // registryArnSuppression list in bin/app.ts): AgentCore registry
      // operations require <registryArn>/* for record sub-resources. Scoped
      // to exactly that form via appliesTo regex.
      NagSuppressions.addResourceSuppressions(
        seedAgentConfigLambda.role!,
        [
          {
            id: "AwsSolutions-IAM5",
            reason:
              "AgentCore registry record create/list requires wildcard on " +
              "registry ARN sub-resources (records). Scoped to the specific " +
              "registry ARN; mirrors the registryArnSuppression applied to " +
              "the fabricator/supervisor roles in bin/app.ts.",
            appliesTo: [
              {
                regex: "/^Resource::<AgentCoreRegistry\\.RegistryArn>\\/\\*$/g",
              },
            ],
          },
        ],
        true,
      );
    }
    // PutObject only — the seed writes the demo agent module, never reads or
    // deletes from the code bucket. Path-scoped to the agents/* object-key
    // prefix: the seed only writes agents/demo_echo_agent.py, so it never needs
    // write access anywhere else in the bucket.
    props.codeBucket.grantPut(seedAgentConfigLambda, "agents/*");
    // The agents/* object-key prefix is the residual (and unavoidable) S3
    // resource wildcard — you cannot PutObject without a key. The app-level
    // IAM5 suppression covers a bucket-wide <Arn>/* but not this narrower
    // <Arn>/agents/* form, so scope the residual suppression to exactly the
    // agents/* prefix here. (The s3:PutObject*/Abort* action wildcards are
    // already covered by the app-level action suppression.)
    NagSuppressions.addResourceSuppressions(
      seedAgentConfigLambda.role!,
      [
        {
          id: "AwsSolutions-IAM5",
          reason:
            "Seed S3 write is path-scoped to agents/* (writes only " +
            "agents/demo_echo_agent.py). The residual wildcard is the object-key " +
            "prefix inherent to any S3 PutObject; no bucket-wide or cross-prefix " +
            "write is granted.",
          appliesTo: [{ regex: "/^Resource::<.+\\.Arn>\\/agents\\/\\*$/g" }],
        },
      ],
      true,
    );

    // Invoke the Custom Resource to seed agent config table
    // This must come after fabricatorQueue is created since we pass its URL.
    // Bumped Version v1.3.0 → v1.4.0 so the CFN Update event fires on the
    // next non-prod deploy and the diagnostic smoke-idempotency-agent (gated
    // on SMOKE_FIXTURES_ENABLED) is seeded in existing non-prod environments.
    //
    // finding 588c7fb8: the change-detection inputs are now TWO levers:
    //   * `Version` — a manual lever (bump to force a re-seed even when no
    //     source changed, e.g. to re-run a seed after an out-of-band table
    //     wipe). Kept for backward-compat with the deploy runbook.
    //   * `ModuleDigest` — an AUTOMATIC content digest of the seed source
    //     (every uploaded agent module + the handler). Any source edit changes
    //     this digest, so CloudFormation re-invokes the seed handler on the
    //     next deploy and the corrected module bytes actually reach S3. This
    //     closes the stale-module defect: previously only `Version` gated the
    //     re-run, so a module source fix that left `Version` untouched never
    //     re-uploaded. The digest covers EVERY uploaded file (not just one
    //     entry point) — see computeSeedModuleDigest above.
    const seedModuleDigest = computeSeedModuleDigest(
      path.join(ARBITER_ROOT, "seedConfig"),
    );
    const seedAgentConfigResource = new cdk.CustomResource(
      this,
      "SeedAgentConfigResource",
      {
        serviceToken: seedAgentConfigLambda.functionArn,
        properties: {
          Version: "v1.4.0",
          ModuleDigest: seedModuleDigest,
        },
      },
    );

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
    const activatorLambda = new PythonFunction(this, "ActivatorAgent", {
      runtime: lambda.Runtime.PYTHON_3_14,
      entry: path.join(ARBITER_ROOT, "activator"),
      handler: "handler",
      layers: [catalogLayer],
      bundling: { assetHashType: cdk.AssetHashType.SOURCE },
      timeout: cdk.Duration.seconds(30),
      memorySize: 512,
      environment: {
        AGENT_CONFIG_TABLE: props.agentConfigTable.tableName,
      },
      deadLetterQueueEnabled: true,
      deadLetterQueue: arbiterAsyncDlq,
    });

    props.agentConfigTable.grantReadWriteData(activatorLambda);

    const agentActivateRule = new events.Rule(this, "AgentActivateRule", {
      eventBus: props.agentEventBus,
      eventPattern: { source: ["agent.activate"] },
    });
    agentActivateRule.addTarget(new targets.LambdaFunction(activatorLambda));

    // --- Step Runner Lambda (Task 1.6) ---
    // Collects every operational Lambda/DLQ alarm in this stack so they can
    // all be actioned to a single destination topic once it is resolved
    // below (Step Runner + watchdog alarms are declared inside the guard
    // block; DLQ/supervisor/fabricator/worker alarms unconditionally).
    const operationalAlarms: cloudwatch.Alarm[] = [];
    if (
      props.workflowsTable &&
      props.executionsTable &&
      props.appSyncEndpoint
    ) {
      const stepRunnerFunction = new lambda.Function(
        this,
        "StepRunnerFunction",
        {
          runtime: lambda.Runtime.PYTHON_3_14,
          handler: "index.handler",
          code: lambda.Code.fromAsset(path.join(ARBITER_ROOT, "stepRunner")),
          // Shared arbiter layer so `from common import workflow_contract`
          // resolves at runtime (common/ is staged at /opt/python/common).
          layers: [catalogLayer],
          timeout: cdk.Duration.minutes(5),
          memorySize: 1024,
          environment: {
            EXECUTIONS_TABLE: props.executionsTable.tableName,
            WORKFLOWS_TABLE: props.workflowsTable.tableName,
            AGENT_CONFIG_TABLE: props.agentConfigTable.tableName,
            TOOLS_CONFIG_TABLE: toolsConfigTable.tableName,
            EVENT_BUS_NAME: props.agentEventBus.eventBusName,
            APPSYNC_ENDPOINT: props.appSyncEndpoint,
            // URL of the worker agent queue. The Step Runner dispatches a
            // workflow node to the worker by sending a discriminated message to
            // this SQS queue; the worker runs the agent and emits the node
            // completed/failed events the rules below consume.
            WORKER_QUEUE_URL: workerAgentQueue.queueUrl,
            // Release-aware dispatch (this story): mirrors the Supervisor's
            // env var wiring above — table names, plus G3's
            // RELEASE_DISPATCH_ENVIRONMENT (feature switch, uppercased) and
            // RELEASE_DEFAULT_ORG_ID (named org seam). Omitted when the
            // tables/prop aren't provisioned. See ArbiterStackProps's doc
            // comment for the rationale.
            ...(props.agentReleasesTable && {
              AGENT_RELEASES_TABLE: props.agentReleasesTable.tableName,
            }),
            ...(props.environmentReleasePointersTable && {
              ENVIRONMENT_RELEASE_POINTERS_TABLE:
                props.environmentReleasePointersTable.tableName,
              RELEASE_DISPATCH_ENVIRONMENT: props.environment.toUpperCase(),
            }),
            ...(props.releaseDefaultOrgId && {
              RELEASE_DEFAULT_ORG_ID: props.releaseDefaultOrgId,
            }),
          },
          deadLetterQueueEnabled: true,
          deadLetterQueue: arbiterAsyncDlq,
        },
      );

      // Least-privilege IAM per design 8.2
      props.executionsTable.grantReadWriteData(stepRunnerFunction);
      props.workflowsTable.grantReadData(stepRunnerFunction);
      props.agentConfigTable.grantReadData(stepRunnerFunction);
      toolsConfigTable.grantReadData(stepRunnerFunction);
      // Release-aware dispatch (this story): GetItem/Query ONLY, mirrors
      // the Supervisor's identical grant above. Never widen beyond
      // grantReadData for either table.
      if (props.agentReleasesTable) {
        props.agentReleasesTable.grantReadData(stepRunnerFunction);
      }
      if (props.environmentReleasePointersTable) {
        props.environmentReleasePointersTable.grantReadData(stepRunnerFunction);
      }
      props.agentEventBus.grantPutEventsTo(stepRunnerFunction);
      // SendMessage only, on the single worker agent queue — the Step Runner
      // dispatches node execution to the worker via SQS and never receives or
      // deletes from this queue (the worker owns consumption).
      workerAgentQueue.grantSendMessages(stepRunnerFunction);

      // The Step Runner emits best-effort node-level metrics (NodeDurationMs /
      // NodeFailure) into the Citadel/Workflows namespace. PutMetricData has no
      // resource-level scoping; the call is narrowed to that namespace in code.
      stepRunnerFunction.addToRolePolicy(
        new iam.PolicyStatement({
          effect: iam.Effect.ALLOW,
          actions: ["cloudwatch:PutMetricData"],
          resources: ["*"],
        }),
      );
      NagSuppressions.addResourceSuppressions(
        stepRunnerFunction.role!,
        [
          {
            id: "AwsSolutions-IAM5",
            reason:
              "cloudwatch:PutMetricData has no resource-level scoping; the " +
              "step runner narrows the call to the Citadel/Workflows namespace " +
              "(node duration/failure metrics).",
            appliesTo: ["Resource::*"],
          },
        ],
        true,
      );

      // EventBridge rules targeting StepRunner
      const stepRunnerStartRule = new events.Rule(this, "StepRunnerStartRule", {
        eventBus: props.agentEventBus,
        eventPattern: {
          detailType: ["execution.start.requested"],
        },
      });
      stepRunnerStartRule.addTarget(
        new targets.LambdaFunction(stepRunnerFunction),
      );

      const stepRunnerNodeCompletedRule = new events.Rule(
        this,
        "StepRunnerNodeCompletedRule",
        {
          eventBus: props.agentEventBus,
          eventPattern: {
            detailType: ["workflow.node.completed"],
          },
        },
      );
      stepRunnerNodeCompletedRule.addTarget(
        new targets.LambdaFunction(stepRunnerFunction),
      );

      const stepRunnerNodeFailedRule = new events.Rule(
        this,
        "StepRunnerNodeFailedRule",
        {
          eventBus: props.agentEventBus,
          eventPattern: {
            detailType: ["workflow.node.failed"],
          },
        },
      );
      stepRunnerNodeFailedRule.addTarget(
        new targets.LambdaFunction(stepRunnerFunction),
      );

      const stepRunnerCancelRule = new events.Rule(
        this,
        "StepRunnerCancelRule",
        {
          eventBus: props.agentEventBus,
          eventPattern: {
            detailType: ["execution.cancel.requested"],
          },
        },
      );
      stepRunnerCancelRule.addTarget(
        new targets.LambdaFunction(stepRunnerFunction),
      );

      // Advance-only resume (durable-execution-resume): route
      // execution.resume.requested (emitted by the resumeExecution resolver)
      // to the step runner, which re-derives the frontier from persisted
      // state and dispatches only the pending-ready nodes.
      const stepRunnerResumeRule = new events.Rule(
        this,
        "StepRunnerResumeRule",
        {
          eventBus: props.agentEventBus,
          eventPattern: {
            detailType: ["execution.resume.requested"],
          },
        },
      );
      stepRunnerResumeRule.addTarget(
        new targets.LambdaFunction(stepRunnerFunction),
      );

      // WorkflowProgressFanoutRule — matches workflow.* events → FanoutFunction
      if (props.fanoutFunction) {
        const workflowProgressFanoutRule = new events.Rule(
          this,
          "WorkflowProgressFanoutRule",
          {
            eventBus: props.agentEventBus,
            eventPattern: {
              source: ["citadel.workflows"],
              detailType: [
                "workflow.started",
                "workflow.node.started",
                "workflow.node.completed",
                "workflow.node.failed",
                "workflow.node.retrying",
                "workflow.completed",
                "workflow.failed",
              ],
            },
          },
        );
        workflowProgressFanoutRule.addTarget(
          new targets.LambdaFunction(props.fanoutFunction),
        );
      }

      // --- Workflow Timeout Watchdog (reconcile-or-fail) ---
      // A scheduled sweep that gives every stuck 'running' execution a definite
      // disposition: reconcile a lost-event frontier (re-derive + dispatch via
      // the executor's shared schedule_frontier), reconcile-or-fail a stalled
      // node, else fail the execution at the execution-level backstop. It
      // shares the stepRunner asset AND (decision O4) now reads the workflows
      // table + reuses the executor's re-entry primitive — a deliberate
      // revision of the former "no executor coupling" constraint, with the IAM
      // widening below kept strictly resource-scoped.
      const workflowTimeoutWatchdogFunction = new lambda.Function(
        this,
        "WorkflowTimeoutWatchdogFunction",
        {
          runtime: lambda.Runtime.PYTHON_3_14,
          handler: "timeout_watchdog.handler",
          code: lambda.Code.fromAsset(path.join(ARBITER_ROOT, "stepRunner")),
          layers: [catalogLayer],
          timeout: cdk.Duration.minutes(2),
          memorySize: 256,
          environment: {
            EXECUTIONS_TABLE: props.executionsTable.tableName,
            WORKFLOWS_TABLE: props.workflowsTable.tableName,
            EVENT_BUS_NAME: props.agentEventBus.eventBusName,
            // Re-dispatch of a stalled node goes to the shared worker queue via
            // the executor's invoke_node.
            WORKER_QUEUE_URL: workerAgentQueue.queueUrl,
            // Executions still 'running' after this many seconds are considered
            // stuck and failed by the sweep. Default 1 hour.
            WORKFLOW_TIMEOUT_SECONDS: "3600",
            // Per-node stall threshold = NODE_STALL_TIMEOUT_SECONDS *
            // NODE_STALL_FACTOR (decision O6; 900s worker ceiling * 2).
            NODE_STALL_TIMEOUT_SECONDS: "900",
            NODE_STALL_FACTOR: "2",
          },
          deadLetterQueueEnabled: true,
          deadLetterQueue: arbiterAsyncDlq,
        },
      );

      // Least-privilege (decision O4/a41e12a6, reconciled — finding d037634b,
      // superseding a41e12a6's original text). SendMessage to the worker
      // queue ARN re-dispatches a stalled node; PutEvents on the shared bus
      // emits workflow.failed/workflow.completed; PutMetricData (below) is
      // the best-effort timeout metric. Distinct, higher-trust role than the
      // worker (UpdateItem-only + FGAC); triggered ONLY by its EventBridge
      // schedule, never externally invokable.
      //
      // DynamoDB grants verified against every call reachable from the
      // watchdog's own code path (timeout_watchdog.py + the shared
      // executor.py primitives it calls: _load_execution, invoke_node,
      // _reconcile_or_fail_node, handle_node_failure, _finalize_execution):
      //   * dynamodb:Scan — PRE-EXISTING (predates the durable-execution
      //     work at c991af7). Load-bearing: the executions table's only
      //     index is WorkflowIndex (workflowId/startedAt); there is no
      //     status index, so `_scan_running()`'s filtered Scan for
      //     status == 'running' is the only viable access pattern for this
      //     low-frequency sweep (see that function's own docstring).
      //   * dynamodb:GetItem — added by c991af7 (durable-execution work).
      //     Load-bearing: `executor._load_execution` reads a single
      //     execution row by key when reconciling/re-dispatching.
      //   * dynamodb:UpdateItem — PRE-EXISTING. Load-bearing: `_fail_stuck`,
      //     `invoke_node`'s conditional pending->running dispatch,
      //     `_reconcile_or_fail_node`'s stall re-dispatch flip,
      //     `handle_node_failure`, and `_finalize_execution` all write
      //     through this table via conditional-guarded UpdateItem calls
      //     (never a bare write — see executor.py's own ConditionExpression
      //     guards).
      //   * dynamodb:Query — REMOVED. Added by c991af7 alongside GetItem but
      //     never actually called: no function reachable from the watchdog
      //     (including the shared executor.py primitives above) issues a
      //     Query against this table. Confirmed by direct grep of the
      //     watchdog + executor + dag modules for `.query(`.
      workflowTimeoutWatchdogFunction.addToRolePolicy(
        new iam.PolicyStatement({
          effect: iam.Effect.ALLOW,
          actions: ["dynamodb:Scan", "dynamodb:GetItem", "dynamodb:UpdateItem"],
          resources: [props.executionsTable.tableArn],
        }),
      );
      // Workflows table: GetItem-only (read-only, no write). PRE-EXISTING
      // GetItem (via `executor._load_workflow`, called to read the DAG graph
      // for reconcile — see `_load_workflow`'s docstring: "read-only
      // GetItem"). dynamodb:Query REMOVED for the identical reason as above
      // — never called; the workflows table is looked up by its partition
      // key (workflowId) only, never queried.
      workflowTimeoutWatchdogFunction.addToRolePolicy(
        new iam.PolicyStatement({
          effect: iam.Effect.ALLOW,
          actions: ["dynamodb:GetItem"],
          resources: [props.workflowsTable.tableArn],
        }),
      );
      workerAgentQueue.grantSendMessages(workflowTimeoutWatchdogFunction);
      props.agentEventBus.grantPutEventsTo(workflowTimeoutWatchdogFunction);
      workflowTimeoutWatchdogFunction.addToRolePolicy(
        new iam.PolicyStatement({
          effect: iam.Effect.ALLOW,
          actions: ["cloudwatch:PutMetricData"],
          resources: ["*"],
        }),
      );
      NagSuppressions.addResourceSuppressions(
        workflowTimeoutWatchdogFunction.role!,
        [
          {
            id: "AwsSolutions-IAM5",
            reason:
              "cloudwatch:PutMetricData has no resource-level scoping; the " +
              "workflow timeout watchdog narrows the call to the " +
              "Citadel/Workflows namespace.",
            appliesTo: ["Resource::*"],
          },
        ],
        true,
      );

      // Sweep every 5 minutes on an EventBridge schedule.
      const workflowTimeoutWatchdogSchedule = new events.Rule(
        this,
        "WorkflowTimeoutWatchdogSchedule",
        {
          ruleName: `citadel-workflow-timeout-watchdog-${props.environment}`,
          description:
            "Periodically fails workflow executions stuck in the running state past their timeout.",
          schedule: events.Schedule.rate(cdk.Duration.minutes(5)),
        },
      );
      workflowTimeoutWatchdogSchedule.addTarget(
        new targets.LambdaFunction(workflowTimeoutWatchdogFunction),
      );

      // Error-rate alarm for the Step Runner Lambda. Declared inside this
      // guard block so it only exists when the Step Runner does. Mirrors the
      // Supervisor/Fabricator pattern: Errors metric, 5-minute period,
      // NOT_BREACHING, threshold 3 (the Step Runner is invoked on every
      // workflow lifecycle event, so a burst of errors is the signal).
      const stepRunnerErrorAlarm = new cloudwatch.Alarm(
        this,
        "StepRunnerErrorAlarm",
        {
          alarmName: `citadel-step-runner-errors-${props.environment}`,
          metric: stepRunnerFunction.metricErrors({
            period: cdk.Duration.minutes(5),
          }),
          threshold: 3,
          evaluationPeriods: 1,
          comparisonOperator:
            cloudwatch.ComparisonOperator.GREATER_THAN_OR_EQUAL_TO_THRESHOLD,
          treatMissingData: cloudwatch.TreatMissingData.NOT_BREACHING,
          alarmDescription: "Step Runner Lambda error rate exceeded threshold",
        },
      );
      operationalAlarms.push(stepRunnerErrorAlarm);

      // Error-rate alarm for the workflow timeout watchdog. Threshold is 1
      // (not 3 like the request-driven Lambdas): the watchdog runs once per
      // 5-minute schedule, so a threshold of 3 within a single 5-minute
      // period could never be reached and the alarm would be dead. A single
      // failed sweep means stuck executions aren't being reaped, which is
      // itself worth paging on. Same Errors metric / NOT_BREACHING pattern.
      const workflowTimeoutWatchdogErrorAlarm = new cloudwatch.Alarm(
        this,
        "WorkflowTimeoutWatchdogErrorAlarm",
        {
          alarmName: `citadel-workflow-timeout-watchdog-errors-${props.environment}`,
          metric: workflowTimeoutWatchdogFunction.metricErrors({
            period: cdk.Duration.minutes(5),
          }),
          threshold: 1,
          evaluationPeriods: 1,
          comparisonOperator:
            cloudwatch.ComparisonOperator.GREATER_THAN_OR_EQUAL_TO_THRESHOLD,
          treatMissingData: cloudwatch.TreatMissingData.NOT_BREACHING,
          alarmDescription:
            "Workflow timeout watchdog Lambda error rate exceeded threshold",
        },
      );
      operationalAlarms.push(workflowTimeoutWatchdogErrorAlarm);
    }

    // O-03: Enable X-Ray active tracing on all Lambda functions
    // O-02: Add Powertools structured logging env vars
    this.node.findAll().forEach((child) => {
      if (child instanceof lambda.Function || child instanceof PythonFunction) {
        const fn = child as lambda.Function;
        fn.addEnvironment("POWERTOOLS_LOG_LEVEL", "INFO");
        fn.addEnvironment("POWERTOOLS_SERVICE_NAME", "citadel");
        const cfnFunction = fn.node.defaultChild as lambda.CfnFunction;
        if (cfnFunction && !cfnFunction.tracingConfig) {
          cfnFunction.addPropertyOverride("TracingConfig", { Mode: "Active" });
        }
      }
    });

    // O-01: CloudWatch alarms for DLQ depth and critical Lambda errors
    operationalAlarms.push(
      new cloudwatch.Alarm(this, "WorkerDLQDepthAlarm", {
        alarmName: `citadel-worker-dlq-depth-${props.environment}`,
        metric: workerAgentDLQ.metricApproximateNumberOfMessagesVisible({
          period: cdk.Duration.minutes(5),
        }),
        threshold: 1,
        evaluationPeriods: 1,
        comparisonOperator:
          cloudwatch.ComparisonOperator.GREATER_THAN_OR_EQUAL_TO_THRESHOLD,
        treatMissingData: cloudwatch.TreatMissingData.NOT_BREACHING,
        alarmDescription:
          "Worker agent DLQ has messages — indicates failed processing",
      }),
    );

    operationalAlarms.push(
      new cloudwatch.Alarm(this, "SupervisorErrorAlarm", {
        alarmName: `citadel-supervisor-errors-${props.environment}`,
        metric: supervisorLambda.metricErrors({
          period: cdk.Duration.minutes(5),
        }),
        threshold: 3,
        evaluationPeriods: 1,
        comparisonOperator:
          cloudwatch.ComparisonOperator.GREATER_THAN_OR_EQUAL_TO_THRESHOLD,
        treatMissingData: cloudwatch.TreatMissingData.NOT_BREACHING,
        alarmDescription: "Supervisor Lambda error rate exceeded threshold",
      }),
    );

    operationalAlarms.push(
      new cloudwatch.Alarm(this, "FabricatorErrorAlarm", {
        alarmName: `citadel-fabricator-errors-${props.environment}`,
        metric: fabricatorLambda.metricErrors({
          period: cdk.Duration.minutes(5),
        }),
        threshold: 3,
        evaluationPeriods: 1,
        comparisonOperator:
          cloudwatch.ComparisonOperator.GREATER_THAN_OR_EQUAL_TO_THRESHOLD,
        treatMissingData: cloudwatch.TreatMissingData.NOT_BREACHING,
        alarmDescription: "Fabricator Lambda error rate exceeded threshold",
      }),
    );

    // Worker agent Lambda error-rate alarm (workflow dispatch path). Mirrors
    // the Supervisor/Fabricator pattern: Errors metric, 5-minute period,
    // NOT_BREACHING, threshold 3. The worker's SQS DLQ depth is covered
    // separately by WorkerDLQDepthAlarm; this alarm surfaces in-invocation
    // failures (bad dispatch payload, agent crash) that are retried and may
    // never reach the DLQ.
    operationalAlarms.push(
      new cloudwatch.Alarm(this, "WorkerErrorAlarm", {
        alarmName: `citadel-worker-errors-${props.environment}`,
        metric: workerAgentWrapperLambda.metricErrors({
          period: cdk.Duration.minutes(5),
        }),
        threshold: 3,
        evaluationPeriods: 1,
        comparisonOperator:
          cloudwatch.ComparisonOperator.GREATER_THAN_OR_EQUAL_TO_THRESHOLD,
        treatMissingData: cloudwatch.TreatMissingData.NOT_BREACHING,
        alarmDescription: "Worker agent Lambda error rate exceeded threshold",
      }),
    );

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
    const escalationTopicKey = new kms.Key(this, "EscalationTopicKey", {
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
    const escalationTopic = new sns.Topic(this, "EscalationTopic", {
      topicName: `citadel-governance-escalations-${props.environment}`,
      displayName: `Citadel Governance Escalations (${props.environment})`,
      masterKey: escalationTopicKey,
      enforceSSL: true,
    });

    new cloudwatch.Alarm(this, "OffFrontierEscalationAlarm", {
      alarmName: `citadel-offfrontier-escalations-${props.environment}`,
      metric: new cloudwatch.Metric({
        namespace: "CitadelGovernance",
        metricName: "OffFrontierEscalations",
        statistic: "Sum",
        period: cdk.Duration.hours(1),
      }),
      threshold: 0,
      evaluationPeriods: 1,
      datapointsToAlarm: 1,
      comparisonOperator: cloudwatch.ComparisonOperator.GREATER_THAN_THRESHOLD,
      treatMissingData: cloudwatch.TreatMissingData.NOT_BREACHING,
      alarmDescription:
        "Any Jagged-Frontier escalation within the last hour. " +
        "Routes to citadel-governance-escalations-<env> SNS topic — operators " +
        "should investigate why an agent escalated and whether the underlying " +
        "task belongs on the AI-analytical frontier.",
    }).addAlarmAction(new cw_actions.SnsAction(escalationTopic));

    // CloudWatch itself must be able to publish to this CMK-encrypted
    // topic, or the alarm action above fails SILENTLY (the alarm still
    // transitions state; no message ever reaches the topic, so no
    // subscriber — email, Chatbot, or any future destination — ever sees
    // it). This is UNCONDITIONAL — not gated on alarmDelivery mode —
    // because CloudWatch's publish is what puts the notification on the
    // topic in the first place, before any downstream delivery-mode
    // branching in attachAlarmDelivery even runs. Scoped to this key only.
    grantCloudWatchAlarmPublish(escalationTopicKey);

    // Expose the topic ARN to both Lambdas that can legitimately emit
    // escalations in the future (today only the worker emits via the
    // escalate tool; supervisor reserves the env var for a routing
    // refactor). Grant Publish on both so neither path needs a follow-up
    // IAM change when wiring lands.
    workerAgentWrapperLambda.addEnvironment(
      "ESCALATION_TOPIC_ARN",
      escalationTopic.topicArn,
    );
    supervisorLambda.addEnvironment(
      "ESCALATION_TOPIC_ARN",
      escalationTopic.topicArn,
    );
    escalationTopic.grantPublish(workerAgentWrapperLambda);
    escalationTopic.grantPublish(supervisorLambda);

    // cdk-nag suppressions: Topic.grantPublish() on a
    // KMS-encrypted topic auto-attaches kms:GenerateDataKey* (covers
    // GenerateDataKey and GenerateDataKeyWithoutPlaintext) and
    // kms:ReEncrypt* to the caller's DefaultPolicy. Standard AWS
    // pattern — cannot be narrowed without losing SNS publish
    // functionality. Tracked: AAF-NAG-IAM5-kms. reviewBy: 2026-10-22.
    const kmsPublishSuppression = [
      {
        id: "AwsSolutions-IAM5",
        reason:
          "Topic.grantPublish() on KMS-encrypted SNS topic attaches " +
          "kms:GenerateDataKey* and kms:ReEncrypt* wildcards via AWS SDK " +
          "defaults; these cannot be narrowed without breaking publish. " +
          "Resource is scoped to the escalation topic CMK only.",
        appliesTo: ["Action::kms:GenerateDataKey*", "Action::kms:ReEncrypt*"],
      },
    ];
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
    // Alarm delivery — action the operational alarms + subscribe topics
    // ============================================================
    // The six operational Lambda/DLQ alarms are infrastructure-health
    // signals, not governance escalations, so they page to the shared
    // platform alarm topic (`citadel-alarms-<env>`, BackendStack) when it is
    // wired through props. In an isolated ArbiterStack (test paths that omit
    // alarmTopic) they fall back to the in-stack escalation topic so no
    // alarm is ever left actionless. The OffFrontierEscalation alarm stays
    // on the escalation topic — its audience (governance/on-call for agents
    // stepping off the AI-analytical frontier) is distinct from ops health.
    const operationalAlarmTopic: sns.ITopic =
      props.alarmTopic ?? escalationTopic;
    for (const alarm of operationalAlarms) {
      alarm.addAlarmAction(new cw_actions.SnsAction(operationalAlarmTopic));
    }

    // Subscribe the CMK-encrypted escalation topic to the configurable
    // external destination (email | slack | none). Email delivery from a
    // CMK-encrypted topic requires the sns.amazonaws.com decrypt grant that
    // attachAlarmDelivery adds via the escalationTopicKey passed here — miss
    // it and delivery fails silently. Unconfigured case is env-scoped (throw
    // for staging/prod, no-op for dev/test/CI) — see alarm-delivery.ts.
    attachAlarmDelivery(this, {
      config: props.alarmDelivery ?? { mode: "none" },
      environment: props.environment,
      topics: [
        {
          topic: escalationTopic,
          nameHint: "escalation",
          encryptionKey: escalationTopicKey,
        },
      ],
    });

    // ============================================================
    // Governance authority/ledger tables (Δ8)
    // ============================================================
    //
    // Four governance-critical configuration tables (authority units,
    // composition contracts, case law, constitutional layers) plus one
    // append-only ledger. All five carry DeletionProtection and
    // RemovalPolicy.RETAIN so the corpus AND the accountability ledger
    // survive stack deletion / divergent-branch reconciliation (findings
    // 7f42ae86, 9c92a738). The ledger additionally keeps a 90-day TTL
    // (`ttl` attr): deletionProtection guards the TABLE while the TTL still
    // expires individual rows, so operational self-cleaning is unchanged —
    // only silent whole-table teardown is now blocked.
    // All five enable PITR to satisfy AwsSolutions-DDB3 (cdk-nag).
    //
    // Tables are exposed as public readonly fields on ArbiterStack so
    // downstream stories (US-ARB-003 hierarchy loader, US-ARB-004 ledger
    // writer) can grantReadData / grantWriteData from other Lambdas
    // without reaching into constructor-local scope. The alias-const
    // pattern (see /016 in backend-stack.ts) keeps any
    // downstream in-constructor references terse.

    this.authorityUnitsTable = new dynamodb.Table(this, "AuthorityUnitsTable", {
      tableName: `citadel-authority-units-${props.environment}`,
      partitionKey: { name: "unitId", type: dynamodb.AttributeType.STRING },
      billingMode: dynamodb.BillingMode.PAY_PER_REQUEST,
      removalPolicy: cdk.RemovalPolicy.RETAIN,
      deletionProtection: true,
      pointInTimeRecoverySpecification: { pointInTimeRecoveryEnabled: true },
      // Wave 4.E.A.2: enable DynamoDB streams so governance-graph-snapshot-on-change
      // produces a fresh snapshot row whenever this table changes.
      stream: dynamodb.StreamViewType.NEW_AND_OLD_IMAGES,
    });

    this.compositionContractsTable = new dynamodb.Table(
      this,
      "CompositionContractsTable",
      {
        tableName: `citadel-composition-contracts-${props.environment}`,
        partitionKey: {
          name: "contractId",
          type: dynamodb.AttributeType.STRING,
        },
        billingMode: dynamodb.BillingMode.PAY_PER_REQUEST,
        removalPolicy: cdk.RemovalPolicy.RETAIN,
        deletionProtection: true,
        pointInTimeRecoverySpecification: { pointInTimeRecoveryEnabled: true },
        // Wave 4.E.A.2: enable DynamoDB streams so governance-graph-snapshot-on-change
        // produces a fresh snapshot row whenever this table changes.
        stream: dynamodb.StreamViewType.NEW_AND_OLD_IMAGES,
      },
    );

    this.caseLawTable = new dynamodb.Table(this, "CaseLawTable", {
      tableName: `citadel-case-law-${props.environment}`,
      partitionKey: { name: "entryId", type: dynamodb.AttributeType.STRING },
      billingMode: dynamodb.BillingMode.PAY_PER_REQUEST,
      removalPolicy: cdk.RemovalPolicy.RETAIN,
      deletionProtection: true,
      pointInTimeRecoverySpecification: { pointInTimeRecoveryEnabled: true },
      // Wave 4.E.A.2: enable DynamoDB streams so governance-graph-snapshot-on-change
      // produces a fresh snapshot row whenever this table changes.
      stream: dynamodb.StreamViewType.NEW_AND_OLD_IMAGES,
    });

    this.constitutionalLayersTable = new dynamodb.Table(
      this,
      "ConstitutionalLayersTable",
      {
        tableName: `citadel-constitutional-layers-${props.environment}`,
        partitionKey: { name: "layerId", type: dynamodb.AttributeType.STRING },
        billingMode: dynamodb.BillingMode.PAY_PER_REQUEST,
        removalPolicy: cdk.RemovalPolicy.RETAIN,
        deletionProtection: true,
        pointInTimeRecoverySpecification: { pointInTimeRecoveryEnabled: true },
        // Wave 4.E.A.2: enable DynamoDB streams so governance-graph-snapshot-on-change
        // produces a fresh snapshot row whenever this table changes.
        stream: dynamodb.StreamViewType.NEW_AND_OLD_IMAGES,
      },
    );

    // Wave 4.E.A — authority graph snapshots table. Stores daily snapshots
    // of the four source tables (authorityUnits, compositionContracts,
    // constitutionalLayers, caseLaw) so the Wave 4.E.B time scrubber can
    // pivot between historical points. Snapshots are reproducible from
    // the source tables, so RemovalPolicy.DESTROY is intentional —
    // RETAIN here would orphan storage that has no off-stack restore
    // value. TTL via `expiresAt` enforces the operator-selected
    // retention window without manual cleanup.
    this.governanceGraphSnapshotsTable = new dynamodb.Table(
      this,
      "GovernanceGraphSnapshotsTable",
      {
        tableName: `citadel-governance-graph-snapshots-${props.environment}`,
        partitionKey: {
          name: "snapshotId",
          type: dynamodb.AttributeType.STRING,
        },
        sortKey: { name: "timestamp", type: dynamodb.AttributeType.NUMBER },
        billingMode: dynamodb.BillingMode.PAY_PER_REQUEST,
        removalPolicy: cdk.RemovalPolicy.DESTROY,
        pointInTimeRecoverySpecification: { pointInTimeRecoveryEnabled: true },
        timeToLiveAttribute: "expiresAt",
      },
    );
    this.governanceGraphSnapshotsTable.addGlobalSecondaryIndex({
      indexName: "kind-timestamp-index",
      partitionKey: { name: "kind", type: dynamodb.AttributeType.STRING },
      sortKey: { name: "timestamp", type: dynamodb.AttributeType.NUMBER },
      projectionType: dynamodb.ProjectionType.ALL,
    });

    this.governanceLedgerTable = new dynamodb.Table(
      this,
      "GovernanceLedgerTable",
      {
        tableName: `citadel-governance-ledger-${props.environment}`,
        partitionKey: {
          name: "findingId",
          type: dynamodb.AttributeType.STRING,
        },
        billingMode: dynamodb.BillingMode.PAY_PER_REQUEST,
        // Deploy-safety (findings 7f42ae86 / 9c92a738): the governance ledger
        // is an accountability/audit store. RETAIN + deletionProtection so a
        // divergent-branch deploy cannot silently DELETE the table (finding
        // 9c92a738's DELETE_COMPLETE path). The `ttl` attribute still expires
        // individual rows on its 90-day schedule — deletionProtection guards
        // the TABLE, not the rows — so operational self-cleaning is unchanged;
        // only whole-table teardown-by-reconcile is now blocked. Tradeoff:
        // orphaned-table-on-re-add (AlreadyExists) recovery in docs/DEPLOYMENT.md.
        removalPolicy: cdk.RemovalPolicy.RETAIN,
        deletionProtection: true,
        timeToLiveAttribute: "ttl",
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
      },
    );
    const governanceLedgerTable = this.governanceLedgerTable;

    // ============================================================
    // Governance legibility wiring for WorkerAgentWrapper (Bug C)
    // ============================================================
    // WorkerAgentWrapper is declared far earlier in this constructor (before
    // the governance ledger table construct exists), so — like
    // SeedAgentConfigFunction above — its governance-ledger env var and grant
    // are patched in here now that `governanceLedgerTable` is defined.
    //
    // Without GOVERNANCE_LEDGER_TABLE on the worker's env, the governed tool
    // path's write-once legibility record (arbiter/governance/ledger.py) fails
    // CLOSED on EVERY tool call ("GOVERNANCE_LEDGER_TABLE not configured —
    // cannot produce legibility record") — a missing legibility record means
    // the decision cannot be honoured (Article 3), so no governed tool runs.
    //
    // The grant is deliberately dynamodb:PutItem ONLY on the single ledger
    // table ARN — the ledger is write-once (a conditional
    // attribute_not_exists(findingId) PutItem), so no UpdateItem/DeleteItem/
    // Query/Scan and no wildcard, matching the least-privilege shape of the
    // sibling governance writers and this worker's own tool-ledger grant.
    //
    // Approval-required tool gating (finding c947aa77) adds a DISTINCT
    // dynamodb:GetItem statement below: the worker READS the pre-granted
    // approval row (a GetItem on the sole findingId HASH key — never a Query)
    // and WRITES the single-use consumption marker + the always-visible
    // APPROVAL finding (both conditional attribute_not_exists PutItems, already
    // covered by the PutItem statement). The read grant is kept a SEPARATE
    // statement so the write-once PutItem shape stays pinned on its own.
    workerAgentWrapperLambda.addEnvironment(
      "GOVERNANCE_LEDGER_TABLE",
      governanceLedgerTable.tableName,
    );
    // OPT-IN approval-required tool set (finding c947aa77), delivered on the
    // server-assembled dispatch path exactly like DENIED_TOOLS — NEVER via
    // the S3 tool module (finding 588c7fb8, which runs stale). Empty by
    // default (no tool gated); operators enable via CDK context
    // `approvalRequiredTools` (comma-separated tool names).
    workerAgentWrapperLambda.addEnvironment(
      "APPROVAL_REQUIRED_TOOLS",
      (this.node.tryGetContext("approvalRequiredTools") as string) ?? "",
    );
    // Agent-subprocess logging level: the tool-seam INFO log lines
    // (tool_idempotency_hook.py, governance_tool_hook.py, worker_governance.py)
    // never reached CloudWatch because nothing in the agent_runner subprocess
    // configured a logging level, so Python's implicit root-logger default
    // (WARNING) silently dropped every INFO record. Delivered SERVER-SIDE on
    // the static function env (never via the S3 tool module, never via the
    // per-dispatch build_subprocess_env path) so it is present for every
    // subprocess launch regardless of dispatch shape. Defaults to INFO;
    // operators can raise it via CDK context `agentLogLevel` (e.g. "WARNING"
    // to silence the seam again without a code change). agent_runner.py
    // parses this defensively — an invalid value falls back to INFO rather
    // than crashing the subprocess.
    workerAgentWrapperLambda.addEnvironment(
      "AGENT_LOG_LEVEL",
      (this.node.tryGetContext("agentLogLevel") as string) ?? "INFO",
    );
    workerAgentWrapperLambda.addToRolePolicy(
      new iam.PolicyStatement({
        effect: iam.Effect.ALLOW,
        actions: ["dynamodb:PutItem"],
        resources: [governanceLedgerTable.tableArn],
      }),
    );
    // Approval-required tool gating (finding c947aa77): a DISTINCT read-only
    // GetItem statement (never folded into the write-once PutItem statement
    // above — a new read grant stays its own least-privilege statement so the
    // write-once shape is pinned separately). The worker READS a pre-granted
    // approval row by its deterministic findingId (a GetItem on the sole HASH
    // key — never a Query); the consumption marker + APPROVAL finding writes
    // reuse the PutItem grant. No UpdateItem/DeleteItem/Query/Scan, no
    // wildcard, no /index/* — scoped to the single ledger table ARN.
    workerAgentWrapperLambda.addToRolePolicy(
      new iam.PolicyStatement({
        effect: iam.Effect.ALLOW,
        actions: ["dynamodb:GetItem"],
        resources: [governanceLedgerTable.tableArn],
      }),
    );

    governanceLedgerTable.addGlobalSecondaryIndex({
      indexName: "workflow-index",
      partitionKey: { name: "workflowId", type: dynamodb.AttributeType.STRING },
      sortKey: { name: "timestamp", type: dynamodb.AttributeType.NUMBER },
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
      "AUTHORITY_UNITS_TABLE",
      this.authorityUnitsTable.tableName,
    );
    seedAgentConfigLambda.addEnvironment(
      "CONSTITUTIONAL_LAYERS_TABLE",
      this.constitutionalLayersTable.tableName,
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

    const governanceUiResolverFn = new lambda.Function(
      this,
      "GovernanceUiResolverFn",
      {
        runtime: lambda.Runtime.NODEJS_24_X,
        handler: "governance-ui-resolver.handler",
        code: lambda.Code.fromAsset("dist/lambda"),
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
          ...(props.registryId && { REGISTRY_ENABLED: "true" }),
        },
        logGroup: new logs.LogGroup(this, "GovernanceUiResolverFnLogs", {
          retention: logs.RetentionDays.ONE_WEEK,
          removalPolicy: cdk.RemovalPolicy.DESTROY,
        }),
      },
    );

    // Wave 5.C.1: getTrustPath uses LAMBDA_EXEC_ROLE_ARN as the assumer
    // anchor for hop 1 of the trust chain. Resolved post-construction
    // because the role ARN is a Function attribute. Names of the
    // datastores + integrations tables are passed as env vars so the
    // resolver can read resources by id without re-deriving the table
    // name from the environment string.
    governanceUiResolverFn.addEnvironment(
      "LAMBDA_EXEC_ROLE_ARN",
      governanceUiResolverFn.role!.roleArn,
    );
    governanceUiResolverFn.addEnvironment(
      "DATASTORES_TABLE",
      `citadel-datastores-${props.environment}`,
    );
    governanceUiResolverFn.addEnvironment(
      "INTEGRATIONS_TABLE",
      `citadel-integrations-${props.environment}`,
    );
    // Pass 2 (design §4, decision f1cbd5ef): getDecisionTrace's
    // findings->execution pivot by runId needs read access to the
    // executions table. Optional wiring mirrors the existing
    // `props.executionsTable &&` guard pattern used elsewhere in this
    // stack (e.g. stepRunnerFunction) — the resolver itself already
    // degrades to `linkedExecutionId: null` when EXECUTIONS_TABLE is
    // unset, so this is additive, not a hard dependency.
    if (props.executionsTable) {
      governanceUiResolverFn.addEnvironment(
        "EXECUTIONS_TABLE",
        props.executionsTable.tableName,
      );
      props.executionsTable.grantReadData(governanceUiResolverFn);
    }

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
    governanceUiResolverFn.addToRolePolicy(
      new iam.PolicyStatement({
        effect: iam.Effect.ALLOW,
        actions: [
          "dynamodb:GetItem",
          "dynamodb:PutItem",
          "dynamodb:UpdateItem",
        ],
        resources: [this.constitutionalLayersTable.tableArn],
      }),
    );
    // Wave 4.D: listCaseLaw scans the case-law table. Read-only —
    // the resolver only ever calls Scan on this table; encode/revoke
    // admin actions ship in Wave 4.D.2 with their own write grants.
    this.caseLawTable.grantReadData(governanceUiResolverFn);
    // Wave 4.D.2: revokeCaseLaw / unrevokeCaseLaw / updateCaseLawPrecedence
    // mutate the soft-delete + precedence fields via UpdateItem. Scoped
    // to the case-law table only. GetItem is already covered by
    // grantReadData above; only UpdateItem is added here.
    governanceUiResolverFn.addToRolePolicy(
      new iam.PolicyStatement({
        effect: iam.Effect.ALLOW,
        actions: ["dynamodb:UpdateItem"],
        resources: [this.caseLawTable.tableArn],
      }),
    );
    // Allow the GSI to be queried as well — grantReadData covers the base
    // table only; index reads need an explicit /index/* resource grant.
    governanceUiResolverFn.addToRolePolicy(
      new iam.PolicyStatement({
        effect: iam.Effect.ALLOW,
        actions: ["dynamodb:Query"],
        resources: [`${this.governanceLedgerTable.tableArn}/index/*`],
      }),
    );

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
    governanceUiResolverFn.addToRolePolicy(
      new iam.PolicyStatement({
        effect: iam.Effect.ALLOW,
        actions: ["dynamodb:Scan", "dynamodb:Query", "dynamodb:GetItem"],
        resources: [
          this.governanceGraphSnapshotsTable.tableArn,
          `${this.governanceGraphSnapshotsTable.tableArn}/index/*`,
        ],
      }),
    );

    // SSM read scope: getReconcilerStatus / governance-flag helper reads,
    // rb-1 readiness check (GetParameter on enforce mode), and rb-2
    // readiness check (GetParameterHistory on enforce mode for transition
    // detection in the last 7 days).
    governanceUiResolverFn.addToRolePolicy(
      new iam.PolicyStatement({
        effect: iam.Effect.ALLOW,
        actions: ["ssm:GetParameter", "ssm:GetParameterHistory"],
        resources: [
          `arn:aws:ssm:${this.region}:${this.account}:parameter/citadel/governance/*`,
        ],
      }),
    );

    // Wave 2.E: setGovernanceMode mutates the enforce + effective_at SSM
    // parameters. Scoped to the two exact ARNs (one per parameter) — never
    // wildcarded over /citadel/governance/* because nothing else under that
    // prefix should be writable from this resolver.
    governanceUiResolverFn.addToRolePolicy(
      new iam.PolicyStatement({
        effect: iam.Effect.ALLOW,
        actions: ["ssm:PutParameter"],
        resources: [
          `arn:aws:ssm:${this.region}:${this.account}:parameter/citadel/governance/enforce/${props.environment}`,
          `arn:aws:ssm:${this.region}:${this.account}:parameter/citadel/governance/effective_at/${props.environment}`,
          // Wave 4.E.A: updateAuthorityGraphHistorySettings writes the
          // authority-graph-history JSON blob. Scoped to the exact ARN
          // for this env so no other parameter under /citadel/governance/
          // becomes writable.
          `arn:aws:ssm:${this.region}:${this.account}:parameter/citadel/governance/authority-graph-history/${props.environment}`,
        ],
      }),
    );

    // Wave 2.B.2: markReadinessCheckVerified writes operator attestation
    // blobs to /citadel/governance/readiness/manual/<env>/<checkId>. The
    // resolver's allowlist constrains <checkId> to the 6 manual stubs,
    // so the wildcard at the end of the ARN is bounded by code rather
    // than IAM. Nag suppression below documents why the trailing `*` is
    // acceptable here.
    governanceUiResolverFn.addToRolePolicy(
      new iam.PolicyStatement({
        effect: iam.Effect.ALLOW,
        actions: ["ssm:PutParameter"],
        resources: [
          `arn:aws:ssm:${this.region}:${this.account}:parameter/citadel/governance/readiness/manual/*`,
        ],
      }),
    );
    NagSuppressions.addResourceSuppressions(
      governanceUiResolverFn.role!,
      [
        {
          id: "AwsSolutions-IAM5",
          reason:
            "ssm:PutParameter on /citadel/governance/readiness/manual/* is " +
            "narrowed in code to a 6-item allowlist of manual checkIds " +
            "(tel-1, tel-2, rb-2, own-1, own-2, own-3) and the four-value " +
            "expiresInDays allowlist; broader IAM scoping would require one " +
            "statement per (env, checkId) pair, which adds complexity without " +
            "reducing blast radius.",
          appliesTo: [
            "Resource::arn:<AWS::Partition>:ssm:<AWS::Region>:<AWS::AccountId>:parameter/citadel/governance/readiness/manual/*",
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
    governanceUiResolverFn.addToRolePolicy(
      new iam.PolicyStatement({
        effect: iam.Effect.ALLOW,
        actions: ["cloudwatch:GetMetricStatistics"],
        resources: ["*"],
      }),
    );
    NagSuppressions.addResourceSuppressions(
      governanceUiResolverFn.role!,
      [
        {
          id: "AwsSolutions-IAM5",
          reason:
            "cloudwatch:GetMetricStatistics has no resource-level scoping; " +
            "the resolver narrows the query to namespace=RegistrySync, " +
            "metric=SyncFailure for the tel-3 readiness check.",
          appliesTo: ["Resource::*"],
        },
      ],
      true,
    );

    // Wave 2.B data-2 + data-3: read the AgentCore Registry. Mirrors the
    // Supervisor / Worker grants — never CRUD, just Get + List. Only attach
    // the policy when the registry ARN is provided; in test paths the
    // resolver tolerates UNKNOWN for these two checks.
    if (props.registryArn) {
      governanceUiResolverFn.addToRolePolicy(
        new iam.PolicyStatement({
          effect: iam.Effect.ALLOW,
          actions: [
            "bedrock-agentcore:GetRegistryRecord",
            "bedrock-agentcore:ListRegistryRecords",
          ],
          resources: [props.registryArn, `${props.registryArn}/*`],
        }),
      );
    }

    // Cognito AdminGetUser scope for isAdminFromEvent's fallback path.
    // Prefer the precise user-pool ARN when supplied; otherwise fall back
    // to the broader userpool/* path with a TODO so the wiring can be
    // tightened when bin/app.ts always passes the ARN.
    if (props.userPoolArn) {
      governanceUiResolverFn.addToRolePolicy(
        new iam.PolicyStatement({
          effect: iam.Effect.ALLOW,
          actions: ["cognito-idp:AdminGetUser"],
          resources: [props.userPoolArn],
        }),
      );
    } else {
      // TODO(governance-ui): tighten this scope to the BackendStack user pool
      // ARN once bin/app.ts always wires `userPoolArn` into ArbiterStackProps.
      governanceUiResolverFn.addToRolePolicy(
        new iam.PolicyStatement({
          effect: iam.Effect.ALLOW,
          actions: ["cognito-idp:AdminGetUser"],
          resources: [
            `arn:aws:cognito-idp:${this.region}:${this.account}:userpool/*`,
          ],
        }),
      );
    }

    // Wave 5.C.1: getTrustPath inspects the IAM assume chain that the
    // governance UI resolver follows to reach a target resource. Per
    // hop the resolver calls iam:GetRole + iam:GetRolePolicy. Scope is
    // the three citadel scoped-role prefixes plus the Lambda's own
    // execution role ARN — never wildcarded across all roles.
    governanceUiResolverFn.addToRolePolicy(
      new iam.PolicyStatement({
        effect: iam.Effect.ALLOW,
        actions: ["iam:GetRole", "iam:GetRolePolicy"],
        resources: [
          `arn:aws:iam::${this.account}:role/citadel-ds-*`,
          `arn:aws:iam::${this.account}:role/citadel-int-*`,
          `arn:aws:iam::${this.account}:role/citadel-agent-*`,
          governanceUiResolverFn.role!.roleArn,
        ],
      }),
    );
    NagSuppressions.addResourceSuppressions(
      governanceUiResolverFn.role!,
      [
        {
          id: "AwsSolutions-IAM5",
          reason:
            "iam:GetRole / iam:GetRolePolicy on citadel-{ds,int,agent}-* " +
            "wildcards a single resourceId suffix per scope, mirroring the " +
            "PolicyManager naming convention. Read-only inspection used by " +
            "the Wave 5.C.1 IAM trust path page; no write actions. The " +
            "fourth resource is the Lambda's own role ARN (exact).",
          appliesTo: [
            "Resource::arn:aws:iam::<AWS::AccountId>:role/citadel-ds-*",
            "Resource::arn:aws:iam::<AWS::AccountId>:role/citadel-int-*",
            "Resource::arn:aws:iam::<AWS::AccountId>:role/citadel-agent-*",
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
    governanceUiResolverFn.addToRolePolicy(
      new iam.PolicyStatement({
        effect: iam.Effect.ALLOW,
        actions: ["sts:GetCallerIdentity"],
        resources: ["*"],
      }),
    );
    NagSuppressions.addResourceSuppressions(
      governanceUiResolverFn.role!,
      [
        {
          id: "AwsSolutions-IAM5",
          reason:
            "sts:GetCallerIdentity has no resource-level scoping; it returns " +
            "the caller's own identity and grants no access beyond what is " +
            "already implicitly available to the Lambda execution role.",
          appliesTo: ["Resource::*"],
        },
      ],
      true,
    );

    // Wave 5.C.1: getTrustPath reads the datastores + integrations tables
    // to look up an optional crossAccountRoleArn. Read-only, scoped to the
    // exact table ARNs (and the integrations GSI used by the resolver
    // read path). Audit: neither table is granted on the governance UI
    // resolver in earlier waves.
    governanceUiResolverFn.addToRolePolicy(
      new iam.PolicyStatement({
        effect: iam.Effect.ALLOW,
        actions: ["dynamodb:GetItem"],
        resources: [
          `arn:aws:dynamodb:${this.region}:${this.account}:table/citadel-datastores-${props.environment}`,
        ],
      }),
    );
    governanceUiResolverFn.addToRolePolicy(
      new iam.PolicyStatement({
        effect: iam.Effect.ALLOW,
        actions: ["dynamodb:Query"],
        resources: [
          `arn:aws:dynamodb:${this.region}:${this.account}:table/citadel-integrations-${props.environment}`,
          `arn:aws:dynamodb:${this.region}:${this.account}:table/citadel-integrations-${props.environment}/index/IntegrationIdIndex`,
        ],
      }),
    );

    // Only attach the AppSync data source + resolvers when an API is
    // actually wired. Existing arbiter-stack-*.test.ts paths construct the
    // stack without an API, and that should remain a valid synthesis.
    if (props.appSyncApi) {
      // ============================================================
      // Approval-required tool gating (finding c947aa77) — decideToolApproval
      // ============================================================
      // A dedicated resolver Lambda + data source for the ONE Mutation field
      // that PRE-GRANTS a single-use tool approval into GOVERNANCE_LEDGER_TABLE
      // (write-once conditional PutItem via tool-approval-grant-writer.ts).
      // Homed in THIS stack because the ledger table lives here; wired to the
      // BackendStack-owned API by apiId string token (same one-way-dependency
      // technique as the governance UI resolver above — no stack cycle).
      const toolApprovalResolverFn = new lambda.Function(
        this,
        "ToolApprovalResolverFn",
        {
          runtime: lambda.Runtime.NODEJS_24_X,
          handler: "tool-approval-resolver.handler",
          code: lambda.Code.fromAsset("dist/lambda"),
          timeout: cdk.Duration.seconds(30),
          environment: {
            ENVIRONMENT: props.environment,
            GOVERNANCE_LEDGER_TABLE: this.governanceLedgerTable.tableName,
            // extractOrgFromEvent prefers the `custom:organization` JWT claim;
            // USER_POOL_ID enables the AdminGetUser fallback during the token-
            // refresh transition window. Derived from the pool ARN when wired.
            ...(props.userPoolArn && {
              USER_POOL_ID: cdk.Fn.select(
                1,
                cdk.Fn.split("/", props.userPoolArn),
              ),
            }),
          },
          logGroup: new logs.LogGroup(this, "ToolApprovalResolverFnLogs", {
            retention: logs.RetentionDays.ONE_WEEK,
            removalPolicy: cdk.RemovalPolicy.DESTROY,
          }),
        },
      );
      // Least privilege: the resolver only WRITES the write-once grant row
      // (conditional attribute_not_exists PutItem). No Get/Update/Delete/
      // Query/Scan, no wildcard — the worker (not this resolver) reads/consumes.
      toolApprovalResolverFn.addToRolePolicy(
        new iam.PolicyStatement({
          effect: iam.Effect.ALLOW,
          actions: ["dynamodb:PutItem"],
          resources: [this.governanceLedgerTable.tableArn],
        }),
      );
      // Cognito AdminGetUser for the org-claim fallback (mirror the governance
      // UI resolver's scoping: precise ARN when supplied, else userpool/*).
      toolApprovalResolverFn.addToRolePolicy(
        new iam.PolicyStatement({
          effect: iam.Effect.ALLOW,
          actions: ["cognito-idp:AdminGetUser"],
          resources: [
            props.userPoolArn ??
              `arn:aws:cognito-idp:${this.region}:${this.account}:userpool/*`,
          ],
        }),
      );

      const toolApprovalDataSourceRole = new iam.Role(
        this,
        "ToolApprovalDataSourceRole",
        { assumedBy: new iam.ServicePrincipal("appsync.amazonaws.com") },
      );
      toolApprovalResolverFn.grantInvoke(toolApprovalDataSourceRole);

      const toolApprovalLambdaDataSource = new appsyncCfn.CfnDataSource(
        this,
        "ToolApprovalLambdaDataSource",
        {
          apiId: props.appSyncApi.apiId,
          name: "ToolApprovalLambdaDataSource",
          type: "AWS_LAMBDA",
          serviceRoleArn: toolApprovalDataSourceRole.roleArn,
          lambdaConfig: {
            lambdaFunctionArn: toolApprovalResolverFn.functionArn,
          },
        },
      );

      const decideToolApprovalResolver = new appsyncCfn.CfnResolver(
        this,
        "ToolApproval_decideToolApproval_Resolver",
        {
          apiId: props.appSyncApi.apiId,
          typeName: "Mutation",
          fieldName: "decideToolApproval",
          dataSourceName: toolApprovalLambdaDataSource.attrName,
          requestMappingTemplate: LAMBDA_REQUEST_MAPPING,
          responseMappingTemplate: LAMBDA_RESPONSE_MAPPING,
        },
      );
      decideToolApprovalResolver.addResourceDependency(
        toolApprovalLambdaDataSource,
      );

      const governanceUiDataSourceRole = new iam.Role(
        this,
        "GovernanceUiDataSourceRole",
        {
          assumedBy: new iam.ServicePrincipal("appsync.amazonaws.com"),
        },
      );
      governanceUiResolverFn.grantInvoke(governanceUiDataSourceRole);

      const governanceUiLambdaDataSource = new appsyncCfn.CfnDataSource(
        this,
        "GovernanceUiLambdaDataSource",
        {
          apiId: props.appSyncApi.apiId,
          name: "GovernanceUiLambdaDataSource",
          type: "AWS_LAMBDA",
          serviceRoleArn: governanceUiDataSourceRole.roleArn,
          lambdaConfig: {
            lambdaFunctionArn: governanceUiResolverFn.functionArn,
          },
        },
      );

      const governanceUiResolverFields = [
        "getGovernanceMode",
        "listGovernanceFindings",
        "getGovernanceFinding",
        "getReconcilerStatus",
        "getRolloutReadiness",
        "getMismatchHeatmap",
        "getEscalationMetricSeries",
        // Wave 3.B: 10th resolver — `getDecisionTrace` on the Query type.
        // Same Lambda + data source as the other reads. The resolver
        // composes a finding's reason / scope / contract fields into the
        // engine's 8-step pipeline state for the tracer page.
        "getDecisionTrace",
        // Wave 4.A: 11th + 12th resolvers — `listAuthorityUnits` and
        // `listCompositionContracts` on the Query type. Read-only
        // projections of the authority graph, admin-only via the resolver
        // dispatch (defence in depth on top of the AppSync auth layer).
        "listAuthorityUnits",
        "listCompositionContracts",
        // Wave 4.B: 13th resolver — `getRevokeImpact` on the Query type.
        // Blast-radius approximation that scans the governance ledger
        // for permit findings where the supplied unitId was the matched
        // scope. No new IAM (already has Scan on the ledger). Admin-only
        // via the resolver dispatch.
        "getRevokeImpact",
        // Wave 4.C: 14th + 15th resolvers — `listConstitutionalLayers`
        // and `getConstitutionalRuleStats` on the Query type. Read-only
        // projection of the constitutional rule tree + per-rule
        // override statistics. Admin-only via the resolver dispatch.
        "listConstitutionalLayers",
        "getConstitutionalRuleStats",
        // Wave 4.D: 16th resolver — `listCaseLaw` on the Query type.
        // Read-only projection of the case-law timeline. Admin-only
        // via the resolver dispatch. Encode/revoke admin actions ship
        // in Wave 4.D.2 as additional Mutation-typed resolvers.
        "listCaseLaw",
      ];
      for (const fieldName of governanceUiResolverFields) {
        const resolver = new appsyncCfn.CfnResolver(
          this,
          `GovernanceUi_${fieldName}_Resolver`,
          {
            apiId: props.appSyncApi.apiId,
            typeName: "Query",
            fieldName,
            dataSourceName: governanceUiLambdaDataSource.attrName,
            requestMappingTemplate: LAMBDA_REQUEST_MAPPING,
            responseMappingTemplate: LAMBDA_RESPONSE_MAPPING,
          },
        );
        resolver.addResourceDependency(governanceUiLambdaDataSource);
      }

      // Wave 2.E: 8th resolver — `setGovernanceMode` on the Mutation type.
      // Mirrors the 7 query resolvers' shape with typeName flipped to
      // 'Mutation'. Kept as a separate CfnResolver entry rather than
      // expanding the loop because this is the only Mutation-typed
      // resolver wired by the governance UI Lambda; bundling it into the
      // generic loop above would force a typeName branch for one entry.
      const setGovernanceModeResolver = new appsyncCfn.CfnResolver(
        this,
        "GovernanceUi_setGovernanceMode_Resolver",
        {
          apiId: props.appSyncApi.apiId,
          typeName: "Mutation",
          fieldName: "setGovernanceMode",
          dataSourceName: governanceUiLambdaDataSource.attrName,
          requestMappingTemplate: LAMBDA_REQUEST_MAPPING,
          responseMappingTemplate: LAMBDA_RESPONSE_MAPPING,
        },
      );
      setGovernanceModeResolver.addResourceDependency(
        governanceUiLambdaDataSource,
      );

      // Wave 2.B.2: 9th resolver — `markReadinessCheckVerified` on the
      // Mutation type. Same Lambda data source as the queries because the
      // verification write piggybacks on the existing governance UI
      // resolver dispatch.
      const markReadinessCheckVerifiedResolver = new appsyncCfn.CfnResolver(
        this,
        "GovernanceUi_markReadinessCheckVerified_Resolver",
        {
          apiId: props.appSyncApi.apiId,
          typeName: "Mutation",
          fieldName: "markReadinessCheckVerified",
          dataSourceName: governanceUiLambdaDataSource.attrName,
          requestMappingTemplate: LAMBDA_REQUEST_MAPPING,
          responseMappingTemplate: LAMBDA_RESPONSE_MAPPING,
        },
      );
      markReadinessCheckVerifiedResolver.addResourceDependency(
        governanceUiLambdaDataSource,
      );

      // Wave 3.C: 10th resolver — `publishGovernanceFinding` on the
      // Mutation type. The mutation is `@aws_iam` only; the resolver
      // performs an additional defence-in-depth identity check and
      // returns the input as-is so the @aws_subscribe-driven
      // `onGovernanceFinding` subscription receives the right shape.
      const publishGovernanceFindingResolver = new appsyncCfn.CfnResolver(
        this,
        "GovernanceUi_publishGovernanceFinding_Resolver",
        {
          apiId: props.appSyncApi.apiId,
          typeName: "Mutation",
          fieldName: "publishGovernanceFinding",
          dataSourceName: governanceUiLambdaDataSource.attrName,
          requestMappingTemplate: LAMBDA_REQUEST_MAPPING,
          responseMappingTemplate: LAMBDA_RESPONSE_MAPPING,
        },
      );
      publishGovernanceFindingResolver.addResourceDependency(
        governanceUiLambdaDataSource,
      );

      // Wave 4.C.2: 11th, 12th, 13th Mutation-typed resolvers —
      // `addConstitutionalRule`, `updateConstitutionalRule`,
      // `deleteConstitutionalRule`. All three pipe through the same
      // governance UI Lambda data source; admin gating + the
      // acknowledgement check happen inside the resolver dispatch.
      const constitutionalRuleMutationFields: ReadonlyArray<string> = [
        "addConstitutionalRule",
        "updateConstitutionalRule",
        "deleteConstitutionalRule",
      ];
      for (const fieldName of constitutionalRuleMutationFields) {
        const resolver = new appsyncCfn.CfnResolver(
          this,
          `GovernanceUi_${fieldName}_Resolver`,
          {
            apiId: props.appSyncApi.apiId,
            typeName: "Mutation",
            fieldName,
            dataSourceName: governanceUiLambdaDataSource.attrName,
            requestMappingTemplate: LAMBDA_REQUEST_MAPPING,
            responseMappingTemplate: LAMBDA_RESPONSE_MAPPING,
          },
        );
        resolver.addResourceDependency(governanceUiLambdaDataSource);
      }

      // Wave 4.D.2: 14th, 15th, 16th Mutation-typed resolvers —
      // `revokeCaseLaw`, `unrevokeCaseLaw`, `updateCaseLawPrecedence`.
      // Same pattern as the constitutional rule editor: admin gating +
      // the verbatim acknowledgement check happen inside the resolver
      // dispatch. Each mutation is idempotent (revoke on an already-
      // revoked row no-ops with emittedEventDetailType=null).
      const caseLawMutationFields: ReadonlyArray<string> = [
        "revokeCaseLaw",
        "unrevokeCaseLaw",
        "updateCaseLawPrecedence",
      ];
      for (const fieldName of caseLawMutationFields) {
        const resolver = new appsyncCfn.CfnResolver(
          this,
          `GovernanceUi_${fieldName}_Resolver`,
          {
            apiId: props.appSyncApi.apiId,
            typeName: "Mutation",
            fieldName,
            dataSourceName: governanceUiLambdaDataSource.attrName,
            requestMappingTemplate: LAMBDA_REQUEST_MAPPING,
            responseMappingTemplate: LAMBDA_RESPONSE_MAPPING,
          },
        );
        resolver.addResourceDependency(governanceUiLambdaDataSource);
      }

      // Wave 4.E.A: 17th Query-typed resolver — `getAuthorityGraphHistorySettings`
      // (admin-only). Reads the SSM-backed settings + counts snapshots
      // within the retention window. Same Lambda data source as the
      // other governance UI reads.
      const getAuthorityGraphHistorySettingsResolver =
        new appsyncCfn.CfnResolver(
          this,
          "GovernanceUi_getAuthorityGraphHistorySettings_Resolver",
          {
            apiId: props.appSyncApi.apiId,
            typeName: "Query",
            fieldName: "getAuthorityGraphHistorySettings",
            dataSourceName: governanceUiLambdaDataSource.attrName,
            requestMappingTemplate: LAMBDA_REQUEST_MAPPING,
            responseMappingTemplate: LAMBDA_RESPONSE_MAPPING,
          },
        );
      getAuthorityGraphHistorySettingsResolver.addResourceDependency(
        governanceUiLambdaDataSource,
      );

      // Wave 4.E.B: 18th + 19th Query-typed resolvers (admin-only) —
      // `listAuthorityGraphSnapshots` and `getAuthorityGraphSnapshot`.
      // Back the time scrubber on the governance Graph page; both are
      // read-only and pipe through the same governance UI Lambda data
      // source.
      const wave4EbQueryFields: ReadonlyArray<string> = [
        "listAuthorityGraphSnapshots",
        "getAuthorityGraphSnapshot",
      ];
      for (const fieldName of wave4EbQueryFields) {
        const resolver = new appsyncCfn.CfnResolver(
          this,
          `GovernanceUi_${fieldName}_Resolver`,
          {
            apiId: props.appSyncApi.apiId,
            typeName: "Query",
            fieldName,
            dataSourceName: governanceUiLambdaDataSource.attrName,
            requestMappingTemplate: LAMBDA_REQUEST_MAPPING,
            responseMappingTemplate: LAMBDA_RESPONSE_MAPPING,
          },
        );
        resolver.addResourceDependency(governanceUiLambdaDataSource);
      }

      // Wave 4.E.A: 17th Mutation-typed resolver —
      // `updateAuthorityGraphHistorySettings` (admin-only). Writes the
      // SSM blob and emits a governance.authority-graph-history.config.changed
      // audit event (best-effort).
      const updateAuthorityGraphHistorySettingsResolver =
        new appsyncCfn.CfnResolver(
          this,
          "GovernanceUi_updateAuthorityGraphHistorySettings_Resolver",
          {
            apiId: props.appSyncApi.apiId,
            typeName: "Mutation",
            fieldName: "updateAuthorityGraphHistorySettings",
            dataSourceName: governanceUiLambdaDataSource.attrName,
            requestMappingTemplate: LAMBDA_REQUEST_MAPPING,
            responseMappingTemplate: LAMBDA_RESPONSE_MAPPING,
          },
        );
      updateAuthorityGraphHistorySettingsResolver.addResourceDependency(
        governanceUiLambdaDataSource,
      );

      // Wave 5.A: 27th Query-typed resolver — `getD4RetrospectiveReport`
      // (admin-only). Ports `arbiter/governance/d4_retrospective.py` to
      // an on-demand AppSync read with a 5-minute in-process cache.
      // Same Lambda + data source as the other governance UI reads;
      // no new IAM (the resolver Scans the existing governance ledger).
      const getD4RetrospectiveReportResolver = new appsyncCfn.CfnResolver(
        this,
        "GovernanceUi_getD4RetrospectiveReport_Resolver",
        {
          apiId: props.appSyncApi.apiId,
          typeName: "Query",
          fieldName: "getD4RetrospectiveReport",
          dataSourceName: governanceUiLambdaDataSource.attrName,
          requestMappingTemplate: LAMBDA_REQUEST_MAPPING,
          responseMappingTemplate: LAMBDA_RESPONSE_MAPPING,
        },
      );
      getD4RetrospectiveReportResolver.addResourceDependency(
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
        "GovernanceUi_getTrustPath_Resolver",
        {
          apiId: props.appSyncApi.apiId,
          typeName: "Query",
          fieldName: "getTrustPath",
          dataSourceName: governanceUiLambdaDataSource.attrName,
          requestMappingTemplate: LAMBDA_REQUEST_MAPPING,
          responseMappingTemplate: LAMBDA_RESPONSE_MAPPING,
        },
      );
      getTrustPathResolver.addResourceDependency(governanceUiLambdaDataSource);

      // Wave 5.C.1: 29th Query-typed resolver — `getResourceIamDrift`
      // (admin-only). Compares the recorded baseline IAM trust/policy
      // posture against the live IAM state for a target resource and
      // returns the diff. Same Lambda + data source as the other
      // governance UI reads; reuses the IAM Get* grants attached to
      // the Lambda role above.
      const getResourceIamDriftResolver = new appsyncCfn.CfnResolver(
        this,
        "GovernanceUi_getResourceIamDrift_Resolver",
        {
          apiId: props.appSyncApi.apiId,
          typeName: "Query",
          fieldName: "getResourceIamDrift",
          dataSourceName: governanceUiLambdaDataSource.attrName,
          requestMappingTemplate: LAMBDA_REQUEST_MAPPING,
          responseMappingTemplate: LAMBDA_RESPONSE_MAPPING,
        },
      );
      getResourceIamDriftResolver.addResourceDependency(
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

    new ssm.StringParameter(this, "AuthorityGraphHistorySettingsParam", {
      parameterName: `/citadel/governance/authority-graph-history/${props.environment}`,
      stringValue: '{"enabled":false,"retentionDays":30,"captureMode":"daily"}',
      description:
        "Authority graph history settings (Wave 4.E.A). Default OFF. " +
        "JSON shape: {enabled, retentionDays, captureMode}.",
    });

    const governanceGraphSnapshotFn = new lambda.Function(
      this,
      "GovernanceGraphSnapshotFn",
      {
        runtime: lambda.Runtime.NODEJS_24_X,
        handler: "governance-graph-snapshot.handler",
        code: lambda.Code.fromAsset("dist/lambda"),
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
        logGroup: new logs.LogGroup(this, "GovernanceGraphSnapshotFnLogs", {
          retention: logs.RetentionDays.ONE_WEEK,
          removalPolicy: cdk.RemovalPolicy.DESTROY,
        }),
        deadLetterQueueEnabled: true,
        deadLetterQueue: arbiterAsyncDlq,
      },
    );

    // SSM read scope — single exact ARN.
    governanceGraphSnapshotFn.addToRolePolicy(
      new iam.PolicyStatement({
        effect: iam.Effect.ALLOW,
        actions: ["ssm:GetParameter"],
        resources: [
          `arn:aws:ssm:${this.region}:${this.account}:parameter/citadel/governance/authority-graph-history/${props.environment}`,
        ],
      }),
    );

    // DDB scans on the four source tables — read-only.
    this.authorityUnitsTable.grantReadData(governanceGraphSnapshotFn);
    this.compositionContractsTable.grantReadData(governanceGraphSnapshotFn);
    this.constitutionalLayersTable.grantReadData(governanceGraphSnapshotFn);
    this.caseLawTable.grantReadData(governanceGraphSnapshotFn);

    // DDB write on the snapshots table.
    this.governanceGraphSnapshotsTable.grantWriteData(
      governanceGraphSnapshotFn,
    );

    // CloudWatch metrics — namespace narrowed in code; no resource-level
    // scoping is available for PutMetricData.
    governanceGraphSnapshotFn.addToRolePolicy(
      new iam.PolicyStatement({
        effect: iam.Effect.ALLOW,
        actions: ["cloudwatch:PutMetricData"],
        resources: ["*"],
      }),
    );
    NagSuppressions.addResourceSuppressions(
      governanceGraphSnapshotFn.role!,
      [
        {
          id: "AwsSolutions-IAM5",
          reason:
            "cloudwatch:PutMetricData has no resource-level scoping; the " +
            "governance-graph-snapshot Lambda narrows the call to the " +
            "Citadel/Governance/GraphSnapshot namespace.",
          appliesTo: ["Resource::*"],
        },
      ],
      true,
    );

    // EventBridge schedule rule firing daily at 03:00 UTC. Same
    // schedule pattern as governance-mode-refresher (event-driven), but
    // here we use a cron expression because there's no triggering event
    // — the snapshot is intrinsically time-based.
    const governanceGraphSnapshotSchedule = new events.Rule(
      this,
      "GovernanceGraphSnapshotSchedule",
      {
        ruleName: `citadel-governance-graph-snapshot-${props.environment}`,
        description:
          "Triggers the governance-graph-snapshot Lambda daily at 03:00 UTC (Wave 4.E.A).",
        schedule: events.Schedule.cron({ hour: "3", minute: "0" }),
      },
    );
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

    const governanceGraphSnapshotOnChangeDLQ = new Queue(
      this,
      "GovernanceGraphSnapshotOnChangeDLQ",
      {
        queueName: `citadel-governance-graph-snapshot-on-change-dlq-${props.environment}`,
        retentionPeriod: cdk.Duration.days(14),
        encryption: cdk.aws_sqs.QueueEncryption.SQS_MANAGED,
        enforceSSL: true,
      },
    );
    // The DLQ is itself the dead-letter target for the four
    // EventSourceMappings; a DLQ for a DLQ would loop on its own
    // failures (same pattern as governanceFindingFanoutDLQ).
    NagSuppressions.addResourceSuppressions(
      governanceGraphSnapshotOnChangeDLQ,
      [
        {
          id: "AwsSolutions-SQS3",
          reason:
            "This queue IS the dead-letter destination for the " +
            "governance-graph-snapshot-on-change DDB stream " +
            "EventSourceMappings (one per authority source table). " +
            "A DLQ for a DLQ would loop on its own failures.",
        },
      ],
    );

    this.governanceGraphSnapshotOnChangeFn = new lambda.Function(
      this,
      "GovernanceGraphSnapshotOnChangeFn",
      {
        functionName: `citadel-governance-graph-snapshot-on-change-${props.environment}`,
        runtime: lambda.Runtime.NODEJS_24_X,
        handler: "governance-graph-snapshot-on-change.handler",
        code: lambda.Code.fromAsset("dist/lambda"),
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
        logGroup: new logs.LogGroup(
          this,
          "GovernanceGraphSnapshotOnChangeFnLogs",
          {
            retention: logs.RetentionDays.ONE_WEEK,
            removalPolicy: cdk.RemovalPolicy.DESTROY,
          },
        ),
      },
    );
    const governanceGraphSnapshotOnChangeFn =
      this.governanceGraphSnapshotOnChangeFn;

    // SSM read scope — single exact ARN, mirrors the scheduled Lambda.
    governanceGraphSnapshotOnChangeFn.addToRolePolicy(
      new iam.PolicyStatement({
        effect: iam.Effect.ALLOW,
        actions: ["ssm:GetParameter"],
        resources: [
          `arn:aws:ssm:${this.region}:${this.account}:parameter/citadel/governance/authority-graph-history/${props.environment}`,
        ],
      }),
    );

    // DDB scans on the four source tables — read-only.
    this.authorityUnitsTable.grantReadData(governanceGraphSnapshotOnChangeFn);
    this.compositionContractsTable.grantReadData(
      governanceGraphSnapshotOnChangeFn,
    );
    this.constitutionalLayersTable.grantReadData(
      governanceGraphSnapshotOnChangeFn,
    );
    this.caseLawTable.grantReadData(governanceGraphSnapshotOnChangeFn);

    // DDB write on the snapshots table.
    this.governanceGraphSnapshotsTable.grantWriteData(
      governanceGraphSnapshotOnChangeFn,
    );

    // CloudWatch metrics — namespace narrowed in code; no resource-level
    // scoping is available for PutMetricData.
    governanceGraphSnapshotOnChangeFn.addToRolePolicy(
      new iam.PolicyStatement({
        effect: iam.Effect.ALLOW,
        actions: ["cloudwatch:PutMetricData"],
        resources: ["*"],
      }),
    );
    NagSuppressions.addResourceSuppressions(
      governanceGraphSnapshotOnChangeFn.role!,
      [
        {
          id: "AwsSolutions-IAM5",
          reason:
            "Two scoped wildcards on the on-change snapshot Lambda role: " +
            "(1) cloudwatch:PutMetricData has no resource-level scoping; the " +
            "handler narrows calls to the Citadel/Governance/GraphSnapshot " +
            "namespace. (2) DynamoDB stream ARNs include a timestamp suffix " +
            "that CFN cannot resolve at template time; the wildcards are " +
            "bounded to the four authority source-table stream sub-resources " +
            "via their tableArn prefixes, so no other table is reachable.",
          appliesTo: [
            "Resource::*",
            "Resource::<AuthorityUnitsTableC4FCD799.Arn>/stream/*",
            "Resource::<CompositionContractsTable03389A48.Arn>/stream/*",
            "Resource::<CaseLawTable6F50F1D2.Arn>/stream/*",
            "Resource::<ConstitutionalLayersTable20D1ED32.Arn>/stream/*",
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
    governanceGraphSnapshotOnChangeFn.addToRolePolicy(
      new iam.PolicyStatement({
        effect: iam.Effect.ALLOW,
        actions: [
          "dynamodb:DescribeStream",
          "dynamodb:GetRecords",
          "dynamodb:GetShardIterator",
          "dynamodb:ListStreams",
        ],
        resources: [
          `${this.authorityUnitsTable.tableArn}/stream/*`,
          `${this.compositionContractsTable.tableArn}/stream/*`,
          `${this.caseLawTable.tableArn}/stream/*`,
          `${this.constitutionalLayersTable.tableArn}/stream/*`,
        ],
      }),
    );

    // SendMessage on the DLQ — the EventSourceMappings need this for
    // their on-failure target.
    governanceGraphSnapshotOnChangeDLQ.grantSendMessages(
      governanceGraphSnapshotOnChangeFn,
    );

    // Four EventSourceMappings — one per authority source table.
    // batchSize 100 + maxBatchingWindow 5s amortises Lambda cold starts
    // across small change bursts; retryAttempts 2 gives three total
    // attempts before the DLQ catches a permanently broken event.
    // Filter criteria use three separate FilterCriteria entries
    // (INSERT/MODIFY/REMOVE) because lambda.FilterRule has no .or()
    // helper — multiple filter entries are OR'd at the EventSourceMapping
    // level per the Lambda filter-criteria spec.
    new lambda.EventSourceMapping(
      this,
      "GovernanceGraphSnapshotOnChangeAuthorityUnitsESM",
      {
        target: governanceGraphSnapshotOnChangeFn,
        eventSourceArn: this.authorityUnitsTable.tableStreamArn,
        startingPosition: lambda.StartingPosition.LATEST,
        batchSize: 100,
        maxBatchingWindow: cdk.Duration.seconds(5),
        retryAttempts: 2,
        onFailure: new cdk.aws_lambda_event_sources.SqsDlq(
          governanceGraphSnapshotOnChangeDLQ,
        ),
        filters: [
          lambda.FilterCriteria.filter({
            eventName: lambda.FilterRule.isEqual("INSERT"),
          }),
          lambda.FilterCriteria.filter({
            eventName: lambda.FilterRule.isEqual("MODIFY"),
          }),
          lambda.FilterCriteria.filter({
            eventName: lambda.FilterRule.isEqual("REMOVE"),
          }),
        ],
      },
    );

    new lambda.EventSourceMapping(
      this,
      "GovernanceGraphSnapshotOnChangeCompositionContractsESM",
      {
        target: governanceGraphSnapshotOnChangeFn,
        eventSourceArn: this.compositionContractsTable.tableStreamArn,
        startingPosition: lambda.StartingPosition.LATEST,
        batchSize: 100,
        maxBatchingWindow: cdk.Duration.seconds(5),
        retryAttempts: 2,
        onFailure: new cdk.aws_lambda_event_sources.SqsDlq(
          governanceGraphSnapshotOnChangeDLQ,
        ),
        filters: [
          lambda.FilterCriteria.filter({
            eventName: lambda.FilterRule.isEqual("INSERT"),
          }),
          lambda.FilterCriteria.filter({
            eventName: lambda.FilterRule.isEqual("MODIFY"),
          }),
          lambda.FilterCriteria.filter({
            eventName: lambda.FilterRule.isEqual("REMOVE"),
          }),
        ],
      },
    );

    new lambda.EventSourceMapping(
      this,
      "GovernanceGraphSnapshotOnChangeCaseLawESM",
      {
        target: governanceGraphSnapshotOnChangeFn,
        eventSourceArn: this.caseLawTable.tableStreamArn,
        startingPosition: lambda.StartingPosition.LATEST,
        batchSize: 100,
        maxBatchingWindow: cdk.Duration.seconds(5),
        retryAttempts: 2,
        onFailure: new cdk.aws_lambda_event_sources.SqsDlq(
          governanceGraphSnapshotOnChangeDLQ,
        ),
        filters: [
          lambda.FilterCriteria.filter({
            eventName: lambda.FilterRule.isEqual("INSERT"),
          }),
          lambda.FilterCriteria.filter({
            eventName: lambda.FilterRule.isEqual("MODIFY"),
          }),
          lambda.FilterCriteria.filter({
            eventName: lambda.FilterRule.isEqual("REMOVE"),
          }),
        ],
      },
    );

    new lambda.EventSourceMapping(
      this,
      "GovernanceGraphSnapshotOnChangeConstitutionalLayersESM",
      {
        target: governanceGraphSnapshotOnChangeFn,
        eventSourceArn: this.constitutionalLayersTable.tableStreamArn,
        startingPosition: lambda.StartingPosition.LATEST,
        batchSize: 100,
        maxBatchingWindow: cdk.Duration.seconds(5),
        retryAttempts: 2,
        onFailure: new cdk.aws_lambda_event_sources.SqsDlq(
          governanceGraphSnapshotOnChangeDLQ,
        ),
        filters: [
          lambda.FilterCriteria.filter({
            eventName: lambda.FilterRule.isEqual("INSERT"),
          }),
          lambda.FilterCriteria.filter({
            eventName: lambda.FilterRule.isEqual("MODIFY"),
          }),
          lambda.FilterCriteria.filter({
            eventName: lambda.FilterRule.isEqual("REMOVE"),
          }),
        ],
      },
    );

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

    const governanceModeRefresherFn = new lambda.Function(
      this,
      "GovernanceModeRefresherFn",
      {
        runtime: lambda.Runtime.NODEJS_24_X,
        handler: "governance-mode-refresher.handler",
        code: lambda.Code.fromAsset("dist/lambda"),
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
        logGroup: new logs.LogGroup(this, "GovernanceModeRefresherFnLogs", {
          retention: logs.RetentionDays.ONE_WEEK,
          removalPolicy: cdk.RemovalPolicy.DESTROY,
        }),
        deadLetterQueueEnabled: true,
        deadLetterQueue: arbiterAsyncDlq,
      },
    );

    // IAM: GetFunctionConfiguration + UpdateFunctionConfiguration scoped
    // to the exact ARNs of the governance-aware functions in the env-var
    // list above. As that list grows, add the corresponding ARNs here.
    governanceModeRefresherFn.addToRolePolicy(
      new iam.PolicyStatement({
        effect: iam.Effect.ALLOW,
        actions: [
          "lambda:GetFunctionConfiguration",
          "lambda:UpdateFunctionConfiguration",
        ],
        resources: [
          governanceUiResolverFn.functionArn,
          // TODO(Wave 3.B+): add additional governance-aware Lambda ARNs
          // here as they adopt governance-flag.ts (Supervisor,
          // worker-wrapper, fabricator, etc.) and are appended to the
          // GOVERNANCE_AWARE_FUNCTIONS env var above.
        ],
      }),
    );

    // CloudWatch metrics — the Citadel/Governance/Refresher namespace
    // does not support resource-level scoping (PutMetricData has no
    // resource ARN). The action stays narrow because the resolver
    // emits only into this single namespace.
    governanceModeRefresherFn.addToRolePolicy(
      new iam.PolicyStatement({
        effect: iam.Effect.ALLOW,
        actions: ["cloudwatch:PutMetricData"],
        resources: ["*"],
      }),
    );
    NagSuppressions.addResourceSuppressions(
      governanceModeRefresherFn.role!,
      [
        {
          id: "AwsSolutions-IAM5",
          reason:
            "cloudwatch:PutMetricData has no resource-level scoping; the " +
            "governance-mode-refresher Lambda narrows the call to the " +
            "Citadel/Governance/Refresher namespace and only emits " +
            "RefreshAttempt / RefreshSuccess / RefreshFailure counters.",
          appliesTo: ["Resource::*"],
        },
      ],
      true,
    );

    // EventBridge rule on the agent event bus — fires on every
    // governance.mode.transition event emitted by setGovernanceMode.
    const governanceModeTransitionRule = new events.Rule(
      this,
      "GovernanceModeTransitionRule",
      {
        eventBus: props.agentEventBus,
        ruleName: `citadel-governance-mode-transition-${props.environment}`,
        description:
          "Triggers the governance-mode-refresher Lambda on every governance.mode.transition event.",
        eventPattern: {
          source: ["citadel.governance"],
          detailType: ["governance.mode.transition"],
        },
      },
    );
    governanceModeTransitionRule.addTarget(
      new targets.LambdaFunction(governanceModeRefresherFn),
    );

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
      const governanceFindingFanoutDLQ = new Queue(
        this,
        "GovernanceFindingFanoutDLQ",
        {
          queueName: `citadel-governance-finding-fanout-dlq-${props.environment}`,
          retentionPeriod: cdk.Duration.days(14),
          encryption: cdk.aws_sqs.QueueEncryption.SQS_MANAGED,
          enforceSSL: true,
        },
      );
      // The DLQ is itself the dead-letter target for the
      // EventSourceMapping; suppressing AwsSolutions-SQS3 here is the
      // standard pattern (a DLQ for a DLQ would create an infinite
      // failure regress and accomplish nothing).
      NagSuppressions.addResourceSuppressions(governanceFindingFanoutDLQ, [
        {
          id: "AwsSolutions-SQS3",
          reason:
            "This queue IS the dead-letter destination for the " +
            "governance-finding-fanout DDB stream EventSourceMapping. " +
            "A DLQ for a DLQ would loop on its own failures.",
        },
      ]);

      const governanceFindingFanoutFn = new lambda.Function(
        this,
        "GovernanceFindingFanoutFn",
        {
          runtime: lambda.Runtime.NODEJS_24_X,
          handler: "governance-finding-fanout.handler",
          code: lambda.Code.fromAsset("dist/lambda"),
          timeout: cdk.Duration.seconds(30),
          // Keep the Lambda small — it only signs + posts a single GraphQL
          // mutation per record. 256MB handles up to ~10 INSERT records
          // per batch comfortably.
          memorySize: 256,
          environment: {
            ENVIRONMENT: props.environment,
            APPSYNC_ENDPOINT: props.appSyncApi.graphqlUrl,
          },
          logGroup: new logs.LogGroup(this, "GovernanceFindingFanoutFnLogs", {
            retention: logs.RetentionDays.ONE_WEEK,
            removalPolicy: cdk.RemovalPolicy.DESTROY,
          }),
        },
      );

      // appsync:GraphQL grant scoped to the single mutation field. The
      // ARN format `${apiArn}/types/Mutation/fields/<field>` is per
      // AppSync's IAM authorization spec — broader scopes (e.g. the
      // whole API arn) would let this Lambda call any other mutation,
      // which is unnecessary.
      governanceFindingFanoutFn.addToRolePolicy(
        new iam.PolicyStatement({
          effect: iam.Effect.ALLOW,
          actions: ["appsync:GraphQL"],
          resources: [
            `${props.appSyncApi.arn}/types/Mutation/fields/publishGovernanceFinding`,
          ],
        }),
      );

      // CloudWatch PutMetricData has no resource-level scoping; the
      // Lambda narrows the call to a single namespace + metric name.
      governanceFindingFanoutFn.addToRolePolicy(
        new iam.PolicyStatement({
          effect: iam.Effect.ALLOW,
          actions: ["cloudwatch:PutMetricData"],
          resources: ["*"],
        }),
      );
      NagSuppressions.addResourceSuppressions(
        governanceFindingFanoutFn.role!,
        [
          {
            id: "AwsSolutions-IAM5",
            reason:
              "cloudwatch:PutMetricData has no resource-level scoping; the " +
              "governance-finding-fanout Lambda narrows the call to the " +
              "Citadel/Governance/Fanout namespace and only emits the " +
              "PublishFailure counter.",
            appliesTo: ["Resource::*"],
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
      new lambda.EventSourceMapping(
        this,
        "GovernanceFindingFanoutEventSourceMapping",
        {
          target: governanceFindingFanoutFn,
          eventSourceArn: this.governanceLedgerTable.tableStreamArn,
          startingPosition: lambda.StartingPosition.LATEST,
          batchSize: 10,
          retryAttempts: 2,
          onFailure: new cdk.aws_lambda_event_sources.SqsDlq(
            governanceFindingFanoutDLQ,
          ),
          // EventSourceMapping FilterCriteria narrows the trigger to INSERT
          // events only. The handler also defensively checks
          // record.eventName so a future filter-criteria change (e.g.
          // backfill replay) doesn't accidentally project a MODIFY/REMOVE
          // row.
          filters: [
            lambda.FilterCriteria.filter({
              eventName: lambda.FilterRule.isEqual("INSERT"),
            }),
          ],
        },
      );

      // Grant the Lambda permission to read the DDB stream. CDK's
      // EventSourceMapping wires the trigger but does not implicitly
      // grant the read permission on the stream ARN — that requires
      // an explicit IAM statement.
      governanceFindingFanoutFn.addToRolePolicy(
        new iam.PolicyStatement({
          effect: iam.Effect.ALLOW,
          actions: [
            "dynamodb:DescribeStream",
            "dynamodb:GetRecords",
            "dynamodb:GetShardIterator",
            "dynamodb:ListStreams",
          ],
          resources: [`${this.governanceLedgerTable.tableArn}/stream/*`],
        }),
      );
      // The /stream/* suffix is unavoidable: the stream ARN includes a
      // timestamp suffix (e.g. /stream/2026-05-19T...) that CFN does
      // not surface at template time. The wildcard is bounded to the
      // single ledger table's stream sub-resource — broader scopes
      // (e.g. account-wide dynamodb:GetRecords) are not granted.
      NagSuppressions.addResourceSuppressions(
        governanceFindingFanoutFn.role!,
        [
          {
            id: "AwsSolutions-IAM5",
            reason:
              "DynamoDB stream ARNs include a timestamp suffix that CFN " +
              "cannot resolve at template time. The wildcard is bounded " +
              "to the governanceLedgerTable stream sub-resource via the " +
              "tableArn prefix; no other table is reachable.",
            appliesTo: [
              "Resource::<GovernanceLedgerTable6CB53D06.Arn>/stream/*",
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
