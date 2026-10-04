/**
 * Tests for normaliseTags — CIT-042 format validation for resource tags.
 */
import { normaliseTags, TagFormatError } from "../../utils/tag-policy";

describe("normaliseTags", () => {
  it("returns empty object for null input", () => {
    expect(normaliseTags(null)).toEqual({});
  });

  it("returns empty object for undefined input", () => {
    expect(normaliseTags(undefined)).toEqual({});
  });

  it("round-trips a valid tags object", () => {
    const tags = { env: "prod", team: "platform" };
    expect(normaliseTags(tags)).toEqual(tags);
  });

  it("accepts exactly 10 keys (boundary)", () => {
    const tags: Record<string, string> = {};
    for (let i = 0; i < 10; i++) tags[`k${i}`] = `v${i}`;
    expect(Object.keys(normaliseTags(tags))).toHaveLength(10);
  });

  // --- Format errors with distinct codes ---

  it("throws TOO_MANY_KEYS when > 10 keys", () => {
    const tags: Record<string, string> = {};
    for (let i = 0; i < 11; i++) tags[`k${i}`] = `v${i}`;
    try {
      normaliseTags(tags);
      fail("expected TagFormatError");
    } catch (err) {
      expect(err).toBeInstanceOf(TagFormatError);
      expect((err as TagFormatError).code).toBe("TOO_MANY_KEYS");
    }
  });

  it("throws KEY_TOO_LONG when key > 64 chars", () => {
    const longKey = "k".repeat(65);
    try {
      normaliseTags({ [longKey]: "v" });
      fail("expected TagFormatError");
    } catch (err) {
      expect(err).toBeInstanceOf(TagFormatError);
      expect((err as TagFormatError).code).toBe("KEY_TOO_LONG");
    }
  });

  it("throws VALUE_TOO_LONG when value > 256 chars", () => {
    try {
      normaliseTags({ ok: "v".repeat(257) });
      fail("expected TagFormatError");
    } catch (err) {
      expect(err).toBeInstanceOf(TagFormatError);
      expect((err as TagFormatError).code).toBe("VALUE_TOO_LONG");
    }
  });

  it("throws INVALID_TYPE for non-string value", () => {
    try {
      normaliseTags({ num: 42 });
      fail("expected TagFormatError");
    } catch (err) {
      expect(err).toBeInstanceOf(TagFormatError);
      expect((err as TagFormatError).code).toBe("INVALID_TYPE");
    }
  });

  it("throws INVALID_TYPE for array input", () => {
    try {
      normaliseTags([1, 2]);
      fail("expected TagFormatError");
    } catch (err) {
      expect(err).toBeInstanceOf(TagFormatError);
      expect((err as TagFormatError).code).toBe("INVALID_TYPE");
    }
  });

  it("throws INVALID_TYPE for string input", () => {
    try {
      normaliseTags("not-an-object");
      fail("expected TagFormatError");
    } catch (err) {
      expect(err).toBeInstanceOf(TagFormatError);
      expect((err as TagFormatError).code).toBe("INVALID_TYPE");
    }
  });

  it("accepts key of exactly 64 chars (boundary)", () => {
    const key = "k".repeat(64);
    expect(normaliseTags({ [key]: "v" })).toEqual({ [key]: "v" });
  });

  it("accepts value of exactly 256 chars (boundary)", () => {
    const val = "v".repeat(256);
    expect(normaliseTags({ ok: val })).toEqual({ ok: val });
  });
});
