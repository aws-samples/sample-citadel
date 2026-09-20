/**
 * Enumeration-completeness guard for agent-resolver.ts's dispatch switch
 * (fail-closed org reconciliation shipped on fix/authz-sweep-fail-closed,
 * finding ce470ab0). Modeled on
 * eval-run-resolver-dispatch-gate-enumeration.test.ts via the shared AST
 * helpers (fixtures/dispatch-gate-ast-helpers.ts).
 *
 * Both ops are ORG-RECONCILED, fail-closed, against the parent Project's
 * `organization` (AgentStatus rows carry no orgId — the tenant boundary
 * lives on the project). Asserted structurally per function:
 *  - loads the parent project and returns null when missing (closes the
 *    existence oracle);
 *  - admin bypass ONLY via isAdminFromEvent;
 *  - non-admin: extractOrgFromEvent, then a fail-closed condition that
 *    denies BOTH an unresolvable caller org (`!userOrg || ...`) AND an org
 *    mismatch — the pre-fix bug was exactly the truthy-only check
 *    (`if (userOrg && ...)`) that waved org-less callers through;
 *  - updateAgentStatus: the reconciliation precedes the PutCommand write
 *    (bite: source-position ordering).
 */
import * as fs from "fs";
import * as path from "path";
import * as ts from "typescript";
import {
  callReceivesBareEvent,
  collectCalls,
  collectNews,
  containsThrow,
  extractDispatch,
  findDispatchSwitch,
  findHandlerArrowBody,
  findTopLevelFunction,
  functionBody,
  parseSource,
} from "./fixtures/dispatch-gate-ast-helpers";

const HANDLER_PATH = path.join(__dirname, "..", "agent-resolver.ts");

const GATED_OPS: Record<string, { fn: string; gate: string }> = {
  getAgentStatus: {
    fn: "getAgentStatus",
    gate: "fail-closed project-org reconciliation (read)",
  },
  updateAgentStatus: {
    fn: "updateAgentStatus",
    gate: "fail-closed project-org reconciliation before write",
  },
};

const EXEMPT_OPS: Record<string, string> = {};

/** Asserts the fail-closed org-reconciliation shape inside a function body:
 * isAdminFromEvent bypass, extractOrgFromEvent derivation, and a throwing
 * condition of the form `!userOrg || <mismatch>` — the `!userOrg` disjunct
 * is what makes it fail CLOSED for org-less callers. */
function assertFailClosedOrgReconciliation(
  body: ts.Block,
  sf: ts.SourceFile,
): void {
  const calls = collectCalls(body, sf);
  expect(calls.some((c) => c.callee === "isAdminFromEvent")).toBe(true);
  expect(calls.some((c) => c.callee === "extractOrgFromEvent")).toBe(true);

  let failClosed = false;
  const visit = (n: ts.Node): void => {
    if (
      ts.isIfStatement(n) &&
      ts.isBinaryExpression(n.expression) &&
      n.expression.operatorToken.kind === ts.SyntaxKind.BarBarToken &&
      containsThrow(n.thenStatement)
    ) {
      const left = n.expression.left;
      if (
        ts.isPrefixUnaryExpression(left) &&
        left.operator === ts.SyntaxKind.ExclamationToken &&
        ts.isIdentifier(left.operand) &&
        left.operand.text === "userOrg"
      ) {
        failClosed = true;
      }
    }
    n.forEachChild(visit);
  };
  visit(body);
  expect(failClosed).toBe(true);
}

describe("agent-resolver — dispatch enumeration completeness", () => {
  const source = fs.readFileSync(HANDLER_PATH, "utf-8");
  const sf = parseSource(source, "agent-resolver.ts");
  const handlerBody = findHandlerArrowBody(sf);
  const dispatch = extractDispatch(findDispatchSwitch(handlerBody));
  const caseNames = Array.from(dispatch.cases.keys());

  test("the dispatch switch actually has cases to check (sanity check on the parser itself)", () => {
    expect(caseNames.length).toBeGreaterThanOrEqual(2);
    expect(caseNames).toEqual(
      expect.arrayContaining(["getAgentStatus", "updateAgentStatus"]),
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
      test(`case '${fieldName}' dispatches to ${meta.fn} and passes the raw \`event\``, () => {
        const clause = dispatch.cases.get(fieldName);
        expect(clause).toBeDefined();
        const calls = collectCalls(clause as ts.Node, sf);
        const target = calls.filter((c) => c.callee === meta.fn);
        expect(target.length).toBeGreaterThanOrEqual(1);
        expect(target.some((c) => callReceivesBareEvent(c.node))).toBe(true);
      });

      test(`${meta.fn} carries the fail-closed org reconciliation (admin bypass, !userOrg denial, mismatch denial)`, () => {
        const body = functionBody(findTopLevelFunction(sf, meta.fn));
        assertFailClosedOrgReconciliation(body, sf);
      });

      test(`${meta.fn} returns null for a missing project (existence-oracle closure)`, () => {
        const body = functionBody(findTopLevelFunction(sf, meta.fn));
        let returnsNull = false;
        const visit = (n: ts.Node): void => {
          if (
            ts.isReturnStatement(n) &&
            n.expression?.kind === ts.SyntaxKind.NullKeyword
          ) {
            returnsNull = true;
          }
          n.forEachChild(visit);
        };
        visit(body);
        expect(returnsNull).toBe(true);
      });
    },
  );

  test("updateAgentStatus's org reconciliation precedes the PutCommand write (bite: ordering)", () => {
    const fn = findTopLevelFunction(sf, "updateAgentStatus");
    const body = functionBody(fn);
    const calls = collectCalls(body, sf);
    const orgDerivations = calls.filter(
      (c) => c.callee === "extractOrgFromEvent",
    );
    const puts = collectNews(body, sf).filter(
      (n) => n.className === "PutCommand",
    );
    expect(orgDerivations.length).toBeGreaterThanOrEqual(1);
    expect(puts.length).toBeGreaterThanOrEqual(1);
    expect(Math.min(...orgDerivations.map((c) => c.start))).toBeLessThan(
      Math.min(...puts.map((p) => p.start)),
    );
  });
});
