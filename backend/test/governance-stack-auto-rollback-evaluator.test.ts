/**
 * governance-stack-auto-rollback-evaluator.test.ts — CDK template
 * assertions for the auto-rollback evaluator (decisions D2/D6/D8):
 *  - the evaluator Lambda exists with the expected handler + env vars;
 *  - it is triggered by a 1-minute schedule rule (D2, poll only);
 *  - its role is least-privilege (cost-ledger Query, governance-ledger
 *    PutItem, no DeleteItem, no promote path);
 *  - the finding-write-failure alarm exists on the EMF metric (D6).
 *
 * Mirrors governance-stack-environment-release-pointer-ledger.test.ts's
 * mock-table scaffold (same GovernanceStack prop list).
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
import { assertSharedAsyncDlqShape } from "./helpers/shared-dlq-shape";

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

function createTemplate(): Template {
  const app = new cdk.App();
  const backendStack = new cdk.Stack(app, "MockBackendStackRollback", {
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
  const alarmTopic = new sns.Topic(backendStack, "AlarmTopic", {
    topicName: "citadel-alarms-test",
  });

  const names = [
    "Adrs",
    "AdrReopenAttempts",
    "ExecutionSpecifications",
    "InterrogationRounds",
    "AgentDesignAssessments",
    "ProgramReviews",
    "Projects",
    "EvalSuites",
    "EvalCases",
    "EvalRuns",
    "EvalRunCaseResults",
    "EvalBaselines",
    "EvalComparisons",
    "EvalComparisonConfig",
    "Executions",
    "Conversations",
  ];
  const t = Object.fromEntries(
    names.map((n) => [n, mockTable(backendStack, n, `citadel-${n}-test`)]),
  ) as Record<string, dynamodb.Table>;

  const agentReleasesTable = mockTable(
    backendStack,
    "AgentReleases",
    "citadel-agent-releases-test",
  );
  const agentReleaseWriterRole = new iam.Role(
    backendStack,
    "AgentReleaseWriterRole",
    {
      assumedBy: new iam.ServicePrincipal("lambda.amazonaws.com"),
    },
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
    {
      assumedBy: new iam.ServicePrincipal("lambda.amazonaws.com"),
    },
  );
  const promotionPolicyConfigTable = mockTable(
    backendStack,
    "PromotionPolicyConfig",
    "citadel-promotion-policy-config-test",
  );
  const promotionPolicyConfigWriterRole = new iam.Role(
    backendStack,
    "PromotionPolicyConfigWriterRole",
    {
      assumedBy: new iam.ServicePrincipal("lambda.amazonaws.com"),
    },
  );

  const stack = new GovernanceStack(app, "TestGovernanceStackRollback", {
    env: { account: "123456789012", region: "us-east-1" },
    environment: "test",
    appSyncApi,
    agentEventBus,
    accessLogsBucket,
    adrsTable: t.Adrs,
    adrReopenAttemptsTable: t.AdrReopenAttempts,
    executionSpecificationsTable: t.ExecutionSpecifications,
    interrogationRoundsTable: t.InterrogationRounds,
    agentDesignAssessmentsTable: t.AgentDesignAssessments,
    programReviewsTable: t.ProgramReviews,
    projectsTable: t.Projects,
    evalSuitesTable: t.EvalSuites,
    evalCasesTable: t.EvalCases,
    evalRunsTable: t.EvalRuns,
    evalRunCaseResultsTable: t.EvalRunCaseResults,
    evalBaselinesTable: t.EvalBaselines,
    evalComparisonsTable: t.EvalComparisons,
    evalComparisonConfigTable: t.EvalComparisonConfig,
    executionsTable: t.Executions,
    conversationsTable: t.Conversations,
    agentReleasesTable,
    agentReleaseWriterRole,
    registryArn:
      "arn:aws:bedrock-agentcore:us-east-1:123456789012:registry/citadel-test",
    registryId: "citadel-test",
    environmentReleasePointersTable,
    environmentReleasePointerWriterRole,
    promotionPolicyConfigTable,
    promotionPolicyConfigWriterRole,
    alarmTopic,
  });
  return Template.fromStack(stack);
}

describe("GovernanceStack — auto-rollback evaluator", () => {
  let template: Template;
  beforeAll(() => {
    template = createTemplate();
  });

  test("D2/D6: evaluator Lambda exists with the expected handler + env vars", () => {
    template.hasResourceProperties("AWS::Lambda::Function", {
      Handler: "agent-release-rollback-evaluator.handler",
      Runtime: "nodejs24.x",
      Environment: {
        Variables: Match.objectLike({
          ENVIRONMENT_RELEASE_POINTERS_TABLE: Match.anyValue(),
          ENVIRONMENT_RELEASE_POINTER_HISTORY_TABLE: Match.anyValue(),
          PROMOTION_POLICY_CONFIG_TABLE: Match.anyValue(),
          COST_LEDGER_TABLE: "citadel-cost-ledger-test",
          GOVERNANCE_LEDGER_TABLE: "citadel-governance-ledger-test",
          EVENT_BUS_NAME: Match.anyValue(),
        }),
      },
    });
  });

  test("D2: triggered by a 1-minute schedule rule (poll only)", () => {
    template.hasResourceProperties("AWS::Events::Rule", {
      ScheduleExpression: "rate(1 minute)",
    });
  });

  test("D6: defines the AutoRollbackFindingWriteFailure alarm", () => {
    template.hasResourceProperties("AWS::CloudWatch::Alarm", {
      MetricName: "AutoRollbackFindingWriteFailure",
      Namespace: "Citadel/Governance",
    });
  });

  test("least-privilege: evaluator role Queries the cost ledger and never Deletes a pointer", () => {
    const policies = template.findResources("AWS::IAM::Policy");
    // Scope strictly to the evaluator's OWN role policies (the stack has
    // many other roles with broader grants).
    const evaluatorPolicies = Object.values(policies).filter((p) =>
      JSON.stringify(p.Properties?.Roles ?? []).includes(
        "AgentReleaseRollbackEvaluatorRole",
      ),
    );
    expect(evaluatorPolicies.length).toBeGreaterThan(0);

    let grantsCostLedgerQuery = false;
    for (const policy of evaluatorPolicies) {
      const stmts: Array<{ Action?: string | string[]; Resource?: unknown }> =
        policy.Properties?.PolicyDocument?.Statement ?? [];
      for (const stmt of stmts) {
        const resources = Array.isArray(stmt.Resource)
          ? stmt.Resource
          : [stmt.Resource];
        const asStrings = resources.map((r) => JSON.stringify(r));
        const actions = Array.isArray(stmt.Action)
          ? stmt.Action
          : [stmt.Action];
        if (
          asStrings.some((s) => s.includes("citadel-cost-ledger-test")) &&
          actions.includes("dynamodb:Query")
        ) {
          grantsCostLedgerQuery = true;
        }
        // The evaluator's own role never Deletes and has no promote path.
        expect(actions).not.toContain("dynamodb:DeleteItem");
      }
    }
    expect(grantsCostLedgerQuery).toBe(true);
  });
});

// CIT-125 slice A follow-up (design A.6 #6, deferred from the feature PR
// per the slice-A verification advisory): shared async DLQ queue shape,
// asserted against this file's existing Template.fromStack harness.
describe("GovernanceStack — CIT-125 slice A shared async DLQ shape", () => {
  let template: Template;
  beforeAll(() => {
    template = createTemplate();
  });

  test("shared async DLQ carries the design queue shape (14d retention, SQS-managed SSE, enforceSSL policy)", () => {
    assertSharedAsyncDlqShape(template, "governance");
  });
});
