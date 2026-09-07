/**
 * app-access-control-dead-code-guard.test.ts — prevents re-arming the
 * booby trap closed by finding 603e732f.
 *
 * Finding 603e732f: `app-access-control.ts` held a parallel DynamoDB
 * ACCESS#-row access-control implementation (checkAppAccess,
 * checkOperationAccess, grantAppAccess, revokeAppAccess, autoAssignOwner)
 * with ZERO production writers — access is granted/revoked exclusively via
 * the Registry manifest's `access` map (writeManifestMutation in
 * registry-agent-record-resolver.ts). The module's one LIVE reader,
 * listAppAccessEntries, was wired into the resolver's dispatch and read
 * that empty, writer-less DynamoDB store via a `GroupIndex` GSI — so
 * listing always returned `[]` even when grants existed in the manifest.
 * The whole module (and its two test files) was deleted; the resolver's
 * `listAppAccessEntries` now reads `manifest.access` directly.
 *
 * This guard has two independent jobs, both AST-based (per the repo
 * lesson that plain regex text-matching is defeated by tokens that appear
 * in comments or string literals — the dispatch-gate-enumeration guards
 * already establish this convention for this resolver, and the trap
 * removed here is close enough in shape that a text-matching guard could
 * pass while a re-armed version paraphrases its way past a literal
 * substring check):
 *
 *   1. NOTHING imports from a module named `app-access-control` (in any
 *      relative form) anywhere in application code. Detected by parsing
 *      every .ts/.tsx file under src/ with the TypeScript compiler and
 *      walking its `ImportDeclaration` / `ExportDeclaration` /
 *      call-expression `require(...)` module-specifier nodes — not by
 *      grepping for the string "app-access-control", which would also
 *      match this file's own descriptive prose (see the module-surface
 *      test below, which legitimately needs to reference the deleted
 *      exports by name for its own assertions).
 *   2. NO file re-introduces a DynamoDB `GroupIndex` GSI query for an
 *      `ACCESS#` sort-key prefix — the exact query shape
 *      `queryAccessEntries` used (`IndexName: 'GroupIndex'`,
 *      `begins_with(sortId, ...)` against a value containing `ACCESS#`).
 *      Detected structurally: for every `new QueryCommand(...)` /
 *      `new QueryCommandInput`-shaped object-literal argument found via
 *      AST traversal, check whether its `IndexName` property's literal
 *      value is `"GroupIndex"` AND its `ExpressionAttributeValues` (or
 *      any string literal within the whole call-expression subtree)
 *      contains the literal substring `ACCESS#`. This is deliberately
 *      still a targeted structural check rather than a full data-flow
 *      analysis (out of scope for a guard test), but it inspects the AST
 *      node contents rather than raw source text, so a value hidden
 *      inside a comment (e.g. this file's own header, which mentions
 *      `GroupIndex` and `ACCESS#` in prose) is NOT visible to it — the
 *      comment-defeat scenario the repo lesson warns about.
 *
 * Scope: src/lambda/**\/*.ts and src/lambda/**\/*.tsx, excluding
 * __tests__ and fixtures (a test file is allowed to reference the
 * deleted module by name in an assertion string, as this file itself
 * does below — that is not a production import).
 */
import * as fs from "fs";
import * as os from "os";
import * as path from "path";
import * as ts from "typescript";

const REPO_ROOT = path.resolve(__dirname, "../../..");
const SCAN_DIR = path.join("src", "lambda");
const DELETED_MODULE_BASENAME = "app-access-control";

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

function parseSourceFile(filePath: string): ts.SourceFile {
  const text = fs.readFileSync(filePath, "utf-8");
  return ts.createSourceFile(
    filePath,
    text,
    ts.ScriptTarget.ESNext,
    /* setParentNodes */ true,
    filePath.endsWith(".tsx") ? ts.ScriptKind.TSX : ts.ScriptKind.TS,
  );
}

/**
 * Returns every module-specifier string this file imports/requires from,
 * derived from real AST nodes (ImportDeclaration.moduleSpecifier,
 * ExportDeclaration.moduleSpecifier, and `require("...")` call
 * expressions) — never from a raw text search, so a specifier mentioned
 * only inside a comment or an unrelated string literal is not counted.
 */
function collectModuleSpecifiers(sf: ts.SourceFile): string[] {
  const specifiers: string[] = [];

  function visit(node: ts.Node): void {
    if (
      (ts.isImportDeclaration(node) || ts.isExportDeclaration(node)) &&
      node.moduleSpecifier &&
      ts.isStringLiteral(node.moduleSpecifier)
    ) {
      specifiers.push(node.moduleSpecifier.text);
    } else if (
      ts.isCallExpression(node) &&
      ts.isIdentifier(node.expression) &&
      node.expression.text === "require" &&
      node.arguments.length === 1 &&
      ts.isStringLiteral(node.arguments[0])
    ) {
      specifiers.push((node.arguments[0] as ts.StringLiteral).text);
    }
    ts.forEachChild(node, visit);
  }

  visit(sf);
  return specifiers;
}

/** True if a module-specifier string resolves to the deleted module,
 * regardless of relative-path prefix (./, ../, ../../utils/, etc.) or
 * an accidental .ts/.js extension on the specifier. */
function referencesDeletedModule(specifier: string): boolean {
  const base = path.posix.basename(specifier).replace(/\.(t|j)sx?$/, "");
  return base === DELETED_MODULE_BASENAME;
}

/**
 * Walks every `new QueryCommand(...)`-shaped call expression (matched by
 * constructor identifier name, not by string content) and inspects its
 * object-literal argument's AST properties directly: flags a match only
 * when an `IndexName` property's literal value is exactly "GroupIndex"
 * AND some string literal anywhere within that same call expression's
 * argument subtree contains "ACCESS#". Both conditions are read from
 * AST node values (string literal `.text`), not raw source text, so a
 * comment mentioning both tokens without an actual QueryCommand node does
 * not trip this function.
 */
function findAccessRowGsiQueries(sf: ts.SourceFile): ts.Node[] {
  const hits: ts.Node[] = [];

  function stringLiteralsIn(node: ts.Node): string[] {
    const out: string[] = [];
    function inner(n: ts.Node): void {
      if (ts.isStringLiteral(n) || ts.isNoSubstitutionTemplateLiteral(n)) {
        out.push(n.text);
      }
      ts.forEachChild(n, inner);
    }
    inner(node);
    return out;
  }

  function findIndexNameLiteral(
    objLiteral: ts.ObjectLiteralExpression,
  ): string | undefined {
    for (const prop of objLiteral.properties) {
      if (
        ts.isPropertyAssignment(prop) &&
        ts.isIdentifier(prop.name) &&
        prop.name.text === "IndexName" &&
        ts.isStringLiteral(prop.initializer)
      ) {
        return prop.initializer.text;
      }
    }
    return undefined;
  }

  function visit(node: ts.Node): void {
    if (
      ts.isNewExpression(node) &&
      ts.isIdentifier(node.expression) &&
      node.expression.text === "QueryCommand" &&
      node.arguments &&
      node.arguments.length === 1 &&
      ts.isObjectLiteralExpression(node.arguments[0])
    ) {
      const arg = node.arguments[0] as ts.ObjectLiteralExpression;
      const indexName = findIndexNameLiteral(arg);
      const literals = stringLiteralsIn(arg);
      const referencesAccessRowPrefix = literals.some((s) =>
        s.includes("ACCESS#"),
      );
      if (indexName === "GroupIndex" && referencesAccessRowPrefix) {
        hits.push(node);
      }
    }
    ts.forEachChild(node, visit);
  }

  visit(sf);
  return hits;
}

function scan(): {
  importViolations: string[];
  gsiViolations: string[];
} {
  const importViolations: string[] = [];
  const gsiViolations: string[] = [];

  for (const file of listSourceFiles(SCAN_DIR)) {
    const relPath = path.relative(REPO_ROOT, file);
    const sf = parseSourceFile(file);

    const specifiers = collectModuleSpecifiers(sf);
    if (specifiers.some(referencesDeletedModule)) {
      importViolations.push(relPath);
    }

    if (findAccessRowGsiQueries(sf).length > 0) {
      gsiViolations.push(relPath);
    }
  }

  return { importViolations, gsiViolations };
}

describe("app-access-control dead-code guard (finding 603e732f)", () => {
  it("no application file imports/requires the deleted app-access-control module", () => {
    const { importViolations } = scan();
    expect(importViolations).toEqual([]);
  });

  it("no application file issues a GroupIndex QueryCommand against an ACCESS# sort-key prefix (the deleted store's exact query shape)", () => {
    const { gsiViolations } = scan();
    expect(gsiViolations).toEqual([]);
  });

  it("the deleted module's source file no longer exists on disk", () => {
    const deletedPath = path.join(
      REPO_ROOT,
      "src",
      "lambda",
      "app-access-control.ts",
    );
    expect(fs.existsSync(deletedPath)).toBe(false);
  });

  it("bites: an AST-detectable import of app-access-control in a scratch file IS flagged", () => {
    const scratchDir = fs.mkdtempSync(
      path.join(os.tmpdir(), "app-access-control-guard-import-"),
    );
    try {
      const scratchFile = path.join(scratchDir, "planted-import.ts");
      fs.writeFileSync(
        scratchFile,
        [
          'import { listAppAccessEntries } from "./app-access-control";',
          "export { listAppAccessEntries };",
        ].join("\n"),
      );
      const sf = parseSourceFile(scratchFile);
      const specifiers = collectModuleSpecifiers(sf);
      expect(specifiers.some(referencesDeletedModule)).toBe(true);
    } finally {
      fs.rmSync(scratchDir, { recursive: true, force: true });
    }
  });

  it("bites: a re-armed GroupIndex/ACCESS# QueryCommand in a scratch file IS flagged, even split across a differently-named helper", () => {
    const scratchDir = fs.mkdtempSync(
      path.join(os.tmpdir(), "app-access-control-guard-gsi-"),
    );
    try {
      const scratchFile = path.join(scratchDir, "planted-gsi-reader.ts");
      fs.writeFileSync(
        scratchFile,
        [
          'import { QueryCommand } from "@aws-sdk/lib-dynamodb";',
          "",
          "// Deliberately NOT named queryAccessEntries or listAppAccessEntries —",
          "// the guard must catch the query SHAPE, not the function name.",
          "async function fetchGrants(appId: string, deps: { docClient: any; appsTable: string }) {",
          "  return deps.docClient.send(",
          "    new QueryCommand({",
          "      TableName: deps.appsTable,",
          "      IndexName: 'GroupIndex',",
          "      KeyConditionExpression: 'groupId = :gid AND begins_with(sortId, :sk)',",
          "      ExpressionAttributeValues: {",
          "        ':gid': `APP#${appId}`,",
          "        ':sk': 'ACCESS#',",
          "      },",
          "    }),",
          "  );",
          "}",
        ].join("\n"),
      );
      const sf = parseSourceFile(scratchFile);
      expect(findAccessRowGsiQueries(sf).length).toBeGreaterThan(0);
    } finally {
      fs.rmSync(scratchDir, { recursive: true, force: true });
    }
  });

  it("does NOT flag a GroupIndex QueryCommand for an unrelated sort-key prefix (no false positive on GroupIndex reuse for other data)", () => {
    const scratchDir = fs.mkdtempSync(
      path.join(os.tmpdir(), "app-access-control-guard-safe-gsi-"),
    );
    try {
      const scratchFile = path.join(scratchDir, "safe-gsi-reader.ts");
      fs.writeFileSync(
        scratchFile,
        [
          'import { QueryCommand } from "@aws-sdk/lib-dynamodb";',
          "async function fetchMeta(appId: string, deps: { docClient: any; appsTable: string }) {",
          "  return deps.docClient.send(",
          "    new QueryCommand({",
          "      TableName: deps.appsTable,",
          "      IndexName: 'GroupIndex',",
          "      KeyConditionExpression: 'groupId = :gid AND begins_with(sortId, :sk)',",
          "      ExpressionAttributeValues: {",
          "        ':gid': `APP#${appId}`,",
          "        ':sk': 'META#',",
          "      },",
          "    }),",
          "  );",
          "}",
        ].join("\n"),
      );
      const sf = parseSourceFile(scratchFile);
      expect(findAccessRowGsiQueries(sf).length).toBe(0);
    } finally {
      fs.rmSync(scratchDir, { recursive: true, force: true });
    }
  });

  it("does NOT flag a comment that merely mentions GroupIndex and ACCESS# in prose (comment-defeat resistance — the repo lesson this guard is built to satisfy)", () => {
    const scratchDir = fs.mkdtempSync(
      path.join(os.tmpdir(), "app-access-control-guard-comment-fp-"),
    );
    try {
      const scratchFile = path.join(scratchDir, "comment-only.ts");
      fs.writeFileSync(
        scratchFile,
        [
          "/**",
          " * This module intentionally does NOT query the GroupIndex GSI for",
          " * ACCESS# rows — see finding 603e732f. Do not reintroduce that",
          " * pattern here.",
          " */",
          "export function noop(): void {}",
        ].join("\n"),
      );
      const sf = parseSourceFile(scratchFile);
      const specifiers = collectModuleSpecifiers(sf);
      expect(specifiers.some(referencesDeletedModule)).toBe(false);
      expect(findAccessRowGsiQueries(sf).length).toBe(0);
    } finally {
      fs.rmSync(scratchDir, { recursive: true, force: true });
    }
  });

  it("does NOT flag a string literal that merely mentions app-access-control in prose without an actual import/require", () => {
    const scratchDir = fs.mkdtempSync(
      path.join(os.tmpdir(), "app-access-control-guard-string-fp-"),
    );
    try {
      const scratchFile = path.join(scratchDir, "string-only.ts");
      fs.writeFileSync(
        scratchFile,
        [
          'const historicalNote = "see the deleted app-access-control module for context";',
          "export { historicalNote };",
        ].join("\n"),
      );
      const sf = parseSourceFile(scratchFile);
      const specifiers = collectModuleSpecifiers(sf);
      expect(specifiers.some(referencesDeletedModule)).toBe(false);
    } finally {
      fs.rmSync(scratchDir, { recursive: true, force: true });
    }
  });
});
