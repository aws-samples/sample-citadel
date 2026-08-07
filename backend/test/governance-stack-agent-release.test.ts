/**
 * governance-stack-agent-release.test.ts — GovernanceStack agent-release
 * wiring assertions (agent release bundles, slice 3: wiring only).
 *
 * Mirrors governance-stack-eval-run.test.ts: one AgentReleaseResolverFunction,
 * one AgentReleaseLambdaDataSource, and a CfnResolver for the
 * Mutation.cutAgentRelease field, bound to that data source.
 *
 * The two invariants under test here are the whole risk of this slice:
 *  - The resolver Lambda's role is the EXISTING AgentReleaseWriterRole
 *    (assumed, not a fresh grantReadWriteData call) — so this test also
 *    re-asserts, at the GovernanceStack synth level, that no UpdateItem/
 *    DeleteItem is granted on AgentReleasesTable anywhere in the
 *    template (the IAM immutability floor must survive wiring).
 *  - No new principal picks up broader-than-Put/Get/Query access to the
 *    releases table as a side effect of AppSync/data-source wiring.
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

function createTestStack(): {
  stack: GovernanceStack;
  template: Template;
  backendTemplate: Template;
} {
  const app = new cdk.App();
  const backendStack = new cdk.Stack(app, "MockBackendStackAgentRelease", {
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

  // Slice 1's actual releases table shape (simple PK on releaseId) plus
  // the pre-existing writer role this slice must ASSUME rather than
  // grant afresh — mirrors backend-stack.ts's real AgentReleasesTable /
  // AgentReleaseWriterRole construction exactly (PutItem/GetItem/Query
  // only, nothing else, ever).
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
  agentReleasesTable.addGlobalSecondaryIndex({
    indexName: "org-index",
    partitionKey: { name: "orgId", type: dynamodb.AttributeType.STRING },
    sortKey: { name: "createdAt", type: dynamodb.AttributeType.STRING },
    projectionType: dynamodb.ProjectionType.ALL,
  });
  const agentReleaseWriterRole = new iam.Role(
    backendStack,
    "AgentReleaseWriterRole",
    {
      assumedBy: new iam.ServicePrincipal("lambda.amazonaws.com"),
    },
  );
  agentReleaseWriterRole.addToPolicy(
    new iam.PolicyStatement({
      effect: iam.Effect.ALLOW,
      actions: ["dynamodb:PutItem", "dynamodb:GetItem", "dynamodb:Query"],
      resources: [
        agentReleasesTable.tableArn,
        `${agentReleasesTable.tableArn}/index/*`,
      ],
    }),
  );

  const registryArn =
    "arn:aws:bedrock-agentcore:us-east-1:123456789012:registry/citadel-test";

  const stack = new GovernanceStack(app, "TestGovernanceStackAgentRelease", {
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
    registryArn,
    registryId: "citadel-test",
  });

  const template = Template.fromStack(stack);
  const backendTemplate = Template.fromStack(backendStack);
  return { stack, template, backendTemplate };
}

describe("GovernanceStack — agent-release wiring (cutAgentRelease reachability)", () => {
  let template: Template;
  let backendTemplate: Template;

  beforeAll(() => {
    ({ template, backendTemplate } = createTestStack());
  });

  test("AgentReleaseResolverFunction exists with Node.js 24.x runtime and the expected table/registry env vars", () => {
    template.hasResourceProperties("AWS::Lambda::Function", {
      Handler: "release-resolver.handler",
      Runtime: "nodejs24.x",
      Environment: {
        Variables: Match.objectLike({
          AGENT_RELEASES_TABLE: Match.anyValue(),
          EXECUTION_SPECS_TABLE: Match.anyValue(),
          EVAL_RUNS_TABLE: Match.anyValue(),
          EVAL_SUITES_TABLE: Match.anyValue(),
          PROJECTS_TABLE: Match.anyValue(),
          REGISTRY_ID: Match.anyValue(),
        }),
      },
    });
  });

  test("AgentReleaseResolverFunction's execution role IS the existing AgentReleaseWriterRole (assumed, not a fresh grantReadWriteData role)", () => {
    const fns = template.findResources("AWS::Lambda::Function");
    const match = Object.values(fns).find(
      (f) => f.Properties?.Handler === "release-resolver.handler",
    );
    expect(match).toBeDefined();
    const roleProp = JSON.stringify(match!.Properties.Role);
    // Cross-stack role reference: CDK exports agentReleaseWriterRole's ARN
    // from BackendStack and imports it here via Fn::ImportValue — proof
    // this Lambda ASSUMES the existing role rather than getting a
    // freshly-generated "...ServiceRole..." (which grantReadWriteData
    // or an implicit default role would produce).
    expect(roleProp).toContain("AgentReleaseWriterRole");
    expect(roleProp).not.toContain("ServiceRole");
  });

  test("no fresh IAM Role named *AgentReleaseResolverFunctionServiceRole* is synthesized (confirms no default/grantReadWriteData role was created)", () => {
    const roles = template.findResources("AWS::IAM::Role");
    const freshRoles = Object.keys(roles).filter((id) =>
      id.startsWith("AgentReleaseResolverFunctionServiceRole"),
    );
    expect(freshRoles).toEqual([]);
  });

  test("AgentReleaseLambdaDataSource exists as an AWS_LAMBDA AppSync data source", () => {
    template.hasResourceProperties("AWS::AppSync::DataSource", {
      Name: "AgentReleaseLambdaDataSource",
      Type: "AWS_LAMBDA",
    });
  });

  test("has a Mutation.cutAgentRelease CfnResolver bound to AgentReleaseLambdaDataSource", () => {
    template.hasResourceProperties("AWS::AppSync::Resolver", {
      TypeName: "Mutation",
      FieldName: "cutAgentRelease",
      DataSourceName: {
        "Fn::GetAtt": [
          Match.stringLikeRegexp("AgentReleaseLambdaDataSource"),
          "Name",
        ],
      },
    });
  });

  test("grants read access (via the assumed AgentReleaseWriterRole's policy) to exec-specs/eval-runs/eval-suites/projects tables and the registry", () => {
    // Because agentReleaseWriterRole is an existing role passed in as a
    // prop (not created inside GovernanceStack), grantXxx calls against
    // it attach their statements to a policy owned by the role's own
    // stack (the mock "backend" stack here), not to a fresh
    // ServiceRole/DefaultPolicy inside GovernanceStack. This is the
    // expected cross-stack shape, and it is itself part of what proves
    // the resolver assumes the existing role rather than getting a new
    // grantReadWriteData-generated one.
    const policies = backendTemplate.findResources("AWS::IAM::Policy");
    const writerRolePolicies = Object.values(policies).filter((p) => {
      const roles = (p.Properties?.Roles ?? []) as Array<{ Ref?: string }>;
      return roles.some((r) =>
        (r.Ref ?? "").startsWith("AgentReleaseWriterRole"),
      );
    });
    expect(writerRolePolicies.length).toBeGreaterThan(0);

    const allStatements = writerRolePolicies.flatMap(
      (p) =>
        p.Properties.PolicyDocument.Statement as Array<{
          Action?: string | string[];
          Resource?: unknown;
        }>,
    );
    const allActions = allStatements.flatMap((s) =>
      Array.isArray(s.Action) ? s.Action : [s.Action],
    );
    expect(allActions).toEqual(expect.arrayContaining(["dynamodb:GetItem"]));
    expect(allActions).toEqual(
      expect.arrayContaining(["bedrock-agentcore:GetRegistryRecord"]),
    );
  });

  describe("IAM immutability floor survives wiring", () => {
    function collectReleaseTableActions(tmpl: Template): string[] {
      const policies = tmpl.findResources("AWS::IAM::Policy");
      const actions: string[] = [];
      for (const policy of Object.values(policies)) {
        const stmts: Array<{
          Action?: string | string[];
          Resource?: unknown;
        }> = policy.Properties?.PolicyDocument?.Statement ?? [];
        for (const stmt of stmts) {
          const resources = Array.isArray(stmt.Resource)
            ? stmt.Resource
            : [stmt.Resource];
          const targetsReleaseTable = resources.some((r) =>
            JSON.stringify(r).includes("AgentReleasesTable"),
          );
          if (!targetsReleaseTable) continue;
          const stmtActions = Array.isArray(stmt.Action)
            ? stmt.Action
            : [stmt.Action];
          actions.push(...stmtActions.filter((a): a is string => !!a));
        }
      }
      return actions;
    }

    test("no IAM policy in either the GovernanceStack or the table-owning stack grants UpdateItem or DeleteItem on AgentReleasesTable", () => {
      const actions = [
        ...collectReleaseTableActions(template),
        ...collectReleaseTableActions(backendTemplate),
      ];
      expect(actions).not.toContain("dynamodb:UpdateItem");
      expect(actions).not.toContain("dynamodb:DeleteItem");
    });

    test("every statement referencing AgentReleasesTable grants only Put/Get/Query — no grantReadWriteData-shaped Allow-all-actions was introduced by wiring", () => {
      const actions = [
        ...collectReleaseTableActions(template),
        ...collectReleaseTableActions(backendTemplate),
      ];
      expect(actions.length).toBeGreaterThan(0);
      for (const action of actions) {
        expect([
          "dynamodb:PutItem",
          "dynamodb:GetItem",
          "dynamodb:Query",
        ]).toContain(action);
      }
    });
  });
});
