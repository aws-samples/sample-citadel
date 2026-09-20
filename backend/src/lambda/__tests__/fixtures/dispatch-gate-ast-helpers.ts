/**
 * Shared AST helpers for the dispatch gate-enumeration guard family
 * (registry-agent-record-resolver-dispatch-gate-enumeration.test.ts and
 * siblings). Extracted verbatim from
 * eval-run-resolver-dispatch-gate-enumeration.test.ts so the newer guards
 * (agent-import / release / environment-release-pointer / release-diff /
 * promotion-policy / tool-approval / agent / model-config / chatter) can
 * derive their dispatch surface from the real resolver source without each
 * re-inlining ~150 lines of identical parsing code.
 *
 * Design rationale (see the eval-run guard's module doc for the long form):
 * deriving the case list from the handler's REAL `switch (fieldName)` (or
 * `if (fieldName === "...")` chain) means a future op added to the dispatch
 * without a corresponding GATED/EXEMPT classification fails LOUDLY instead
 * of silently shipping ungated. Matching call sites via the AST — not via
 * substring search — makes the guards immune to gate names appearing in
 * comments or string literals (verified by
 * dispatch-gate-ast-helpers.test.ts's synthetic decoy tests).
 *
 * Lives under __tests__/fixtures/ so jest imports it without treating it as
 * a test suite (fixtures/ is in testPathIgnorePatterns) — same precedent as
 * workflow-envelope-guard.ts.
 */
import * as ts from "typescript";

export function parseSource(source: string, fileName: string): ts.SourceFile {
  return ts.createSourceFile(
    fileName,
    source,
    ts.ScriptTarget.Latest,
    true,
    ts.ScriptKind.TS,
  );
}

export function walk(node: ts.Node, cb: (n: ts.Node) => void): void {
  cb(node);
  node.forEachChild((child) => walk(child, cb));
}

export function findTopLevelFunction(
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
        `${sf.fileName} — structure changed; update this guard.`,
    );
  }
  return found;
}

/**
 * Locates `export const handler = async (event) => {...}` (with or without
 * an explicit type annotation on `handler`) and returns the arrow body.
 */
export function findHandlerArrowBody(sf: ts.SourceFile): ts.Block {
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
      `Could not locate \`export const handler = async (event) => {...}\` in ` +
        `${sf.fileName} — structure changed; update this guard's parsing.`,
    );
  }
  return found;
}

export function functionBody(fn: ts.FunctionDeclaration): ts.Block {
  if (!fn.body) {
    throw new Error(
      `Function '${fn.name?.text ?? "<anonymous>"}' has no body — ` +
        "update this guard.",
    );
  }
  return fn.body;
}

export interface CallSite {
  callee: string;
  start: number;
  node: ts.CallExpression;
}

export function collectCalls(root: ts.Node, sf: ts.SourceFile): CallSite[] {
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

export interface NewSite {
  className: string;
  start: number;
  node: ts.NewExpression;
}

/** Collects `new <ClassName>(...)` construction sites (e.g. `new PutCommand(...)`). */
export function collectNews(root: ts.Node, sf: ts.SourceFile): NewSite[] {
  const out: NewSite[] = [];
  walk(root, (n) => {
    if (!ts.isNewExpression(n)) return;
    if (ts.isIdentifier(n.expression)) {
      out.push({
        className: n.expression.text,
        start: n.getStart(sf),
        node: n,
      });
    }
  });
  return out;
}

export function unwrapExpression(node: ts.Expression): ts.Expression {
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

export function callReceivesIdentifier(
  call: ts.CallExpression,
  name: string,
): boolean {
  return call.arguments.some((arg) => {
    const core = unwrapExpression(arg);
    return ts.isIdentifier(core) && core.text === name;
  });
}

export function callReceivesBareEvent(call: ts.CallExpression): boolean {
  return callReceivesIdentifier(call, "event");
}

export function callReceivesStringLiteral(
  call: ts.CallExpression,
  value: string,
): boolean {
  return call.arguments.some((arg) => {
    const core = unwrapExpression(arg);
    return ts.isStringLiteral(core) && core.text === value;
  });
}

export function findDispatchSwitch(
  handlerBody: ts.Block,
  switchIdentifier = "fieldName",
): ts.SwitchStatement {
  let sw: ts.SwitchStatement | undefined;
  walk(handlerBody, (n) => {
    if (
      !sw &&
      ts.isSwitchStatement(n) &&
      ts.isIdentifier(n.expression) &&
      n.expression.text === switchIdentifier
    ) {
      sw = n;
    }
  });
  if (!sw) {
    throw new Error(
      `Could not locate \`switch (${switchIdentifier})\` inside handler() — ` +
        "dispatch structure changed; update this guard's parsing.",
    );
  }
  return sw;
}

export interface DispatchInfo {
  cases: Map<string, ts.CaseClause>;
  hasDefault: boolean;
  defaultClause: ts.DefaultClause | null;
}

export function extractDispatch(sw: ts.SwitchStatement): DispatchInfo {
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

export interface FieldNameComparison {
  literal: string;
  operator: "===" | "!==";
  node: ts.BinaryExpression;
}

/**
 * For handlers that dispatch via `if (fieldName === "op")` /
 * `if (fieldName !== "op") throw` instead of a switch (task-runner-resolver,
 * fabricator-request-resolver, tool-approval-resolver): collects every
 * strict comparison of `<identifierName>` against a string literal. The set
 * of compared literals IS the dispatch surface — derived from source, not
 * hand-maintained.
 */
export function collectFieldNameComparisons(
  root: ts.Node,
  identifierName = "fieldName",
): FieldNameComparison[] {
  const out: FieldNameComparison[] = [];
  walk(root, (n) => {
    if (!ts.isBinaryExpression(n)) return;
    const op = n.operatorToken.kind;
    if (
      op !== ts.SyntaxKind.EqualsEqualsEqualsToken &&
      op !== ts.SyntaxKind.ExclamationEqualsEqualsToken
    ) {
      return;
    }
    const sides = [
      [n.left, n.right],
      [n.right, n.left],
    ] as const;
    for (const [idSide, litSide] of sides) {
      const id = unwrapExpression(idSide);
      const lit = unwrapExpression(litSide);
      if (
        ts.isIdentifier(id) &&
        id.text === identifierName &&
        ts.isStringLiteral(lit)
      ) {
        out.push({
          literal: lit.text,
          operator:
            op === ts.SyntaxKind.EqualsEqualsEqualsToken ? "===" : "!==",
          node: n,
        });
        return;
      }
    }
  });
  return out;
}

export function containsThrow(node: ts.Node): boolean {
  let throws = false;
  walk(node, (n) => {
    if (ts.isThrowStatement(n)) throws = true;
  });
  return throws;
}

/**
 * Collects the initializer text of every `<propName>: <initializer>`
 * property assignment under `root` (e.g. to assert a persisted row's
 * `orgId:` is always the server-derived `callerOrgId`, never client input).
 */
export function collectPropertyAssignments(
  root: ts.Node,
  propName: string,
  sf: ts.SourceFile,
): string[] {
  const out: string[] = [];
  walk(root, (n) => {
    if (!ts.isPropertyAssignment(n)) return;
    const name = n.name;
    const text = ts.isIdentifier(name)
      ? name.text
      : ts.isStringLiteral(name)
        ? name.text
        : null;
    if (text === propName) {
      out.push(n.initializer.getText(sf));
    }
  });
  return out;
}
