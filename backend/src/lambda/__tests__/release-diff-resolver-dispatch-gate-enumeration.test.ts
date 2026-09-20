/**
 * Enumeration-completeness guard for release-diff-resolver.ts's dispatch
 * switch (finding 25bb4af6 wave — release-surface guards). Modeled on
 * eval-run-resolver-dispatch-gate-enumeration.test.ts via the shared AST
 * helpers (fixtures/dispatch-gate-ast-helpers.ts).
 *
 * releaseDiff is the single op (read-only, org-scoped). Asserted
 * structurally:
 *  - the dispatch case derives callerOrgId via extractOrgFromEvent, fails
 *    closed when unresolvable, and threads callerOrgId into releaseDiff;
 *  - getOwnReleaseOrThrow rejects a cross-org release
 *    (release.orgId !== callerOrgId → CrossOrgReleaseDiffError);
 *  - the handler collapses BOTH ReleaseNotFoundError and
 *    CrossOrgReleaseDiffError into the single opaque
 *    OpaqueReleaseDiffNotFoundError (finding ce470ab0's existence-oracle
 *    closure) — a caller must not be able to distinguish "exists but not
 *    yours" from "does not exist".
 */
import * as fs from "fs";
import * as path from "path";
import * as ts from "typescript";
import {
  callReceivesIdentifier,
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

const HANDLER_PATH = path.join(__dirname, "..", "release-diff-resolver.ts");

const GATED_OPS: Record<string, { fn: string; gate: string }> = {
  releaseDiff: {
    fn: "releaseDiff",
    gate: "org-scoped read via getOwnReleaseOrThrow + opaque not-found collapse",
  },
};

const EXEMPT_OPS: Record<string, string> = {};

describe("release-diff-resolver — dispatch enumeration completeness", () => {
  const source = fs.readFileSync(HANDLER_PATH, "utf-8");
  const sf = parseSource(source, "release-diff-resolver.ts");
  const handlerBody = findHandlerArrowBody(sf);
  const dispatch = extractDispatch(findDispatchSwitch(handlerBody));
  const caseNames = Array.from(dispatch.cases.keys());

  test("the dispatch switch actually has cases to check (sanity check on the parser itself)", () => {
    expect(caseNames.length).toBeGreaterThanOrEqual(1);
    expect(caseNames).toEqual(expect.arrayContaining(["releaseDiff"]));
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

  test("case 'releaseDiff' derives callerOrgId server-side, fails closed, and threads it into releaseDiff", () => {
    const clause = dispatch.cases.get("releaseDiff");
    expect(clause).toBeDefined();
    const calls = collectCalls(clause as ts.Node, sf);
    expect(calls.some((c) => c.callee === "extractOrgFromEvent")).toBe(true);
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

    const target = calls.filter((c) => c.callee === "releaseDiff");
    expect(target.length).toBeGreaterThanOrEqual(1);
    expect(
      target.some((c) => callReceivesIdentifier(c.node, "callerOrgId")),
    ).toBe(true);
  });

  test("releaseDiff resolves both sides through getOwnReleaseOrThrow (the org gate)", () => {
    const fn = findTopLevelFunction(sf, "releaseDiff");
    const calls = collectCalls(functionBody(fn), sf);
    const gated = calls.filter((c) => c.callee === "getOwnReleaseOrThrow");
    expect(gated.length).toBeGreaterThanOrEqual(2);
    expect(
      gated.every((c) => callReceivesIdentifier(c.node, "callerOrgId")),
    ).toBe(true);
  });

  test("getOwnReleaseOrThrow rejects a cross-org release with CrossOrgReleaseDiffError", () => {
    const fn = findTopLevelFunction(sf, "getOwnReleaseOrThrow");
    const body = functionBody(fn);
    let rejectsCrossOrg = false;
    const visit = (n: ts.Node): void => {
      if (
        ts.isIfStatement(n) &&
        ts.isBinaryExpression(n.expression) &&
        n.expression.operatorToken.kind ===
          ts.SyntaxKind.ExclamationEqualsEqualsToken &&
        n.expression.getText(sf).includes("callerOrgId") &&
        containsThrow(n.thenStatement)
      ) {
        // The throw must construct CrossOrgReleaseDiffError specifically.
        const news = collectNews(n.thenStatement, sf);
        if (news.some((x) => x.className === "CrossOrgReleaseDiffError")) {
          rejectsCrossOrg = true;
        }
      }
      n.forEachChild(visit);
    };
    visit(body);
    expect(rejectsCrossOrg).toBe(true);
  });

  test("the handler collapses cross-org and missing into ONE opaque error (existence-oracle closure, finding ce470ab0)", () => {
    const clause = dispatch.cases.get("releaseDiff");
    expect(clause).toBeDefined();
    // The catch must reference both concrete error classes and re-throw the
    // opaque one — all as real AST nodes, not prose.
    const clauseText = (clause as ts.Node).getText(sf);
    expect(clauseText).toContain("ReleaseNotFoundError");
    expect(clauseText).toContain("CrossOrgReleaseDiffError");
    const news = collectNews(clause as ts.Node, sf);
    expect(
      news.some((x) => x.className === "OpaqueReleaseDiffNotFoundError"),
    ).toBe(true);
  });
});
