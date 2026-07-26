/**
 * Cost Ledger Reconciler — shared types + reserved-key constants.
 *
 * Watermark/window state lives in the cost-ledger table itself as reserved
 * meta rows under `PK="RECON#COST"` — never colliding with `ORG#...` data
 * rows. See `cost-ledger-reconciler.ts` for the read-modify-write algorithm
 * that uses these shapes.
 */

/** Reserved partition key for all reconciler meta rows (watermark + window markers). */
export const RECON_PK = "RECON#COST";

/** Sort key for the single global watermark row. */
export const WATERMARK_SK = "WATERMARK";

/** Sort key for a per-window idempotency marker / durable drift record. */
export function windowSk(windowStartEpochSec: number): string {
  return `WINDOW#${windowStartEpochSec}`;
}

/** `PK="RECON#COST", SK="WATERMARK"` — single global monotonic watermark. */
export interface WatermarkRow {
  PK: typeof RECON_PK;
  SK: typeof WATERMARK_SK;
  watermarkEpochSec: number;
  updatedAt: string;
}

/** Per-model drift comparison result within one window. */
export interface ModelDriftEntry {
  modelKey: string;
  modelId: string;
  ledgerInputTokens: number;
  ledgerOutputTokens: number;
  metricInputTokens: number | null;
  metricOutputTokens: number | null;
  driftPct: number | null;
  match: "matched" | "metricsMissing";
}

/** `PK="RECON#COST", SK="WINDOW#<start>"` — idempotency anchor + durable drift record. */
export interface LedgerWindowMarkerRow {
  PK: typeof RECON_PK;
  SK: string;
  windowStartEpochSec: number;
  windowEndEpochSec: number;
  computedAt: string;
  tier: "A";
  models: ModelDriftEntry[];
  ledgerRowCount: number;
  unmatchedModelCount: number;
}

/** A half-open `[startSec, endSec)` hour-aligned reconciliation window. */
export interface ReconcilerWindow {
  startSec: number;
  endSec: number;
}

/** Aggregated per-model ledger totals for one window, keyed by modelKey. */
export interface LedgerModelAggregate {
  modelId: string;
  inputTokens: number;
  outputTokens: number;
  rowKeys: Array<{ PK: string; SK: string }>;
}

/** Narrow shape of a ledger row as read (Scan/Query projection) for aggregation. */
export interface LedgerRowProjection {
  PK: string;
  SK: string;
  modelKey?: unknown;
  modelId?: unknown;
  inputTokens?: unknown;
  outputTokens?: unknown;
  capturedAt?: unknown;
  bedrockRequestId?: unknown;
  estimate?: unknown;
}

/** Result of the Tier B feature-gate check (skeleton only — no matching logic). */
export interface TierBGateResult {
  active: boolean;
  reason: "disabled" | "missing_requestId";
}
