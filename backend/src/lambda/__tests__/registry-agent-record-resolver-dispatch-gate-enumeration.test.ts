/**
 * Enumeration-completeness guard for registry-agent-record-resolver.ts's
 * dispatch switch (finding 6400b440 follow-up; upgraded for finding
 * 13ffaca1 / board task a6ff10ff, ITEM2).
 *
 * The previous "every op is gated" claim was a hand-maintained list that
 * missed deleteApp entirely. This test derives the operation list directly
 * from the handler's `switch (fieldName)` source — by parsing the actual
 * `case "..."` labels out of the file — rather than trusting a manually
 * transcribed list, so a future case added to the switch without a
 * corresponding entry here fails LOUDLY instead of silently shipping
 * ungated.
 *
 * Every case must appear in exactly one of:
 *   - GATED_OPS: calls an assertManifestAccess/assertManifestOwnerAccess
 *     gate (verified by grep against the case's handler function body, not
 *     just asserted by hand) before any mutating side effect.
 *   - ORG_DERIVED_CREATE_OPS: creates a NEW resource with no existing
 *     manifest access map to check against; gated instead by deriving the
 *     caller's org server-side and rejecting a mismatching client input
 *     (verified structurally via the AST `callReceivesBareEvent` +
 *     `extractOrgFromEvent`-in-body check, ported from
 *     governance-ui-resolver-dispatch-gate-enumeration.test.ts, since
 *     `assertManifestAccess` cannot apply here — no manifest exists yet).
 *   - EXEMPT_OPS: legitimately gate-free, each with an explicit reason
 *     (pure read with its own tenant check, IAM-only internal, or a
 *     documented pre-existing gap called out for follow-up rather than
 *     silently passed over).
 *
 * `listAppApiKeys` and `getAppMetrics` previously sat in EXEMPT_OPS with
 * hand-written prose reasons that were never structurally checked — the
 * EXEMPT list was the hole (finding 13ffaca1: both took no `event` at all
 * and delegated straight to their DDB-backed impls with zero tenant check).
 * They are now GATED_OPS at 'viewer', verified the same way every other
 * GATED_OPS entry is: a real `assertManifestAccess(...)` call in the
 * handler body.
 *
 * If neither list accounts for a case, or a GATED op's handler function no
 * longer contains a gate call, the test fails.
 */
import * as fs from "fs";
import * as path from "path";
import * as ts from "typescript";

const RESOLVER_PATH = path.join(
  __dirname,
  "..",
  "registry-agent-record-resolver.ts",
);

// --- AST helpers (ported from
// governance-ui-resolver-dispatch-gate-enumeration.test.ts) ---------------

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
        "registry-agent-record-resolver.ts — structure changed; update this guard.",
    );
  }
  return found;
}

/**
 * `handler` in this file is declared as `export const handler: T = async
 * (event) => {...}` (an arrow function assigned to a typed const), not a
 * `function` declaration — unlike governance-ui-resolver.ts's `handler`,
 * which this helper was ported from. Locates the arrow function's body via
 * the top-level VariableStatement so the same downstream AST helpers
 * (functionBody-shaped consumers) keep working unmodified.
 */
function findTopLevelArrowFunctionBody(
  sf: ts.SourceFile,
  constName: string,
): ts.Block {
  let found: ts.Block | undefined;
  sf.forEachChild((node) => {
    if (!ts.isVariableStatement(node)) return;
    for (const decl of node.declarationList.declarations) {
      if (
        ts.isIdentifier(decl.name) &&
        decl.name.text === constName &&
        decl.initializer &&
        ts.isArrowFunction(decl.initializer) &&
        decl.initializer.body &&
        ts.isBlock(decl.initializer.body)
      ) {
        found = decl.initializer.body;
      }
    }
  });
  if (!found) {
    throw new Error(
      `Could not locate top-level arrow function '${constName}' with a ` +
        "block body in registry-agent-record-resolver.ts — structure " +
        "changed; update this guard.",
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

/**
 * Collects every call expression under `root` whose callee is a plain
 * identifier (`foo(...)`) or a one-level property access on an identifier
 * (`dynamodb.send(...)` → "dynamodb.send"). Because this walks AST nodes, a
 * gate name that appears only inside a comment or a string literal is
 * invisible to it.
 */
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

/** Unwraps `(x)`, `x as T`, `x!`, `x satisfies T` down to the core node. */
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

/** True when some argument of `call` is (a cast/paren wrap of) bare `event`. */
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
      "Could not locate `switch (fieldName)` inside handler — dispatch " +
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

const GATE_CALL_RE = /assertManifest(Owner)?Access\s*\(/;

/**
 * Ops verified to call an assertManifestAccess/assertManifestOwnerAccess
 * gate inside their handler function body before any mutating side effect.
 * `requiredRole` documents which role the call site pins (for humans
 * reading this list); the actual enforcement is verified structurally by
 * extractFunctionBody + GATE_CALL_RE against the real source, not merely
 * asserted here.
 */
const GATED_OPS: Record<
  string,
  { requiredRole: "owner" | "editor" | "viewer" }
> = {
  updateApp: { requiredRole: "editor" },
  deleteApp: { requiredRole: "owner" },
  addAppComponent: { requiredRole: "editor" },
  removeAppComponent: { requiredRole: "editor" },
  updateAgentBinding: { requiredRole: "editor" },
  setAppConfigSchema: { requiredRole: "editor" },
  setAppConfigValues: { requiredRole: "editor" },
  setAppAuthConfig: { requiredRole: "editor" },
  grantAppAccess: { requiredRole: "owner" },
  revokeAppAccess: { requiredRole: "owner" },
  createAppApiKey: { requiredRole: "editor" },
  revokeAppApiKey: { requiredRole: "editor" },
  rotateAppApiKey: { requiredRole: "editor" },
  // Finding c35137bb: both mutate manifest.workflowIds and alter which
  // workflows the app executes at runtime, rather than destroying the app
  // — gated at 'editor', same tier as updateApp/addAppComponent/
  // updateAgentBinding. See
  // registry-agent-record-resolver-workflow-binding-editor-gate.test.ts for
  // the dedicated cross-org/non-editor/editor/owner/admin coverage.
  bindWorkflowToApp: { requiredRole: "editor" },
  unbindWorkflowFromApp: { requiredRole: "editor" },
  // Finding 603e732f: previously delegated to app-access-control.ts's
  // DynamoDB-backed listAppAccessEntries (a writer-less store, ungated on
  // this dispatch) — now reads manifest.access directly and is gated at
  // 'viewer', the lowest tier, since it is a non-mutating read that a
  // viewer legitimately needs (to see who else has access), same
  // justification as getApp/listApps' own viewer-tier reads. See
  // registry-agent-record-resolver-access.test.ts for the dedicated
  // cross-org/no-entry/viewer/admin coverage.
  listAppAccessEntries: { requiredRole: "viewer" },
  // Finding 13ffaca1 / board task a6ff10ff (ITEM2): previously EXEMPT_OPS
  // with a hand-written "relies on AppSync field-level auth" / "pure read"
  // reason that the guard never structurally checked — both took no
  // `event` at all and delegated straight to their DDB-backed impls with
  // zero tenant check, letting ANY authenticated caller read ANY app's key
  // metadata or metrics regardless of org. Now gated at 'viewer' (same
  // tier as listAppAccessEntries/getApp/listApps — non-mutating reads). See
  // registry-agent-record-resolver-keys-metrics-gate.test.ts for dedicated
  // same-org/cross-org/missing-app coverage.
  listAppApiKeys: { requiredRole: "viewer" },
  getAppMetrics: { requiredRole: "viewer" },
};

/**
 * Ops that create a brand-new resource and so have no EXISTING manifest
 * access map to check against — gated instead by deriving the caller's org
 * server-side (`extractOrgFromEvent`) and rejecting a mismatching client
 * `input.orgId`, rather than by `assertManifestAccess`. Verified
 * structurally via AST (ported from governance-ui-resolver's guard,
 * `callReceivesBareEvent` + a body scan for `extractOrgFromEvent`) since
 * the text-based `GATE_CALL_RE` cannot see this gate shape.
 */
const ORG_DERIVED_CREATE_OPS: Record<string, { fn: string }> = {
  createApp: { fn: "createApp" },
};

/**
 * Ops that legitimately have NO assertManifestAccess gate call, each with
 * an explicit reason. This list must be kept honest — a case landing here
 * with a hand-wavy reason defeats the point of the guard.
 */
const EXEMPT_OPS: Record<string, string> = {
  getApp: "pure read; enforces its own inline org-equality tenant check",
  listApps: "pure read, scoped to the caller's own orgId argument",
  publishAppStatusEvent:
    "internal EventBridge publish helper invoked by other already-gated " +
    "handlers, not a caller-facing app mutation in its own right",
};

describe("registry-agent-record-resolver — dispatch enumeration completeness", () => {
  const source = fs.readFileSync(RESOLVER_PATH, "utf-8");
  const sf = parseSource(source, "registry-agent-record-resolver.ts");
  const handlerBody = findTopLevelArrowFunctionBody(sf, "handler");
  const dispatch = extractDispatch(findDispatchSwitch(handlerBody));
  const cases = Array.from(dispatch.cases.keys());

  test("the dispatch switch actually has cases to check (sanity check on the parser itself)", () => {
    expect(cases.length).toBeGreaterThan(15);
    expect(cases).toContain("deleteApp");
    expect(cases).toContain("grantAppAccess");
    expect(cases).toContain("bindWorkflowToApp");
  });

  test("every dispatch case is accounted for in GATED_OPS, ORG_DERIVED_CREATE_OPS, or EXEMPT_OPS", () => {
    const unaccounted = cases.filter(
      (c) =>
        !(c in GATED_OPS) &&
        !(c in ORG_DERIVED_CREATE_OPS) &&
        !(c in EXEMPT_OPS),
    );
    expect(unaccounted).toEqual([]);
  });

  test("no op is claimed by more than one classification table", () => {
    const tables: Array<Record<string, unknown>> = [
      GATED_OPS,
      ORG_DERIVED_CREATE_OPS,
      EXEMPT_OPS,
    ];
    for (let a = 0; a < tables.length; a++) {
      for (let b = a + 1; b < tables.length; b++) {
        const overlap = Object.keys(tables[a]).filter((k) => k in tables[b]);
        expect(overlap).toEqual([]);
      }
    }
  });

  test("no classification entry references a case that no longer exists in the switch", () => {
    const known = new Set(cases);
    const staleGated = Object.keys(GATED_OPS).filter((k) => !known.has(k));
    const staleCreate = Object.keys(ORG_DERIVED_CREATE_OPS).filter(
      (k) => !known.has(k),
    );
    const staleExempt = Object.keys(EXEMPT_OPS).filter((k) => !known.has(k));
    expect(staleGated).toEqual([]);
    expect(staleCreate).toEqual([]);
    expect(staleExempt).toEqual([]);
  });

  describe.each(Object.entries(GATED_OPS))(
    "GATED_OPS['%s'] handler actually calls a manifest-access gate",
    (fieldName, meta) => {
      test(`${fieldName} (requiredRole=${meta.requiredRole}) contains an assertManifestAccess/assertManifestOwnerAccess call`, () => {
        const clause = dispatch.cases.get(fieldName);
        expect(clause).toBeDefined();
        const calls = collectCalls(clause as ts.Node, sf);
        const target = calls.filter((c) => c.callee === fieldName);
        expect(target.length).toBeGreaterThanOrEqual(1);
        const fn = findTopLevelFunction(sf, fieldName);
        const body = functionBody(fn).getText(sf);
        expect(GATE_CALL_RE.test(body)).toBe(true);
      });
    },
  );

  describe.each(Object.entries(ORG_DERIVED_CREATE_OPS))(
    "ORG_DERIVED_CREATE_OPS['%s'] dispatches with bare `event` and derives org server-side",
    (fieldName, meta) => {
      test(`case '${fieldName}' passes the raw \`event\` to ${meta.fn}`, () => {
        const clause = dispatch.cases.get(fieldName);
        expect(clause).toBeDefined();
        const calls = collectCalls(clause as ts.Node, sf);
        const target = calls.filter((c) => c.callee === meta.fn);
        expect(target.length).toBeGreaterThanOrEqual(1);
        expect(target.some((c) => callReceivesBareEvent(c.node))).toBe(true);
      });

      test(`${meta.fn}'s body calls extractOrgFromEvent to derive the caller's org`, () => {
        const fn = findTopLevelFunction(sf, meta.fn);
        const calls = collectCalls(functionBody(fn), sf);
        expect(calls.some((c) => c.callee === "extractOrgFromEvent")).toBe(
          true,
        );
      });
    },
  );

  describe("AST inspection is immune to gate names in comments and string literals", () => {
    test("synthetic: gate names appearing ONLY in comments and string literals produce zero call sites", () => {
      const snippet = [
        "async function decoy(event: unknown): Promise<null> {",
        "  // extractOrgFromEvent(event) must gate this — prose only.",
        "  const a = \"assertManifestAccess(appId, record, event, 'viewer')\";",
        "  return null;",
        "}",
      ].join("\n");
      const decoySf = parseSource(snippet, "decoy.ts");
      const decoyFn = findTopLevelFunction(decoySf, "decoy");
      const names = collectCalls(functionBody(decoyFn), decoySf).map(
        (c) => c.callee,
      );
      expect(names).not.toContain("extractOrgFromEvent");
      expect(names).not.toContain("assertManifestAccess");
    });

    test("synthetic: the same helper DOES detect a real extractOrgFromEvent call", () => {
      const snippet = [
        "async function real(event: unknown): Promise<void> {",
        "  const callerOrg = await extractOrgFromEvent(event);",
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

  test("the dispatch has a default clause that throws on unknown fields (fails closed)", () => {
    expect(dispatch.hasDefault).toBe(true);
    const clause = dispatch.defaultClause;
    expect(clause).not.toBeNull();
    let throws = false;
    walk(clause as ts.Node, (n) => {
      if (ts.isThrowStatement(n)) throws = true;
    });
    expect(throws).toBe(true);
  });
});
