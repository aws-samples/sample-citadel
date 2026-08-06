/**
 * eval-drift-finding-writer.ts (Phase 3 §3.3) — consumes
 * `governance.eval.drift.detected` and writes a GovernanceFinding row
 * into the SAME `GOVERNANCE_LEDGER_TABLE` the Python arbiter's
 * `arbiter/governance/ledger.py::write_finding` writes.
 *
 * HONEST SCHEMA MAPPING (read directly from
 * `arbiter/governance/models.py::GovernanceFinding` and
 * `ledger.py::_serialize_finding` before writing this module):
 * `GovernanceFinding` is an ARBITRATION-DECISION legibility record —
 * its required fields are `workflow_id`, `decision` (one of PERMIT /
 * DENY / ESCALATE / HALT), `requesting_agent`, `target_agent`, `reason`.
 * There is no `category`/`severity` field on the dataclass at all. A
 * metric-drift condition is not literally an arbitration decision on a
 * dispatch request, so this writer maps it as honestly as the schema
 * allows rather than inventing new required fields the Python reader
 * (`governance-ui-resolver.ts::projectFinding`) does not know about:
 *
 *   - `workflow_id` / `workflowId`: a synthetic, STABLE identifier
 *     `EVAL_DRIFT#{agentId}#{dimension}` — stable across cycles for the
 *     same (agent, dimension) pair so the `workflow-index` GSI groups
 *     all drift findings for one agent/dimension together, the same way
 *     a real workflow's findings group under its real workflowId.
 *   - `decision`: `"escalate"` (`ArbitrationDecision.ESCALATE`) — a
 *     drift finding is exactly that: a signal that requires human
 *     attention, not an autonomous permit/deny outcome.
 *   - `requesting_agent`: `"eval-drift-detector"` (the producer).
 *   - `target_agent`: the drifting `agentId` (the subject of concern).
 *   - `reason`: a bounded, legible sentence embedding the dimension,
 *     baseline/current stats, and delta — this IS the evidence a human
 *     reviewer reads in the governance UI.
 *
 * An ADDITIVE `category: "eval-drift"` field is included on the item
 * (present on every write from this module, absent from every
 * arbitration-produced finding) purely as a forward-compatible filter
 * hint for a future governance-UI query — it is NOT read by
 * `projectFinding` today and does not change that resolver's behavior
 * (an unknown DDB attribute is simply not selected into the GraphQL
 * projection). This mirrors the same "additive, never breaks the
 * existing reader" discipline as `traceId`/`runId`/`evalRunId` on the
 * Python-side dataclass itself.
 *
 * IDEMPOTENCY: `findingId` is derived deterministically from
 * `{agentId}#{dimension}#{window.from}#{window.to}` (a stable hash, not
 * a fresh UUID) so the SAME breach detected twice for the SAME cycle
 * (write-once `ConditionExpression: attribute_not_exists(findingId)`,
 * same discipline as ledger.py::write_finding) produces the SAME
 * `findingId` and the second PutItem is rejected as a
 * `ConditionalCheckFailedException` — exactly one finding per breach
 * per cycle (design §3.3). A different `window` (a later cycle)
 * produces a different `findingId`, so a persisting regression across
 * multiple cycles legitimately raises one finding per cycle, not a
 * single finding that silently stops updating.
 *
 * Never throws out of `handleDriftDetected` — an unexpected DDB error
 * (anything other than the expected dedupe rejection) is logged and
 * dropped rather than failing the EventBridge delivery/retry loop for
 * what is a best-effort observability side-channel producing an audit
 * record, not a primary write path.
 */
import { createHash } from "crypto";
import { DynamoDBClient } from "@aws-sdk/client-dynamodb";
import { DynamoDBDocumentClient, PutCommand } from "@aws-sdk/lib-dynamodb";

const dynamoClient = new DynamoDBClient({});
const docClient = DynamoDBDocumentClient.from(dynamoClient);

const GOVERNANCE_LEDGER_TABLE = process.env.GOVERNANCE_LEDGER_TABLE!;

const TTL_DAYS = 90; // QT1-10 default retention, same as ledger.py::write_finding.

export interface DimStatLike {
  passRate?: number;
  meanScore?: number;
  sampleCount: number;
}

export interface DriftDetectedDetail {
  agentId: string;
  dimension: string;
  baseline: DimStatLike;
  current: DimStatLike;
  delta: number | null;
  window: { from: string; to: string };
}

function workflowIdFor(agentId: string, dimension: string): string {
  return `EVAL_DRIFT#${agentId}#${dimension}`;
}

/** Deterministic findingId — the write-once dedupe key for one breach in
 * one cycle. Not a fresh UUID (unlike the Python factory's
 * `GovernanceFinding.create`), because this writer's dedupe key MUST be
 * reproducible from the event payload alone: the same
 * governance.eval.drift.detected redelivered (or independently detected
 * twice due to an upstream retry) for the SAME window must collide on
 * PutItem, not create a second finding. */
function findingIdFor(detail: DriftDetectedDetail): string {
  const raw = `${detail.agentId}#${detail.dimension}#${detail.window.from}#${detail.window.to}`;
  return createHash("sha256").update(raw).digest("hex");
}

function formatStat(stat: DimStatLike): string {
  if (typeof stat.passRate === "number") {
    return `passRate=${stat.passRate} (n=${stat.sampleCount})`;
  }
  if (typeof stat.meanScore === "number") {
    return `meanScore=${stat.meanScore} (n=${stat.sampleCount})`;
  }
  return `no measurement (n=${stat.sampleCount})`;
}

function buildReason(detail: DriftDetectedDetail): string {
  const deltaStr = detail.delta === null ? "n/a" : String(detail.delta);
  return (
    `Production eval drift detected for agent="${detail.agentId}" ` +
    `dimension="${detail.dimension}": baseline ${formatStat(detail.baseline)} ` +
    `-> current ${formatStat(detail.current)} (delta=${deltaStr}) ` +
    `over window [${detail.window.from}, ${detail.window.to}].`
  );
}

/**
 * Writes one write-once GovernanceFinding row for a detected drift
 * breach. Idempotent per (agentId, dimension, window) — see module doc.
 * Never throws.
 */
export async function handleDriftDetected(
  detail: DriftDetectedDetail,
): Promise<void> {
  const findingId = findingIdFor(detail);
  const workflowId = workflowIdFor(detail.agentId, detail.dimension);
  const timestamp = Date.now() / 1000;
  const ttl = timestamp + TTL_DAYS * 86400;

  const item: Record<string, unknown> = {
    // Key-schema aliases (camelCase), required by the table's key schema
    // and the workflow-index GSI — mirrors ledger.py::_serialize_finding.
    findingId,
    workflowId,
    timestamp,
    // Dataclass field names (snake_case), matching every OTHER finding
    // already in this ledger so governance-ui-resolver.ts's existing
    // snake_case reads (requesting_agent/target_agent) work unmodified.
    workflow_id: workflowId,
    decision: "escalate",
    requesting_agent: "eval-drift-detector",
    target_agent: detail.agentId,
    reason: buildReason(detail),
    finding_id: findingId,
    // Additive, non-arbitration filter hint — see module doc. Never read
    // by projectFinding today; present only on drift findings.
    category: "eval-drift",
    dimension: detail.dimension,
    ttl,
  };

  try {
    await docClient.send(
      new PutCommand({
        TableName: GOVERNANCE_LEDGER_TABLE,
        Item: item,
        ConditionExpression: "attribute_not_exists(findingId)",
      }),
    );
  } catch (err: unknown) {
    if (
      err instanceof Error &&
      err.name === "ConditionalCheckFailedException"
    ) {
      // intentional-empty-catch: expected outcome — a finding for this
      // exact (agent, dimension, window) already exists (design §3.3:
      // one finding per breach per cycle). Not an error.
      return;
    }
    console.error(
      "eval-drift-finding-writer: GovernanceFinding write failed — dropping",
      {
        agentId: detail.agentId,
        dimension: detail.dimension,
        findingId,
        error: err instanceof Error ? err.message : String(err),
      },
    );
  }
}

export const handler = async (event: {
  detail?: DriftDetectedDetail;
}): Promise<void> => {
  if (!event.detail) {
    console.error("eval-drift-finding-writer: event missing detail — no-op");
    return;
  }
  await handleDriftDetected(event.detail);
};
