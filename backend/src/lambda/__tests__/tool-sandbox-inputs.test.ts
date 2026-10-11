/**
 * Tests for the AWSJSON inputs-parsing fix in the tool-sandbox handler.
 *
 * AWSJSON! may arrive as an already-parsed object (AppSync resolves the
 * scalar before invoking) or as a raw JSON string (direct / test harness).
 * The handler must accept both, rejecting non-string/non-object types.
 */

import { handler } from "../tool-sandbox";

// Minimal identity that satisfies the admin check so we don't need DDB stubs
// for org lookup — isAdminFromEvent returns true when cognito:groups contains
// "admin".
const adminIdentity = {
  sub: "admin-user",
  username: "admin",
  "cognito:groups": ["admin"] as string[],
  "custom:role": "admin",
};

// eslint-disable-next-line @typescript-eslint/no-explicit-any -- intentional: we test runtime rejection of invalid types
function makeEvent(inputs: unknown) {
  return {
    identity: adminIdentity,
    arguments: {
      toolId: "tool-abc123",
      inputs: inputs as string | Record<string, unknown>,
      orgId: "org-1",
    },
  };
}

// We don't need real DDB/S3 — the handler validates inputs before calling
// executeTool, so if the inputs path rejects we'll get the error before any
// AWS calls.  For the success paths (string / object) we just verify that
// the handler does NOT return the "Invalid inputs" error — it will fail
// downstream on the DDB lookup, which is fine; we're testing parsing, not
// execution.

describe("tool-sandbox handler: AWSJSON inputs parsing", () => {
  it("accepts a valid JSON string and parses it", async () => {
    const result = await handler(makeEvent(JSON.stringify({ key: "value" })));
    // Should NOT fail with "Invalid inputs" — it may fail later on
    // missing env vars / DDB, which is fine.
    expect(result.error).not.toBe("Invalid inputs: must be valid JSON");
  });

  it("accepts an already-parsed object (AWSJSON pre-resolved)", async () => {
    const result = await handler(makeEvent({ key: "value" }));
    expect(result.error).not.toBe("Invalid inputs: must be valid JSON");
  });

  it("rejects an invalid JSON string", async () => {
    const result = await handler(makeEvent("{not json!}"));
    expect(result).toEqual({
      success: false,
      error: "Invalid inputs: must be valid JSON",
      executionTimeMs: 0,
    });
  });

  it("rejects a number", async () => {
    const result = await handler(makeEvent(42));
    expect(result).toEqual({
      success: false,
      error: "Invalid inputs: must be valid JSON",
      executionTimeMs: 0,
    });
  });

  it("rejects null", async () => {
    const result = await handler(makeEvent(null));
    expect(result).toEqual({
      success: false,
      error: "Invalid inputs: must be valid JSON",
      executionTimeMs: 0,
    });
  });

  it("rejects an array", async () => {
    const result = await handler(makeEvent([1, 2, 3]));
    expect(result).toEqual({
      success: false,
      error: "Invalid inputs: must be valid JSON",
      executionTimeMs: 0,
    });
  });
});
