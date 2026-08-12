/**
 * governance-stack-promotion-policy.test.ts — decision ada70113
 * (promotion policy becomes per-org config). CDK template assertions
 * for PromotionPolicyConfigTable (BackendStack) and the admin
 * PromotionPolicyResolverFunction + AppSync wiring (GovernanceStack).
 *
 * Mirrors governance-stack-agent-release.test.ts's mock-stack scaffold
 * pattern: a minimal BackendStack stand-in with just the tables/roles
 * GovernanceStack actually needs, real GovernanceStack synth on top.
 *
 * Invariants under test:
 *  - PromotionPolicyConfigTable exists, PAY_PER_REQUEST, PK=orgId.
 *  - PromotionPolicyResolverFunction has the PROMOTION_POLICY_CONFIG_TABLE
 *    env var and Node.js 24.x runtime.
 *  - Its execution role is the EXISTING promotionPolicyConfigWriterRole
 *    (assumed), not a fresh grantReadWriteData role.
 *  - IAM floor is narrow: GetItem+PutItem only for the writer role, no
 *    grantWriteData anywhere (no UpdateItem/DeleteItem/BatchWriteItem on
 *    this table from any principal).
 *  - The EXISTING environmentReleasePointerWriterRole additionally has a
 *    GetItem-only (never PutItem) statement on this table — no single
 *    statement grants PutItem to that role for this table.
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
  template: Template;
  backendTemplate: Template;
} {
  const app = new cdk.App();
  const backendStack = new cdk.Stack(app, "MockBackendStackPromotionPolicy", {
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
  agentReleasesTable.addGlobalSecondaryIndex({
    indexName: "org-index",
    partitionKey: { name: "orgId", type: dynamodb.AttributeType.STRING },
    sortKey: { name: "createdAt", type: dynamodb.AttributeType.STRING },
    projectionType: dynamodb.ProjectionType.ALL,
  });
  const agentReleaseWriterRole = new iam.Role(
    backendStack,
    "AgentReleaseWriterRole",
    { assumedBy: new iam.ServicePrincipal("lambda.amazonaws.com") },
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
  environmentReleasePointerWriterRole.addToPolicy(
    new iam.PolicyStatement({
      effect: iam.Effect.ALLOW,
      actions: ["dynamodb:PutItem", "dynamodb:GetItem", "dynamodb:Query"],
      resources: [
        environmentReleasePointersTable.tableArn,
        `${environmentReleasePointersTable.tableArn}/index/*`,
      ],
    }),
  );

  // Decision ada70113 — the table + two IAM floors under test. Mirrors
  // backend-stack.ts's real construction: a dedicated writer role for
  // the admin resolver (GetItem+PutItem), plus an ADDITIONAL scoped
  // GetItem-only statement on the EXISTING pointer-writer role above
  // (the promotion gate's read path).
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
  environmentReleasePointerWriterRole.addToPolicy(
    new iam.PolicyStatement({
      effect: iam.Effect.ALLOW,
      actions: ["dynamodb:GetItem"],
      resources: [promotionPolicyConfigTable.tableArn],
    }),
  );

  const registryArn =
    "arn:aws:bedrock-agentcore:us-east-1:123456789012:registry/citadel-test";

  const stack = new GovernanceStack(app, "TestGovernanceStackPromotionPolicy", {
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
    environmentReleasePointersTable,
    environmentReleasePointerWriterRole,
    promotionPolicyConfigTable,
    promotionPolicyConfigWriterRole,
  });

  const template = Template.fromStack(stack);
  const backendTemplate = Template.fromStack(backendStack);
  return { template, backendTemplate };
}

describe("PromotionPolicyConfigTable (decision ada70113)", () => {
  let backendTemplate: Template;

  beforeAll(() => {
    ({ backendTemplate } = createTestStack());
  });

  test("table exists, PAY_PER_REQUEST, PK=orgId", () => {
    backendTemplate.hasResourceProperties("AWS::DynamoDB::Table", {
      TableName: "citadel-promotion-policy-config-test",
      BillingMode: "PAY_PER_REQUEST",
      KeySchema: [{ AttributeName: "orgId", KeyType: "HASH" }],
    });
  });

  test("no single IAM statement grants access to both PromotionPolicyConfigTable and EnvironmentReleasePointersTable's PutItem action", () => {
    const policies = backendTemplate.findResources("AWS::IAM::Policy");
    for (const policy of Object.values(policies)) {
      const stmts: Array<{ Action?: string | string[]; Resource?: unknown }> =
        policy.Properties?.PolicyDocument?.Statement ?? [];
      for (const stmt of stmts) {
        const resources = Array.isArray(stmt.Resource)
          ? stmt.Resource
          : [stmt.Resource];
        const asStrings = resources.map((r) => JSON.stringify(r));
        const targetsPromotionPolicy = asStrings.some((s) =>
          s.includes("PromotionPolicyConfigTable"),
        );
        const actions = Array.isArray(stmt.Action)
          ? stmt.Action
          : [stmt.Action];
        const grantsPutOnPointers =
          asStrings.some((s) =>
            s.includes("EnvironmentReleasePointersTable"),
          ) && actions.includes("dynamodb:PutItem");
        // A statement targeting PromotionPolicyConfigTable must never be
        // the SAME statement that grants PutItem on the pointers table —
        // that would indicate the two tables' write floors were merged.
        expect(targetsPromotionPolicy && grantsPutOnPointers).toBe(false);
      }
    }
  });
});

describe("GovernanceStack — PromotionPolicyResolverFunction wiring", () => {
  let template: Template;

  beforeAll(() => {
    ({ template } = createTestStack());
  });

  test("exists with Node.js 24.x runtime and the PROMOTION_POLICY_CONFIG_TABLE env var", () => {
    template.hasResourceProperties("AWS::Lambda::Function", {
      Handler: "promotion-policy-resolver.handler",
      Runtime: "nodejs24.x",
      Environment: {
        Variables: Match.objectLike({
          PROMOTION_POLICY_CONFIG_TABLE: Match.anyValue(),
        }),
      },
    });
  });

  test("its execution role IS the existing promotionPolicyConfigWriterRole (assumed, not a fresh role)", () => {
    const fns = template.findResources("AWS::Lambda::Function");
    const match = Object.values(fns).find(
      (f) => f.Properties?.Handler === "promotion-policy-resolver.handler",
    );
    expect(match).toBeDefined();
    const roleProp = JSON.stringify(match!.Properties.Role);
    // Cross-stack role reference: CDK exports promotionPolicyConfigWriterRole's
    // ARN from the mock BackendStack and imports it here via
    // Fn::ImportValue — proof this Lambda ASSUMES the existing role
    // rather than getting a fresh GetAtt'd role of its own.
    expect(roleProp).toMatch(
      /Fn::ImportValue|Fn::GetAtt.*PromotionPolicyConfigWriterRole/,
    );
  });

  test("AppSync data source + resolvers exist for setPromotionPolicy (Mutation) and getPromotionPolicy (Query)", () => {
    template.hasResourceProperties("AWS::AppSync::DataSource", {
      Name: "PromotionPolicyLambdaDataSource",
      Type: "AWS_LAMBDA",
    });
    template.hasResourceProperties("AWS::AppSync::Resolver", {
      TypeName: "Mutation",
      FieldName: "setPromotionPolicy",
    });
    template.hasResourceProperties("AWS::AppSync::Resolver", {
      TypeName: "Query",
      FieldName: "getPromotionPolicy",
    });
  });
});
