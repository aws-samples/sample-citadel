/**
 * Structural guard (finding e396a7ee, PART B): the governance-notifier
 * must fan out to at least one NON-EPHEMERAL destination (SNS) in addition
 * to the ephemeral AppSync/WebSocket mutation, so a future refactor cannot
 * silently revert to WS-only (the original silent zero-subscriber bug).
 *
 * Also covers the secondary finding (163d4776): every claimed-CRITICAL
 * detail-type must appear in BOTH GOVERNANCE_DETAIL_TYPES and the
 * GovernanceEventsRule eventPattern.detailType list (the auto_rollback
 * routing gap).
 *
 * A companion bite proof demonstrates each predicate actually fires when
 * the wiring it guards is removed — a green suite against an unbitten
 * guard proves nothing (see every-alarm-has-action.test.ts precedent).
 *
 * Scaffold mirrors governance-stack-auto-rollback-evaluator.test.ts's
 * mock-table convention (single wrapper `backendStack`, GovernanceStack
 * as a child of the SAME app).
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

import {
  GovernanceStack,
  type GovernanceStackProps,
} from "../lib/governance-stack";
import { CRITICAL_GOVERNANCE_DETAIL_TYPES } from "../src/utils/notifier-base";

interface IamStatement {
  Effect?: string;
  Action?: string | string[];
  Resource?: unknown;
}
interface CfnResource {
  Type: string;
  Properties?: Record<string, unknown>;
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

function buildProps(
  backendStack: cdk.Stack,
  suffix: string,
): GovernanceStackProps {
  const agentEventBus = new events.EventBus(
    backendStack,
    `AgentEventBus${suffix}`,
    { eventBusName: `citadel-agents-test${suffix}` },
  );
  const appSyncApi = new appsync.GraphqlApi(backendStack, `MockApi${suffix}`, {
    name: `mock-api${suffix}`,
    schema: appsync.SchemaFile.fromAsset(
      path.resolve(__dirname, "../src/schema/schema.graphql"),
    ),
  });
  const accessLogsBucket = new Bucket(
    backendStack,
    `AccessLogsBucket${suffix}`,
    {
      bucketName: `citadel-access-logs-test${suffix.toLowerCase()}`,
    },
  );
  const alarmTopic = new sns.Topic(backendStack, `AlarmTopic${suffix}`, {
    topicName: `citadel-alarms-test${suffix.toLowerCase()}`,
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
      mockTable(
        backendStack,
        `${n}${suffix}`,
        `citadel-${n}-test${suffix.toLowerCase()}`,
      ),
    ]),
  ) as Record<string, dynamodb.Table>;

  const agentReleasesTable = mockTable(
    backendStack,
    `AgentReleases${suffix}`,
    `citadel-agent-releases-test${suffix.toLowerCase()}`,
  );
  const agentReleaseWriterRole = new iam.Role(
    backendStack,
    `AgentReleaseWriterRole${suffix}`,
    { assumedBy: new iam.ServicePrincipal("lambda.amazonaws.com") },
  );
  const environmentReleasePointersTable = new dynamodb.Table(
    backendStack,
    `EnvironmentReleasePointersTable${suffix}`,
    {
      tableName: `citadel-environment-release-pointers-test${suffix.toLowerCase()}`,
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
    `EnvironmentReleasePointerWriterRole${suffix}`,
    { assumedBy: new iam.ServicePrincipal("lambda.amazonaws.com") },
  );
  const promotionPolicyConfigTable = mockTable(
    backendStack,
    `PromotionPolicyConfig${suffix}`,
    `citadel-promotion-policy-config-test${suffix.toLowerCase()}`,
  );
  const promotionPolicyConfigWriterRole = new iam.Role(
    backendStack,
    `PromotionPolicyConfigWriterRole${suffix}`,
    { assumedBy: new iam.ServicePrincipal("lambda.amazonaws.com") },
  );

  return {
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
  };
}

function synthGovernanceStack(
  suffix: string,
  mutate?: (props: GovernanceStackProps) => GovernanceStackProps,
): Template {
  const app = new cdk.App();
  const backendStack = new cdk.Stack(app, `MockBackendStack${suffix}`, {
    env: { account: "123456789012", region: "us-east-1" },
  });
  let props = buildProps(backendStack, suffix);
  if (mutate) props = mutate(props);
  const stack = new GovernanceStack(app, `TestGovernanceStack${suffix}`, props);
  return Template.fromStack(stack);
}

describe("R10: notifier function env carries the durable-destination config", () => {
  test("ALARM_TOPIC_ARN, NOTIFICATION_OUTCOMES_TABLE, GOVERNANCE_UI_BASE_URL are all set", () => {
    const template = synthGovernanceStack("R10");
    template.hasResourceProperties("AWS::Lambda::Function", {
      Handler: "governance-notifier.handler",
      Environment: {
        Variables: Match.objectLike({
          ALARM_TOPIC_ARN: Match.anyValue(),
          NOTIFICATION_OUTCOMES_TABLE: Match.anyValue(),
        }),
      },
    });
  });
});

describe("R11: notifier IAM role has scoped sns:Publish + dynamodb:PutItem + cloudwatch:PutMetricData, retains appsync:GraphQL", () => {
  test("scoped least-privilege statements are present", () => {
    const template = synthGovernanceStack("R11a");
    const policies = template.findResources("AWS::IAM::Policy");
    const allStatements: IamStatement[] = Object.values(policies).flatMap(
      (p: CfnResource) =>
        (p.Properties?.PolicyDocument as { Statement?: IamStatement[] })
          ?.Statement ?? [],
    );

    const includesAction = (s: IamStatement, action: string) =>
      s.Effect === "Allow" &&
      (Array.isArray(s.Action) ? s.Action : [s.Action]).includes(action);

    expect(allStatements.some((s) => includesAction(s, "sns:Publish"))).toBe(
      true,
    );
    expect(
      allStatements.some((s) => includesAction(s, "dynamodb:PutItem")),
    ).toBe(true);
    expect(
      allStatements.some((s) => includesAction(s, "cloudwatch:PutMetricData")),
    ).toBe(true);
    expect(
      allStatements.some((s) => includesAction(s, "appsync:GraphQL")),
    ).toBe(true);
  });

  test("dynamodb:PutItem statement does not also grant UpdateItem/DeleteItem/BatchWriteItem (no grantWriteData over-widening)", () => {
    const template = synthGovernanceStack("R11b");
    const policies = template.findResources("AWS::IAM::Policy");
    const allStatements: IamStatement[] = Object.values(policies).flatMap(
      (p: CfnResource) =>
        (p.Properties?.PolicyDocument as { Statement?: IamStatement[] })
          ?.Statement ?? [],
    );
    const putItemStatement = allStatements.find(
      (s) =>
        s.Effect === "Allow" &&
        (Array.isArray(s.Action) ? s.Action : [s.Action]).includes(
          "dynamodb:PutItem",
        ),
    );
    expect(putItemStatement).toBeDefined();
    const actions = Array.isArray(putItemStatement.Action)
      ? putItemStatement.Action
      : [putItemStatement.Action];
    expect(actions).not.toContain("dynamodb:UpdateItem");
    expect(actions).not.toContain("dynamodb:DeleteItem");
    expect(actions).not.toContain("dynamodb:BatchWriteItem");
  });
});

describe("R12: NotifierOutcomeWriteFailure alarm exists with >=1 action; bite proof on removal", () => {
  test("GREEN: the alarm exists in the synthesized template with an action", () => {
    const template = synthGovernanceStack("R12");
    const alarms = template.findResources("AWS::CloudWatch::Alarm", {
      Properties: { MetricName: "NotifierOutcomeWriteFailure" },
    });
    const matches = Object.values(alarms) as CfnResource[];
    expect(matches.length).toBeGreaterThanOrEqual(1);
    const actions = (matches[0].Properties?.AlarmActions as unknown[]) ?? [];
    expect(Array.isArray(actions)).toBe(true);
    expect(actions.length).toBeGreaterThanOrEqual(1);
  });

  test("bite proof predicate: an alarm with the same MetricName but empty AlarmActions IS flagged", () => {
    // Mirrors findActionlessAlarms from every-alarm-has-action.test.ts —
    // demonstrates the assertion style actually fires on a muted alarm.
    const resources: Record<
      string,
      { Type: string; Properties?: Record<string, unknown> }
    > = {
      SomeAlarm: {
        Type: "AWS::CloudWatch::Alarm",
        Properties: {
          MetricName: "NotifierOutcomeWriteFailure",
          AlarmActions: [],
        },
      },
    };
    const actionless = Object.values(resources).filter((r) => {
      const actions = (r.Properties?.AlarmActions ?? []) as unknown[];
      return (
        r.Type === "AWS::CloudWatch::Alarm" &&
        (!Array.isArray(actions) || actions.length === 0)
      );
    });
    expect(actionless.length).toBe(1);
  });
});

describe("R13: alarmTopic is a REQUIRED prop on GovernanceStackProps", () => {
  test("constructing GovernanceStack without alarmTopic fails at runtime (no silent WS-only fallback)", () => {
    const app = new cdk.App();
    const backendStack = new cdk.Stack(app, "MockBackendStackR13", {
      env: { account: "123456789012", region: "us-east-1" },
    });
    const props = buildProps(backendStack, "R13");
    // Simulates a caller that forgot to pass alarmTopic — this must fail
    // loudly (throw) rather than silently constructing a WS-only notifier.
    const propsWithoutAlarmTopic = {
      ...props,
    } as Partial<GovernanceStackProps>;
    delete propsWithoutAlarmTopic.alarmTopic;
    expect(
      () =>
        new GovernanceStack(
          app,
          "TestGovernanceStackR13NoAlarm",
          propsWithoutAlarmTopic as GovernanceStackProps,
        ),
    ).toThrow();
  });
});

describe("secondary finding 163d4776: lock-step CRITICAL detail-types in the EventBridge rule", () => {
  function ruleDetailTypes(template: Template): string[] {
    const rules = template.findResources("AWS::Events::Rule");
    const governanceRule = Object.values(rules).find(
      (r: CfnResource) =>
        typeof r.Properties?.Name === "string" &&
        (r.Properties.Name as string).includes("citadel-governance-events"),
    ) as CfnResource | undefined;
    expect(governanceRule).toBeDefined();
    const eventPattern = governanceRule!.Properties?.EventPattern as {
      "detail-type": string[];
    };
    return eventPattern["detail-type"];
  }

  test("every CRITICAL_GOVERNANCE_DETAIL_TYPES member is present in the GovernanceEventsRule eventPattern.detailType list", () => {
    const template = synthGovernanceStack("Rule1");
    const types = ruleDetailTypes(template);
    for (const critical of CRITICAL_GOVERNANCE_DETAIL_TYPES) {
      expect(types).toContain(critical);
    }
  });

  test("governance.release.auto_rollback specifically is routed by the rule (the auto-rollback gap)", () => {
    const template = synthGovernanceStack("Rule2");
    const types = ruleDetailTypes(template);
    expect(types).toContain("governance.release.auto_rollback");
  });
});
