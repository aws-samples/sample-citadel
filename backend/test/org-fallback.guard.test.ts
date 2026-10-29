/**
 * Guard test: no backend/src/lambda file may contain default-organisation
 * fallback patterns.
 *
 * The org model is fail-closed — an unresolvable org is a hard deny, never
 * a fallback to "Default" or any other shared pool. This guard ensures no
 * future code reintroduces such a fallback.
 *
 * Excluded: __tests__/ directories (test fixtures may assert on the string),
 * seed-* directories (seed scripts stamp sentinel org values by design).
 */

import * as fs from "fs";
import * as path from "path";

const LAMBDA_DIR = path.resolve(__dirname, "..", "src", "lambda");

/**
 * Patterns that indicate a default-org fallback. Each entry is a regex and
 * a human-readable description for the failure message.
 */
const FORBIDDEN_PATTERNS: Array<{ pattern: RegExp; description: string }> = [
  {
    pattern: /\|\|\s*["']Default["']/,
    description: '|| "Default" fallback',
  },
  {
    pattern: /\?\?\s*["']Default["']/,
    description: '?? "Default" fallback',
  },
  {
    pattern: /\borg(?:Id|anization)?\s*[:=]\s*['"]default['"]/i,
    description: "'default' org literal in org assignment",
  },
  {
    pattern: /DEFAULT_ORGANIZATION/,
    description: "DEFAULT_ORGANIZATION constant reference",
  },
];

/**
 * Recursively collect .ts files under a directory, excluding test and seed
 * directories.
 */
function collectLambdaFiles(dir: string): string[] {
  const results: string[] = [];
  for (const entry of fs.readdirSync(dir, { withFileTypes: true })) {
    const full = path.join(dir, entry.name);
    if (entry.isDirectory()) {
      if (
        entry.name === "__tests__" ||
        entry.name === "node_modules" ||
        entry.name.startsWith("seed-")
      ) {
        continue;
      }
      results.push(...collectLambdaFiles(full));
    } else if (entry.name.endsWith(".ts") && !entry.name.endsWith(".test.ts")) {
      results.push(full);
    }
  }
  return results;
}

describe("org-fallback guard", () => {
  const files = collectLambdaFiles(LAMBDA_DIR);

  it("scans at least one file", () => {
    expect(files.length).toBeGreaterThan(0);
  });

  for (const filePath of files) {
    const rel = path.relative(path.resolve(__dirname, ".."), filePath);

    for (const { pattern, description } of FORBIDDEN_PATTERNS) {
      it(`${rel} must not contain ${description}`, () => {
        const content = fs.readFileSync(filePath, "utf-8");
        const lines = content.split("\n");
        const violations: string[] = [];

        for (let i = 0; i < lines.length; i++) {
          const trimmed = lines[i].trim();
          // Skip comment-only lines — comments that explain the no-default
          // policy legitimately mention the word 'default'.
          if (
            trimmed.startsWith("//") ||
            trimmed.startsWith("*") ||
            trimmed.startsWith("/*")
          ) {
            continue;
          }
          if (pattern.test(lines[i])) {
            violations.push(`  line ${i + 1}: ${lines[i].trim()}`);
          }
        }

        if (violations.length > 0) {
          fail(
            `${rel} contains ${description}:\n${violations.join("\n")}\n\n` +
              "The org model is fail-closed. Remove the fallback and use " +
              "requireCallerOrg / assertRowOrg instead.",
          );
        }
      });
    }
  }
});
