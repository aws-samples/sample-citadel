/**
 * Tests for cost-budget-evaluator.ts (scheduled Lambda):
 *  - BudgetIndex enumeration (GSI5PK='BUDGET' Query, never Scan).
 *  - Period-to-date spend sums only priced rows (costMicros); unpriced
 *    rows are tracked, never summed (never fabricate a price).
 *  - Dedupe: two runs, same period+threshold -> exactly one publish
 *    (the second run's conditional UpdateItem fails and is swallowed).
 *  - Escalation: 0.8 -> 1.0 within the same period publishes again.
 *  - Evaluator failures (a single budget's processing throwing) are
 *    logged and never corrupt other budget rows — no empty catches.
 */
import {
  DynamoDBDocumentClient,
  QueryCommand,
  UpdateCommand,
} from "@aws-sdk/lib-dynamodb";
import { mockClient } from "aws-sdk-client-mock";

import { evaluateBudgets } from "../cost-budget-evaluator";
import * as costNotifier from "../cost-notifier";

const ddbMock = mockClient(DynamoDBDocumentClient);

function budgetIndexRow(overrides: Record<string, unknown> = {}) {
  return {
    PK: "ORG#org-1",
    SK: "BUDGET#ORG",
    GSI5PK: "BUDGET",
    GSI5SK: "ORG#org-1#BUDGET#ORG",
    periodType: "monthly",
    limitMicros: 1_000_000,
    thresholds: [0.8, 1.0],
    currency: "USD",
    notified: {},
    ...overrides,
  };
}

beforeEach(() => {
  ddbMock.reset();
  jest.restoreAllMocks();
  process.env.COST_LEDGER_TABLE = "test-ledger";
});

afterEach(() => {
  delete process.env.COST_LEDGER_TABLE;
});

describe("evaluateBudgets", () => {
  test("enumerates budgets via GSI5PK=BUDGET Query, never a Scan", async () => {
    ddbMock
      .on(QueryCommand, { IndexName: "BudgetIndex" })
      .resolves({ Items: [budgetIndexRow()] });
    ddbMock.on(QueryCommand).callsFake((input) => {
      if (input.IndexName === "BudgetIndex") {
        return { Items: [budgetIndexRow()] };
      }
      return { Items: [] }; // period-to-date spend query
    });
    ddbMock.on(UpdateCommand).resolves({});
    jest.spyOn(costNotifier, "emitBudgetEvent").mockResolvedValue();

    await evaluateBudgets();

    const budgetIndexCalls = ddbMock
      .commandCalls(QueryCommand)
      .filter((c) => c.args[0].input.IndexName === "BudgetIndex");
    expect(budgetIndexCalls).toHaveLength(1);
    expect(budgetIndexCalls[0].args[0].input.ExpressionAttributeValues).toEqual(
      expect.objectContaining({ ":gsi5pk": "BUDGET" }),
    );
  });

  test("sums only priced rows for period-to-date spend, tracks unpriced separately", async () => {
    ddbMock.on(QueryCommand).callsFake((input) => {
      if (input.IndexName === "BudgetIndex") {
        return { Items: [budgetIndexRow({ thresholds: [0.5] })] };
      }
      return {
        Items: [
          { costMicros: 400_000, priced: true },
          { costMicros: 100_000, priced: true },
          { costMicros: null, priced: false },
        ],
      };
    });
    ddbMock.on(UpdateCommand).resolves({});
    const emitSpy = jest
      .spyOn(costNotifier, "emitBudgetEvent")
      .mockResolvedValue();

    await evaluateBudgets();

    // 500_000 / 1_000_000 = 0.5 -> crosses the 0.5 threshold -> notifies.
    expect(emitSpy).toHaveBeenCalledWith(
      "cost.budget.threshold.crossed",
      expect.objectContaining({ spentMicros: 500_000, threshold: 0.5 }),
    );
  });

  // CIT-102 §5 — eval-context cost exclusion (pinned both ways). A
  // period-to-date spend sum must never count evalContext===true rows,
  // so an eval run cannot trip an org's budget alarm.
  test("PINNED (CIT-102): evalContext===true rows are excluded from period-to-date spend, never trip a threshold", async () => {
    ddbMock.on(QueryCommand).callsFake((input) => {
      if (input.IndexName === "BudgetIndex") {
        return { Items: [budgetIndexRow({ thresholds: [0.8] })] };
      }
      return {
        Items: [
          { costMicros: 100_000, priced: true },
          // Eval-tagged row carries a huge cost that would otherwise cross
          // the 0.8 threshold (100_000 + 900_000 = 1_000_000 / 1_000_000 = 1.0)
          // but must be excluded entirely.
          { costMicros: 900_000, priced: true, evalContext: true },
        ],
      };
    });
    ddbMock.on(UpdateCommand).resolves({});
    const emitSpy = jest
      .spyOn(costNotifier, "emitBudgetEvent")
      .mockResolvedValue();

    await evaluateBudgets();

    // Only the non-eval 100_000 counts -> 0.1 ratio -> below the 0.8
    // threshold -> no notification.
    expect(emitSpy).not.toHaveBeenCalled();
  });

  test("PINNED (CIT-102): non-eval rows (evalContext absent or false) are unaffected by the exclusion", async () => {
    ddbMock.on(QueryCommand).callsFake((input) => {
      if (input.IndexName === "BudgetIndex") {
        return { Items: [budgetIndexRow({ thresholds: [0.8] })] };
      }
      return {
        Items: [{ costMicros: 900_000, priced: true, evalContext: false }],
      };
    });
    ddbMock.on(UpdateCommand).resolves({});
    const emitSpy = jest
      .spyOn(costNotifier, "emitBudgetEvent")
      .mockResolvedValue();

    await evaluateBudgets();

    expect(emitSpy).toHaveBeenCalledWith(
      "cost.budget.threshold.crossed",
      expect.objectContaining({ spentMicros: 900_000, threshold: 0.8 }),
    );
  });

  // Finding c93c0ab5 (medium, pinned): judge-invocation rows (Phase 2)
  // carry costContext:"eval" (written by handleEvalUsageCaptured in
  // cost-ledger-writer.ts, dims={orgId, agentId, costContext:"eval"} — no
  // evalContext attribute). Prior to this fix, periodToDateSpend excluded
  // only evalContext===true rows, so a judge's own usage counted toward
  // customer budget alarms — contradicting EVENTBRIDGE_CATALOG.md's "a
  // judge's own usage is never customer-billable spend". Mirrors the
  // evalContext exclusion test above exactly, for the sibling attribute.
  test('PINNED (finding c93c0ab5): costContext==="eval" rows are excluded from period-to-date spend, never trip a threshold', async () => {
    ddbMock.on(QueryCommand).callsFake((input) => {
      if (input.IndexName === "BudgetIndex") {
        return { Items: [budgetIndexRow({ thresholds: [0.8] })] };
      }
      return {
        Items: [
          { costMicros: 100_000, priced: true },
          // Judge-invocation row carries a huge cost that would otherwise
          // cross the 0.8 threshold (100_000 + 900_000 = 1_000_000 /
          // 1_000_000 = 1.0) but must be excluded entirely.
          { costMicros: 900_000, priced: true, costContext: "eval" },
        ],
      };
    });
    ddbMock.on(UpdateCommand).resolves({});
    const emitSpy = jest
      .spyOn(costNotifier, "emitBudgetEvent")
      .mockResolvedValue();

    await evaluateBudgets();

    // Only the non-eval 100_000 counts -> 0.1 ratio -> below the 0.8
    // threshold -> no notification.
    expect(emitSpy).not.toHaveBeenCalled();
  });

  test("PINNED (finding c93c0ab5): non-judge rows (costContext absent or a non-eval value) are unaffected by the exclusion", async () => {
    ddbMock.on(QueryCommand).callsFake((input) => {
      if (input.IndexName === "BudgetIndex") {
        return { Items: [budgetIndexRow({ thresholds: [0.8] })] };
      }
      return {
        Items: [{ costMicros: 900_000, priced: true, costContext: undefined }],
      };
    });
    ddbMock.on(UpdateCommand).resolves({});
    const emitSpy = jest
      .spyOn(costNotifier, "emitBudgetEvent")
      .mockResolvedValue();

    await evaluateBudgets();

    expect(emitSpy).toHaveBeenCalledWith(
      "cost.budget.threshold.crossed",
      expect.objectContaining({ spentMicros: 900_000, threshold: 0.8 }),
    );
  });

  test("dedupe: a threshold already notified this period is not re-notified", async () => {
    ddbMock.on(QueryCommand).callsFake((input) => {
      if (input.IndexName === "BudgetIndex") {
        return {
          Items: [
            budgetIndexRow({
              thresholds: [0.8],
              notified: { "2026-07": 0.8 },
            }),
          ],
        };
      }
      return { Items: [{ costMicros: 900_000, priced: true }] };
    });
    ddbMock.on(UpdateCommand).resolves({});
    const emitSpy = jest
      .spyOn(costNotifier, "emitBudgetEvent")
      .mockResolvedValue();

    await evaluateBudgets({ now: new Date("2026-07-15T00:00:00.000Z") });

    expect(emitSpy).not.toHaveBeenCalled();
  });

  test("escalation: 0.8 already notified, now crossing 1.0 in the same period publishes again", async () => {
    ddbMock.on(QueryCommand).callsFake((input) => {
      if (input.IndexName === "BudgetIndex") {
        return {
          Items: [
            budgetIndexRow({
              thresholds: [0.8, 1.0],
              notified: { "2026-07": 0.8 },
            }),
          ],
        };
      }
      return { Items: [{ costMicros: 1_200_000, priced: true }] };
    });
    ddbMock.on(UpdateCommand).resolves({});
    const emitSpy = jest
      .spyOn(costNotifier, "emitBudgetEvent")
      .mockResolvedValue();

    await evaluateBudgets({ now: new Date("2026-07-15T00:00:00.000Z") });

    expect(emitSpy).toHaveBeenCalledWith(
      "cost.budget.breached",
      expect.objectContaining({ threshold: 1.0 }),
    );
  });

  test("conditional UpdateItem dedupe: the second concurrent run's conditional check failure is swallowed, not thrown", async () => {
    ddbMock.on(QueryCommand).callsFake((input) => {
      if (input.IndexName === "BudgetIndex") {
        return { Items: [budgetIndexRow({ thresholds: [0.8] })] };
      }
      return { Items: [{ costMicros: 900_000, priced: true }] };
    });
    const err = Object.assign(new Error("conditional check failed"), {
      name: "ConditionalCheckFailedException",
    });
    ddbMock.on(UpdateCommand).rejects(err);
    const emitSpy = jest
      .spyOn(costNotifier, "emitBudgetEvent")
      .mockResolvedValue();

    await expect(evaluateBudgets()).resolves.not.toThrow();
    // Conditional update failed -> notification must NOT have been sent,
    // because the dedupe write is what gates the publish.
    expect(emitSpy).not.toHaveBeenCalled();
  });

  test("one budget's processing failure is logged and does not prevent other budgets from being evaluated", async () => {
    const consoleErrorSpy = jest.spyOn(console, "error").mockImplementation();
    ddbMock.on(QueryCommand).callsFake((input) => {
      if (input.IndexName === "BudgetIndex") {
        return {
          Items: [
            budgetIndexRow({ PK: "ORG#org-bad", thresholds: [0.8] }),
            budgetIndexRow({ PK: "ORG#org-good", thresholds: [0.8] }),
          ],
        };
      }
      // Fail the spend-lookup Query for the "bad" org only.
      if (input.ExpressionAttributeValues?.[":org"] === "ORG#org-bad") {
        throw new Error("transient DDB error");
      }
      return { Items: [{ costMicros: 900_000, priced: true }] };
    });
    ddbMock.on(UpdateCommand).resolves({});
    const emitSpy = jest
      .spyOn(costNotifier, "emitBudgetEvent")
      .mockResolvedValue();

    await evaluateBudgets();

    expect(consoleErrorSpy).toHaveBeenCalled();
    expect(emitSpy).toHaveBeenCalledTimes(1);
    consoleErrorSpy.mockRestore();
  });
});
