/**
 * governance-stack-environment-release-pointer-ledger.test.ts —
 * CDK template assertions for finding 23971f32 (fail-closed governance
 * ledger recording).
 *
 * Verified against live AWS: the resolver Lambda had NO
 * GOVERNANCE_LEDGER_TABLE env var and its role had NO statement for
 * citadel-governance-ledger-* — so every ledger write, in both shadow and
 * strict mode, was actually failing at the IAM/config layer, not just
 * theoretically. This file asserts the fix at the CDK synth level:
 *
 *  - EnvironmentReleasePointerResolverFunction's env carries
 *    GOVERNANCE_LEDGER_TABLE.
 *  - environmentReleasePointerWriterRole's synthesized policy grants
 *    dynamodb:PutItem on the ledger table (deterministic ARN — see
 *    backend-stack.ts's construction site for why this is a literal
 *    string, not a construct reference: ArbiterStack, which owns the
 *    real table, is instantiated AFTER BackendStack in bin/app.ts).
 *  - That SAME grant does NOT also carry UpdateItem/DeleteItem/
 *    BatchWriteItem — explicit iam.PolicyStatement, deliberately NOT
 *    grantWriteData (rejected twice in prior work on this role).
 *
 * Mirrors governance-stack-agent-release.test.ts's mock-table scaffold
 * (same prop list GovernanceStack requires), scoped down to only the
 * tables this resolver's slice touches.
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

const GOVERNANCE_LEDGER_TABLE_ARN =
  "arn:aws:dynamodb:us-east-1:123456789012:table/citadel-governance-ledger-test";

function createTestStack(): {
  template: Template;
  backendTemplate: Template;
} {
  const app = new cdk.App();
  const backendStack = new cdk.Stack(app, "MockBackendStackEnvPointerLedger", {
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

  // Environment release pointer table + role — mirrors backend-stack.ts's
  // real construction, INCLUDING the finding-23971f32 PutItem-only grant
  // on the deterministic governance-ledger ARN, so this test exercises the
  // exact IAM shape the real stack produces.
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
  environmentReleasePointerWriterRole.addToPolicy(
    new iam.PolicyStatement({
      effect: iam.Effect.ALLOW,
      actions: ["dynamodb:PutItem"],
      resources: [GOVERNANCE_LEDGER_TABLE_ARN],
    }),
  );

  const registryArn =
    "arn:aws:bedrock-agentcore:us-east-1:123456789012:registry/citadel-test";

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

  const stack = new GovernanceStack(
    app,
    "TestGovernanceStackEnvPointerLedger",
    {
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
    },
  );

  const template = Template.fromStack(stack);
  const backendTemplate = Template.fromStack(backendStack);
  return { template, backendTemplate };
}

describe("GovernanceStack + BackendStack — fail-closed governance ledger recording (finding 23971f32)", () => {
  let template: Template;
  let backendTemplate: Template;

  beforeAll(() => {
    ({ template, backendTemplate } = createTestStack());
  });

  test("EnvironmentReleasePointerResolverFunction's env carries GOVERNANCE_LEDGER_TABLE", () => {
    template.hasResourceProperties("AWS::Lambda::Function", {
      Handler: "environment-release-pointer-resolver.handler",
      Environment: {
        Variables: Match.objectLike({
          GOVERNANCE_LEDGER_TABLE: "citadel-governance-ledger-test",
        }),
      },
    });
  });

  function policiesTargetingLedgerTable() {
    const policies = backendTemplate.findResources("AWS::IAM::Policy");
    return Object.values(policies).filter((p) => {
      const stmts = p.Properties?.PolicyDocument?.Statement ?? [];
      return stmts.some((s: { Resource?: unknown }) => {
        const resources = Array.isArray(s.Resource) ? s.Resource : [s.Resource];
        return resources.some((r: unknown) =>
          JSON.stringify(r).includes("citadel-governance-ledger-test"),
        );
      });
    });
  }

  test("environmentReleasePointerWriterRole's policy grants dynamodb:PutItem on the governance ledger table (deterministic ARN)", () => {
    const policies = policiesTargetingLedgerTable();
    expect(policies.length).toBeGreaterThan(0);

    const grantsPutItem = policies.some((policy) => {
      const stmts = policy.Properties.PolicyDocument.Statement as Array<{
        Action?: string | string[];
        Resource?: unknown;
      }>;
      return stmts.some((stmt) => {
        const resources = Array.isArray(stmt.Resource)
          ? stmt.Resource
          : [stmt.Resource];
        const targetsLedger = resources.some((r) =>
          JSON.stringify(r).includes("citadel-governance-ledger-test"),
        );
        if (!targetsLedger) return false;
        const actions = Array.isArray(stmt.Action)
          ? stmt.Action
          : [stmt.Action];
        return actions.includes("dynamodb:PutItem");
      });
    });
    expect(grantsPutItem).toBe(true);
  });

  test("no statement targeting the governance ledger table also grants UpdateItem/DeleteItem/BatchWriteItem (PutItem-only, never grantWriteData)", () => {
    const policies = policiesTargetingLedgerTable();
    expect(policies.length).toBeGreaterThan(0);

    for (const policy of policies) {
      const stmts = policy.Properties.PolicyDocument.Statement as Array<{
        Action?: string | string[];
        Resource?: unknown;
      }>;
      for (const stmt of stmts) {
        const resources = Array.isArray(stmt.Resource)
          ? stmt.Resource
          : [stmt.Resource];
        const targetsLedger = resources.some((r) =>
          JSON.stringify(r).includes("citadel-governance-ledger-test"),
        );
        if (!targetsLedger) continue;

        const actions = Array.isArray(stmt.Action)
          ? stmt.Action
          : [stmt.Action];
        expect(actions).not.toContain("dynamodb:UpdateItem");
        expect(actions).not.toContain("dynamodb:DeleteItem");
        expect(actions).not.toContain("dynamodb:BatchWriteItem");
      }
    }
  });

  test("no single IAM statement grants access to both EnvironmentReleasePointersTable and the governance ledger table (kept-separate doctrine)", () => {
    const policies = backendTemplate.findResources("AWS::IAM::Policy");
    for (const policy of Object.values(policies)) {
      const stmts: Array<{ Action?: string | string[]; Resource?: unknown }> =
        policy.Properties?.PolicyDocument?.Statement ?? [];
      for (const stmt of stmts) {
        const resources = Array.isArray(stmt.Resource)
          ? stmt.Resource
          : [stmt.Resource];
        const asStrings = resources.map((r) => JSON.stringify(r));
        const targetsPointers = asStrings.some((s) =>
          s.includes("EnvironmentReleasePointersTable"),
        );
        const targetsLedger = asStrings.some((s) =>
          s.includes("citadel-governance-ledger-test"),
        );
        expect(targetsPointers && targetsLedger).toBe(false);
      }
    }
  });
});
