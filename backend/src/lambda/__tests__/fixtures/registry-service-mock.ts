/**
 * Shared jest mock for backend/src/services/registry-service.ts.
 * Used by agent-app-shim-*.test.ts in PR 3 of the AgentCore Registry
 * governance retrofit. Each test seeds per-test records via seedMockRegistry.
 */
import type {
  CreateResourceInput,
  RegistryRecord,
  RegistryRecordStatusValue,
  ResourceType,
  UpdateResourceInput,
} from "../../../services/registry-service";

export interface MockRegistryRecord extends Partial<RegistryRecord> {
  recordId: string;
  name: string;
}

const records = new Map<string, MockRegistryRecord>();

export function seedMockRegistry(
  resourceType: ResourceType,
  recordId: string,
  record: Omit<Partial<MockRegistryRecord>, "recordId"> & { name?: string },
): void {
  records.set(`${resourceType}:${recordId}`, {
    recordId,
    name: record.name ?? "mock",
    ...record,
  } as MockRegistryRecord);
}

export function resetMockRegistry(): void {
  records.clear();
  listResourceSummariesCallCount = 0;
  getResourceCallCounts.clear();
}

/** Test-visible call counter: how many times listResourceSummaries() ran. */
let listResourceSummariesCallCount = 0;
export function getListResourceSummariesCallCount(): number {
  return listResourceSummariesCallCount;
}

/** Test-visible call counter: getResource() invocations per `${type}:${id}` key. */
const getResourceCallCounts = new Map<string, number>();
export function getGetResourceCallCount(
  type: ResourceType,
  id: string,
): number {
  return getResourceCallCounts.get(`${type}:${id}`) ?? 0;
}

export function getMockRegistryService() {
  return {
    async getResource(
      type: ResourceType,
      id: string,
    ): Promise<RegistryRecord | null> {
      const key = `${type}:${id}`;
      getResourceCallCounts.set(key, (getResourceCallCounts.get(key) ?? 0) + 1);
      return records.get(key) ?? null;
    },
    async listResources(type: ResourceType): Promise<RegistryRecord[]> {
      return Array.from(records.entries())
        .filter(([k]) => k.startsWith(`${type}:`))
        .map(([, v]) => v) as RegistryRecord[];
    },
    async listResourceSummaries(): Promise<
      Array<{ recordId: string; name: string; status?: string }>
    > {
      listResourceSummariesCallCount += 1;
      return Array.from(records.values()).map((v) => ({
        recordId: v.recordId,
        name: v.name,
        status: v.status,
      }));
    },
    /**
     * Mirrors the production dedup/legacy-name-resolution contract: at most
     * one listResourceSummaries() call for the WHOLE batch (only if a
     * non-12-char ref is present), then one getResource() per UNIQUE
     * resolved recordId.
     */
    async getResourcesByRefs(
      type: ResourceType,
      refs: string[],
    ): Promise<Map<string, RegistryRecord>> {
      const uniqueRefs = Array.from(new Set(refs.filter((r) => !!r)));
      const result = new Map<string, RegistryRecord>();
      if (uniqueRefs.length === 0) return result;

      const isRecordId = (r: string) => /^[a-zA-Z0-9]{12}$/.test(r);
      const needsNameResolution = uniqueRefs.some((r) => !isRecordId(r));

      let nameToRecordId: Map<string, string> | undefined;
      if (needsNameResolution) {
        listResourceSummariesCallCount += 1;
        nameToRecordId = new Map(
          Array.from(records.values())
            .filter((v) => v.recordId && v.name)
            .map((v) => [v.name, v.recordId]),
        );
      }

      const refToRecordId = new Map<string, string | undefined>();
      for (const ref of uniqueRefs) {
        refToRecordId.set(
          ref,
          isRecordId(ref) ? ref : nameToRecordId?.get(ref),
        );
      }

      const uniqueRecordIds = Array.from(
        new Set(
          Array.from(refToRecordId.values()).filter((id): id is string => !!id),
        ),
      );
      const recordIdToRecord = new Map<string, RegistryRecord>();
      for (const recordId of uniqueRecordIds) {
        const key = `${type}:${recordId}`;
        getResourceCallCounts.set(
          key,
          (getResourceCallCounts.get(key) ?? 0) + 1,
        );
        const record = records.get(key);
        if (record) recordIdToRecord.set(recordId, record as RegistryRecord);
      }

      for (const [ref, recordId] of refToRecordId.entries()) {
        if (!recordId) continue;
        const record = recordIdToRecord.get(recordId);
        if (record) result.set(ref, record);
      }
      return result;
    },
    /** Mirrors RegistryService.mapToAgentConfig's orgId/name extraction. */
    mapToAgentConfig(record: RegistryRecord): {
      agentId: string;
      name: string;
      orgId: string;
    } {
      let orgId = "";
      try {
        const meta = record.customDescriptorContent
          ? JSON.parse(record.customDescriptorContent)
          : {};
        orgId = typeof meta.orgId === "string" ? meta.orgId : "";
      } catch {
        orgId = "";
      }
      return { agentId: record.recordId, name: record.name ?? "", orgId };
    },
    async searchResources(
      type: ResourceType,
      _query: string,
    ): Promise<RegistryRecord[]> {
      return Array.from(records.entries())
        .filter(([k]) => k.startsWith(`${type}:`))
        .map(([, v]) => v) as RegistryRecord[];
    },
    async createResource(
      type: ResourceType,
      id: string,
      input: CreateResourceInput,
    ): Promise<RegistryRecord> {
      const record: MockRegistryRecord = {
        recordId: id,
        name: input.name,
        description: input.description,
        status: "DRAFT",
        customDescriptorContent: input.customMetadata,
        createdAt: new Date(),
        updatedAt: new Date(),
      };
      records.set(`${type}:${id}`, record);
      return record as RegistryRecord;
    },
    async updateResource(
      type: ResourceType,
      id: string,
      input: UpdateResourceInput,
    ): Promise<RegistryRecord> {
      const existing = records.get(`${type}:${id}`);
      if (!existing) throw new Error(`Record not found: ${type}:${id}`);
      const updated: MockRegistryRecord = {
        ...existing,
        ...(input.name !== undefined && { name: input.name }),
        ...(input.description !== undefined && {
          description: input.description,
        }),
        ...(input.customMetadata !== undefined && {
          customDescriptorContent: input.customMetadata,
        }),
        recordId: id,
        updatedAt: new Date(),
      };
      records.set(`${type}:${id}`, updated);
      return updated as RegistryRecord;
    },
    async updateResourceStatus(
      type: ResourceType,
      id: string,
      status: RegistryRecordStatusValue,
      _statusReason?: string,
    ): Promise<RegistryRecord> {
      const existing = records.get(`${type}:${id}`);
      if (!existing) throw new Error(`Record not found: ${type}:${id}`);
      const updated = { ...existing, status, updatedAt: new Date() };
      records.set(`${type}:${id}`, updated);
      return updated as RegistryRecord;
    },
    async deleteResource(type: ResourceType, id: string): Promise<void> {
      records.delete(`${type}:${id}`);
    },
    async resolveRecordId(_type: ResourceType, id: string): Promise<string> {
      return id;
    },
    // Mirrors RegistryService.toInternalState EXACTLY (registry-service.ts) —
    // gates that derive the agent's state from record.status must behave as
    // in production. NOTE: deliberately NOT registry-sync's toInternalState,
    // which maps PENDING_APPROVAL → 'pending' for the agents-table cache;
    // the service maps it → 'active' (async auto-approval reflects intent).
    toInternalState(status: string | undefined): string {
      switch (status) {
        case "APPROVED":
        case "UPDATING":
        case "PENDING_APPROVAL":
          return "active";
        case "DRAFT":
        case "CREATING":
          return "maintenance";
        default:
          return "inactive";
      }
    },
  };
}
