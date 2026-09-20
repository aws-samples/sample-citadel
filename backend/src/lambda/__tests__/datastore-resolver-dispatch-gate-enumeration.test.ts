/**
 * Enumeration-completeness guard for datastore-resolver.ts's dispatch
 * switch (finding 41c1cd9b — completes the dispatch gate-enumeration
 * family). Modeled on model-config-resolver-dispatch-gate-enumeration
 * .test.ts via the shared AST helpers
 * (fixtures/dispatch-gate-ast-helpers.ts).
 *
 * Classification — every op is ORG-RECONCILED, in one of three shapes:
 *  - clauseGate (requireEffectiveOrgId): listDataStores /
 *    getDataStoreStats / listAvailableDataSources — the case clause
 *    derives a fail-closed effective org (admin uses the supplied
 *    argument; non-admin uses ONLY their own resolved org; unresolved →
 *    hard denial, finding f0ce2b00) and the delegate receives that
 *    derived value, never the raw event.
 *  - rowGate (assertRowOrg fetch-then-verify): getDataStore (via
 *    getDataStoreGuarded) / updateDataStore / deleteDataStore /
 *    connectDataStore / disconnectDataStore / testDataStoreConnection —
 *    the delegate reconciles the fetched row's org against the caller
 *    BEFORE any direct side-effect call (finding ca76d041). Bite:
 *    source-position ordering vs the first dynamodb.send /
 *    secretsManager.send / eventBridge.send in the same function.
 *  - serverDerivedWrite: createDataStore — derives the caller org
 *    server-side (extractOrgFromEvent), throws when unresolved, and
 *    stamps the persisted row's orgId with the derived value only
 *    (wave-3B design item 4: input.orgId is accepted but never trusted).
 */
import * as fs from "fs";
import * as path from "path";
import * as ts from "typescript";
import {
  callReceivesBareEvent,
  callReceivesIdentifier,
  collectCalls,
  collectPropertyAssignments,
  containsThrow,
  extractDispatch,
  findDispatchSwitch,
  findTopLevelFunction,
  functionBody,
  parseSource,
} from "./fixtures/dispatch-gate-ast-helpers";

const HANDLER_PATH = path.join(__dirname, "..", "datastore-resolver.ts");

const SIDE_EFFECT_CALLEES = [
  "dynamodb.send",
  "secretsManager.send",
  "eventBridge.send",
];

/** Ops whose case clause derives a fail-closed effective org. */
const CLAUSE_GATED_OPS: Record<string, { fn: string }> = {
  listDataStores: { fn: "listDataStores" },
  getDataStoreStats: { fn: "getDataStoreStats" },
  listAvailableDataSources: { fn: "listAvailableDataSources" },
};

/** Ops whose delegate reconciles the fetched row's org via assertRowOrg. */
const ROW_GATED_OPS: Record<string, { fn: string }> = {
  getDataStore: { fn: "getDataStoreGuarded" },
  updateDataStore: { fn: "updateDataStore" },
  deleteDataStore: { fn: "deleteDataStore" },
  connectDataStore: { fn: "connectDataStore" },
  disconnectDataStore: { fn: "disconnectDataStore" },
  testDataStoreConnection: { fn: "testDataStoreConnection" },
};

/** Ops that server-derive the org and stamp it on every persisted row. */
const SERVER_DERIVED_WRITE_OPS: Record<string, { fn: string }> = {
  createDataStore: { fn: "createDataStore" },
};

describe("datastore-resolver — dispatch enumeration completeness", () => {
  const source = fs.readFileSync(HANDLER_PATH, "utf-8");
  const sf = parseSource(source, "datastore-resolver.ts");
  const handlerBody = functionBody(findTopLevelFunction(sf, "handler"));
  const dispatch = extractDispatch(findDispatchSwitch(handlerBody));
  const caseNames = Array.from(dispatch.cases.keys());

  const allClassified = new Set([
    ...Object.keys(CLAUSE_GATED_OPS),
    ...Object.keys(ROW_GATED_OPS),
    ...Object.keys(SERVER_DERIVED_WRITE_OPS),
  ]);

  test("the dispatch switch actually has cases to check (sanity check on the parser itself)", () => {
    expect(caseNames.length).toBeGreaterThanOrEqual(10);
    expect(caseNames).toEqual(
      expect.arrayContaining(["listDataStores", "createDataStore"]),
    );
  });

  test("every dispatch case is accounted for in exactly one classification table", () => {
    const unaccounted = caseNames.filter((c) => !allClassified.has(c));
    expect(unaccounted).toEqual([]);
  });

  test("no classification entry references a case that no longer exists in the switch", () => {
    const known = new Set(caseNames);
    const stale = [...allClassified].filter((k) => !known.has(k));
    expect(stale).toEqual([]);
  });

  test("the classification tables jointly cover exactly the dispatch surface", () => {
    expect(allClassified.size).toBe(caseNames.length);
  });

  test("the dispatch default clause throws on unknown fields (fails closed)", () => {
    expect(dispatch.hasDefault).toBe(true);
    expect(containsThrow(dispatch.defaultClause as ts.Node)).toBe(true);
  });

  test("requireEffectiveOrgId itself is fail-closed: admin bypass via isAdminFromEvent, server-derived org via extractOrgFromEvent, throws when unresolved", () => {
    const body = functionBody(
      findTopLevelFunction(sf, "requireEffectiveOrgId"),
    );
    const calls = collectCalls(body, sf);
    expect(calls.some((c) => c.callee === "isAdminFromEvent")).toBe(true);
    expect(calls.some((c) => c.callee === "extractOrgFromEvent")).toBe(true);
    expect(containsThrow(body)).toBe(true);
  });

  describe.each(Object.entries(CLAUSE_GATED_OPS))(
    "CLAUSE_GATED_OPS['%s'] (ORG-RECONCILED in the case clause)",
    (fieldName, meta) => {
      test(`case '${fieldName}' calls requireEffectiveOrgId(event) and passes the derived org — not the raw event — into ${meta.fn}`, () => {
        const clause = dispatch.cases.get(fieldName);
        expect(clause).toBeDefined();
        const calls = collectCalls(clause as ts.Node, sf);
        const gate = calls.filter((c) => c.callee === "requireEffectiveOrgId");
        expect(gate.length).toBeGreaterThanOrEqual(1);
        expect(gate.some((c) => callReceivesBareEvent(c.node))).toBe(true);
        const target = calls.filter((c) => c.callee === meta.fn);
        expect(target.length).toBeGreaterThanOrEqual(1);
        expect(
          target.some((c) => callReceivesIdentifier(c.node, "effectiveOrgId")),
        ).toBe(true);
        expect(target.some((c) => callReceivesBareEvent(c.node))).toBe(false);
      });

      test(`the requireEffectiveOrgId gate precedes the ${meta.fn} delegate call (bite: ordering)`, () => {
        const clause = dispatch.cases.get(fieldName);
        const calls = collectCalls(clause as ts.Node, sf);
        const gates = calls.filter((c) => c.callee === "requireEffectiveOrgId");
        const targets = calls.filter((c) => c.callee === meta.fn);
        expect(Math.min(...gates.map((c) => c.start))).toBeLessThan(
          Math.min(...targets.map((c) => c.start)),
        );
      });
    },
  );

  describe.each(Object.entries(ROW_GATED_OPS))(
    "ROW_GATED_OPS['%s'] (ORG-RECONCILED via assertRowOrg fetch-then-verify)",
    (fieldName, meta) => {
      test(`case '${fieldName}' dispatches to ${meta.fn} and passes the raw \`event\` (the gate's input)`, () => {
        const clause = dispatch.cases.get(fieldName);
        expect(clause).toBeDefined();
        const calls = collectCalls(clause as ts.Node, sf);
        const target = calls.filter((c) => c.callee === meta.fn);
        expect(target.length).toBeGreaterThanOrEqual(1);
        expect(target.some((c) => callReceivesBareEvent(c.node))).toBe(true);
      });

      test(`${meta.fn} reconciles the row org: assertRowOrg(<row>, event) is called`, () => {
        const body = functionBody(findTopLevelFunction(sf, meta.fn));
        const calls = collectCalls(body, sf);
        const gates = calls.filter((c) => c.callee === "assertRowOrg");
        expect(gates.length).toBeGreaterThanOrEqual(1);
        expect(gates.some((c) => callReceivesBareEvent(c.node))).toBe(true);
      });

      test(`${meta.fn}'s assertRowOrg gate precedes its first direct side-effect call (bite: ordering)`, () => {
        const body = functionBody(findTopLevelFunction(sf, meta.fn));
        const calls = collectCalls(body, sf);
        const gates = calls.filter((c) => c.callee === "assertRowOrg");
        const effects = calls.filter((c) =>
          SIDE_EFFECT_CALLEES.includes(c.callee),
        );
        expect(gates.length).toBeGreaterThanOrEqual(1);
        if (effects.length === 0) {
          // getDataStoreGuarded is a pure fetch-then-verify read: its only
          // "effect" is the return; nothing to order against beyond the
          // gate's existence (the fetch itself goes through getDataStore).
          expect(meta.fn).toBe("getDataStoreGuarded");
          return;
        }
        expect(Math.min(...gates.map((c) => c.start))).toBeLessThan(
          Math.min(...effects.map((c) => c.start)),
        );
      });
    },
  );

  describe.each(Object.entries(SERVER_DERIVED_WRITE_OPS))(
    "SERVER_DERIVED_WRITE_OPS['%s'] (ORG-RECONCILED by server-side derivation)",
    (fieldName, meta) => {
      test(`case '${fieldName}' dispatches to ${meta.fn} and passes the raw \`event\` (the gate's input)`, () => {
        const clause = dispatch.cases.get(fieldName);
        expect(clause).toBeDefined();
        const calls = collectCalls(clause as ts.Node, sf);
        const target = calls.filter((c) => c.callee === meta.fn);
        expect(target.length).toBeGreaterThanOrEqual(1);
        expect(target.some((c) => callReceivesBareEvent(c.node))).toBe(true);
      });

      test(`${meta.fn} derives the caller org server-side and fails closed when no org resolves`, () => {
        const body = functionBody(findTopLevelFunction(sf, meta.fn));
        const calls = collectCalls(body, sf);
        expect(calls.some((c) => c.callee === "extractOrgFromEvent")).toBe(
          true,
        );
        let failClosed = false;
        const visit = (n: ts.Node): void => {
          if (
            ts.isIfStatement(n) &&
            ts.isPrefixUnaryExpression(n.expression) &&
            n.expression.operator === ts.SyntaxKind.ExclamationToken &&
            n.expression.operand.getText(sf) === "callerOrgId" &&
            containsThrow(n.thenStatement)
          ) {
            failClosed = true;
          }
          n.forEachChild(visit);
        };
        visit(body);
        expect(failClosed).toBe(true);
      });

      test(`${meta.fn}'s org derivation precedes its first direct side-effect call (bite: ordering)`, () => {
        const body = functionBody(findTopLevelFunction(sf, meta.fn));
        const calls = collectCalls(body, sf);
        const gates = calls.filter((c) => c.callee === "extractOrgFromEvent");
        const effects = calls.filter((c) =>
          SIDE_EFFECT_CALLEES.includes(c.callee),
        );
        expect(gates.length).toBeGreaterThanOrEqual(1);
        expect(effects.length).toBeGreaterThanOrEqual(1);
        expect(Math.min(...gates.map((c) => c.start))).toBeLessThan(
          Math.min(...effects.map((c) => c.start)),
        );
      });

      test(`every orgId: property persisted by ${meta.fn} is the server-derived callerOrgId, never client input`, () => {
        const body = functionBody(findTopLevelFunction(sf, meta.fn));
        const assignments = collectPropertyAssignments(body, "orgId", sf);
        expect(assignments.length).toBeGreaterThanOrEqual(1);
        for (const init of assignments) {
          expect(init).toBe("callerOrgId");
        }
      });
    },
  );
});
