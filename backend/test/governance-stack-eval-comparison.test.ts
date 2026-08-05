/**
 * CIT-105 Pass 2 — GovernanceStack eval-comparison wiring assertions.
 *
 * Mirrors governance-stack-eval-run.test.ts (CIT-102): one
 * EvalComparisonResolverFunction (own IAM role per kept-separate doctrine),
 * one EvalComparisonLambdaDataSource, one CfnResolver per eval-comparison
 * Mutation/Query field, least-privilege grants (RW on its three own tables +
 * case-results for inline-scoring persistence; read-only on suites/cases/
 * runs), PutEvents on the agent bus, and prefix-scoped S3 access covering
 * eval-comparisons/* (the pre-existing "no bucket-wide grant" guard in
 * governance-stack-eval-run.test.ts only inspects string-valued Resource
 * entries — the two-prefix grant here is array-valued, so it is asserted
 * explicitly in this file).
 */
import * as cdk from "aws-cdk-lib";
import { Template, Match } from "aws-cdk-lib/assertions";
import * as appsync from "aws-cdk-lib/aws-appsync";
import * as dynamodb from "aws-cdk-lib/aws-dynamodb";
import * as events from "aws-cdk-lib/aws-events";
import { Bucket } from "aws-cdk-lib/aws-s3";
import * as path from "path";
import { scaffoldBackendAssetDirs } from "./helpers/scaffold-stub-assets";

scaffoldBackendAssetDirs(["dist/lambda", "src/schema"]);

import { GovernanceStack } from "../lib/governance-stack";

const EVAL_COMPARISON_MUTATION_FIELDS = [
  "designateEvalBaseline",
  "computeEvalComparison",
  "setEvalComparisonThresholdConfig",
];
const EVAL_COMPARISON_QUERY_FIELDS = [
  "getEvalBaseline",
  "listEvalBaselines",
  "getEvalComparison",
  "listEvalComparisons",
  "getEvalComparisonThresholdConfig",
  "getEvalCaseArtifactDiff",
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
  const backendStack = new cdk.Stack(app, "MockBackendStackEvalComparison", {
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

  const stack = new GovernanceStack(app, "TestGovernanceStackEvalComparison", {
    env: { account: "123456789012", region: "us-east-1" },
    environment: "test",
    appSyncApi,
    agentEventBus,
    accessLogsBucket,
    adrsTable: mockTable(backendStack, "Adrs", "citadel-adrs-test"),
    adrReopenAttemptsTable: mockTable(
      backendStack,
      "AdrReopenAttempts",
      "citadel-adr-reopen-attempts-test",
    ),
    executionSpecificationsTable: mockTable(
      backendStack,
      "ExecutionSpecifications",
      "citadel-execution-specifications-test",
    ),
    interrogationRoundsTable: mockTable(
      backendStack,
      "InterrogationRounds",
      "citadel-interrogation-rounds-test",
    ),
    agentDesignAssessmentsTable: mockTable(
      backendStack,
      "AgentDesignAssessments",
      "citadel-agent-design-assessments-test",
    ),
    programReviewsTable: mockTable(
      backendStack,
      "ProgramReviews",
      "citadel-program-reviews-test",
    ),
    projectsTable: mockTable(backendStack, "Projects", "citadel-projects-test"),
    evalSuitesTable: mockTable(
      backendStack,
      "EvalSuites",
      "citadel-eval-suites-test",
    ),
    evalCasesTable: mockTable(
      backendStack,
      "EvalCases",
      "citadel-eval-cases-test",
    ),
    evalRunsTable: mockTable(
      backendStack,
      "EvalRuns",
      "citadel-eval-runs-test",
    ),
    evalRunCaseResultsTable: mockTable(
      backendStack,
      "EvalRunCaseResults",
      "citadel-eval-run-case-results-test",
    ),
    evalBaselinesTable: mockTable(
      backendStack,
      "EvalBaselines",
      "citadel-eval-baselines-test",
    ),
    evalComparisonsTable: mockTable(
      backendStack,
      "EvalComparisons",
      "citadel-eval-comparisons-test",
    ),
    evalComparisonConfigTable: mockTable(
      backendStack,
      "EvalComparisonConfig",
      "citadel-eval-comparison-config-test",
    ),
    executionsTable: mockTable(
      backendStack,
      "Executions",
      "citadel-executions-test",
    ),
    conversationsTable: mockTable(
      backendStack,
      "Conversations",
      "citadel-conversations-test",
    ),
  });

  const template = Template.fromStack(stack);
  return { stack, template };
}

describe("GovernanceStack — eval-comparison wiring (CIT-105)", () => {
  let template: Template;

  beforeAll(() => {
    ({ template } = createTestStack());
  });

  test("EvalComparisonResolverFunction exists with Node.js 24.x runtime and all seven table env vars + event bus", () => {
    template.hasResourceProperties("AWS::Lambda::Function", {
      Handler: "eval-comparison-resolver.handler",
      Runtime: "nodejs24.x",
      Environment: {
        Variables: Match.objectLike({
          EVAL_BASELINES_TABLE: Match.anyValue(),
          EVAL_COMPARISONS_TABLE: Match.anyValue(),
          EVAL_COMPARISON_CONFIG_TABLE: Match.anyValue(),
          EVAL_SUITES_TABLE: Match.anyValue(),
          EVAL_CASES_TABLE: Match.anyValue(),
          EVAL_RUNS_TABLE: Match.anyValue(),
          EVAL_RUN_CASE_RESULTS_TABLE: Match.anyValue(),
          EVENT_BUS_NAME: Match.anyValue(),
        }),
      },
    });
  });

  test("EvalComparisonLambdaDataSource exists as an AWS_LAMBDA AppSync data source", () => {
    template.hasResourceProperties("AWS::AppSync::DataSource", {
      Name: "EvalComparisonLambdaDataSource",
      Type: "AWS_LAMBDA",
    });
  });

  test.each(EVAL_COMPARISON_MUTATION_FIELDS)(
    "has a Mutation.%s CfnResolver bound to EvalComparisonLambdaDataSource",
    (fieldName) => {
      template.hasResourceProperties("AWS::AppSync::Resolver", {
        TypeName: "Mutation",
        FieldName: fieldName,
        DataSourceName: {
          "Fn::GetAtt": [
            Match.stringLikeRegexp("EvalComparisonLambdaDataSource"),
            "Name",
          ],
        },
      });
    },
  );

  test.each(EVAL_COMPARISON_QUERY_FIELDS)(
    "has a Query.%s CfnResolver bound to EvalComparisonLambdaDataSource",
    (fieldName) => {
      template.hasResourceProperties("AWS::AppSync::Resolver", {
        TypeName: "Query",
        FieldName: fieldName,
        DataSourceName: {
          "Fn::GetAtt": [
            Match.stringLikeRegexp("EvalComparisonLambdaDataSource"),
            "Name",
          ],
        },
      });
    },
  );

  test("grants EvalComparisonResolverFunction read/write access (its own tables + case-results for inline-scoring persistence)", () => {
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
        {
          Ref: Match.stringLikeRegexp(
            "EvalComparisonResolverFunctionServiceRole",
          ),
        },
      ]),
    });
  });

  test("read-only tables (suites/cases/runs) never receive a write action on the comparison resolver's role", () => {
    const policies = template.findResources("AWS::IAM::Policy");
    // Resource entries are Fn::ImportValue strings shaped like
    // `...:ExportsOutputFnGetAtt<LogicalId><8-hex><...>Arn<...>` — anchor on
    // the FnGetAtt token + the 8-hex hash so `EvalRuns` can never match
    // `EvalRunCaseResults` (the char after "EvalRuns" there is lowercase).
    const readOnlyPattern =
      /FnGetAtt(EvalSuites|EvalCases|EvalRuns)[0-9A-F]{8}/;
    const writeStatementResources: string[] = [];
    for (const [, resource] of Object.entries(policies)) {
      const props = (
        resource as {
          Properties: {
            PolicyDocument: { Statement: Array<Record<string, unknown>> };
            Roles?: Array<{ Ref?: string }>;
          };
        }
      ).Properties;
      const isComparisonRole = (props.Roles ?? []).some((r) =>
        (r.Ref ?? "").startsWith("EvalComparisonResolverFunctionServiceRole"),
      );
      if (!isComparisonRole) continue;
      for (const stmt of props.PolicyDocument.Statement) {
        const actions = Array.isArray(stmt.Action)
          ? (stmt.Action as string[])
          : [stmt.Action as string];
        const hasDdbWrite = actions.some(
          (a) =>
            a === "dynamodb:PutItem" ||
            a === "dynamodb:UpdateItem" ||
            a === "dynamodb:DeleteItem" ||
            a === "dynamodb:BatchWriteItem",
        );
        if (!hasDdbWrite) continue;
        const json = JSON.stringify(stmt.Resource);
        writeStatementResources.push(json);
        expect(json).not.toMatch(readOnlyPattern);
      }
    }
    // Positive control (non-vacuous guard): the RW grants on the resolver's
    // own tables + case-results MUST be visible through the same lens.
    const allWrites = writeStatementResources.join("|");
    expect(allWrites).toMatch(/FnGetAttEvalRunCaseResults[0-9A-F]{8}/);
    expect(allWrites).toMatch(/FnGetAttEvalBaselines[0-9A-F]{8}/);
    expect(allWrites).toMatch(/FnGetAttEvalComparisons[0-9A-F]{8}/);
    expect(allWrites).toMatch(/FnGetAttEvalComparisonConfig[0-9A-F]{8}/);
  });

  test("PutEvents granted on the agent event bus", () => {
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
            "EvalComparisonResolverFunctionServiceRole",
          ),
        },
      ]),
    });
  });

  test("S3 grant is prefix-scoped to eval-runs/* AND eval-comparisons/* — never bucket-wide (array-valued Resource, uncovered by the eval-run guard)", () => {
    template.hasResourceProperties("AWS::IAM::Policy", {
      PolicyDocument: Match.objectLike({
        Statement: Match.arrayWith([
          Match.objectLike({
            Action: ["s3:PutObject", "s3:GetObject"],
            Effect: "Allow",
            Resource: Match.arrayWith([
              Match.stringLikeRegexp(
                "^arn:aws:s3:::citadel-telemetry-test-replaypackagebucket\\*/eval-runs/\\*$",
              ),
              Match.stringLikeRegexp(
                "^arn:aws:s3:::citadel-telemetry-test-replaypackagebucket\\*/eval-comparisons/\\*$",
              ),
            ]),
          }),
        ]),
      }),
      Roles: Match.arrayWith([
        {
          Ref: Match.stringLikeRegexp(
            "EvalComparisonResolverFunctionServiceRole",
          ),
        },
      ]),
    });
  });

  // CIT-105 per-case artifact read path (memory
  // projects/cit-105-artifacts-design §5): the read path is served by the
  // SAME resolver Lambda/data source/role — it must add exactly one new
  // CfnResolver (asserted via EVAL_COMPARISON_QUERY_FIELDS above) and NO
  // new or bucket-wide S3 statement, since the existing eval-runs/* grant
  // already covers the GetObject this path needs.
  describe("CIT-105 getEvalCaseArtifactDiff — no new/bucket-wide S3 grant", () => {
    test("exactly one S3 policy statement exists on the comparison role, still prefix-scoped to the same two prefixes", () => {
      const policies = template.findResources("AWS::IAM::Policy");
      const s3Statements: Array<Record<string, unknown>> = [];
      for (const [, resource] of Object.entries(policies)) {
        const props = (
          resource as {
            Properties: {
              PolicyDocument: { Statement: Array<Record<string, unknown>> };
              Roles?: Array<{ Ref?: string }>;
            };
          }
        ).Properties;
        const isComparisonRole = (props.Roles ?? []).some((r) =>
          (r.Ref ?? "").startsWith("EvalComparisonResolverFunctionServiceRole"),
        );
        if (!isComparisonRole) continue;
        for (const stmt of props.PolicyDocument.Statement) {
          const actions = Array.isArray(stmt.Action)
            ? (stmt.Action as string[])
            : [stmt.Action as string];
          if (
            actions.some((a) => typeof a === "string" && a.startsWith("s3:"))
          ) {
            s3Statements.push(stmt);
          }
        }
      }

      // Exactly one S3 statement — no second/duplicate statement was
      // introduced for the read path.
      expect(s3Statements.length).toBe(1);

      const resourceJson = JSON.stringify(s3Statements[0].Resource);
      // Never bucket-wide: every resource entry must carry a `/` prefix
      // segment (eval-runs/* or eval-comparisons/*), never a bare
      // `.../replaypackagebucket*` with no prefix.
      expect(resourceJson).toMatch(/eval-runs\\?\/\*/);
      expect(resourceJson).toMatch(/eval-comparisons\\?\/\*/);
      expect(resourceJson).not.toMatch(/replaypackagebucket\*"(?!.*eval-)/);
    });

    test("env vars on EvalComparisonResolverFunction are unchanged by the read path (still exactly the pre-existing seven table vars + event bus)", () => {
      const fns = template.findResources("AWS::Lambda::Function", {
        Properties: {
          Handler: "eval-comparison-resolver.handler",
        },
      });
      const [, fn] = Object.entries(fns)[0];
      const vars = (
        fn as {
          Properties: { Environment: { Variables: Record<string, unknown> } };
        }
      ).Properties.Environment.Variables;
      expect(Object.keys(vars).sort()).toEqual(
        [
          "ENVIRONMENT",
          "EVAL_BASELINES_TABLE",
          "EVAL_CASES_TABLE",
          "EVAL_COMPARISONS_TABLE",
          "EVAL_COMPARISON_CONFIG_TABLE",
          "EVAL_RUNS_TABLE",
          "EVAL_RUN_CASE_RESULTS_TABLE",
          "EVAL_SUITES_TABLE",
          "EVENT_BUS_NAME",
        ].sort(),
      );
    });
  });
});
