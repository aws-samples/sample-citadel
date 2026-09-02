/**
 * Shared-DLQ queue-shape assertion helper (CIT-125 slice A follow-up,
 * design A.6 #6).
 *
 * Every per-stack shared async DLQ (`citadel-<stack>-async-dlq-<env>`)
 * must carry the exact queue shape the design prescribes:
 *   - MessageRetentionPeriod 1209600s (14 days) — the redrive window the
 *     DLQ_REDRIVE runbook's procedures assume;
 *   - SqsManagedSseEnabled true (SQS_MANAGED encryption);
 *   - an enforceSSL QueuePolicy (Deny sqs:* to any principal when
 *     aws:SecureTransport is false) attached to the queue.
 *
 * Called from each stack's EXISTING Template.fromStack harness so the
 * assertion runs against in-process synth (no cdk.out dependency) — one
 * call site per stack, one shape definition here.
 *
 * NOTE: files under test/helpers/ are compiled by the BUILD tsc (they
 * match none of tsconfig.json's test-file excludes), where jest's ambient
 * globals are not typed (`@types/jest` is not installed; jest injects its
 * globals only at runtime via the ts-jest transform's `types` override).
 * This helper therefore uses no `expect` — violations are collected and
 * thrown as a single Error, which jest reports as the calling test's
 * failure with the full violation list in the message.
 */
import { Template } from "aws-cdk-lib/assertions";

/** 14 days, in seconds — the design's DLQ retention (A.0 queue shape). */
export const SHARED_ASYNC_DLQ_RETENTION_SECONDS = 14 * 24 * 60 * 60;

interface CfnResourceLike {
  Type?: string;
  Properties?: Record<string, unknown>;
}

/**
 * Asserts the `citadel-<slug>-async-dlq-<environment>` queue in `template`
 * has the design's retention + SSE shape and an enforceSSL QueuePolicy.
 * Throws a single Error listing every violation found (empty = passes).
 */
export function assertSharedAsyncDlqShape(
  template: Template,
  slug: string,
  environment = "test",
): void {
  const queueName = `citadel-${slug}-async-dlq-${environment}`;
  const problems: string[] = [];

  // --- Queue exists exactly once, with retention + SQS-managed SSE ---
  const queues = template.findResources("AWS::SQS::Queue", {
    Properties: { QueueName: queueName },
  }) as Record<string, CfnResourceLike>;
  const queueIds = Object.keys(queues);
  if (queueIds.length !== 1) {
    throw new Error(
      `shared async DLQ shape (${queueName}): expected exactly 1 ` +
        `AWS::SQS::Queue with that QueueName, found ${queueIds.length} ` +
        `[${queueIds.join(", ")}]`,
    );
  }
  const queueLogicalId = queueIds[0];
  const queueProps = queues[queueLogicalId].Properties ?? {};
  if (
    queueProps.MessageRetentionPeriod !== SHARED_ASYNC_DLQ_RETENTION_SECONDS
  ) {
    problems.push(
      `MessageRetentionPeriod: expected ${SHARED_ASYNC_DLQ_RETENTION_SECONDS} ` +
        `(14d), got ${JSON.stringify(queueProps.MessageRetentionPeriod)}`,
    );
  }
  if (queueProps.SqsManagedSseEnabled !== true) {
    problems.push(
      `SqsManagedSseEnabled: expected true, got ` +
        `${JSON.stringify(queueProps.SqsManagedSseEnabled)}`,
    );
  }

  // --- enforceSSL QueuePolicy: Deny sqs:* when aws:SecureTransport=false ---
  const policies = template.findResources("AWS::SQS::QueuePolicy") as Record<
    string,
    CfnResourceLike
  >;
  let attachedDenyStatements = 0;
  for (const policy of Object.values(policies)) {
    const props = policy.Properties ?? {};
    const queuesAttached = (props.Queues ?? []) as Array<unknown>;
    const attachesToQueue = queuesAttached.some(
      (q) =>
        typeof q === "object" &&
        q !== null &&
        (q as Record<string, unknown>).Ref === queueLogicalId,
    );
    if (!attachesToQueue) continue;
    const doc = (props.PolicyDocument ?? {}) as {
      Statement?: Array<Record<string, unknown>>;
    };
    for (const stmt of doc.Statement ?? []) {
      if (stmt.Effect !== "Deny") continue;
      const actions = Array.isArray(stmt.Action) ? stmt.Action : [stmt.Action];
      if (!actions.includes("sqs:*")) continue;
      const condition = (stmt.Condition ?? {}) as {
        Bool?: Record<string, unknown>;
      };
      if (condition.Bool?.["aws:SecureTransport"] !== "false") continue;
      attachedDenyStatements += 1;
    }
  }
  if (attachedDenyStatements !== 1) {
    problems.push(
      `enforceSSL QueuePolicy: expected exactly 1 Deny-sqs:*-when-insecure ` +
        `statement attached to ${queueLogicalId}, found ${attachedDenyStatements}`,
    );
  }

  if (problems.length > 0) {
    throw new Error(
      `shared async DLQ shape violation(s) for ${queueName} ` +
        `(logical id ${queueLogicalId}):\n  - ${problems.join("\n  - ")}`,
    );
  }
}
