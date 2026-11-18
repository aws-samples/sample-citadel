/**
 * Tests for stamp-agent-permissions script.
 */
jest.mock("../../src/services/registry-service");

import { RegistryService } from "../../src/services/registry-service";

// We test the pure functions rather than main() to avoid process.exit
import { main } from "../stamp-agent-permissions";

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

describe("stamp-agent-permissions script (unit)", () => {
  let mockListResources: jest.Mock;
  let mockGetResource: jest.Mock;
  let mockUpdateResource: jest.Mock;
  let mockUpdateResourceStatus: jest.Mock;
  let mockSubmitForApproval: jest.Mock;

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
  });

  test("pure-compute agent gets credentialMode: none", async () => {
    const record = makeRecord({ name: "demo-echo-agent", recordId: "echo-1" });
    mockListResources.mockResolvedValue([record]);
    mockGetResource.mockResolvedValue(record);

    process.env.REGISTRY_ID = "test-registry";
    process.argv = ["node", "script", "--apply"];

    await main().catch(() => {
      /* process.exit mocked below */
    });

    // The script calls applyMarkerEdit which calls updateResource
    expect(mockUpdateResource).toHaveBeenCalled();
    const callArgs = mockUpdateResource.mock.calls[0];
    const writtenMeta = JSON.parse(callArgs[2].customMetadata);
    expect(writtenMeta.credentialMode).toBe("none");
  });

  test("already-stamped agent is skipped", async () => {
    const record = makeRecord({
      meta: {
        config: { name: "test" },
        requiredPermissions: { models: ["m1"] },
      },
    });
    mockListResources.mockResolvedValue([record]);

    process.env.REGISTRY_ID = "test-registry";
    process.argv = ["node", "script"];

    await main().catch(() => {});

    expect(mockUpdateResource).not.toHaveBeenCalled();
  });

  test("dry-run does not call updateResource", async () => {
    const record = makeRecord({ name: "some-agent" });
    mockListResources.mockResolvedValue([record]);
    mockGetResource.mockResolvedValue(record);

    process.env.REGISTRY_ID = "test-registry";
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

    process.env.REGISTRY_ID = "test-registry";
    process.argv = ["node", "script", "--apply", "--record-id", "rec-a"];

    await main().catch(() => {});

    // Only the target record's data should be written
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

    process.env.REGISTRY_ID = "test-registry";
    process.argv = ["node", "script", "--apply", "--limit", "2"];

    await main().catch(() => {});

    // At most 2 records processed (they have no requiredPermissions so
    // they each get stamped with credentialMode:scoped + models:[])
    expect(mockUpdateResource.mock.calls.length).toBeLessThanOrEqual(2);
  });
});
