/**
 * Enumeration-completeness guard for tool-approval-resolver.ts's dispatch
 * (finding c947aa77's resolver; guard added in the 25bb4af6/3c67ccc6 wave).
 * Modeled on eval-run-resolver-dispatch-gate-enumeration.test.ts via the
 * shared AST helpers (fixtures/dispatch-gate-ast-helpers.ts).
 *
 * Like task-runner-resolver, this handler dispatches via a fieldName
 * comparison rather than a switch: `if (fieldName !== "decideToolApproval")
 * throw`. The dispatch surface is derived from the REAL comparisons of
 * `fieldName` against string literals (collectFieldNameComparisons), so a
 * new field added to this handler without a classification here fails
 * LOUDLY.
 *
 * decideToolApproval's three server-side governance controls, all asserted
 * structurally (see the resolver's module doc):
 *  1. PERMISSION — hasPermission(authContext, "tool:approve") with the
 *     exact literal, throwing when absent;
 *  2. ORG MATCH — a caller-supplied input.orgId differing from the
 *     server-derived callerOrgId is REJECTED (cross-org grant attempt);
 *  3. SERVER-DERIVED PERSISTENCE — the persisted grant's `orgId:` is
 *     ALWAYS callerOrgId and `decidedBy:` is ALWAYS authContext.userId,
 *     never caller input.
 * Plus the handler-level fail-closed org derivation (extractOrgFromEvent →
 * throw when unresolvable) and the bite: both gates precede the
 * writeToolApprovalGrant side effect.
 */
import * as fs from "fs";
import * as path from "path";
import * as ts from "typescript";
import {
  callReceivesIdentifier,
  callReceivesStringLiteral,
  collectCalls,
  collectFieldNameComparisons,
  collectPropertyAssignments,
  containsThrow,
  findHandlerArrowBody,
  findTopLevelFunction,
  functionBody,
  parseSource,
} from "./fixtures/dispatch-gate-ast-helpers";

const HANDLER_PATH = path.join(__dirname, "..", "tool-approval-resolver.ts");

const GATED_OPS: Record<string, { fn: string; gate: string }> = {
  decideToolApproval: {
    fn: "decideToolApproval",
    gate: "tool:approve permission + org-match rejection + server-derived persistence",
  },
};

const EXEMPT_OPS: Record<string, string> = {};

describe("tool-approval-resolver — dispatch enumeration completeness", () => {
  const source = fs.readFileSync(HANDLER_PATH, "utf-8");
  const sf = parseSource(source, "tool-approval-resolver.ts");
  const handlerBody = findHandlerArrowBody(sf);
  const comparisons = collectFieldNameComparisons(handlerBody);
  const fieldNames = Array.from(new Set(comparisons.map((c) => c.literal)));

  test("the dispatch comparison surface actually has fields to check (sanity check on the parser itself)", () => {
    expect(fieldNames.length).toBeGreaterThanOrEqual(1);
    expect(fieldNames).toContain("decideToolApproval");
  });

  test("every dispatched field is accounted for in GATED_OPS or EXEMPT_OPS", () => {
    const unaccounted = fieldNames.filter(
      (c) => !(c in GATED_OPS) && !(c in EXEMPT_OPS),
    );
    expect(unaccounted).toEqual([]);
  });

  test("no classification entry references a field that no longer exists in the dispatch", () => {
    const known = new Set(fieldNames);
    const stale = [
      ...Object.keys(GATED_OPS),
      ...Object.keys(EXEMPT_OPS),
    ].filter((k) => !known.has(k));
    expect(stale).toEqual([]);
  });

  test("the classification tables jointly cover exactly the dispatch surface", () => {
    const claimed =
      Object.keys(GATED_OPS).length + Object.keys(EXEMPT_OPS).length;
    expect(claimed).toBe(fieldNames.length);
  });

  test("an unknown field fails closed: the !== comparison guards a throw", () => {
    const rejecting = comparisons.find(
      (c) => c.literal === "decideToolApproval" && c.operator === "!==",
    );
    expect(rejecting).toBeDefined();
    // The comparison's enclosing if-statement must throw.
    let parent: ts.Node | undefined = rejecting!.node.parent;
    while (parent && !ts.isIfStatement(parent)) {
      parent = parent.parent;
    }
    expect(parent).toBeDefined();
    expect(containsThrow((parent as ts.IfStatement).thenStatement)).toBe(true);
  });

  test("the handler derives callerOrgId via extractOrgFromEvent and fails closed when unresolvable", () => {
    const calls = collectCalls(handlerBody, sf);
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
    visit(handlerBody);
    expect(failClosed).toBe(true);
  });

  test("the handler threads callerOrgId into decideToolApproval", () => {
    const calls = collectCalls(handlerBody, sf);
    const target = calls.filter((c) => c.callee === "decideToolApproval");
    expect(target.length).toBeGreaterThanOrEqual(1);
    expect(
      target.some((c) => callReceivesIdentifier(c.node, "callerOrgId")),
    ).toBe(true);
  });

  test("decideToolApproval requires the tool:approve permission (exact literal) and throws without it", () => {
    const fn = findTopLevelFunction(sf, "decideToolApproval");
    const body = functionBody(fn);
    const calls = collectCalls(body, sf);
    const perm = calls.filter((c) => c.callee === "hasPermission");
    expect(perm.length).toBeGreaterThanOrEqual(1);
    expect(
      perm.some((c) => callReceivesStringLiteral(c.node, "tool:approve")),
    ).toBe(true);
    expect(containsThrow(body)).toBe(true);
  });

  test("decideToolApproval rejects a caller-supplied input.orgId that differs from callerOrgId (cross-org grant attempt)", () => {
    const fn = findTopLevelFunction(sf, "decideToolApproval");
    const body = functionBody(fn);
    let rejectsMismatch = false;
    const visit = (n: ts.Node): void => {
      if (
        ts.isBinaryExpression(n) &&
        n.operatorToken.kind === ts.SyntaxKind.ExclamationEqualsEqualsToken
      ) {
        const text = n.getText(sf);
        if (text.includes("input.orgId") && text.includes("callerOrgId")) {
          // Find the enclosing if and confirm it throws.
          let parent: ts.Node | undefined = n.parent;
          while (parent && !ts.isIfStatement(parent)) {
            parent = parent.parent;
          }
          if (
            parent &&
            containsThrow((parent as ts.IfStatement).thenStatement)
          ) {
            rejectsMismatch = true;
          }
        }
      }
      n.forEachChild(visit);
    };
    visit(body);
    expect(rejectsMismatch).toBe(true);
  });

  test("the persisted grant's orgId is server-derived callerOrgId and decidedBy is authContext.userId — never caller input", () => {
    const fn = findTopLevelFunction(sf, "decideToolApproval");
    const body = functionBody(fn);
    const orgAssignments = collectPropertyAssignments(body, "orgId", sf);
    expect(orgAssignments).toContain("callerOrgId");
    expect(orgAssignments).not.toContain("input.orgId");
    const decidedByAssignments = collectPropertyAssignments(
      body,
      "decidedBy",
      sf,
    );
    expect(decidedByAssignments).toContain("authContext.userId");
  });

  test("both gates precede the writeToolApprovalGrant side effect (bite: ordering)", () => {
    const fn = findTopLevelFunction(sf, "decideToolApproval");
    const body = functionBody(fn);
    const calls = collectCalls(body, sf);
    const perm = calls.filter((c) => c.callee === "hasPermission");
    const writes = calls.filter((c) => c.callee === "writeToolApprovalGrant");
    expect(perm.length).toBeGreaterThanOrEqual(1);
    expect(writes.length).toBeGreaterThanOrEqual(1);
    const firstWrite = Math.min(...writes.map((c) => c.start));
    expect(Math.min(...perm.map((c) => c.start))).toBeLessThan(firstWrite);
    // The org-mismatch rejection must also precede the write.
    let mismatchStart = -1;
    const visit = (n: ts.Node): void => {
      if (
        mismatchStart === -1 &&
        ts.isBinaryExpression(n) &&
        n.operatorToken.kind === ts.SyntaxKind.ExclamationEqualsEqualsToken &&
        n.getText(sf).includes("input.orgId")
      ) {
        mismatchStart = n.getStart(sf);
      }
      n.forEachChild(visit);
    };
    visit(body);
    expect(mismatchStart).toBeGreaterThan(-1);
    expect(mismatchStart).toBeLessThan(firstWrite);
  });
});
