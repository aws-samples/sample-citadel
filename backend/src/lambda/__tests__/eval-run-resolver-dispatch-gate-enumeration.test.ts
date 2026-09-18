/**
 * Enumeration-completeness guard for eval-run-resolver.ts's dispatch switch
 * (Wave-3A ITEM4, board task a6ff10ff). Modeled on
 * governance-ui-resolver-dispatch-gate-enumeration.test.ts /
 * eval-resolver-dispatch-gate-enumeration.test.ts — see those files for the
 * full rationale on deriving from the real switch and AST-vs-text-matching.
 */
import * as fs from "fs";
import * as path from "path";
import * as ts from "typescript";

const HANDLER_PATH = path.join(__dirname, "..", "eval-run-resolver.ts");

function parseSource(source: string, fileName: string): ts.SourceFile {
  return ts.createSourceFile(
    fileName,
    source,
    ts.ScriptTarget.Latest,
    true,
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
        "eval-run-resolver.ts — structure changed; update this guard.",
    );
  }
  return found;
}

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

const GATED_OPS: Record<string, { fn: string; gate: GateKind }> = {
  startEvalRun: { fn: "startEvalRun", gate: "org-derived-write" },
  getEvalRun: { fn: "getEvalRun", gate: "canCallerSeeRow" },
  listEvalRuns: { fn: "listEvalRuns", gate: "org-scoped-query" },
  listEvalRunCaseResults: {
    fn: "listEvalRunCaseResults",
    gate: "canCallerSeeRow",
  },
};

const EXEMPT_OPS: Record<string, string> = {};

describe("eval-run-resolver — dispatch enumeration completeness", () => {
  const source = fs.readFileSync(HANDLER_PATH, "utf-8");
  const sf = parseSource(source, "eval-run-resolver.ts");
  const handlerBody = findHandlerArrowBody(sf);
  const dispatch = extractDispatch(findDispatchSwitch(handlerBody));
  const caseNames = Array.from(dispatch.cases.keys());

  test("the dispatch switch actually has cases to check (sanity check on the parser itself)", () => {
    expect(caseNames.length).toBeGreaterThanOrEqual(4);
    expect(caseNames).toEqual(
      expect.arrayContaining([
        "startEvalRun",
        "getEvalRun",
        "listEvalRuns",
        "listEvalRunCaseResults",
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

  test("getEvalRun threads event + canCallerSeeRow return-null", () => {
    const fn = findTopLevelFunction(sf, "getEvalRun");
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

  test("listEvalRunCaseResults gates via parent-run org (canCallerSeeRow on the fetched run)", () => {
    const fn = findTopLevelFunction(sf, "listEvalRunCaseResults");
    const calls = collectCalls(functionBody(fn), sf);
    expect(calls.some((c) => c.callee === "canCallerSeeRow")).toBe(true);
    expect(calls.some((c) => c.callee === "getEvalRun")).toBe(true);
  });

  test("listEvalRuns derives caller org (suite-index branch filters returned rows to scoped org)", () => {
    const fn = findTopLevelFunction(sf, "listEvalRuns");
    const calls = collectCalls(functionBody(fn), sf);
    const orgCalls = calls.filter(
      (c) => c.callee === "resolveScopedOrgFromEvent",
    );
    expect(orgCalls.length).toBeGreaterThanOrEqual(1);
    // Both branches (suite-index and org-index) must reference scoped.orgId
    // somewhere in the body — verified via the raw source containing the
    // filter/query predicate use of `scoped.orgId`.
    const bodyText = functionBody(fn).getText(sf);
    expect(bodyText).toContain("scoped.orgId");
  });

  test("startEvalRun assertRowOrg(suite,event) before any write", () => {
    const fn = findTopLevelFunction(sf, "startEvalRun");
    const calls = collectCalls(functionBody(fn), sf);
    const gates = calls.filter((c) => c.callee === "assertRowOrg");
    const sends = calls.filter((c) => c.callee === "docClient.send");
    expect(gates.length).toBeGreaterThanOrEqual(1);
    expect(sends.length).toBeGreaterThanOrEqual(1);
    expect(Math.min(...gates.map((c) => c.start))).toBeLessThan(
      Math.min(...sends.map((c) => c.start)),
    );
  });

  describe("AST inspection is immune to gate names in comments and string literals", () => {
    test("real file: listEvalRunCaseResults' docstring names canCallerSeeRow/canCallerSeeRow-adjacent terms in prose, but call-site collection is exact (exactly one real gate call)", () => {
      const fn = findTopLevelFunction(sf, "listEvalRunCaseResults");
      const body = functionBody(fn);
      const astCalls = collectCalls(body, sf).filter(
        (c) => c.callee === "canCallerSeeRow",
      );
      expect(astCalls).toHaveLength(1);
    });

    test("synthetic: gate names appearing ONLY in comments and string literals produce zero call sites", () => {
      const snippet = [
        "async function decoy(event: unknown): Promise<null> {",
        "  // canCallerSeeRow(row, event) must gate this — prose only.",
        '  const a = "resolveScopedOrgFromEvent(event, orgId)";',
        "  const b = `assertRowOrg(suite, event)`;",
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
      expect(names).not.toContain("assertRowOrg");
    });

    test("synthetic: the same helpers DO detect a real gate call (immunity is not blindness)", () => {
      const snippet = [
        "async function real(event: unknown): Promise<void> {",
        "  await assertRowOrg(suite, event);",
        "}",
      ].join("\n");
      const realSf = parseSource(snippet, "real.ts");
      const realFn = findTopLevelFunction(realSf, "real");
      const names = collectCalls(functionBody(realFn), realSf).map(
        (c) => c.callee,
      );
      expect(names).toContain("assertRowOrg");
    });
  });
});
