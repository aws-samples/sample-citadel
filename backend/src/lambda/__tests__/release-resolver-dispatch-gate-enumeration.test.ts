/**
 * Enumeration-completeness guard for release-resolver.ts's dispatch switch
 * (finding 25bb4af6 wave — release-surface guards). Modeled on
 * eval-run-resolver-dispatch-gate-enumeration.test.ts via the shared AST
 * helpers (fixtures/dispatch-gate-ast-helpers.ts): the case list is derived
 * from the handler's REAL `switch (fieldName)`, so a future op added
 * without a classification here fails LOUDLY.
 *
 * cutAgentRelease is the single op. Its gates, all asserted structurally:
 *  - the dispatch case derives callerOrgId via extractOrgFromEvent and
 *    fails closed (throw) when unresolvable, then threads callerOrgId into
 *    cutAgentRelease;
 *  - cutAgentRelease calls requireReleaseCutPermission BEFORE its
 *    putRelease write (bite assertion: source-position ordering);
 *  - the persisted release's `orgId:` is the server-derived `callerOrgId`,
 *    never caller-supplied input (collectPropertyAssignments).
 */
import * as fs from "fs";
import * as path from "path";
import * as ts from "typescript";
import {
  callReceivesIdentifier,
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

const HANDLER_PATH = path.join(__dirname, "..", "release-resolver.ts");

const GATED_OPS: Record<string, { fn: string; gate: string }> = {
  cutAgentRelease: {
    fn: "cutAgentRelease",
    gate: "release:cut permission + server-derived org on every evidence check",
  },
};

const EXEMPT_OPS: Record<string, string> = {};

describe("release-resolver — dispatch enumeration completeness", () => {
  const source = fs.readFileSync(HANDLER_PATH, "utf-8");
  const sf = parseSource(source, "release-resolver.ts");
  const handlerBody = findHandlerArrowBody(sf);
  const dispatch = extractDispatch(findDispatchSwitch(handlerBody));
  const caseNames = Array.from(dispatch.cases.keys());

  test("the dispatch switch actually has cases to check (sanity check on the parser itself)", () => {
    expect(caseNames.length).toBeGreaterThanOrEqual(1);
    expect(caseNames).toEqual(expect.arrayContaining(["cutAgentRelease"]));
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

  test("case 'cutAgentRelease' derives callerOrgId server-side, fails closed, and threads it into cutAgentRelease", () => {
    const clause = dispatch.cases.get("cutAgentRelease");
    expect(clause).toBeDefined();
    const calls = collectCalls(clause as ts.Node, sf);
    expect(calls.some((c) => c.callee === "extractOrgFromEvent")).toBe(true);
    // Fail-closed: `if (!callerOrgId) throw`.
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

    const target = calls.filter((c) => c.callee === "cutAgentRelease");
    expect(target.length).toBeGreaterThanOrEqual(1);
    expect(
      target.some((c) => callReceivesIdentifier(c.node, "callerOrgId")),
    ).toBe(true);
  });

  test("cutAgentRelease calls requireReleaseCutPermission BEFORE its putRelease write (bite: ordering)", () => {
    const fn = findTopLevelFunction(sf, "cutAgentRelease");
    const calls = collectCalls(functionBody(fn), sf);
    const gates = calls.filter(
      (c) => c.callee === "requireReleaseCutPermission",
    );
    const writes = calls.filter((c) => c.callee === "putRelease");
    expect(gates.length).toBeGreaterThanOrEqual(1);
    expect(writes.length).toBeGreaterThanOrEqual(1);
    expect(Math.min(...gates.map((c) => c.start))).toBeLessThan(
      Math.min(...writes.map((c) => c.start)),
    );
  });

  test("the persisted release's orgId is the server-derived callerOrgId, never caller input", () => {
    const fn = findTopLevelFunction(sf, "cutAgentRelease");
    const body = functionBody(fn);
    // Scope to the putRelease call's argument to avoid matching unrelated
    // orgId property reads elsewhere in the function.
    const putCall = collectCalls(body, sf).find(
      (c) => c.callee === "putRelease",
    );
    expect(putCall).toBeDefined();
    const assignments = collectPropertyAssignments(putCall!.node, "orgId", sf);
    expect(assignments).toEqual(["callerOrgId"]);
  });

  test("cutAgentRelease cross-checks every pinned evidence row's org against callerOrgId (registry record, exec spec, eval run, eval suite)", () => {
    const fn = findTopLevelFunction(sf, "cutAgentRelease");
    const body = functionBody(fn);
    // Each evidence source must be compared against callerOrgId with a
    // strict inequality that throws — count the distinct comparisons.
    let comparisons = 0;
    const visit = (n: ts.Node): void => {
      if (
        ts.isBinaryExpression(n) &&
        n.operatorToken.kind === ts.SyntaxKind.ExclamationEqualsEqualsToken
      ) {
        const text = n.getText(sf);
        if (text.includes("callerOrgId")) {
          comparisons += 1;
        }
      }
      n.forEachChild(visit);
    };
    visit(body);
    expect(comparisons).toBeGreaterThanOrEqual(4);
  });
});
