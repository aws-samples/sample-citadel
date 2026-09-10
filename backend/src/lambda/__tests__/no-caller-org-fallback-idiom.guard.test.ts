/**
 * no-caller-org-fallback-idiom.guard.test.ts — pins closed finding f0ce2b00
 * (high): four resolvers coerced an unresolvable caller org into a
 * CLIENT-SUPPLIED argument via `const effectiveOrgId = callerOrgId ||
 * event.arguments.orgId;` (datastore-resolver.ts listDataStores /
 * getDataStoreStats / listAvailableDataSources; integration-resolver.ts
 * listIntegrations). Because `orgId` is a required argument on all four
 * GraphQL fields, and `adminCreateUser` never sets `custom:organization`
 * (finding cbbc3be1) so a non-admin caller can legitimately have no
 * resolvable org claim, this idiom let such a caller read ANY tenant's
 * rows just by supplying that tenant's orgId — the `||` reads as
 * defensive (falls back to *something*) while actually inverting the
 * trust direction (falls back to attacker-controlled input).
 *
 * This guard is AST-based, per the repo lesson (documented in
 * app-access-control-dead-code-guard.test.ts and this project's
 * steering docs) that a regex over source text is defeated by
 * reformatting, renaming through an intermediate variable, or the
 * pattern being restated inside a comment/string. Parsing with the
 * TypeScript compiler lets the check inspect the actual BinaryExpression
 * shape (`<identifier-or-property-read> || <property-read ending in
 * "orgId" read off an object other than the left operand's own base>`)
 * rather than matching literal text.
 *
 * Detected shape: a `||` binary expression whose:
 *   - LEFT operand is any expression (typically a caller-org identifier,
 *     e.g. `callerOrgId`, or `event.something.orgId` naming the caller),
 *   - RIGHT operand is a property-access expression whose final property
 *     name is exactly `orgId`, AND whose access path contains an
 *     `arguments` segment (`event.arguments.orgId`, `args.orgId`,
 *     `evt.arguments.orgId`, etc. — the "client argument" shape) or is a
 *     bare identifier literally named `orgId` that is not the same
 *     identifier as the left operand (covers a destructured
 *     `{ orgId } = event.arguments` shape feeding
 *     `callerOrgId || orgId`).
 *
 * This intentionally does NOT flag:
 *   - `rowOrgId || !callerOrgId || ...` used as a REJECT condition (e.g.
 *     assertRowOrg in auth-event.ts: `!rowOrgId || !callerOrgId ||
 *     rowOrgId !== callerOrgId`) — the right operand there is a
 *     comparison/negation, not a bare `...orgId` value read off an
 *     arguments-shaped path.
 *   - `a.orgId === callerOrgId || a.orgId === ""` (per-row membership
 *     filters in agent-config-resolver.ts) — the right operand is an
 *     equality comparison, not an `orgId` property read.
 *   - `callerOrgId || suppliedOrgId` in tool-sandbox.ts — structurally
 *     different: the non-admin path already denies above (`!callerOrgId`
 *     and a mismatched `suppliedOrgId` both return an UnauthorizedError
 *     before this line runs), so by the time this line executes for a
 *     non-admin, callerOrgId is already truthy; the fallback only
 *     resolves for admins. Still caught by the RIGHT-operand-shape rule
 *     below only if `suppliedOrgId` were a raw `event.arguments.orgId`
 *     property read — it is a local variable, not a property-access
 *     expression, so it is not flagged. This is a deliberate scope
 *     boundary: this guard targets the specific
 *     property-access-off-arguments shape that caused f0ce2b00, not every
 *     local variable named similarly. If tool-sandbox.ts's admin fallback
 *     is ever rewritten to read `event.arguments.orgId` directly inline,
 *     that WOULD trip this guard (see the bites test below).
 */
import * as fs from "fs";
import * as path from "path";
import * as ts from "typescript";

const REPO_ROOT = path.resolve(__dirname, "../../..");
const SCAN_DIR = path.join("src");

function listSourceFiles(dir: string): string[] {
  const abs = path.join(REPO_ROOT, dir);
  if (!fs.existsSync(abs)) return [];
  const out: string[] = [];
  const stack = [abs];
  while (stack.length > 0) {
    const current = stack.pop()!;
    for (const entry of fs.readdirSync(current, { withFileTypes: true })) {
      if (entry.name === "node_modules" || entry.name === "__tests__") {
        continue;
      }
      const full = path.join(current, entry.name);
      if (entry.isDirectory()) {
        stack.push(full);
      } else if (entry.isFile() && /\.tsx?$/.test(entry.name)) {
        out.push(full);
      }
    }
  }
  return out;
}

function parseSourceFile(filePath: string, text?: string): ts.SourceFile {
  const content = text ?? fs.readFileSync(filePath, "utf-8");
  return ts.createSourceFile(
    filePath,
    content,
    ts.ScriptTarget.ESNext,
    /* setParentNodes */ true,
    filePath.endsWith(".tsx") ? ts.ScriptKind.TSX : ts.ScriptKind.TS,
  );
}

/**
 * True when `node` is a property-access chain (e.g. `event.arguments.orgId`,
 * `args.orgId`) whose FINAL property name is `orgId` and whose access path
 * includes a segment literally named `arguments` OR `args` — the
 * "client-supplied argument" shape. A bare identifier `orgId` is also
 * treated as this shape (covers a destructured `{ orgId } =
 * event.arguments` feeding a same-named local).
 */
function isClientArgumentOrgIdRead(node: ts.Expression): boolean {
  if (ts.isIdentifier(node)) {
    return node.text === "orgId";
  }
  if (!ts.isPropertyAccessExpression(node)) return false;
  if (node.name.text !== "orgId") return false;

  // Walk the access chain collecting every identifier/property name in it.
  const segments: string[] = [];
  let current: ts.Expression = node;
  while (ts.isPropertyAccessExpression(current)) {
    segments.unshift(current.name.text);
    current = current.expression;
  }
  if (ts.isIdentifier(current)) {
    segments.unshift(current.text);
  }
  return segments.some((s) => s === "arguments" || s === "args");
}

/**
 * Returns every `||` BinaryExpression in `sf` whose right operand is a
 * client-argument `orgId` read (per {@link isClientArgumentOrgIdRead})
 * and whose left operand is NOT itself the exact same identifier as the
 * right operand's bare-identifier form (avoids flagging a trivial
 * `orgId || orgId` no-op, which is not the vulnerable shape).
 */
function findCallerOrgFallbackIdioms(sf: ts.SourceFile): ts.Node[] {
  const hits: ts.Node[] = [];

  function visit(node: ts.Node): void {
    if (
      ts.isBinaryExpression(node) &&
      node.operatorToken.kind === ts.SyntaxKind.BarBarToken &&
      isClientArgumentOrgIdRead(node.right)
    ) {
      const leftIsSameBareIdentifier =
        ts.isIdentifier(node.left) &&
        ts.isIdentifier(node.right) &&
        node.left.text === node.right.text;
      if (!leftIsSameBareIdentifier) {
        hits.push(node);
      }
    }
    ts.forEachChild(node, visit);
  }

  visit(sf);
  return hits;
}

function scan(): string[] {
  const violations: string[] = [];
  for (const file of listSourceFiles(SCAN_DIR)) {
    const relPath = path.relative(REPO_ROOT, file);
    const sf = parseSourceFile(file);
    if (findCallerOrgFallbackIdioms(sf).length > 0) {
      violations.push(relPath);
    }
  }
  return violations;
}

describe("no-caller-org-fallback-idiom guard (finding f0ce2b00)", () => {
  it("no file under src/ contains a `<callerOrg> || <client-argument orgId>` fallback expression", () => {
    const violations = scan();
    expect(violations).toEqual([]);
  });

  it("bites: `callerOrgId || event.arguments.orgId` in a scratch file IS flagged", () => {
    const sf = parseSourceFile(
      "scratch.ts",
      [
        "function f(event: any, admin: boolean) {",
        "  const callerOrgId = admin ? null : 'x';",
        "  const effectiveOrgId = callerOrgId || event.arguments.orgId;",
        "  return effectiveOrgId;",
        "}",
      ].join("\n"),
    );
    expect(findCallerOrgFallbackIdioms(sf).length).toBeGreaterThan(0);
  });

  it("bites: `callerOrgId || args.orgId` (shorthand arguments variable name) IS flagged", () => {
    const sf = parseSourceFile(
      "scratch.ts",
      [
        "function f(callerOrgId: string | null, args: { orgId: string }) {",
        "  return callerOrgId || args.orgId;",
        "}",
      ].join("\n"),
    );
    expect(findCallerOrgFallbackIdioms(sf).length).toBeGreaterThan(0);
  });

  it("bites: `someOrg || evt.arguments.orgId` through a differently-named left operand IS flagged (catches the pattern by shape, not by the left-hand variable's name)", () => {
    const sf = parseSourceFile(
      "scratch.ts",
      [
        "function f(someOrg: string | null, evt: any) {",
        "  return someOrg || evt.arguments.orgId;",
        "}",
      ].join("\n"),
    );
    expect(findCallerOrgFallbackIdioms(sf).length).toBeGreaterThan(0);
  });

  it("bites: destructured `{ orgId } = event.arguments` feeding `callerOrgId || orgId` IS flagged", () => {
    const sf = parseSourceFile(
      "scratch.ts",
      [
        "function f(event: any, callerOrgId: string | null) {",
        "  const { orgId } = event.arguments;",
        "  return callerOrgId || orgId;",
        "}",
      ].join("\n"),
    );
    expect(findCallerOrgFallbackIdioms(sf).length).toBeGreaterThan(0);
  });

  it("does NOT flag the reject-not-coerce comparison shape (`!rowOrgId || !callerOrgId || rowOrgId !== callerOrgId`, assertRowOrg's actual gate)", () => {
    const sf = parseSourceFile(
      "scratch.ts",
      [
        "function f(rowOrgId: string | undefined, callerOrgId: string | null) {",
        "  if (!rowOrgId || !callerOrgId || rowOrgId !== callerOrgId) {",
        "    throw new Error('denied');",
        "  }",
        "}",
      ].join("\n"),
    );
    expect(findCallerOrgFallbackIdioms(sf).length).toBe(0);
  });

  it('does NOT flag a per-row membership filter (`a.orgId === callerOrgId || a.orgId === ""`)', () => {
    const sf = parseSourceFile(
      "scratch.ts",
      [
        "function f(rows: { orgId: string }[], callerOrgId: string | null) {",
        "  return rows.filter((a) => a.orgId === callerOrgId || a.orgId === '');",
        "}",
      ].join("\n"),
    );
    expect(findCallerOrgFallbackIdioms(sf).length).toBe(0);
  });

  it("does NOT flag a local-variable fallback that is not itself a client-argument property read (tool-sandbox.ts's admin-only `callerOrgId || suppliedOrgId`, where suppliedOrgId is a destructured local, not an inline `event.arguments.orgId` read)", () => {
    const sf = parseSourceFile(
      "scratch.ts",
      [
        "function f(event: { arguments: { orgId: string } }, callerOrgId: string | null) {",
        "  const suppliedOrgId = event.arguments.orgId;",
        "  return callerOrgId || suppliedOrgId;",
        "}",
      ].join("\n"),
    );
    expect(findCallerOrgFallbackIdioms(sf).length).toBe(0);
  });

  it("does NOT flag a comment that merely mentions the idiom in prose (comment-defeat resistance)", () => {
    const sf = parseSourceFile(
      "scratch.ts",
      [
        "/**",
        " * Do not write `callerOrgId || event.arguments.orgId` here — see",
        " * finding f0ce2b00.",
        " */",
        "export function noop(): void {}",
      ].join("\n"),
    );
    expect(findCallerOrgFallbackIdioms(sf).length).toBe(0);
  });

  it("does NOT flag a trivial `orgId || orgId` no-op (same bare identifier on both sides)", () => {
    const sf = parseSourceFile(
      "scratch.ts",
      [
        "function f(orgId: string | undefined) {",
        "  return orgId || orgId;",
        "}",
      ].join("\n"),
    );
    expect(findCallerOrgFallbackIdioms(sf).length).toBe(0);
  });

  it("the four fixed sites (datastore-resolver.ts listDataStores/getDataStoreStats/listAvailableDataSources, integration-resolver.ts listIntegrations) no longer contain the idiom", () => {
    const fixedFiles = [
      path.join(REPO_ROOT, "src", "lambda", "datastore-resolver.ts"),
      path.join(REPO_ROOT, "src", "lambda", "integration-resolver.ts"),
    ];
    for (const file of fixedFiles) {
      const sf = parseSourceFile(file);
      expect(findCallerOrgFallbackIdioms(sf)).toEqual([]);
    }
  });
});
