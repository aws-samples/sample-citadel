/**
 * Real-stack alarm-delivery wiring: proves the `alarmDelivery` prop threaded
 * from bin/app.ts reaches attachAlarmDelivery inside the topic-owning stacks.
 *
 * ArbiterStack is the KMS-critical path (its escalation topic is
 * CMK-encrypted). Two KMS grants on that CMK are UNCONDITIONAL — present in
 * every alarmDelivery mode, including `none`:
 *   - cloudwatch.amazonaws.com (grantCloudWatchAlarmPublish, wired at
 *     topic-construction time in arbiter-stack.ts) — required for the
 *     OffFrontierEscalation alarm action to publish to the topic at all.
 *   - sns.amazonaws.com (grantSnsDeliveryDecrypt, wired by
 *     attachAlarmDelivery) — required for SNS to decrypt+fan out to any
 *     subscriber protocol.
 * BackendStack's alarm topic is plaintext, so it needs neither grant.
 */
import * as cdk from "aws-cdk-lib";
import { Template, Match } from "aws-cdk-lib/assertions";
import * as dynamodb from "aws-cdk-lib/aws-dynamodb";
import * as events from "aws-cdk-lib/aws-events";
import * as lambda from "aws-cdk-lib/aws-lambda";
import * as appsync from "aws-cdk-lib/aws-appsync";
import * as sns from "aws-cdk-lib/aws-sns";
import { Bucket } from "aws-cdk-lib/aws-s3";
import * as path from "path";
import {
  scaffoldBackendAssetDirs,
  scaffoldArbiterStubs,
} from "./helpers/scaffold-stub-assets";
import type { AlarmDeliveryConfig } from "../lib/alarm-delivery";

scaffoldBackendAssetDirs(["dist/lambda", "src/schema"]);
scaffoldArbiterStubs();

import { ArbiterStack } from "../lib/arbiter-stack";
import { BackendStack } from "../lib/backend-stack";

// This suite performs 4 full CDK synths (ArbiterStack x3, BackendStack x1).
// Standalone it runs in ~1-2s per test, but under CI/full-suite CPU
// contention (16+ other CDK-synth suites scheduled concurrently by Jest's
// slowest-first heuristic under maxWorkers: "50%") a single synth has been
// measured taking 22.7s vs 849ms standalone — within 1.3x of the global
// 30s testTimeout in jest.config.js. Raise this suite's own timeout well
// above that measured worst case rather than the global default, since the
// slowdown is contention-driven, not a hang (finding 0fe3b82f).
jest.setTimeout(120000);

function buildArbiter(alarmDelivery: AlarmDeliveryConfig): Template {
  const app = new cdk.App({ context: { "aws:cdk:bundling-stacks": [] } });
  const backend = new cdk.Stack(app, "MockBackend", {
    env: { account: "123456789012", region: "us-east-1" },
  });
  const agentEventBus = new events.EventBus(backend, "Bus", {
    eventBusName: "citadel-agents-test",
  });
  const agentConfigTable = new dynamodb.Table(backend, "AgentConfig", {
    partitionKey: { name: "agentId", type: dynamodb.AttributeType.STRING },
    billingMode: dynamodb.BillingMode.PAY_PER_REQUEST,
  });
  const codeBucket = new Bucket(backend, "CodeBucket");
  const workflowsTable = new dynamodb.Table(backend, "Workflows", {
    partitionKey: { name: "workflowId", type: dynamodb.AttributeType.STRING },
    billingMode: dynamodb.BillingMode.PAY_PER_REQUEST,
  });
  const executionsTable = new dynamodb.Table(backend, "Executions", {
    partitionKey: { name: "executionId", type: dynamodb.AttributeType.STRING },
    billingMode: dynamodb.BillingMode.PAY_PER_REQUEST,
  });
  const executionSpecificationsTable = new dynamodb.Table(backend, "Specs", {
    partitionKey: { name: "specId", type: dynamodb.AttributeType.STRING },
    billingMode: dynamodb.BillingMode.PAY_PER_REQUEST,
  });
  const fanoutFunction = new lambda.Function(backend, "Fanout", {
    runtime: lambda.Runtime.NODEJS_24_X,
    handler: "workflow-progress-fanout.handler",
    code: lambda.Code.fromAsset("dist/lambda"),
  });
  const appSyncApi = new appsync.GraphqlApi(backend, "Api", {
    name: "mock-api",
    definition: appsync.Definition.fromFile(
      path.resolve(__dirname, "../src/schema/schema.graphql"),
    ),
  });
  const alarmTopic = new sns.Topic(backend, "AlarmTopic", {
    topicName: "citadel-alarms-test",
  });

  const arbiter = new ArbiterStack(app, "citadel-arbiter-test", {
    environment: "test",
    env: { account: "123456789012", region: "us-east-1" },
    agentEventBus,
    agentConfigTable,
    codeBucket,
    workflowsTable,
    executionsTable,
    fanoutFunction,
    appSyncEndpoint: appSyncApi.graphqlUrl,
    executionSpecificationsTable,
    alarmTopic,
    alarmDelivery,
  });
  return Template.fromStack(arbiter);
}

describe("ArbiterStack escalation topic — alarmDelivery prop wiring", () => {
  function expectCloudWatchAlarmPublishGrant(template: Template): void {
    template.hasResourceProperties("AWS::KMS::Key", {
      KeyPolicy: {
        Statement: Match.arrayWith([
          Match.objectLike({
            Effect: "Allow",
            Principal: { Service: "cloudwatch.amazonaws.com" },
            Action: Match.arrayWith(["kms:GenerateDataKey*", "kms:Decrypt"]),
          }),
        ]),
      },
    });
  }

  function expectSnsDeliveryDecryptGrant(template: Template): void {
    template.hasResourceProperties("AWS::KMS::Key", {
      KeyPolicy: {
        Statement: Match.arrayWith([
          Match.objectLike({
            Effect: "Allow",
            Principal: { Service: "sns.amazonaws.com" },
            Action: Match.arrayWith(["kms:Decrypt", "kms:GenerateDataKey*"]),
          }),
        ]),
      },
    });
  }

  test("email: email subscription on the escalation topic + BOTH cloudwatch.amazonaws.com and sns.amazonaws.com CMK grants", () => {
    const template = buildArbiter({
      mode: "email",
      email: "oncall@citadel.io",
    });
    template.hasResourceProperties("AWS::SNS::Subscription", {
      Protocol: "email",
      Endpoint: "oncall@citadel.io",
    });
    expectCloudWatchAlarmPublishGrant(template);
    expectSnsDeliveryDecryptGrant(template);
  });

  test("slack: a Chatbot Slack config, NO email subscription, and BOTH CMK grants still present", () => {
    const template = buildArbiter({
      mode: "slack",
      workspaceId: "T012ABC",
      channelId: "C099XYZ",
    });
    template.hasResourceProperties("AWS::Chatbot::SlackChannelConfiguration", {
      SlackWorkspaceId: "T012ABC",
      SlackChannelId: "C099XYZ",
    });
    const emailSubs = Object.values(
      template.findResources("AWS::SNS::Subscription"),
    ).filter((s) => s.Properties?.Protocol === "email");
    expect(emailSubs).toHaveLength(0);
    expectCloudWatchAlarmPublishGrant(template);
    expectSnsDeliveryDecryptGrant(template);
  });

  test("none: escalation topic keeps no external subscriber, alarms still actioned, and BOTH CMK grants are still present", () => {
    const template = buildArbiter({ mode: "none" });
    const emailSubs = Object.values(
      template.findResources("AWS::SNS::Subscription"),
    ).filter((s) => s.Properties?.Protocol === "email");
    expect(emailSubs).toHaveLength(0);
    template.resourceCountIs("AWS::Chatbot::SlackChannelConfiguration", 0);
    // Every alarm still has an action (the operational alarms fall to the
    // provided alarmTopic; OffFrontier to the escalation topic).
    const alarms = template.findResources("AWS::CloudWatch::Alarm");
    for (const a of Object.values(alarms)) {
      expect((a.Properties?.AlarmActions ?? []).length).toBeGreaterThan(0);
    }
    // The whole point of this finding: CloudWatch's own publish grant must
    // be present even when NO external destination is configured, because
    // it is what lets the alarm action deliver to the topic at all.
    expectCloudWatchAlarmPublishGrant(template);
    expectSnsDeliveryDecryptGrant(template);
  });
});

describe("BackendStack alarm topic — alarmDelivery prop wiring", () => {
  test("email: email subscription on the plaintext alarm topic (no CMK grant needed)", () => {
    const app = new cdk.App();
    const backend = new BackendStack(app, "citadel-backend-test", {
      environment: "test",
      env: { account: "123456789012", region: "us-east-1" },
      alarmDelivery: { mode: "email", email: "oncall@citadel.io" },
    });
    const template = Template.fromStack(backend);
    template.hasResourceProperties("AWS::SNS::Subscription", {
      Protocol: "email",
      Endpoint: "oncall@citadel.io",
    });
    // The alarm topic is not CMK-encrypted, so it carries no KmsMasterKeyId.
    const topics = template.findResources("AWS::SNS::Topic");
    const alarmTopic = Object.values(topics).find(
      (t) => t.Properties?.TopicName === "citadel-alarms-test",
    );
    expect(alarmTopic).toBeDefined();
    expect(alarmTopic!.Properties?.KmsMasterKeyId).toBeUndefined();
  });
});
