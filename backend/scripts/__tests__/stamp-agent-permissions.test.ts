/**
 * Tests for stamp-agent-permissions script — model resolution.
 */
jest.mock("@aws-sdk/client-dynamodb");
jest.mock("@aws-sdk/lib-dynamodb");
jest.mock("../../src/services/registry-service");

import {
  DynamoDBDocumentClient,
  GetCommand,
  ScanCommand,
} from "@aws-sdk/lib-dynamodb";
import { RegistryService } from "../../src/services/registry-service";
import { main, resolveAgentModel } from "../stamp-agent-permissions";

// ---------------------------------------------------------------------------
// resolveAgentModel unit tests (pure, no DDB)
// ---------------------------------------------------------------------------

const CATALOG = new Map([
  [
    "anthropic-claude-sonnet-5",
    {
      modelKey: "anthropic-claude-sonnet-5",
      baseModelId: "anthropic.claude-sonnet-5",
      status: "enabled",
      regionProfiles: { us: "us.anthropic.claude-sonnet-5" },
    },
  ],
  [
    "anthropic-claude-haiku-4",
    {
      modelKey: "anthropic-claude-haiku-4",
      baseModelId: "anthropic.claude-haiku-4",
      status: "enabled",
      regionProfiles: { us: "us.anthropic.claude-haiku-4" },
    },
  ],
  [
    "disabled-model",
    {
      modelKey: "disabled-model",
      baseModelId: "vendor.disabled-model",
      status: "disabled",
      regionProfiles: {},
    },
  ],
]);

describe("resolveAgentModel", () => {
  test("per-agent modelOverride takes priority", () => {
    const meta = {
      config: { modelOverride: "anthropic-claude-haiku-4" },
    };
    const ctx = {
      config: {
        globalDefaultKey: "anthropic-claude-sonnet-5",
        slotDefaults: {},
      },
      catalog: CATALOG,
    };
    expect(resolveAgentModel(meta, ctx)).toBe("anthropic.claude-haiku-4");
  });

  test("fabricated_agent_default slot takes priority over global", () => {
    const meta = { config: { name: "fabricated-agent" } };
    const ctx = {
      config: {
        globalDefaultKey: "anthropic-claude-sonnet-5",
        slotDefaults: { fabricated_agent_default: "anthropic-claude-haiku-4" },
      },
      catalog: CATALOG,
    };
    expect(resolveAgentModel(meta, ctx)).toBe("anthropic.claude-haiku-4");
  });

  test("falls back to global default when no slot default", () => {
    const meta = { config: { name: "fabricated-agent" } };
    const ctx = {
      config: {
        globalDefaultKey: "anthropic-claude-sonnet-5",
        slotDefaults: {},
      },
      catalog: CATALOG,
    };
    expect(resolveAgentModel(meta, ctx)).toBe("anthropic.claude-sonnet-5");
  });

  test("returns null when no model can be resolved", () => {
    const meta = { config: { name: "fabricated-agent" } };
    const ctx = {
      config: { globalDefaultKey: null, slotDefaults: {} },
      catalog: CATALOG,
    };
    expect(resolveAgentModel(meta, ctx)).toBeNull();
  });

  test("skips disabled models and falls to next layer", () => {
    const meta = { config: { modelOverride: "disabled-model" } };
    const ctx = {
      config: {
        globalDefaultKey: "anthropic-claude-sonnet-5",
        slotDefaults: {},
      },
      catalog: CATALOG,
    };
    // Override points to disabled model → skip → fall to global
    expect(resolveAgentModel(meta, ctx)).toBe("anthropic.claude-sonnet-5");
  });

  test("returns null when config is null", () => {
    const meta = { config: { name: "test" } };
    const ctx = { config: null, catalog: CATALOG };
    expect(resolveAgentModel(meta, ctx)).toBeNull();
  });
});

// ---------------------------------------------------------------------------
// main() integration tests (mocked DDB + Registry)
// ---------------------------------------------------------------------------

function makeRecord(overrides: Record<string, unknown> = {}) {
  const meta = {
    config: { name: "test-agent", filename: "test.py" },
    ...((overrides.meta ?? {}) as Record<string, unknown>),
  };
  return {
    recordId: overrides.recordId ?? "rec-1",
    name: overrides.name ?? "test-agent",
    status: overrides.status ?? "APPROVED",
    customDescriptorContent: JSON.stringify(meta),
  };
}

describe("stamp-agent-permissions main()", () => {
  let mockListResources: jest.Mock;
  let mockGetResource: jest.Mock;
  let mockUpdateResource: jest.Mock;
  let mockUpdateResourceStatus: jest.Mock;
  let mockSubmitForApproval: jest.Mock;
  let mockDocSend: jest.Mock;

  beforeEach(() => {
    mockListResources = jest.fn().mockResolvedValue([]);
    mockGetResource = jest.fn();
    mockUpdateResource = jest.fn().mockResolvedValue({});
    mockUpdateResourceStatus = jest
      .fn()
      .mockResolvedValue({ status: "APPROVED" });
    mockSubmitForApproval = jest
      .fn()
      .mockResolvedValue({ recordId: "rec-1", status: "PENDING_APPROVAL" });

    (RegistryService as jest.Mock).mockImplementation(() => ({
      listResources: mockListResources,
      getResource: mockGetResource,
      updateResource: mockUpdateResource,
      updateResourceStatus: mockUpdateResourceStatus,
      submitForApproval: mockSubmitForApproval,
    }));

    // Mock DynamoDB document client
    mockDocSend = jest.fn().mockImplementation((cmd: unknown) => {
      if (cmd instanceof GetCommand) {
        return Promise.resolve({
          Item: {
            scope: "platform",
            globalDefaultKey: "anthropic-claude-sonnet-5",
            slotDefaults: {},
            agentOverrides: {},
            localityMode: "off",
          },
        });
      }
      if (cmd instanceof ScanCommand) {
        return Promise.resolve({
          Items: [
            {
              modelKey: "anthropic-claude-sonnet-5",
              baseModelId: "anthropic.claude-sonnet-5",
              status: "enabled",
              regionProfiles: { us: "us.anthropic.claude-sonnet-5" },
            },
          ],
        });
      }
      return Promise.resolve({});
    });

    (DynamoDBDocumentClient.from as jest.Mock).mockReturnValue({
      send: mockDocSend,
    });

    process.env.REGISTRY_ID = "test-registry";
    process.env.MODEL_CONFIG_TABLE = "citadel-model-config-test";
    process.env.MODEL_CATALOG_TABLE = "citadel-model-catalog-test";
  });

  afterEach(() => {
    delete process.env.REGISTRY_ID;
    delete process.env.MODEL_CONFIG_TABLE;
    delete process.env.MODEL_CATALOG_TABLE;
  });

  test("non-pure-compute agent gets models:[foundationModelId]", async () => {
    const record = makeRecord({
      name: "my-fabricated-agent",
      recordId: "fab-1",
    });
    mockListResources.mockResolvedValue([record]);
    mockGetResource.mockResolvedValue(record);

    process.argv = ["node", "script", "--apply"];

    await main().catch(() => {});

    expect(mockUpdateResource).toHaveBeenCalled();
    const callArgs = mockUpdateResource.mock.calls[0];
    const writtenMeta = JSON.parse(callArgs[2].customMetadata);
    expect(writtenMeta.requiredPermissions).toBeDefined();
    expect(writtenMeta.requiredPermissions.models).toEqual([
      "anthropic.claude-sonnet-5",
    ]);
    expect(writtenMeta.credentialMode).toBe("scoped");
    // Also propagated into nested config
    expect(writtenMeta.config.requiredPermissions.models).toEqual([
      "anthropic.claude-sonnet-5",
    ]);
    expect(writtenMeta.config.credentialMode).toBe("scoped");
  });

  test("pure-compute agent gets credentialMode: none", async () => {
    const record = makeRecord({ name: "demo-echo-agent", recordId: "echo-1" });
    mockListResources.mockResolvedValue([record]);
    mockGetResource.mockResolvedValue(record);

    process.argv = ["node", "script", "--apply"];

    await main().catch(() => {});

    expect(mockUpdateResource).toHaveBeenCalled();
    const callArgs = mockUpdateResource.mock.calls[0];
    const writtenMeta = JSON.parse(callArgs[2].customMetadata);
    expect(writtenMeta.credentialMode).toBe("none");
  });

  test("already-stamped agent is skipped", async () => {
    const record = makeRecord({
      meta: {
        config: { name: "test" },
        requiredPermissions: { models: ["anthropic.claude-sonnet-5"] },
      },
    });
    mockListResources.mockResolvedValue([record]);

    process.argv = ["node", "script"];

    await main().catch(() => {});

    expect(mockUpdateResource).not.toHaveBeenCalled();
  });

  test("agent with integration bindings includes them in requiredPermissions", async () => {
    const record = makeRecord({
      name: "tool-agent",
      recordId: "tool-1",
      meta: {
        config: { name: "tool-agent", filename: "tool.py" },
        integrationBindings: [{ integrationId: "int-abc" }],
        dataStoreBindings: [{ dataStoreId: "ds-xyz" }],
      },
    });
    mockListResources.mockResolvedValue([record]);
    mockGetResource.mockResolvedValue(record);

    process.argv = ["node", "script", "--apply"];

    await main().catch(() => {});

    expect(mockUpdateResource).toHaveBeenCalled();
    const callArgs = mockUpdateResource.mock.calls[0];
    const writtenMeta = JSON.parse(callArgs[2].customMetadata);
    expect(writtenMeta.requiredPermissions.models).toEqual([
      "anthropic.claude-sonnet-5",
    ]);
    expect(writtenMeta.requiredPermissions.integrations).toEqual(["int-abc"]);
    expect(writtenMeta.requiredPermissions.dataStores).toEqual(["ds-xyz"]);
  });

  test("dry-run does not call updateResource", async () => {
    const record = makeRecord({ name: "some-agent" });
    mockListResources.mockResolvedValue([record]);
    mockGetResource.mockResolvedValue(record);

    process.argv = ["node", "script"]; // no --apply = dry-run

    await main().catch(() => {});

    expect(mockUpdateResource).not.toHaveBeenCalled();
  });

  test("--record-id canary: processes only the specified record", async () => {
    const rec1 = makeRecord({ name: "agent-a", recordId: "rec-a" });
    const rec2 = makeRecord({ name: "agent-b", recordId: "rec-b" });
    mockListResources.mockResolvedValue([rec1, rec2]);
    mockGetResource.mockImplementation((_type: string, id: string) => {
      if (id === "rec-a") return Promise.resolve(rec1);
      if (id === "rec-b") return Promise.resolve(rec2);
      return Promise.resolve(null);
    });

    process.argv = ["node", "script", "--apply", "--record-id", "rec-a"];

    await main().catch(() => {});

    expect(mockUpdateResource).toHaveBeenCalledTimes(1);
    const writeCall = mockUpdateResource.mock.calls[0];
    expect(writeCall[1]).toBe("rec-a");
  });

  test("--limit N: processes only first N records", async () => {
    const records = Array.from({ length: 5 }, (_, i) =>
      makeRecord({ name: `agent-${i}`, recordId: `rec-${i}` }),
    );
    mockListResources.mockResolvedValue(records);
    mockGetResource.mockImplementation((_type: string, id: string) => {
      const found = records.find((r) => r.recordId === id);
      return Promise.resolve(found ?? null);
    });

    process.argv = ["node", "script", "--apply", "--limit", "2"];

    await main().catch(() => {});

    expect(mockUpdateResource.mock.calls.length).toBeLessThanOrEqual(2);
  });
});
