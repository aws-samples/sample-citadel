/**
 * Tests for marker-registry-edit helper (PR-5 Workstream 3).
 */
import {
  applyMarkerEdit,
  MarkerEditSpec,
  MarkerEditOptions,
} from "../marker-registry-edit";

function mockRegistryService(overrides: Record<string, unknown> = {}) {
  const meta = {
    orgId: "org-1",
    config: { name: "test-agent", filename: "test.py" },
    ...((overrides.meta as Record<string, unknown>) ?? {}),
  };
  return {
    getResource: jest.fn().mockResolvedValue({
      recordId: "rec-1",
      name: "test-agent",
      status: overrides.status ?? "APPROVED",
      customDescriptorContent: JSON.stringify(meta),
    }),
    updateResource: jest.fn().mockResolvedValue({}),
    updateResourceStatus: jest.fn().mockResolvedValue({
      recordId: "rec-1",
      status: "APPROVED",
    }),
    ...overrides,
  };
}

function baseOptions(
  registryService: ReturnType<typeof mockRegistryService>,
  overrides: Partial<MarkerEditOptions> = {},
): MarkerEditOptions {
  return {
    registryService:
      registryService as unknown as MarkerEditOptions["registryService"],
    dryRun: false,
    operationLabel: "test-operation",
    ...overrides,
  };
}

describe("applyMarkerEdit", () => {
  test("rejects field not in allowlist", async () => {
    const registry = mockRegistryService();
    const spec: MarkerEditSpec = {
      recordId: "rec-1",
      type: "agent",
      // eslint-disable-next-line @typescript-eslint/no-explicit-any
      fieldsToSet: { badField: "value" } as any,
    };
    const result = await applyMarkerEdit(spec, baseOptions(registry));
    expect(result.error).toContain("not in the marker-edit allowlist");
    expect(registry.updateResource).not.toHaveBeenCalled();
  });

  test("idempotent: no-op when field already has the target value", async () => {
    const registry = mockRegistryService({
      meta: { orgId: "org-1", requiredPermissions: { models: ["m1"] } },
    });
    const spec: MarkerEditSpec = {
      recordId: "rec-1",
      type: "agent",
      fieldsToSet: { requiredPermissions: { models: ["m1"] } },
    };
    const result = await applyMarkerEdit(spec, baseOptions(registry));
    expect(result.fieldsChanged).toHaveLength(0);
    expect(registry.updateResource).not.toHaveBeenCalled();
  });

  test("APPROVED -> UPDATING -> DRAFT -> restore flow", async () => {
    const registry = mockRegistryService({ status: "APPROVED" });
    const spec: MarkerEditSpec = {
      recordId: "rec-1",
      type: "agent",
      fieldsToSet: { requiredPermissions: { models: ["m1"] } },
    };
    const result = await applyMarkerEdit(spec, baseOptions(registry));
    expect(result.priorStatus).toBe("APPROVED");
    expect(result.postStatus).toBe("APPROVED");
    expect(result.reapproved).toBe(true);
    expect(result.fieldsChanged).toContain("requiredPermissions");
    expect(registry.updateResource).toHaveBeenCalledTimes(1);
    expect(registry.updateResourceStatus).toHaveBeenCalledWith(
      "agent",
      "rec-1",
      "APPROVED",
      expect.stringContaining("marker-only edit"),
    );
  });

  test("dry-run returns diff without calling updateResource", async () => {
    const registry = mockRegistryService({ status: "APPROVED" });
    const spec: MarkerEditSpec = {
      recordId: "rec-1",
      type: "agent",
      fieldsToSet: { credentialMode: "none" },
    };
    const result = await applyMarkerEdit(
      spec,
      baseOptions(registry, { dryRun: true }),
    );
    expect(result.fieldsChanged).toContain("credentialMode");
    expect(result.reapproved).toBe(true);
    expect(registry.updateResource).not.toHaveBeenCalled();
    expect(registry.updateResourceStatus).not.toHaveBeenCalled();
  });

  test("updateResource failure returns error in result without throwing", async () => {
    const registry = mockRegistryService({
      status: "APPROVED",
      updateResource: jest
        .fn()
        .mockRejectedValue(new Error("Registry unavailable")),
    });
    const spec: MarkerEditSpec = {
      recordId: "rec-1",
      type: "agent",
      fieldsToSet: { credentialMode: "none" },
    };
    const result = await applyMarkerEdit(spec, baseOptions(registry));
    expect(result.error).toContain("updateResource failed");
    expect(result.reapproved).toBe(false);
  });

  test("governance ledger decision is written with correct fields", async () => {
    const ledgerWriter = jest.fn().mockResolvedValue("decision-123");
    const registry = mockRegistryService({ status: "APPROVED" });
    const spec: MarkerEditSpec = {
      recordId: "rec-1",
      type: "agent",
      fieldsToSet: { requiredPermissions: { models: ["m1"] } },
    };
    const result = await applyMarkerEdit(
      spec,
      baseOptions(registry, { ledgerWriter }),
    );
    expect(result.ledgerDecisionId).toBe("decision-123");
    expect(ledgerWriter).toHaveBeenCalledWith(
      expect.objectContaining({
        type: "marker_only_registry_edit",
        operation: "test-operation",
        recordId: "rec-1",
        fieldsChanged: ["requiredPermissions"],
        priorStatus: "APPROVED",
        postStatus: "APPROVED",
        reapproved: true,
        decidedBy: "system:test-operation",
      }),
    );
  });

  test("DRAFT record does not attempt re-approval", async () => {
    const registry = mockRegistryService({ status: "DRAFT" });
    const spec: MarkerEditSpec = {
      recordId: "rec-1",
      type: "agent",
      fieldsToSet: { credentialMode: "none" },
    };
    const result = await applyMarkerEdit(spec, baseOptions(registry));
    expect(result.priorStatus).toBe("DRAFT");
    expect(result.reapproved).toBe(false);
    expect(registry.updateResourceStatus).not.toHaveBeenCalled();
  });

  test("propagates changed fields into nested config object", async () => {
    const registry = mockRegistryService({ status: "DRAFT" });
    const spec: MarkerEditSpec = {
      recordId: "rec-1",
      type: "agent",
      fieldsToSet: { credentialMode: "none" },
    };
    await applyMarkerEdit(spec, baseOptions(registry));
    const writeCall = registry.updateResource.mock.calls[0];
    const writtenMeta = JSON.parse(writeCall[2].customMetadata);
    expect(writtenMeta.credentialMode).toBe("none");
    expect(writtenMeta.config.credentialMode).toBe("none");
  });

  test("fieldsToRemove removes field from descriptor and nested config", async () => {
    const registry = mockRegistryService({
      status: "DRAFT",
      meta: {
        orgId: "org-1",
        orgUnknown: true,
        config: { name: "test", orgUnknown: true },
      },
    });
    const spec: MarkerEditSpec = {
      recordId: "rec-1",
      type: "agent",
      fieldsToSet: { orgId: "All Organizations" },
      fieldsToRemove: ["orgUnknown"],
    };
    await applyMarkerEdit(spec, baseOptions(registry));
    const writeCall = registry.updateResource.mock.calls[0];
    const writtenMeta = JSON.parse(writeCall[2].customMetadata);
    expect(writtenMeta.orgId).toBe("All Organizations");
    expect(writtenMeta.orgUnknown).toBeUndefined();
  });
});
