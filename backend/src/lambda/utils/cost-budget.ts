/**
 * Cost Budget — pure budget-domain helpers shared by cost-query-handler.ts
 * (PUT /budgets validation/serialization) and cost-budget-evaluator.ts
 * (period-to-date comparison + dedupe escalation logic).
 *
 * Pure and I/O-free — no AWS SDK imports.
 */

export type BudgetPeriodType = "monthly" | "daily";

/** `scope` path-param shape: "org" or "app:<appId>" (see PUT /budgets/{scope}). */
export type BudgetScope = "org" | `app:${string}`;

/**
 * Builds the ledger-table sort key for a budget row. Scope is normalized
 * to the `SK` namespace `BUDGET#ORG` / `BUDGET#APP#<appId>` — deliberately
 * NOT ISO-timestamp-prefixed, so it can never collide with (or be swept
 * into) a `SK BETWEEN :fromIso AND :toIso` rollup Query. Accepts either
 * the bare `"org"` / `"app#<id>"` internal form or the wire `"org"` /
 * `"app:<id>"` scope param — both normalize to the same SK.
 */
export function budgetSortKey(scope: string): string {
  const normalized = scope.replace(":", "#");
  if (normalized === "org") return "BUDGET#ORG";
  const match = /^app#(.+)$/.exec(normalized);
  if (match) return `BUDGET#APP#${match[1]}`;
  throw new Error(`cost-budget: invalid budget scope "${scope}"`);
}

/** Parses a wire scope param ("org" | "app:<appId>") into {scopeType, appId?}. */
export function parseBudgetScope(
  scope: string,
): { scopeType: "org" } | { scopeType: "app"; appId: string } {
  if (scope === "org") return { scopeType: "org" };
  const match = /^app:(.+)$/.exec(scope);
  if (match && match[1].length > 0) {
    return { scopeType: "app", appId: match[1] };
  }
  throw new Error(`cost-budget: invalid budget scope "${scope}"`);
}

/** periodKey: "YYYY-MM" (monthly) or "YYYY-MM-DD" (daily), always UTC. */
export function periodKeyFor(periodType: BudgetPeriodType, now: Date): string {
  const iso = now.toISOString(); // e.g. 2026-07-25T15:10:35.960Z
  return periodType === "monthly" ? iso.slice(0, 7) : iso.slice(0, 10);
}

/** ISO start-of-period timestamp (UTC midnight) for a given periodKey. */
export function periodStartIso(
  periodType: BudgetPeriodType,
  periodKey: string,
): string {
  const day = periodType === "monthly" ? `${periodKey}-01` : periodKey;
  return `${day}T00:00:00.000Z`;
}

/**
 * Returns the subset of `thresholds` (fractions of `limitMicros`) that
 * `spentMicros` meets or exceeds, in ascending order. An empty thresholds
 * list yields an empty result.
 */
export function crossedThresholds(
  spentMicros: number,
  limitMicros: number,
  thresholds: number[],
): number[] {
  if (limitMicros <= 0) return [];
  const ratio = spentMicros / limitMicros;
  return thresholds.filter((t) => ratio >= t).sort((a, b) => a - b);
}

/** The highest threshold already notified for `periodKey`, or undefined if none. */
export function highestNotifiedThreshold(
  notified: Record<string, number>,
  periodKey: string,
): number | undefined {
  return notified[periodKey];
}

/**
 * True when `crossedThreshold` represents a new escalation relative to
 * `lastNotified` (undefined = nothing notified yet for this period). This
 * is the pure predicate backing the evaluator's conditional-UpdateItem
 * dedupe: notify once per (period, threshold), and again only if a higher
 * threshold is subsequently crossed within the same period.
 */
export function shouldNotify(
  lastNotified: number | undefined,
  crossedThreshold: number,
): boolean {
  if (lastNotified === undefined) return true;
  return crossedThreshold > lastNotified;
}
