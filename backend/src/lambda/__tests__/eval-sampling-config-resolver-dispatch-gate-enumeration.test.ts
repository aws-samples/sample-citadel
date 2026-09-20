/**
 * Enumeration-completeness guard for eval-sampling-config-resolver.ts's
 * dispatch switch (finding 41c1cd9b — completes the dispatch
 * gate-enumeration family). Modeled on
 * model-config-resolver-dispatch-gate-enumeration.test.ts via the shared
 * AST helpers (fixtures/dispatch-gate-ast-helpers.ts).
 *
 * Classification — every op is GATED (admin): setEvalSamplingConfig /
 * getEvalSamplingConfig / listEvalProdSamples. This resolver is
 * deliberately ADMIN-ONLY (stricter than eval-resolver's
 * eval:author/eval:approve permissions — see the module doc): the
 * sampling toggle controls whether PII-sanitized-but-real production
 * conversations get captured and judged, a platform-wide data-handling
 * decision. Each delegate calls requireAdmin as its FIRST step, before
 * any docClient.send (bite: source-position ordering). requireAdmin
 * itself refuses unless the deriveRoles-derived roles include "admin"
 * (real if/throw, pinned below) — a failed identity parse yields no
 * roles → refusal (fail closed).
 *
 * There is no per-org reconciliation gate BY DESIGN: the callers are
 * platform admins acting across orgs (the orgId argument selects which
 * org's config/samples an admin is administering); non-admins cannot
 * reach any op at all.
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
  "eval-sampling-config-resolver.ts",
);

const GATED_OPS: Record<string, { fn: string }> = {
  setEvalSamplingConfig: { fn: "setEvalSamplingConfig" },
  getEvalSamplingConfig: { fn: "getEvalSamplingConfig" },
  listEvalProdSamples: { fn: "listEvalProdSamples" },
};

describe("eval-sampling-config-resolver — dispatch enumeration completeness", () => {
  const source = fs.readFileSync(HANDLER_PATH, "utf-8");
  const sf = parseSource(source, "eval-sampling-config-resolver.ts");
  const handlerBody = findHandlerArrowBody(sf);
  const dispatch = extractDispatch(findDispatchSwitch(handlerBody));
  const caseNames = Array.from(dispatch.cases.keys());

  test("the dispatch switch actually has cases to check (sanity check on the parser itself)", () => {
    expect(caseNames.length).toBeGreaterThanOrEqual(3);
    expect(caseNames).toEqual(
      expect.arrayContaining(["setEvalSamplingConfig", "listEvalProdSamples"]),
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
    "GATED_OPS['%s'] (admin-gated in the delegate)",
    (fieldName, meta) => {
      test(`case '${fieldName}' dispatches to ${meta.fn} and passes the derived authContext (the gate's input)`, () => {
        const clause = dispatch.cases.get(fieldName);
        expect(clause).toBeDefined();
        const calls = collectCalls(clause as ts.Node, sf);
        const target = calls.filter((c) => c.callee === meta.fn);
        expect(target.length).toBeGreaterThanOrEqual(1);
        expect(
          target.some((c) => callReceivesIdentifier(c.node, "authContext")),
        ).toBe(true);
      });

      test(`${meta.fn} calls requireAdmin(authContext, ...)`, () => {
        const body = functionBody(findTopLevelFunction(sf, meta.fn));
        const calls = collectCalls(body, sf);
        const gates = calls.filter((c) => c.callee === "requireAdmin");
        expect(gates.length).toBeGreaterThanOrEqual(1);
        expect(
          gates.some((c) => callReceivesIdentifier(c.node, "authContext")),
        ).toBe(true);
      });

      test(`${meta.fn}'s requireAdmin gate precedes its first docClient.send (bite: ordering)`, () => {
        const body = functionBody(findTopLevelFunction(sf, meta.fn));
        const calls = collectCalls(body, sf);
        const gates = calls.filter((c) => c.callee === "requireAdmin");
        const effects = calls.filter((c) => c.callee === "docClient.send");
        expect(gates.length).toBeGreaterThanOrEqual(1);
        expect(effects.length).toBeGreaterThanOrEqual(1);
        expect(Math.min(...gates.map((c) => c.start))).toBeLessThan(
          Math.min(...effects.map((c) => c.start)),
        );
      });
    },
  );
});
