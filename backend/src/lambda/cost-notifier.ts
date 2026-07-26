/**
 * Cost Notifier — sanitize + PutEvents helper for the two budget-alert
 * detail-types emitted by cost-budget-evaluator.ts, on the shared
 * `agentEventBus`, source `citadel.telemetry`.
 *
 * Deliberately does NOT reuse `emitGovernanceEvent` (backend/src/utils
 * governance-namespaced emitter): this is a distinct bounded context
 * (telemetry, not governance) with its own detail-type set, per the
 * architect design. It mirrors that module's fail-closed sanitisation
 * (`<script>`/`<iframe>`/`<object>` tag stripping) so a budget scope/orgId
 * value that somehow contains injected markup can never reach a downstream
 * EventBridge consumer un-sanitised.
 *
 * This makes TelemetryStack an EventBridge *publisher* for the first time
 * (previously consume-only) — the evaluator Lambda's role needs an
 * `events:PutEvents` grant (added in telemetry-stack.ts).
 */

import {
  EventBridgeClient,
  PutEventsCommand,
} from "@aws-sdk/client-eventbridge";

export const BUDGET_DETAIL_TYPES = [
  "cost.budget.threshold.crossed",
  "cost.budget.breached",
] as const;

export type BudgetDetailType = (typeof BUDGET_DETAIL_TYPES)[number];

export interface BudgetEventDetail {
  orgId: string;
  /** "org" or "app:<appId>" — mirrors the PUT /budgets/{scope} wire shape. */
  scope: string;
  periodKey: string;
  threshold: number;
  spentMicros: number;
  limitMicros: number;
  currency: string;
}

// Fail-closed sanitiser — identical contract to the governance notifier's:
// strip <script>/<iframe>/<object> tags (and content), leave every other
// character byte-for-byte intact, run to a fixed point so nested/overlapping
// constructs cannot survive.
const DANGEROUS_TAGS = "script|iframe|object";
const PAIRED_TAG_RE = new RegExp(
  `<\\s*(${DANGEROUS_TAGS})\\b[^>]*>[\\s\\S]*?<\\s*\\/\\s*\\1\\b[^>]*>`,
  "gi",
);
const STRAY_TAG_RE = new RegExp(
  `<\\s*\\/?\\s*(?:${DANGEROUS_TAGS})\\b[^>]*>?`,
  "gi",
);

function sanitizeString(s: string): string {
  let out = s;
  let previous: string;
  do {
    previous = out;
    out = out.replace(PAIRED_TAG_RE, "").replace(STRAY_TAG_RE, "");
  } while (out !== previous);
  return out;
}

function sanitizeDeep<T>(value: T): T {
  if (typeof value === "string") return sanitizeString(value) as unknown as T;
  if (Array.isArray(value))
    return value.map((v) => sanitizeDeep(v)) as unknown as T;
  if (value && typeof value === "object") {
    const out: Record<string, unknown> = {};
    for (const [k, v] of Object.entries(value as Record<string, unknown>)) {
      out[k] = sanitizeDeep(v);
    }
    return out as unknown as T;
  }
  return value;
}

let _client: EventBridgeClient | null = null;
function ebClient(): EventBridgeClient {
  if (!_client) _client = new EventBridgeClient({});
  return _client;
}

/**
 * Publishes a budget alert event. Errors are NOT swallowed here — the
 * caller (cost-budget-evaluator.ts) decides how to react to a publish
 * failure, and per the binding rule "evaluator/notifier failures log and
 * never corrupt budget rows", the evaluator issues its dedupe
 * conditional-UpdateItem BEFORE calling this, so a publish failure can
 * never leave a budget row in an inconsistent (notified-but-not-sent, or
 * vice versa) state — worst case is a swallowed duplicate suppressed by
 * the dedupe key, never a corrupted row.
 */
export async function emitBudgetEvent(
  detailType: BudgetDetailType,
  detail: BudgetEventDetail,
): Promise<void> {
  const sanitisedDetail = sanitizeDeep(detail);
  const envelope = {
    ...sanitisedDetail,
    timestamp: new Date().toISOString(),
  };

  const command = new PutEventsCommand({
    Entries: [
      {
        Source: "citadel.telemetry",
        DetailType: detailType,
        Detail: JSON.stringify(envelope),
        EventBusName: process.env.EVENT_BUS_NAME || "default",
      },
    ],
  });

  await ebClient().send(command);
}

/** Test-only: reset the cached EventBridge client. Do not call from production code. */
export function __resetCostNotifierForTest(): void {
  _client = null;
}
