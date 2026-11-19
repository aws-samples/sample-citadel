/**
 * Parity guard: asserts that backend and frontend SECRET_FIELD_KEYS,
 * CREDENTIAL_ADJACENT_KEYS, and CREDENTIAL_KEYS are identical.
 *
 * If this test fails, one copy was updated without its mirror.
 */
import * as fs from "fs";
import * as path from "path";

const BACKEND_PATH = path.resolve(
  __dirname,
  "../../utils/secret-field-keys.ts",
);
const FRONTEND_PATH = path.resolve(
  __dirname,
  "../../../../frontend/src/utils/secret-field-keys.ts",
);

function extractSetMembers(source: string, setName: string): string[] {
  // Match: export const <setName> = new Set([ ... ]);
  // Handle multi-line sets with quoted strings
  const re = new RegExp(
    `export\\s+const\\s+${setName}\\s*=\\s*new\\s+Set\\(\\[([^\\]]*?)\\]\\)`,
    "s",
  );
  const match = source.match(re);
  if (!match) return [];
  const body = match[1];
  const members: string[] = [];
  for (const m of body.matchAll(/"([^"]+)"/g)) {
    members.push(m[1]);
  }
  return members.sort();
}

describe("secret-field-keys parity guard", () => {
  let backendSource: string;
  let frontendSource: string;

  beforeAll(() => {
    backendSource = fs.readFileSync(BACKEND_PATH, "utf-8");
    frontendSource = fs.readFileSync(FRONTEND_PATH, "utf-8");
  });

  test("SECRET_FIELD_KEYS are identical", () => {
    const be = extractSetMembers(backendSource, "SECRET_FIELD_KEYS");
    const fe = extractSetMembers(frontendSource, "SECRET_FIELD_KEYS");
    expect(be).toEqual(fe);
    expect(be.length).toBeGreaterThan(0);
  });

  test("CREDENTIAL_ADJACENT_KEYS are identical", () => {
    const be = extractSetMembers(backendSource, "CREDENTIAL_ADJACENT_KEYS");
    const fe = extractSetMembers(frontendSource, "CREDENTIAL_ADJACENT_KEYS");
    expect(be).toEqual(fe);
    expect(be.length).toBeGreaterThan(0);
  });

  test("CREDENTIAL_KEYS is the union of SECRET_FIELD_KEYS and CREDENTIAL_ADJACENT_KEYS", () => {
    // CREDENTIAL_KEYS uses spread syntax (...SECRET_FIELD_KEYS, ...CREDENTIAL_ADJACENT_KEYS)
    // so we verify it at runtime instead of by regex.
    const {
      SECRET_FIELD_KEYS: sk,
      CREDENTIAL_ADJACENT_KEYS: ak,
      CREDENTIAL_KEYS: ck,
    } = jest.requireActual<typeof import("../../utils/secret-field-keys")>(
      "../../utils/secret-field-keys",
    );
    const expected = new Set([...sk, ...ak]);
    expect(ck).toEqual(expected);
  });
});
