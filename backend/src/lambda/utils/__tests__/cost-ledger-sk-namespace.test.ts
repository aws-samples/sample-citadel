/**
 * SK-namespace invariant: BUDGET# rows must never be swept into an
 * ISO-window ledger rollup Query. Rollup queries bound SK with ISO
 * timestamps only (`SK BETWEEN :fromIso AND :toIso`) — never a high-byte
 * sentinel. Budget rows use SK prefix `BUDGET#` ('B'=0x42 > '2'=0x32, the
 * leading char of any realistic ISO year), so lexically `BUDGET#...`
 * always sorts AFTER any ISO window upper bound this system would ever
 * construct, and a plain string BETWEEN can never include it.
 *
 * This is a pure string-ordering test — no DynamoDB round-trip needed;
 * DynamoDB's BETWEEN on a String (S) sort key uses byte-wise (lexical)
 * ordering, identical to JS string comparison for ASCII ranges.
 */
import { budgetSortKey } from "../cost-budget";

describe("SK-namespace invariant (BUDGET# vs ISO-window rollups)", () => {
  test("a BUDGET# SK sorts after any realistic ISO-window upper bound", () => {
    const budgetSk = budgetSortKey("org");
    const farFutureIso = "2099-12-31T23:59:59.999Z";
    // Lexical comparison mirrors DynamoDB's BETWEEN semantics on a String sort key.
    expect(budgetSk > farFutureIso).toBe(true);
  });

  test("BETWEEN over any ISO window [from, to] never matches a BUDGET# SK", () => {
    const fromIso = "2000-01-01T00:00:00.000Z";
    const toIso = "2099-12-31T23:59:59.999Z";
    const budgetSk = budgetSortKey("app#app-1");

    const withinWindow = budgetSk >= fromIso && budgetSk <= toIso;
    expect(withinWindow).toBe(false);
  });

  test("budgetSortKey produces the documented SK shapes for org and app scope", () => {
    expect(budgetSortKey("org")).toBe("BUDGET#ORG");
    expect(budgetSortKey("app#app-42")).toBe("BUDGET#APP#app-42");
  });
});
