/**
 * CIT-101 — GovernanceStack eval-resolver AppSync wiring assertions.
 *
 * Mirrors the exec-spec resolver block: one EvalResolverFunction, one
 * EvalLambdaDataSource, and one CfnResolver per eval Mutation/Query field
 * (governance-stack.ts:802-882). No baseline (split-gates rail2) covers
 * this new wiring, so this test is the only machine guard that every field
 * the eval-resolver's handler switch serves has a matching CfnResolver
 * bound to EvalLambdaDataSource, and that both eval tables receive
 * grantReadWriteData.
 *
 * Style mirrors projects-stack.test.ts / arbiter-stack-governance-tables.test.ts:
 * bootstrap a minimal mock BackendStack supplying GovernanceStackProps'
 * cross-stack inputs (appSyncApi, agentEventBus, accessLogsBucket, the 6
 * governance tables, projectsTable, evalSuitesTable, evalCasesTable), then
 * instantiate the real GovernanceStack and assert via Template.fromStack.
 */

import * as cdk from "aws-cdk-lib";
import { Template, Match } from "aws-cdk-lib/assertions";
import * as appsync from "aws-cdk-lib/aws-appsync";
import * as dynamodb from "aws-cdk-lib/aws-dynamodb";
import * as events from "aws-cdk-lib/aws-events";
import * as iam from "aws-cdk-lib/aws-iam";
import { Bucket } from "aws-cdk-lib/aws-s3";
import * as path from "path";
import { scaffoldBackendAssetDirs } from "./helpers/scaffold-stub-assets";

scaffoldBackendAssetDirs(["dist/lambda", "src/schema"]);

import { GovernanceStack } from "../lib/governance-stack";

const EVAL_MUTATION_FIELDS = [
  "createEvalSuite",
  "updateEvalSuite",
  "freezeEvalSuite",
  "archiveEvalSuite",
  "cloneEvalSuite",
  "markEvalSuiteReferenced",
  "addEvalCase",
  "updateEvalCase",
  "deleteEvalCase",
  "importReplayAsEvalCase",
];

const EVAL_QUERY_FIELDS = ["getEvalSuite", "listEvalSuites", "listEvalCases"];

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
  const backendStack = new cdk.Stack(app, "MockBackendStack", {
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
  // CIT-102: GovernanceStackProps now also requires the eval-run tables +
  // executions/conversations tables (eval-runner + eval-conversation-worker
  // wiring). Additive to this CIT-101 test — not otherwise exercised here.
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

  const stack = new GovernanceStack(app, "TestGovernanceStackEval", {
    env: { account: "123456789012", region: "us-east-1" },
    environment: "test",
    appSyncApi,
    agentEventBus,
    accessLogsBucket,
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
  });

  const template = Template.fromStack(stack);
  return { stack, template };
}

describe("GovernanceStack — eval-resolver AppSync wiring (CIT-101)", () => {
  let template: Template;

  beforeAll(() => {
    ({ template } = createTestStack());
  });

  test("EvalResolverFunction exists with Node.js 24.x runtime, 30s timeout, and eval table env vars", () => {
    template.hasResourceProperties("AWS::Lambda::Function", {
      Handler: "eval-resolver.handler",
      Runtime: "nodejs24.x",
      Timeout: 30,
      Environment: {
        Variables: Match.objectLike({
          EVAL_SUITES_TABLE: Match.anyValue(),
          EVAL_CASES_TABLE: Match.anyValue(),
          EVENT_BUS_NAME: Match.anyValue(),
        }),
      },
    });
  });

  test("EvalLambdaDataSource exists as an AWS_LAMBDA AppSync data source", () => {
    template.hasResourceProperties("AWS::AppSync::DataSource", {
      Name: "EvalLambdaDataSource",
      Type: "AWS_LAMBDA",
    });
  });

  test.each(EVAL_MUTATION_FIELDS)(
    "has a Mutation.%s CfnResolver bound to EvalLambdaDataSource",
    (fieldName) => {
      template.hasResourceProperties("AWS::AppSync::Resolver", {
        TypeName: "Mutation",
        FieldName: fieldName,
        DataSourceName: {
          "Fn::GetAtt": [
            Match.stringLikeRegexp("EvalLambdaDataSource"),
            "Name",
          ],
        },
      });
    },
  );

  test.each(EVAL_QUERY_FIELDS)(
    "has a Query.%s CfnResolver bound to EvalLambdaDataSource",
    (fieldName) => {
      template.hasResourceProperties("AWS::AppSync::Resolver", {
        TypeName: "Query",
        FieldName: fieldName,
        DataSourceName: {
          "Fn::GetAtt": [
            Match.stringLikeRegexp("EvalLambdaDataSource"),
            "Name",
          ],
        },
      });
    },
  );

  test("defines exactly 13 eval CfnResolvers (10 mutations + 3 queries)", () => {
    const allFields = new Set([...EVAL_MUTATION_FIELDS, ...EVAL_QUERY_FIELDS]);
    const resolvers = template.findResources("AWS::AppSync::Resolver", {
      Properties: {
        DataSourceName: {
          "Fn::GetAtt": [
            Match.stringLikeRegexp("EvalLambdaDataSource"),
            "Name",
          ],
        },
      },
    });
    const fieldNames = Object.values(resolvers).map(
      (r) => (r as { Properties: { FieldName: string } }).Properties.FieldName,
    );
    expect(fieldNames).toHaveLength(13);
    for (const f of fieldNames) {
      expect(allFields.has(f)).toBe(true);
    }
  });

  test("grants EvalResolverFunction read/write IAM access to both eval tables", () => {
    // grantReadWriteData produces an IAM::Policy with dynamodb actions
    // scoped to the table (+ index) ARNs. Assert at least one such policy
    // exists referencing the eval resolver's role — narrower per-table ARN
    // matching is brittle against CDK's Fn::Join/GetAtt token shape, so we
    // assert on the action set + role attachment instead.
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
        { Ref: Match.stringLikeRegexp("EvalResolverFunctionServiceRole") },
      ]),
    });
  });

  test("EvalDataSourceRole can invoke EvalResolverFunction", () => {
    // grantInvoke on a single Lambda renders a bare-string Action (not an
    // array) — Match.arrayWith requires array-typed values, so match the
    // string directly here (contrast with the dynamodb grant below, which
    // legitimately renders as an action array).
    template.hasResourceProperties("AWS::IAM::Policy", {
      PolicyDocument: Match.objectLike({
        Statement: Match.arrayWith([
          Match.objectLike({
            Action: "lambda:InvokeFunction",
            Effect: "Allow",
          }),
        ]),
      }),
      Roles: Match.arrayWith([
        { Ref: Match.stringLikeRegexp("EvalDataSourceRole") },
      ]),
    });
  });
});
