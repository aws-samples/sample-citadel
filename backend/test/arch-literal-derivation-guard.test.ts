/**
 * Extended architecture-literal derivation guard.
 *
 * Scans backend/test/ and backend/scripts/ for hardcoded architecture and
 * platform literals that should instead be derived from
 * lib/runtime-constants.ts.  (The existing grep guard in
 * lib/__tests__/runtime-constants.test.ts covers lib/ already.)
 *
 * Allowed exceptions:
 *
 * - THIS file (the guard itself)
 * - Lines carrying the marker: "arch-literal-guard allowlist"
 */
import * as fs from "fs";
import * as path from "path";

const BACKEND = path.resolve(__dirname, "..");

/**
 * Architecture/platform literals that must only appear in the source of
 * truth (runtime-constants.ts) or allowlisted locations.
 *
 * The pattern matches actual string values in quotes, not identifiers
 * like DOCKER_PLATFORM or EXPECTED_ARCH_TAG.
 */
const ARCH_LITERAL =
  /(?:'|"|`)(?:linux\/amd64|linux\/arm64)(?:'|"|`)|(?:'|"|`)(?:x86_64|aarch64)(?:'|"|`)|Architecture\./;

/** Relative paths (from BACKEND) that are unconditionally allowed. */
const ALLOWED_FILES = new Set([
  // The guard itself:
  path.relative(BACKEND, __filename).replace(/\.js$/, ".ts"),
]);

/** Lines carrying this marker are exempt. */
const ALLOWLIST_MARKER = "arch-literal-guard allowlist";

function walkTs(dir: string): string[] {
  const results: string[] = [];
  if (!fs.existsSync(dir)) return results;
  for (const entry of fs.readdirSync(dir, { withFileTypes: true })) {
    const full = path.join(dir, entry.name);
    if (entry.isDirectory()) {
      if (
        entry.name === "node_modules" ||
        entry.name === "cdk.out" ||
        entry.name === "dist"
      ) {
        continue;
      }
      results.push(...walkTs(full));
    } else if (entry.name.endsWith(".ts") && !entry.name.endsWith(".d.ts")) {
      results.push(full);
    }
  }
  return results;
}

describe("Architecture literal derivation guard (test/ + scripts/)", () => {
  const SCAN_DIRS = ["test", "scripts"].map((d) => path.join(BACKEND, d));

  test("no architecture/platform literals outside runtime-constants.ts and allowlisted lines", () => {
    const violations: string[] = [];

    for (const dir of SCAN_DIRS) {
      for (const filePath of walkTs(dir)) {
        const rel = path.relative(BACKEND, filePath);
        if (ALLOWED_FILES.has(rel)) continue;

        const lines = fs.readFileSync(filePath, "utf-8").split("\n");
        for (let i = 0; i < lines.length; i++) {
          const line = lines[i];
          // Skip lines carrying the explicit allowlist marker.
          if (line.includes(ALLOWLIST_MARKER)) continue;
          // Skip pure comment lines (// or * or /*).
          if (/^\s*(\/\/|\*|\/\*)/.test(line)) continue;

          if (ARCH_LITERAL.test(line)) {
            violations.push(`${rel}:${i + 1}: ${line.trim()}`);
          }
        }
      }
    }

    if (violations.length > 0) {
      // eslint-disable-next-line no-console
      console.error(
        "\nArchitecture/platform literals found in test/ or scripts/.\n" +
          "Derive these from lib/runtime-constants.ts instead.\n" +
          "If a line is a legitimate test fixture, add the marker comment:\n" +
          `  // ${ALLOWLIST_MARKER}: <reason>\n\n` +
          violations.join("\n"),
      );
    }

    expect(violations).toEqual([]);
  });
});
