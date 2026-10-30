/**
 * Egress pinning guard — structural regression test.
 *
 * Ensures that no bare `fetch(`, `fetchFn(`, or `https.request(` call
 * exists in http-endpoint-adapter.ts, connection-tester.ts, or
 * oauth-metadata.ts.  All outbound requests to caller-controlled URLs
 * MUST go through url-safety.ts's safeFetch / safeHttpsRequest, which
 * connect to the DNS-pinned IP rather than re-resolving the hostname.
 */

import * as fs from "fs";
import * as path from "path";

const SRC_ROOT = path.resolve(__dirname, "..", "src");

/**
 * Files that previously contained bare fetch calls — now all outbound
 * requests must go through safeFetch (which lives in url-safety.ts).
 */
const GUARDED_FILES = [
  "adapters/agent-source/http-endpoint-adapter.ts",
  "utils/connection-tester.ts",
  "utils/oauth-metadata.ts",
];

/** Patterns that indicate a direct network call bypassing the pin. */
const FORBIDDEN_PATTERNS = [
  /\bfetch\s*\(/,
  /\bfetchFn\s*\(/,
  /\bhttps\.request\s*\(/,
];

/** url-safety.ts is the ONE file allowed to make raw network calls. */
const ALLOWED_FILE = "utils/url-safety.ts";

describe("egress-pin guard", () => {
  for (const relPath of GUARDED_FILES) {
    it(`${relPath} contains no bare fetch/fetchFn/https.request calls`, () => {
      const absPath = path.join(SRC_ROOT, relPath);
      const source = fs.readFileSync(absPath, "utf-8");
      const lines = source.split("\n");

      const violations: string[] = [];
      for (let i = 0; i < lines.length; i++) {
        const line = lines[i];
        // Skip import lines and comments
        if (/^\s*(import\s|\/\/|\/\*|\*)/.test(line)) continue;
        // Skip type annotations / interface declarations
        if (/^\s*(export\s+)?(type|interface)\s/.test(line)) continue;
        for (const pat of FORBIDDEN_PATTERNS) {
          if (pat.test(line)) {
            violations.push(`  L${i + 1}: ${line.trim()}`);
          }
        }
      }

      expect(violations).toEqual([]);
    });
  }

  it("url-safety.ts IS allowed to contain https.request and the safeFetch implementation", () => {
    const absPath = path.join(SRC_ROOT, ALLOWED_FILE);
    const source = fs.readFileSync(absPath, "utf-8");
    // Sanity: safeFetch must exist in url-safety.ts
    expect(source).toContain("export async function safeFetch");
    // And safeHttpsRequest must exist
    expect(source).toContain("export async function safeHttpsRequest");
  });
});
