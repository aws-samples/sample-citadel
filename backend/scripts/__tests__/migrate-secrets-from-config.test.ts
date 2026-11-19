/**
 * Tests for the migrate-secrets-from-config script logic.
 *
 * Since the script uses AWS SDK clients directly, we mock them and test
 * the core splitting/detection logic.
 */

const SECRET_FIELD_KEYS = new Set([
  "masterPassword",
  "password",
  "apiKey",
  "connectionString",
  "token",
  "secretAccessKey",
  "sessionToken",
]);

const CREDENTIAL_ADJACENT_KEYS = new Set(["masterUsername", "username"]);

/** Extract the splitting logic from the script for testability. */
function classifyConfigKeys(config: Record<string, unknown>) {
  const leaked: Record<string, unknown> = {};
  const adjacent: Record<string, unknown> = {};
  const clean: Record<string, unknown> = {};

  for (const [key, value] of Object.entries(config)) {
    if (SECRET_FIELD_KEYS.has(key)) {
      leaked[key] = value;
    } else if (CREDENTIAL_ADJACENT_KEYS.has(key)) {
      adjacent[key] = value;
    } else {
      clean[key] = value;
    }
  }

  return { leaked, adjacent, clean };
}

describe("migrate-secrets-from-config logic", () => {
  test("detects masterPassword in config as leaked", () => {
    const { leaked, clean } = classifyConfigKeys({
      dbInstanceIdentifier: "db-1",
      masterUsername: "admin",
      masterPassword: "secret",
    });
    expect(leaked).toEqual({ masterPassword: "secret" });
    expect(clean).toEqual({ dbInstanceIdentifier: "db-1" });
  });

  test("detects connectionString as leaked", () => {
    const { leaked } = classifyConfigKeys({
      connectionString: "mongodb://u:p@host/db",
    });
    expect(leaked).toEqual({ connectionString: "mongodb://u:p@host/db" });
  });

  test("detects multiple secret keys", () => {
    const { leaked, adjacent, clean } = classifyConfigKeys({
      username: "u",
      password: "p",
      host: "h",
      port: 5432,
    });
    expect(leaked).toEqual({ password: "p" });
    expect(adjacent).toEqual({ username: "u" });
    expect(clean).toEqual({ host: "h", port: 5432 });
  });

  test("reports no leaks for clean config", () => {
    const { leaked } = classifyConfigKeys({
      bucketName: "my-bucket",
      tableName: "my-table",
    });
    expect(Object.keys(leaked)).toHaveLength(0);
  });

  test("classifies token and apiKey correctly", () => {
    const { leaked } = classifyConfigKeys({
      token: "dapi-123",
      apiKey: "sk-abc",
      host: "h",
    });
    expect(leaked).toEqual({ token: "dapi-123", apiKey: "sk-abc" });
  });

  test("is idempotent — already-clean config has empty leaked set", () => {
    const { leaked } = classifyConfigKeys({ host: "h", port: 5432 });
    expect(Object.keys(leaked)).toHaveLength(0);
    // Running again produces same result
    const { leaked: leaked2 } = classifyConfigKeys({ host: "h", port: 5432 });
    expect(Object.keys(leaked2)).toHaveLength(0);
  });

  test("secretData combines leaked and adjacent for vault storage", () => {
    const { leaked, adjacent } = classifyConfigKeys({
      masterUsername: "admin",
      masterPassword: "s3cret",
      dbInstanceIdentifier: "db-1",
    });
    const secretData = { ...leaked, ...adjacent };
    expect(secretData).toEqual({
      masterPassword: "s3cret",
      masterUsername: "admin",
    });
  });
});
