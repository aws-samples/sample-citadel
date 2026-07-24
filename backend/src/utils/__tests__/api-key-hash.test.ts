/**
 * Unit tests for api-key-hash.ts — HMAC-SHA-256 API key hashing with
 * server-side pepper, plus the isolated legacy SHA-256 helper used only
 * for the dual-read migration window.
 */
import { createHmac, createHash } from "crypto";
import { SSMClient, GetParameterCommand } from "@aws-sdk/client-ssm";
import { mockClient } from "aws-sdk-client-mock";

const ssmMock = mockClient(SSMClient);

const TEST_PEPPER = "a".repeat(64); // 32-byte hex
const TEST_KEY = "cit_test_plaintext_key_value_abcdef";

describe("hashApiKey", () => {
  test("computes HMAC-SHA-256 of the plaintext using the pepper as key", async () => {
    const { hashApiKey } = await import("../api-key-hash");
    const result = hashApiKey(TEST_KEY, TEST_PEPPER);
    const expected = createHmac("sha256", TEST_PEPPER)
      .update(TEST_KEY)
      .digest("hex");
    expect(result).toBe(expected);
  });

  test("produces a 64-character hex digest", async () => {
    const { hashApiKey } = await import("../api-key-hash");
    const result = hashApiKey(TEST_KEY, TEST_PEPPER);
    expect(result).toMatch(/^[0-9a-f]{64}$/);
  });

  test("different peppers produce different digests for the same plaintext", async () => {
    const { hashApiKey } = await import("../api-key-hash");
    const a = hashApiKey(TEST_KEY, TEST_PEPPER);
    const b = hashApiKey(TEST_KEY, "b".repeat(64));
    expect(a).not.toBe(b);
  });

  test("is not equal to the legacy plain SHA-256 digest (regression: must not silently degrade to SHA-256)", async () => {
    const { hashApiKey } = await import("../api-key-hash");
    const hmac = hashApiKey(TEST_KEY, TEST_PEPPER);
    const sha256 = createHash("sha256").update(TEST_KEY).digest("hex");
    expect(hmac).not.toBe(sha256);
  });
});

describe("legacyHashApiKey", () => {
  test("computes plain SHA-256 of the plaintext (dual-read compat only)", async () => {
    const { legacyHashApiKey } = await import("../api-key-hash");
    const result = legacyHashApiKey(TEST_KEY);
    const expected = createHash("sha256").update(TEST_KEY).digest("hex");
    expect(result).toBe(expected);
  });
});

describe("HASH_ALG", () => {
  test("is the versioned algorithm identifier hmac-sha256-v1", async () => {
    const { HASH_ALG } = await import("../api-key-hash");
    expect(HASH_ALG).toBe("hmac-sha256-v1");
  });
});

describe("getApiKeyPepper", () => {
  const OLD_ENV = process.env.ENVIRONMENT;

  beforeEach(async () => {
    ssmMock.reset();
    process.env.ENVIRONMENT = "test";
    const mod = await import("../api-key-hash");
    mod.__resetApiKeyPepperCacheForTest();
  });

  afterEach(() => {
    process.env.ENVIRONMENT = OLD_ENV;
  });

  test("reads the pepper from SSM SecureString at /citadel/{ENVIRONMENT}/app-api-key-pepper with decryption", async () => {
    ssmMock.on(GetParameterCommand).resolves({
      Parameter: { Value: TEST_PEPPER },
    });
    const { getApiKeyPepper } = await import("../api-key-hash");

    const pepper = await getApiKeyPepper();

    expect(pepper).toBe(TEST_PEPPER);
    const calls = ssmMock.commandCalls(GetParameterCommand);
    expect(calls).toHaveLength(1);
    expect(calls[0].args[0].input.Name).toBe(
      "/citadel/test/app-api-key-pepper",
    );
    expect(calls[0].args[0].input.WithDecryption).toBe(true);
  });

  test("caches the pepper across calls within a cold start (only one SSM call)", async () => {
    ssmMock.on(GetParameterCommand).resolves({
      Parameter: { Value: TEST_PEPPER },
    });
    const { getApiKeyPepper } = await import("../api-key-hash");

    await getApiKeyPepper();
    await getApiKeyPepper();
    await getApiKeyPepper();

    expect(ssmMock.commandCalls(GetParameterCommand)).toHaveLength(1);
  });

  test("throws when the SSM parameter has no value", async () => {
    ssmMock.on(GetParameterCommand).resolves({ Parameter: {} });
    const { getApiKeyPepper } = await import("../api-key-hash");

    await expect(getApiKeyPepper()).rejects.toThrow();
  });

  test("propagates SSM errors (callers must fail closed, not swallow)", async () => {
    ssmMock.on(GetParameterCommand).rejects(new Error("AccessDenied"));
    const { getApiKeyPepper } = await import("../api-key-hash");

    await expect(getApiKeyPepper()).rejects.toThrow("AccessDenied");
  });
});
