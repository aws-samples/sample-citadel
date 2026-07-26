/**
 * ProjectsStack — backend-stack-split phase 1 (decision 30e6d067).
 *
 * Moves the projects / conversations / documents / assessment /
 * design-progress / planning / chatter domain out of BackendStack into its
 * own satellite stack. Follows the governance-stack.ts precedent exactly:
 * L1 `CfnDataSource` + `CfnResolver` attached to BackendStack's AppSync API
 * via `props.appSyncApi.apiId` (a string token), each with its own
 * `appsync.amazonaws.com`-assumable IAM role + `grantInvoke`. This avoids
 * stamping this stack's Lambda ARNs into BackendStack's template, which
 * would create a BackendStack -> ProjectsStack dependency edge and complete
 * a cycle with ProjectsStack -> BackendStack (via the appSyncApi prop).
 *
 * functionName pinning is dropped on every moved Lambda (per the binding
 * design decision) — CFN auto-names them, and every invocation happens via
 * in-stack grantInvoke, never by name. This eliminates both the
 * `citadel-*-<env>` name collision with the (to-be-removed) backend copies
 * and the delete-before-create ordering dependency; the only remaining
 * cross-stack ordering requirement is resolver-field-uniqueness, enforced by
 * `addDependency(backendStack)` in bin/app.ts.
 *
 * The DynamoDB tables (Projects, Conversations, AgentStatus) and the
 * governance-gate tables (ADRs, ExecutionSpecifications,
 * AgentDesignAssessments) remain in BackendStack and are passed in as
 * props — moving them would trigger table recreation, which is unsafe.
 * agentStatusTable specifically stays in BackendStack because it is also
 * read/written by the unmoved agentMessageHandlerFunction.
 *
 * Contract:
 * Inputs (props): appSyncApi, agentEventBus, projectsTable,
 *                 conversationsTable, agentStatusTable, documentBucket,
 *                 adrsTable, executionSpecificationsTable,
 *                 agentDesignAssessmentsTable, idempotencyTable, userPool.
 * Outputs: none — this satellite is invoke-only from AppSync; no other
 *          stack imports anything from it.
 */
import * as cdk from "aws-cdk-lib";
import * as appsync from "@aws-cdk/aws-appsync-alpha";
// Cfn L1 AppSync constructs — used cross-stack to avoid creating data
// sources in the API owner's stack (see governance-stack.ts for the same
// pattern, applied there to the governance domain).
import { aws_appsync as appsyncCfn } from "aws-cdk-lib";
import * as cloudwatch from "aws-cdk-lib/aws-cloudwatch";
import * as cognito from "aws-cdk-lib/aws-cognito";
import * as dynamodb from "aws-cdk-lib/aws-dynamodb";
import * as events from "aws-cdk-lib/aws-events";
import * as targets from "aws-cdk-lib/aws-events-targets";
import * as iam from "aws-cdk-lib/aws-iam";
import * as lambda from "aws-cdk-lib/aws-lambda";
import * as logs from "aws-cdk-lib/aws-logs";
import { Bucket } from "aws-cdk-lib/aws-s3";
import { Construct } from "constructs";

export interface ProjectsStackProps extends cdk.StackProps {
  environment: string;
  appSyncApi: appsync.GraphqlApi;
  agentEventBus: events.IEventBus;
  projectsTable: dynamodb.ITable;
  conversationsTable: dynamodb.ITable;
  /** Shared with the unmoved agentMessageHandlerFunction; stays in BackendStack. */
  agentStatusTable: dynamodb.ITable;
  documentBucket: Bucket;
  idempotencyTable: dynamodb.ITable;
  /** Governance-gate tables (C3/C7/C10) — owned by BackendStack, RETAIN policy. */
  adrsTable: dynamodb.ITable;
  executionSpecificationsTable: dynamodb.ITable;
  agentDesignAssessmentsTable: dynamodb.ITable;
  userPool: cognito.IUserPool;
}

export class ProjectsStack extends cdk.Stack {
  constructor(scope: Construct, id: string, props: ProjectsStackProps) {
    super(scope, id, props);

    // These literals match the CDK L2 defaults for
    // appsync.MappingTemplate.lambdaRequest() / lambdaResult() exactly
    // (single-line JSON, default payload `$util.toJson($ctx)`) — verified
    // against node_modules/@aws-cdk/aws-appsync-alpha/lib/mapping-template.js
    // — so the moved resolvers' behavior (rail 7) byte-matches the
    // pre-split baseline.
    const LAMBDA_REQUEST_MAPPING = `{"version": "2017-02-28", "operation": "Invoke", "payload": $util.toJson($ctx)}`;
    const LAMBDA_RESPONSE_MAPPING = `$util.toJson($ctx.result)`;

    /** Registers an appsync.amazonaws.com-assumable role + CfnDataSource for one Lambda, mirroring governance-stack.ts. */
    const makeLambdaDataSource = (
      logicalPrefix: string,
      fn: lambda.Function,
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
      resolver.addDependency(dataSource);
      return resolver;
    };

    // ============================================================
    // Project Resolver
    // ============================================================

    const projectResolverFunction = new lambda.Function(
      this,
      "ProjectResolverFunction",
      {
        runtime: lambda.Runtime.NODEJS_24_X,
        handler: "project-resolver.handler",
        code: lambda.Code.fromAsset("dist/lambda"),
        environment: {
          PROJECTS_TABLE: props.projectsTable.tableName,
          ENVIRONMENT: props.environment,
          ADRS_TABLE: props.adrsTable.tableName,
          EXECUTION_SPECS_TABLE: props.executionSpecificationsTable.tableName,
          AGENT_DESIGN_ASSESSMENTS_TABLE:
            props.agentDesignAssessmentsTable.tableName,
          CONVERSATIONS_TABLE: props.conversationsTable.tableName,
          AGENT_STATUS_TABLE: props.agentStatusTable.tableName,
          EVENT_BUS_NAME: props.agentEventBus.eventBusName,
          USER_POOL_ID: props.userPool.userPoolId,
        },
        timeout: cdk.Duration.seconds(30),
        logGroup: new logs.LogGroup(this, "ProjectResolverFunctionLogs", {
          retention: logs.RetentionDays.ONE_WEEK,
          removalPolicy: cdk.RemovalPolicy.DESTROY,
        }),
      },
    );

    props.projectsTable.grantReadWriteData(projectResolverFunction);
    props.conversationsTable.grantReadWriteData(projectResolverFunction);
    props.agentStatusTable.grantReadWriteData(projectResolverFunction);
    props.adrsTable.grantReadData(projectResolverFunction);
    props.executionSpecificationsTable.grantReadData(projectResolverFunction);
    props.agentDesignAssessmentsTable.grantReadData(projectResolverFunction);
    props.agentEventBus.grantPutEventsTo(projectResolverFunction);

    projectResolverFunction.addToRolePolicy(
      new iam.PolicyStatement({
        effect: iam.Effect.ALLOW,
        actions: ["cognito-idp:AdminGetUser"],
        resources: [props.userPool.userPoolArn],
      }),
    );

    const projectLambdaDataSource = makeLambdaDataSource(
      "Project",
      projectResolverFunction,
    );

    makeResolver(
      "GetProjectResolver",
      "Query",
      "getProject",
      projectLambdaDataSource,
    );
    makeResolver(
      "ListProjectsResolver",
      "Query",
      "listProjects",
      projectLambdaDataSource,
    );
    makeResolver(
      "CreateProjectResolver",
      "Mutation",
      "createProject",
      projectLambdaDataSource,
    );
    makeResolver(
      "UpdateProjectResolver",
      "Mutation",
      "updateProject",
      projectLambdaDataSource,
    );
    makeResolver(
      "UploadDocumentResolver",
      "Mutation",
      "uploadDocument",
      projectLambdaDataSource,
    );

    // ============================================================
    // Conversation Resolver
    // ============================================================

    const conversationResolverFunction = new lambda.Function(
      this,
      "ConversationResolverFunction",
      {
        runtime: lambda.Runtime.NODEJS_24_X,
        handler: "conversation-resolver.handler",
        code: lambda.Code.fromAsset("dist/lambda"),
        environment: {
          PROJECTS_TABLE: props.projectsTable.tableName,
          CONVERSATIONS_TABLE: props.conversationsTable.tableName,
          AGENT_STATUS_TABLE: props.agentStatusTable.tableName,
          EVENT_BUS_NAME: props.agentEventBus.eventBusName,
        },
        timeout: cdk.Duration.seconds(30),
        logGroup: new logs.LogGroup(this, "ConversationResolverFunctionLogs", {
          retention: logs.RetentionDays.ONE_WEEK,
          removalPolicy: cdk.RemovalPolicy.DESTROY,
        }),
      },
    );

    props.conversationsTable.grantReadWriteData(conversationResolverFunction);
    props.agentStatusTable.grantReadWriteData(conversationResolverFunction);
    props.projectsTable.grantReadData(conversationResolverFunction);
    props.agentEventBus.grantPutEventsTo(conversationResolverFunction);

    const conversationLambdaDataSource = makeLambdaDataSource(
      "Conversation",
      conversationResolverFunction,
    );

    makeResolver(
      "GetConversationHistoryResolver",
      "Query",
      "getConversationHistory",
      conversationLambdaDataSource,
    );
    makeResolver(
      "SendMessageResolver",
      "Mutation",
      "sendMessage",
      conversationLambdaDataSource,
    );
    makeResolver(
      "PublishConversationMessageResolver",
      "Mutation",
      "publishConversationMessage",
      conversationLambdaDataSource,
    );
    makeResolver(
      "SendMessageToAgentResolver",
      "Mutation",
      "sendMessageToAgent",
      conversationLambdaDataSource,
    );

    // ============================================================
    // Agent (status) Resolver
    // ============================================================

    const agentResolverFunction = new lambda.Function(
      this,
      "AgentResolverFunction",
      {
        runtime: lambda.Runtime.NODEJS_24_X,
        handler: "agent-resolver.handler",
        code: lambda.Code.fromAsset("dist/lambda"),
        environment: {
          PROJECTS_TABLE: props.projectsTable.tableName,
          CONVERSATIONS_TABLE: props.conversationsTable.tableName,
          AGENT_STATUS_TABLE: props.agentStatusTable.tableName,
          EVENT_BUS_NAME: props.agentEventBus.eventBusName,
        },
        timeout: cdk.Duration.seconds(30),
        logGroup: new logs.LogGroup(this, "AgentResolverFunctionLogs", {
          retention: logs.RetentionDays.ONE_WEEK,
          removalPolicy: cdk.RemovalPolicy.DESTROY,
        }),
      },
    );

    props.agentStatusTable.grantReadWriteData(agentResolverFunction);
    props.projectsTable.grantReadData(agentResolverFunction);
    props.agentEventBus.grantPutEventsTo(agentResolverFunction);

    const agentLambdaDataSource = makeLambdaDataSource(
      "Agent",
      agentResolverFunction,
    );

    makeResolver(
      "GetAgentStatusResolver",
      "Query",
      "getAgentStatus",
      agentLambdaDataSource,
    );

    // ============================================================
    // Document Upload Resolver
    // ============================================================

    const documentUploadResolverFunction = new lambda.Function(
      this,
      "DocumentUploadResolverFunction",
      {
        runtime: lambda.Runtime.NODEJS_24_X,
        handler: "document-upload-resolver.handler",
        code: lambda.Code.fromAsset("dist/lambda"),
        environment: {
          DOCUMENT_BUCKET: props.documentBucket.bucketName,
          KB_ID_PARAM: `/citadel/knowledge-base-id-${props.environment}`,
          DS_ID_PARAM: `/citadel/knowledge-base-datasource-id-${props.environment}`,
          EVENT_BUS_NAME: props.agentEventBus.eventBusName,
          // Source-of-truth jobs table (created in ServicesStack). Referenced
          // by deterministic name — NOT a cross-stack construct import —
          // mirroring the pre-split backend-stack.ts wiring exactly: importing
          // the table construct here would require threading it through
          // BackendStack -> ProjectsStack -> ServicesStack, and ServicesStack
          // already depends on BackendStack. The resolver reads this table
          // first and degrades to a Bedrock KB query if the var/table is
          // absent.
          INGESTION_TABLE: `citadel-document-ingestion-${props.environment}`,
        },
        timeout: cdk.Duration.seconds(30),
        logGroup: new logs.LogGroup(
          this,
          "DocumentUploadResolverFunctionLogs",
          {
            retention: logs.RetentionDays.ONE_WEEK,
            removalPolicy: cdk.RemovalPolicy.DESTROY,
          },
        ),
      },
    );

    props.documentBucket.grantPut(documentUploadResolverFunction);
    props.documentBucket.grantRead(documentUploadResolverFunction);
    props.documentBucket.grantDelete(documentUploadResolverFunction);
    documentUploadResolverFunction.addToRolePolicy(
      new iam.PolicyStatement({
        actions: [
          "bedrock:GetKnowledgeBaseDocuments",
          "bedrock:DeleteKnowledgeBaseDocuments",
        ],
        resources: ["*"],
      }),
    );
    documentUploadResolverFunction.addToRolePolicy(
      new iam.PolicyStatement({
        actions: ["ssm:GetParameter"],
        resources: [
          `arn:aws:ssm:${this.region}:${this.account}:parameter/citadel/knowledge-base-id-${props.environment}`,
          `arn:aws:ssm:${this.region}:${this.account}:parameter/citadel/knowledge-base-datasource-id-${props.environment}`,
        ],
      }),
    );
    props.agentEventBus.grantPutEventsTo(documentUploadResolverFunction);

    // Read-only access to the authoritative document-ingestion jobs table —
    // ARN built from account/region/name (deterministic), same rationale as
    // INGESTION_TABLE above.
    const ingestionTableName = `citadel-document-ingestion-${props.environment}`;
    const ingestionTableArn = `arn:aws:dynamodb:${this.region}:${this.account}:table/${ingestionTableName}`;
    documentUploadResolverFunction.addToRolePolicy(
      new iam.PolicyStatement({
        effect: iam.Effect.ALLOW,
        actions: ["dynamodb:GetItem", "dynamodb:Query"],
        resources: [
          ingestionTableArn,
          `${ingestionTableArn}/index/status-index`,
        ],
      }),
    );

    const documentUploadLambdaDataSource = makeLambdaDataSource(
      "DocumentUpload",
      documentUploadResolverFunction,
    );

    makeResolver(
      "GenerateDocumentUploadUrlResolver",
      "Mutation",
      "generateDocumentUploadUrl",
      documentUploadLambdaDataSource,
    );
    makeResolver(
      "GetDocumentIngestionStatusResolver",
      "Query",
      "getDocumentIngestionStatus",
      documentUploadLambdaDataSource,
    );
    makeResolver(
      "ListProjectDocumentsResolver",
      "Query",
      "listProjectDocuments",
      documentUploadLambdaDataSource,
    );
    makeResolver(
      "DeleteDocumentResolver",
      "Mutation",
      "deleteDocument",
      documentUploadLambdaDataSource,
    );

    // ============================================================
    // Document Resolver (versions + PDF generation)
    // ============================================================

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
        logGroup: new logs.LogGroup(this, "DocumentResolverFunctionLogs", {
          retention: logs.RetentionDays.ONE_WEEK,
          removalPolicy: cdk.RemovalPolicy.DESTROY,
        }),
      },
    );

    const sessionBucketArn = `arn:aws:s3:::citadel-sessions-${props.environment}-${this.account}-${this.region}`;
    documentResolverFunction.addToRolePolicy(
      new iam.PolicyStatement({
        actions: [
          "s3:GetObject",
          "s3:ListBucket",
          "s3:ListBucketVersions",
          "s3:GetObjectVersion",
        ],
        resources: [sessionBucketArn, `${sessionBucketArn}/*`],
      }),
    );
    documentResolverFunction.addToRolePolicy(
      new iam.PolicyStatement({
        actions: ["s3:PutObject"],
        resources: [`${sessionBucketArn}/*`],
      }),
    );
    documentResolverFunction.addToRolePolicy(
      new iam.PolicyStatement({
        actions: ["lambda:InvokeFunction"],
        resources: [
          `arn:aws:lambda:${this.region}:${this.account}:function:citadel-pdf-generator-${props.environment}`,
        ],
      }),
    );

    const documentLambdaDataSource = makeLambdaDataSource(
      "Document",
      documentResolverFunction,
    );

    makeResolver(
      "GetProjectDocumentResolver",
      "Query",
      "getProjectDocument",
      documentLambdaDataSource,
    );
    makeResolver(
      "ListDocumentVersionsResolver",
      "Query",
      "listDocumentVersions",
      documentLambdaDataSource,
    );
    makeResolver(
      "GetDocumentVersionResolver",
      "Query",
      "getDocumentVersion",
      documentLambdaDataSource,
    );
    makeResolver(
      "GenerateDocumentPdfResolver",
      "Mutation",
      "generateDocumentPdf",
      documentLambdaDataSource,
    );

    // ============================================================
    // Chatter Publisher + Resolver
    // ============================================================

    const chatterPublisherFunction = new lambda.Function(
      this,
      "ChatterPublisherFunction",
      {
        runtime: lambda.Runtime.NODEJS_24_X,
        handler: "chatter-publisher.handler",
        code: lambda.Code.fromAsset("dist/lambda"),
        environment: {
          APPSYNC_ENDPOINT: props.appSyncApi.graphqlUrl,
        },
        timeout: cdk.Duration.seconds(30),
        logGroup: new logs.LogGroup(this, "ChatterPublisherFunctionLogs", {
          retention: logs.RetentionDays.ONE_WEEK,
          removalPolicy: cdk.RemovalPolicy.DESTROY,
        }),
      },
    );

    chatterPublisherFunction.addToRolePolicy(
      new iam.PolicyStatement({
        effect: iam.Effect.ALLOW,
        actions: ["appsync:GraphQL"],
        resources: [
          `${props.appSyncApi.arn}/types/Mutation/fields/publishChatter`,
        ],
      }),
    );

    const chatterResolverFunction = new lambda.Function(
      this,
      "ChatterResolverFunction",
      {
        runtime: lambda.Runtime.NODEJS_24_X,
        handler: "chatter-resolver.handler",
        code: lambda.Code.fromAsset("dist/lambda"),
        timeout: cdk.Duration.seconds(30),
        logGroup: new logs.LogGroup(this, "ChatterResolverFunctionLogs", {
          retention: logs.RetentionDays.ONE_WEEK,
          removalPolicy: cdk.RemovalPolicy.DESTROY,
        }),
      },
    );

    const chatterLambdaDataSource = makeLambdaDataSource(
      "Chatter",
      chatterResolverFunction,
    );

    makeResolver(
      "PublishChatterResolver",
      "Mutation",
      "publishChatter",
      chatterLambdaDataSource,
    );

    // EventBridge rule for ALL agent chatter - captures all messages on the
    // shared bus. Matches all events by not specifying a source pattern.
    const chatterRule = new events.Rule(this, "ChatterRule", {
      eventBus: props.agentEventBus,
      ruleName: `citadel-chatter-${props.environment}`,
      description: "Captures all agent communication for real-time display",
      eventPattern: {
        source: [{ prefix: "" }] as unknown as string[],
      },
    });

    chatterRule.addTarget(
      new targets.LambdaFunction(chatterPublisherFunction, {
        retryAttempts: 2,
        maxEventAge: cdk.Duration.hours(2),
      }),
    );

    // ============================================================
    // Project Progress Updater
    // ============================================================

    const projectProgressUpdater = new lambda.Function(
      this,
      "ProjectProgressUpdater",
      {
        runtime: lambda.Runtime.NODEJS_24_X,
        handler: "project-progress-updater.handler",
        code: lambda.Code.fromAsset("dist/lambda"),
        environment: {
          PROJECTS_TABLE: props.projectsTable.tableName,
          IDEMPOTENCY_TABLE: props.idempotencyTable.tableName,
        },
        timeout: cdk.Duration.seconds(30),
        logGroup: new logs.LogGroup(this, "ProjectProgressUpdaterLogs", {
          retention: logs.RetentionDays.ONE_WEEK,
          removalPolicy: cdk.RemovalPolicy.DESTROY,
        }),
      },
    );

    props.projectsTable.grantReadWriteData(projectProgressUpdater);
    props.idempotencyTable.grantReadWriteData(projectProgressUpdater);

    const progressUpdateRule = new events.Rule(this, "ProgressUpdateRule", {
      eventBus: props.agentEventBus,
      ruleName: `citadel-progress-update-${props.environment}`,
      description: "Updates project progress from agent events",
      eventPattern: {
        detailType: ["intake.progress.updated"],
        source: [
          "agent_intake.assessment",
          "agent_intake.design",
          "agent_intake.planning",
          "agent_intake.implementation",
        ],
      },
    });

    progressUpdateRule.addTarget(
      new targets.LambdaFunction(projectProgressUpdater, {
        retryAttempts: 2,
        maxEventAge: cdk.Duration.hours(2),
      }),
    );

    // ============================================================
    // Assessment Completion Notifier + Resolver + Rule
    // ============================================================

    const assessmentCompletionNotifier = new lambda.Function(
      this,
      "AssessmentCompletionNotifier",
      {
        runtime: lambda.Runtime.NODEJS_24_X,
        handler: "assessment-completion-notifier.handler",
        code: lambda.Code.fromAsset("dist/lambda"),
        environment: {
          APPSYNC_ENDPOINT: props.appSyncApi.graphqlUrl,
        },
        timeout: cdk.Duration.seconds(30),
        logGroup: new logs.LogGroup(this, "AssessmentCompletionNotifierLogs", {
          retention: logs.RetentionDays.ONE_WEEK,
          removalPolicy: cdk.RemovalPolicy.DESTROY,
        }),
      },
    );

    props.appSyncApi.grantMutation(
      assessmentCompletionNotifier,
      "publishAssessmentCompletion",
    );

    const assessmentCompletionRule = new events.Rule(
      this,
      "AssessmentCompletionRule",
      {
        eventBus: props.agentEventBus,
        ruleName: `citadel-assessment-completion-${props.environment}`,
        description: "Triggers when all assessment dimensions are complete",
        eventPattern: {
          detailType: ["assessment.completed"],
          source: ["citadel.assessment"],
        },
      },
    );

    assessmentCompletionRule.addTarget(
      new targets.LambdaFunction(assessmentCompletionNotifier, {
        retryAttempts: 2,
        maxEventAge: cdk.Duration.hours(2),
      }),
    );

    const assessmentCompletionResolverFunction = new lambda.Function(
      this,
      "AssessmentCompletionResolverFunction",
      {
        runtime: lambda.Runtime.NODEJS_24_X,
        handler: "assessment-completion-resolver.handler",
        code: lambda.Code.fromAsset("dist/lambda"),
        timeout: cdk.Duration.seconds(30),
        logGroup: new logs.LogGroup(
          this,
          "AssessmentCompletionResolverFunctionLogs",
          {
            retention: logs.RetentionDays.ONE_WEEK,
            removalPolicy: cdk.RemovalPolicy.DESTROY,
          },
        ),
      },
    );

    const assessmentCompletionLambdaDataSource = makeLambdaDataSource(
      "AssessmentCompletion",
      assessmentCompletionResolverFunction,
    );

    makeResolver(
      "PublishAssessmentCompletionResolver",
      "Mutation",
      "publishAssessmentCompletion",
      assessmentCompletionLambdaDataSource,
    );

    // ============================================================
    // Assessment Progress Resolver
    // ============================================================

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
        logGroup: new logs.LogGroup(
          this,
          "AssessmentProgressResolverFunctionLogs",
          {
            retention: logs.RetentionDays.ONE_WEEK,
            removalPolicy: cdk.RemovalPolicy.DESTROY,
          },
        ),
      },
    );

    assessmentProgressResolverFunction.addToRolePolicy(
      new iam.PolicyStatement({
        effect: iam.Effect.ALLOW,
        actions: ["dynamodb:GetItem", "dynamodb:Query"],
        resources: [sessionMemoryTableArn],
      }),
    );

    const assessmentProgressLambdaDataSource = makeLambdaDataSource(
      "AssessmentProgress",
      assessmentProgressResolverFunction,
    );

    makeResolver(
      "GetAssessmentProgressResolver",
      "Query",
      "getAssessmentProgress",
      assessmentProgressLambdaDataSource,
    );

    // ============================================================
    // Design Progress Notifier + Resolver + Rule
    // ============================================================

    const designProgressNotifier = new lambda.Function(
      this,
      "DesignProgressNotifier",
      {
        runtime: lambda.Runtime.NODEJS_24_X,
        handler: "design-progress-notifier.handler",
        code: lambda.Code.fromAsset("dist/lambda"),
        environment: {
          APPSYNC_ENDPOINT: props.appSyncApi.graphqlUrl,
        },
        timeout: cdk.Duration.seconds(30),
        logGroup: new logs.LogGroup(this, "DesignProgressNotifierLogs", {
          retention: logs.RetentionDays.ONE_WEEK,
          removalPolicy: cdk.RemovalPolicy.DESTROY,
        }),
      },
    );

    props.appSyncApi.grantMutation(
      designProgressNotifier,
      "publishDesignProgress",
    );

    const designProgressRule = new events.Rule(this, "DesignProgressRule", {
      eventBus: props.agentEventBus,
      ruleName: `citadel-design-progress-${props.environment}`,
      description: "Triggers when design section progress is updated",
      eventPattern: {
        detailType: ["design.progress.updated"],
        source: ["agent2.design"],
      },
    });

    designProgressRule.addTarget(
      new targets.LambdaFunction(designProgressNotifier, {
        retryAttempts: 2,
        maxEventAge: cdk.Duration.hours(2),
      }),
    );

    const designProgressResolverFunction = new lambda.Function(
      this,
      "DesignProgressResolverFunction",
      {
        runtime: lambda.Runtime.NODEJS_24_X,
        handler: "design-progress-resolver.handler",
        code: lambda.Code.fromAsset("dist/lambda"),
        timeout: cdk.Duration.seconds(30),
        logGroup: new logs.LogGroup(
          this,
          "DesignProgressResolverFunctionLogs",
          {
            retention: logs.RetentionDays.ONE_WEEK,
            removalPolicy: cdk.RemovalPolicy.DESTROY,
          },
        ),
      },
    );

    const designProgressLambdaDataSource = makeLambdaDataSource(
      "DesignProgress",
      designProgressResolverFunction,
    );

    makeResolver(
      "PublishDesignProgressResolver",
      "Mutation",
      "publishDesignProgress",
      designProgressLambdaDataSource,
    );

    // ============================================================
    // Report Download URL Generator
    // ============================================================

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
          PROJECTS_TABLE: props.projectsTable.tableName,
        },
        timeout: cdk.Duration.seconds(30),
        logGroup: new logs.LogGroup(this, "GenerateReportUrlFunctionLogs", {
          retention: logs.RetentionDays.ONE_WEEK,
          removalPolicy: cdk.RemovalPolicy.DESTROY,
        }),
      },
    );

    generateReportUrlFunction.addToRolePolicy(
      new iam.PolicyStatement({
        effect: iam.Effect.ALLOW,
        actions: ["s3:GetObject", "s3:ListBucket"],
        resources: [
          `arn:aws:s3:::${sessionBucketName}/*`,
          `arn:aws:s3:::${sessionBucketName}`,
        ],
      }),
    );
    props.projectsTable.grantReadData(generateReportUrlFunction);

    const generateReportUrlDataSource = makeLambdaDataSource(
      "GenerateReportUrl",
      generateReportUrlFunction,
    );

    makeResolver(
      "GenerateReportDownloadUrlResolver",
      "Query",
      "generateReportDownloadUrl",
      generateReportUrlDataSource,
    );

    // ============================================================
    // Alarms (moved with ProjectResolver — 2 alarms, mirroring the
    // criticalFunctions loop pattern in backend-stack.ts)
    // ============================================================

    new cloudwatch.Alarm(this, "ProjectResolverErrorAlarm", {
      alarmName: `citadel-ProjectResolver-errors-${props.environment}`,
      metric: projectResolverFunction.metricErrors({
        period: cdk.Duration.minutes(5),
      }),
      threshold: 5,
      evaluationPeriods: 1,
      comparisonOperator:
        cloudwatch.ComparisonOperator.GREATER_THAN_OR_EQUAL_TO_THRESHOLD,
      treatMissingData: cloudwatch.TreatMissingData.NOT_BREACHING,
      alarmDescription: "ProjectResolver Lambda error rate exceeded threshold",
    });

    new cloudwatch.Alarm(this, "ProjectResolverThrottleAlarm", {
      alarmName: `citadel-ProjectResolver-throttles-${props.environment}`,
      metric: projectResolverFunction.metricThrottles({
        period: cdk.Duration.minutes(5),
      }),
      threshold: 3,
      evaluationPeriods: 1,
      comparisonOperator:
        cloudwatch.ComparisonOperator.GREATER_THAN_OR_EQUAL_TO_THRESHOLD,
      treatMissingData: cloudwatch.TreatMissingData.NOT_BREACHING,
      alarmDescription:
        "ProjectResolver Lambda throttle rate exceeded threshold",
    });

    // cdk-nag suppressions for this stack's IAM4/IAM5 findings are applied
    // centrally in bin/app.ts via the shared `appLambdaSuppressions` stack
    // loop (same pattern backend/services/arbiter/frontend/gateway use) —
    // no new suppression categories introduced here, per the design's rail
    // 5 requirement.
  }
}
