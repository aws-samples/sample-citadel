/**
 * Tests for the datastore-resolver secret-boundary rule and deep-redact
 * sanitiser, including a fast-check property test.
 */
import * as fc from "fast-check";
import { SECRET_FIELD_KEYS } from "../../utils/secret-field-keys";
import { deepRedactSecrets } from "../datastore-resolver";

describe("deepRedactSecrets", () => {
  test("redacts SECRET_FIELD_KEYS at top level", () => {
    const obj = { masterPassword: "s3cret", host: "db.example.com" };
    const result = deepRedactSecrets(obj) as Record<string, unknown>;
    expect(result.masterPassword).toBe("[REDACTED]");
    expect(result.host).toBe("db.example.com");
  });

  test("redacts credentials key at top level", () => {
    const obj = { credentials: '{"password":"secret"}', name: "test" };
    const result = deepRedactSecrets(obj) as Record<string, unknown>;
    expect(result.credentials).toBe("[REDACTED]");
    expect(result.name).toBe("test");
  });

  test("redacts secret keys inside nested objects", () => {
    const obj = {
      arguments: {
        input: {
          config: { password: "hidden", host: "h" },
        },
      },
    };
    const result = deepRedactSecrets(obj) as Record<string, unknown>;
    const input = (result.arguments as Record<string, unknown>).input as Record<
      string,
      unknown
    >;
    const config = input.config as Record<string, unknown>;
    expect(config.password).toBe("[REDACTED]");
    expect(config.host).toBe("h");
  });

  test("redacts secret keys inside JSON-encoded strings", () => {
    const inner = JSON.stringify({
      masterPassword: "hidden",
      tableName: "t",
    });
    const obj = { config: inner };
    const result = deepRedactSecrets(obj) as Record<string, unknown>;
    const parsed = JSON.parse(result.config as string);
    expect(parsed.masterPassword).toBe("[REDACTED]");
    expect(parsed.tableName).toBe("t");
  });

  test("handles null, undefined, numbers, and booleans", () => {
    expect(deepRedactSecrets(null)).toBeNull();
    expect(deepRedactSecrets(undefined)).toBeUndefined();
    expect(deepRedactSecrets(42)).toBe(42);
    expect(deepRedactSecrets(true)).toBe(true);
  });

  test("handles arrays", () => {
    const arr = [{ password: "p" }, { host: "h" }];
    const result = deepRedactSecrets(arr) as Record<string, unknown>[];
    expect(result[0].password).toBe("[REDACTED]");
    expect(result[1].host).toBe("h");
  });

  test("handles doubly-nested JSON strings", () => {
    const inner = JSON.stringify({ apiKey: "k123", name: "n" });
    const outer = JSON.stringify({ data: inner, token: "t" });
    const obj = { payload: outer };
    const result = deepRedactSecrets(obj) as Record<string, unknown>;
    // token should be redacted at the outer level
    const outerParsed = JSON.parse(result.payload as string);
    expect(outerParsed.token).toBe("[REDACTED]");
    // apiKey should be redacted at the inner level
    const innerParsed = JSON.parse(outerParsed.data as string);
    expect(innerParsed.apiKey).toBe("[REDACTED]");
    expect(innerParsed.name).toBe("n");
  });
});

describe("deepRedactSecrets — property test", () => {
  // Arbitrary that generates objects with at least one secret key
  const secretKeyArb = fc.constantFrom(...SECRET_FIELD_KEYS);
  const secretValueArb = fc.string({ minLength: 1 });

  // Build an object that has at least one secret key with a non-empty value
  const objWithSecretArb = fc
    .tuple(secretKeyArb, secretValueArb)
    .chain(([secretKey, secretValue]) =>
      fc
        .dictionary(
          fc.string({ minLength: 1, maxLength: 20 }),
          fc.string({ minLength: 0, maxLength: 50 }),
          { minKeys: 0, maxKeys: 5 },
        )
        .map((extra) => ({ ...extra, [secretKey]: secretValue })),
    );

  test("no secret VALUE survives in serialised output", () => {
    fc.assert(
      fc.property(objWithSecretArb, (obj) => {
        const redacted = deepRedactSecrets(obj);
        const serialised = JSON.stringify(redacted);

        // Every value for a secret key must not appear in output
        for (const key of SECRET_FIELD_KEYS) {
          const value = obj[key];
          if (typeof value === "string" && value.length > 0) {
            // The secret value must not appear literally in the serialised output,
            // unless the value happens to be "[REDACTED]" or a substring of
            // a non-secret value.
            if (value !== "[REDACTED]") {
              // Check it doesn't appear as a JSON-encoded value
              const jsonEncoded = JSON.stringify(value);
              // It should not appear as a value for the secret key
              expect(serialised).not.toContain(
                `${JSON.stringify(key)}:${jsonEncoded}`,
              );
            }
          }
        }
      }),
      { numRuns: 200 },
    );
  });

  test("non-secret keys are preserved", () => {
    fc.assert(
      fc.property(
        fc.dictionary(
          fc
            .string({ minLength: 1, maxLength: 20 })
            .filter((k) => !SECRET_FIELD_KEYS.has(k) && k !== "credentials"),
          fc.string({ minLength: 0, maxLength: 50 }),
          { minKeys: 1, maxKeys: 5 },
        ),
        (obj) => {
          const redacted = deepRedactSecrets(obj) as Record<string, unknown>;
          for (const [key, value] of Object.entries(obj)) {
            expect(redacted[key]).toBe(value);
          }
        },
      ),
      { numRuns: 200 },
    );
  });

  test("secret keys in JSON-string values are redacted", () => {
    fc.assert(
      fc.property(secretKeyArb, secretValueArb, (key, value) => {
        const jsonStr = JSON.stringify({ [key]: value, safe: "ok" });
        const obj = { data: jsonStr };
        const redacted = deepRedactSecrets(obj) as Record<string, unknown>;
        const parsed = JSON.parse(redacted.data as string);
        expect(parsed[key]).toBe("[REDACTED]");
        expect(parsed.safe).toBe("ok");
      }),
      { numRuns: 200 },
    );
  });
});
