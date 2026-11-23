/**
 * Smoke Echo Lambda — unit tests.
 *
 * Covers the `lambda`-binding target that replaced the retired vm sandbox's
 * smoke-echo-tool module (board task 10c3bf48 Slice 2).
 */

import { describe, it, expect } from "@jest/globals";
import { handler, TOOL_ID } from "../smoke-echo-lambda";

describe("smoke-echo-lambda", () => {
  it("echoes the input payload plus tool id and a timestamp", async () => {
    const result = await handler({ message: "hello" });
    expect(result.message).toBe("hello");
    expect(result.tool).toBe(TOOL_ID);
    expect(result.ts).toMatch(/^\d{4}-\d{2}-\d{2}T/);
  });

  it("handles an empty/undefined input without throwing", async () => {
    const result = await handler(undefined);
    expect(result.tool).toBe(TOOL_ID);
    expect(typeof result.ts).toBe("string");
  });

  it("preserves additional arbitrary input fields", async () => {
    const result = await handler({ message: "hi", extra: 42 });
    expect(result.extra).toBe(42);
  });
});
