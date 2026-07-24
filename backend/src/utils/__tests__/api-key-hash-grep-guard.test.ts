/**
 * Grep guard: `createHash(` must not appear anywhere in the API-key hashing
 * surface except inside the single annotated `legacyHashApiKey` helper in
 * api-key-hash.ts. This locks in the HMAC-SHA-256-with-pepper migration
 * (security-architect decision, CodeQL #43/#44 remediation) against
 * regression to plain SHA-256 in any producer or the authorizer.
 */
import { readFileSync } from "fs";
import { join } from "path";

const FILES_TO_CHECK = [
  "src/utils/api-key-hash.ts",
  "src/lambda/app-api-authorizer.ts",
  "src/lambda/app-publish-handler.ts",
  "src/lambda/app-api-key-management.ts",
];

const BACKEND_ROOT = join(__dirname, "..", "..", "..");

describe("createHash( grep guard — API key hashing surface", () => {
  test("api-key-hash.ts contains exactly one createHash( call, inside legacyHashApiKey", () => {
    const content = readFileSync(
      join(BACKEND_ROOT, "src/utils/api-key-hash.ts"),
      "utf-8",
    );
    const matches = content.match(/createHash\(/g) || [];
    expect(matches).toHaveLength(1);

    const legacyFnStart = content.indexOf("export function legacyHashApiKey");
    const createHashIndex = content.indexOf("createHash(");
    expect(legacyFnStart).toBeGreaterThan(-1);
    expect(createHashIndex).toBeGreaterThan(legacyFnStart);
  });

  test.each(FILES_TO_CHECK.filter((f) => f !== "src/utils/api-key-hash.ts"))(
    "%s does not contain any createHash( call",
    (relPath) => {
      const content = readFileSync(join(BACKEND_ROOT, relPath), "utf-8");
      expect(content).not.toMatch(/createHash\(/);
    },
  );
});
