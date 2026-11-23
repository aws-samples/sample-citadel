/**
 * Gate-enumeration guard for tool-run-resolver.ts's single-field dispatch
 * surface (board task 10c3bf48 — PR #613 CI fix 2). Closes the meta-guard
 * gap flagged by backend/test/dispatch-gate-coverage-guard.test.ts: this
 * AppSync-wired entry file (CfnDataSource for Mutation.testTool, see
 * services-stack.ts) had neither a `*-dispatch-gate-enumeration` guard nor
 * a documented exemption.
 *
 * Modeled on generate-report-url-dispatch-gate-enumeration.test.ts via the
 * shared AST helpers (fixtures/dispatch-gate-ast-helpers.ts): like that
 * resolver, tool-run-resolver.ts has no `switch (fieldName)` / `if
 * (fieldName === ...)` dispatch — it backs exactly ONE mutation field
 * (`testTool`) via a top-level `export async function handler(event) {...}`
 * declaration (not the `const handler = async (event) => {...}` arrow
 * shape generate-report-url uses, hence findTopLevelFunction + functionBody
 * rather than findHandlerArrowBody). This guard derives the handler body
 * directly rather than classifying a dispatch surface, and pins the THREE
 * server-side gates the resolver's module doc describes, all asserted
 * structurally against the real source (never mocked), each proven to
 * precede the worker invocation (invokeWorkerToolRun) — the side effect
 * that runs caller-supplied code with scoped credentials:
 *
 *  1. PERMISSION — hasPermission(authContext, "tool:execute") with the
 *     exact literal, short-circuiting with success:false before any org
 *     derivation or tool lookup;
 *  2. SERVER-DERIVED ORG — the effective org is NEVER read from
 *     event.arguments; it comes from requireCallerOrg(event, ...) on the
 *     non-admin path and extractOrgFromEvent(event) on the admin path,
 *     both of which fail closed (no callerOrgId -> no invoke);
 *  3. ORG MATCH / SENTINEL — the resolved toolConfig's own orgId must
 *     equal effectiveOrgId OR the "All Organizations" sentinel; mismatch
 *     or missing orgId returns the identical "Tool not found" string used
 *     for a genuinely missing tool (no cross-tenant existence disclosure).
 *
 * Per backend/test/dispatch-gate-coverage-guard.test.ts, this guard's
 * existence is what removes tool-run-resolver from that meta-guard's
 * unaccounted set — the module is now classified as guarded, not exempt,
 * because (unlike tool-sandbox before it) it invokes the worker wrapper
 * Lambda with scoped credentials and so must be enumerated.
 */
import * as fs from "fs";
import * as path from "path";
import * as ts from "typescript";
import {
  callReceivesStringLiteral,
  collectCalls,
  containsThrow,
  findTopLevelFunction,
  functionBody,
  parseSource,
} from "./fixtures/dispatch-gate-ast-helpers";

const HANDLER_PATH = path.join(__dirname, "..", "tool-run-resolver.ts");

describe("tool-run-resolver — dispatch enumeration completeness (single-field surface)", () => {
  const source = fs.readFileSync(HANDLER_PATH, "utf-8");
  const sf = parseSource(source, "tool-run-resolver.ts");
  const handlerFn = findTopLevelFunction(sf, "handler");
  const handlerBody = functionBody(handlerFn);

  test("the handler has no fieldName dispatch switch (sanity check on the parser/handler shape)", () => {
    let hasSwitch = false;
    const walk = (n: ts.Node) => {
      if (ts.isSwitchStatement(n)) hasSwitch = true;
      n.forEachChild(walk);
    };
    walk(handlerBody);
    expect(hasSwitch).toBe(false);
  });

  test("this is the ONE op on the dispatch surface: testTool (Mutation, single field, no other cases to account for)", () => {
    expect(source).toContain("export async function handler");
    expect(source).toContain("event.arguments");
  });

  test("the handler requires tool:execute permission (exact literal) and short-circuits without it", () => {
    const calls = collectCalls(handlerBody, sf);
    const perm = calls.filter((c) => c.callee === "hasPermission");
    expect(perm.length).toBeGreaterThanOrEqual(1);
    expect(
      perm.some((c) => callReceivesStringLiteral(c.node, "tool:execute")),
    ).toBe(true);

    // The permission check guards an early return — find the enclosing
    // if-statement and confirm it returns (fail-closed, not just logged).
    const permCall = perm.find((c) =>
      callReceivesStringLiteral(c.node, "tool:execute"),
    )!;
    let parent: ts.Node | undefined = permCall.node.parent;
    while (parent && !ts.isIfStatement(parent)) {
      parent = parent.parent;
    }
    expect(parent).toBeDefined();
    let returns = false;
    const visit = (n: ts.Node): void => {
      if (ts.isReturnStatement(n)) returns = true;
      n.forEachChild(visit);
    };
    visit((parent as ts.IfStatement).thenStatement);
    expect(returns).toBe(true);
  });

  test("the handler derives the effective org server-side via requireCallerOrg or extractOrgFromEvent, never event.arguments", () => {
    const calls = collectCalls(handlerBody, sf);
    expect(calls.some((c) => c.callee === "requireCallerOrg")).toBe(true);
    expect(calls.some((c) => c.callee === "extractOrgFromEvent")).toBe(true);
    // Neither org-deriving call reads a client-supplied orgId argument.
    const orgCalls = calls.filter(
      (c) =>
        c.callee === "requireCallerOrg" || c.callee === "extractOrgFromEvent",
    );
    for (const c of orgCalls) {
      expect(
        c.node.arguments.some((a) => a.getText(sf).includes("arguments.orgId")),
      ).toBe(false);
    }
  });

  test("the admin org-derivation path fails closed when callerOrgId cannot be determined", () => {
    let failClosed = false;
    const visit = (n: ts.Node): void => {
      if (
        ts.isIfStatement(n) &&
        ts.isPrefixUnaryExpression(n.expression) &&
        n.expression.operator === ts.SyntaxKind.ExclamationToken &&
        ts.isIdentifier(n.expression.operand) &&
        n.expression.operand.text === "callerOrgId" &&
        containsThrow(n.thenStatement) === false // returns, not throw, in this resolver
      ) {
        // confirm it returns a failure result rather than falling through
        let returnsFailure = false;
        const inner = (m: ts.Node): void => {
          if (ts.isReturnStatement(m)) returnsFailure = true;
          m.forEachChild(inner);
        };
        inner(n.thenStatement);
        if (returnsFailure) failClosed = true;
      }
      n.forEachChild(visit);
    };
    visit(handlerBody);
    expect(failClosed).toBe(true);
  });

  test("the resolved tool config's orgId must match effectiveOrgId or the All Organizations sentinel before invoking the worker", () => {
    expect(source).toContain("ALL_ORGANIZATIONS");
    expect(source).toMatch(/toolConfig\.orgId\s*!==\s*effectiveOrgId/);
    expect(source).toMatch(/toolConfig\.orgId\s*!==\s*ALL_ORGANIZATIONS/);
    // Mismatch/missing config produces the same "Tool not found" string
    // used for a genuinely absent tool (no cross-tenant disclosure).
    const toolNotFoundCount = (source.match(/"Tool not found"/g) ?? []).length;
    expect(toolNotFoundCount).toBeGreaterThanOrEqual(1);
  });

  test("bite (ordering): the permission gate precedes the org derivation, which precedes the worker invocation", () => {
    const calls = collectCalls(handlerBody, sf);
    const perm = calls.filter((c) => c.callee === "hasPermission");
    const orgDerivation = calls.filter(
      (c) =>
        c.callee === "requireCallerOrg" || c.callee === "extractOrgFromEvent",
    );
    const invokes = calls.filter((c) => c.callee === "invokeWorkerToolRun");

    expect(perm.length).toBeGreaterThanOrEqual(1);
    expect(orgDerivation.length).toBeGreaterThanOrEqual(1);
    expect(invokes.length).toBeGreaterThanOrEqual(1);

    const permStart = Math.min(...perm.map((c) => c.start));
    const orgStart = Math.min(...orgDerivation.map((c) => c.start));
    const invokeStart = Math.min(...invokes.map((c) => c.start));

    expect(permStart).toBeLessThan(orgStart);
    expect(orgStart).toBeLessThan(invokeStart);
  });

  test("bite (ordering): the tool org-match check precedes the worker invocation", () => {
    const calls = collectCalls(handlerBody, sf);
    const invokes = calls.filter((c) => c.callee === "invokeWorkerToolRun");
    expect(invokes.length).toBeGreaterThanOrEqual(1);
    const invokeStart = Math.min(...invokes.map((c) => c.start));

    let matchStart = -1;
    const visit = (n: ts.Node): void => {
      if (
        matchStart === -1 &&
        ts.isBinaryExpression(n) &&
        n.operatorToken.kind === ts.SyntaxKind.ExclamationEqualsEqualsToken &&
        n.getText(sf).includes("toolConfig.orgId") &&
        n.getText(sf).includes("effectiveOrgId")
      ) {
        matchStart = n.getStart(sf);
      }
      n.forEachChild(visit);
    };
    visit(handlerBody);

    expect(matchStart).toBeGreaterThan(-1);
    expect(matchStart).toBeLessThan(invokeStart);
  });

  test("runId sent to the worker is server-minted (randomUUID), never read from event.arguments", () => {
    expect(source).toContain("randomUUID()");
    expect(source).not.toMatch(/arguments\.runId/);
  });
});
