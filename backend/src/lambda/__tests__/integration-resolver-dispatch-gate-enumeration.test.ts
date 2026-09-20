/**
 * Enumeration-completeness guard for integration-resolver.ts's dispatch
 * switch (finding 41c1cd9b — completes the dispatch gate-enumeration
 * family). Modeled on datastore-resolver-dispatch-gate-enumeration
 * .test.ts via the shared AST helpers
 * (fixtures/dispatch-gate-ast-helpers.ts).
 *
 * Classification — every op is ORG-RECONCILED, in one of four shapes:
 *  - clauseGate (requireEffectiveOrgId): listIntegrations — the case
 *    clause derives a fail-closed effective org (finding f0ce2b00) and
 *    the delegate receives that derived value, never the raw event.
 *  - clauseRowGate: getIntegration — the case clause itself fetches the
 *    row and reconciles it via assertRowOrg(<row>, event) before
 *    returning the sanitized record (finding ca76d041, CRE item 3).
 *  - rowGate (assertRowOrg fetch-then-verify in the delegate):
 *    updateIntegration / deleteIntegration / testIntegration /
 *    connectIntegration / disconnectIntegration — the delegate
 *    reconciles the fetched row's org BEFORE any direct side-effect call
 *    (finding ca76d041). Bite: source-position ordering vs the first
 *    dynamodb.send / secretsManager.send / eventBridge.send / ssm.send.
 *  - rejectNotCoerce write: createIntegration — non-admins must present
 *    an input.orgId equal to their server-derived org; mismatch or an
 *    unresolvable caller org throws BEFORE any Secrets Manager call,
 *    credential-provider provisioning, or DynamoDB write. Admins may
 *    create on behalf of any org (explicit isAdminFromEvent bypass,
 *    matching every other operation in this module).
 */
import * as fs from "fs";
import * as path from "path";
import * as ts from "typescript";
import {
  callReceivesBareEvent,
  callReceivesIdentifier,
  collectCalls,
  containsThrow,
  extractDispatch,
  findDispatchSwitch,
  findTopLevelFunction,
  functionBody,
  parseSource,
} from "./fixtures/dispatch-gate-ast-helpers";

const HANDLER_PATH = path.join(__dirname, "..", "integration-resolver.ts");

const SIDE_EFFECT_CALLEES = [
  "dynamodb.send",
  "secretsManager.send",
  "eventBridge.send",
  "ssm.send",
];

const CLAUSE_GATED_OPS: Record<string, { fn: string }> = {
  listIntegrations: { fn: "listIntegrations" },
};

const CLAUSE_ROW_GATED_OPS: Record<string, { fn: string }> = {
  getIntegration: { fn: "getIntegration" },
};

const ROW_GATED_OPS: Record<string, { fn: string }> = {
  updateIntegration: { fn: "updateIntegration" },
  deleteIntegration: { fn: "deleteIntegration" },
  testIntegration: { fn: "testIntegration" },
  connectIntegration: { fn: "connectIntegration" },
  disconnectIntegration: { fn: "disconnectIntegration" },
};

const REJECT_NOT_COERCE_OPS: Record<string, { fn: string }> = {
  createIntegration: { fn: "createIntegration" },
};

describe("integration-resolver — dispatch enumeration completeness", () => {
  const source = fs.readFileSync(HANDLER_PATH, "utf-8");
  const sf = parseSource(source, "integration-resolver.ts");
  const handlerBody = functionBody(findTopLevelFunction(sf, "handler"));
  const dispatch = extractDispatch(findDispatchSwitch(handlerBody));
  const caseNames = Array.from(dispatch.cases.keys());

  const allClassified = new Set([
    ...Object.keys(CLAUSE_GATED_OPS),
    ...Object.keys(CLAUSE_ROW_GATED_OPS),
    ...Object.keys(ROW_GATED_OPS),
    ...Object.keys(REJECT_NOT_COERCE_OPS),
  ]);

  test("the dispatch switch actually has cases to check (sanity check on the parser itself)", () => {
    expect(caseNames.length).toBeGreaterThanOrEqual(8);
    expect(caseNames).toEqual(
      expect.arrayContaining(["createIntegration", "getIntegration"]),
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

  describe.each(Object.entries(CLAUSE_ROW_GATED_OPS))(
    "CLAUSE_ROW_GATED_OPS['%s'] (ORG-RECONCILED via assertRowOrg in the case clause)",
    (fieldName, meta) => {
      test(`case '${fieldName}' fetches via ${meta.fn} and reconciles with assertRowOrg(<row>, event) before returning`, () => {
        const clause = dispatch.cases.get(fieldName);
        expect(clause).toBeDefined();
        const calls = collectCalls(clause as ts.Node, sf);
        const fetches = calls.filter((c) => c.callee === meta.fn);
        expect(fetches.length).toBeGreaterThanOrEqual(1);
        const gates = calls.filter((c) => c.callee === "assertRowOrg");
        expect(gates.length).toBeGreaterThanOrEqual(1);
        expect(gates.some((c) => callReceivesBareEvent(c.node))).toBe(true);
      });

      test(`the assertRowOrg gate sits between the ${meta.fn} fetch and the clause's return (bite: ordering)`, () => {
        const clause = dispatch.cases.get(fieldName) as ts.Node;
        const calls = collectCalls(clause, sf);
        const fetchStart = Math.min(
          ...calls.filter((c) => c.callee === meta.fn).map((c) => c.start),
        );
        const gateStart = Math.min(
          ...calls
            .filter((c) => c.callee === "assertRowOrg")
            .map((c) => c.start),
        );
        expect(fetchStart).toBeLessThan(gateStart);
        const text = clause.getText(sf);
        const returnIdx = clause.getStart(sf) + text.indexOf("return ");
        expect(text.indexOf("return ")).toBeGreaterThan(-1);
        expect(gateStart).toBeLessThan(returnIdx);
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
        expect(effects.length).toBeGreaterThanOrEqual(1);
        expect(Math.min(...gates.map((c) => c.start))).toBeLessThan(
          Math.min(...effects.map((c) => c.start)),
        );
      });
    },
  );

  describe.each(Object.entries(REJECT_NOT_COERCE_OPS))(
    "REJECT_NOT_COERCE_OPS['%s'] (ORG-RECONCILED by reject-not-coerce)",
    (fieldName, meta) => {
      test(`case '${fieldName}' dispatches to ${meta.fn} and passes the raw \`event\` (the gate's input)`, () => {
        const clause = dispatch.cases.get(fieldName);
        expect(clause).toBeDefined();
        const calls = collectCalls(clause as ts.Node, sf);
        const target = calls.filter((c) => c.callee === meta.fn);
        expect(target.length).toBeGreaterThanOrEqual(1);
        expect(target.some((c) => callReceivesBareEvent(c.node))).toBe(true);
      });

      test(`${meta.fn} rejects a mismatched or unresolvable caller org: both legs guard one throwing if-condition`, () => {
        const body = functionBody(findTopLevelFunction(sf, meta.fn));
        const calls = collectCalls(body, sf);
        expect(calls.some((c) => c.callee === "isAdminFromEvent")).toBe(true);
        expect(calls.some((c) => c.callee === "extractOrgFromEvent")).toBe(
          true,
        );
        let legsFound = 0;
        const visit = (n: ts.Node): void => {
          if (ts.isIfStatement(n) && containsThrow(n.thenStatement)) {
            const cond = n.expression.getText(sf);
            const hasMissingCaller = /!\s*callerOrgId/.test(cond);
            const hasMismatch = /callerOrgId\s*!==\s*input\.orgId/.test(cond);
            if (hasMissingCaller && hasMismatch) {
              legsFound = 2;
            }
          }
          n.forEachChild(visit);
        };
        visit(body);
        expect(legsFound).toBe(2);
      });

      test(`${meta.fn}'s org gate precedes its first direct side-effect call (bite: ordering)`, () => {
        const body = functionBody(findTopLevelFunction(sf, meta.fn));
        const calls = collectCalls(body, sf);
        const gates = calls.filter((c) => c.callee === "isAdminFromEvent");
        const effects = calls.filter((c) =>
          SIDE_EFFECT_CALLEES.includes(c.callee),
        );
        expect(gates.length).toBeGreaterThanOrEqual(1);
        expect(effects.length).toBeGreaterThanOrEqual(1);
        expect(Math.min(...gates.map((c) => c.start))).toBeLessThan(
          Math.min(...effects.map((c) => c.start)),
        );
      });
    },
  );
});
