/**
 * RegistryStack — backend-stack-split phase 2 (decision 30e6d067).
 *
 * Moves the registry / agent-import / fabricator-request / fabricator-queue
 * / fabrication-event / app-CRUD-and-api-key domain out of BackendStack into
 * its own satellite stack. Follows the ProjectsStack (phase 1) / governance-
 * stack.ts precedent exactly: L1 `CfnDataSource` + `CfnResolver` attached to
 * BackendStack's AppSync API via `props.appSyncApi.apiId` (a string token),
 * each with its own `appsync.amazonaws.com`-assumable IAM role +
 * `grantInvoke`. This avoids stamping this stack's Lambda ARNs into
 * BackendStack's template, which would create a BackendStack ->
 * RegistryStack dependency edge and complete a cycle with RegistryStack ->
 * BackendStack (via the appSyncApi prop).
 *
 * functionName pinning is dropped on every moved Lambda EXCEPT
 * registryAgentRecordResolverFunction, which keeps its deterministic name
 * (`citadel-registry-agent-record-resolver-<env>`) in the pre-split
 * baseline — CFN auto-names the rest, and every invocation happens via
 * in-stack grantInvoke, never by name, so this is safe. Because the phase-1
 * design DROPS functionName pinning specifically to eliminate the
 * name-collision + delete-before-create ordering hazard, and this one
 * function IS deterministically named in the baseline, ordering here still
 * relies on `addDependency(backendStack)` in bin/app.ts (resolver-field-
 * uniqueness) PLUS the backend UPDATE_COMPLETE (name released) happening
 * before this stack's CREATE_COMPLETE — the same two-command ordering
 * discipline documented in bin/app.ts and the split-gates runbook. No other
 * moved Lambda in this stack is deterministically named.
 *
 * AgentCoreRegistry (the custom resource that provisions the external
 * bedrock-agentcore registry) STAYS in BackendStack; registryArn/registryId
 * are threaded into this stack as props (GetAtt string tokens — pinned via
 * BackendStack's existing auto-exports, not new ones).
 *
 * EXCLUSIONS (documented, not moved):
 * - agent-config-resolver / agent-config-lambda-data-source: inventory
 *   groups this under domain (a), but it was NOT named in this phase's
 *   binding scope list and several OTHER unmoved fields (ListAgentConfigs,
 *   GetAgentConfig, CreateAgentConfig, UpdateAgentConfig, DeleteAgentConfig,
 *   PublishAgentManifest, SearchAgentConfigs, SyncModelCatalog-adjacent
 *   modelConfig fields) still live on it in BackendStack. Moving it without
 *   an explicit instruction risks silently relocating fields outside the
 *   requested scope. Left in BackendStack for a future phase.
 * - gateway-registration-handler: inventory groups this under domain (c)
 *   (datastores+integrations+tools), tightly coupled to
 *   integrationResolverFunction/integrationsTable (also domain (c), not
 *   moved this phase) via shared IDEMPOTENCY_TABLE wiring and adjacent IAM
 *   grants. The task's own scope note only says "if inventory groups it
 *   here" — it does not. Left in BackendStack.
 * - publishApp / unpublishApp resolvers (PublishHandlerLambdaDataSource):
 *   these resolvers' DataSource targets `citadel-app-publish-handler-<env>`,
 *   a Lambda OWNED BY GatewayStack, imported into BackendStack by
 *   deterministic ARN via the public `addPublishHandlerResolvers()` method
 *   (called from bin/app.ts strictly AFTER GatewayStack is instantiated).
 *   Moving these two resolvers into RegistryStack would require importing
 *   a GatewayStack-owned function ARN into RegistryStack, i.e. a
 *   RegistryStack -> GatewayStack dependency edge. GatewayStack currently
 *   has no dependency on RegistryStack (or BackendStack beyond
 *   apps/bus/idempotency table props), so this edge would be acyclic in
 *   principle — but `addPublishHandlerResolvers` is invoked imperatively
 *   from bin/app.ts on the BackendStack instance specifically because the
 *   resolver's OWNING stack must exist before the gateway fn ARN is known
 *   at that call site's position in the deploy graph, and duplicating that
 *   call against a second stack would double-attach `publishApp`/
 *   `unpublishApp` (CFN-forbidden, rail 3). Kept in BackendStack as a
 *   documented exclusion — the acyclic-but-not-worth-the-churn option.
 *
 * The DynamoDB tables (Apps, Workflows, AgentConfig, ModelCatalog,
 * Idempotency) and the AgentCoreRegistry custom resource remain in
 * BackendStack and are passed in as props — moving them would trigger
 * recreation, which is unsafe. agentConfigTable is read-only here (the
 * unmoved agent-config-resolver still owns read/write).
 *
 * Contract:
 * Inputs (props): appSyncApi, agentEventBus, appsTable, workflowsTable,
 *                  agentConfigTable, modelCatalogTable, idempotencyTable,
 *                  userPool, registryArn, registryId, adrsTable,
 *                  environment, account/region (via cdk.Stack).
 * Outputs: none — this satellite is invoke-only from AppSync; no other
 *          stack imports anything from it.
 */
import * as cdk from "aws-cdk-lib";
import * as appsync from "aws-cdk-lib/aws-appsync";
// Cfn L1 AppSync constructs — used cross-stack to avoid creating data
// sources in the API owner's stack (see governance-stack.ts / projects-
// stack.ts for the same pattern).
import { aws_appsync as appsyncCfn } from "aws-cdk-lib";
import * as cognito from "aws-cdk-lib/aws-cognito";
import * as dynamodb from "aws-cdk-lib/aws-dynamodb";
import * as events from "aws-cdk-lib/aws-events";
import * as targets from "aws-cdk-lib/aws-events-targets";
import * as iam from "aws-cdk-lib/aws-iam";
import * as lambda from "aws-cdk-lib/aws-lambda";
import * as logs from "aws-cdk-lib/aws-logs";
import { Construct } from "constructs";
import { buildImportDiscoveryPolicy } from "../src/utils/agent-import-policy";

export interface RegistryStackProps extends cdk.StackProps {
  environment: string;
  appSyncApi: appsync.GraphqlApi;
  agentEventBus: events.IEventBus;
  appsTable: dynamodb.ITable;
  workflowsTable: dynamodb.ITable;
  /** Read-only here; the unmoved agent-config-resolver in BackendStack owns read/write. */
  agentConfigTable: dynamodb.ITable;
  /** Read-only here (per-agent-binding modelOverride catalog validation). */
  modelCatalogTable: dynamodb.ITable;
  idempotencyTable: dynamodb.ITable;
  userPool: cognito.IUserPool;
  /** AgentCoreRegistry custom resource stays in BackendStack; threaded as props. */
  registryArn: string;
  registryId: string;
  /** Write-only ADR creation for the import resolver's system-generated ADR. */
  adrsTable: dynamodb.ITable;
}

export class RegistryStack extends cdk.Stack {
  constructor(scope: Construct, id: string, props: RegistryStackProps) {
    super(scope, id, props);

    // These literals match the CDK L2 defaults for
    // appsync.MappingTemplate.lambdaRequest() / lambdaResult() exactly
    // (single-line JSON, default payload `$util.toJson($ctx)`) — verified
    // against node_modules/aws-cdk-lib/aws-appsync/lib/mapping-template.js
    // — so the moved resolvers' behavior (rail 7) byte-matches the
    // pre-split baseline. Identical to projects-stack.ts.
    const LAMBDA_REQUEST_MAPPING = `{"version": "2017-02-28", "operation": "Invoke", "payload": $util.toJson($ctx)}`;
    const LAMBDA_RESPONSE_MAPPING = `$util.toJson($ctx.result)`;

    // Same deterministic formula as backend-stack.ts's gatewayIdParamName
    // local const — a pure string, not a cross-stack reference. The SSM
    // parameter itself is owned/written by ServicesStack; read here via
    // ssm:GetParameter by name (same no-cross-ref mechanism as
    // gateway-registration-handler), never resolved at synth time.
    const gatewayIdParamName = `/citadel/gateway-id-${props.environment}`;

    /** Registers an appsync.amazonaws.com-assumable role + CfnDataSource for one Lambda. */
    const makeLambdaDataSource = (
      logicalPrefix: string,
      fn: lambda.IFunction,
    ): appsyncCfn.CfnDataSource => {
      const role = new iam.Role(this, `${logicalPrefix}DataSourceRole`, {
        assumedBy: new iam.ServicePrincipal("appsync.amazonaws.com"),
      });
      fn.grantInvoke(role);
      return new appsyncCfn.CfnDataSource(
        this,
        `${logicalPrefix}LambdaDataSource`,
        {
          apiId: props.appSyncApi.apiId,
          name: `${logicalPrefix}LambdaDataSource`,
          type: "AWS_LAMBDA",
          serviceRoleArn: role.roleArn,
          lambdaConfig: { lambdaFunctionArn: fn.functionArn },
        },
      );
    };

    const makeResolver = (
      logicalId: string,
      typeName: string,
      fieldName: string,
      dataSource: appsyncCfn.CfnDataSource,
    ): appsyncCfn.CfnResolver => {
      const resolver = new appsyncCfn.CfnResolver(this, logicalId, {
        apiId: props.appSyncApi.apiId,
        typeName,
        fieldName,
        dataSourceName: dataSource.attrName,
        requestMappingTemplate: LAMBDA_REQUEST_MAPPING,
        responseMappingTemplate: LAMBDA_RESPONSE_MAPPING,
      });
      resolver.addResourceDependency(dataSource);
      return resolver;
    };

    // ============================================================
    // Registry Sync (EventBridge-driven, no resolver)
    // ============================================================

    const registrySyncRule = new events.Rule(this, "RegistrySyncRule", {
      ruleName: `citadel-registry-sync-${props.environment}`,
      description:
        "Captures AgentCore Registry resource changes for DynamoDB cache sync",
      eventPattern: {
        source: ["aws.bedrock-agentcore"],
        detailType: ["AgentCore Registry Resource Change"],
        detail: {
          registryId: [props.registryId],
        },
      },
    });

    const registrySyncDlq = new cdk.aws_sqs.Queue(this, "RegistrySyncDLQ", {
      queueName: `citadel-registry-sync-dlq-${props.environment}`,
      retentionPeriod: cdk.Duration.days(14),
      enforceSSL: true,
    });

    const registrySyncLambda = new lambda.Function(this, "RegistrySyncLambda", {
      runtime: lambda.Runtime.NODEJS_24_X,
      handler: "registry-sync.handler",
      code: lambda.Code.fromAsset("dist/lambda"),
      environment: {
        AGENT_CONFIG_TABLE: props.agentConfigTable.tableName,
        TOOLS_CONFIG_TABLE: `citadel-tools-${props.environment}`,
        REGISTRY_ID: props.registryId,
      },
      timeout: cdk.Duration.seconds(30),
      logGroup: new logs.LogGroup(this, "RegistrySyncLambdaLogs", {
        retention: logs.RetentionDays.ONE_WEEK,
        removalPolicy: cdk.RemovalPolicy.DESTROY,
      }),
    });

    props.agentConfigTable.grantReadWriteData(registrySyncLambda);
    registrySyncLambda.addToRolePolicy(
      new iam.PolicyStatement({
        effect: iam.Effect.ALLOW,
        actions: [
          "dynamodb:GetItem",
          "dynamodb:PutItem",
          "dynamodb:DeleteItem",
        ],
        resources: [
          `arn:aws:dynamodb:${this.region}:${this.account}:table/citadel-tools-${props.environment}`,
        ],
      }),
    );
    registrySyncLambda.addToRolePolicy(
      new iam.PolicyStatement({
        effect: iam.Effect.ALLOW,
        actions: [
          "bedrock-agentcore:CreateRegistryRecord",
          "bedrock-agentcore:UpdateRegistryRecord",
          "bedrock-agentcore:UpdateRegistryRecordStatus",
          "bedrock-agentcore:DeleteRegistryRecord",
          "bedrock-agentcore:GetRegistryRecord",
          "bedrock-agentcore:ListRegistryRecords",
        ],
        resources: [props.registryArn, `${props.registryArn}/*`],
      }),
    );
    registrySyncDlq.grantSendMessages(registrySyncLambda);

    registrySyncRule.addTarget(
      new targets.LambdaFunction(registrySyncLambda, {
        deadLetterQueue: registrySyncDlq,
        retryAttempts: 2,
      }),
    );

    // ============================================================
    // Agent Import Resolver + Manifest Result Handler
    // ============================================================

    const agentImportResolverFunction = new lambda.Function(
      this,
      "AgentImportResolverFunction",
      {
        runtime: lambda.Runtime.NODEJS_24_X,
        handler: "agent-import-resolver.handler",
        code: lambda.Code.fromAsset("dist/lambda"),
        environment: {
          AGENT_CONFIG_TABLE: props.agentConfigTable.tableName,
          REGISTRY_ENABLED: "true",
          REGISTRY_ID: props.registryId,
          EVENT_BUS_NAME: props.agentEventBus.eventBusName,
          AUTHORITY_UNITS_TABLE: `citadel-authority-units-${props.environment}`,
          ACCOUNT_ID: this.account,
          FABRICATOR_QUEUE_URL: `https://sqs.${this.region}.amazonaws.com/${this.account}/citadel-fabricator-queue-${props.environment}`,
          ADRS_TABLE: props.adrsTable.tableName,
          GATEWAY_ID_PARAM: `/citadel/gateway-id-${props.environment}`,
        },
        timeout: cdk.Duration.seconds(30),
        logGroup: new logs.LogGroup(this, "AgentImportResolverFunctionLogs", {
          retention: logs.RetentionDays.ONE_WEEK,
          removalPolicy: cdk.RemovalPolicy.DESTROY,
        }),
      },
    );

    props.agentEventBus.grantPutEventsTo(agentImportResolverFunction);

    // SECURITY DISSENT VERBATIM CLAUSE: these Secrets Manager + STS
    // statements MUST remain byte-identical to the pre-split baseline
    // (backend-stack.ts AgentImportResolverFunction grants) — not merely a
    // subset. Rail 6 (IAM equivalence) checks subset-or-equal by design, so
    // a subset would pass the rail but silently under-provision the moved
    // function at runtime (e.g. dropped TagResource) without failing CI.
    // Reproduced verbatim, action-for-action, resource-for-resource:
    agentImportResolverFunction.addToRolePolicy(
      new iam.PolicyStatement({
        effect: iam.Effect.ALLOW,
        actions: ["dynamodb:PutItem", "dynamodb:UpdateItem"],
        resources: [
          `arn:aws:dynamodb:${this.region}:${this.account}:table/citadel-authority-units-${props.environment}`,
        ],
      }),
    );
    agentImportResolverFunction.addToRolePolicy(
      new iam.PolicyStatement({
        effect: iam.Effect.ALLOW,
        actions: [
          "secretsmanager:CreateSecret",
          "secretsmanager:PutSecretValue",
          "secretsmanager:TagResource",
        ],
        resources: [
          `arn:aws:secretsmanager:${this.region}:${this.account}:secret:/citadel/agents/*`,
        ],
      }),
    );
    agentImportResolverFunction.addToRolePolicy(
      new iam.PolicyStatement({
        effect: iam.Effect.ALLOW,
        actions: [
          "bedrock-agentcore:InvokeAgentRuntime",
          "lambda:InvokeFunction",
          "bedrock:InvokeAgent",
          "execute-api:Invoke",
        ],
        resources: [
          `arn:aws:bedrock-agentcore:*:${this.account}:runtime/*`,
          `arn:aws:lambda:*:${this.account}:function:*`,
          `arn:aws:bedrock:*:${this.account}:agent-alias/*`,
          `arn:aws:execute-api:*:${this.account}:*`,
        ],
      }),
    );
    agentImportResolverFunction.addToRolePolicy(
      new iam.PolicyStatement({
        effect: iam.Effect.ALLOW,
        actions: ["secretsmanager:GetSecretValue"],
        resources: [
          `arn:aws:secretsmanager:${this.region}:${this.account}:secret:/citadel/agents/*`,
        ],
      }),
    );
    // Verbatim STS statement (cross-account trust-path assume). Action set
    // (["sts:AssumeRole"]) and Resource (["arn:aws:iam::*:role/*"]) match the
    // baseline exactly — no narrowing, no widening.
    agentImportResolverFunction.addToRolePolicy(
      new iam.PolicyStatement({
        effect: iam.Effect.ALLOW,
        actions: ["sts:AssumeRole"],
        resources: ["arn:aws:iam::*:role/*"],
      }),
    );
    agentImportResolverFunction.addToRolePolicy(
      new iam.PolicyStatement({
        effect: iam.Effect.ALLOW,
        actions: ["sqs:SendMessage"],
        resources: [
          `arn:aws:sqs:${this.region}:${this.account}:citadel-fabricator-queue-${props.environment}`,
        ],
      }),
    );

    // Same DynamoDB + Registry grants as agent-config-resolver (baseline:
    // the import resolver reuses RegistryService). The baseline backend-
    // stack.ts grants this Registry CRUD action set TWICE (once near the
    // function's construction, once again later in the constructor) —
    // functionally idempotent (IAM policy statements dedupe), reproduced
    // ONCE here since a second identical addToRolePolicy call is a no-op
    // for the synthesized policy document.
    props.agentConfigTable.grantReadWriteData(agentImportResolverFunction);
    agentImportResolverFunction.addToRolePolicy(
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
        resources: [props.registryArn, `${props.registryArn}/*`],
      }),
    );

    // Read-only discovery permissions for discoverAgents/describeAgentCandidate
    // (buildImportDiscoveryPolicy — single source of truth for the List/
    // Describe/Get actions across the phase-1 substrates). Reproduced
    // verbatim from the baseline.
    for (const statement of buildImportDiscoveryPolicy().Statement) {
      agentImportResolverFunction.addToRolePolicy(
        new iam.PolicyStatement({
          effect: iam.Effect.ALLOW,
          actions: statement.Action,
          resources: statement.Resource,
        }),
      );
    }

    // US-IMP-018/019/020 companion ELBv2 Describe actions (ECS/EKS/EC2
    // endpoint-resolution discovery substrates). Verbatim from baseline.
    agentImportResolverFunction.addToRolePolicy(
      new iam.PolicyStatement({
        effect: iam.Effect.ALLOW,
        actions: [
          "elasticloadbalancing:DescribeTargetGroups",
          "elasticloadbalancing:DescribeTargetHealth",
          "elasticloadbalancing:DescribeLoadBalancers",
          "elasticloadbalancing:DescribeTags",
        ],
        resources: ["*"],
      }),
    );

    // US-IMP-031: MCP Gateway publish/unpublish (publishImportToGateway /
    // unpublishImportFromGateway). Verbatim from baseline: gateway-target
    // create/delete + API-key credential-provider lifecycle (scoped to the
    // integration-* provider namespace) + read of the gateway-id SSM
    // parameter owned by ServicesStack (deterministic name, no cross-stack
    // construct import — same no-cross-ref mechanism as
    // gateway-registration-handler).
    agentImportResolverFunction.addToRolePolicy(
      new iam.PolicyStatement({
        effect: iam.Effect.ALLOW,
        actions: [
          "bedrock-agentcore:CreateGatewayTarget",
          "bedrock-agentcore:DeleteGatewayTarget",
        ],
        resources: [
          `arn:aws:bedrock-agentcore:${this.region}:${this.account}:gateway/*`,
          `arn:aws:bedrock-agentcore:${this.region}:${this.account}:gateway/*/target/*`,
        ],
      }),
    );
    agentImportResolverFunction.addToRolePolicy(
      new iam.PolicyStatement({
        effect: iam.Effect.ALLOW,
        actions: [
          "bedrock-agentcore:CreateApiKeyCredentialProvider",
          "bedrock-agentcore:UpdateApiKeyCredentialProvider",
          "bedrock-agentcore:DeleteApiKeyCredentialProvider",
        ],
        resources: [
          `arn:aws:bedrock-agentcore:${this.region}:${this.account}:credential-provider/integration-*`,
        ],
      }),
    );
    agentImportResolverFunction.addToRolePolicy(
      new iam.PolicyStatement({
        effect: iam.Effect.ALLOW,
        actions: ["ssm:GetParameter"],
        resources: [
          `arn:aws:ssm:${this.region}:${this.account}:parameter${gatewayIdParamName}`,
        ],
      }),
    );

    // Write-only ADR creation for the import resolver's system-generated ADR
    // keyed to the synthetic GLOBAL import project (createADR -> PutItem,
    // never read). Verbatim from baseline.
    props.adrsTable.grantWriteData(agentImportResolverFunction);

    const agentImportManifestResultHandler = new lambda.Function(
      this,
      "AgentImportManifestResultHandler",
      {
        runtime: lambda.Runtime.NODEJS_24_X,
        handler: "agent-import-manifest-result-handler.handler",
        code: lambda.Code.fromAsset("dist/lambda"),
        environment: {
          REGISTRY_ENABLED: "true",
          REGISTRY_ID: props.registryId,
          IDEMPOTENCY_TABLE: props.idempotencyTable.tableName,
        },
        timeout: cdk.Duration.seconds(30),
        logGroup: new logs.LogGroup(
          this,
          "AgentImportManifestResultHandlerLogs",
          {
            retention: logs.RetentionDays.ONE_WEEK,
            removalPolicy: cdk.RemovalPolicy.DESTROY,
          },
        ),
      },
    );

    props.idempotencyTable.grantReadWriteData(agentImportManifestResultHandler);
    agentImportManifestResultHandler.addToRolePolicy(
      new iam.PolicyStatement({
        effect: iam.Effect.ALLOW,
        actions: [
          "bedrock-agentcore:GetRegistryRecord",
          "bedrock-agentcore:UpdateRegistryRecord",
        ],
        resources: [props.registryArn, `${props.registryArn}/*`],
      }),
    );

    const agentImportManifestResultRule = new events.Rule(
      this,
      "AgentImportManifestResultRule",
      {
        eventBus: props.agentEventBus,
        ruleName: `citadel-agent-import-manifest-result-${props.environment}`,
        description:
          "Routes async LLM-proposed agent-import manifest results (proposed/failed) to the result handler",
        eventPattern: {
          detailType: [
            "agent.import.manifest.proposed",
            "agent.import.manifest.failed",
          ],
        },
      },
    );
    agentImportManifestResultRule.addTarget(
      new targets.LambdaFunction(agentImportManifestResultHandler, {
        retryAttempts: 2,
        maxEventAge: cdk.Duration.hours(2),
      }),
    );

    const agentImportLambdaDataSource = makeLambdaDataSource(
      "AgentImport",
      agentImportResolverFunction,
    );

    makeResolver(
      "ImportAgentResolver",
      "Mutation",
      "importAgent",
      agentImportLambdaDataSource,
    );
    makeResolver(
      "AttestAgentImportResolver",
      "Mutation",
      "attestAgentImport",
      agentImportLambdaDataSource,
    );
    makeResolver(
      "DiscoverAgentsResolver",
      "Query",
      "discoverAgents",
      agentImportLambdaDataSource,
    );
    makeResolver(
      "DescribeAgentCandidateResolver",
      "Query",
      "describeAgentCandidate",
      agentImportLambdaDataSource,
    );
    makeResolver(
      "TestImportedAgentResolver",
      "Mutation",
      "testImportedAgent",
      agentImportLambdaDataSource,
    );
    makeResolver(
      "ProbeAgentCandidateResolver",
      "Mutation",
      "probeAgentCandidate",
      agentImportLambdaDataSource,
    );
    makeResolver(
      "ProbeImportReachabilityResolver",
      "Mutation",
      "probeImportReachability",
      agentImportLambdaDataSource,
    );
    makeResolver(
      "ProposeAgentManifestTier3Resolver",
      "Mutation",
      "proposeAgentManifestTier3",
      agentImportLambdaDataSource,
    );
    makeResolver(
      "AcceptProposedManifestTier3Resolver",
      "Mutation",
      "acceptProposedManifestTier3",
      agentImportLambdaDataSource,
    );
    makeResolver(
      "PublishImportToGatewayResolver",
      "Mutation",
      "publishImportToGateway",
      agentImportLambdaDataSource,
    );
    makeResolver(
      "UnpublishImportFromGatewayResolver",
      "Mutation",
      "unpublishImportFromGateway",
      agentImportLambdaDataSource,
    );

    // ============================================================
    // Agent Code Resolver
    // ============================================================

    const agentCodeResolverFunction = new lambda.Function(
      this,
      "AgentCodeResolverFunction",
      {
        runtime: lambda.Runtime.NODEJS_24_X,
        handler: "agent-code-resolver.handler",
        code: lambda.Code.fromAsset("dist/lambda"),
        environment: {
          AGENT_BUCKET_NAME: `citadel-code-${props.environment}-${this.account}-${this.region}`,
          AGENT_CONFIG_TABLE: props.agentConfigTable.tableName,
        },
        timeout: cdk.Duration.seconds(30),
        logGroup: new logs.LogGroup(this, "AgentCodeResolverFunctionLogs", {
          retention: logs.RetentionDays.ONE_WEEK,
          removalPolicy: cdk.RemovalPolicy.DESTROY,
        }),
      },
    );

    // S3 permissions for agent code — baseline grants by explicit,
    // deterministic ARN STRING (account/region interpolated, same pattern
    // as document-upload-resolver's INGESTION_TABLE ARN in projects-
    // stack.ts) rather than `props.codeBucket.bucketArn`, which would
    // render as a cross-stack Fn::ImportValue/GetAtt token — functionally
    // equivalent at deploy time (same bucket, same account/region) but NOT
    // byte-identical to the baseline's literal-string resources, which
    // would make rail 6 (IAM equivalence) report a false-positive
    // divergence. Reproduced verbatim (action set + resource scope).
    agentCodeResolverFunction.addToRolePolicy(
      new iam.PolicyStatement({
        effect: iam.Effect.ALLOW,
        actions: [
          "s3:GetObject",
          "s3:PutObject",
          "s3:GetObjectVersion",
          "s3:ListBucket",
        ],
        resources: [
          `arn:aws:s3:::citadel-code-${props.environment}-${this.account}-${this.region}`,
          `arn:aws:s3:::citadel-code-${props.environment}-${this.account}-${this.region}/agents/*`,
        ],
      }),
    );
    props.agentConfigTable.grantReadData(agentCodeResolverFunction);

    const agentCodeLambdaDataSource = makeLambdaDataSource(
      "AgentCode",
      agentCodeResolverFunction,
    );

    makeResolver(
      "GetAgentCodeResolver",
      "Query",
      "getAgentCode",
      agentCodeLambdaDataSource,
    );
    makeResolver(
      "UpdateAgentCodeResolver",
      "Mutation",
      "updateAgentCode",
      agentCodeLambdaDataSource,
    );

    // ============================================================
    // Fabricator Request + Queue Resolvers
    // ============================================================

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
        logGroup: new logs.LogGroup(
          this,
          "FabricatorRequestResolverFunctionLogs",
          {
            retention: logs.RetentionDays.ONE_WEEK,
            removalPolicy: cdk.RemovalPolicy.DESTROY,
          },
        ),
      },
    );

    fabricatorRequestResolverFunction.addToRolePolicy(
      new iam.PolicyStatement({
        effect: iam.Effect.ALLOW,
        actions: ["sqs:SendMessage", "sqs:GetQueueUrl"],
        resources: [
          `arn:aws:sqs:${this.region}:${this.account}:citadel-fabricator-queue-${props.environment}`,
        ],
      }),
    );

    // FabricationJobsTable (durable per-agent fabrication status) STAYS in
    // BackendStack — it is the dependency root consumed by ServicesStack's
    // intake runtime and ArbiterStack's fabricator Lambda too, so moving it
    // would require re-threading it through three stacks and risks
    // recreation. Referenced here by the SAME deterministic name +
    // constructed ARN pattern the baseline already uses for those other
    // cross-stack consumers (no circular dependency). Least privilege: the
    // request resolver only writes PENDING rows.
    const fabricationJobsTableArn = `arn:aws:dynamodb:${this.region}:${this.account}:table/citadel-fabrication-jobs-${props.environment}`;
    fabricatorRequestResolverFunction.addToRolePolicy(
      new iam.PolicyStatement({
        effect: iam.Effect.ALLOW,
        actions: ["dynamodb:PutItem"],
        resources: [fabricationJobsTableArn],
      }),
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
        logGroup: new logs.LogGroup(
          this,
          "FabricatorQueueResolverFunctionLogs",
          {
            retention: logs.RetentionDays.ONE_WEEK,
            removalPolicy: cdk.RemovalPolicy.DESTROY,
          },
        ),
      },
    );

    fabricatorQueueResolverFunction.addToRolePolicy(
      new iam.PolicyStatement({
        effect: iam.Effect.ALLOW,
        actions: ["sqs:ReceiveMessage", "sqs:GetQueueAttributes"],
        resources: [
          `arn:aws:sqs:${this.region}:${this.account}:citadel-fabricator-queue-${props.environment}`,
        ],
      }),
    );
    // Least privilege: the queue resolver only reads (Query for a given
    // project, Scan otherwise) — matches the baseline exactly.
    fabricatorQueueResolverFunction.addToRolePolicy(
      new iam.PolicyStatement({
        effect: iam.Effect.ALLOW,
        actions: ["dynamodb:Query", "dynamodb:Scan"],
        resources: [fabricationJobsTableArn],
      }),
    );

    const fabricatorRequestLambdaDataSource = makeLambdaDataSource(
      "FabricatorRequest",
      fabricatorRequestResolverFunction,
    );
    const fabricatorQueueLambdaDataSource = makeLambdaDataSource(
      "FabricatorQueue",
      fabricatorQueueResolverFunction,
    );

    makeResolver(
      "RequestAgentCreationResolver",
      "Mutation",
      "requestAgentCreation",
      fabricatorRequestLambdaDataSource,
    );
    makeResolver(
      "RequestToolCreationResolver",
      "Mutation",
      "requestToolCreation",
      fabricatorRequestLambdaDataSource,
    );
    makeResolver(
      "GetFabricatorQueueResolver",
      "Query",
      "getFabricatorQueue",
      fabricatorQueueLambdaDataSource,
    );

    // ============================================================
    // Fabrication Event Handler + Resolver + Rule
    // ============================================================

    const fabricationEventHandlerFunction = new lambda.Function(
      this,
      "FabricationEventHandlerFunction",
      {
        runtime: lambda.Runtime.NODEJS_24_X,
        handler: "fabrication-event-handler.handler",
        code: lambda.Code.fromAsset("dist/lambda"),
        environment: {
          APPSYNC_ENDPOINT: props.appSyncApi.graphqlUrl,
        },
        timeout: cdk.Duration.seconds(30),
        logGroup: new logs.LogGroup(
          this,
          "FabricationEventHandlerFunctionLogs",
          {
            retention: logs.RetentionDays.ONE_WEEK,
            removalPolicy: cdk.RemovalPolicy.DESTROY,
          },
        ),
      },
    );

    fabricationEventHandlerFunction.addToRolePolicy(
      new iam.PolicyStatement({
        effect: iam.Effect.ALLOW,
        actions: ["appsync:GraphQL"],
        resources: [
          `${props.appSyncApi.arn}/types/Mutation/fields/publishFabricationEvent`,
        ],
      }),
    );

    const fabricationEventLambdaDataSource = makeLambdaDataSource(
      "FabricationEvent",
      fabricationEventHandlerFunction,
    );

    makeResolver(
      "PublishFabricationEventResolver",
      "Mutation",
      "publishFabricationEvent",
      fabricationEventLambdaDataSource,
    );

    // The FabricationEventRule (agent.fabricated / agent.fabrication.failed on
    // the shared bus, targeting fabricationEventHandlerFunction) belongs here
    // per the task's explicit scope note ("the phase-1 exclusion that
    // belongs here") — it was left in BackendStack during phase 1 because
    // its target function moves in this phase, not phase 1.
    const fabricationEventRule = new events.Rule(this, "FabricationEventRule", {
      eventBus: props.agentEventBus,
      ruleName: `citadel-fabrication-${props.environment}`,
      description: "Captures agent fabrication completion and error events",
      eventPattern: {
        source: ["agent.fabricated", "agent.fabrication.failed"],
      },
    });

    fabricationEventRule.addTarget(
      new targets.LambdaFunction(fabricationEventHandlerFunction, {
        retryAttempts: 2,
        maxEventAge: cdk.Duration.hours(2),
      }),
    );

    // ============================================================
    // Registry Agent Record Resolver (the 28-field hot resolver) —
    // App CRUD, workflow binding, config, API keys, access control, metrics.
    // ============================================================

    const registryAgentRecordResolverFunction = new lambda.Function(
      this,
      "RegistryAgentRecordResolverFunction",
      {
        runtime: lambda.Runtime.NODEJS_24_X,
        handler: "registry-agent-record-resolver.handler",
        code: lambda.Code.fromAsset("dist/lambda"),
        functionName: `citadel-registry-agent-record-resolver-${props.environment}`,
        environment: {
          APPS_TABLE: props.appsTable.tableName,
          WORKFLOWS_TABLE: props.workflowsTable.tableName,
          AGENT_CONFIG_TABLE: props.agentConfigTable.tableName,
          EVENT_BUS_NAME: props.agentEventBus.eventBusName,
          USER_POOL_ID: props.userPool.userPoolId,
          REGISTRY_ID: props.registryId,
          AUTHORITY_UNITS_TABLE: `citadel-authority-units-${props.environment}`,
          MODEL_CATALOG_TABLE: props.modelCatalogTable.tableName,
          ENVIRONMENT: props.environment,
        },
        timeout: cdk.Duration.seconds(30),
        logGroup: new logs.LogGroup(
          this,
          "RegistryAgentRecordResolverFunctionLogs",
          {
            retention: logs.RetentionDays.ONE_WEEK,
            removalPolicy: cdk.RemovalPolicy.DESTROY,
          },
        ),
      },
    );

    props.appsTable.grantReadWriteData(registryAgentRecordResolverFunction);
    props.workflowsTable.grantReadWriteData(
      registryAgentRecordResolverFunction,
    );
    props.agentConfigTable.grantReadData(registryAgentRecordResolverFunction);
    props.modelCatalogTable.grantReadData(registryAgentRecordResolverFunction);
    props.agentEventBus.grantPutEventsTo(registryAgentRecordResolverFunction);
    registryAgentRecordResolverFunction.addToRolePolicy(
      new iam.PolicyStatement({
        effect: iam.Effect.ALLOW,
        actions: ["dynamodb:PutItem", "dynamodb:UpdateItem"],
        resources: [
          `arn:aws:dynamodb:${this.region}:${this.account}:table/citadel-authority-units-${props.environment}`,
        ],
      }),
    );
    registryAgentRecordResolverFunction.addToRolePolicy(
      new iam.PolicyStatement({
        effect: iam.Effect.ALLOW,
        actions: ["cognito-idp:AdminGetUser"],
        resources: [props.userPool.userPoolArn],
      }),
    );
    registryAgentRecordResolverFunction.addToRolePolicy(
      new iam.PolicyStatement({
        effect: iam.Effect.ALLOW,
        actions: [
          "iam:CreateRole",
          "iam:DeleteRole",
          "iam:PutRolePolicy",
          "iam:DeleteRolePolicy",
          "iam:GetRole",
          "iam:PassRole",
          "iam:TagRole",
          "iam:UntagRole",
        ],
        resources: [`arn:aws:iam::${this.account}:role/citadel-agent-*`],
      }),
    );
    registryAgentRecordResolverFunction.addToRolePolicy(
      new iam.PolicyStatement({
        effect: iam.Effect.ALLOW,
        actions: ["sts:GetCallerIdentity"],
        resources: ["*"],
      }),
    );
    registryAgentRecordResolverFunction.addToRolePolicy(
      new iam.PolicyStatement({
        effect: iam.Effect.ALLOW,
        actions: ["ssm:GetParameter"],
        resources: [
          `arn:aws:ssm:${this.region}:${this.account}:parameter/citadel/${props.environment}/app-api-key-pepper`,
        ],
      }),
    );
    registryAgentRecordResolverFunction.addToRolePolicy(
      new iam.PolicyStatement({
        effect: iam.Effect.ALLOW,
        actions: ["kms:Decrypt"],
        resources: [`arn:aws:kms:${this.region}:${this.account}:alias/aws/ssm`],
      }),
    );
    registryAgentRecordResolverFunction.addToRolePolicy(
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
        resources: [props.registryArn, `${props.registryArn}/*`],
      }),
    );

    const registryAgentRecordLambdaDataSource = makeLambdaDataSource(
      "RegistryAgentRecord",
      registryAgentRecordResolverFunction,
    );

    // App CRUD
    makeResolver(
      "GetAppResolver",
      "Query",
      "getApp",
      registryAgentRecordLambdaDataSource,
    );
    makeResolver(
      "ListAppsResolver",
      "Query",
      "listApps",
      registryAgentRecordLambdaDataSource,
    );
    makeResolver(
      "CreateAppResolver",
      "Mutation",
      "createApp",
      registryAgentRecordLambdaDataSource,
    );
    makeResolver(
      "UpdateAppResolver",
      "Mutation",
      "updateApp",
      registryAgentRecordLambdaDataSource,
    );
    makeResolver(
      "DeleteAppResolver",
      "Mutation",
      "deleteApp",
      registryAgentRecordLambdaDataSource,
    );
    makeResolver(
      "BindWorkflowToAppResolver",
      "Mutation",
      "bindWorkflowToApp",
      registryAgentRecordLambdaDataSource,
    );
    makeResolver(
      "UnbindWorkflowFromAppResolver",
      "Mutation",
      "unbindWorkflowFromApp",
      registryAgentRecordLambdaDataSource,
    );
    makeResolver(
      "UpdateAgentBindingResolver",
      "Mutation",
      "updateAgentBinding",
      registryAgentRecordLambdaDataSource,
    );
    makeResolver(
      "AddAppComponentResolver",
      "Mutation",
      "addAppComponent",
      registryAgentRecordLambdaDataSource,
    );
    makeResolver(
      "RemoveAppComponentResolver",
      "Mutation",
      "removeAppComponent",
      registryAgentRecordLambdaDataSource,
    );
    makeResolver(
      "SetAppConfigSchemaResolver",
      "Mutation",
      "setAppConfigSchema",
      registryAgentRecordLambdaDataSource,
    );
    makeResolver(
      "SetAppConfigValuesResolver",
      "Mutation",
      "setAppConfigValues",
      registryAgentRecordLambdaDataSource,
    );
    makeResolver(
      "PublishAppStatusEventResolver",
      "Mutation",
      "publishAppStatusEvent",
      registryAgentRecordLambdaDataSource,
    );

    // App API-key management surface
    makeResolver(
      "CreateAppApiKeyResolver",
      "Mutation",
      "createAppApiKey",
      registryAgentRecordLambdaDataSource,
    );
    makeResolver(
      "RevokeAppApiKeyResolver",
      "Mutation",
      "revokeAppApiKey",
      registryAgentRecordLambdaDataSource,
    );
    makeResolver(
      "RotateAppApiKeyResolver",
      "Mutation",
      "rotateAppApiKey",
      registryAgentRecordLambdaDataSource,
    );
    makeResolver(
      "ListAppApiKeysResolver",
      "Query",
      "listAppApiKeys",
      registryAgentRecordLambdaDataSource,
    );

    // Auth config
    makeResolver(
      "SetAppAuthConfigResolver",
      "Mutation",
      "setAppAuthConfig",
      registryAgentRecordLambdaDataSource,
    );

    // Access control
    makeResolver(
      "GrantAppAccessResolver",
      "Mutation",
      "grantAppAccess",
      registryAgentRecordLambdaDataSource,
    );
    makeResolver(
      "RevokeAppAccessResolver",
      "Mutation",
      "revokeAppAccess",
      registryAgentRecordLambdaDataSource,
    );
    makeResolver(
      "ListAppAccessEntriesResolver",
      "Query",
      "listAppAccessEntries",
      registryAgentRecordLambdaDataSource,
    );

    // Metrics
    makeResolver(
      "GetAppMetricsResolver",
      "Query",
      "getAppMetrics",
      registryAgentRecordLambdaDataSource,
    );

    // cdk-nag suppressions for this stack's IAM4/IAM5 findings are applied
    // centrally in bin/app.ts via the shared `appLambdaSuppressions` stack
    // loop (same pattern backend/projects/services/arbiter/frontend/gateway
    // use) — no new suppression categories introduced here, per the
    // design's rail 5 requirement. Registry-ARN-wildcard suppressions for
    // RegistryAgentRecordResolverFunction / AgentImportResolverFunction /
    // AgentImportManifestResultHandler / registrySyncLambda are re-pointed
    // at this stack's paths in bin/app.ts.
  }
}
