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
} from '../../../services/registry-service';

export interface MockRegistryRecord extends Partial<RegistryRecord> {
  recordId: string;
  name: string;
}

const records = new Map<string, MockRegistryRecord>();

export function seedMockRegistry(
  resourceType: ResourceType,
  recordId: string,
  record: Omit<Partial<MockRegistryRecord>, 'recordId'> & { name?: string },
): void {
  records.set(`${resourceType}:${recordId}`, {
    recordId,
    name: record.name ?? 'mock',
    ...record,
  } as MockRegistryRecord);
}

export function resetMockRegistry(): void {
  records.clear();
}

export function getMockRegistryService() {
  return {
    async getResource(type: ResourceType, id: string): Promise<RegistryRecord | null> {
      return records.get(`${type}:${id}`) ?? null;
    },
    async listResources(type: ResourceType): Promise<RegistryRecord[]> {
      return Array.from(records.entries())
        .filter(([k]) => k.startsWith(`${type}:`))
        .map(([, v]) => v) as RegistryRecord[];
    },
    async searchResources(type: ResourceType, _query: string): Promise<RegistryRecord[]> {
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
        status: 'DRAFT',
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
      const updated = { ...existing, ...input, recordId: id, updatedAt: new Date() };
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
        case 'APPROVED':
        case 'UPDATING':
        case 'PENDING_APPROVAL':
          return 'active';
        case 'DRAFT':
        case 'CREATING':
          return 'maintenance';
        default:
          return 'inactive';
      }
    },
  };
}
