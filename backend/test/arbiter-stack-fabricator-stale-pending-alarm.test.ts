/**
 * Board 2b52a985 (slice-B checker advisory): FabricatorStalePendingClaim
 * alarm — the CDK half of the missing signal.
 *
 * The fabricator's two-phase idempotency claim acks a redelivered poison
 * message on ALREADY_PENDING (see arbiter/fabricator/index.py's
 * `_route_to_reconcile`) instead of letting it three-strike into
 * `citadel-fabricator-dlq-${ENV}`. That function now emits one
 * `CitadelArbiter/FabricatorStalePendingClaim` (Count, Dimensions:
 * [{Name: Consumer, Value: fabricator}]) CloudWatch metric per
 * ALREADY_PENDING ack. This alarm pages on Sum > 0 over 5 minutes — any
 * poison-ack in the window is notable, same threshold shape as the existing
 * OffFrontierEscalationAlarm (Sum > 0 over its own period) — and routes
 * through the SAME `operationalAlarms` action-wiring loop as
 * FabricatorErrorAlarm/SupervisorErrorAlarm/etc., so it inherits the
 * existing alarm-delivery path (props.alarmTopic -> citadel-alarms-<env>,
 * or the in-stack escalation topic fallback in an isolated ArbiterStack)
 * with zero new IAM or SNS wiring.
 */
import * as cdk from "aws-cdk-lib";
import { Template, Match } from "aws-cdk-lib/assertions";
import * as dynamodb from "aws-cdk-lib/aws-dynamodb";
import * as events from "aws-cdk-lib/aws-events";
import { Bucket } from "aws-cdk-lib/aws-s3";
import {
  scaffoldBackendAssetDirs,
  scaffoldArbiterStubs,
} from "./helpers/scaffold-stub-assets";

scaffoldBackendAssetDirs(["dist/lambda", "src/schema"]);
scaffoldArbiterStubs();

import { ArbiterStack } from "../lib/arbiter-stack";

function buildStack(): cdk.Stack {
  const app = new cdk.App({ context: { "aws:cdk:bundling-stacks": [] } });
  const backendStack = new cdk.Stack(app, "MockBackendStack2", {
    env: { account: "123456789012", region: "us-east-1" },
  });
  const agentEventBus = new events.EventBus(backendStack, "AgentEventBus", {
    eventBusName: "citadel-agents-test2",
  });
  const agentConfigTable = new dynamodb.Table(
    backendStack,
    "AgentConfigTable",
    {
      tableName: "citadel-agents-test2",
      partitionKey: { name: "agentId", type: dynamodb.AttributeType.STRING },
      billingMode: dynamodb.BillingMode.PAY_PER_REQUEST,
      removalPolicy: cdk.RemovalPolicy.DESTROY,
    },
  );
  const codeBucket = new Bucket(backendStack, "CodeBucket", {
    bucketName: "citadel-code-test2",
  });
  const executionSpecificationsTable = new dynamodb.Table(
    backendStack,
    "ExecutionSpecificationsTable",
    {
      tableName: "citadel-execution-specifications-test2",
      partitionKey: { name: "specId", type: dynamodb.AttributeType.STRING },
      billingMode: dynamodb.BillingMode.PAY_PER_REQUEST,
      removalPolicy: cdk.RemovalPolicy.DESTROY,
    },
  );
  return new ArbiterStack(app, "TestArbiterStack2", {
    environment: "test",
    env: { account: "123456789012", region: "us-east-1" },
    agentEventBus,
    agentConfigTable,
    codeBucket,
    executionSpecificationsTable,
  });
}

describe("ArbiterStack — FabricatorStalePendingClaim alarm", () => {
  let template: Template;
  beforeAll(() => {
    template = Template.fromStack(buildStack());
  });

  test("alarm exists on the pinned CitadelArbiter/FabricatorStalePendingClaim metric, Sum > 0 over 5m", () => {
    template.hasResourceProperties("AWS::CloudWatch::Alarm", {
      AlarmName: "citadel-fabricator-stale-pending-claim-test",
      MetricName: "FabricatorStalePendingClaim",
      Namespace: "CitadelArbiter",
      Statistic: "Sum",
      Period: 300,
      Threshold: 0,
      ComparisonOperator: "GreaterThanThreshold",
      Dimensions: Match.arrayWith([
        Match.objectLike({ Name: "Consumer", Value: "fabricator" }),
      ]),
    });
  });

  test("alarm has at least one AlarmAction (existing alarm-delivery path — no bare console-only alarm)", () => {
    const resources = template.toJSON().Resources as Record<
      string,
      { Type: string; Properties?: Record<string, unknown> }
    >;
    const entry = Object.values(resources).find(
      (r) =>
        r.Type === "AWS::CloudWatch::Alarm" &&
        r.Properties?.AlarmName ===
          "citadel-fabricator-stale-pending-claim-test",
    );
    expect(entry).toBeDefined();
    const actions = (entry!.Properties?.AlarmActions ?? []) as unknown[];
    expect(Array.isArray(actions)).toBe(true);
    expect(actions.length).toBeGreaterThan(0);
  });

  test("ArbiterStack (isolated, no alarmTopic prop) now synthesizes 6 alarms (5 pre-existing in this minimal harness + this one)", () => {
    template.resourceCountIs("AWS::CloudWatch::Alarm", 6);
  });
});
