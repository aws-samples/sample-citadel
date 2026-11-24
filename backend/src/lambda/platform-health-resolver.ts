/**
 * Platform health resolver.
 *
 * Backs the admin-only, read-only `Query.getPlatformAlarms` field. Surfaces
 * the state of the existing CloudWatch alarms declared in
 * backend/lib/telemetry-stack.ts (DlqNotEmptyAlarm, DlqNotEmptySharedAlarm,
 * and sibling citadel-* SLO alarms) via `cloudwatch:DescribeAlarms` only —
 * this resolver creates no alarms and holds no other IAM permission.
 *
 * Security model:
 *  - Admin-gated via `isAdminFromEvent` (../utils/auth-event.ts). This is
 *    the AUTHORITATIVE check — the schema's
 *    `@aws_cognito_user_pools(cognito_groups: ["admin"])` directive is
 *    defence-in-depth only, matching the documented convention for sibling
 *    admin queries (see `getTagPolicy`/`listPendingApprovals` comments in
 *    schema.graphql). A non-admin caller gets a THROWN error — never an
 *    empty or filtered list, so a caller cannot distinguish "no alarms"
 *    from "I'm not allowed to see alarms" by probing field shape, but is
 *    also never silently given an empty success response.
 *  - `configured: false` (distinct from an empty `alarms: []`) is returned
 *    — not thrown — when `ALARM_NAME_PREFIX` is unset, or when
 *    `DescribeAlarms` itself fails/is denied. Both are platform
 *    configuration states, not caller-authorization states, so they must
 *    not be indistinguishable from "you're not an admin".
 *  - `queueName`/`queueDepth` are derived entirely from the alarm's own
 *    `Dimensions` (`QueueName`) and `StateReasonData` (the datapoint
 *    CloudWatch already evaluated) — this resolver never calls
 *    `sqs:GetQueueAttributes` or any other SQS API, by design (least
 *    privilege: one read action, `cloudwatch:DescribeAlarms`).
 */
import type { AppSyncResolverEvent } from "aws-lambda";
import {
  CloudWatchClient,
  DescribeAlarmsCommand,
  type MetricAlarm,
} from "@aws-sdk/client-cloudwatch";
import { isAdminFromEvent } from "../utils/auth-event";

const cloudWatch = new CloudWatchClient({});

export type AlarmStateValue = "OK" | "ALARM" | "INSUFFICIENT_DATA";

export interface PlatformAlarm {
  alarmName: string;
  state: AlarmStateValue;
  reason: string | null;
  stateUpdatedAt: string | null;
  category: "dlq" | "slo";
  queueName: string | null;
  queueDepth: number | null;
  redriveHint: string | null;
}

export interface PlatformAlarmsResult {
  configured: boolean;
  alarms: PlatformAlarm[];
}

/** Thrown when a non-admin caller invokes getPlatformAlarms. Fail closed. */
export class PermissionError extends Error {
  constructor(message = "Admin access required") {
    super(message);
    this.name = "PermissionError";
  }
}

const EMPTY_RESULT: PlatformAlarmsResult = { configured: false, alarms: [] };

const REDRIVE_HINT =
  "Messages are accumulating on this dead-letter queue. Inspect the " +
  "failed messages and redrive them once the root cause is fixed — see " +
  "docs/runbooks/DLQ_REDRIVE.md.";

function queueNameFromDimensions(alarm: MetricAlarm): string | null {
  const dim = alarm.Dimensions?.find((d) => d.Name === "QueueName");
  return dim?.Value ?? null;
}

/** Best-effort parse of the datapoint CloudWatch already evaluated out of
 * `StateReasonData` (a JSON string). Never throws — malformed/absent data
 * yields `null`, not a resolver error. */
function queueDepthFromStateReasonData(alarm: MetricAlarm): number | null {
  if (!alarm.StateReasonData) return null;
  try {
    const parsed = JSON.parse(alarm.StateReasonData) as {
      recentDatapoints?: unknown;
    };
    const points = parsed.recentDatapoints;
    if (Array.isArray(points) && points.length > 0) {
      const last = points[points.length - 1];
      if (typeof last === "number" && Number.isFinite(last)) {
        return Math.round(last);
      }
    }
  } catch {
    // Malformed StateReasonData — fall through to null.
  }
  return null;
}

function categoryForAlarm(alarmName: string): "dlq" | "slo" {
  return alarmName.includes("dlq") ? "dlq" : "slo";
}

function mapAlarm(alarm: MetricAlarm): PlatformAlarm {
  const alarmName = alarm.AlarmName ?? "";
  const state = (alarm.StateValue ?? "INSUFFICIENT_DATA") as AlarmStateValue;
  const category = categoryForAlarm(alarmName);
  const queueName = category === "dlq" ? queueNameFromDimensions(alarm) : null;
  const queueDepth =
    category === "dlq" ? queueDepthFromStateReasonData(alarm) : null;

  return {
    alarmName,
    state,
    reason: alarm.StateReason ?? null,
    stateUpdatedAt: alarm.StateUpdatedTimestamp
      ? new Date(alarm.StateUpdatedTimestamp).toISOString()
      : null,
    category,
    queueName,
    queueDepth,
    redriveHint: category === "dlq" && state === "ALARM" ? REDRIVE_HINT : null,
  };
}

export async function handler(
  event: AppSyncResolverEvent<Record<string, never>>,
): Promise<PlatformAlarmsResult> {
  if (!isAdminFromEvent(event)) {
    throw new PermissionError();
  }

  const prefix = process.env.ALARM_NAME_PREFIX;
  if (!prefix) {
    return EMPTY_RESULT;
  }

  try {
    const response = await cloudWatch.send(
      new DescribeAlarmsCommand({ AlarmNamePrefix: prefix }),
    );
    const alarms = (response.MetricAlarms ?? []).map(mapAlarm);
    return { configured: true, alarms };
  } catch {
    // DescribeAlarms denied/unavailable — a platform configuration state,
    // not an authorization state. Fail closed to "not configured" rather
    // than propagating an AWS SDK error to the caller.
    return EMPTY_RESULT;
  }
}
