/**
 * Cost Drift — pure Tier-A aggregate-drift helpers for the cost-ledger
 * reconciler.
 *
 * Pure and I/O-free — no AWS SDK imports, no env var reads, no Date.now()
 * calls (callers pass epoch seconds explicitly so this stays deterministic
 * and property-testable). Mirrors `cost-compute.ts`'s "never fabricate"
 * ethos: unmatched/zero denominators return `null`, never `Infinity`/`NaN`/
 * a guessed `0`.
 */

import type {
  LedgerModelAggregate,
  LedgerRowProjection,
  ReconcilerWindow,
} from "./cost-reconciler-types";

const HOUR_SEC = 3600;

/** Rounds `value` half-up to `decimals` decimal places without introducing float noise. */
function roundHalfUp(value: number, decimals: number): number {
  const factor = 10 ** decimals;
  return Math.round((value + Number.EPSILON) * factor) / factor;
}

/**
 * Floors `epochSec` down to the start of its containing hour. Idempotent:
 * `alignToHour(alignToHour(x)) === alignToHour(x)`. Always `<= x` and a
 * multiple of 3600.
 */
export function alignToHour(epochSec: number): number {
  return Math.floor(epochSec / HOUR_SEC) * HOUR_SEC;
}

/**
 * Computes the aggregate drift percentage between summed ledger tokens and
 * summed CloudWatch metric tokens for one model in one window.
 *
 * `((ledgerTok - metricTok) / metricTok) * 100`, rounded to 4 decimal
 * places. Positive = ledger over-estimated vs Bedrock; negative = under.
 *
 * Returns `null` (never `Infinity`/`NaN`/a fabricated `0`) whenever
 * `metricTok <= 0` — that denominator means "no usable metric", not "metric
 * is actually zero tokens".
 */
export function computeDriftPct(
  ledgerTok: number,
  metricTok: number,
): number | null {
  if (!Number.isFinite(ledgerTok) || !Number.isFinite(metricTok)) return null;
  if (metricTok <= 0) return null;
  const raw = ((ledgerTok - metricTok) / metricTok) * 100;
  if (!Number.isFinite(raw)) return null;
  return roundHalfUp(raw, 4);
}

/**
 * Enumerates ascending, contiguous, hour-aligned half-open windows
 * `[startSec, endSec)` from `watermarkSec` (exclusive lower bound — the
 * last already-processed boundary) up to `targetEndSec` (exclusive upper
 * bound), capped at `maxWindows` for bounded catch-up cost per run.
 *
 * Both bounds are expected to already be hour-aligned by the caller
 * (`alignToHour`); this function does not re-align them, so a caller that
 * passes non-aligned bounds gets non-aligned windows — callers are
 * responsible for aligning first.
 *
 * Returns `[]` when `watermarkSec >= targetEndSec` (nothing to reconcile
 * yet — including the exact-boundary edge case).
 */
export function enumerateWindows(
  watermarkSec: number,
  targetEndSec: number,
  maxWindows: number,
): ReconcilerWindow[] {
  const windows: ReconcilerWindow[] = [];
  let cursor = watermarkSec;
  while (cursor < targetEndSec && windows.length < maxWindows) {
    const endSec = cursor + HOUR_SEC;
    windows.push({ startSec: cursor, endSec });
    cursor = endSec;
  }
  return windows;
}

/** Non-negative-number coercion — never throws, mirrors the writer's defensive coercion. */
function coerceNonNegativeNumber(value: unknown): number {
  if (typeof value === "number" && Number.isFinite(value)) {
    return Math.max(0, value);
  }
  return 0;
}

/**
 * Groups a page of ledger row projections by `modelKey`, summing tokens and
 * collecting row keys for later `driftCheckedAt` annotation. Rows missing a
 * non-empty `modelKey` are skipped entirely rather than bucketed under a
 * fabricated key — an aggregate can't attribute tokens to "unknown".
 */
export function aggregateLedgerWindow(
  rows: LedgerRowProjection[],
): Map<string, LedgerModelAggregate> {
  const byModel = new Map<string, LedgerModelAggregate>();

  for (const row of rows) {
    const modelKey =
      typeof row.modelKey === "string" && row.modelKey.length > 0
        ? row.modelKey
        : undefined;
    if (!modelKey) continue;

    const modelId =
      typeof row.modelId === "string" && row.modelId.length > 0
        ? row.modelId
        : "";

    const inputTokens = coerceNonNegativeNumber(row.inputTokens);
    const outputTokens = coerceNonNegativeNumber(row.outputTokens);

    const existing = byModel.get(modelKey);
    if (existing) {
      existing.inputTokens += inputTokens;
      existing.outputTokens += outputTokens;
      existing.rowKeys.push({ PK: row.PK, SK: row.SK });
      if (!existing.modelId && modelId) existing.modelId = modelId;
    } else {
      byModel.set(modelKey, {
        modelId,
        inputTokens,
        outputTokens,
        rowKeys: [{ PK: row.PK, SK: row.SK }],
      });
    }
  }

  return byModel;
}
