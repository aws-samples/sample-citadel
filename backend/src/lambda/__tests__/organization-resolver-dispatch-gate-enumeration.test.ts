/**
 * Enumeration-completeness guard for organization-resolver.ts's dispatch
 * switch (finding 41c1cd9b — completes the dispatch gate-enumeration
 * family). Modeled on model-config-resolver-dispatch-gate-enumeration
 * .test.ts via the shared AST helpers
 * (fixtures/dispatch-gate-ast-helpers.ts).
 *
 * Classification — ops are either ADMIN_GATED (requireAdmin) or
 * MEMBER_GATED (org-membership check). createOrganization /
 * deleteOrganization / updateTagPolicy are platform-administration writes.
 * getTagPolicy is a member-gated read (any authenticated org member or
 * admin). The admin gates run IN THE CASE CLAUSE (requireAdmin on an
 * authContext resolved inside the try/case, per finding c79cd4f6, so a
 * derivation exception surfaces as a refusal, never as an unhandled crash
 * mistaken for "allow") and the delegate is only called after it.
 * requireAdmin itself refuses unless the derived roles include "admin"
 * (real if/throw, pinned below); deriveRoles-based derivation means a
 * failed identity parse yields no roles → refusal (fail closed).
 *
 * getTagPolicy delegates membership checking to the callee (getTagPolicy
 * function), which uses isAdminFromEvent + extractOrgFromEvent to verify
 * the caller is either admin or a member of the target org.
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

/** Admin-gated ops: requireAdmin is called in the dispatch case clause. */
const ADMIN_GATED_OPS: Record<string, { fn: string }> = {
  createOrganization: { fn: "createOrganization" },
  deleteOrganization: { fn: "deleteOrganization" },
  updateTagPolicy: { fn: "updateTagPolicy" },
};

/**
 * Member-gated ops: access control delegated to the callee (the callee
 * checks isAdminFromEvent + extractOrgFromEvent internally).
 */
const MEMBER_GATED_OPS: Record<string, { fn: string }> = {
  getTagPolicy: { fn: "getTagPolicy" },
};

/** All classified ops — union of admin-gated and member-gated. */
const ALL_OPS: Record<string, { fn: string }> = {
  ...ADMIN_GATED_OPS,
  ...MEMBER_GATED_OPS,
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

  test("every dispatch case is accounted for in the classification tables", () => {
    const unaccounted = caseNames.filter((c) => !(c in ALL_OPS));
    expect(unaccounted).toEqual([]);
  });

  test("no classification entry references a case that no longer exists in the switch", () => {
    const known = new Set(caseNames);
    const stale = Object.keys(ALL_OPS).filter((k) => !known.has(k));
    expect(stale).toEqual([]);
  });

  test("the classification tables cover exactly the dispatch surface", () => {
    expect(Object.keys(ALL_OPS).length).toBe(caseNames.length);
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

  describe.each(Object.entries(ADMIN_GATED_OPS))(
    "ADMIN_GATED_OPS['%s'] (admin-gated in the case clause)",
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

  describe.each(Object.entries(MEMBER_GATED_OPS))(
    "MEMBER_GATED_OPS['%s'] (member-gated, access control in callee)",
    (fieldName, meta) => {
      test(`case '${fieldName}' delegates to ${meta.fn}`, () => {
        const clause = dispatch.cases.get(fieldName);
        expect(clause).toBeDefined();
        const calls = collectCalls(clause as ts.Node, sf);
        const targets = calls.filter((c) => c.callee === meta.fn);
        expect(targets.length).toBeGreaterThanOrEqual(1);
      });
    },
  );
});
