/**
 * Unit tests for the shared resolveToolConfig helper.
 *
 * Proves the registry-first, DynamoDB-fallback, and 404-when-neither paths
 * that tool-sandbox.ts (and any future caller) relies on.
 */
import {
  resolveToolConfig,
  _resetResolveToolConfig,
} from "../../utils/resolve-tool-config";

// ---------------------------------------------------------------------------
// Mocks
// ---------------------------------------------------------------------------

const mockGetResource = jest.fn();
const mockMapToToolConfig = jest.fn();

jest.mock("../../../services/registry-service", () => ({
  RegistryService: jest.fn().mockImplementation(() => ({
    getResource: mockGetResource,
    mapToToolConfig: mockMapToToolConfig,
  })),
}));

const mockDynamoSend = jest.fn();
jest.mock("@aws-sdk/client-dynamodb", () => ({
  DynamoDBClient: jest
    .fn()
    .mockImplementation(() => ({
      /* inner client – the doc wrapper calls send on it */
    })),
}));
jest.mock("@aws-sdk/lib-dynamodb", () => ({
  DynamoDBDocumentClient: {
    from: jest.fn(() => ({ send: mockDynamoSend })),
  },
  GetCommand: jest.fn().mockImplementation((input: unknown) => input),
}));

// ---------------------------------------------------------------------------

beforeEach(() => {
  jest.clearAllMocks();
  _resetResolveToolConfig();
  delete process.env.REGISTRY_ENABLED;
  delete process.env.REGISTRY_ID;
  process.env.TOOLS_CONFIG_TABLE = "citadel-tools-test";
});

afterEach(() => {
  delete process.env.REGISTRY_ENABLED;
  delete process.env.REGISTRY_ID;
  delete process.env.TOOLS_CONFIG_TABLE;
});

describe("resolveToolConfig", () => {
  it("returns a registry tool when REGISTRY_ENABLED is true", async () => {
    process.env.REGISTRY_ENABLED = "true";
    process.env.REGISTRY_ID = "reg-1";

    const registryRecord = { recordId: "tool-1", name: "my-tool" };
    mockGetResource.mockResolvedValue(registryRecord);
    mockMapToToolConfig.mockReturnValue({
      toolId: "tool-1",
      orgId: "org-1",
      config: "{}",
      state: "active",
      integrationBindings: [{ integrationId: "int-1" }],
      dataStoreBindings: null,
    });

    const result = await resolveToolConfig("tool-1");

    expect(result).not.toBeNull();
    expect(result!.toolId).toBe("tool-1");
    expect(result!.orgId).toBe("org-1");
    expect(result!.integrationBindings).toEqual([{ integrationId: "int-1" }]);
    expect(mockGetResource).toHaveBeenCalledWith("tool", "tool-1");
    // DynamoDB should NOT be called when registry has the record
    expect(mockDynamoSend).not.toHaveBeenCalled();
  });

  it("falls back to DynamoDB when registry returns null", async () => {
    process.env.REGISTRY_ENABLED = "true";
    process.env.REGISTRY_ID = "reg-1";
    mockGetResource.mockResolvedValue(null);

    mockDynamoSend.mockResolvedValue({
      Item: {
        toolId: "tool-legacy",
        orgId: "org-legacy",
        integrationBindings: [{ integrationId: "int-legacy" }],
        dataStoreBindings: null,
      },
    });

    const result = await resolveToolConfig("tool-legacy");

    expect(result).not.toBeNull();
    expect(result!.toolId).toBe("tool-legacy");
    expect(result!.orgId).toBe("org-legacy");
    expect(mockDynamoSend).toHaveBeenCalled();
  });

  it("falls back to DynamoDB when registry throws", async () => {
    process.env.REGISTRY_ENABLED = "true";
    process.env.REGISTRY_ID = "reg-1";
    mockGetResource.mockRejectedValue(new Error("registry down"));

    mockDynamoSend.mockResolvedValue({
      Item: {
        toolId: "tool-fallback",
        orgId: "org-fb",
      },
    });

    const result = await resolveToolConfig("tool-fallback");

    expect(result).not.toBeNull();
    expect(result!.toolId).toBe("tool-fallback");
  });

  it("returns null when neither registry nor DynamoDB has the tool", async () => {
    process.env.REGISTRY_ENABLED = "true";
    process.env.REGISTRY_ID = "reg-1";
    mockGetResource.mockResolvedValue(null);
    mockDynamoSend.mockResolvedValue({ Item: undefined });

    const result = await resolveToolConfig("tool-missing");

    expect(result).toBeNull();
  });

  it("skips registry when REGISTRY_ENABLED is not set", async () => {
    // No REGISTRY_ENABLED env var
    mockDynamoSend.mockResolvedValue({
      Item: {
        toolId: "tool-ddb",
        orgId: "org-ddb",
      },
    });

    const result = await resolveToolConfig("tool-ddb");

    expect(result).not.toBeNull();
    expect(result!.toolId).toBe("tool-ddb");
    expect(mockGetResource).not.toHaveBeenCalled();
  });

  it("returns null when TOOLS_CONFIG_TABLE is not set and registry is disabled", async () => {
    delete process.env.TOOLS_CONFIG_TABLE;

    const result = await resolveToolConfig("tool-x");

    expect(result).toBeNull();
  });
});
