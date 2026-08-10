/**
 * release-store-choke-point.guard.test.ts — mechanical guard enforcing
 * that release-store.ts is the SOLE write choke point for
 * AgentReleasesTable (design §2, L1). Modeled on
 * eval-no-composite.guard.test.ts's scanning precedent (steering: "Never
 * use empty catch{} around DB writes" — same technique, different
 * forbidden pattern), which closes the exact bypass class the eval
 * tables suffered from: a seeder/healer/migration issuing a raw
 * Put/Update/Delete against the table outside its owning resolver.
 *
 * Scope note: CDK infrastructure (lib/*.ts) legitimately DEFINES the
 * table and its IAM floor — that is not a write-path bypass, it is the
 * resource declaration. The guard therefore scans APPLICATION code only
 * (src/lambda/**, excluding release-store.ts itself and __tests__), for
 * two independent bypass signatures:
 *  (a) STATIC SCAN — any file that both (i) imports
 *      PutCommand/UpdateCommand/DeleteCommand from
 *      @aws-sdk/lib-dynamodb (or the low-level @aws-sdk/client-dynamodb
 *      equivalents) AND (ii) references the AGENT_RELEASES_TABLE env var
 *      or the literal table name prefix. Either signal alone is not
 *      proof of a raw write (e.g. a file might read the env var to pass
 *      it elsewhere), but the combination is the exact shape of a bypass
 *      write.
 *  (b) BEHAVIORAL/bite-proof — a scratch file combining both signatures
 *      must be flagged by the scanner, proving it is not a no-op.
 *
 * release-store.ts itself is required to export ONLY putRelease and
 * getRelease — no update, no delete — asserted directly (belt-and-
 * suspenders with release-store.test.ts's module-surface test).
 *
 * Comment-stripping (finding 3af95c1a, hardened by finding 7d3e6f47): the
 * scanner strips line comments (//...) and block comments (incl. JSDoc
 * /** ... *\/) from each file's content before pattern matching, so it
 * tests CODE, not prose. This closed a real false positive: a comment
 * that merely named a write command and the releases table together (no
 * write present) failed the build. Detection did NOT get weaker — the
 * planted-write bite tests below still require the scanner to catch a
 * real bypass, and stripping comments cannot hide an actual write, since
 * a write must be executable code, not a comment.
 *
 * Comment-stripping uses the TypeScript compiler's own scanner
 * (`ts.transpileModule` with `removeComments: true`), not a hand-rolled
 * character walker. A hand-rolled walker regressed detection (finding
 * 7d3e6f47): it could not disambiguate a regex literal's `/` from a
 * comment delimiter using only local context, so a benign regex literal
 * like `/\/*$/` was misread as opening a block comment, silently
 * swallowing the rest of the file — including a real planted write — to
 * EOF. The TS compiler's lexer performs grammar-aware regex-vs-comment
 * disambiguation and cannot be fooled this way; identifiers, keywords,
 * and string/template literal content pass through transpilation
 * unchanged (only comments and TS-only syntax are elided).
 *
 * String literals are DELIBERATELY KEPT IN SCOPE (not stripped), because
 * they are load-bearing for detection, not just prose surface area.
 * Investigation of every real write site under src/lambda (release-store.ts,
 * the sole owning file) found the table is referenced via the
 * AGENT_RELEASES_TABLE env var, never a literal table-name string in
 * application code. TABLE_NAME_LITERAL_RE therefore exists as an
 * independent secondary signal for a DIFFERENT bypass shape than the one
 * that caused the false positive: a hypothetical future write that
 * hardcodes the table name literal instead of reading the env var (e.g.
 * to dodge an env-var-only check). If string literals were stripped
 * before scanning, a planted write of the form
 * `new PutCommand({ TableName: "citadel-agent-releases-dev", ... })`
 * would be invisible to the guard — a real regression in detection
 * strength. Comments cannot smuggle a write (they are not executed);
 * string literals CAN be the exact mechanism a bypass uses, so they stay
 * in scope. This decision is re-verified by the "bites: a literal
 * table-name string combined with a write command is still detected"
 * test below.
 */
import * as fs from "fs";
import * as os from "os";
import * as path from "path";
import * as ts from "typescript";
import * as releaseStore from "../release-store";

const REPO_ROOT = path.resolve(__dirname, "../../..");
const OWNING_FILE = path.join("src", "lambda", "release-store.ts");
const TABLE_ENV_VAR = "AGENT_RELEASES_TABLE";
const TABLE_NAME_LITERAL_RE = /citadel-agent-releases-/;
const WRITE_COMMAND_RE =
  /\b(PutCommand|UpdateCommand|DeleteCommand|PutItemCommand|UpdateItemCommand|DeleteItemCommand)\b/;

/**
 * Strips line comments (//...) and block comments (/* ... *\/, including
 * JSDoc /** ... *\/) from source text before pattern matching, so the
 * guard scans code, not prose. String literals are intentionally NOT
 * stripped (see header comment above for why).
 *
 * Finding 7d3e6f47 (regression from the original finding 3af95c1a fix):
 * a hand-rolled character-walking lexer cannot tell a regex literal's
 * `/` from a division operator or a comment delimiter using only local
 * context, because that disambiguation depends on the preceding token
 * (regex literals are only legal where an expression is expected, e.g.
 * after `(`, `,`, `return`, `=`, etc. — never after an identifier or
 * `)`). A file containing a benign regex literal like `/\/*$/` has a
 * `/*` inside it that a naive walker misreads as opening a block
 * comment, silently swallowing the rest of the file (including any
 * planted write) to EOF. This is exactly the kind of "quieter, not
 * smarter" regression the brief warns against — it must never
 * reoccur.
 *
 * Fix: delegate comment-stripping to the TypeScript compiler's own
 * scanner via `ts.transpileModule` with `removeComments: true`.
 * `typescript` is already a devDependency, and the compiler's lexer
 * performs real regex-vs-comment-vs-division disambiguation using
 * grammar context, so it cannot be fooled by a regex literal containing
 * `/*` or `//`. Identifiers, keywords, and string/template literal
 * content are preserved verbatim through transpilation (only comments
 * and TS-specific syntax such as type annotations are elided), so
 * TABLE_ENV_VAR / TABLE_NAME_LITERAL_RE / WRITE_COMMAND_RE matching
 * against the transpiled output is equivalent to matching against the
 * original source with comments removed.
 */
function stripComments(source: string): string {
  const { outputText } = ts.transpileModule(source, {
    compilerOptions: {
      module: ts.ModuleKind.ESNext,
      target: ts.ScriptTarget.ESNext,
      removeComments: true,
      // Preserve JSX text as-is; guard scans .ts/.tsx application code
      // and no JSX is expected under src/lambda, but this keeps
      // transpilation from erroring out if it ever appears.
      jsx: ts.JsxEmit.Preserve,
    },
    reportDiagnostics: false,
  });
  return outputText;
}

/** Only application code under src/lambda is scanned — CDK infra
 * (lib/*.ts) legitimately defines the table/IAM and is out of scope. */
const SCAN_DIR = path.join("src", "lambda");

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

/** Returns the list of files (relative to repo root) that combine a raw
 * write-command import/usage with a reference to the AgentReleasesTable
 * name/env var — the exact signature of a bypass write — EXCLUDING the
 * one legitimate owning file. */
function findChokePointViolations(): string[] {
  const violations: string[] = [];
  for (const file of listSourceFiles(SCAN_DIR)) {
    const relPath = path.relative(REPO_ROOT, file);
    if (relPath === OWNING_FILE) continue;

    const rawContent = fs.readFileSync(file, "utf-8");
    const content = stripComments(rawContent);
    const referencesTable =
      content.includes(TABLE_ENV_VAR) || TABLE_NAME_LITERAL_RE.test(content);
    const issuesWriteCommand = WRITE_COMMAND_RE.test(content);

    if (referencesTable && issuesWriteCommand) {
      violations.push(relPath);
    }
  }
  return violations;
}

describe("release-store choke-point guard — static scan", () => {
  it("no application file other than release-store.ts combines a raw write command with a reference to AgentReleasesTable", () => {
    const violations = findChokePointViolations();
    expect(violations).toEqual([]);
  });

  it("bites: the scanner FAILS when a bypass (write command + table reference) is planted in a scratch file", () => {
    const scratchDir = fs.mkdtempSync(
      path.join(os.tmpdir(), "release-choke-point-guard-"),
    );
    const scratchFile = path.join(scratchDir, "planted-bypass.ts");
    try {
      fs.writeFileSync(
        scratchFile,
        [
          "// simulated seeder/healer bypass",
          'import { PutCommand } from "@aws-sdk/lib-dynamodb";',
          "const TABLE = process.env.AGENT_RELEASES_TABLE!;",
          "docClient.send(new PutCommand({ TableName: TABLE, Item: {} }));",
        ].join("\n"),
      );

      const content = stripComments(fs.readFileSync(scratchFile, "utf-8"));
      const referencesTable =
        content.includes(TABLE_ENV_VAR) || TABLE_NAME_LITERAL_RE.test(content);
      const issuesWriteCommand = WRITE_COMMAND_RE.test(content);

      // The bite-proof: this scratch file WOULD be flagged if it lived
      // inside the scanned directory. If this assertion ever fails, the
      // detection predicate itself is broken and the guard is a no-op.
      expect(referencesTable && issuesWriteCommand).toBe(true);
    } finally {
      fs.rmSync(scratchDir, { recursive: true, force: true });
    }
  });

  it("bites: a planted bypass using the literal table-name string (instead of the env var) is still detected — string literals stay in scope", () => {
    const scratchDir = fs.mkdtempSync(
      path.join(os.tmpdir(), "release-choke-point-guard-literal-"),
    );
    const scratchFile = path.join(scratchDir, "planted-literal-bypass.ts");
    try {
      fs.writeFileSync(
        scratchFile,
        [
          'import { PutCommand } from "@aws-sdk/lib-dynamodb";',
          'docClient.send(new PutCommand({ TableName: "citadel-agent-releases-dev", Item: {} }));',
        ].join("\n"),
      );

      const content = stripComments(fs.readFileSync(scratchFile, "utf-8"));
      const referencesTable =
        content.includes(TABLE_ENV_VAR) || TABLE_NAME_LITERAL_RE.test(content);
      const issuesWriteCommand = WRITE_COMMAND_RE.test(content);

      expect(referencesTable && issuesWriteCommand).toBe(true);
    } finally {
      fs.rmSync(scratchDir, { recursive: true, force: true });
    }
  });

  it("bites: a planted write survives alongside a benign regex literal containing '/*' (finding 7d3e6f47 regression fixture — the hand-rolled lexer misread the regex as opening a block comment and swallowed the file to EOF)", () => {
    const scratchDir = fs.mkdtempSync(
      path.join(os.tmpdir(), "release-choke-point-guard-regex-"),
    );
    const scratchFile = path.join(scratchDir, "planted-bypass-with-regex.ts");
    try {
      fs.writeFileSync(
        scratchFile,
        [
          'import { PutCommand } from "@aws-sdk/lib-dynamodb";',
          "",
          "// benign helper unrelated to the bypass below",
          'const stripTrailingSlashes = (s: string) => s.replace(/\\/*$/, "");',
          "const isApiRoute = (s: string) => /^\\/*api/.test(s);",
          "",
          "const TABLE = process.env.AGENT_RELEASES_TABLE!;",
          "docClient.send(new PutCommand({ TableName: TABLE, Item: {} }));",
        ].join("\n"),
      );

      const content = stripComments(fs.readFileSync(scratchFile, "utf-8"));
      const referencesTable =
        content.includes(TABLE_ENV_VAR) || TABLE_NAME_LITERAL_RE.test(content);
      const issuesWriteCommand = WRITE_COMMAND_RE.test(content);

      // Guards against a "quieter, not smarter" regression: a comment
      // that trips a naive lexer must not blind the scanner to a real
      // write elsewhere in the same file.
      expect(referencesTable && issuesWriteCommand).toBe(true);
    } finally {
      fs.rmSync(scratchDir, { recursive: true, force: true });
    }
  });

  it("a file that only references the table name without a raw write command is NOT flagged (e.g. a Lambda receiving the table name as an env var to pass through)", () => {
    const scratchDir = fs.mkdtempSync(
      path.join(os.tmpdir(), "release-choke-point-guard-safe-"),
    );
    const scratchFile = path.join(scratchDir, "safe-reference.ts");
    try {
      fs.writeFileSync(
        scratchFile,
        [
          "// legitimate: reads the env var to log it, issues no DDB command",
          "const TABLE = process.env.AGENT_RELEASES_TABLE!;",
          "console.log(TABLE);",
        ].join("\n"),
      );

      const content = stripComments(fs.readFileSync(scratchFile, "utf-8"));
      const referencesTable =
        content.includes(TABLE_ENV_VAR) || TABLE_NAME_LITERAL_RE.test(content);
      const issuesWriteCommand = WRITE_COMMAND_RE.test(content);

      expect(referencesTable && issuesWriteCommand).toBe(false);
    } finally {
      fs.rmSync(scratchDir, { recursive: true, force: true });
    }
  });

  it("a // line comment naming a write command alongside the releases table does NOT trip the guard (finding 3af95c1a regression)", () => {
    const scratchDir = fs.mkdtempSync(
      path.join(os.tmpdir(), "release-choke-point-guard-fp-line-"),
    );
    const scratchFile = path.join(scratchDir, "fp-line-comment.ts");
    try {
      fs.writeFileSync(
        scratchFile,
        [
          "// NOTE: unlike a raw PutCommand against AGENT_RELEASES_TABLE,",
          "// this module only ever reads release evidence, never writes it.",
          "export function readOnly(): void {",
          "  // no-op",
          "}",
        ].join("\n"),
      );

      const content = stripComments(fs.readFileSync(scratchFile, "utf-8"));
      const referencesTable =
        content.includes(TABLE_ENV_VAR) || TABLE_NAME_LITERAL_RE.test(content);
      const issuesWriteCommand = WRITE_COMMAND_RE.test(content);

      expect(referencesTable && issuesWriteCommand).toBe(false);
    } finally {
      fs.rmSync(scratchDir, { recursive: true, force: true });
    }
  });

  it("a /* */ block comment naming a write command alongside the releases table does NOT trip the guard", () => {
    const scratchDir = fs.mkdtempSync(
      path.join(os.tmpdir(), "release-choke-point-guard-fp-block-"),
    );
    const scratchFile = path.join(scratchDir, "fp-block-comment.ts");
    try {
      fs.writeFileSync(
        scratchFile,
        [
          "/* Design note: a PutCommand against AGENT_RELEASES_TABLE from",
          "   outside release-store.ts would break immutability. This file",
          "   does not issue one. */",
          "export function evaluate(): boolean {",
          "  return true;",
          "}",
        ].join("\n"),
      );

      const content = stripComments(fs.readFileSync(scratchFile, "utf-8"));
      const referencesTable =
        content.includes(TABLE_ENV_VAR) || TABLE_NAME_LITERAL_RE.test(content);
      const issuesWriteCommand = WRITE_COMMAND_RE.test(content);

      expect(referencesTable && issuesWriteCommand).toBe(false);
    } finally {
      fs.rmSync(scratchDir, { recursive: true, force: true });
    }
  });

  it("a JSDoc block naming a write command alongside the releases table does NOT trip the guard (matches the real false positive: a read-only evidence-resolution module documenting what it must NOT do)", () => {
    const scratchDir = fs.mkdtempSync(
      path.join(os.tmpdir(), "release-choke-point-guard-fp-jsdoc-"),
    );
    const scratchFile = path.join(scratchDir, "fp-jsdoc.ts");
    try {
      fs.writeFileSync(
        scratchFile,
        [
          "/**",
          " * evidence-resolver.ts — read-only evidence resolution.",
          " *",
          " * This module must never issue a PutCommand against",
          " * AGENT_RELEASES_TABLE; all writes belong solely to",
          " * release-store.ts. This file only reads evidence for display.",
          " */",
          "export function resolveEvidence(): void {",
          "  // intentionally empty for this fixture",
          "}",
        ].join("\n"),
      );

      const content = stripComments(fs.readFileSync(scratchFile, "utf-8"));
      const referencesTable =
        content.includes(TABLE_ENV_VAR) || TABLE_NAME_LITERAL_RE.test(content);
      const issuesWriteCommand = WRITE_COMMAND_RE.test(content);

      expect(referencesTable && issuesWriteCommand).toBe(false);
    } finally {
      fs.rmSync(scratchDir, { recursive: true, force: true });
    }
  });
});

describe("release-store choke-point guard — module surface", () => {
  it("release-store.ts exports ONLY putRelease and getRelease (create + read) — no update, no delete", () => {
    const exported = Object.keys(releaseStore).sort();
    expect(exported).toEqual(["getRelease", "putRelease"]);
  });
});
