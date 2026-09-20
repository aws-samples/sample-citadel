/**
 * Enumeration-completeness guard for organization-resolver.ts's dispatch
 * switch (finding 41c1cd9b — completes the dispatch gate-enumeration
 * family). Modeled on model-config-resolver-dispatch-gate-enumeration
 * .test.ts via the shared AST helpers
 * (fixtures/dispatch-gate-ast-helpers.ts).
 *
 * Classification — every op is GATED (admin): createOrganization /
 * deleteOrganization are platform-administration writes. The gate runs
 * IN THE CASE CLAUSE (requireAdmin on an authContext resolved inside the
 * try/case, per finding c79cd4f6, so a derivation exception surfaces as
 * a refusal, never as an unhandled crash mistaken for "allow") and the
 * delegate is only called after it. requireAdmin itself refuses unless
 * the derived roles include "admin" (real if/throw, pinned below);
 * deriveRoles-based derivation means a failed identity parse yields no
 * roles → refusal (fail closed).
 *
 * There is no org reconciliation here BY DESIGN: organizations are the
 * tenancy roots themselves — only platform admins may create or delete
 * them, and admin access is cross-org everywhere else in this codebase.
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

const HANDLER_PATH = path.join(__dirname, "..", "organization-resolver.ts");

const GATED_OPS: Record<string, { fn: string }> = {
  createOrganization: { fn: "createOrganization" },
  deleteOrganization: { fn: "deleteOrganization" },
};

describe("organization-resolver — dispatch enumeration completeness", () => {
  const source = fs.readFileSync(HANDLER_PATH, "utf-8");
  const sf = parseSource(source, "organization-resolver.ts");
  const handlerBody = findHandlerArrowBody(sf);
  const dispatch = extractDispatch(findDispatchSwitch(handlerBody));
  const caseNames = Array.from(dispatch.cases.keys());

  test("the dispatch switch actually has cases to check (sanity check on the parser itself)", () => {
    expect(caseNames.length).toBeGreaterThanOrEqual(2);
    expect(caseNames).toEqual(
      expect.arrayContaining(["createOrganization", "deleteOrganization"]),
    );
  });

  test("every dispatch case is accounted for in GATED_OPS", () => {
    const unaccounted = caseNames.filter((c) => !(c in GATED_OPS));
    expect(unaccounted).toEqual([]);
  });

  test("no classification entry references a case that no longer exists in the switch", () => {
    const known = new Set(caseNames);
    const stale = Object.keys(GATED_OPS).filter((k) => !known.has(k));
    expect(stale).toEqual([]);
  });

  test("the classification table covers exactly the dispatch surface", () => {
    expect(Object.keys(GATED_OPS).length).toBe(caseNames.length);
  });

  test("the dispatch default clause throws on unknown fields (fails closed)", () => {
    expect(dispatch.hasDefault).toBe(true);
    expect(containsThrow(dispatch.defaultClause as ts.Node)).toBe(true);
  });

  test("requireAdmin itself refuses unless roles include 'admin' (real if/throw, not prose)", () => {
    const body = functionBody(findTopLevelFunction(sf, "requireAdmin"));
    let failClosed = false;
    const visit = (n: ts.Node): void => {
      if (
        ts.isIfStatement(n) &&
        ts.isPrefixUnaryExpression(n.expression) &&
        n.expression.operator === ts.SyntaxKind.ExclamationToken &&
        /roles.*includes\(\s*"admin"\s*\)/.test(
          n.expression.operand.getText(sf),
        ) &&
        containsThrow(n.thenStatement)
      ) {
        failClosed = true;
      }
      n.forEachChild(visit);
    };
    visit(body);
    expect(failClosed).toBe(true);
  });

  describe.each(Object.entries(GATED_OPS))(
    "GATED_OPS['%s'] (admin-gated in the case clause)",
    (fieldName, meta) => {
      test(`case '${fieldName}' derives authContext from the event and calls requireAdmin(authContext, ...)`, () => {
        const clause = dispatch.cases.get(fieldName);
        expect(clause).toBeDefined();
        const calls = collectCalls(clause as ts.Node, sf);
        expect(calls.some((c) => c.callee === "authContextFromEvent")).toBe(
          true,
        );
        const gates = calls.filter((c) => c.callee === "requireAdmin");
        expect(gates.length).toBeGreaterThanOrEqual(1);
        expect(
          gates.some((c) => callReceivesIdentifier(c.node, "authContext")),
        ).toBe(true);
      });

      test(`the requireAdmin gate precedes the ${meta.fn} delegate call (bite: ordering)`, () => {
        const clause = dispatch.cases.get(fieldName);
        const calls = collectCalls(clause as ts.Node, sf);
        const gates = calls.filter((c) => c.callee === "requireAdmin");
        const targets = calls.filter((c) => c.callee === meta.fn);
        expect(gates.length).toBeGreaterThanOrEqual(1);
        expect(targets.length).toBeGreaterThanOrEqual(1);
        expect(Math.min(...gates.map((c) => c.start))).toBeLessThan(
          Math.min(...targets.map((c) => c.start)),
        );
      });
    },
  );
});
