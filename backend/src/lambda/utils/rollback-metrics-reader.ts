/**
 * rollback-metrics-reader.ts — reads the per-CANDIDATE-ARM metrics the
 * auto-rollback evaluator gates on, from the cost ledger (decision D3).
 *
 * HONEST MEASURABILITY (the pivotal constraint): only two metrics are
 * per-arm attributable TODAY, both from the cost ledger's canary
 * attribution (releaseId + releaseArm, propagated by cost-ledger-writer.ts
 * from usage.py's usage rows):
 *   - cost-per-invocation  = Σ priced costMicros / candidate-arm row count
 *   - model-call p95 latency = p95 of candidate-arm row latencyMs
 * error rate, policy-violation finding rate, and drift score have NO
 * per-arm attribution today (decisions D3/D7/D9), so this reader returns
 * `null` for all three — evaluateRollback then structurally cannot fire on
 * them (a null observed value is skipped). This keeps the policy extensible
 * and the behaviour honest: an unmeasured metric never triggers a mutation.
 *
 * The window Query is the SAME base-table read cost-budget-evaluator.ts
 * uses (PK=ORG#<org>, SK BETWEEN :from AND :to) — no new GSI. Rows are
 * filtered in memory to the candidate arm (releaseId === candidate AND
 * releaseArm === "candidate"). Eval-context rows are excluded (an eval run
 * is not real canary traffic and must not trip a rollback), matching
 * cost-budget-evaluator.ts's exclusion of evalContext / costContext="eval".
 */
import { DynamoDBClient } from "@aws-sdk/client-dynamodb";
import { DynamoDBDocumentClient, QueryCommand } from "@aws-sdk/lib-dynamodb";
import type { CandidateArmMetrics } from "./rollback-policy";

const dynamoClient = new DynamoDBClient({});
const docClient = DynamoDBDocumentClient.from(dynamoClient);

function costLedgerTable(): string {
  return process.env.COST_LEDGER_TABLE!;
}

interface LedgerRowLike {
  costMicros?: number | null;
  priced?: boolean;
  latencyMs?: number | null;
  releaseId?: string;
  releaseArm?: string;
  evalContext?: boolean;
  costContext?: string;
}

/** Nearest-rank p95 over a set of samples. Pure. Returns null for an empty
 * set (no evidence — never fabricate a latency). */
export function percentile(values: number[], p: number): number | null {
  if (values.length === 0) return null;
  const sorted = [...values].sort((a, b) => a - b);
  const rank = Math.ceil((p / 100) * sorted.length);
  const index = Math.min(Math.max(rank - 1, 0), sorted.length - 1);
  return sorted[index];
}

/**
 * Read the candidate-arm metrics for one canary over the given window.
 * `candidateReleaseId` is the arm B release (canary.candidateReleaseId).
 * Returns CandidateArmMetrics with null for every unattributed metric and
 * a sampleCount the evaluator's minSampleCount gate consumes.
 */
export async function readCandidateArmMetrics(
  orgId: string,
  candidateReleaseId: string,
  windowStart: string,
  windowEnd: string,
): Promise<CandidateArmMetrics> {
  let pricedCostMicros = 0;
  let sampleCount = 0;
  const latencies: number[] = [];
  let exclusiveStartKey: Record<string, unknown> | undefined;

  do {
    const res = await docClient.send(
      new QueryCommand({
        TableName: costLedgerTable(),
        KeyConditionExpression: "PK = :org AND SK BETWEEN :from AND :to",
        ExpressionAttributeValues: {
          ":org": `ORG#${orgId}`,
          ":from": windowStart,
          ":to": windowEnd,
        },
        ExclusiveStartKey: exclusiveStartKey,
      }),
    );

    for (const item of res.Items ?? []) {
      const row = item as LedgerRowLike;
      // Only candidate-arm rows for THIS candidate release count.
      if (row.releaseArm !== "candidate") continue;
      if (row.releaseId !== candidateReleaseId) continue;
      // Eval runs are not real canary traffic — never let one roll back.
      if (row.evalContext === true) continue;
      if (row.costContext === "eval") continue;

      sampleCount += 1;
      if (row.priced && typeof row.costMicros === "number") {
        pricedCostMicros += row.costMicros;
      }
      if (typeof row.latencyMs === "number") {
        latencies.push(row.latencyMs);
      }
    }

    exclusiveStartKey = res.LastEvaluatedKey as
      Record<string, unknown> | undefined;
  } while (exclusiveStartKey);

  return {
    // cost-per-invocation over the candidate arm's invocations; null when
    // there are no samples (evaluateRollback skips a null observed value).
    costPerInvocationMicros:
      sampleCount > 0 ? pricedCostMicros / sampleCount : null,
    modelCallLatencyP95Ms: percentile(latencies, 95),
    // No per-arm attribution today (D3/D7/D9) — never triggers.
    errorRate: null,
    policyViolationFindingRate: null,
    driftScore: null,
    sampleCount,
  };
}
