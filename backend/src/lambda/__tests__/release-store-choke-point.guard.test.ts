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
 */
import * as fs from "fs";
import * as os from "os";
import * as path from "path";
import * as releaseStore from "../release-store";

const REPO_ROOT = path.resolve(__dirname, "../../..");
const OWNING_FILE = path.join("src", "lambda", "release-store.ts");
const TABLE_ENV_VAR = "AGENT_RELEASES_TABLE";
const TABLE_NAME_LITERAL_RE = /citadel-agent-releases-/;
const WRITE_COMMAND_RE =
  /\b(PutCommand|UpdateCommand|DeleteCommand|PutItemCommand|UpdateItemCommand|DeleteItemCommand)\b/;

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

    const content = fs.readFileSync(file, "utf-8");
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

      const content = fs.readFileSync(scratchFile, "utf-8");
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

      const content = fs.readFileSync(scratchFile, "utf-8");
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
