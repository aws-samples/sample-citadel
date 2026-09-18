/**
 * Enumeration-completeness guard for eval-resolver.ts's dispatch switch
 * (Wave-3A ITEM4, board task a6ff10ff). Modeled on
 * governance-ui-resolver-dispatch-gate-enumeration.test.ts: derives the
 * operation list from the handler's ACTUAL `switch (fieldName)` dispatch
 * (never a hand-maintained array) and requires every case be classified as
 * either a write (org-derived-write: stamps/verifies caller org before any
 * mutation) or a read (by-id via canCallerSeeRow return-null, or
 * list-by-org via resolveScopedOrgFromEvent).
 *
 * AST, not string matching: text matching is defeated by a token appearing
 * in a comment or string literal (repo lesson, cross-referenced in the
 * governance-ui guard). This file's own docstring above `assertSuiteMutable`
 * names `canCallerSeeRow`/`resolveScopedOrgFromEvent` in prose, so a naive
 * text search would over-count; a synthetic-snippet test below proves the
 * AST helpers are immune.
 */
import * as fs from "fs";
import * as path from "path";
import * as ts from "typescript";

const HANDLER_PATH = path.join(__dirname, "..", "eval-resolver.ts");

function parseSource(source: string, fileName: string): ts.SourceFile {
  return ts.createSourceFile(
    fileName,
    source,
    ts.ScriptTarget.Latest,
    /* setParentNodes */ true,
    ts.ScriptKind.TS,
  );
}

function walk(node: ts.Node, cb: (n: ts.Node) => void): void {
  cb(node);
  node.forEachChild((child) => walk(child, cb));
}

function findTopLevelFunction(
  sf: ts.SourceFile,
  name: string,
): ts.FunctionDeclaration {
  let found: ts.FunctionDeclaration | undefined;
  sf.forEachChild((node) => {
    if (ts.isFunctionDeclaration(node) && node.name?.text === name) {
      found = node;
    }
  });
  if (!found) {
    throw new Error(
      `Could not locate top-level function declaration '${name}' in ` +
        "eval-resolver.ts — structure changed; update this guard.",
    );
  }
  return found;
}

/**
 * `handler` is declared as `export const handler = async (event) => {...}`
 * (an arrow function assigned to a const), not a FunctionDeclaration —
 * unlike every other exported operation function in this module. This
 * locates its body via the VariableStatement/ArrowFunction shape.
 */
function findHandlerArrowBody(sf: ts.SourceFile): ts.Block {
  let found: ts.Block | undefined;
  sf.forEachChild((node) => {
    if (!ts.isVariableStatement(node)) return;
    for (const decl of node.declarationList.declarations) {
      if (
        ts.isIdentifier(decl.name) &&
        decl.name.text === "handler" &&
        decl.initializer &&
        ts.isArrowFunction(decl.initializer) &&
        ts.isBlock(decl.initializer.body)
      ) {
        found = decl.initializer.body;
      }
    }
  });
  if (!found) {
    throw new Error(
      "Could not locate `export const handler = async (event) => {...}` — " +
        "structure changed; update this guard's parsing.",
    );
  }
  return found;
}

function functionBody(fn: ts.FunctionDeclaration): ts.Block {
  if (!fn.body) {
    throw new Error(
      `Function '${fn.name?.text ?? "<anonymous>"}' has no body — ` +
        "update this guard.",
    );
  }
  return fn.body;
}

interface CallSite {
  callee: string;
  start: number;
  node: ts.CallExpression;
}

function collectCalls(root: ts.Node, sf: ts.SourceFile): CallSite[] {
  const out: CallSite[] = [];
  walk(root, (n) => {
    if (!ts.isCallExpression(n)) return;
    const ex = n.expression;
    let callee: string | null = null;
    if (ts.isIdentifier(ex)) {
      callee = ex.text;
    } else if (
      ts.isPropertyAccessExpression(ex) &&
      ts.isIdentifier(ex.expression)
    ) {
      callee = `${ex.expression.text}.${ex.name.text}`;
    }
    if (callee !== null) {
      out.push({ callee, start: n.getStart(sf), node: n });
    }
  });
  return out;
}

function unwrapExpression(node: ts.Expression): ts.Expression {
  let current: ts.Expression = node;
  for (;;) {
    if (
      ts.isParenthesizedExpression(current) ||
      ts.isAsExpression(current) ||
      ts.isNonNullExpression(current) ||
      ts.isSatisfiesExpression(current)
    ) {
      current = current.expression;
    } else {
      return current;
    }
  }
}

function callReceivesBareEvent(call: ts.CallExpression): boolean {
  return call.arguments.some((arg) => {
    const core = unwrapExpression(arg);
    return ts.isIdentifier(core) && core.text === "event";
  });
}

function findDispatchSwitch(handlerBody: ts.Block): ts.SwitchStatement {
  let sw: ts.SwitchStatement | undefined;
  walk(handlerBody, (n) => {
    if (
      !sw &&
      ts.isSwitchStatement(n) &&
      ts.isIdentifier(n.expression) &&
      n.expression.text === "fieldName"
    ) {
      sw = n;
    }
  });
  if (!sw) {
    throw new Error(
      "Could not locate `switch (fieldName)` inside handler() — dispatch " +
        "structure changed; update this guard's parsing.",
    );
  }
  return sw;
}

interface DispatchInfo {
  cases: Map<string, ts.CaseClause>;
  hasDefault: boolean;
  defaultClause: ts.DefaultClause | null;
}

function extractDispatch(sw: ts.SwitchStatement): DispatchInfo {
  const cases = new Map<string, ts.CaseClause>();
  let hasDefault = false;
  let defaultClause: ts.DefaultClause | null = null;
  for (const clause of sw.caseBlock.clauses) {
    if (ts.isCaseClause(clause)) {
      if (!ts.isStringLiteral(clause.expression)) {
        throw new Error(
          "Dispatch switch contains a non-string-literal case — update " +
            "this guard's parsing.",
        );
      }
      cases.set(clause.expression.text, clause);
    } else if (ts.isDefaultClause(clause)) {
      hasDefault = true;
      defaultClause = clause;
    }
  }
  return { cases, hasDefault, defaultClause };
}

type GateKind = "org-derived-write" | "canCallerSeeRow" | "org-scoped-query";

/**
 * Every dispatch case, classified by its enforcement mechanism:
 *  - org-derived-write: the callee stamps/verifies the caller's
 *    server-derived org before any DDB write (resolveWriteOrgId /
 *    assertRowOrg), rejecting a mismatching input.orgId.
 *  - canCallerSeeRow: by-id read, return-null posture (no existence
 *    oracle).
 *  - org-scoped-query: list-by-org read, resolveScopedOrgFromEvent before
 *    the Query.
 */
const GATED_OPS: Record<string, { fn: string; gate: GateKind }> = {
  createEvalSuite: { fn: "createEvalSuite", gate: "org-derived-write" },
  updateEvalSuite: { fn: "updateEvalSuite", gate: "org-derived-write" },
  freezeEvalSuite: { fn: "freezeEvalSuite", gate: "org-derived-write" },
  archiveEvalSuite: { fn: "archiveEvalSuite", gate: "org-derived-write" },
  cloneEvalSuite: { fn: "cloneEvalSuite", gate: "org-derived-write" },
  markEvalSuiteReferenced: {
    fn: "markEvalSuiteReferenced",
    gate: "org-derived-write",
  },
  addEvalCase: { fn: "addEvalCase", gate: "org-derived-write" },
  updateEvalCase: { fn: "updateEvalCase", gate: "org-derived-write" },
  deleteEvalCase: { fn: "deleteEvalCase", gate: "org-derived-write" },
  importReplayAsEvalCase: {
    fn: "importReplayAsEvalCase",
    gate: "org-derived-write",
  },
  getEvalSuite: { fn: "getEvalSuite", gate: "canCallerSeeRow" },
  listEvalCases: { fn: "listEvalCases", gate: "canCallerSeeRow" },
  listEvalSuites: { fn: "listEvalSuites", gate: "org-scoped-query" },
};

const EXEMPT_OPS: Record<string, string> = {};

describe("eval-resolver — dispatch enumeration completeness", () => {
  const source = fs.readFileSync(HANDLER_PATH, "utf-8");
  const sf = parseSource(source, "eval-resolver.ts");
  const handlerBody = findHandlerArrowBody(sf);
  const dispatch = extractDispatch(findDispatchSwitch(handlerBody));
  const caseNames = Array.from(dispatch.cases.keys());

  test("the dispatch switch actually has cases to check (sanity check on the parser itself)", () => {
    expect(caseNames.length).toBeGreaterThanOrEqual(13);
    expect(caseNames).toEqual(
      expect.arrayContaining([
        "createEvalSuite",
        "getEvalSuite",
        "listEvalSuites",
        "listEvalCases",
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
    const clause = dispatch.defaultClause;
    expect(clause).not.toBeNull();
    let throws = false;
    walk(clause as ts.Node, (n) => {
      if (ts.isThrowStatement(n)) throws = true;
    });
    expect(throws).toBe(true);
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
    },
  );

  test("getEvalSuite threads the raw event and its body gates via canCallerSeeRow (return-null, no existence oracle)", () => {
    const fn = findTopLevelFunction(sf, "getEvalSuite");
    const calls = collectCalls(functionBody(fn), sf);
    expect(calls.some((c) => c.callee === "canCallerSeeRow")).toBe(true);
    let returnsNull = false;
    walk(functionBody(fn), (n) => {
      if (
        ts.isReturnStatement(n) &&
        n.expression?.kind === ts.SyntaxKind.NullKeyword
      ) {
        returnsNull = true;
      }
    });
    expect(returnsNull).toBe(true);
  });

  test("listEvalCases gates via the parent suite's canCallerSeeRow (parent-org gate, not its own orgId)", () => {
    const fn = findTopLevelFunction(sf, "listEvalCases");
    const calls = collectCalls(functionBody(fn), sf);
    expect(calls.some((c) => c.callee === "canCallerSeeRow")).toBe(true);
    expect(calls.some((c) => c.callee === "getEvalSuite")).toBe(true);
  });

  test("listEvalSuites derives caller org via resolveScopedOrgFromEvent before the org-index Query", () => {
    const fn = findTopLevelFunction(sf, "listEvalSuites");
    const calls = collectCalls(functionBody(fn), sf);
    const orgCalls = calls.filter(
      (c) => c.callee === "resolveScopedOrgFromEvent",
    );
    const sends = calls.filter((c) => c.callee === "docClient.send");
    expect(orgCalls.length).toBeGreaterThanOrEqual(1);
    expect(sends.length).toBeGreaterThanOrEqual(1);
    expect(Math.min(...orgCalls.map((c) => c.start))).toBeLessThan(
      Math.min(...sends.map((c) => c.start)),
    );
  });

  test("createEvalSuite/updateEvalSuite stamp caller org and reject mismatching input.orgId", () => {
    for (const fnName of ["createEvalSuite", "updateEvalSuite"]) {
      const fn = findTopLevelFunction(sf, fnName);
      const calls = collectCalls(functionBody(fn), sf);
      expect(calls.some((c) => c.callee === "resolveWriteOrgId")).toBe(true);
    }
  });

  test("resolveWriteOrgId itself derives from extractOrgFromEvent and rejects a mismatching input.orgId", () => {
    const fn = findTopLevelFunction(sf, "resolveWriteOrgId");
    const calls = collectCalls(functionBody(fn), sf);
    expect(calls.some((c) => c.callee === "extractOrgFromEvent")).toBe(true);
    let throwsOnMismatch = false;
    walk(functionBody(fn), (n) => {
      if (ts.isIfStatement(n)) {
        let throwsHere = false;
        walk(n.thenStatement, (t) => {
          if (ts.isThrowStatement(t)) throwsHere = true;
        });
        if (throwsHere) throwsOnMismatch = true;
      }
    });
    expect(throwsOnMismatch).toBe(true);
  });

  describe("AST inspection is immune to gate names in comments and string literals", () => {
    test("real file: assertSuiteMutable's raw text names canCallerSeeRow/resolveScopedOrgFromEvent in a comment, but call-site collection is exact", () => {
      // The eval-resolver.ts module docstring block references these gate
      // names in prose; verifying the guard's collectCalls only counts
      // real CallExpression nodes (not comment text) for a function whose
      // own body does not call them at all.
      const fn = findTopLevelFunction(sf, "assertSuiteMutable");
      const calls = collectCalls(functionBody(fn), sf);
      expect(calls.some((c) => c.callee === "canCallerSeeRow")).toBe(false);
      expect(calls.some((c) => c.callee === "resolveScopedOrgFromEvent")).toBe(
        false,
      );
    });

    test("synthetic: gate names appearing ONLY in comments and string literals produce zero call sites", () => {
      const snippet = [
        "async function decoy(event: unknown): Promise<null> {",
        "  // canCallerSeeRow(row, event) must gate this — prose only.",
        '  const a = "resolveScopedOrgFromEvent(event, orgId)";',
        "  const b = `resolveWriteOrgId(input, event)`;",
        "  return null;",
        "}",
      ].join("\n");
      const decoySf = parseSource(snippet, "decoy.ts");
      const decoyFn = findTopLevelFunction(decoySf, "decoy");
      const names = collectCalls(functionBody(decoyFn), decoySf).map(
        (c) => c.callee,
      );
      expect(names).not.toContain("canCallerSeeRow");
      expect(names).not.toContain("resolveScopedOrgFromEvent");
      expect(names).not.toContain("resolveWriteOrgId");
    });

    test("synthetic: the same helpers DO detect a real gate call (immunity is not blindness)", () => {
      const snippet = [
        "async function real(event: unknown): Promise<boolean> {",
        "  return await canCallerSeeRow({ orgId: 'x' }, event);",
        "}",
      ].join("\n");
      const realSf = parseSource(snippet, "real.ts");
      const realFn = findTopLevelFunction(realSf, "real");
      const names = collectCalls(functionBody(realFn), realSf).map(
        (c) => c.callee,
      );
      expect(names).toContain("canCallerSeeRow");
    });
  });
});
