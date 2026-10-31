/**
 * Tests for requireScopedCredentials and CredentialMissingError.
 *
 * Verifies that:
 * 1. Missing credentials throw CredentialMissingError
 * 2. Incomplete credentials throw CredentialMissingError
 * 3. Valid credentials return the expected shape
 * 4. CredentialMissingError emits structured metric log
 */
import { requireScopedCredentials } from "../credential-guard";
import { CredentialMissingError } from "../../../adapters/errors";

describe("requireScopedCredentials", () => {
  it("throws CredentialMissingError when credentials are undefined", () => {
    expect(() =>
      requireScopedCredentials(undefined, {
        adapter: "TestAdapter",
        op: "connect",
      }),
    ).toThrow(CredentialMissingError);
  });

  it("throws CredentialMissingError when credentials are empty object", () => {
    expect(() =>
      requireScopedCredentials({}, { adapter: "TestAdapter", op: "connect" }),
    ).toThrow(CredentialMissingError);
  });

  it("throws CredentialMissingError when accessKeyId is missing", () => {
    expect(() =>
      requireScopedCredentials(
        { secretAccessKey: "secret", sessionToken: "token" },
        { adapter: "TestAdapter", op: "connect" },
      ),
    ).toThrow(CredentialMissingError);
  });

  it("throws CredentialMissingError when secretAccessKey is missing", () => {
    expect(() =>
      requireScopedCredentials(
        { accessKeyId: "key", sessionToken: "token" },
        { adapter: "TestAdapter", op: "connect" },
      ),
    ).toThrow(CredentialMissingError);
  });

  it("throws CredentialMissingError when sessionToken is missing", () => {
    expect(() =>
      requireScopedCredentials(
        { accessKeyId: "key", secretAccessKey: "secret" },
        { adapter: "TestAdapter", op: "connect" },
      ),
    ).toThrow(CredentialMissingError);
  });

  it("returns typed credentials when all fields are present", () => {
    const result = requireScopedCredentials(
      { accessKeyId: "AKIA…", secretAccessKey: "secret", sessionToken: "tok" },
      { adapter: "S3Adapter", op: "provision" },
    );
    expect(result).toEqual({
      accessKeyId: "AKIA…",
      secretAccessKey: "secret",
      sessionToken: "tok",
    });
  });

  it("CredentialMissingError has opaque message and correct code", () => {
    try {
      requireScopedCredentials(undefined, {
        adapter: "S3Adapter",
        op: "getMetrics",
      });
      fail("expected throw");
    } catch (err) {
      expect(err).toBeInstanceOf(CredentialMissingError);
      const cme = err as CredentialMissingError;
      expect(cme.message).toBe(
        "Scoped credentials are required for this operation",
      );
      expect(cme.code).toBe("CREDENTIAL_MISSING");
      expect(cme.retryable).toBe(false);
      expect(cme.name).toBe("CredentialMissingError");
    }
  });

  it("CredentialMissingError emits structured metric log", () => {
    const spy = jest.spyOn(console, "error").mockImplementation();
    try {
      requireScopedCredentials(undefined, {
        adapter: "DynamoDBAdapter",
        op: "query",
      });
    } catch {
      // expected
    }
    expect(spy).toHaveBeenCalledWith(
      JSON.stringify({
        level: "error",
        metric: "CredentialMissing",
        adapter: "DynamoDBAdapter",
        op: "query",
      }),
    );
    spy.mockRestore();
  });
});
