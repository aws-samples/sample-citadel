import { Construct } from "constructs";
import * as sns from "aws-cdk-lib/aws-sns";
import * as subscriptions from "aws-cdk-lib/aws-sns-subscriptions";
import * as kms from "aws-cdk-lib/aws-kms";
import * as iam from "aws-cdk-lib/aws-iam";
import * as chatbot from "aws-cdk-lib/aws-chatbot";
import { NagSuppressions } from "cdk-nag";

/**
 * Configurable alarm-delivery destination for Citadel's SNS alarm topics.
 *
 * Both platform alarm topics (`citadel-alarms-<env>` in BackendStack and the
 * CMK-encrypted `citadel-governance-escalations-<env>` in ArbiterStack) had
 * ZERO subscriptions repo-wide, so no CloudWatch alarm ever reached a human
 * asynchronously. This module resolves an operator-selected destination from
 * env/CDK-context and subscribes the given topic(s) to it:
 *
 *   - `email`  — an SNS EMAIL subscription on each topic. Delivery from a
 *                CMK-encrypted topic ALSO requires the `sns.amazonaws.com`
 *                service principal to hold `kms:Decrypt` + `kms:GenerateDataKey*`
 *                on the topic's CMK, or SNS drops the notification SILENTLY.
 *                This module adds that grant for every encrypted topic.
 *   - `slack`  — an AWS Chatbot Slack channel configuration (the STABLE
 *                `aws-cdk-lib/aws-chatbot` `SlackChannelConfiguration` L2 —
 *                promoted out of alpha; no `@aws-cdk/aws-chatbot-alpha`
 *                package is required or installed) subscribed to the topic(s).
 *                One-time console prerequisite: the Slack workspace must be
 *                authorised for AWS Chatbot via the AWS console OAuth flow
 *                first (this cannot be done by CDK); the resulting workspace
 *                id is what `ALARM_SLACK_WORKSPACE_ID` carries.
 *   - `none`   — no subscription (alarms stay wired to their topic, but no
 *                external destination). The explicit opt-out.
 *
 * ## Unconfigured-case policy (decision)
 *
 * An unset/placeholder destination is NOT a hard synth failure in
 * dev/test/local, because this OSS dev clone's `backend/.env` holds
 * placeholders and CI has no `.env` at all — both must still `cdk synth`
 * cleanly. It IS a hard synth failure (throw) for `staging`/`prod`, where a
 * muted alarm is an on-call hazard and a mere CDK warning would be ignored.
 * The explicit `ALARM_DELIVERY=none` opt-out is always honoured everywhere.
 *
 * This mirrors the repo's existing env-scoped `shouldWarnOnPlaceholder`
 * pattern in `frontend-origin.ts`, but ESCALATES warn->throw for prod-like
 * envs: an unrouted alarm fails silently at the worst time, unlike the
 * cosmetic CORS gap, so the gap must be impossible to miss where it matters
 * while keeping dev + CI green.
 */

export type AlarmDeliveryMode = "email" | "slack" | "none";

export type AlarmDeliveryConfig =
  | { readonly mode: "email"; readonly email: string }
  | {
      readonly mode: "slack";
      readonly workspaceId: string;
      readonly channelId: string;
    }
  | { readonly mode: "none" };

/** Environment variable names — the single source of truth for the config. */
export const ALARM_DELIVERY_ENV = {
  MODE: "ALARM_DELIVERY",
  EMAIL: "ALARM_EMAIL",
  SLACK_WORKSPACE_ID: "ALARM_SLACK_WORKSPACE_ID",
  SLACK_CHANNEL_ID: "ALARM_SLACK_CHANNEL_ID",
} as const;

/** Environments where an unconfigured/placeholder destination is fatal. */
export function isProdLikeEnvironment(environment: string): boolean {
  return environment === "staging" || environment === "prod";
}

/**
 * Heuristic placeholder detector. A value is a placeholder (treated as
 * "unset") when it is empty/whitespace or contains a well-known scaffold
 * token. Keeps `backend/.env.example`'s commented sample values and the
 * common `example.com` / `your-...` shapes from being mistaken for a real
 * destination.
 */
export function isPlaceholderValue(value: string | undefined): boolean {
  if (value === undefined) return true;
  const v = value.trim();
  if (v === "") return true;
  const lower = v.toLowerCase();
  return (
    lower.includes("your-") ||
    lower.includes("your_") ||
    lower.includes("changeme") ||
    lower.includes("example.com") ||
    lower.includes("workspace-id") ||
    lower.includes("channel-id") ||
    lower === "xxxx" ||
    lower === "todo" ||
    lower === "placeholder"
  );
}

export interface ResolveAlarmDeliveryOptions {
  readonly environment: string;
  /** Defaults to `process.env`. Injected for unit testing. */
  readonly env?: Record<string, string | undefined>;
  /** Optional CDK-context reader (e.g. `app.node.tryGetContext`). */
  readonly context?: (key: string) => unknown;
}

function read(
  opts: ResolveAlarmDeliveryOptions,
  envKey: string,
  contextKey: string,
): string | undefined {
  const env = opts.env ?? process.env;
  const fromEnv = env[envKey];
  if (fromEnv !== undefined && fromEnv.trim() !== "") return fromEnv.trim();
  const fromCtx = opts.context?.(contextKey);
  return typeof fromCtx === "string" && fromCtx.trim() !== ""
    ? fromCtx.trim()
    : undefined;
}

/** Remediation text surfaced in the thrown error for prod-like envs. */
export function alarmDeliveryRemediation(environment: string): string {
  return (
    `Alarm delivery is not configured for '${environment}'. Set ` +
    `${ALARM_DELIVERY_ENV.MODE} in backend/.env (or -c alarmDelivery=...) to ` +
    `one of: 'email' (+ ${ALARM_DELIVERY_ENV.EMAIL}), 'slack' (+ ` +
    `${ALARM_DELIVERY_ENV.SLACK_WORKSPACE_ID} and ` +
    `${ALARM_DELIVERY_ENV.SLACK_CHANNEL_ID}), or 'none' to explicitly opt ` +
    `out. Refusing to synth a ${environment} deployment whose CloudWatch ` +
    `alarms have a topic but no destination (a muted alarm fails silently).`
  );
}

/**
 * Resolve the alarm-delivery config from env/context.
 *
 * Throws for prod-like environments when the destination is unset/placeholder
 * or incomplete, or for ANY environment when the value is a recognised-but-
 * invalid mode (a typo, which should never pass silently). Returns
 * `{ mode: 'none' }` for a dev/test/local unset/placeholder destination so
 * the OSS dev clone and CI both synth cleanly.
 */
export function resolveAlarmDeliveryConfig(
  opts: ResolveAlarmDeliveryOptions,
): AlarmDeliveryConfig {
  const environment = opts.environment;
  const rawMode = read(opts, ALARM_DELIVERY_ENV.MODE, "alarmDelivery");

  const unconfigured = (): AlarmDeliveryConfig => {
    if (isProdLikeEnvironment(environment)) {
      throw new Error(alarmDeliveryRemediation(environment));
    }
    return { mode: "none" };
  };

  if (rawMode === undefined || isPlaceholderValue(rawMode)) {
    return unconfigured();
  }

  const mode = rawMode.toLowerCase();

  if (mode === "none") {
    return { mode: "none" };
  }

  if (mode === "email") {
    const email = read(opts, ALARM_DELIVERY_ENV.EMAIL, "alarmEmail");
    if (email === undefined || isPlaceholderValue(email)) {
      return unconfigured();
    }
    return { mode: "email", email };
  }

  if (mode === "slack") {
    const workspaceId = read(
      opts,
      ALARM_DELIVERY_ENV.SLACK_WORKSPACE_ID,
      "alarmSlackWorkspaceId",
    );
    const channelId = read(
      opts,
      ALARM_DELIVERY_ENV.SLACK_CHANNEL_ID,
      "alarmSlackChannelId",
    );
    if (
      workspaceId === undefined ||
      isPlaceholderValue(workspaceId) ||
      channelId === undefined ||
      isPlaceholderValue(channelId)
    ) {
      return unconfigured();
    }
    return { mode: "slack", workspaceId, channelId };
  }

  // Recognised-but-invalid value: a typo is always fatal, in every env, so it
  // never silently degrades to no-delivery.
  throw new Error(
    `Invalid ${ALARM_DELIVERY_ENV.MODE}='${rawMode}'. Expected one of: ` +
      `email, slack, none.`,
  );
}

/** A topic to wire a destination onto, plus its CMK if it is encrypted. */
export interface AlarmTopicRef {
  readonly topic: sns.ITopic;
  /**
   * A short, unique, DNS/name-safe hint used to name the per-topic Slack
   * channel configuration (e.g. `backend`, `escalation`). Chatbot
   * configuration names must be unique per account.
   */
  readonly nameHint: string;
  /**
   * The topic's customer-managed KMS key, present IFF the topic is
   * CMK-encrypted. When present, the `sns.amazonaws.com` service principal is
   * granted decrypt on it so email delivery does not fail silently.
   */
  readonly encryptionKey?: kms.IKey;
}

/**
 * Grant the SNS service principal decrypt on a topic CMK so SNS-native
 * delivery (email) can read the encrypted message. Missing this grant makes
 * delivery from a CMK-encrypted topic fail SILENTLY — hence the dedicated
 * assertion in the alarm-delivery tests.
 */
export function grantSnsDeliveryDecrypt(key: kms.IKey): void {
  key.addToResourcePolicy(
    new iam.PolicyStatement({
      sid: "AllowSnsDeliveryDecrypt",
      effect: iam.Effect.ALLOW,
      principals: [new iam.ServicePrincipal("sns.amazonaws.com")],
      actions: ["kms:Decrypt", "kms:GenerateDataKey*"],
      resources: ["*"],
    }),
    /* allowNoOp */ true,
  );
}

export interface AttachAlarmDeliveryOptions {
  readonly config: AlarmDeliveryConfig;
  readonly environment: string;
  readonly topics: AlarmTopicRef[];
}

/**
 * Subscribe the given topic(s) to the resolved destination. No-op for
 * `mode: 'none'` (alarms remain actioned to their topic; there is simply no
 * external subscriber).
 */
export function attachAlarmDelivery(
  scope: Construct,
  opts: AttachAlarmDeliveryOptions,
): void {
  const { config, environment, topics } = opts;

  if (config.mode === "none") {
    return;
  }

  if (config.mode === "email") {
    for (const t of topics) {
      t.topic.addSubscription(
        new subscriptions.EmailSubscription(config.email),
      );
      if (t.encryptionKey) {
        grantSnsDeliveryDecrypt(t.encryptionKey);
      }
    }
    return;
  }

  // config.mode === "slack"
  for (const t of topics) {
    const cfg = new chatbot.SlackChannelConfiguration(
      scope,
      `AlarmSlack${pascalCase(t.nameHint)}`,
      {
        slackChannelConfigurationName: `citadel-alarms-${t.nameHint}-${environment}`,
        slackWorkspaceId: config.workspaceId,
        slackChannelId: config.channelId,
        notificationTopics: [t.topic],
        loggingLevel: chatbot.LoggingLevel.ERROR,
      },
    );
    // Chatbot delivery from a CMK-encrypted topic needs the configuration's
    // own role to decrypt. (The sns.amazonaws.com grant covers SNS-native
    // email delivery; this covers the Chatbot path.)
    if (t.encryptionKey) {
      t.encryptionKey.grantDecrypt(cfg.grantPrincipal);
    }
    // The Chatbot L2 auto-creates a scoped role/policy (CloudWatch read +
    // notifications-only). cdk-nag flags the managed-policy/DefaultPolicy
    // wildcards the construct owns; suppress narrowly on the construct we
    // just created rather than widening any stack-level suppression.
    NagSuppressions.addResourceSuppressions(
      cfg,
      [
        {
          id: "AwsSolutions-IAM4",
          reason:
            "AWS Chatbot SlackChannelConfiguration L2 attaches the " +
            "AWS-managed read-only CloudWatch policy for notification " +
            "rendering; construct-owned, not application-controlled.",
        },
        {
          id: "AwsSolutions-IAM5",
          reason:
            "AWS Chatbot SlackChannelConfiguration L2 role uses the " +
            "AWS-documented notifications/CloudWatch read wildcards; " +
            "construct-owned, cannot be narrowed without breaking Chatbot.",
        },
      ],
      true,
    );
  }
}

function pascalCase(s: string): string {
  return s
    .split(/[^a-zA-Z0-9]+/)
    .filter(Boolean)
    .map((w) => w.charAt(0).toUpperCase() + w.slice(1))
    .join("");
}
