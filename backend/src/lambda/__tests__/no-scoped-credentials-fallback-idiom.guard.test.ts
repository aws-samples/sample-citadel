/**
 * no-scoped-credentials-fallback-idiom.guard.test.ts — Citadel PR-1 (H4):
 * pins closed the `scopedCredentials || credentials` idiom in
 * datastore-resolver.ts. Before this PR, every adapter dispatch site
 * (`adapter.provision!(config, scopedCredentials || credentials)`,
 * `adapter.connect(config, scopedCredentials || credentials)`,
 * `adapter.getMetrics!(config, resourceArn, scopedCredentials ||
 * credentials)`) fell back to the CALLER-SUPPLIED `credentials` (parsed
 * from `input.credentials`, an attacker-controlled GraphQL argument)
 * whenever no scoped role was vended for that adapter — which was exactly
 * the KnowledgeBaseAdapter's CREATE_NEW connect path, since
 * `requiredPolicies().provision` returned an empty array (CIT-299),
 * so `scopedCredentials` stayed `undefined` and the caller's raw
 * credentials reached `adapter.provision!`.
 *
 * AST-based per this project's established guard pattern (regex over
 * source text is defeated by reformatting/renaming) — detects a `||`
 * BinaryExpression whose LEFT operand is an identifier named
 * `scopedCredentials` and whose RIGHT operand is an identifier named
 * `credentials`.
 */
import * as path from "path";
import * as ts from "typescript";
import {
  listSourceFiles,
  readSourceFileOrNull,
} from "./fixtures/source-file-walker";

const REPO_ROOT = path.resolve(__dirname, "../../..");
const SCAN_DIR = path.join("src");

function parseSourceFile(
  filePath: string,
  text?: string,
): ts.SourceFile | null {
  const content = text ?? readSourceFileOrNull(filePath);
  if (content === null) return null;
  return ts.createSourceFile(
    filePath,
    content,
    ts.ScriptTarget.ESNext,
    true,
    filePath.endsWith(".tsx") ? ts.ScriptKind.TSX : ts.ScriptKind.TS,
  );
}

function findScopedCredentialsFallbackIdioms(sf: ts.SourceFile): ts.Node[] {
  const hits: ts.Node[] = [];
  function visit(node: ts.Node): void {
    if (
      ts.isBinaryExpression(node) &&
      node.operatorToken.kind === ts.SyntaxKind.BarBarToken &&
      ts.isIdentifier(node.left) &&
      node.left.text === "scopedCredentials" &&
      ts.isIdentifier(node.right) &&
      node.right.text === "credentials"
    ) {
      hits.push(node);
    }
    ts.forEachChild(node, visit);
  }
  visit(sf);
  return hits;
}

function scan(): string[] {
  const violations: string[] = [];
  for (const file of listSourceFiles(path.join(REPO_ROOT, SCAN_DIR))) {
    const relPath = path.relative(REPO_ROOT, file);
    const sf = parseSourceFile(file);
    if (sf === null) continue;
    if (findScopedCredentialsFallbackIdioms(sf).length > 0) {
      violations.push(relPath);
    }
  }
  return violations;
}

describe("no-scoped-credentials-fallback-idiom guard (Citadel PR-1, H4)", () => {
  it("no file under src/ contains a `scopedCredentials || credentials` fallback expression", () => {
    expect(scan()).toEqual([]);
  });

  it("bites: `scopedCredentials || credentials` in a scratch file IS flagged", () => {
    const sf = parseSourceFile(
      "scratch.ts",
      [
        "function f(scopedCredentials: unknown, credentials: unknown) {",
        "  return scopedCredentials || credentials;",
        "}",
      ].join("\n"),
    )!;
    expect(findScopedCredentialsFallbackIdioms(sf).length).toBeGreaterThan(0);
  });

  it("does NOT flag `scopedCredentials ?? credentials` (nullish coalescing is a different operator)", () => {
    const sf = parseSourceFile(
      "scratch.ts",
      [
        "function f(scopedCredentials: unknown, credentials: unknown) {",
        "  return scopedCredentials ?? credentials;",
        "}",
      ].join("\n"),
    )!;
    expect(findScopedCredentialsFallbackIdioms(sf).length).toBe(0);
  });

  it("does NOT flag unrelated `||` expressions with similarly-named but different identifiers", () => {
    const sf = parseSourceFile(
      "scratch.ts",
      [
        "function f(scoped: unknown, creds: unknown) {",
        "  return scoped || creds;",
        "}",
      ].join("\n"),
    )!;
    expect(findScopedCredentialsFallbackIdioms(sf).length).toBe(0);
  });

  it("datastore-resolver.ts no longer contains the idiom", () => {
    const file = path.join(REPO_ROOT, "src", "lambda", "datastore-resolver.ts");
    const sf = parseSourceFile(file)!;
    expect(findScopedCredentialsFallbackIdioms(sf)).toEqual([]);
  });
});
