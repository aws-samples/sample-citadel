/**
 * Asserts that the tool sandbox returns a clear error message when a tool
 * exists in the registry but has no S3 code bundle (NoSuchKey).
 */
import { executeTool } from "../tool-sandbox";
import type { ExecuteToolDeps } from "../tool-sandbox";
import type { AuthContext } from "../../types";

const adminAuth: AuthContext = {
  userId: "admin-user",
  username: "admin",
  groups: ["admins"],
  roles: ["admin"],
};

function baseDeps(overrides: Partial<ExecuteToolDeps> = {}): ExecuteToolDeps {
  return {
    loadToolConfig: async () => ({ orgId: "org-1" }),
    loadToolCode: async () => 'module.exports = function() { return "ok"; }',
    resolveCredentials: async () => ({}),
    executeCode: async () => ({ output: "ok" }),
    ...overrides,
  };
}

describe("tool-sandbox — missing tool code", () => {
  test("returns clear error when S3 object does not exist", async () => {
    const deps = baseDeps({
      loadToolCode: async () => {
        const err = new Error("The specified key does not exist.");
        (err as unknown as Record<string, string>).name = "NoSuchKey";
        throw err;
      },
    });

    const result = await executeTool(
      "tool-no-code",
      {},
      adminAuth,
      "org-1",
      deps,
    );

    expect(result.success).toBe(false);
    expect(result.error).toBe("Tool code not found");
  });

  test("returns clear error when S3 bucket does not exist", async () => {
    const deps = baseDeps({
      loadToolCode: async () => {
        const err = new Error("The specified bucket does not exist.");
        (err as unknown as Record<string, string>).name = "NoSuchBucket";
        throw err;
      },
    });

    const result = await executeTool(
      "tool-no-bucket",
      {},
      adminAuth,
      "org-1",
      deps,
    );

    expect(result.success).toBe(false);
    expect(result.error).toBe("Tool code not found");
  });

  test("still succeeds when code is present", async () => {
    const deps = baseDeps();

    const result = await executeTool(
      "tool-with-code",
      {},
      adminAuth,
      "org-1",
      deps,
    );

    expect(result.success).toBe(true);
  });
});
