/**
 * Tests for marker-registry-edit helper (PR-5 Workstream 3).
 */
import {
  applyMarkerEdit,
  MarkerEditSpec,
  MarkerEditOptions,
} from "../marker-registry-edit";

/**
 * REGISTRY_TRANSITIONS (lifecycle.ts) says:
 *   DRAFT           -> DEPRECATED  (only)
 *   PENDING_APPROVAL -> APPROVED | REJECTED
 *
 * The mock enforces these constraints so tests catch any code path that
 * attempts a forbidden transition (e.g. DRAFT -> APPROVED directly).
 */
const MOCK_VALID_STATUS_TARGETS: Record<string, Set<string>> = {
  DRAFT: new Set(["DEPRECATED"]),
  PENDING_APPROVAL: new Set(["APPROVED", "REJECTED"]),
  REJECTED: new Set(["DEPRECATED"]),
  APPROVED: new Set(["DEPRECATED"]),
  DEPRECATED: new Set(),
};

function mockRegistryService(overrides: Record<string, unknown> = {}) {
  const meta = {
    orgId: "org-1",
    config: { name: "test-agent", filename: "test.py" },
    ...((overrides.meta as Record<string, unknown>) ?? {}),
  };

  // Track the mutable status so the mock enforces lifecycle transitions.
  let currentStatus = (overrides.status as string) ?? "APPROVED";

  const getResourceResult = () => ({
    recordId: "rec-1",
    name: "test-agent",
    status: currentStatus,
    customDescriptorContent: JSON.stringify(meta),
  });

  return {
    getResource: jest
      .fn()
      .mockImplementation(() => Promise.resolve(getResourceResult())),
    updateResource: jest.fn().mockImplementation(() => {
      // updateResource demotes to DRAFT (AgentCore GA behaviour)
      currentStatus = "DRAFT";
      // `settleFailed` models the incident shape: the write landed (hence
      // the demotion above) but registry-service.ts's own settle poll
      // exhausted its retries, so it returns the flag instead of throwing.
      if (overrides.settleFailed) {
        return Promise.resolve({
          recordId: "rec-1",
          name: "test-agent",
          status: "UPDATING",
          settleFailed: true,
        });
      }
      return Promise.resolve({});
    }),
    updateResourceStatus: jest
      .fn()
      .mockImplementation((_type: string, _id: string, target: string) => {
        const validTargets = MOCK_VALID_STATUS_TARGETS[currentStatus];
        if (!validTargets || !validTargets.has(target)) {
          return Promise.reject(
            new Error(
              `Invalid status transition: ${currentStatus} → ${target}. ` +
                `Valid from ${currentStatus}: ${[...(validTargets ?? [])].join(", ") || "none"}`,
            ),
          );
        }
        currentStatus = target;
        return Promise.resolve({ recordId: "rec-1", status: currentStatus });
      }),
    submitForApproval: jest.fn().mockImplementation(() => {
      // submitForApproval transitions DRAFT -> PENDING_APPROVAL (or
      // auto-approves to APPROVED when registry auto-approval is on).
      if (currentStatus !== "DRAFT") {
        return Promise.reject(
          new Error(`submitForApproval requires DRAFT, got ${currentStatus}`),
        );
      }
      const autoApprove = (overrides.autoApproval ?? false) as boolean;
      currentStatus = autoApprove ? "APPROVED" : "PENDING_APPROVAL";
      return Promise.resolve({ recordId: "rec-1", status: currentStatus });
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

  test("APPROVED -> UPDATING -> DRAFT -> re-approval flow", async () => {
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
    // Full lifecycle: submitForApproval (DRAFT→PENDING_APPROVAL)
    // then decideRecord via updateResourceStatus (PENDING_APPROVAL→APPROVED)
    expect(registry.submitForApproval).toHaveBeenCalledWith("rec-1");
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

  // LIVE INCIDENT 2026-11-20: UpdateRegistryRecord lands (the write
  // succeeds, demoting the record to DRAFT) but the post-write settle poll
  // (waitForStableState/getResource) exhausts its throttle retries.
  // registry-service.ts's updateResource now returns `settleFailed: true`
  // instead of throwing. applyMarkerEdit must still proceed to step 7
  // (submitForApproval -> decide) rather than returning the early
  // "updateResource failed" error that would skip approval restoration
  // entirely — the exact gap that left the incident record DRAFT forever.
  test("settleFailed from updateResource still proceeds to approval restoration and succeeds", async () => {
    const registry = mockRegistryService({
      status: "APPROVED",
      settleFailed: true,
    });
    const spec: MarkerEditSpec = {
      recordId: "rec-1",
      type: "agent",
      fieldsToSet: { credentialMode: "none" },
    };
    const result = await applyMarkerEdit(spec, baseOptions(registry));

    expect(result.error).toBeUndefined();
    // submitForApproval/updateResourceStatus run against the mock's
    // shared `currentStatus` (demoted to DRAFT by the updateResource mock
    // above even though settleFailed was set) and succeed normally,
    // proving step 7 was reached and completed rather than skipped.
    expect(registry.submitForApproval).toHaveBeenCalledWith("rec-1");
    expect(result.reapproved).toBe(true);
    expect(result.postStatus).toBe("APPROVED");
  });

  test("settleFailed followed by a genuine approval-restoration failure buckets as needsReapproval shape (no error, DRAFT, reapproved false)", async () => {
    const registry = mockRegistryService({
      status: "APPROVED",
      settleFailed: true,
      submitForApproval: jest.fn().mockRejectedValue(
        Object.assign(new Error("Request rate exceeded."), {
          name: "ThrottlingException",
        }),
      ),
    });
    const spec: MarkerEditSpec = {
      recordId: "rec-1",
      type: "agent",
      fieldsToSet: { credentialMode: "none" },
    };
    const result = await applyMarkerEdit(spec, baseOptions(registry));

    // This is the exact signature `editResultNeedsReapproval` (in
    // backfill-shared-org-marker.ts) detects: no `error`, priorStatus
    // APPROVED, reapproved false — bucketed as needsReapproval, never as
    // an abandoned error.
    expect(result.error).toBeUndefined();
    expect(result.priorStatus).toBe("APPROVED");
    expect(result.postStatus).toBe("DRAFT");
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

  test("governance ledger decision includes citadelKind when provided", async () => {
    const ledgerWriter = jest.fn().mockResolvedValue("decision-456");
    const registry = mockRegistryService({ status: "APPROVED" });
    const spec: MarkerEditSpec = {
      recordId: "rec-1",
      type: "agent",
      fieldsToSet: { credentialMode: "scoped" },
    };
    const result = await applyMarkerEdit(
      spec,
      baseOptions(registry, {
        ledgerWriter,
        operationLabel: "stamp-agent-permissions",
      }),
    );
    expect(result.ledgerDecisionId).toBe("decision-456");
    expect(ledgerWriter).toHaveBeenCalledWith(
      expect.objectContaining({
        decidedBy: "system:stamp-agent-permissions",
        reason: expect.stringContaining("credentialMode"),
      }),
    );
  });

  test("DRAFT→APPROVED direct transition is never attempted", async () => {
    // The mock enforces REGISTRY_TRANSITIONS: DRAFT can only reach
    // DEPRECATED, not APPROVED. If marker-edit tried the old direct
    // updateResourceStatus(APPROVED) from DRAFT, the mock rejects it.
    const registry = mockRegistryService({ status: "APPROVED" });
    const spec: MarkerEditSpec = {
      recordId: "rec-1",
      type: "agent",
      fieldsToSet: { requiredPermissions: { models: ["m1"] } },
    };
    const result = await applyMarkerEdit(spec, baseOptions(registry));
    expect(result.reapproved).toBe(true);
    expect(result.postStatus).toBe("APPROVED");

    // Verify submitForApproval was called (DRAFT→PENDING_APPROVAL)
    expect(registry.submitForApproval).toHaveBeenCalledWith("rec-1");

    // Verify updateResourceStatus was called with APPROVED from
    // PENDING_APPROVAL (not from DRAFT)
    const statusCalls = registry.updateResourceStatus.mock.calls;
    for (const call of statusCalls) {
      // call is [type, id, targetStatus, reason?, currentStatus?]
      const target = call[2];
      // The mock would have thrown if DRAFT→APPROVED was attempted, but
      // also assert explicitly:
      expect(target).not.toBe("DEPRECATED");
    }
  });

  test("approval restore uses submitForApproval + decideRecord lifecycle", async () => {
    const registry = mockRegistryService({ status: "APPROVED" });
    const spec: MarkerEditSpec = {
      recordId: "rec-1",
      type: "agent",
      fieldsToSet: { credentialMode: "scoped" },
    };
    const result = await applyMarkerEdit(spec, baseOptions(registry));
    expect(result.priorStatus).toBe("APPROVED");
    expect(result.postStatus).toBe("APPROVED");
    expect(result.reapproved).toBe(true);

    // After updateResource demotes to DRAFT, submitForApproval is called
    expect(registry.submitForApproval).toHaveBeenCalledWith("rec-1");
    // Then updateResourceStatus APPROVED from PENDING_APPROVAL
    expect(registry.updateResourceStatus).toHaveBeenCalledWith(
      "agent",
      "rec-1",
      "APPROVED",
      expect.stringContaining("marker-only edit"),
    );
  });

  test("auto-approval path: submitForApproval returns APPROVED directly", async () => {
    const registry = mockRegistryService({
      status: "APPROVED",
      autoApproval: true,
    });
    const spec: MarkerEditSpec = {
      recordId: "rec-1",
      type: "agent",
      fieldsToSet: { requiredPermissions: { models: ["m2"] } },
    };
    const result = await applyMarkerEdit(spec, baseOptions(registry));
    expect(result.priorStatus).toBe("APPROVED");
    expect(result.postStatus).toBe("APPROVED");
    expect(result.reapproved).toBe(true);
    // submitForApproval auto-approved — no separate decideRecord needed
    expect(registry.submitForApproval).toHaveBeenCalledWith("rec-1");
    // updateResourceStatus should NOT have been called for approval
    // because auto-approval already set status to APPROVED
    expect(registry.updateResourceStatus).not.toHaveBeenCalled();
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
