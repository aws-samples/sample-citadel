import { SnowflakeAdapter } from "../snowflake-adapter";
import type { SdkError } from "../sdk-types";
import {
  ProvisioningError,
  ConnectionError,
  PermissionError,
  ValidationError,
  DataStoreError,
} from "../errors";
import { MOCK_SCOPED_CREDENTIALS } from "./helpers/mock-credentials";

const mockConnect = jest.fn();
const mockDestroy = jest.fn();
const mockCreateConnection = jest.fn();

jest.mock("snowflake-sdk", () => ({
  createConnection: (...args: unknown[]) => {
    mockCreateConnection(...args);
    return { connect: mockConnect, destroy: mockDestroy };
  },
}));

describe("SnowflakeAdapter", () => {
  let adapter: SnowflakeAdapter;
  const validConfig = {
    accountIdentifier: "myaccount",
    warehouse: "COMPUTE_WH",
    database: "MY_DB",
    username: "user",
    password: "pass",
  };

  beforeEach(() => {
    adapter = new SnowflakeAdapter();
    mockConnect.mockReset();
    mockDestroy.mockReset();
    mockCreateConnection.mockReset();
  });

  describe("requiredPolicies", () => {
    it("returns empty arrays for both provision and connect", () => {
      const policies = adapter.requiredPolicies(
        validConfig,
        "123456789012",
        "us-east-1",
      );
      expect(policies.provision).toEqual([]);
      expect(policies.connect).toEqual([]);
    });
  });

  describe("provision", () => {
    it("throws ProvisioningError", async () => {
      await expect(
        adapter.provision(validConfig, MOCK_SCOPED_CREDENTIALS),
      ).rejects.toThrow(ProvisioningError);
    });

    it("includes kind in error message", async () => {
      await expect(
        adapter.provision(validConfig, MOCK_SCOPED_CREDENTIALS),
      ).rejects.toThrow(/snowflake/);
    });
  });

  describe("testConnection", () => {
    it("throws ValidationError when accountIdentifier is missing", async () => {
      await expect(
        adapter.testConnection(
          { warehouse: "WH", database: "DB", username: "u", password: "p" },
          MOCK_SCOPED_CREDENTIALS,
        ),
      ).rejects.toThrow(ValidationError);
    });

    it("throws ValidationError when warehouse is missing", async () => {
      await expect(
        adapter.testConnection(
          {
            accountIdentifier: "acct",
            database: "DB",
            username: "u",
            password: "p",
          },
          MOCK_SCOPED_CREDENTIALS,
        ),
      ).rejects.toThrow(ValidationError);
    });

    it("throws ValidationError when database is missing", async () => {
      await expect(
        adapter.testConnection(
          {
            accountIdentifier: "acct",
            warehouse: "WH",
            username: "u",
            password: "p",
          },
          MOCK_SCOPED_CREDENTIALS,
        ),
      ).rejects.toThrow(ValidationError);
    });

    it("throws ValidationError when username/password are missing", async () => {
      await expect(
        adapter.testConnection(
          { accountIdentifier: "acct", warehouse: "WH", database: "DB" },
          MOCK_SCOPED_CREDENTIALS,
        ),
      ).rejects.toThrow(ValidationError);
    });

    it("returns success when SDK connect succeeds", async () => {
      mockConnect.mockImplementation((cb: (err: unknown) => void) => cb(null));
      mockDestroy.mockImplementation((cb: (err: unknown) => void) => cb(null));

      const result = await adapter.testConnection(
        validConfig,
        MOCK_SCOPED_CREDENTIALS,
      );
      expect(result.success).toBe(true);
      expect(result.message).toContain("myaccount");
      expect(result.details?.accountIdentifier).toBe("myaccount");
      expect(result.details?.warehouse).toBe("COMPUTE_WH");
      expect(result.details?.database).toBe("MY_DB");
    });

    it("passes correct options to createConnection", async () => {
      mockConnect.mockImplementation((cb: (err: unknown) => void) => cb(null));
      mockDestroy.mockImplementation((cb: (err: unknown) => void) => cb(null));

      await adapter.testConnection(validConfig, MOCK_SCOPED_CREDENTIALS);
      expect(mockCreateConnection).toHaveBeenCalledWith(
        expect.objectContaining({
          account: "myaccount",
          username: "user",
          password: "pass",
          warehouse: "COMPUTE_WH",
          database: "MY_DB",
        }),
      );
    });

    it("wraps authentication errors in PermissionError", async () => {
      const sdkError: SdkError = new Error("Incorrect username or password");
      sdkError.code = "390100";
      mockConnect.mockImplementation((cb: (err: unknown) => void) =>
        cb(sdkError),
      );

      try {
        await adapter.testConnection(validConfig, MOCK_SCOPED_CREDENTIALS);
        fail("Expected PermissionError");
      } catch (err) {
        expect(err).toBeInstanceOf(PermissionError);
        expect((err as DataStoreError).cause).toBe(sdkError);
      }
    });

    it("wraps other SDK errors in ConnectionError with cause", async () => {
      const sdkError = new Error("Network timeout");
      mockConnect.mockImplementation((cb: (err: unknown) => void) =>
        cb(sdkError),
      );

      try {
        await adapter.testConnection(validConfig, MOCK_SCOPED_CREDENTIALS);
        fail("Expected ConnectionError");
      } catch (err) {
        expect(err).toBeInstanceOf(ConnectionError);
        expect((err as DataStoreError).cause).toBe(sdkError);
      }
    });

    it("wraps SDK errors as DataStoreError subclass", async () => {
      const sdkError = new Error("Something went wrong");
      mockConnect.mockImplementation((cb: (err: unknown) => void) =>
        cb(sdkError),
      );

      try {
        await adapter.testConnection(validConfig, MOCK_SCOPED_CREDENTIALS);
        fail("Expected DataStoreError");
      } catch (err) {
        expect(err).toBeInstanceOf(DataStoreError);
        expect((err as DataStoreError).cause).toBe(sdkError);
      }
    });

    it("uses credentials parameter over config for username/password", async () => {
      mockConnect.mockImplementation((cb: (err: unknown) => void) => cb(null));
      mockDestroy.mockImplementation((cb: (err: unknown) => void) => cb(null));

      await adapter.testConnection(
        { accountIdentifier: "acct", warehouse: "WH", database: "DB" },
        { username: "cred-user", password: "cred-pass" },
      );
      expect(mockCreateConnection).toHaveBeenCalledWith(
        expect.objectContaining({
          username: "cred-user",
          password: "cred-pass",
        }),
      );
    });
  });

  describe("connect", () => {
    it("succeeds when testConnection returns success", async () => {
      mockConnect.mockImplementation((cb: (err: unknown) => void) => cb(null));
      mockDestroy.mockImplementation((cb: (err: unknown) => void) => cb(null));

      await expect(
        adapter.connect(validConfig, MOCK_SCOPED_CREDENTIALS),
      ).resolves.toBeUndefined();
    });

    it("throws ConnectionError when SDK connect fails", async () => {
      const sdkError = new Error("Connection refused");
      mockConnect.mockImplementation((cb: (err: unknown) => void) =>
        cb(sdkError),
      );

      await expect(
        adapter.connect(validConfig, MOCK_SCOPED_CREDENTIALS),
      ).rejects.toThrow(ConnectionError);
    });

    it("propagates ValidationError from testConnection", async () => {
      await expect(
        adapter.connect(
          { warehouse: "WH", database: "DB" },
          MOCK_SCOPED_CREDENTIALS,
        ),
      ).rejects.toThrow(ValidationError);
    });
  });

  describe("disconnect", () => {
    it("is a no-op", async () => {
      await expect(
        adapter.disconnect(validConfig, MOCK_SCOPED_CREDENTIALS),
      ).resolves.toBeUndefined();
    });
  });

  describe("getMetrics", () => {
    it("returns placeholder metrics", async () => {
      const result = await adapter.getMetrics(
        validConfig,
        undefined,
        MOCK_SCOPED_CREDENTIALS,
      );
      expect(result.size).toBe("0 MB");
      expect(result.records).toBe(0);
    });
  });
});
