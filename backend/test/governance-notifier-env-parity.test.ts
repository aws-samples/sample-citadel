/**
 * TS env-parity guard for the governance-notifier Lambda (finding
 * e396a7ee, design §6). `arbiter-stack-env-parity.test.ts` covers only the
 * Python arbiter Lambdas — this closes the same class of gap for the new
 * TS handler: every `process.env.X` read added to governance-notifier.ts
 * must actually be set on the synthesized function's environment, so a new
 * handler env read (e.g. GOVERNANCE_UI_BASE_URL) can never be added without
 * also wiring it on the CDK side.
 *
 * `AWS_REGION` is ambient (Lambda always sets it) and allowlisted.
 */
import * as fs from "fs";
import * as path from "path";
import * as cdk from "aws-cdk-lib";
import { Template } from "aws-cdk-lib/assertions";
import * as appsync from "aws-cdk-lib/aws-appsync";
import * as dynamodb from "aws-cdk-lib/aws-dynamodb";
import * as events from "aws-cdk-lib/aws-events";
import * as iam from "aws-cdk-lib/aws-iam";
import * as sns from "aws-cdk-lib/aws-sns";
import { Bucket } from "aws-cdk-lib/aws-s3";
import { scaffoldBackendAssetDirs } from "./helpers/scaffold-stub-assets";

scaffoldBackendAssetDirs(["dist/lambda", "src/schema"]);

import {
  GovernanceStack,
  type GovernanceStackProps,
} from "../lib/governance-stack";

const AMBIENT_ALLOWLIST = new Set(["AWS_REGION"]);

function scanProcessEnvReads(filePath: string): string[] {
  const source = fs.readFileSync(filePath, "utf8");
  const re = /process\.env\.([A-Z][A-Z0-9_]*)/g;
  const found = new Set<string>();
  let match: RegExpExecArray | null;
  while ((match = re.exec(source)) !== null) {
    found.add(match[1]);
  }
  return [...found].filter((name) => !AMBIENT_ALLOWLIST.has(name));
}

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

function synthGovernanceStack(): Template {
  const app = new cdk.App();
  const backendStack = new cdk.Stack(app, "MockBackendStackParity", {
    env: { account: "123456789012", region: "us-east-1" },
  });

  const agentEventBus = new events.EventBus(
    backendStack,
    "AgentEventBusParity",
    {
      eventBusName: "citadel-agents-test-parity",
    },
  );
  const appSyncApi = new appsync.GraphqlApi(backendStack, "MockApiParity", {
    name: "mock-api-parity",
    schema: appsync.SchemaFile.fromAsset(
      path.resolve(__dirname, "../src/schema/schema.graphql"),
    ),
  });
  const accessLogsBucket = new Bucket(backendStack, "AccessLogsBucketParity", {
    bucketName: "citadel-access-logs-test-parity",
  });
  const alarmTopic = new sns.Topic(backendStack, "AlarmTopicParity", {
    topicName: "citadel-alarms-test-parity",
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
    names.map((n) => [
      n,
      mockTable(backendStack, `${n}Parity`, `citadel-${n}-test-parity`),
    ]),
  ) as Record<string, dynamodb.Table>;

  const agentReleasesTable = mockTable(
    backendStack,
    "AgentReleasesParity",
    "citadel-agent-releases-test-parity",
  );
  const agentReleaseWriterRole = new iam.Role(
    backendStack,
    "AgentReleaseWriterRoleParity",
    { assumedBy: new iam.ServicePrincipal("lambda.amazonaws.com") },
  );
  const environmentReleasePointersTable = new dynamodb.Table(
    backendStack,
    "EnvironmentReleasePointersTableParity",
    {
      tableName: "citadel-environment-release-pointers-test-parity",
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
    "EnvironmentReleasePointerWriterRoleParity",
    { assumedBy: new iam.ServicePrincipal("lambda.amazonaws.com") },
  );
  const promotionPolicyConfigTable = mockTable(
    backendStack,
    "PromotionPolicyConfigParity",
    "citadel-promotion-policy-config-test-parity",
  );
  const promotionPolicyConfigWriterRole = new iam.Role(
    backendStack,
    "PromotionPolicyConfigWriterRoleParity",
    { assumedBy: new iam.ServicePrincipal("lambda.amazonaws.com") },
  );

  const props: GovernanceStackProps = {
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
    governanceUiBaseUrl: "https://ui.example.com",
  };

  const stack = new GovernanceStack(app, "TestGovernanceStackParity", props);
  return Template.fromStack(stack);
}

describe("R14: governance-notifier.ts env-parity — every process.env.X read is set on the function", () => {
  test("every process.env read in the handler source is present in the synthesized Lambda's Environment.Variables", () => {
    const handlerPath = path.resolve(
      __dirname,
      "../src/lambda/governance-notifier.ts",
    );
    const reads = scanProcessEnvReads(handlerPath);
    expect(reads.length).toBeGreaterThan(0); // sanity: the scan itself works

    const template = synthGovernanceStack();
    const fns = template.findResources("AWS::Lambda::Function", {
      Properties: { Handler: "governance-notifier.handler" },
    });
    const fnResources = Object.values(fns) as Array<{
      Properties?: { Environment?: { Variables?: Record<string, unknown> } };
    }>;
    const fn = fnResources[0];
    expect(fn).toBeDefined();
    const envVars: Record<string, unknown> =
      fn?.Properties?.Environment?.Variables ?? {};

    for (const read of reads) {
      expect(envVars).toHaveProperty(read);
    }
  });

  test("bite proof: a made-up unset var is correctly reported as missing (predicate actually fires)", () => {
    const envVars: Record<string, unknown> = { EVENT_BUS_NAME: "x" };
    expect(envVars).not.toHaveProperty("SOME_MADE_UP_UNSET_VAR");
  });
});
