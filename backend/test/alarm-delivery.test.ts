/**
 * Alarm-delivery: config resolution + subscription/KMS wiring.
 *
 * Covers the four contract points from the alarm-delivery build:
 *   1. resolveAlarmDeliveryConfig — env/context resolution, the env-scoped
 *      unconfigured-case policy (throw for staging/prod, none for dev/CI),
 *      and typo-is-always-fatal.
 *   2. email mode — an SNS email subscription on the topic(s) AND the CMK
 *      policy grants sns.amazonaws.com decrypt (the silent-failure guard).
 *   3. slack mode — an AWS Chatbot Slack channel configuration referencing
 *      the configured workspace/channel, and NO email subscription.
 *   4. none mode — nothing subscribed (topics/alarms untouched).
 */
import * as cdk from "aws-cdk-lib";
import { Template, Match } from "aws-cdk-lib/assertions";
import * as sns from "aws-cdk-lib/aws-sns";
import * as kms from "aws-cdk-lib/aws-kms";
import {
  resolveAlarmDeliveryConfig,
  attachAlarmDelivery,
  grantCloudWatchAlarmPublish,
  isPlaceholderValue,
  isProdLikeEnvironment,
  type AlarmDeliveryConfig,
} from "../lib/alarm-delivery";

describe("resolveAlarmDeliveryConfig", () => {
  test("unset destination in dev resolves to 'none' (keeps dev + CI green)", () => {
    expect(resolveAlarmDeliveryConfig({ environment: "dev", env: {} })).toEqual(
      { mode: "none" },
    );
  });

  test("unset destination in test resolves to 'none'", () => {
    expect(
      resolveAlarmDeliveryConfig({ environment: "test", env: {} }),
    ).toEqual({ mode: "none" });
  });

  test.each(["staging", "prod"])(
    "unset destination in %s THROWS (a muted alarm must not ship silently)",
    (environment) => {
      expect(() =>
        resolveAlarmDeliveryConfig({ environment, env: {} }),
      ).toThrow(/Alarm delivery is not configured/);
    },
  );

  test("explicit 'none' is always honoured, even in prod (the opt-out)", () => {
    expect(
      resolveAlarmDeliveryConfig({
        environment: "prod",
        env: { ALARM_DELIVERY: "none" },
      }),
    ).toEqual({ mode: "none" });
  });

  test("email mode with a real address resolves to email", () => {
    expect(
      resolveAlarmDeliveryConfig({
        environment: "prod",
        env: { ALARM_DELIVERY: "email", ALARM_EMAIL: "oncall@citadel.io" },
      }),
    ).toEqual({ mode: "email", email: "oncall@citadel.io" });
  });

  test("email mode with a placeholder address THROWS in prod", () => {
    expect(() =>
      resolveAlarmDeliveryConfig({
        environment: "prod",
        env: { ALARM_DELIVERY: "email", ALARM_EMAIL: "you@example.com" },
      }),
    ).toThrow(/not configured/);
  });

  test("email mode with a missing address falls back to none in dev", () => {
    expect(
      resolveAlarmDeliveryConfig({
        environment: "dev",
        env: { ALARM_DELIVERY: "email" },
      }),
    ).toEqual({ mode: "none" });
  });

  test("slack mode with workspace + channel resolves to slack", () => {
    expect(
      resolveAlarmDeliveryConfig({
        environment: "prod",
        env: {
          ALARM_DELIVERY: "slack",
          ALARM_SLACK_WORKSPACE_ID: "T012ABC",
          ALARM_SLACK_CHANNEL_ID: "C099XYZ",
        },
      }),
    ).toEqual({ mode: "slack", workspaceId: "T012ABC", channelId: "C099XYZ" });
  });

  test("slack mode missing a channel id THROWS in prod", () => {
    expect(() =>
      resolveAlarmDeliveryConfig({
        environment: "prod",
        env: { ALARM_DELIVERY: "slack", ALARM_SLACK_WORKSPACE_ID: "T012ABC" },
      }),
    ).toThrow(/not configured/);
  });

  test("an invalid mode is ALWAYS fatal, even in dev (typo never degrades)", () => {
    expect(() =>
      resolveAlarmDeliveryConfig({
        environment: "dev",
        env: { ALARM_DELIVERY: "slakc" },
      }),
    ).toThrow(/Invalid ALARM_DELIVERY/);
  });

  test("config resolves from CDK context when env is empty", () => {
    const context = (k: string) =>
      ({ alarmDelivery: "email", alarmEmail: "ops@citadel.io" })[k];
    expect(
      resolveAlarmDeliveryConfig({ environment: "prod", env: {}, context }),
    ).toEqual({ mode: "email", email: "ops@citadel.io" });
  });

  test("isProdLikeEnvironment only flags staging/prod", () => {
    expect(isProdLikeEnvironment("staging")).toBe(true);
    expect(isProdLikeEnvironment("prod")).toBe(true);
    expect(isProdLikeEnvironment("dev")).toBe(false);
    expect(isProdLikeEnvironment("test")).toBe(false);
  });

  test("isPlaceholderValue catches common scaffold shapes", () => {
    expect(isPlaceholderValue(undefined)).toBe(true);
    expect(isPlaceholderValue("")).toBe(true);
    expect(isPlaceholderValue("you@example.com")).toBe(true);
    expect(isPlaceholderValue("your-channel-id")).toBe(true);
    expect(isPlaceholderValue("oncall@citadel.io")).toBe(false);
  });

  // Boundary-anchored domain matching (CodeQL js/incomplete-url-substring-
  // sanitization, alert #49): equality or subdomain of a reserved RFC 2606
  // documentation domain is a placeholder; a domain that merely CONTAINS the
  // reserved token as a substring is a legitimate, non-placeholder domain.
  test.each([
    ["admin@example.com", true],
    ["admin@mail.example.com", true],
    ["admin@example.net", true],
    ["admin@example.org", true],
    ["admin@deep.sub.example.com", true],
    ["someone@notexample.community", false],
    ["someone@example.com.attacker.io", false],
    ["oncall@citadel.io", false],
  ])(
    "isPlaceholderValue(%s) classifies as placeholder=%s",
    (email, expected) => {
      expect(isPlaceholderValue(email)).toBe(expected);
    },
  );
});

// A representative two-topic setup: one CMK-encrypted (the escalation-topic
// shape) and one plaintext (the alarms-topic shape), wired via the shared
// attachAlarmDelivery helper for each mode.
function synthWithDelivery(config: AlarmDeliveryConfig): Template {
  const app = new cdk.App();
  const stack = new cdk.Stack(app, "DeliveryTestStack", {
    env: { account: "123456789012", region: "us-east-1" },
  });
  const key = new kms.Key(stack, "EscalationKey", { enableKeyRotation: true });
  const encryptedTopic = new sns.Topic(stack, "EscalationTopic", {
    topicName: "citadel-governance-escalations-test",
    masterKey: key,
  });
  const plainTopic = new sns.Topic(stack, "AlarmTopic", {
    topicName: "citadel-alarms-test",
  });
  attachAlarmDelivery(stack, {
    config,
    environment: "test",
    topics: [
      { topic: encryptedTopic, nameHint: "escalation", encryptionKey: key },
      { topic: plainTopic, nameHint: "backend" },
    ],
  });
  return Template.fromStack(stack);
}

describe("attachAlarmDelivery — email mode", () => {
  let template: Template;
  beforeAll(() => {
    template = synthWithDelivery({ mode: "email", email: "oncall@citadel.io" });
  });

  test("creates an SNS email subscription on each topic", () => {
    const subs = template.findResources("AWS::SNS::Subscription");
    const emailSubs = Object.values(subs).filter(
      (s) => s.Properties?.Protocol === "email",
    );
    expect(emailSubs).toHaveLength(2);
    for (const s of emailSubs) {
      expect(s.Properties?.Endpoint).toBe("oncall@citadel.io");
    }
  });

  test("grants sns.amazonaws.com decrypt + GenerateDataKey on the CMK (silent-failure guard)", () => {
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
  });

  test("creates no Chatbot Slack configuration", () => {
    template.resourceCountIs("AWS::Chatbot::SlackChannelConfiguration", 0);
  });
});

describe("attachAlarmDelivery — slack mode", () => {
  let template: Template;
  beforeAll(() => {
    template = synthWithDelivery({
      mode: "slack",
      workspaceId: "T012ABC",
      channelId: "C099XYZ",
    });
  });

  test("creates a Chatbot Slack config per topic referencing the workspace/channel", () => {
    const configs = template.findResources(
      "AWS::Chatbot::SlackChannelConfiguration",
    );
    expect(Object.keys(configs)).toHaveLength(2);
    for (const c of Object.values(configs)) {
      expect(c.Properties?.SlackWorkspaceId).toBe("T012ABC");
      expect(c.Properties?.SlackChannelId).toBe("C099XYZ");
      // Each references exactly one notification topic.
      expect(c.Properties?.SnsTopicArns).toHaveLength(1);
    }
  });

  test("creates NO email subscription", () => {
    const subs = template.findResources("AWS::SNS::Subscription");
    const emailSubs = Object.values(subs).filter(
      (s) => s.Properties?.Protocol === "email",
    );
    expect(emailSubs).toHaveLength(0);
  });

  test("STILL grants sns.amazonaws.com decrypt + GenerateDataKey on the CMK (unconditional, not email-only)", () => {
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
  });
});

describe("attachAlarmDelivery — none mode", () => {
  let template: Template;
  beforeAll(() => {
    template = synthWithDelivery({ mode: "none" });
  });

  test("creates no subscription and no Chatbot config (topics stay bare)", () => {
    template.resourceCountIs("AWS::SNS::Subscription", 0);
    template.resourceCountIs("AWS::Chatbot::SlackChannelConfiguration", 0);
  });

  test("the topics themselves still synth", () => {
    template.resourceCountIs("AWS::SNS::Topic", 2);
  });

  test("STILL grants sns.amazonaws.com decrypt + GenerateDataKey on the CMK even with no external destination", () => {
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
  });
});

describe("grantCloudWatchAlarmPublish", () => {
  test("grants cloudwatch.amazonaws.com decrypt + GenerateDataKey on the key", () => {
    const app = new cdk.App();
    const stack = new cdk.Stack(app, "CwGrantTestStack");
    const key = new kms.Key(stack, "Key", { enableKeyRotation: true });
    grantCloudWatchAlarmPublish(key);
    const template = Template.fromStack(stack);
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
  });
});
