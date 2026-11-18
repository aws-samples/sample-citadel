/**
 * Citadel PR-1 — H4: non-forgeable credential provenance marker.
 *
 * A WeakSet-backed marker distinguishes platform-minted scoped credentials
 * (STS AssumeRole output, wrapped by PolicyManager.assumeScopedRole) from
 * any caller-supplied object that merely has the right field shape
 * ({accessKeyId, secretAccessKey, sessionToken}). A WeakSet membership
 * check cannot be forged from the wire: `input.credentials` is
 * `JSON.parse`'d into a fresh plain object that was never registered, so
 * it can never pass `isScopedCredentials`/the guard regardless of its
 * field values.
 */
import {
  requireScopedCredentials,
  markScopedCredentials,
  isScopedCredentials,
} from "../credential-guard";
import { CredentialMissingError } from "../../../adapters/errors";

describe("markScopedCredentials / isScopedCredentials (H4)", () => {
  it("marks an object and isScopedCredentials reports true for it", () => {
    const creds = {
      accessKeyId: "AK",
      secretAccessKey: "SK",
      sessionToken: "ST",
    };
    const marked = markScopedCredentials(creds);
    expect(marked).toBe(creds); // returns the same reference
    expect(isScopedCredentials(creds)).toBe(true);
  });

  it("isScopedCredentials reports false for an unmarked object with identical fields", () => {
    const creds = {
      accessKeyId: "AK",
      secretAccessKey: "SK",
      sessionToken: "ST",
    };
    expect(isScopedCredentials(creds)).toBe(false);
  });

  it("isScopedCredentials reports false for a JSON.parse'd clone of a marked object", () => {
    const creds = markScopedCredentials({
      accessKeyId: "AK",
      secretAccessKey: "SK",
      sessionToken: "ST",
    });
    const clone = JSON.parse(JSON.stringify(creds));
    expect(isScopedCredentials(clone)).toBe(false);
  });

  it("isScopedCredentials reports false for undefined/null/primitives", () => {
    expect(isScopedCredentials(undefined)).toBe(false);
    expect(isScopedCredentials(null)).toBe(false);
    expect(isScopedCredentials("accessKeyId")).toBe(false);
    expect(isScopedCredentials(42)).toBe(false);
  });
});

describe("requireScopedCredentials provenance enforcement (H4)", () => {
  it("passes for marked credentials with all required fields", () => {
    const creds = markScopedCredentials({
      accessKeyId: "AK",
      secretAccessKey: "SK",
      sessionToken: "ST",
    });
    const result = requireScopedCredentials(creds, {
      adapter: "TestAdapter",
      op: "connect",
    });
    expect(result).toEqual({
      accessKeyId: "AK",
      secretAccessKey: "SK",
      sessionToken: "ST",
    });
  });

  it("throws CredentialMissingError for an UNMARKED object even with all fields present", () => {
    const forged = {
      accessKeyId: "AK",
      secretAccessKey: "SK",
      sessionToken: "ST",
    };
    expect(() =>
      requireScopedCredentials(forged, {
        adapter: "TestAdapter",
        op: "connect",
      }),
    ).toThrow(CredentialMissingError);
  });

  it("throws CredentialMissingError for a caller-supplied JSON.parse'd object mimicking marked creds", () => {
    // Simulates the real attack surface: input.credentials arrives over the
    // wire as a JSON string and is JSON.parse'd into a brand-new object —
    // it can never be a member of the WeakSet regardless of field values.
    const wireString = JSON.stringify({
      accessKeyId: "AK",
      secretAccessKey: "SK",
      sessionToken: "ST",
    });
    const forged = JSON.parse(wireString);
    expect(() =>
      requireScopedCredentials(forged, {
        adapter: "KnowledgeBaseAdapter",
        op: "provision",
      }),
    ).toThrow(CredentialMissingError);
  });

  it("still throws CredentialMissingError when marked but missing a required field", () => {
    const partial = markScopedCredentials({
      accessKeyId: "AK",
      secretAccessKey: "SK",
      // sessionToken missing
    });
    expect(() =>
      requireScopedCredentials(partial, {
        adapter: "TestAdapter",
        op: "connect",
      }),
    ).toThrow(CredentialMissingError);
  });
});
