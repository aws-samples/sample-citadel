import { DatabricksAdapter } from "../databricks-adapter";
import {
  ProvisioningError,
  ConnectionError,
  PermissionError,
  ValidationError,
  DataStoreError,
} from "../errors";

const mockConnect = jest.fn();
const mockClose = jest.fn();

jest.mock("@databricks/sql", () => ({
  DBSQLClient: jest.fn().mockImplementation(() => ({
    connect: mockConnect,
    close: mockClose,
  })),
}));

describe("DatabricksAdapter", () => {
  let adapter: DatabricksAdapter;
  const validConfig = {
    host: "myworkspace.cloud.databricks.com",
    httpPath: "/sql/1.0/warehouses/abc123",
    token: "dapi-token-123",
  };

  beforeEach(() => {
    adapter = new DatabricksAdapter();
    mockConnect.mockReset();
    mockClose.mockReset();
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
      await expect(adapter.provision(validConfig)).rejects.toThrow(
        ProvisioningError,
      );
    });

    it("includes kind in error message", async () => {
      await expect(adapter.provision(validConfig)).rejects.toThrow(
        /databricks/,
      );
    });
  });

  describe("testConnection", () => {
    it("throws ValidationError when host is missing", async () => {
      await expect(
        adapter.testConnection({ httpPath: "/path", token: "tok" }),
      ).rejects.toThrow(ValidationError);
    });

    it("throws ValidationError when httpPath is missing", async () => {
      await expect(
        adapter.testConnection({ host: "h", token: "tok" }),
      ).rejects.toThrow(ValidationError);
    });

    it("throws ValidationError when token is missing", async () => {
      await expect(
        adapter.testConnection({ host: "h", httpPath: "/path" }),
      ).rejects.toThrow(ValidationError);
    });

    it("returns success when SDK connect succeeds", async () => {
      mockConnect.mockResolvedValueOnce(undefined);
      mockClose.mockResolvedValueOnce(undefined);

      const result = await adapter.testConnection(validConfig);
      expect(result.success).toBe(true);
      expect(result.message).toContain("myworkspace.cloud.databricks.com");
      expect(result.details?.host).toBe("myworkspace.cloud.databricks.com");
      expect(result.details?.httpPath).toBe("/sql/1.0/warehouses/abc123");
    });

    it("passes correct options to DBSQLClient.connect", async () => {
      mockConnect.mockResolvedValueOnce(undefined);
      mockClose.mockResolvedValueOnce(undefined);

      await adapter.testConnection(validConfig);
      expect(mockConnect).toHaveBeenCalledWith({
        host: "myworkspace.cloud.databricks.com",
        path: "/sql/1.0/warehouses/abc123",
        authType: "access-token",
        token: "dapi-token-123",
        telemetryEnabled: false,
      });
    });

    it("disables v2 driver telemetry to avoid out-of-band HTTP from Lambda", async () => {
      mockConnect.mockResolvedValueOnce(undefined);
      mockClose.mockResolvedValueOnce(undefined);

      await adapter.testConnection(validConfig);
      expect(mockConnect).toHaveBeenCalledWith(
        expect.objectContaining({ telemetryEnabled: false }),
      );
    });

    it("wraps authentication errors in PermissionError with cause", async () => {
      const sdkError = new Error("401 Unauthorized");
      mockConnect.mockRejectedValueOnce(sdkError);
      mockClose.mockResolvedValueOnce(undefined);

      try {
        await adapter.testConnection(validConfig);
        fail("Expected PermissionError");
      } catch (err) {
        expect(err).toBeInstanceOf(PermissionError);
        expect((err as DataStoreError).cause).toBe(sdkError);
      }
    });

    it("wraps other SDK errors in ConnectionError with cause", async () => {
      const sdkError = new Error("ECONNREFUSED");
      mockConnect.mockRejectedValueOnce(sdkError);
      mockClose.mockResolvedValueOnce(undefined);

      try {
        await adapter.testConnection(validConfig);
        fail("Expected ConnectionError");
      } catch (err) {
        expect(err).toBeInstanceOf(ConnectionError);
        expect((err as DataStoreError).cause).toBe(sdkError);
      }
    });

    it("wraps SDK errors as DataStoreError subclass", async () => {
      const sdkError = new Error("Something went wrong");
      mockConnect.mockRejectedValueOnce(sdkError);
      mockClose.mockResolvedValueOnce(undefined);

      try {
        await adapter.testConnection(validConfig);
        fail("Expected DataStoreError");
      } catch (err) {
        expect(err).toBeInstanceOf(DataStoreError);
        expect((err as DataStoreError).cause).toBe(sdkError);
      }
    });

    it("uses credentials parameter for token over config", async () => {
      mockConnect.mockResolvedValueOnce(undefined);
      mockClose.mockResolvedValueOnce(undefined);

      await adapter.testConnection(
        { host: "h", httpPath: "/p" },
        { token: "cred-token" },
      );
      expect(mockConnect).toHaveBeenCalledWith(
        expect.objectContaining({ token: "cred-token" }),
      );
    });

    it("closes client even on error", async () => {
      const sdkError = new Error("Connection failed");
      mockConnect.mockRejectedValueOnce(sdkError);
      mockClose.mockResolvedValueOnce(undefined);

      try {
        await adapter.testConnection(validConfig);
      } catch {
        /* expected */
      }

      expect(mockClose).toHaveBeenCalled();
    });
  });

  describe("connect", () => {
    it("succeeds when testConnection returns success", async () => {
      mockConnect.mockResolvedValueOnce(undefined);
      mockClose.mockResolvedValueOnce(undefined);

      await expect(adapter.connect(validConfig)).resolves.toBeUndefined();
    });

    it("throws ConnectionError when SDK connect fails", async () => {
      const sdkError = new Error("Connection refused");
      mockConnect.mockRejectedValueOnce(sdkError);
      mockClose.mockResolvedValueOnce(undefined);

      await expect(adapter.connect(validConfig)).rejects.toThrow(
        ConnectionError,
      );
    });

    it("propagates ValidationError from testConnection", async () => {
      await expect(adapter.connect({ httpPath: "/path" })).rejects.toThrow(
        ValidationError,
      );
    });
  });

  describe("disconnect", () => {
    it("is a no-op", async () => {
      await expect(adapter.disconnect(validConfig)).resolves.toBeUndefined();
    });
  });

  describe("getMetrics", () => {
    it("returns placeholder metrics", async () => {
      const result = await adapter.getMetrics(validConfig);
      expect(result.size).toBe("0 MB");
      expect(result.records).toBe(0);
    });
  });
});
