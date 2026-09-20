/**
 * Enumeration-completeness guard for promotion-policy-resolver.ts's
 * dispatch switch (finding 25bb4af6). Modeled on
 * eval-run-resolver-dispatch-gate-enumeration.test.ts via the shared AST
 * helpers (fixtures/dispatch-gate-ast-helpers.ts).
 *
 * BOTH ops (the write AND the read) are admin-gated by doctrine (see the
 * resolver's module doc: this toggle controls the FLOOR every promotion
 * quality gate in the org evaluates against — a platform-wide
 * governance-policy decision, deliberately stricter than any release:*
 * permission). Asserted structurally:
 *  - each op's function body calls requireAdmin;
 *  - requireAdmin itself checks `roles.includes("admin")` and throws;
 *  - setPromotionPolicy's requireAdmin precedes its DynamoDB write (bite:
 *    source-position ordering vs docClient.send);
 *  - the persisted config's `updatedBy:` is the server-derived
 *    authContext.userId, never caller input.
 *
 * STRENGTHENED (decision c5c8429a): the handler's dispatch case for each
 * op now calls `requireCallerOrgMatches` (reconciling the client-supplied
 * `arguments.orgId` against the caller's server-derived org) BEFORE
 * delegating to `setPromotionPolicy`/`getPromotionPolicy` — i.e. before
 * either op's own read/write. This deliberately removes the prior
 * global-admin cross-org policy write.
 */
import * as fs from "fs";
import * as path from "path";
import * as ts from "typescript";
import {
  collectCalls,
  collectPropertyAssignments,
  containsThrow,
  extractDispatch,
  findDispatchSwitch,
  findHandlerArrowBody,
  findTopLevelFunction,
  functionBody,
  parseSource,
} from "./fixtures/dispatch-gate-ast-helpers";

const HANDLER_PATH = path.join(__dirname, "..", "promotion-policy-resolver.ts");

const GATED_OPS: Record<string, { fn: string; gate: string }> = {
  setPromotionPolicy: {
    fn: "setPromotionPolicy",
    gate: "admin-only write (requireAdmin)",
  },
  getPromotionPolicy: {
    fn: "getPromotionPolicy",
    gate: "admin-only read (requireAdmin)",
  },
};

const EXEMPT_OPS: Record<string, string> = {};

describe("promotion-policy-resolver — dispatch enumeration completeness", () => {
  const source = fs.readFileSync(HANDLER_PATH, "utf-8");
  const sf = parseSource(source, "promotion-policy-resolver.ts");
  const handlerBody = findHandlerArrowBody(sf);
  const dispatch = extractDispatch(findDispatchSwitch(handlerBody));
  const caseNames = Array.from(dispatch.cases.keys());

  test("the dispatch switch actually has cases to check (sanity check on the parser itself)", () => {
    expect(caseNames.length).toBeGreaterThanOrEqual(2);
    expect(caseNames).toEqual(
      expect.arrayContaining(["setPromotionPolicy", "getPromotionPolicy"]),
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
      test(`case '${fieldName}' dispatches to ${meta.fn} with the event-derived authContext`, () => {
        const clause = dispatch.cases.get(fieldName);
        expect(clause).toBeDefined();
        const calls = collectCalls(clause as ts.Node, sf);
        const target = calls.filter((c) => c.callee === meta.fn);
        expect(target.length).toBeGreaterThanOrEqual(1);
        expect(
          target.some((c) =>
            c.node.arguments.some(
              (a) => ts.isIdentifier(a) && a.text === "authContext",
            ),
          ),
        ).toBe(true);
      });

      test(`${meta.fn}'s body calls requireAdmin`, () => {
        const body = functionBody(findTopLevelFunction(sf, meta.fn));
        const calls = collectCalls(body, sf);
        expect(calls.some((c) => c.callee === "requireAdmin")).toBe(true);
      });
    },
  );

  test("requireAdmin checks roles.includes('admin') and throws otherwise (the gate has teeth)", () => {
    const fn = findTopLevelFunction(sf, "requireAdmin");
    const body = functionBody(fn);
    // roles?.includes("admin") is a PropertyAccess chain on `roles`, so
    // collectCalls can't name it via a simple identifier receiver — assert
    // the includes call by walking for a call whose expression text ends
    // with `.includes` and whose argument is the "admin" literal.
    let checksAdmin = false;
    const visit = (n: ts.Node): void => {
      if (
        ts.isCallExpression(n) &&
        n.expression.getText(sf).endsWith(".includes") &&
        n.arguments.some((a) => ts.isStringLiteral(a) && a.text === "admin")
      ) {
        checksAdmin = true;
      }
      n.forEachChild(visit);
    };
    visit(body);
    expect(checksAdmin).toBe(true);
    expect(containsThrow(body)).toBe(true);
  });

  test("setPromotionPolicy's requireAdmin precedes its DynamoDB write (bite: ordering)", () => {
    const fn = findTopLevelFunction(sf, "setPromotionPolicy");
    const calls = collectCalls(functionBody(fn), sf);
    const gates = calls.filter((c) => c.callee === "requireAdmin");
    const sends = calls.filter((c) => c.callee === "docClient.send");
    expect(gates.length).toBeGreaterThanOrEqual(1);
    expect(sends.length).toBeGreaterThanOrEqual(1);
    expect(Math.min(...gates.map((c) => c.start))).toBeLessThan(
      Math.min(...sends.map((c) => c.start)),
    );
  });

  test("the persisted config's updatedBy is server-derived (authContext.userId), never caller input", () => {
    const fn = findTopLevelFunction(sf, "setPromotionPolicy");
    const assignments = collectPropertyAssignments(
      functionBody(fn),
      "updatedBy",
      sf,
    );
    expect(assignments).toEqual(["authContext.userId"]);
  });

  describe("org reconciliation (decision c5c8429a)", () => {
    test.each(Object.keys(GATED_OPS))(
      "the '%s' dispatch case calls requireCallerOrgMatches with the client-supplied orgId",
      (fieldName) => {
        const clause = dispatch.cases.get(fieldName);
        expect(clause).toBeDefined();
        const calls = collectCalls(clause as ts.Node, sf);
        const target = calls.filter(
          (c) => c.callee === "requireCallerOrgMatches",
        );
        expect(target.length).toBeGreaterThanOrEqual(1);
        // Second positional argument is the orgId being reconciled — must
        // be the caller-supplied event.arguments.orgId, not a hardcoded
        // or admin-overridable value.
        expect(
          target.some((c) =>
            c.node.arguments.some((a) =>
              a.getText(sf).includes("event.arguments.orgId"),
            ),
          ),
        ).toBe(true);
      },
    );

    test.each(Object.entries(GATED_OPS))(
      "the '%s' dispatch case's requireCallerOrgMatches precedes its delegation to %s (bite: before any read/write)",
      (fieldName, meta) => {
        const clause = dispatch.cases.get(fieldName);
        expect(clause).toBeDefined();
        const calls = collectCalls(clause as ts.Node, sf);
        const gates = calls.filter(
          (c) => c.callee === "requireCallerOrgMatches",
        );
        const delegations = calls.filter((c) => c.callee === meta.fn);
        expect(gates.length).toBeGreaterThanOrEqual(1);
        expect(delegations.length).toBeGreaterThanOrEqual(1);
        expect(Math.min(...gates.map((c) => c.start))).toBeLessThan(
          Math.min(...delegations.map((c) => c.start)),
        );
      },
    );

    test("requireCallerOrgMatches itself rejects on mismatch or an unresolvable caller org (the gate has teeth)", () => {
      const fn = findTopLevelFunction(sf, "requireCallerOrgMatches");
      const body = functionBody(fn);
      const calls = collectCalls(body, sf);
      expect(calls.some((c) => c.callee === "extractOrgFromEvent")).toBe(true);
      expect(containsThrow(body)).toBe(true);
      // Must compare the resolved caller org against the requested org
      // (not merely check truthiness) — a strict inequality on the two
      // identifiers is the structural signal that a mismatch is rejected.
      let comparesOrgs = false;
      const visit = (n: ts.Node): void => {
        if (
          ts.isBinaryExpression(n) &&
          n.operatorToken.kind === ts.SyntaxKind.ExclamationEqualsEqualsToken
        ) {
          const text = n.getText(sf);
          if (text.includes("callerOrgId") && text.includes("requestedOrgId")) {
            comparesOrgs = true;
          }
        }
        n.forEachChild(visit);
      };
      visit(body);
      expect(comparesOrgs).toBe(true);
    });
  });
});
