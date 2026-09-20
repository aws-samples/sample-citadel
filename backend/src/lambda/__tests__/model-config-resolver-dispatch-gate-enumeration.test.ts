/**
 * Enumeration-completeness guard for model-config-resolver.ts's dispatch
 * switch (25bb4af6/3c67ccc6 wave). Modeled on
 * eval-run-resolver-dispatch-gate-enumeration.test.ts via the shared AST
 * helpers (fixtures/dispatch-gate-ast-helpers.ts).
 *
 * Classification:
 *  - GATED (admin): updateModelConfig / setModelCatalogEntryStatus /
 *    syncModelCatalog — every WRITE (and the sync trigger) requires
 *    isAdminFromEvent, throwing otherwise, and the gate precedes the
 *    side effect (bite: source-position ordering vs docClient.send /
 *    publishEvent).
 *  - EXEMPT (platform-global reads BY DESIGN): listModelCatalog /
 *    getModelConfig — the model catalog and the resolved model config are
 *    platform-scoped configuration (scope key defaults to "platform"),
 *    not org-partitioned tenant rows; there is no tenant boundary to
 *    reconcile. The exemption is pinned structurally: neither case
 *    forwards the raw `event` into its delegate, so the read path cannot
 *    even see caller identity — a future change that starts threading
 *    `event` into these reads (a sign tenant data moved in) fails this
 *    guard and forces reclassification.
 */
import * as fs from "fs";
import * as path from "path";
import * as ts from "typescript";
import {
  callReceivesBareEvent,
  collectCalls,
  containsThrow,
  extractDispatch,
  findDispatchSwitch,
  findHandlerArrowBody,
  findTopLevelFunction,
  functionBody,
  parseSource,
} from "./fixtures/dispatch-gate-ast-helpers";

const HANDLER_PATH = path.join(__dirname, "..", "model-config-resolver.ts");

/** Admin-gated ops with the side-effect call the gate must precede. */
const GATED_OPS: Record<
  string,
  { fn: string; sideEffect: "docClient.send" | "publishEvent" }
> = {
  updateModelConfig: { fn: "updateModelConfig", sideEffect: "docClient.send" },
  setModelCatalogEntryStatus: {
    fn: "setModelCatalogEntryStatus",
    sideEffect: "docClient.send",
  },
  syncModelCatalog: { fn: "syncModelCatalog", sideEffect: "publishEvent" },
};

const EXEMPT_OPS: Record<string, { fn: string; reason: string }> = {
  listModelCatalog: {
    fn: "listModelCatalog",
    reason:
      "platform-global catalog read by design — data-driven model catalog, " +
      "no org partition; delegate receives no event (pinned below)",
  },
  getModelConfig: {
    fn: "getModelConfig",
    reason:
      "platform-global config read by design — scope defaults to 'platform', " +
      "no org partition; delegate receives no event (pinned below)",
  },
};

describe("model-config-resolver — dispatch enumeration completeness", () => {
  const source = fs.readFileSync(HANDLER_PATH, "utf-8");
  const sf = parseSource(source, "model-config-resolver.ts");
  const handlerBody = findHandlerArrowBody(sf);
  const dispatch = extractDispatch(findDispatchSwitch(handlerBody));
  const caseNames = Array.from(dispatch.cases.keys());

  test("the dispatch switch actually has cases to check (sanity check on the parser itself)", () => {
    expect(caseNames.length).toBeGreaterThanOrEqual(5);
    expect(caseNames).toEqual(
      expect.arrayContaining([
        "listModelCatalog",
        "getModelConfig",
        "updateModelConfig",
        "setModelCatalogEntryStatus",
        "syncModelCatalog",
      ]),
    );
  });

  test("every dispatch case is accounted for in GATED_OPS or EXEMPT_OPS", () => {
    const unaccounted = caseNames.filter(
      (c) => !(c in GATED_OPS) && !(c in EXEMPT_OPS),
    );
    expect(unaccounted).toEqual([]);
  });

  test("no classification entry references a case that no longer exists in the switch", () => {
    const known = new Set(caseNames);
    const stale = [
      ...Object.keys(GATED_OPS),
      ...Object.keys(EXEMPT_OPS),
    ].filter((k) => !known.has(k));
    expect(stale).toEqual([]);
  });

  test("the classification tables jointly cover exactly the dispatch surface", () => {
    const claimed =
      Object.keys(GATED_OPS).length + Object.keys(EXEMPT_OPS).length;
    expect(claimed).toBe(caseNames.length);
  });

  test("the dispatch default clause throws on unknown fields (fails closed)", () => {
    expect(dispatch.hasDefault).toBe(true);
    expect(containsThrow(dispatch.defaultClause as ts.Node)).toBe(true);
  });

  describe.each(Object.entries(GATED_OPS))(
    "GATED_OPS['%s']",
    (fieldName, meta) => {
      test(`case '${fieldName}' dispatches to ${meta.fn} and passes the raw \`event\` (the gate's input)`, () => {
        const clause = dispatch.cases.get(fieldName);
        expect(clause).toBeDefined();
        const calls = collectCalls(clause as ts.Node, sf);
        const target = calls.filter((c) => c.callee === meta.fn);
        expect(target.length).toBeGreaterThanOrEqual(1);
        expect(target.some((c) => callReceivesBareEvent(c.node))).toBe(true);
      });

      test(`${meta.fn} is admin-gated: isAdminFromEvent guard that throws when absent`, () => {
        const body = functionBody(findTopLevelFunction(sf, meta.fn));
        let adminGated = false;
        const visit = (n: ts.Node): void => {
          if (
            ts.isIfStatement(n) &&
            ts.isPrefixUnaryExpression(n.expression) &&
            n.expression.operator === ts.SyntaxKind.ExclamationToken &&
            ts.isCallExpression(n.expression.operand) &&
            ts.isIdentifier(n.expression.operand.expression) &&
            n.expression.operand.expression.text === "isAdminFromEvent" &&
            containsThrow(n.thenStatement)
          ) {
            adminGated = true;
          }
          n.forEachChild(visit);
        };
        visit(body);
        expect(adminGated).toBe(true);
      });

      test(`${meta.fn}'s admin gate precedes its first ${meta.sideEffect} side effect (bite: ordering)`, () => {
        const body = functionBody(findTopLevelFunction(sf, meta.fn));
        const calls = collectCalls(body, sf);
        const gates = calls.filter((c) => c.callee === "isAdminFromEvent");
        const effects = calls.filter((c) => c.callee === meta.sideEffect);
        expect(gates.length).toBeGreaterThanOrEqual(1);
        expect(effects.length).toBeGreaterThanOrEqual(1);
        expect(Math.min(...gates.map((c) => c.start))).toBeLessThan(
          Math.min(...effects.map((c) => c.start)),
        );
      });
    },
  );

  describe.each(Object.entries(EXEMPT_OPS))(
    "EXEMPT_OPS['%s'] (platform-global read by design)",
    (fieldName, meta) => {
      test(`case '${fieldName}' does NOT forward the raw \`event\` into ${meta.fn} — the read path cannot see caller identity`, () => {
        const clause = dispatch.cases.get(fieldName);
        expect(clause).toBeDefined();
        const calls = collectCalls(clause as ts.Node, sf);
        const target = calls.filter((c) => c.callee === meta.fn);
        expect(target.length).toBeGreaterThanOrEqual(1);
        expect(target.some((c) => callReceivesBareEvent(c.node))).toBe(false);
      });

      test(`${meta.fn}'s own body performs no identity/org derivation (no extractOrgFromEvent / isAdminFromEvent)`, () => {
        const body = functionBody(findTopLevelFunction(sf, meta.fn));
        const calls = collectCalls(body, sf);
        expect(calls.some((c) => c.callee === "extractOrgFromEvent")).toBe(
          false,
        );
        expect(calls.some((c) => c.callee === "isAdminFromEvent")).toBe(false);
      });
    },
  );
});
