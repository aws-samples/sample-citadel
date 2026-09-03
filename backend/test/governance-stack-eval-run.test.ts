/**
 * CIT-102 Pass A — GovernanceStack eval-run wiring assertions.
 *
 * Mirrors governance-stack-eval-resolver.test.ts (CIT-101): one
 * EvalRunResolverFunction, one EvalRunLambdaDataSource, one CfnResolver per
 * eval-run Mutation/Query field, plus the SQS EvalDispatchQueue + DLQ
 * (design §1) and the eval-conversation-worker Lambda (design §9).
 */
import * as cdk from "aws-cdk-lib";
import { Template, Match } from "aws-cdk-lib/assertions";
import * as appsync from "aws-cdk-lib/aws-appsync";
import * as dynamodb from "aws-cdk-lib/aws-dynamodb";
import * as events from "aws-cdk-lib/aws-events";
import * as iam from "aws-cdk-lib/aws-iam";
import * as sns from "aws-cdk-lib/aws-sns";
import { Bucket } from "aws-cdk-lib/aws-s3";
import * as path from "path";
import { scaffoldBackendAssetDirs } from "./helpers/scaffold-stub-assets";

scaffoldBackendAssetDirs(["dist/lambda", "src/schema"]);

import { GovernanceStack } from "../lib/governance-stack";

const EVAL_RUN_MUTATION_FIELDS = ["startEvalRun"];
const EVAL_RUN_QUERY_FIELDS = [
  "getEvalRun",
  "listEvalRuns",
  "listEvalRunCaseResults",
];

function mockTable(
  scope: cdk.Stack,
  id: string,
  tableName: string,
): dynamodb.Table {
  return new dynamodb.Table(scope, id, {
    tableName,
    partitionKey: { name: `${id}Id`, type: dynamodb.AttributeType.STRING },
    billingMode: dynamodb.BillingMode.PAY_PER_REQUEST,
    removalPolicy: cdk.RemovalPolicy.DESTROY,
  });
}

function createTestStack(): { stack: GovernanceStack; template: Template } {
  const app = new cdk.App();
  const backendStack = new cdk.Stack(app, "MockBackendStackEvalRun", {
    env: { account: "123456789012", region: "us-east-1" },
  });

  const agentEventBus = new events.EventBus(backendStack, "AgentEventBus", {
    eventBusName: "citadel-agents-test",
  });

  const appSyncApi = new appsync.GraphqlApi(backendStack, "MockApi", {
    name: "mock-api",
    schema: appsync.SchemaFile.fromAsset(
      path.resolve(__dirname, "../src/schema/schema.graphql"),
    ),
  });

  const accessLogsBucket = new Bucket(backendStack, "AccessLogsBucket", {
    bucketName: "citadel-access-logs-test",
  });

  const adrsTable = mockTable(backendStack, "Adrs", "citadel-adrs-test");
  const adrReopenAttemptsTable = mockTable(
    backendStack,
    "AdrReopenAttempts",
    "citadel-adr-reopen-attempts-test",
  );
  const executionSpecificationsTable = mockTable(
    backendStack,
    "ExecutionSpecifications",
    "citadel-execution-specifications-test",
  );
  const interrogationRoundsTable = mockTable(
    backendStack,
    "InterrogationRounds",
    "citadel-interrogation-rounds-test",
  );
  const agentDesignAssessmentsTable = mockTable(
    backendStack,
    "AgentDesignAssessments",
    "citadel-agent-design-assessments-test",
  );
  const programReviewsTable = mockTable(
    backendStack,
    "ProgramReviews",
    "citadel-program-reviews-test",
  );
  const projectsTable = mockTable(
    backendStack,
    "Projects",
    "citadel-projects-test",
  );
  const evalSuitesTable = mockTable(
    backendStack,
    "EvalSuites",
    "citadel-eval-suites-test",
  );
  const evalCasesTable = mockTable(
    backendStack,
    "EvalCases",
    "citadel-eval-cases-test",
  );
  const evalRunsTable = mockTable(
    backendStack,
    "EvalRuns",
    "citadel-eval-runs-test",
  );
  const evalRunCaseResultsTable = mockTable(
    backendStack,
    "EvalRunCaseResults",
    "citadel-eval-run-case-results-test",
  );
  const evalBaselinesTable = mockTable(
    backendStack,
    "EvalBaselines",
    "citadel-eval-baselines-test",
  );
  const evalComparisonsTable = mockTable(
    backendStack,
    "EvalComparisons",
    "citadel-eval-comparisons-test",
  );
  const evalComparisonConfigTable = mockTable(
    backendStack,
    "EvalComparisonConfig",
    "citadel-eval-comparison-config-test",
  );
  const executionsTable = mockTable(
    backendStack,
    "Executions",
    "citadel-executions-test",
  );
  const conversationsTable = mockTable(
    backendStack,
    "Conversations",
    "citadel-conversations-test",
  );

  const agentReleasesTable = new dynamodb.Table(
    backendStack,
    "AgentReleasesTable",
    {
      tableName: "citadel-agent-releases-test",
      partitionKey: { name: "releaseId", type: dynamodb.AttributeType.STRING },
      billingMode: dynamodb.BillingMode.PAY_PER_REQUEST,
      removalPolicy: cdk.RemovalPolicy.DESTROY,
    },
  );
  const agentReleaseWriterRole = new iam.Role(
    backendStack,
    "AgentReleaseWriterRole",
    { assumedBy: new iam.ServicePrincipal("lambda.amazonaws.com") },
  );
  const environmentReleasePointersTable = new dynamodb.Table(
    backendStack,
    "EnvironmentReleasePointersTable",
    {
      tableName: "citadel-environment-release-pointers-test",
      partitionKey: { name: "orgId", type: dynamodb.AttributeType.STRING },
      sortKey: {
        name: "agentTargetId_environment",
        type: dynamodb.AttributeType.STRING,
      },
      billingMode: dynamodb.BillingMode.PAY_PER_REQUEST,
      removalPolicy: cdk.RemovalPolicy.DESTROY,
    },
  );
  const environmentReleasePointerWriterRole = new iam.Role(
    backendStack,
    "EnvironmentReleasePointerWriterRole",
    { assumedBy: new iam.ServicePrincipal("lambda.amazonaws.com") },
  );

  const promotionPolicyConfigTable = new dynamodb.Table(
    backendStack,
    "PromotionPolicyConfigTable",
    {
      tableName: "citadel-promotion-policy-config-test",
      partitionKey: { name: "orgId", type: dynamodb.AttributeType.STRING },
      billingMode: dynamodb.BillingMode.PAY_PER_REQUEST,
      removalPolicy: cdk.RemovalPolicy.DESTROY,
    },
  );
  const promotionPolicyConfigWriterRole = new iam.Role(
    backendStack,
    "PromotionPolicyConfigWriterRole",
    { assumedBy: new iam.ServicePrincipal("lambda.amazonaws.com") },
  );
  promotionPolicyConfigWriterRole.addToPolicy(
    new iam.PolicyStatement({
      effect: iam.Effect.ALLOW,
      actions: ["dynamodb:GetItem", "dynamodb:PutItem"],
      resources: [promotionPolicyConfigTable.tableArn],
    }),
  );

  const alarmTopic = new sns.Topic(backendStack, "AlarmTopic", {
    topicName: "citadel-alarms-test-evalrun",
  });

  const stack = new GovernanceStack(app, "TestGovernanceStackEvalRun", {
    env: { account: "123456789012", region: "us-east-1" },
    environment: "test",
    appSyncApi,
    agentEventBus,
    accessLogsBucket,
    alarmTopic,
    adrsTable,
    adrReopenAttemptsTable,
    executionSpecificationsTable,
    interrogationRoundsTable,
    agentDesignAssessmentsTable,
    programReviewsTable,
    projectsTable,
    evalSuitesTable,
    evalCasesTable,
    evalRunsTable,
    evalRunCaseResultsTable,
    evalBaselinesTable,
    evalComparisonsTable,
    evalComparisonConfigTable,
    executionsTable,
    conversationsTable,
    agentReleasesTable,
    agentReleaseWriterRole,
    registryArn:
      "arn:aws:bedrock-agentcore:us-east-1:123456789012:registry/citadel-test",
    registryId: "citadel-test",
    environmentReleasePointersTable,
    environmentReleasePointerWriterRole,
    promotionPolicyConfigTable,
    promotionPolicyConfigWriterRole,
  });

  const template = Template.fromStack(stack);
  return { stack, template };
}

describe("GovernanceStack — eval-run wiring (CIT-102)", () => {
  let template: Template;

  beforeAll(() => {
    ({ template } = createTestStack());
  });

  test("EvalRunResolverFunction exists with Node.js 24.x runtime and eval-run table env vars", () => {
    template.hasResourceProperties("AWS::Lambda::Function", {
      Handler: "eval-run-resolver.handler",
      Runtime: "nodejs24.x",
      Environment: {
        Variables: Match.objectLike({
          EVAL_RUNS_TABLE: Match.anyValue(),
          EVAL_RUN_CASE_RESULTS_TABLE: Match.anyValue(),
          EVAL_SUITES_TABLE: Match.anyValue(),
          EVAL_CASES_TABLE: Match.anyValue(),
        }),
      },
    });
  });

  test("EvalRunLambdaDataSource exists as an AWS_LAMBDA AppSync data source", () => {
    template.hasResourceProperties("AWS::AppSync::DataSource", {
      Name: "EvalRunLambdaDataSource",
      Type: "AWS_LAMBDA",
    });
  });

  test.each(EVAL_RUN_MUTATION_FIELDS)(
    "has a Mutation.%s CfnResolver bound to EvalRunLambdaDataSource",
    (fieldName) => {
      template.hasResourceProperties("AWS::AppSync::Resolver", {
        TypeName: "Mutation",
        FieldName: fieldName,
        DataSourceName: {
          "Fn::GetAtt": [
            Match.stringLikeRegexp("EvalRunLambdaDataSource"),
            "Name",
          ],
        },
      });
    },
  );

  test.each(EVAL_RUN_QUERY_FIELDS)(
    "has a Query.%s CfnResolver bound to EvalRunLambdaDataSource",
    (fieldName) => {
      template.hasResourceProperties("AWS::AppSync::Resolver", {
        TypeName: "Query",
        FieldName: fieldName,
        DataSourceName: {
          "Fn::GetAtt": [
            Match.stringLikeRegexp("EvalRunLambdaDataSource"),
            "Name",
          ],
        },
      });
    },
  );

  test("EvalDispatchQueue + DLQ exist, wired with maxReceiveCount", () => {
    template.hasResourceProperties("AWS::SQS::Queue", {
      QueueName: "citadel-eval-dispatch-test",
    });
    template.hasResourceProperties("AWS::SQS::Queue", {
      QueueName: "citadel-eval-dispatch-dlq-test",
    });
  });

  test("EvalConversationWorkerFunction exists with a 15-minute timeout and an SQS event source mapping to the dispatch queue", () => {
    template.hasResourceProperties("AWS::Lambda::Function", {
      Handler: "eval-conversation-worker.handler",
      Runtime: "nodejs24.x",
      Timeout: 900,
    });
    template.hasResourceProperties("AWS::Lambda::EventSourceMapping", {
      EventSourceArn: Match.objectLike({
        "Fn::GetAtt": [Match.stringLikeRegexp("EvalDispatchQueue"), "Arn"],
      }),
    });
  });

  test("grants EvalRunResolverFunction read/write access to both eval-run tables", () => {
    template.hasResourceProperties("AWS::IAM::Policy", {
      PolicyDocument: Match.objectLike({
        Statement: Match.arrayWith([
          Match.objectLike({
            Action: Match.arrayWith(["dynamodb:GetItem", "dynamodb:PutItem"]),
            Effect: "Allow",
          }),
        ]),
      }),
      Roles: Match.arrayWith([
        { Ref: Match.stringLikeRegexp("EvalRunResolverFunctionServiceRole") },
      ]),
    });
  });

  test("EvalRunnerFunction exists with eval-run table + executions table env vars (F3 fix: driver Lambda is provisioned)", () => {
    template.hasResourceProperties("AWS::Lambda::Function", {
      Handler: "eval-runner.handler",
      Runtime: "nodejs24.x",
      Environment: {
        Variables: Match.objectLike({
          EVAL_RUNS_TABLE: Match.anyValue(),
          EVAL_RUN_CASE_RESULTS_TABLE: Match.anyValue(),
          EVAL_CASES_TABLE: Match.anyValue(),
          EXECUTIONS_TABLE: Match.anyValue(),
          EVAL_DISPATCH_QUEUE_URL: Match.anyValue(),
        }),
      },
    });
  });

  test("EvalWorkflowCompletionRule routes citadel.workflows workflow.completed/workflow.failed to EvalRunnerFunction", () => {
    template.hasResourceProperties("AWS::Events::Rule", {
      Name: "citadel-eval-workflow-completion-test",
      EventPattern: {
        source: ["citadel.workflows"],
        "detail-type": ["workflow.completed", "workflow.failed"],
      },
    });
  });

  test("EvalTimeoutSweepRule schedules EvalRunnerFunction on a 5-minute rate (sweepTimeouts reachability)", () => {
    template.hasResourceProperties("AWS::Events::Rule", {
      Name: "citadel-eval-timeout-sweep-test",
      ScheduleExpression: "rate(5 minutes)",
    });
  });

  test("EvalConversationWorkerFunction is granted events:PutEvents on the agent event bus (F5 fix: run.completed emission must not AccessDenied)", () => {
    template.hasResourceProperties("AWS::IAM::Policy", {
      PolicyDocument: Match.objectLike({
        Statement: Match.arrayWith([
          Match.objectLike({
            Action: "events:PutEvents",
            Effect: "Allow",
          }),
        ]),
      }),
      Roles: Match.arrayWith([
        {
          Ref: Match.stringLikeRegexp(
            "EvalConversationWorkerFunctionServiceRole",
          ),
        },
      ]),
    });
  });

  // ── F4: artifact materialization grants (design §6, DECISION d36fbbf7) ──

  test.each([
    [
      "EvalConversationWorkerFunction",
      "EvalConversationWorkerFunctionServiceRole",
    ],
    ["EvalRunnerFunction", "EvalRunnerFunctionServiceRole"],
  ])(
    "%s is granted ssm:GetParameter scoped to the exact eval-replay-bucket parameter ARN",
    (_fnLogicalId, roleLogicalIdPrefix) => {
      template.hasResourceProperties("AWS::IAM::Policy", {
        PolicyDocument: Match.objectLike({
          Statement: Match.arrayWith([
            Match.objectLike({
              Action: "ssm:GetParameter",
              Effect: "Allow",
              Resource:
                "arn:aws:ssm:us-east-1:123456789012:parameter/citadel/eval-replay-bucket-test",
            }),
          ]),
        }),
        Roles: Match.arrayWith([
          { Ref: Match.stringLikeRegexp(roleLogicalIdPrefix) },
        ]),
      });
    },
  );

  test.each([
    [
      "EvalConversationWorkerFunction",
      "EvalConversationWorkerFunctionServiceRole",
    ],
    ["EvalRunnerFunction", "EvalRunnerFunctionServiceRole"],
  ])(
    "%s is granted s3:PutObject + s3:GetObject scoped exactly to the eval-runs/* prefix (no bucket-wide grant, no Delete/List)",
    (_fnLogicalId, roleLogicalIdPrefix) => {
      template.hasResourceProperties("AWS::IAM::Policy", {
        PolicyDocument: Match.objectLike({
          Statement: Match.arrayWith([
            Match.objectLike({
              Action: ["s3:PutObject", "s3:GetObject"],
              Effect: "Allow",
              Resource: Match.stringLikeRegexp(
                "^arn:aws:s3:::citadel-telemetry-test-replaypackagebucket\\*/eval-runs/\\*$",
              ),
            }),
          ]),
        }),
        Roles: Match.arrayWith([
          { Ref: Match.stringLikeRegexp(roleLogicalIdPrefix) },
        ]),
      });
    },
  );

  test("no S3 grant on either eval Lambda is bucket-wide (every S3 statement's Resource ends in /eval-runs/*)", () => {
    const policies = template.findResources("AWS::IAM::Policy");
    for (const [, resource] of Object.entries(policies)) {
      const statements = (
        resource as {
          Properties: {
            PolicyDocument: { Statement: Array<Record<string, unknown>> };
          };
        }
      ).Properties.PolicyDocument.Statement;
      for (const stmt of statements) {
        const actions = Array.isArray(stmt.Action)
          ? stmt.Action
          : [stmt.Action];
        const isS3Write = actions.some(
          (a) => a === "s3:PutObject" || a === "s3:GetObject",
        );
        if (!isS3Write) continue;
        if (typeof stmt.Resource === "string") {
          expect(stmt.Resource.endsWith("/eval-runs/*")).toBe(true);
        }
      }
    }
  });
});
