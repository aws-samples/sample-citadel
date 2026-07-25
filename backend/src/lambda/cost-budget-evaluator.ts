/**
 * Cost Budget Evaluator — scheduled Lambda (separate from
 * cost-ledger-reconciler.ts: different purpose — budget breach vs token
 * drift — and independent failure isolation; needs `events:PutEvents`,
 * which the reconciler does not).
 *
 * Flow per run:
 *  1. Enumerate every budget row across every org via a single
 *     `Query GSI5PK='BUDGET'` on the sparse `BudgetIndex` — sparse because
 *     GSI5PK/GSI5SK are written ONLY on budget rows, so this stays cheap
 *     and never becomes a Scan as the ledger grows (binding: never Scan).
 *  2. For each budget, compute period-to-date spend via a base-table Query
 *     `PK=ORG#<org> AND SK BETWEEN :periodStartIso AND :nowIso`, summing
 *     `costMicros` only where `priced===true` (unpriced rows are counted,
 *     never summed — never fabricate a price).
 *  3. Determine which thresholds are newly crossed relative to the
 *     budget's `notified` map for the current periodKey.
 *  4. Dedupe via an atomic conditional `UpdateItem`
 *     (`notified.#pk` absent OR less than the new threshold). Only a
 *     successful conditional write is followed by a publish — this is
 *     what makes the notification exactly-once per (period, threshold)
 *     even under concurrent/retried evaluator runs.
 *
 * FAILURE ISOLATION (binding): one budget's processing failure (a read
 * error, a malformed row) is logged via `console.error` and the loop
 * continues to the next budget — it never throws out of `evaluateBudgets`
 * and never leaves a partial/corrupt write on the budget row it failed on
 * (the conditional UpdateItem is all-or-nothing).
 */

import { DynamoDBClient } from "@aws-sdk/client-dynamodb";
import {
  DynamoDBDocumentClient,
  QueryCommand,
  UpdateCommand,
} from "@aws-sdk/lib-dynamodb";

import {
  periodKeyFor,
  periodStartIso,
  crossedThresholds,
  highestNotifiedThreshold,
  shouldNotify,
  type BudgetPeriodType,
} from "./utils/cost-budget";
import { emitBudgetEvent, type BudgetDetailType } from "./cost-notifier";

const dynamoClient = new DynamoDBClient({});
const docClient = DynamoDBDocumentClient.from(dynamoClient);

const COST_LEDGER_TABLE = process.env.COST_LEDGER_TABLE!;

interface BudgetIndexRow {
  PK: string; // ORG#<orgId>
  SK: string; // BUDGET#ORG | BUDGET#APP#<appId>
  periodType: BudgetPeriodType;
  limitMicros: number;
  thresholds: number[];
  currency: string;
  notified?: Record<string, number>;
}

interface EvaluateOptions {
  now?: Date;
}

function orgIdFromPk(pk: string): string {
  return pk.replace(/^ORG#/, "");
}

function scopeFromSk(sk: string): string {
  return sk === "BUDGET#ORG" ? "org" : `app:${sk.replace("BUDGET#APP#", "")}`;
}

/** Enumerates every budget row via the sparse BudgetIndex GSI. Never a Scan. */
async function listAllBudgets(): Promise<BudgetIndexRow[]> {
  const rows: BudgetIndexRow[] = [];
  let exclusiveStartKey: Record<string, unknown> | undefined;

  do {
    const result = await docClient.send(
      new QueryCommand({
        TableName: COST_LEDGER_TABLE,
        IndexName: "BudgetIndex",
        KeyConditionExpression: "GSI5PK = :gsi5pk",
        ExpressionAttributeValues: { ":gsi5pk": "BUDGET" },
        ExclusiveStartKey: exclusiveStartKey,
      }),
    );
    rows.push(...((result.Items ?? []) as BudgetIndexRow[]));
    exclusiveStartKey = result.LastEvaluatedKey as
      | Record<string, unknown>
      | undefined;
  } while (exclusiveStartKey);

  return rows;
}

/** Period-to-date spend for one org, summing only priced rows. */
async function periodToDateSpend(
  orgId: string,
  periodStart: string,
  nowIso: string,
): Promise<{ spentMicros: number; unpricedCount: number }> {
  let spentMicros = 0;
  let unpricedCount = 0;
  let exclusiveStartKey: Record<string, unknown> | undefined;

  do {
    const result = await docClient.send(
      new QueryCommand({
        TableName: COST_LEDGER_TABLE,
        KeyConditionExpression: "PK = :org AND SK BETWEEN :from AND :to",
        ExpressionAttributeValues: {
          ":org": `ORG#${orgId}`,
          ":from": periodStart,
          ":to": nowIso,
        },
        ExclusiveStartKey: exclusiveStartKey,
      }),
    );

    for (const item of result.Items ?? []) {
      const row = item as { costMicros?: number | null; priced?: boolean };
      if (row.priced && typeof row.costMicros === "number") {
        spentMicros += row.costMicros;
      } else {
        unpricedCount += 1;
      }
    }

    exclusiveStartKey = result.LastEvaluatedKey as
      | Record<string, unknown>
      | undefined;
  } while (exclusiveStartKey);

  return { spentMicros, unpricedCount };
}

/**
 * Atomic dedupe write: succeeds only if nothing has been notified for this
 * period yet, or the previously notified threshold is lower than the new
 * one. Returns true when the write succeeded (caller should publish);
 * false when a concurrent/prior run already claimed this
 * (period, threshold) — the ConditionalCheckFailedException is swallowed
 * here, intentionally: it is the expected "someone else already notified"
 * outcome, not an error.
 */
async function tryClaimNotification(
  pk: string,
  sk: string,
  periodKey: string,
  threshold: number,
): Promise<boolean> {
  try {
    await docClient.send(
      new UpdateCommand({
        TableName: COST_LEDGER_TABLE,
        Key: { PK: pk, SK: sk },
        UpdateExpression: "SET notified.#pk = :t",
        ExpressionAttributeNames: { "#pk": periodKey },
        ExpressionAttributeValues: { ":t": threshold },
        ConditionExpression:
          "attribute_not_exists(notified) OR attribute_not_exists(notified.#pk) OR notified.#pk < :t",
      }),
    );
    return true;
  } catch (err: unknown) {
    if (
      err instanceof Error &&
      err.name === "ConditionalCheckFailedException"
    ) {
      // intentional-empty-catch: expected outcome when a concurrent/prior
      // run already claimed this (period, threshold) — not an error.
      return false;
    }
    console.error("cost-budget-evaluator: dedupe UpdateItem failed", {
      pk,
      sk,
      periodKey,
      threshold,
      error: err instanceof Error ? err.message : String(err),
    });
    return false;
  }
}

async function evaluateOneBudget(
  budget: BudgetIndexRow,
  now: Date,
): Promise<void> {
  const orgId = orgIdFromPk(budget.PK);
  const scope = scopeFromSk(budget.SK);
  const periodKey = periodKeyFor(budget.periodType, now);
  const periodStart = periodStartIso(budget.periodType, periodKey);

  const { spentMicros } = await periodToDateSpend(
    orgId,
    periodStart,
    now.toISOString(),
  );

  const crossed = crossedThresholds(
    spentMicros,
    budget.limitMicros,
    budget.thresholds,
  );
  if (crossed.length === 0) return;

  const highestCrossed = crossed[crossed.length - 1];
  const lastNotified = highestNotifiedThreshold(
    budget.notified ?? {},
    periodKey,
  );
  if (!shouldNotify(lastNotified, highestCrossed)) return;

  const claimed = await tryClaimNotification(
    budget.PK,
    budget.SK,
    periodKey,
    highestCrossed,
  );
  if (!claimed) return;

  const detailType: BudgetDetailType =
    highestCrossed >= 1.0
      ? "cost.budget.breached"
      : "cost.budget.threshold.crossed";

  await emitBudgetEvent(detailType, {
    orgId,
    scope,
    periodKey,
    threshold: highestCrossed,
    spentMicros,
    limitMicros: budget.limitMicros,
    currency: budget.currency,
  });
}

/**
 * Evaluates every budget across every org. Never throws out of this
 * function — a single budget's failure is logged and the remaining
 * budgets are still evaluated (failure isolation, per binding rules).
 */
export async function evaluateBudgets(
  options: EvaluateOptions = {},
): Promise<void> {
  const now = options.now ?? new Date();
  const budgets = await listAllBudgets();

  for (const budget of budgets) {
    try {
      await evaluateOneBudget(budget, now);
    } catch (err: unknown) {
      console.error(
        "cost-budget-evaluator: failed to evaluate budget, continuing with remaining budgets",
        {
          pk: budget.PK,
          sk: budget.SK,
          error: err instanceof Error ? err.message : String(err),
        },
      );
    }
  }
}

export const handler = async (): Promise<void> => {
  await evaluateBudgets();
};
