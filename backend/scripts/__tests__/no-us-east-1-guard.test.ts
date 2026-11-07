/**
 * Guard: no 'us-east-1' string literals in backend/scripts/**\/*.ts
 * (excluding __tests__/ and the template-utils comment).
 *
 * CIT-287: all scripts must use the shared resolveRegion() utility
 * instead of a silent us-east-1 fallback.
 */
import * as fs from "fs";
import * as path from "path";

const SCRIPTS_DIR = path.resolve(__dirname, "..");

function collectTsFiles(dir: string): string[] {
  const out: string[] = [];
  for (const entry of fs.readdirSync(dir, { withFileTypes: true })) {
    if (entry.name === "__tests__" || entry.name === "node_modules") continue;
    const full = path.join(dir, entry.name);
    if (entry.isDirectory()) {
      out.push(...collectTsFiles(full));
    } else if (entry.isFile() && entry.name.endsWith(".ts")) {
      out.push(full);
    }
  }
  return out;
}

describe("CIT-287: no us-east-1 fallback literals in scripts", () => {
  test("no script file contains a us-east-1 string literal", () => {
    const files = collectTsFiles(SCRIPTS_DIR);
    const violations: string[] = [];
    // Match 'us-east-1' or "us-east-1" as string values (not in comments).
    // We check line by line and skip lines that are purely comments.
    const literalPattern = /['"]us-east-1['"]/;

    for (const file of files) {
      const lines = fs.readFileSync(file, "utf-8").split("\n");
      for (let i = 0; i < lines.length; i++) {
        const line = lines[i];
        const trimmed = line.trimStart();
        // Skip single-line comments and JSDoc/block-comment continuations
        if (trimmed.startsWith("//") || trimmed.startsWith("*")) continue;
        if (literalPattern.test(line)) {
          const rel = path.relative(SCRIPTS_DIR, file);
          violations.push(`${rel}:${i + 1}: ${line.trim()}`);
        }
      }
    }

    if (violations.length > 0) {
      fail(
        `Found 'us-east-1' string literals in backend/scripts/ — ` +
          `use resolveRegion() instead:\n${violations.join("\n")}`,
      );
    }
  });
});
