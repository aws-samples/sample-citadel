/**
 * Structural guard (finding 2ca8d956): every CloudWatch alarm that targets a
 * CMK-encrypted SNS topic must have a key policy granting
 * `cloudwatch.amazonaws.com` both `kms:GenerateDataKey*` and `kms:Decrypt` on
 * that CMK — or the alarm action fails to publish SILENTLY (the alarm still
 * transitions state in the console; no message ever reaches the topic, so
 * no subscriber ever sees it).
 *
 * This guard is derived FROM THE SYNTHESIZED TEMPLATE — not a maintained
 * list of "known encrypted topics" — so it keeps holding if a future alarm
 * is wired to a new CMK-encrypted topic without anyone remembering to add
 * the grant. It walks:
 *
 *   AWS::CloudWatch::Alarm.AlarmActions
 *     -> (Ref) AWS::SNS::Topic in the SAME template
 *       -> .KmsMasterKeyId (Fn::GetAtt [KeyLogicalId, "Arn"])
 *         -> AWS::KMS::Key.KeyPolicy.Statement
 *           -> must contain an Allow statement for principal
 *              cloudwatch.amazonaws.com with both required actions.
 *
 * An AlarmAction expressed as `Fn::ImportValue` (a cross-stack topic, e.g.
 * the plaintext BackendStack `AlarmTopic` referenced from ArbiterStack) is
 * NOT resolvable inside a single synthesized template and is treated as
 * "not analyzable here" rather than a false failure — that topic is
 * plaintext in this codebase (see every-alarm-has-action.test.ts /
 * alarm-delivery-stacks.test.ts), and a genuinely cross-stack encrypted
 * topic would need the equivalent check run against the STACK THAT OWNS
 * the key, where the Ref/GetAtt chain is local.
 *
 * A companion bite proof (bottom) proves the assertion actually fires when
 * the grant is missing — a green suite against an unbitten guard proves
 * nothing.
 */
import * as cdk from "aws-cdk-lib";
import { Template } from "aws-cdk-lib/assertions";
import * as cloudwatch from "aws-cdk-lib/aws-cloudwatch";
import * as cw_actions from "aws-cdk-lib/aws-cloudwatch-actions";
import * as sns from "aws-cdk-lib/aws-sns";
import * as kms from "aws-cdk-lib/aws-kms";
import * as iam from "aws-cdk-lib/aws-iam";
import {
  scaffoldBackendAssetDirs,
  scaffoldArbiterStubs,
} from "./helpers/scaffold-stub-assets";
import { grantCloudWatchAlarmPublish } from "../lib/alarm-delivery";

scaffoldBackendAssetDirs(["dist/lambda", "src/schema"]);
scaffoldArbiterStubs();

import { ArbiterStack } from "../lib/arbiter-stack";
import { BackendStack } from "../lib/backend-stack";

type CfnResource = { Type: string; Properties?: Record<string, unknown> };
type Resources = Record<string, CfnResource>;

const REQUIRED_ACTIONS = ["kms:GenerateDataKey*", "kms:Decrypt"];

/**
 * True iff `statement` is an Allow statement naming `principalService` as
 * (one of) its Principal.Service, and its Action array/string contains
 * every action in `requiredActions`.
 */
function statementGrantsServiceActions(
  statement: Record<string, unknown>,
  principalService: string,
  requiredActions: string[],
): boolean {
  if (statement.Effect !== "Allow") return false;
  const principal = statement.Principal as
    { Service?: string | string[] } | undefined;
  const svc = principal?.Service;
  const services = Array.isArray(svc) ? svc : svc ? [svc] : [];
  if (!services.includes(principalService)) return false;
  const action = statement.Action;
  const actions = Array.isArray(action) ? action : action ? [action] : [];
  return requiredActions.every((a) => actions.includes(a));
}

/** Resolve a `{ Ref: logicalId }` token to the referenced resource, or undefined. */
function resolveRef(
  resources: Resources,
  token: unknown,
): { logicalId: string; resource: CfnResource } | undefined {
  if (
    typeof token === "object" &&
    token !== null &&
    "Ref" in (token as Record<string, unknown>)
  ) {
    const logicalId = (token as { Ref: string }).Ref;
    const resource = resources[logicalId];
    if (resource) return { logicalId, resource };
  }
  return undefined;
}

/** Resolve a `{ "Fn::GetAtt": [logicalId, attr] }` token's target resource. */
function resolveGetAtt(
  resources: Resources,
  token: unknown,
): { logicalId: string; resource: CfnResource } | undefined {
  if (
    typeof token === "object" &&
    token !== null &&
    "Fn::GetAtt" in (token as Record<string, unknown>)
  ) {
    const pair = (token as { "Fn::GetAtt": [string, string] })["Fn::GetAtt"];
    const logicalId = Array.isArray(pair) ? pair[0] : undefined;
    const resource = logicalId ? resources[logicalId] : undefined;
    if (resource) return { logicalId: logicalId!, resource };
  }
  return undefined;
}

export interface UngrantedAlarmTopicKey {
  alarmLogicalId: string;
  topicLogicalId: string;
  keyLogicalId: string;
}

/**
 * For every AWS::CloudWatch::Alarm in `resources`, resolve each AlarmAction
 * that is a same-template `Ref` to an AWS::SNS::Topic. If that topic has a
 * `KmsMasterKeyId` resolvable (via Fn::GetAtt) to a same-template
 * AWS::KMS::Key, verify the key's KeyPolicy grants `cloudwatch.amazonaws.com`
 * both kms:GenerateDataKey* and kms:Decrypt. Returns the list of violations
 * (empty = guard satisfied).
 */
export function findAlarmTopicKeysMissingCloudWatchPublishGrant(
  resources: Resources,
): UngrantedAlarmTopicKey[] {
  const violations: UngrantedAlarmTopicKey[] = [];

  for (const [alarmLogicalId, alarm] of Object.entries(resources)) {
    if (alarm.Type !== "AWS::CloudWatch::Alarm") continue;
    const actions = (alarm.Properties?.AlarmActions ?? []) as unknown[];
    if (!Array.isArray(actions)) continue;

    for (const action of actions) {
      const topicRef = resolveRef(resources, action);
      if (!topicRef || topicRef.resource.Type !== "AWS::SNS::Topic") {
        // Not a same-template topic Ref (e.g. Fn::ImportValue for a
        // cross-stack topic) — not analyzable from this template; skip.
        continue;
      }

      const kmsMasterKeyId = topicRef.resource.Properties?.KmsMasterKeyId;
      if (kmsMasterKeyId === undefined) {
        // Plaintext topic — no key policy to check.
        continue;
      }

      const keyRef = resolveGetAtt(resources, kmsMasterKeyId);
      if (!keyRef || keyRef.resource.Type !== "AWS::KMS::Key") {
        // Encrypted with a key we can't resolve in this template (e.g. an
        // imported/cross-stack key ARN) — not analyzable from here.
        continue;
      }

      const statements = (
        keyRef.resource.Properties?.KeyPolicy as
          { Statement?: Record<string, unknown>[] } | undefined
      )?.Statement;
      const grants = Array.isArray(statements)
        ? statements.some((s) =>
            statementGrantsServiceActions(
              s,
              "cloudwatch.amazonaws.com",
              REQUIRED_ACTIONS,
            ),
          )
        : false;

      if (!grants) {
        violations.push({
          alarmLogicalId,
          topicLogicalId: topicRef.logicalId,
          keyLogicalId: keyRef.logicalId,
        });
      }
    }
  }

  return violations;
}

describe("structural guard: alarm -> encrypted-topic -> key-policy must grant cloudwatch.amazonaws.com publish", () => {
  test("ArbiterStack: the CMK-encrypted escalation topic's key grants cloudwatch.amazonaws.com (non-vacuous: at least one encrypted topic is actually checked)", () => {
    const app = new cdk.App({ context: { "aws:cdk:bundling-stacks": [] } });
    const env = { account: "123456789012", region: "us-east-1" };
    const backend = new BackendStack(app, "citadel-backend-test", {
      environment: "test",
      env,
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
    const resources = Template.fromStack(arbiter).toJSON().Resources;

    // Non-vacuousness check: this template must actually contain at least
    // one alarm whose action Refs an encrypted topic, or the guard below
    // would trivially pass by never examining anything.
    const encryptedTopicLogicalIds = Object.entries(resources)
      .filter(
        ([, r]) =>
          r.Type === "AWS::SNS::Topic" &&
          r.Properties?.KmsMasterKeyId !== undefined,
      )
      .map(([id]) => id);
    expect(encryptedTopicLogicalIds.length).toBeGreaterThan(0);

    const violations =
      findAlarmTopicKeysMissingCloudWatchPublishGrant(resources);
    expect(violations).toEqual([]);
  });
});

describe("bite proof: the guard fires when the cloudwatch.amazonaws.com key-policy grant is absent", () => {
  function synthAlarmToEncryptedTopic(withCloudWatchGrant: boolean): Template {
    const app = new cdk.App();
    const stack = new cdk.Stack(app, "BiteStack", {
      env: { account: "123456789012", region: "us-east-1" },
    });
    const key = new kms.Key(stack, "BiteKey", { enableKeyRotation: true });
    const topic = new sns.Topic(stack, "BiteTopic", {
      topicName: "citadel-bite-encrypted-test",
      masterKey: key,
    });
    if (withCloudWatchGrant) {
      grantCloudWatchAlarmPublish(key);
    }
    new cloudwatch.Alarm(stack, "BiteAlarm", {
      alarmName: "citadel-bite-encrypted-alarm-test",
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
    }).addAlarmAction(new cw_actions.SnsAction(topic));
    return Template.fromStack(stack);
  }

  test("RED: missing the cloudwatch.amazonaws.com grant IS flagged", () => {
    const violations = findAlarmTopicKeysMissingCloudWatchPublishGrant(
      synthAlarmToEncryptedTopic(false).toJSON().Resources,
    );
    expect(violations.length).toBe(1);
    expect(violations[0].alarmLogicalId).toMatch(/BiteAlarm/);
    // And the assertion the structural test uses would fail on it.
    expect(() => expect(violations).toEqual([])).toThrow();
  });

  test("GREEN: the same alarm/topic/key WITH the grant is not flagged", () => {
    expect(
      findAlarmTopicKeysMissingCloudWatchPublishGrant(
        synthAlarmToEncryptedTopic(true).toJSON().Resources,
      ),
    ).toEqual([]);
  });

  test("a plaintext topic (no KmsMasterKeyId) is never flagged — nothing to grant", () => {
    const app = new cdk.App();
    const stack = new cdk.Stack(app, "BitePlainStack", {
      env: { account: "123456789012", region: "us-east-1" },
    });
    const topic = new sns.Topic(stack, "BitePlainTopic", {
      topicName: "citadel-bite-plaintext-test",
    });
    new cloudwatch.Alarm(stack, "BitePlainAlarm", {
      alarmName: "citadel-bite-plaintext-alarm-test",
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
    }).addAlarmAction(new cw_actions.SnsAction(topic));
    const resources = Template.fromStack(stack).toJSON().Resources;
    expect(findAlarmTopicKeysMissingCloudWatchPublishGrant(resources)).toEqual(
      [],
    );
  });

  test("a key policy granting a DIFFERENT service (not cloudwatch.amazonaws.com) is still flagged", () => {
    const app = new cdk.App();
    const stack = new cdk.Stack(app, "BiteWrongServiceStack", {
      env: { account: "123456789012", region: "us-east-1" },
    });
    const key = new kms.Key(stack, "WrongServiceKey", {
      enableKeyRotation: true,
    });
    key.addToResourcePolicy(
      new iam.PolicyStatement({
        sid: "OnlySns",
        effect: iam.Effect.ALLOW,
        principals: [new iam.ServicePrincipal("sns.amazonaws.com")],
        actions: ["kms:Decrypt", "kms:GenerateDataKey*"],
        resources: ["*"],
      }),
    );
    const topic = new sns.Topic(stack, "WrongServiceTopic", {
      topicName: "citadel-bite-wrong-service-test",
      masterKey: key,
    });
    new cloudwatch.Alarm(stack, "WrongServiceAlarm", {
      alarmName: "citadel-bite-wrong-service-alarm-test",
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
    }).addAlarmAction(new cw_actions.SnsAction(topic));
    const resources = Template.fromStack(stack).toJSON().Resources;
    expect(
      findAlarmTopicKeysMissingCloudWatchPublishGrant(resources).length,
    ).toBe(1);
  });
});
