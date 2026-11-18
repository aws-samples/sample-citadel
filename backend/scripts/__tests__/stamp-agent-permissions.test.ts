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

  beforeEach(() => {
    mockListResources = jest.fn().mockResolvedValue([]);
    mockGetResource = jest.fn();
    mockUpdateResource = jest.fn().mockResolvedValue({});
    mockUpdateResourceStatus = jest
      .fn()
      .mockResolvedValue({ status: "APPROVED" });

    (RegistryService as jest.Mock).mockImplementation(() => ({
      listResources: mockListResources,
      getResource: mockGetResource,
      updateResource: mockUpdateResource,
      updateResourceStatus: mockUpdateResourceStatus,
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
});
