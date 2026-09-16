/**
 * Enumeration-completeness guard for agent-config-resolver.ts's dispatch
 * switch (finding 1fcfd11e), modeled on
 * governance-ui-resolver-dispatch-gate-enumeration.test.ts.
 *
 * Root defect closed by finding 1fcfd11e: deleteAgentConfigRegistry,
 * publishAgentManifestRegistry, and activateProjectAgents took NO event at
 * all (any authenticated caller of any org could delete/publish/activate
 * any org's agents); searchAgentConfigsRegistry had no org filter;
 * updateAgentConfigRegistry never compared the caller's org against the
 * EXISTING record it was about to mutate.
 *
 * Unlike governance-ui-resolver's `case: return await fn(...)` shape, this
 * handler's dispatch is `registryEnabled ? await regFn(event, ...) : await
 * legacyFn(...)` ternaries (Registry path vs. legacy DynamoDB path), plus
 * one case (`activateProjectAgents`) that calls an org gate BEFORE the
 * delegate. The guard therefore derives, per case, the REGISTRY-PATH callee
 * (the branch that actually reaches Registry/tenant data) and checks THAT
 * callee receives a bare `event` argument at the call site — using the same
 * `callReceivesBareEvent` AST technique the task names, adapted to a
 * conditional (ternary) expression instead of a case calling one function
 * directly.
 *
 * Classification:
 *   GATED_AT_CALL_SITE — the dispatch case itself passes `event` (or, for
 *     activateProjectAgents, calls the org-access gate before delegating).
 *   GATED_INSIDE_CALLEE — the case passes only agentId/projectId/query, but
 *     the callee's OWN body performs the org+role reconciliation using a
 *     value it derives independently (not applicable to any current case —
 *     kept as a documented, empty table so a future such case fails loudly
 *     rather than silently passing).
 *   LEGACY_UNGATED — the DynamoDB (non-Registry) fallback path, which this
 *     finding does not touch (legacy per-row org scoping predates the
 *     Registry and is out of scope for 1fcfd11e).
 *
 * A future case added to the dispatch switch without a classification, or a
 * classified Registry-path case whose call site silently drops `event`,
 * fails a named test below instead of shipping ungated-by-omission.
 */
import * as fs from "fs";
import * as path from "path";
import * as ts from "typescript";

const HANDLER_PATH = path.join(__dirname, "..", "agent-config-resolver.ts");

// --- AST helpers (mirrors governance-ui-resolver-dispatch-gate-enumeration) --

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

function findTopLevelFunction(sf: ts.SourceFile, name: string): ts.Node {
  let found: ts.Node | undefined;
  sf.forEachChild((node) => {
    if (
      (ts.isFunctionDeclaration(node) || ts.isVariableStatement(node)) &&
      !found
    ) {
      if (ts.isFunctionDeclaration(node) && node.name?.text === name) {
        found = node;
      } else if (ts.isVariableStatement(node)) {
        for (const decl of node.declarationList.declarations) {
          if (
            ts.isIdentifier(decl.name) &&
            decl.name.text === name &&
            decl.initializer &&
            (ts.isArrowFunction(decl.initializer) ||
              ts.isFunctionExpression(decl.initializer))
          ) {
            found = decl.initializer;
          }
        }
      }
    }
  });
  if (!found) {
    throw new Error(
      `Could not locate top-level declaration '${name}' in ` +
        "agent-config-resolver.ts — structure changed; update this guard.",
    );
  }
  return found;
}

function functionBody(fn: ts.Node): ts.Node {
  const body = (fn as ts.FunctionLikeDeclarationBase).body;
  if (!body) {
    throw new Error("handler has no body — update this guard.");
  }
  return body;
}

function findDispatchSwitch(handlerFn: ts.Node): ts.SwitchStatement {
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
}

function extractDispatch(sw: ts.SwitchStatement): DispatchInfo {
  const cases = new Map<string, ts.CaseClause>();
  let hasDefault = false;
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
    }
  }
  return { cases, hasDefault };
}

/** Unwraps `(x)`, `x as T`, `x!`, `await x` down to the core node. */
function unwrapExpression(node: ts.Node): ts.Node {
  let current: ts.Node = node;
  for (;;) {
    if (ts.isParenthesizedExpression(current)) {
      current = current.expression;
    } else if (ts.isAwaitExpression(current)) {
      current = current.expression;
    } else if (ts.isAsExpression(current) || ts.isNonNullExpression(current)) {
      current = (current as ts.AsExpression | ts.NonNullExpression).expression;
    } else {
      return current;
    }
  }
}

/** True when some argument of `call` is (a wrap of) the bare identifier `event`. */
function callReceivesBareEvent(call: ts.CallExpression): boolean {
  return call.arguments.some((arg) => {
    const core = unwrapExpression(arg);
    return ts.isIdentifier(core) && core.text === "event";
  });
}

/** Finds every call expression under `root` whose callee identifier is `name`. */
function findCallsTo(root: ts.Node, name: string): ts.CallExpression[] {
  const out: ts.CallExpression[] = [];
  walk(root, (n) => {
    if (
      ts.isCallExpression(n) &&
      ts.isIdentifier(n.expression) &&
      n.expression.text === name
    ) {
      out.push(n);
    }
  });
  return out;
}

/**
 * Given a case clause shaped `return registryEnabled ? await regFn(...) :
 * await legacyFn(...);` (optionally preceded by other statements, as with
 * activateProjectAgents's block-form case), returns the ConditionalExpression
 * node, or null if the case has no ternary (e.g. a case that always calls one
 * function regardless of the flag).
 */
function findTernaryInCase(
  clause: ts.CaseClause,
): ts.ConditionalExpression | null {
  let found: ts.ConditionalExpression | null = null;
  walk(clause, (n) => {
    if (!found && ts.isConditionalExpression(n)) {
      found = n;
    }
  });
  return found;
}

/** Extracts the call expression on the "true" (Registry-enabled) branch of a ternary. */
function registryBranchCall(
  ternary: ts.ConditionalExpression,
): ts.CallExpression | null {
  const core = unwrapExpression(ternary.whenTrue);
  return ts.isCallExpression(core) ? core : null;
}

// --- Classification ---------------------------------------------------

/**
 * Registry-path cases whose dispatch call site must pass the bare `event`
 * identifier as an argument to the Registry-path callee. Verified below by
 * parsing the actual ternary in each case, not a hand-transcribed list of
 * callee names.
 */
const GATED_AT_CALL_SITE = [
  "getAgentConfig",
  "createAgentConfig",
  "updateAgentConfig",
  "deleteAgentConfig",
  "publishAgentManifest",
] as const;

/**
 * searchAgentConfigs has no registryEnabled ternary (it is Registry-only,
 * per requirement 9.3) — its case calls searchAgentConfigsRegistry(query,
 * event) directly. Verified by a dedicated test below rather than the
 * ternary-shaped check used for GATED_AT_CALL_SITE.
 */
const SEARCH_OP = "searchAgentConfigs";
const SEARCH_CALLEE = "searchAgentConfigsRegistry";

/**
 * activateProjectAgents has no registryEnabled ternary either: its case is
 * a block that calls `assertProjectOrgAccess(projectId, event)` BEFORE
 * delegating to the (deliberately ungated, internally-reused by
 * intake-orchestration-resolver.ts) activateProjectAgents core. Verified by
 * a dedicated test below.
 */
const ACTIVATE_OP = "activateProjectAgents";
const ACTIVATE_GATE = "assertProjectOrgAccess";
const ACTIVATE_CALLEE = "activateProjectAgents";

/**
 * listAgentConfigs already passed `event` pre-finding (it is the pre-existing
 * org-scoped read from Phase-2a) and is not part of the 1fcfd11e gap list,
 * but is included here for enumeration completeness with the same call-site
 * check as the newly-gated ops.
 */
const PRE_EXISTING_GATED_OP = "listAgentConfigs";

describe("agent-config-resolver — dispatch enumeration completeness (finding 1fcfd11e)", () => {
  const source = fs.readFileSync(HANDLER_PATH, "utf-8");
  const sf = parseSource(source, "agent-config-resolver.ts");
  const handlerFn = findTopLevelFunction(sf, "handler");
  const dispatch = extractDispatch(findDispatchSwitch(handlerFn));
  const caseNames = Array.from(dispatch.cases.keys());

  test("the dispatch switch actually has cases to check (sanity check on the parser itself)", () => {
    expect(caseNames.length).toBe(8);
    expect(caseNames).toEqual(
      expect.arrayContaining([
        "listAgentConfigs",
        "getAgentConfig",
        "createAgentConfig",
        "updateAgentConfig",
        "deleteAgentConfig",
        "publishAgentManifest",
        "searchAgentConfigs",
        "activateProjectAgents",
      ]),
    );
  });

  test("every dispatch case is accounted for by this guard's classification", () => {
    const known = new Set<string>([
      ...GATED_AT_CALL_SITE,
      PRE_EXISTING_GATED_OP,
      SEARCH_OP,
      ACTIVATE_OP,
    ]);
    const unaccounted = caseNames.filter((c) => !known.has(c));
    expect(unaccounted).toEqual([]);
  });

  test("no classification entry references a case that no longer exists in the switch", () => {
    const known = new Set(caseNames);
    const claimed = [
      ...GATED_AT_CALL_SITE,
      PRE_EXISTING_GATED_OP,
      SEARCH_OP,
      ACTIVATE_OP,
    ];
    const stale = claimed.filter((c) => !known.has(c));
    expect(stale).toEqual([]);
  });

  describe.each([...GATED_AT_CALL_SITE, PRE_EXISTING_GATED_OP])(
    "GATED_AT_CALL_SITE['%s'] — Registry-path branch passes bare `event`",
    (fieldName) => {
      test(`${fieldName}'s case has a registryEnabled ternary whose Registry-path branch receives bare event`, () => {
        const clause = dispatch.cases.get(fieldName);
        expect(clause).toBeDefined();
        const ternary = findTernaryInCase(clause as ts.CaseClause);
        expect(ternary).not.toBeNull();
        const call = registryBranchCall(ternary as ts.ConditionalExpression);
        expect(call).not.toBeNull();
        expect(callReceivesBareEvent(call as ts.CallExpression)).toBe(true);
      });
    },
  );

  test(`${SEARCH_OP}'s case calls ${SEARCH_CALLEE}(query, event) — bare event passed directly (no ternary; Registry-only op)`, () => {
    const clause = dispatch.cases.get(SEARCH_OP) as ts.CaseClause;
    expect(clause).toBeDefined();
    const calls = findCallsTo(clause, SEARCH_CALLEE);
    expect(calls.length).toBeGreaterThan(0);
    expect(calls.some((c) => callReceivesBareEvent(c))).toBe(true);
  });

  test(`${ACTIVATE_OP}'s case calls ${ACTIVATE_GATE}(projectId, event) BEFORE delegating to ${ACTIVATE_CALLEE}`, () => {
    const clause = dispatch.cases.get(ACTIVATE_OP) as ts.CaseClause;
    expect(clause).toBeDefined();

    const gateCalls = findCallsTo(clause, ACTIVATE_GATE);
    expect(gateCalls.length).toBe(1);
    expect(callReceivesBareEvent(gateCalls[0])).toBe(true);

    const delegateCalls = findCallsTo(clause, ACTIVATE_CALLEE).filter(
      (c) => c !== gateCalls[0],
    );
    expect(delegateCalls.length).toBeGreaterThan(0);

    // Ordering: the gate call must textually precede the delegate call —
    // a case that calls the gate but ignores its rejection (e.g. by
    // delegating first) would defeat the whole point of the gate.
    expect(gateCalls[0].getStart(sf)).toBeLessThan(
      delegateCalls[0].getStart(sf),
    );
  });

  test(`${ACTIVATE_OP}'s dispatch-level gate call does NOT itself receive a hard-coded projectId literal (must thread the real client-supplied value)`, () => {
    const clause = dispatch.cases.get(ACTIVATE_OP) as ts.CaseClause;
    const gateCalls = findCallsTo(clause, ACTIVATE_GATE);
    expect(gateCalls[0].arguments.length).toBeGreaterThanOrEqual(2);
    const firstArg = unwrapExpression(gateCalls[0].arguments[0]);
    expect(ts.isStringLiteral(firstArg)).toBe(false);
  });
});
