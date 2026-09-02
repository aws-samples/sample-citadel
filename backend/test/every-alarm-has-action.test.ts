/**
 * Structural guard: EVERY CloudWatch alarm must have at least one action.
 *
 * This is the guard that stops a muted alarm shipping again. 20 alarm
 * construct sites across backend/projects/arbiter were historically wired to
 * a topic with ZERO subscriptions (and 20 had no SNS action at all); this
 * test synthesizes the alarm-bearing stacks exactly as bin/app.ts wires them
 * and fails if any alarm has an empty/absent AlarmActions list.
 *
 * A companion bite proof (bottom) demonstrates the assertion actually fires
 * when an alarm's action is removed — a green suite against an unbitten
 * guard proves nothing.
 */
import * as cdk from "aws-cdk-lib";
import { Template } from "aws-cdk-lib/assertions";
import * as cloudwatch from "aws-cdk-lib/aws-cloudwatch";
import * as sns from "aws-cdk-lib/aws-sns";
import * as cw_actions from "aws-cdk-lib/aws-cloudwatch-actions";
import {
  scaffoldBackendAssetDirs,
  scaffoldArbiterStubs,
} from "./helpers/scaffold-stub-assets";

scaffoldBackendAssetDirs(["dist/lambda", "src/schema"]);
scaffoldArbiterStubs();

import { BackendStack } from "../lib/backend-stack";
import { ProjectsStack } from "../lib/projects-stack";
import { ArbiterStack } from "../lib/arbiter-stack";

/**
 * Returns the logical ids of every AWS::CloudWatch::Alarm in `resources`
 * whose AlarmActions is absent or empty. The single predicate shared by the
 * structural guard and the bite proof.
 */
export function findActionlessAlarms(
  resources: Record<
    string,
    { Type: string; Properties?: Record<string, unknown> }
  >,
): string[] {
  const out: string[] = [];
  for (const [logicalId, resource] of Object.entries(resources)) {
    if (resource.Type !== "AWS::CloudWatch::Alarm") continue;
    const actions = (resource.Properties?.AlarmActions ?? []) as unknown[];
    if (!Array.isArray(actions) || actions.length === 0) {
      out.push(logicalId);
    }
  }
  return out;
}

describe("every CloudWatch alarm has at least one action (muted-alarm regression guard)", () => {
  let backendTemplate: Template;
  let projectsTemplate: Template;
  let arbiterTemplate: Template;

  beforeAll(() => {
    // Disable Docker bundling of the arbiter's PythonFunctions so the suite
    // runs without a container runtime (same context flag the arbiter-stack
    // tests use).
    const app = new cdk.App({
      context: { "aws:cdk:bundling-stacks": [] },
    });
    const env = { account: "123456789012", region: "us-east-1" };

    const backend = new BackendStack(app, "citadel-backend-test", {
      environment: "test",
      env,
    });

    const projects = new ProjectsStack(app, "citadel-projects-test", {
      environment: "test",
      env,
      appSyncApi: backend.appSyncApi,
      agentEventBus: backend.agentEventBus,
      projectsTable: backend.projectsTable,
      conversationsTable: backend.conversationsTable,
      agentStatusTable: backend.agentStatusTable,
      documentBucket: backend.documentBucket,
      idempotencyTable: backend.idempotencyTable,
      adrsTable: backend.adrsTable,
      executionSpecificationsTable: backend.executionSpecificationsTable,
      agentDesignAssessmentsTable: backend.agentDesignAssessmentsTable,
      userPool: backend.userPool,
      alarmTopic: backend.alarmTopic,
    });

    const arbiter = new ArbiterStack(app, "citadel-arbiter-test", {
      environment: "test",
      env,
      agentEventBus: backend.agentEventBus,
      agentConfigTable: backend.agentConfigTable,
      codeBucket: backend.codeBucket,
      workflowsTable: backend.workflowsTable,
      executionsTable: backend.executionsTable,
      fanoutFunction: backend.workflowProgressFanoutFunction,
      appSyncEndpoint: backend.appSyncApi.graphqlUrl,
      appsTable: backend.appsTable,
      executionSpecificationsTable: backend.executionSpecificationsTable,
      registryArn: backend.registryArn,
      registryId: backend.registryId,
      alarmTopic: backend.alarmTopic,
    });

    backendTemplate = Template.fromStack(backend);
    projectsTemplate = Template.fromStack(projects);
    arbiterTemplate = Template.fromStack(arbiter);
  });

  test("BackendStack: 12 alarms, none actionless", () => {
    backendTemplate.resourceCountIs("AWS::CloudWatch::Alarm", 12);
    expect(findActionlessAlarms(backendTemplate.toJSON().Resources)).toEqual(
      [],
    );
  });

  test("ProjectsStack: 2 alarms, none actionless", () => {
    projectsTemplate.resourceCountIs("AWS::CloudWatch::Alarm", 2);
    expect(findActionlessAlarms(projectsTemplate.toJSON().Resources)).toEqual(
      [],
    );
  });

  test("ArbiterStack: 8 alarms, none actionless", () => {
    arbiterTemplate.resourceCountIs("AWS::CloudWatch::Alarm", 8);
    expect(findActionlessAlarms(arbiterTemplate.toJSON().Resources)).toEqual(
      [],
    );
  });
});

describe("bite proof: the every-alarm-has-an-action assertion fires when an action is removed", () => {
  function synthOneAlarm(withAction: boolean): Template {
    const app = new cdk.App();
    const stack = new cdk.Stack(app, "BiteStack", {
      env: { account: "123456789012", region: "us-east-1" },
    });
    const topic = new sns.Topic(stack, "T", { topicName: "bite-test" });
    const alarm = new cloudwatch.Alarm(stack, "BiteAlarm", {
      alarmName: "citadel-bite-test",
      metric: new cloudwatch.Metric({
        namespace: "Citadel/Test",
        metricName: "X",
        period: cdk.Duration.minutes(5),
        statistic: "Sum",
      }),
      threshold: 1,
      evaluationPeriods: 1,
      comparisonOperator:
        cloudwatch.ComparisonOperator.GREATER_THAN_OR_EQUAL_TO_THRESHOLD,
      treatMissingData: cloudwatch.TreatMissingData.NOT_BREACHING,
    });
    if (withAction) {
      alarm.addAlarmAction(new cw_actions.SnsAction(topic));
    }
    return Template.fromStack(stack);
  }

  test("RED: an alarm with no action IS flagged by the guard predicate", () => {
    const flagged = findActionlessAlarms(
      synthOneAlarm(false).toJSON().Resources,
    );
    expect(flagged.length).toBe(1);
    // And the assertion the structural tests use would fail on it.
    expect(() => expect(flagged).toEqual([])).toThrow();
  });

  test("GREEN: the same alarm WITH an action is not flagged", () => {
    expect(
      findActionlessAlarms(synthOneAlarm(true).toJSON().Resources),
    ).toEqual([]);
  });
});
