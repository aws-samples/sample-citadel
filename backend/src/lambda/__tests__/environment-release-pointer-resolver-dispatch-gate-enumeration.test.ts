/**
 * Enumeration-completeness guard for
 * environment-release-pointer-resolver.ts's dispatch switch (finding
 * 25bb4af6 wave — release-surface guards). Modeled on
 * eval-run-resolver-dispatch-gate-enumeration.test.ts via the shared AST
 * helpers (fixtures/dispatch-gate-ast-helpers.ts): the case list is derived
 * from the handler's REAL `switch (fieldName)`, so a future op added
 * without a classification here fails LOUDLY.
 *
 * Every case (writes AND reads) derives callerOrgId server-side in its own
 * case body via extractOrgFromEvent and fails closed when unresolvable —
 * asserted per-case. Write ops additionally carry a permission gate inside
 * their delegate function:
 *  - promoteEnvironmentReleasePointer → requireReleasePromotePermission
 *  - startCanary / reweightCanary / abortCanary →
 *    requireReleaseCanaryPermission
 *  - promoteCanary → BOTH requireReleaseCanaryPermission AND
 *    requireReleasePromotePermission (decision D6: a canary→100% cutover is
 *    a promotion; dropping either gate is a regression this guard bites on,
 *    including ordering: both gates precede the pointer write).
 * Read ops (getCurrentEnvironmentReleasePointer /
 * listEnvironmentReleasePointers / environmentReleasePointerHistory) are
 * ORG-RECONCILED: no extra permission by precedent (org-membership-scoped
 * reads — see the resolver's module doc), but the case must thread the
 * server-derived callerOrgId as the query's org key.
 */
import * as fs from "fs";
import * as path from "path";
import * as ts from "typescript";
import {
  callReceivesIdentifier,
  collectCalls,
  containsThrow,
  extractDispatch,
  findDispatchSwitch,
  findHandlerArrowBody,
  findTopLevelFunction,
  functionBody,
  parseSource,
} from "./fixtures/dispatch-gate-ast-helpers";

const HANDLER_PATH = path.join(
  __dirname,
  "..",
  "environment-release-pointer-resolver.ts",
);

type GateKind =
  | "promote-permission"
  | "canary-permission"
  | "canary+promote-permission"
  | "org-scoped-read";

const GATED_OPS: Record<string, { fn: string; gate: GateKind }> = {
  promoteEnvironmentReleasePointer: {
    fn: "promoteEnvironmentReleasePointer",
    gate: "promote-permission",
  },
  startCanary: { fn: "startCanary", gate: "canary-permission" },
  reweightCanary: { fn: "reweightCanary", gate: "canary-permission" },
  promoteCanary: { fn: "promoteCanary", gate: "canary+promote-permission" },
  abortCanary: { fn: "abortCanary", gate: "canary-permission" },
  getCurrentEnvironmentReleasePointer: {
    fn: "getCurrentEnvironmentReleasePointer",
    gate: "org-scoped-read",
  },
  listEnvironmentReleasePointers: {
    fn: "listEnvironmentReleasePointers",
    gate: "org-scoped-read",
  },
  environmentReleasePointerHistory: {
    fn: "getEnvironmentReleasePointerHistory",
    gate: "org-scoped-read",
  },
};

const EXEMPT_OPS: Record<string, string> = {};

/** The permission-gate call names each GateKind requires inside the
 * delegate function's body. */
const REQUIRED_PERMISSION_CALLS: Record<GateKind, string[]> = {
  "promote-permission": ["requireReleasePromotePermission"],
  "canary-permission": ["requireReleaseCanaryPermission"],
  "canary+promote-permission": [
    "requireReleaseCanaryPermission",
    "requireReleasePromotePermission",
  ],
  "org-scoped-read": [],
};

describe("environment-release-pointer-resolver — dispatch enumeration completeness", () => {
  const source = fs.readFileSync(HANDLER_PATH, "utf-8");
  const sf = parseSource(source, "environment-release-pointer-resolver.ts");
  const handlerBody = findHandlerArrowBody(sf);
  const dispatch = extractDispatch(findDispatchSwitch(handlerBody));
  const caseNames = Array.from(dispatch.cases.keys());

  test("the dispatch switch actually has cases to check (sanity check on the parser itself)", () => {
    expect(caseNames.length).toBeGreaterThanOrEqual(8);
    expect(caseNames).toEqual(
      expect.arrayContaining([
        "promoteEnvironmentReleasePointer",
        "promoteCanary",
        "getCurrentEnvironmentReleasePointer",
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
      test(`case '${fieldName}' derives callerOrgId via extractOrgFromEvent and fails closed when unresolvable`, () => {
        const clause = dispatch.cases.get(fieldName);
        expect(clause).toBeDefined();
        const calls = collectCalls(clause as ts.Node, sf);
        expect(calls.some((c) => c.callee === "extractOrgFromEvent")).toBe(
          true,
        );
        let failClosed = false;
        const visit = (n: ts.Node): void => {
          if (
            ts.isIfStatement(n) &&
            ts.isPrefixUnaryExpression(n.expression) &&
            n.expression.operator === ts.SyntaxKind.ExclamationToken &&
            ts.isIdentifier(n.expression.operand) &&
            n.expression.operand.text === "callerOrgId" &&
            containsThrow(n.thenStatement)
          ) {
            failClosed = true;
          }
          n.forEachChild(visit);
        };
        visit(clause as ts.Node);
        expect(failClosed).toBe(true);
      });

      test(`case '${fieldName}' threads callerOrgId into ${meta.fn}`, () => {
        const clause = dispatch.cases.get(fieldName);
        const calls = collectCalls(clause as ts.Node, sf);
        const target = calls.filter((c) => c.callee === meta.fn);
        expect(target.length).toBeGreaterThanOrEqual(1);
        expect(
          target.some((c) => callReceivesIdentifier(c.node, "callerOrgId")),
        ).toBe(true);
      });

      const requiredGates = REQUIRED_PERMISSION_CALLS[meta.gate];
      if (requiredGates.length > 0) {
        test(`${meta.fn} carries permission gate(s): ${requiredGates.join(" + ")}`, () => {
          const body = functionBody(findTopLevelFunction(sf, meta.fn));
          const calls = collectCalls(body, sf);
          for (const gate of requiredGates) {
            expect(calls.some((c) => c.callee === gate)).toBe(true);
          }
        });
      }
    },
  );

  test("promoteCanary keeps BOTH gates and both precede the pointer write (bite: decision D6 ordering)", () => {
    const fn = findTopLevelFunction(sf, "promoteCanary");
    const calls = collectCalls(functionBody(fn), sf);
    const canaryGates = calls.filter(
      (c) => c.callee === "requireReleaseCanaryPermission",
    );
    const promoteGates = calls.filter(
      (c) => c.callee === "requireReleasePromotePermission",
    );
    const writes = calls.filter(
      (c) => c.callee === "setEnvironmentReleasePointer",
    );
    expect(canaryGates.length).toBeGreaterThanOrEqual(1);
    expect(promoteGates.length).toBeGreaterThanOrEqual(1);
    expect(writes.length).toBeGreaterThanOrEqual(1);
    const firstWrite = Math.min(...writes.map((c) => c.start));
    expect(Math.min(...canaryGates.map((c) => c.start))).toBeLessThan(
      firstWrite,
    );
    expect(Math.min(...promoteGates.map((c) => c.start))).toBeLessThan(
      firstWrite,
    );
  });

  test("promoteCanary rejects a cross-org candidate release (org comparison against callerOrgId that throws)", () => {
    const fn = findTopLevelFunction(sf, "promoteCanary");
    const body = functionBody(fn);
    let comparesOrg = false;
    const visit = (n: ts.Node): void => {
      if (
        ts.isIfStatement(n) &&
        ts.isBinaryExpression(n.expression) &&
        n.expression.operatorToken.kind ===
          ts.SyntaxKind.ExclamationEqualsEqualsToken &&
        n.expression.getText(sf).includes("callerOrgId") &&
        containsThrow(n.thenStatement)
      ) {
        comparesOrg = true;
      }
      n.forEachChild(visit);
    };
    visit(body);
    expect(comparesOrg).toBe(true);
  });
});
