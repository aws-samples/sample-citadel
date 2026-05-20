/**
 * Registry Service Layer
 *
 * Encapsulates all AgentCore Registry API interactions. Resolvers and the
 * Fabricator use this module instead of calling Registry APIs directly.
 */
import {
  BedrockAgentCoreControlClient,
  CreateRegistryRecordCommand,
  GetRegistryRecordCommand,
  UpdateRegistryRecordCommand,
  UpdateRegistryRecordStatusCommand,
  DeleteRegistryRecordCommand,
  ListRegistryRecordsCommand,
  SubmitRegistryRecordForApprovalCommand,
  DescriptorType,
  RegistryRecordStatus,
} from '@aws-sdk/client-bedrock-agentcore-control';
import type {
  GetRegistryRecordCommandOutput,
  ListRegistryRecordsCommandOutput,
  RegistryRecordSummary,
} from '@aws-sdk/client-bedrock-agentcore-control';

// ---------------------------------------------------------------------------
// Types & Interfaces
// ---------------------------------------------------------------------------

export interface RegistryServiceConfig {
  registryId: string;
  region: string;
}

export type BindingDirection = 'INPUT' | 'OUTPUT' | 'BIDIRECTIONAL';

export interface IntegrationBinding {
  integrationId: string;
  integrationType: string;
  operations?: string[];
  direction?: BindingDirection;
}

export interface DataStoreBinding {
  dataStoreId: string;
  dataStoreType: string;
  operations?: string[];
  direction?: BindingDirection;
}

export interface AgentCustomMetadata {
  categories: string[];
  icon: string;
  state: 'active' | 'inactive' | 'maintenance';
  appId?: string;
  manifest?: Record<string, any>;
}

export interface ToolCustomMetadata {
  categories: string[];
  icon: string;
  state: 'active' | 'inactive' | 'maintenance';
  integrationBindings?: IntegrationBinding[];
  dataStoreBindings?: DataStoreBinding[];
  appId?: string;
}

export type ResourceType = 'agent' | 'tool';

/**
 * Registry record status values from the SDK.
 *
 * The design doc refers to "Published" but the actual SDK enum value is
 * "APPROVED". We use the SDK constants directly.
 */
export const RegistryRecordStatusValues = {
  DRAFT: 'DRAFT',
  PENDING_APPROVAL: 'PENDING_APPROVAL',
  APPROVED: 'APPROVED',
  REJECTED: 'REJECTED',
  DEPRECATED: 'DEPRECATED',
} as const;

export type RegistryRecordStatusValue =
  (typeof RegistryRecordStatusValues)[keyof typeof RegistryRecordStatusValues];

/**
 * A lightweight representation of a Registry record returned by get/list
 * operations. Downstream code should depend on this shape rather than the
 * raw SDK output so that mapping logic stays centralised.
 */
export interface RegistryRecord {
  recordId: string;
  name: string;
  description?: string;
  status: string;
  customDescriptorContent?: string;
  createdAt?: Date;
  updatedAt?: Date;
}

// ---------------------------------------------------------------------------
// Output types — GraphQL response shapes
// ---------------------------------------------------------------------------

export interface AgentConfig {
  agentId: string;
  config: any;
  state: string;
  categories?: string[];
  createdAt?: string;
  updatedAt?: string;
  manifest?: Record<string, any>;
}

export interface ToolConfig {
  toolId: string;
  config: any;
  state: string;
  categories?: string[];
  integrationBindings?: IntegrationBinding[] | null;
  dataStoreBindings?: DataStoreBinding[] | null;
  createdAt?: string;
  updatedAt?: string;
}

// ---------------------------------------------------------------------------
// Input types for CRUD
// ---------------------------------------------------------------------------

export interface CreateResourceInput {
  name: string;
  description?: string;
  customMetadata: string; // serialised JSON
}

export interface UpdateResourceInput {
  name?: string;
  description?: string;
  customMetadata?: string; // serialised JSON
}

// ---------------------------------------------------------------------------
// Service class
// ---------------------------------------------------------------------------

export class RegistryService {
  private readonly client: BedrockAgentCoreControlClient;
  private readonly registryId: string;

  constructor(config: RegistryServiceConfig) {
    this.registryId = config.registryId;
    this.client = new BedrockAgentCoreControlClient({
      region: config.region,
    });
  }

  // -- Accessors (useful for testing) --------------------------------------

  /** Returns the registryId this service was initialised with. */
  getRegistryId(): string {
    return this.registryId;
  }

  /** Returns the underlying SDK client (useful for testing / mocking). */
  getClient(): BedrockAgentCoreControlClient {
    return this.client;
  }

  // -- Retry helper ---------------------------------------------------------

  /**
   * Retries an async operation with exponential backoff for transient errors.
   * Retries on 5xx status codes and timeout/network errors. Non-retryable
   * errors are thrown immediately.
   */
  private async withRetry<T>(
    operation: () => Promise<T>,
    maxAttempts: number = 3,
  ): Promise<T> {
    let lastError: unknown;
    for (let attempt = 1; attempt <= maxAttempts; attempt++) {
      try {
        return await operation();
      } catch (err: any) {
        lastError = err;
        const isTransient = this.isTransientError(err);
        if (!isTransient || attempt === maxAttempts) {
          throw err;
        }
        const delayMs = Math.pow(2, attempt - 1) * 100; // 100ms, 200ms, 400ms…
        console.warn(
          `Transient error on attempt ${attempt}/${maxAttempts}, retrying in ${delayMs}ms: ${
            err.message ?? err
          }`,
        );
        await this.sleep(delayMs);
      }
    }
    // Unreachable, but satisfies TypeScript
    throw lastError;
  }

  /** Returns true if the error is transient (5xx, timeout, network). */
  private isTransientError(err: any): boolean {
    const statusCode = err?.$metadata?.httpStatusCode;
    if (statusCode && statusCode >= 500) return true;

    const name = err?.name ?? '';
    if (
      name === 'TimeoutError' ||
      name === 'NetworkingError' ||
      name === 'ECONNRESET' ||
      name === 'ThrottlingException' ||
      name === 'TooManyRequestsException' ||
      name === 'ServiceUnavailableException' ||
      name === 'InternalServerException'
    ) {
      return true;
    }

    return false;
  }

  /** Promise-based sleep. Extracted for testability. */
  private sleep(ms: number): Promise<void> {
    return new Promise((resolve) => setTimeout(resolve, ms));
  }

  // -- CRUD operations (task 3.4) ------------------------------------------

  /**
   * Creates a new resource (agent or tool) in the Registry.
   *
   * The SDK's CreateRegistryRecord does not accept a recordId — the service
   * generates one. We store custom metadata in a CUSTOM descriptor's
   * inlineContent field. After creation we issue a GetRegistryRecord to
   * retrieve the full record (the create response only returns recordArn +
   * status).
   */
  async createResource(
    type: ResourceType,
    id: string,
    input: CreateResourceInput,
  ): Promise<RegistryRecord> {
    const createResult = await this.withRetry(() =>
      this.client.send(
        new CreateRegistryRecordCommand({
          registryId: this.registryId,
          name: input.name,
          description: input.description,
          descriptorType: DescriptorType.CUSTOM,
          descriptors: {
            custom: {
              inlineContent: input.customMetadata,
            },
          },
        }),
      ),
    );

    // Extract recordId from the ARN (last segment after '/')
    const recordArn = createResult.recordArn ?? '';
    const recordId = recordArn.includes('/')
      ? recordArn.substring(recordArn.lastIndexOf('/') + 1)
      : id;

    // Fetch the full record to populate all fields
    const fullRecord = await this.getResource(type, recordId);
    if (fullRecord) {
      return fullRecord;
    }

    // Fallback: construct from input if get fails
    return {
      recordId,
      name: input.name,
      description: input.description,
      status: createResult.status ?? RegistryRecordStatusValues.DRAFT,
      customDescriptorContent: input.customMetadata,
      createdAt: new Date(),
      updatedAt: new Date(),
    };
  }

  /**
   * Retrieves a single resource from the Registry.
   * Returns `null` if the resource is not found (404).
   */
  async getResource(
    type: ResourceType,
    id: string,
  ): Promise<RegistryRecord | null> {
    // If id doesn't look like a recordId, resolve it
    let recordId = id;
    if (!/^[a-zA-Z0-9]{12}$/.test(id)) {
      try {
        recordId = await this.resolveRecordId(type, id);
      } catch {
        return null;
      }
    }
    try {
      const result: GetRegistryRecordCommandOutput = await this.withRetry(() =>
        this.client.send(
          new GetRegistryRecordCommand({
            registryId: this.registryId,
            recordId,
          }),
        ),
      );

      return {
        recordId: result.recordId ?? id,
        name: result.name ?? '',
        description: result.description,
        status: result.status ?? '',
        customDescriptorContent: result.descriptors?.custom?.inlineContent,
        createdAt: result.createdAt,
        updatedAt: result.updatedAt,
      };
    } catch (err: any) {
      if (
        err.name === 'ResourceNotFoundException' ||
        err?.$metadata?.httpStatusCode === 404
      ) {
        return null;
      }
      throw err;
    }
  }

  /**
   * Resolves a resource name (toolId/agentId) to its Registry recordId.
   * If the id is already a valid 12-char recordId, returns it as-is.
   */
  async resolveRecordId(type: ResourceType, id: string): Promise<string> {
    // If it looks like a recordId already (12 alphanumeric chars), use directly
    if (/^[a-zA-Z0-9]{12}$/.test(id)) {
      return id;
    }
    // Otherwise search by name in the list
    const records = await this.listResources(type);
    const match = records.find((r) => r.name === id);
    if (match) {
      return match.recordId;
    }
    throw new Error(`Registry record not found for ${type}: ${id}`);
  }

  /**
   * Updates an existing resource in the Registry.
   */
  async updateResource(
    type: ResourceType,
    id: string,
    input: UpdateResourceInput,
  ): Promise<RegistryRecord> {
    const recordId = await this.resolveRecordId(type, id);
    const result = await this.withRetry(() =>
      this.client.send(
        new UpdateRegistryRecordCommand({
          registryId: this.registryId,
          recordId,
          name: input.name,
          description: input.description != null
            ? { optionalValue: input.description }
            : undefined,
          descriptors: input.customMetadata != null
            ? {
                optionalValue: {
                  custom: {
                    optionalValue: {
                      inlineContent: input.customMetadata,
                    },
                  },
                },
              }
            : undefined,
        }),
      ),
    );

    return {
      recordId: result.recordId ?? id,
      name: result.name ?? '',
      description: result.description,
      status: result.status ?? '',
      customDescriptorContent: result.descriptors?.custom?.inlineContent,
      createdAt: result.createdAt,
      updatedAt: result.updatedAt,
    };
  }

  /**
   * Updates the status of an existing resource in the Registry.
   */
  /**
   * Waits for a registry record to leave transitional states (CREATING, UPDATING).
   */
  private async waitForStableState(recordId: string, maxWaitMs = 10000): Promise<void> {
    const start = Date.now();
    while (Date.now() - start < maxWaitMs) {
      const result = await this.client.send(
        new GetRegistryRecordCommand({ registryId: this.registryId, recordId }),
      );
      const s = result.status as string;
      if (s !== 'CREATING' && s !== 'UPDATING') return;
      await new Promise(r => setTimeout(r, 1000));
    }
  }

  async updateResourceStatus(
    type: ResourceType,
    id: string,
    status: RegistryRecordStatusValue,
    statusReason: string = 'Status update via registry service',
  ): Promise<RegistryRecord> {
    const recordId = await this.resolveRecordId(type, id);
    // Wait for any in-progress state transition to complete
    await this.waitForStableState(recordId);

    // APPROVED requires SubmitRegistryRecordForApproval (auto-approval handles the rest)
    if (status === RegistryRecordStatusValues.APPROVED) {
      const result = await this.withRetry(() =>
        this.client.send(
          new SubmitRegistryRecordForApprovalCommand({
            registryId: this.registryId,
            recordId,
          }),
        ),
      );
      return {
        recordId: result.recordId ?? recordId,
        name: '',
        status: result.status ?? status,
        updatedAt: result.updatedAt,
      };
    }

    const result = await this.withRetry(() =>
      this.client.send(
        new UpdateRegistryRecordStatusCommand({
          registryId: this.registryId,
          recordId,
          status: status as RegistryRecordStatus,
          statusReason,
        }),
      ),
    );

    return {
      recordId: result.recordId ?? recordId,
      name: '',
      status: result.status ?? status,
      updatedAt: result.updatedAt,
    };
  }

  /**
   * Deletes a resource from the Registry.
   */
  async deleteResource(type: ResourceType, id: string): Promise<void> {
    const recordId = await this.resolveRecordId(type, id);
    await this.withRetry(() =>
      this.client.send(
        new DeleteRegistryRecordCommand({
          registryId: this.registryId,
          recordId,
        }),
      ),
    );
  }

  /**
   * Helper to map a RegistryRecordSummary to our RegistryRecord shape.
   * Note: summaries from ListRegistryRecords do not include custom
   * descriptor content — callers needing that must follow up with getResource.
   */
  private summaryToRecord(rec: RegistryRecordSummary): RegistryRecord {
    return {
      recordId: rec.recordId ?? '',
      name: rec.name ?? '',
      description: rec.description,
      status: rec.status ?? '',
      // Summaries don't include descriptor content
      customDescriptorContent: undefined,
      createdAt: rec.createdAt,
      updatedAt: rec.updatedAt,
    };
  }

  /**
   * Lists all resources of a given type from the Registry.
   * Handles pagination automatically, returning all records.
   *
   * Uses CUSTOM descriptorType filter since all our resources use CUSTOM
   * descriptors. The `type` parameter is reserved for future use when the
   * Registry supports finer-grained filtering.
   */
  async listResources(type: ResourceType): Promise<RegistryRecord[]> {
    const records: RegistryRecord[] = [];
    let nextToken: string | undefined;

    do {
      const result: ListRegistryRecordsCommandOutput = await this.withRetry(
        () =>
          this.client.send(
            new ListRegistryRecordsCommand({
              registryId: this.registryId,
              descriptorType: DescriptorType.CUSTOM,
              nextToken,
            }),
          ),
      );

      if (result.registryRecords) {
        for (const rec of result.registryRecords) {
          try {
            const full = await this.getResource(type, rec.recordId ?? '');
            if (full) {
              // Filter by type: tools have integrationBindings/dataStoreBindings, agents have manifest
              const meta = full.customDescriptorContent ? JSON.parse(full.customDescriptorContent) : {};
              const isTool = meta.integrationBindings !== undefined || meta.dataStoreBindings !== undefined;
              const isAgent = meta.manifest !== undefined || (!isTool && type === 'agent');
              if ((type === 'tool' && isTool) || (type === 'agent' && isAgent)) {
                records.push(full);
              }
              continue;
            }
          } catch { /* fall through */ }
          records.push(this.summaryToRecord(rec));
        }
      }

      nextToken = result.nextToken;
    } while (nextToken);

    return records;
  }

  /**
   * Searches for resources by query string using the Registry's name filter.
   *
   * Uses `ListRegistryRecordsCommand` with the `name` parameter for
   * server-side filtering. Handles pagination automatically.
   */
  async searchResources(
    type: ResourceType,
    query: string,
  ): Promise<RegistryRecord[]> {
    const records: RegistryRecord[] = [];
    let nextToken: string | undefined;

    do {
      const result: ListRegistryRecordsCommandOutput = await this.withRetry(
        () =>
          this.client.send(
            new ListRegistryRecordsCommand({
              registryId: this.registryId,
              descriptorType: DescriptorType.CUSTOM,
              name: query,
              nextToken,
            }),
          ),
      );

      if (result.registryRecords) {
        for (const rec of result.registryRecords) {
          records.push(this.summaryToRecord(rec));
        }
      }

      nextToken = result.nextToken;
    } while (nextToken);

    return records;
  }

  // -- State mapping (task 3.2) ---------------------------------------------

  /**
   * Maps an internal application state to the corresponding Registry status.
   *
   * | Internal   | Registry     |
   * |------------|--------------|
   * | active     | APPROVED     |
   * | inactive   | DEPRECATED   |
   * | maintenance| DRAFT        |
   *
   * Unknown internal states default to DEPRECATED (inactive equivalent) with
   * a warning log.
   */
  toRegistryStatus(internalState: string): RegistryRecordStatusValue {
    switch (internalState) {
      case 'active':
        return RegistryRecordStatusValues.APPROVED;
      case 'inactive':
        return RegistryRecordStatusValues.DRAFT;
      case 'maintenance':
        return RegistryRecordStatusValues.DRAFT;
      default:
        console.warn(
          `Unknown internal state "${internalState}", mapping to DRAFT`,
        );
        return RegistryRecordStatusValues.DRAFT;
    }
  }

  /**
   * Maps a Registry record status to the internal application state.
   *
   * | Registry          | Internal    |
   * |-------------------|-------------|
   * | APPROVED          | active      |
   * | DEPRECATED        | inactive    |
   * | DRAFT             | maintenance |
   * | PENDING_APPROVAL  | pending     |
   *
   * Unknown Registry statuses default to "inactive" with a warning log.
   */
  toInternalState(registryStatus: string): string {
    switch (registryStatus) {
      case RegistryRecordStatusValues.APPROVED:
      case 'UPDATING':
        return 'active';
      case RegistryRecordStatusValues.DEPRECATED:
        return 'inactive';
      case RegistryRecordStatusValues.DRAFT:
        return 'inactive';
      case RegistryRecordStatusValues.PENDING_APPROVAL:
        return 'pending';
      default:
        console.warn(
          `Unknown registry status "${registryStatus}", mapping to "inactive"`,
        );
        return 'inactive';
    }
  }

  // -- Metadata serialization (task 3.3) ------------------------------------

  /**
   * Serializes agent or tool custom metadata to a JSON string for Registry
   * writes.
   */
  serializeCustomMetadata(
    metadata: AgentCustomMetadata | ToolCustomMetadata,
  ): string {
    return JSON.stringify(metadata);
  }

  /**
   * Deserializes a JSON string from a Registry record's custom metadata
   * field, merging with safe defaults.
   *
   * Returns `defaults` when `json` is null, empty, or malformed.
   * Never throws — logs a warning on malformed JSON.
   */
  deserializeCustomMetadata<T>(
    json: string | null | undefined,
    defaults: T,
  ): T {
    if (json == null || json === '') {
      return defaults;
    }

    try {
      const parsed = JSON.parse(json);
      if (typeof parsed !== 'object' || parsed === null || Array.isArray(parsed)) {
        console.warn('Custom metadata JSON is not a plain object, returning defaults');
        return defaults;
      }
      return { ...defaults, ...parsed };
    } catch (err) {
      console.warn(
        `Failed to parse custom metadata JSON, returning defaults: ${
          err instanceof Error ? err.message : String(err)
        }`,
      );
      return defaults;
    }
  }

  // -- Record mapping (task 3.6) --------------------------------------------

  private static readonly AGENT_METADATA_DEFAULTS: AgentCustomMetadata = {
    categories: [],
    icon: '',
    state: 'active',
    appId: undefined,
    manifest: undefined,
  };

  private static readonly TOOL_METADATA_DEFAULTS: ToolCustomMetadata = {
    categories: [],
    icon: '',
    state: 'active',
    integrationBindings: undefined,
    dataStoreBindings: undefined,
    appId: undefined,
  };

  /**
   * Maps a Registry record to the AgentConfig GraphQL response shape.
   */
  mapToAgentConfig(record: RegistryRecord): AgentConfig {
    const meta = this.deserializeCustomMetadata<AgentCustomMetadata>(
      record.customDescriptorContent ?? null,
      RegistryService.AGENT_METADATA_DEFAULTS,
    );

    return {
      agentId: record.name || record.recordId,
      config: record.description ?? '',
      state: meta.state || this.toInternalState(record.status),
      categories: meta.categories,
      createdAt: record.createdAt?.toISOString(),
      updatedAt: record.updatedAt?.toISOString(),
      manifest: meta.manifest,
    };
  }

  /**
   * Maps a Registry record to the ToolConfig GraphQL response shape.
   */
  mapToToolConfig(record: RegistryRecord): ToolConfig {
    const meta = this.deserializeCustomMetadata<ToolCustomMetadata>(
      record.customDescriptorContent ?? null,
      RegistryService.TOOL_METADATA_DEFAULTS,
    );

    return {
      toolId: record.name || record.recordId,
      config: record.description ?? '',
      state: meta.state || this.toInternalState(record.status),
      categories: meta.categories,
      integrationBindings: (meta.integrationBindings || []).filter(b => b.integrationId && b.integrationType) || null,
      dataStoreBindings: (meta.dataStoreBindings || []).filter(b => b.dataStoreId && b.dataStoreType) || null,
      createdAt: record.createdAt?.toISOString(),
      updatedAt: record.updatedAt?.toISOString(),
    };
  }
}
