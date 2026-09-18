/**
 * Enumeration-completeness guard for eval-comparison-resolver.ts's dispatch
 * switch (Wave-3A ITEM4, board task a6ff10ff). Modeled on
 * governance-ui-resolver-dispatch-gate-enumeration.test.ts /
 * eval-resolver-dispatch-gate-enumeration.test.ts — see those files for the
 * full rationale on deriving from the real switch and AST-vs-text-matching.
 */
import * as fs from "fs";
import * as path from "path";
import * as ts from "typescript";

const HANDLER_PATH = path.join(__dirname, "..", "eval-comparison-resolver.ts");

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
        "eval-comparison-resolver.ts — structure changed; update this guard.",
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

type GateKind =
  "org-derived-write" | "org-scoped-query" | "identity-derived-org";

/**
 * getEvalComparison is classified separately (identity-derived-org): the
 * GraphQL schema has no orgId argument for this field, so
 * getEvalComparisonHydrated resolves the expected org from the AppSync
 * identity via extractOrgFromEvent rather than a client-supplied orgId —
 * already-correct by design (see the file's own module docstring).
 */
const GATED_OPS: Record<string, { fn: string; gate: GateKind }> = {
  designateEvalBaseline: {
    fn: "designateEvalBaseline",
    gate: "org-derived-write",
  },
  computeEvalComparison: {
    fn: "computeEvalComparison",
    gate: "org-derived-write",
  },
  setEvalComparisonThresholdConfig: {
    fn: "setEvalComparisonThresholdConfig",
    gate: "org-derived-write",
  },
  getEvalBaseline: { fn: "getEvalBaseline", gate: "org-scoped-query" },
  listEvalBaselines: { fn: "listEvalBaselines", gate: "org-scoped-query" },
  getEvalComparison: {
    fn: "getEvalComparisonHydrated",
    gate: "identity-derived-org",
  },
  listEvalComparisons: {
    fn: "listEvalComparisons",
    gate: "org-scoped-query",
  },
  getEvalComparisonThresholdConfig: {
    fn: "getEvalComparisonThresholdConfig",
    gate: "org-scoped-query",
  },
  getEvalCaseArtifactDiff: {
    fn: "getEvalCaseArtifactDiff",
    gate: "org-derived-write",
  },
};

const EXEMPT_OPS: Record<string, string> = {};

describe("eval-comparison-resolver — dispatch enumeration completeness", () => {
  const source = fs.readFileSync(HANDLER_PATH, "utf-8");
  const sf = parseSource(source, "eval-comparison-resolver.ts");
  const handlerBody = findHandlerArrowBody(sf);
  const dispatch = extractDispatch(findDispatchSwitch(handlerBody));
  const caseNames = Array.from(dispatch.cases.keys());

  test("the dispatch switch actually has cases to check (sanity check on the parser itself)", () => {
    expect(caseNames.length).toBeGreaterThanOrEqual(9);
    expect(caseNames).toEqual(
      expect.arrayContaining([
        "designateEvalBaseline",
        "computeEvalComparison",
        "getEvalComparison",
        "listEvalComparisons",
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

  test("list/keyed reads (getEvalBaseline, listEvalBaselines, listEvalComparisons, getEvalComparisonThresholdConfig) derive caller org via resolveScopedOrgFromEvent, never trust input.orgId directly", () => {
    for (const fnName of [
      "getEvalBaseline",
      "listEvalBaselines",
      "listEvalComparisons",
      "getEvalComparisonThresholdConfig",
    ]) {
      const fn = findTopLevelFunction(sf, fnName);
      const calls = collectCalls(functionBody(fn), sf);
      expect(calls.some((c) => c.callee === "resolveScopedOrgFromEvent")).toBe(
        true,
      );
    }
  });

  test("getEvalComparison (getEvalComparisonHydrated) resolves expected org from identity via extractOrgFromEvent (already correct)", () => {
    const fn = findTopLevelFunction(sf, "getEvalComparisonHydrated");
    const calls = collectCalls(functionBody(fn), sf);
    expect(calls.some((c) => c.callee === "extractOrgFromEvent")).toBe(true);
  });

  test("designateEvalBaseline/computeEvalComparison/setEvalComparisonThresholdConfig stamp caller org + reject mismatch via resolveWriteOrgId", () => {
    for (const fnName of [
      "designateEvalBaseline",
      "computeEvalComparison",
      "setEvalComparisonThresholdConfig",
    ]) {
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

  test("getEvalCaseArtifactDiff passes caller-derived org (via resolveWriteOrgId) to loadArtifactSideView, not input.orgId directly", () => {
    const fn = findTopLevelFunction(sf, "getEvalCaseArtifactDiff");
    const calls = collectCalls(functionBody(fn), sf);
    expect(calls.some((c) => c.callee === "resolveWriteOrgId")).toBe(true);
    const sideViewCalls = calls.filter(
      (c) => c.callee === "loadArtifactSideView",
    );
    expect(sideViewCalls.length).toBeGreaterThanOrEqual(2);
    // Neither call may pass a property-access `input.orgId` argument —
    // both must pass the resolved local `orgId` identifier instead.
    for (const call of sideViewCalls) {
      const passesRawInputOrgId = call.node.arguments.some((arg) => {
        const core = unwrapExpression(arg);
        return (
          ts.isPropertyAccessExpression(core) &&
          ts.isIdentifier(core.expression) &&
          core.expression.text === "input" &&
          core.name.text === "orgId"
        );
      });
      expect(passesRawInputOrgId).toBe(false);
    }
  });

  describe("AST inspection is immune to gate names in comments and string literals", () => {
    test("real file: getEvalCaseArtifactDiff's comment names resolveWriteOrgId's reconciliation in prose, but call-site collection is exact", () => {
      const fn = findTopLevelFunction(sf, "getEvalCaseArtifactDiff");
      const body = functionBody(fn);
      const astCalls = collectCalls(body, sf).filter(
        (c) => c.callee === "resolveWriteOrgId",
      );
      expect(astCalls).toHaveLength(1);
    });

    test("synthetic: gate names appearing ONLY in comments and string literals produce zero call sites", () => {
      const snippet = [
        "async function decoy(event: unknown): Promise<null> {",
        "  // resolveScopedOrgFromEvent(event, orgId) must gate this — prose only.",
        '  const a = "extractOrgFromEvent(event)";',
        "  const b = `resolveWriteOrgId(input.orgId, event)`;",
        "  return null;",
        "}",
      ].join("\n");
      const decoySf = parseSource(snippet, "decoy.ts");
      const decoyFn = findTopLevelFunction(decoySf, "decoy");
      const names = collectCalls(functionBody(decoyFn), decoySf).map(
        (c) => c.callee,
      );
      expect(names).not.toContain("resolveScopedOrgFromEvent");
      expect(names).not.toContain("extractOrgFromEvent");
      expect(names).not.toContain("resolveWriteOrgId");
    });

    test("synthetic: the same helpers DO detect a real gate call (immunity is not blindness)", () => {
      const snippet = [
        "async function real(event: unknown): Promise<string | null> {",
        "  return await extractOrgFromEvent(event);",
        "}",
      ].join("\n");
      const realSf = parseSource(snippet, "real.ts");
      const realFn = findTopLevelFunction(realSf, "real");
      const names = collectCalls(functionBody(realFn), realSf).map(
        (c) => c.callee,
      );
      expect(names).toContain("extractOrgFromEvent");
    });
  });
});
