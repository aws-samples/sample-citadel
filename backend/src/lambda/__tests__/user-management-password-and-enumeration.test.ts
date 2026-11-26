/**
 * TDD RED tests for:
 *   (a) changePassword must prove current password + revoke sessions
 *   (b) adminResetUserPassword must revoke sessions after reset
 *   (c) getUser must return uniform errors for missing/other-org users
 *
 * These tests are written against MAIN and MUST FAIL (RED) to prove
 * that the security gaps exist before the fix lands.
 */
import * as fs from "fs";
import * as path from "path";

const RESOLVER_PATH = path.join(__dirname, "..", "user-management-resolver.ts");
const source = fs.readFileSync(RESOLVER_PATH, "utf-8");

/**
 * Extract a named async function body by brace-counting.
 */
function extractFunctionBody(src: string, fnName: string): string {
  const declRe = new RegExp(`async function ${fnName}\\s*\\(`);
  const m = declRe.exec(src);
  if (!m) throw new Error(`Function ${fnName} not found`);
  // Skip past parameter list
  let parenDepth = 0;
  let i = src.indexOf("(", m.index);
  for (; i < src.length; i++) {
    if (src[i] === "(") parenDepth++;
    else if (src[i] === ")") {
      parenDepth--;
      if (parenDepth === 0) break;
    }
  }
  const braceStart = src.indexOf("{", i);
  let depth = 0;
  let j = braceStart;
  for (; j < src.length; j++) {
    if (src[j] === "{") depth++;
    else if (src[j] === "}") {
      depth--;
      if (depth === 0) break;
    }
  }
  return src.slice(braceStart, j + 1);
}

describe("changePassword — proves current password", () => {
  // The GraphQL schema must no longer expose the changePassword backend mutation.
  // Self-service password change moves to the frontend via Cognito's
  // ChangePassword API (Amplify updatePassword), which inherently requires
  // the current password. If the backend mutation survives (admin variant),
  // its body must verify currentPassword server-side.

  test("schema does not expose a changePassword mutation (self-service moved to frontend)", () => {
    const schemaPath = path.join(
      __dirname,
      "..",
      "..",
      "schema",
      "schema.graphql",
    );
    const schema = fs.readFileSync(schemaPath, "utf-8");
    // The mutation line must be removed from the schema
    expect(schema).not.toMatch(/changePassword\s*\(/);
  });

  test("ChangePasswordInput type is removed from the schema", () => {
    const schemaPath = path.join(
      __dirname,
      "..",
      "..",
      "schema",
      "schema.graphql",
    );
    const schema = fs.readFileSync(schemaPath, "utf-8");
    expect(schema).not.toMatch(/input ChangePasswordInput/);
  });

  test("resolver dispatch does not contain a changePassword case", () => {
    const switchStart = source.indexOf("switch (fieldName)");
    const defaultIdx = source.indexOf("default:", switchStart);
    const switchBody = source.slice(switchStart, defaultIdx);
    expect(switchBody).not.toMatch(/case\s+['"]changePassword['"]/);
  });
});

describe("adminResetUserPassword — revokes sessions after reset", () => {
  const body = extractFunctionBody(source, "adminResetUserPassword");

  test("calls AdminUserGlobalSignOutCommand after resetting the password", () => {
    expect(body).toMatch(/AdminUserGlobalSignOutCommand/);
  });
});

describe("getUser — uniform error for missing and other-org users", () => {
  const body = extractFunctionBody(source, "getUser");

  test("catches UserNotFoundException from AdminGetUser and returns the same error as org-mismatch", () => {
    // The function must wrap AdminGetUserCommand in a try/catch that
    // catches UserNotFoundException and throws the same "User not found
    // or not accessible" message used for org-mismatch, so callers
    // cannot distinguish "user does not exist" from "user is in another org".
    expect(body).toMatch(/UserNotFoundException/);
    expect(body).toMatch(/User not found or not accessible/);
  });

  test("org-mismatch error uses the uniform message", () => {
    // The existing org-mismatch throw must use the same wording
    expect(body).toMatch(/User not found or not accessible/);
    // Must NOT contain the old bare "User not found" (without "or not accessible")
    // as the sole error text for org mismatch
    const orgMismatchSection = body.slice(body.indexOf("callerOrg"));
    const throwMatches = [
      ...orgMismatchSection.matchAll(/throw new Error\("([^"]+)"\)/g),
    ];
    for (const tm of throwMatches) {
      expect(tm[1]).toBe("User not found or not accessible");
    }
  });
});
