/**
 * Enumeration-completeness guard for governance-ui-resolver.ts's dispatch
 * switch — the thirteenth and final guard in the series started by
 * registry-agent-record-resolver-dispatch-gate-enumeration.test.ts and
 * continued through adr-resolver / execspec-resolver /
 * fabricator-queue-resolver (path-shaped) and the rest. This module is the
 * LARGEST resolver in the repo (30 dispatch cases) and, until this guard,
 * the only dispatch surface without one.
 *
 * What the guard enforces: the operation list is derived from the
 * handler's ACTUAL `switch (fieldName)` dispatch — never a hand-maintained
 * array (deriving from the real dispatch is what caught an entirely
 * ungated deleteApp earlier in this series). Every derived case must be
 * accounted for in exactly one of three classification tables:
 *
 *   GATED_OPS          — caller-facing ops; each names its gate
 *                        (isAdminFromEvent / assertAdmin / callerCanSeeRow /
 *                        org-scoped query) and the guard verifies the gate
 *                        structurally in the callee's body.
 *   IAM_INTERNAL_OPS   — machine-to-machine ops rejected for user-pool /
 *                        OIDC / API-key callers (publishGovernanceFinding
 *                        via isIamIdentity(event.identity)).
 *   EXEMPT_OPS         — DELIBERATE exemptions carrying their decision
 *                        reasoning (getGovernanceMode, decision 15d2d3e2).
 *
 * A future case added to the switch without a classification fails the
 * "every dispatch case is accounted for" test by name, so a new operation
 * cannot ship ungated-by-omission.
 *
 * Why AST, not string matching (unlike the earlier guards in the series):
 * per the repo lesson that text matching is defeated by a token appearing
 * in a comment or string literal — and in THIS file that is not
 * hypothetical: getDecisionTrace's body contains the token
 * `callerCanSeeRow` in a prose comment as well as in the real gate call,
 * and listGovernanceFindings' body mentions `extractOrgFromEvent` in a
 * comment. All inspection here parses the module with the TypeScript
 * compiler (ts.createSourceFile) and walks call-expression /
 * property-assignment / if-statement nodes; dedicated tests below prove
 * the helpers see exactly ONE real call where the raw text contains the
 * token more than once, and see ZERO calls in a synthetic snippet whose
 * comments and string literals name every gate. Same convention as
 * app-access-control-dead-code-guard.test.ts /
 * release-store-choke-point.guard.test.ts.
 *
 * Ordering (decisions 7b3f4fe2 / 2dd461f6, slice 3): for the three reads
 * slice 3 org-isolated, the gate must precede the data access/derivation —
 * listGovernanceFindings derives the caller org BEFORE any dynamodb.send;
 * getGovernanceFinding / getDecisionTrace pass callerCanSeeRow BEFORE any
 * projection or cross-table pivot, degrading to null (never a thrown
 * error, which would be an existence oracle).
 */
import * as fs from "fs";
import * as path from "path";
import * as ts from "typescript";

const HANDLER_PATH = path.join(__dirname, "..", "governance-ui-resolver.ts");

// --- AST helpers -----------------------------------------------------

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
        "governance-ui-resolver.ts — structure changed; update this guard.",
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
 * (`dynamodb.send(...)` → "dynamodb.send"). Because this walks AST nodes,
 * a gate name that appears only inside a comment or a string literal is
 * invisible to it — verified by dedicated tests below.
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

/**
 * Finds an `if` statement in `root` whose condition contains a NEGATED
 * call to `gateName` (e.g. `if (!isAdminFromEvent(event))`,
 * `if (!(await callerCanSeeRow(row, event)))`) and whose then-branch has
 * the expected fail-closed consequence: a `throw`, or a `return null`.
 */
function hasNegatedGateIf(
  root: ts.Node,
  sf: ts.SourceFile,
  gateName: string,
  consequence: "throws" | "returnsNull",
): boolean {
  let found = false;
  walk(root, (n) => {
    if (found || !ts.isIfStatement(n)) return;

    let negatedGateCall = false;
    walk(n.expression, (c) => {
      if (
        ts.isPrefixUnaryExpression(c) &&
        c.operator === ts.SyntaxKind.ExclamationToken
      ) {
        walk(c.operand, (inner) => {
          if (
            ts.isCallExpression(inner) &&
            ts.isIdentifier(inner.expression) &&
            inner.expression.text === gateName
          ) {
            negatedGateCall = true;
          }
        });
      }
    });
    if (!negatedGateCall) return;

    let consequenceOk = false;
    walk(n.thenStatement, (t) => {
      if (consequence === "throws" && ts.isThrowStatement(t)) {
        consequenceOk = true;
      }
      if (
        consequence === "returnsNull" &&
        ts.isReturnStatement(t) &&
        t.expression !== undefined &&
        t.expression.kind === ts.SyntaxKind.NullKeyword
      ) {
        consequenceOk = true;
      }
    });
    if (consequenceOk) found = true;
  });
  return found;
}

interface StringProp {
  name: string;
  value: string;
  start: number;
}

/** Collects `name: "literal"` property assignments under `root`. */
function collectStringPropertyAssignments(
  root: ts.Node,
  sf: ts.SourceFile,
): StringProp[] {
  const out: StringProp[] = [];
  walk(root, (n) => {
    if (!ts.isPropertyAssignment(n)) return;
    const nameNode = n.name;
    let name: string | null = null;
    if (ts.isIdentifier(nameNode) || ts.isStringLiteral(nameNode)) {
      name = nameNode.text;
    }
    if (name !== null && ts.isStringLiteral(n.initializer)) {
      out.push({ name, value: n.initializer.text, start: n.getStart(sf) });
    }
  });
  return out;
}

function findDispatchSwitch(
  handlerFn: ts.FunctionDeclaration,
): ts.SwitchStatement {
  let sw: ts.SwitchStatement | undefined;
  walk(functionBody(handlerFn), (n) => {
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

// --- Classification --------------------------------------------------

type GateKind =
  "isAdminFromEvent" | "assertAdmin" | "callerCanSeeRow" | "org-scoped-query";

/**
 * Caller-facing ops. `gate` names the mechanism verified structurally in
 * the callee's own body:
 *  - isAdminFromEvent: inline `if (!isAdminFromEvent(event)) throw`.
 *  - assertAdmin:      `assertAdmin(event)` call (helper itself verified
 *                      below to be the same negated-gate-throw shape).
 *  - callerCanSeeRow:  row-org visibility gate, `return null` posture
 *                      (never a throw — no existence oracle).
 *  - org-scoped-query: non-admin reads Query the org-index by the
 *                      server-derived caller org (listGovernanceFindings).
 */
const GATED_OPS: Record<string, { fn: string; gate: GateKind }> = {
  // Reads/aggregates admin-gated inline.
  getReconcilerStatus: { fn: "getReconcilerStatus", gate: "isAdminFromEvent" },
  getRolloutReadiness: { fn: "getRolloutReadiness", gate: "isAdminFromEvent" },
  getMismatchHeatmap: { fn: "getMismatchHeatmap", gate: "isAdminFromEvent" },
  getEscalationMetricSeries: {
    fn: "getEscalationMetricSeries",
    gate: "isAdminFromEvent",
  },
  setGovernanceMode: { fn: "setGovernanceMode", gate: "isAdminFromEvent" },
  markReadinessCheckVerified: {
    fn: "markReadinessCheckVerified",
    gate: "isAdminFromEvent",
  },
  listAuthorityUnits: { fn: "listAuthorityUnits", gate: "isAdminFromEvent" },
  listCompositionContracts: {
    fn: "listCompositionContracts",
    gate: "isAdminFromEvent",
  },
  getRevokeImpact: { fn: "getRevokeImpact", gate: "isAdminFromEvent" },
  listConstitutionalLayers: {
    fn: "listConstitutionalLayers",
    gate: "isAdminFromEvent",
  },
  getConstitutionalRuleStats: {
    fn: "getConstitutionalRuleStats",
    gate: "isAdminFromEvent",
  },
  listCaseLaw: { fn: "listCaseLaw", gate: "isAdminFromEvent" },
  listAuthorityGraphSnapshots: {
    fn: "listAuthorityGraphSnapshots",
    gate: "isAdminFromEvent",
  },
  getAuthorityGraphSnapshot: {
    fn: "getAuthorityGraphSnapshot",
    gate: "isAdminFromEvent",
  },
  getD4RetrospectiveReport: {
    fn: "getD4RetrospectiveReport",
    gate: "isAdminFromEvent",
  },
  getTrustPath: { fn: "getTrustPath", gate: "isAdminFromEvent" },
  // Mutations/settings gated via the assertAdmin helper.
  addConstitutionalRule: { fn: "addConstitutionalRule", gate: "assertAdmin" },
  updateConstitutionalRule: {
    fn: "updateConstitutionalRule",
    gate: "assertAdmin",
  },
  deleteConstitutionalRule: {
    fn: "deleteConstitutionalRule",
    gate: "assertAdmin",
  },
  revokeCaseLaw: { fn: "revokeCaseLaw", gate: "assertAdmin" },
  unrevokeCaseLaw: { fn: "unrevokeCaseLaw", gate: "assertAdmin" },
  updateCaseLawPrecedence: {
    fn: "updateCaseLawPrecedence",
    gate: "assertAdmin",
  },
  getAuthorityGraphHistorySettings: {
    fn: "getAuthorityGraphHistorySettings",
    gate: "assertAdmin",
  },
  updateAuthorityGraphHistorySettings: {
    fn: "updateAuthorityGraphHistorySettings",
    gate: "assertAdmin",
  },
  getResourceIamDrift: { fn: "getResourceIamDrift", gate: "assertAdmin" },
  // Slice-3 org-isolated ledger reads (decisions 7b3f4fe2 / 2dd461f6).
  listGovernanceFindings: {
    fn: "listGovernanceFindings",
    gate: "org-scoped-query",
  },
  getGovernanceFinding: {
    fn: "getGovernanceFinding",
    gate: "callerCanSeeRow",
  },
  getDecisionTrace: { fn: "getDecisionTrace", gate: "callerCanSeeRow" },
};

/**
 * Machine-to-machine ops: not reachable by user-pool / OIDC / API-key
 * callers. publishGovernanceFinding is the ledger fanout Lambda's
 * pass-through into the AppSync subscription; it rejects any non-IAM
 * identity via isIamIdentity(event.identity) before echoing input.
 */
const IAM_INTERNAL_OPS: Record<string, { fn: string }> = {
  publishGovernanceFinding: { fn: "publishGovernanceFinding" },
};

/**
 * DELIBERATE exemptions — a decision, not an oversight.
 *
 * getGovernanceMode — decision 15d2d3e2 (owner-ratified): stays readable
 * by ANY AUTHENTICATED USER. The enforcement mode (permissive / shadow /
 * strict, plus effectiveAt and env) is platform-wide configuration, not
 * tenant data — the function reads SSM configuration only and touches no
 * tenant's rows, so there is no cross-tenant leak to gate against. The
 * only cost of exposure is reconnaissance value (an authenticated caller
 * learns how strictly the platform currently enforces), judged marginal
 * against the product value of the governance badge every authenticated
 * user's UI renders from this query. The exemption is total and
 * structural, and the tests below pin all three facts: the dispatch
 * passes NO arguments, the function signature has ZERO parameters (it
 * cannot even see the caller's identity), and its body calls no gate.
 */
const EXEMPT_OPS: Record<string, string> = {
  getGovernanceMode:
    "decision 15d2d3e2: platform-wide configuration, not tenant data — " +
    "any-authenticated by design; reconnaissance-only exposure accepted.",
};

// Gate identifiers that must NOT appear as calls in an exempt op's body.
const ALL_GATE_NAMES = [
  "isAdminFromEvent",
  "assertAdmin",
  "callerCanSeeRow",
  "extractOrgFromEvent",
  "isIamIdentity",
];

// --- The guard -------------------------------------------------------

describe("governance-ui-resolver — dispatch enumeration completeness", () => {
  const source = fs.readFileSync(HANDLER_PATH, "utf-8");
  const sf = parseSource(source, "governance-ui-resolver.ts");
  const handlerFn = findTopLevelFunction(sf, "handler");
  const dispatch = extractDispatch(findDispatchSwitch(handlerFn));
  const caseNames = Array.from(dispatch.cases.keys());

  test("the dispatch switch actually has cases to check (sanity check on the parser itself)", () => {
    expect(caseNames.length).toBeGreaterThanOrEqual(30);
    expect(caseNames).toEqual(
      expect.arrayContaining([
        "getGovernanceMode",
        "listGovernanceFindings",
        "getGovernanceFinding",
        "getDecisionTrace",
        "setGovernanceMode",
        "publishGovernanceFinding",
        "deleteConstitutionalRule",
        "getResourceIamDrift",
      ]),
    );
  });

  test("every dispatch case is accounted for in GATED_OPS, IAM_INTERNAL_OPS, or EXEMPT_OPS", () => {
    const unaccounted = caseNames.filter(
      (c) =>
        !(c in GATED_OPS) && !(c in IAM_INTERNAL_OPS) && !(c in EXEMPT_OPS),
    );
    expect(unaccounted).toEqual([]);
  });

  test("no op is claimed by more than one classification table", () => {
    const tables: Array<Record<string, unknown>> = [
      GATED_OPS,
      IAM_INTERNAL_OPS,
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
    const known = new Set(caseNames);
    const stale = [
      ...Object.keys(GATED_OPS),
      ...Object.keys(IAM_INTERNAL_OPS),
      ...Object.keys(EXEMPT_OPS),
    ].filter((k) => !known.has(k));
    expect(stale).toEqual([]);
  });

  test("the classification tables jointly cover exactly the dispatch surface (30 ops today)", () => {
    const claimed =
      Object.keys(GATED_OPS).length +
      Object.keys(IAM_INTERNAL_OPS).length +
      Object.keys(EXEMPT_OPS).length;
    expect(claimed).toBe(caseNames.length);
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

      test(`${meta.fn}'s body enforces its declared gate (${meta.gate})`, () => {
        const fn = findTopLevelFunction(sf, meta.fn);
        const body = functionBody(fn);
        switch (meta.gate) {
          case "isAdminFromEvent":
            expect(
              hasNegatedGateIf(body, sf, "isAdminFromEvent", "throws"),
            ).toBe(true);
            break;
          case "assertAdmin": {
            const calls = collectCalls(body, sf);
            const gateCalls = calls.filter((c) => c.callee === "assertAdmin");
            expect(gateCalls.length).toBeGreaterThanOrEqual(1);
            expect(gateCalls.some((c) => callReceivesBareEvent(c.node))).toBe(
              true,
            );
            break;
          }
          case "callerCanSeeRow":
            expect(
              hasNegatedGateIf(body, sf, "callerCanSeeRow", "returnsNull"),
            ).toBe(true);
            break;
          case "org-scoped-query": {
            // Verified in depth in its own describe block below.
            const calls = collectCalls(body, sf);
            expect(calls.some((c) => c.callee === "extractOrgFromEvent")).toBe(
              true,
            );
            break;
          }
        }
      });
    },
  );

  describe("gate helpers are real enforcement, not stubs", () => {
    test("assertAdmin itself is the negated isAdminFromEvent → throw shape", () => {
      const fn = findTopLevelFunction(sf, "assertAdmin");
      expect(
        hasNegatedGateIf(functionBody(fn), sf, "isAdminFromEvent", "throws"),
      ).toBe(true);
    });

    test("callerCanSeeRow itself admin-bypasses, reads the row org, and compares to the server-derived caller org", () => {
      const fn = findTopLevelFunction(sf, "callerCanSeeRow");
      const calls = collectCalls(functionBody(fn), sf);
      const names = calls.map((c) => c.callee);
      expect(names).toContain("isAdminFromEvent");
      expect(names).toContain("extractOrgFromEvent");
      const ledgerReads = calls.filter(
        (c) =>
          c.callee === "readLedgerAttr" &&
          c.node.arguments.length >= 3 &&
          ts.isStringLiteral(c.node.arguments[1]) &&
          (c.node.arguments[1] as ts.StringLiteral).text === "orgId" &&
          ts.isStringLiteral(c.node.arguments[2]) &&
          (c.node.arguments[2] as ts.StringLiteral).text === "org_id",
      );
      expect(ledgerReads.length).toBeGreaterThanOrEqual(1);
    });
  });

  describe("IAM_INTERNAL_OPS — publishGovernanceFinding is machine-only", () => {
    test("case dispatches to publishGovernanceFinding with the raw `event`", () => {
      const clause = dispatch.cases.get("publishGovernanceFinding");
      expect(clause).toBeDefined();
      const calls = collectCalls(clause as ts.Node, sf);
      const target = calls.filter(
        (c) => c.callee === "publishGovernanceFinding",
      );
      expect(target.length).toBeGreaterThanOrEqual(1);
      expect(target.some((c) => callReceivesBareEvent(c.node))).toBe(true);
    });

    test("its body rejects non-IAM identities: negated isIamIdentity(event.identity) → throw, before any return", () => {
      const fn = findTopLevelFunction(sf, "publishGovernanceFinding");
      const body = functionBody(fn);
      expect(hasNegatedGateIf(body, sf, "isIamIdentity", "throws")).toBe(true);

      const calls = collectCalls(body, sf);
      const gateCalls = calls.filter((c) => c.callee === "isIamIdentity");
      expect(gateCalls.length).toBeGreaterThanOrEqual(1);
      // The gate inspects event.identity specifically.
      expect(
        gateCalls.some((c) => {
          const arg = c.node.arguments[0];
          if (arg === undefined) return false;
          const core = unwrapExpression(arg);
          return (
            ts.isPropertyAccessExpression(core) &&
            ts.isIdentifier(core.expression) &&
            core.expression.text === "event" &&
            core.name.text === "identity"
          );
        }),
      ).toBe(true);

      // Gate precedes every return statement (top-of-function guard).
      let firstReturnStart = Number.POSITIVE_INFINITY;
      walk(body, (n) => {
        if (ts.isReturnStatement(n)) {
          firstReturnStart = Math.min(firstReturnStart, n.getStart(sf));
        }
      });
      const gateStart = Math.min(...gateCalls.map((c) => c.start));
      expect(gateStart).toBeLessThan(firstReturnStart);
    });
  });

  describe("EXEMPT_OPS — getGovernanceMode is a deliberate, total, structural exemption (decision 15d2d3e2)", () => {
    test("the exemption carries its decision reasoning in this guard", () => {
      // A future reader must see a decision, not an oversight: the record
      // itself names the decision and the accepted cost.
      expect(EXEMPT_OPS.getGovernanceMode).toContain("15d2d3e2");
      expect(EXEMPT_OPS.getGovernanceMode).toContain("not tenant data");
    });

    test("the dispatch passes NO arguments to getGovernanceMode (the callee cannot see the caller)", () => {
      const clause = dispatch.cases.get("getGovernanceMode");
      expect(clause).toBeDefined();
      const calls = collectCalls(clause as ts.Node, sf);
      const target = calls.filter((c) => c.callee === "getGovernanceMode");
      expect(target).toHaveLength(1);
      expect(target[0].node.arguments).toHaveLength(0);
    });

    test("getGovernanceMode's signature takes zero parameters", () => {
      const fn = findTopLevelFunction(sf, "getGovernanceMode");
      expect(fn.parameters).toHaveLength(0);
    });

    test("getGovernanceMode's body calls no gate at all — the exemption is total", () => {
      const fn = findTopLevelFunction(sf, "getGovernanceMode");
      const names = collectCalls(functionBody(fn), sf).map((c) => c.callee);
      for (const gate of ALL_GATE_NAMES) {
        expect(names).not.toContain(gate);
      }
    });
  });

  describe("slice-3 ordering — the gate or org-scoped query precedes the data access (decisions 7b3f4fe2 / 2dd461f6)", () => {
    test("listGovernanceFindings derives the caller org BEFORE any dynamodb.send", () => {
      const fn = findTopLevelFunction(sf, "listGovernanceFindings");
      const calls = collectCalls(functionBody(fn), sf);
      const orgCalls = calls.filter((c) => c.callee === "extractOrgFromEvent");
      const sends = calls.filter((c) => c.callee === "dynamodb.send");
      expect(orgCalls.length).toBeGreaterThanOrEqual(1);
      expect(sends.length).toBeGreaterThanOrEqual(1);
      const firstOrg = Math.min(...orgCalls.map((c) => c.start));
      const firstSend = Math.min(...sends.map((c) => c.start));
      expect(firstOrg).toBeLessThan(firstSend);
    });

    test("listGovernanceFindings' non-admin branch Queries the org-index keyed on the caller org (not filter-after-Scan)", () => {
      const fn = findTopLevelFunction(sf, "listGovernanceFindings");
      const props = collectStringPropertyAssignments(functionBody(fn), sf);
      expect(
        props.some((p) => p.name === "IndexName" && p.value === "org-index"),
      ).toBe(true);
      expect(
        props.some(
          (p) =>
            p.name === "KeyConditionExpression" && p.value === "orgId = :orgId",
        ),
      ).toBe(true);
    });

    test("listGovernanceFindings' workflowId GSI path org-checks fetched rows via readLedgerAttr('orgId'/'org_id')", () => {
      const fn = findTopLevelFunction(sf, "listGovernanceFindings");
      const calls = collectCalls(functionBody(fn), sf);
      const rowOrgReads = calls.filter(
        (c) =>
          c.callee === "readLedgerAttr" &&
          c.node.arguments.length >= 3 &&
          ts.isStringLiteral(c.node.arguments[1]) &&
          (c.node.arguments[1] as ts.StringLiteral).text === "orgId" &&
          ts.isStringLiteral(c.node.arguments[2]) &&
          (c.node.arguments[2] as ts.StringLiteral).text === "org_id",
      );
      expect(rowOrgReads.length).toBeGreaterThanOrEqual(1);
    });

    test("getGovernanceFinding gates via callerCanSeeRow BEFORE projecting the row", () => {
      const fn = findTopLevelFunction(sf, "getGovernanceFinding");
      const calls = collectCalls(functionBody(fn), sf);
      const gates = calls.filter((c) => c.callee === "callerCanSeeRow");
      const projections = calls.filter((c) => c.callee === "projectFinding");
      expect(gates.length).toBeGreaterThanOrEqual(1);
      expect(projections.length).toBeGreaterThanOrEqual(1);
      expect(Math.min(...gates.map((c) => c.start))).toBeLessThan(
        Math.min(...projections.map((c) => c.start)),
      );
    });

    test("getDecisionTrace gates via callerCanSeeRow BEFORE projection and BEFORE the cross-table execution pivot", () => {
      const fn = findTopLevelFunction(sf, "getDecisionTrace");
      const calls = collectCalls(functionBody(fn), sf);
      const gates = calls.filter((c) => c.callee === "callerCanSeeRow");
      const projections = calls.filter((c) => c.callee === "projectFinding");
      const pivots = calls.filter((c) => c.callee === "findExecutionIdByRunId");
      expect(gates.length).toBeGreaterThanOrEqual(1);
      expect(projections.length).toBeGreaterThanOrEqual(1);
      expect(pivots.length).toBeGreaterThanOrEqual(1);
      const firstGate = Math.min(...gates.map((c) => c.start));
      expect(firstGate).toBeLessThan(
        Math.min(...projections.map((c) => c.start)),
      );
      expect(firstGate).toBeLessThan(Math.min(...pivots.map((c) => c.start)));
    });
  });

  describe("AST inspection is immune to gate names in comments and string literals (the reason this guard is not text-matching)", () => {
    test("real file: getDecisionTrace's raw text names callerCanSeeRow more than once (prose comment + code), but exactly ONE real call exists", () => {
      const fn = findTopLevelFunction(sf, "getDecisionTrace");
      const body = functionBody(fn);
      const rawOccurrences =
        body.getText(sf).split("callerCanSeeRow").length - 1;
      expect(rawOccurrences).toBeGreaterThanOrEqual(2); // a text-matcher would double-count
      const astCalls = collectCalls(body, sf).filter(
        (c) => c.callee === "callerCanSeeRow",
      );
      expect(astCalls).toHaveLength(1);
    });

    test("real file: listGovernanceFindings' raw text names extractOrgFromEvent more than once (prose comment + code), but exactly ONE real call exists", () => {
      const fn = findTopLevelFunction(sf, "listGovernanceFindings");
      const body = functionBody(fn);
      const rawOccurrences =
        body.getText(sf).split("extractOrgFromEvent").length - 1;
      expect(rawOccurrences).toBeGreaterThanOrEqual(2);
      const astCalls = collectCalls(body, sf).filter(
        (c) => c.callee === "extractOrgFromEvent",
      );
      expect(astCalls).toHaveLength(1);
    });

    test("synthetic: gate names appearing ONLY in comments and string literals produce zero call sites and no gate-if", () => {
      const snippet = [
        "async function decoy(event: unknown): Promise<null> {",
        "  // isAdminFromEvent(event) must gate this — prose only.",
        '  const a = "assertAdmin(event)";',
        "  const b = `callerCanSeeRow(row, event)`;",
        "  /* extractOrgFromEvent(event) and isIamIdentity(event.identity) in a block comment */",
        '  const c = "if (!isAdminFromEvent(event)) { throw new Error(); }";',
        "  return null;",
        "}",
      ].join("\n");
      const decoySf = parseSource(snippet, "decoy.ts");
      const decoyFn = findTopLevelFunction(decoySf, "decoy");
      const names = collectCalls(functionBody(decoyFn), decoySf).map(
        (c) => c.callee,
      );
      for (const gate of ALL_GATE_NAMES) {
        expect(names).not.toContain(gate);
      }
      expect(
        hasNegatedGateIf(
          functionBody(decoyFn),
          decoySf,
          "isAdminFromEvent",
          "throws",
        ),
      ).toBe(false);
    });

    test("synthetic: the same helpers DO detect a real gate call (immunity is not blindness)", () => {
      const snippet = [
        "async function real(event: unknown): Promise<void> {",
        "  if (!isAdminFromEvent(event)) {",
        '    throw new Error("Forbidden: admin required");',
        "  }",
        "}",
      ].join("\n");
      const realSf = parseSource(snippet, "real.ts");
      const realFn = findTopLevelFunction(realSf, "real");
      expect(
        hasNegatedGateIf(
          functionBody(realFn),
          realSf,
          "isAdminFromEvent",
          "throws",
        ),
      ).toBe(true);
      const names = collectCalls(functionBody(realFn), realSf).map(
        (c) => c.callee,
      );
      expect(names).toContain("isAdminFromEvent");
    });
  });
});
