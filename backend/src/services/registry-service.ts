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
  RegistryRecordStatus,
} from '@aws-sdk/client-bedrock-agentcore-control';
import type {
  GetRegistryRecordCommandOutput,
  ListRegistryRecordsCommandOutput,
  RegistryRecordSummary,
} from '@aws-sdk/client-bedrock-agentcore-control';

// ---------------------------------------------------------------------------
// Errors
// ---------------------------------------------------------------------------

/**
 * Thrown by getResource when the requested `type` (agent/tool) does not
 * match the stored record's descriptor content. Agents always carry a
 * `manifest` in customDescriptorContent; tools do not. Callers (e.g. the
 * AgentApp resolver) can catch this and surface a clean not-found error
 * rather than leaking a mis-typed record to the UI.
 */
export class TypeMismatchError extends Error {
  constructor(message: string) {
    super(message);
    this.name = 'TypeMismatchError';
  }
}

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

// ---------------------------------------------------------------------------
// Agent import: invocation + origin descriptor blocks (US-IMP-001)
//
// These extend the agent descriptor stored in customDescriptorContent so an
// imported (externally-owned) agent records HOW it is invoked and WHERE it
// came from. Both blocks are optional — records that predate the import
// feature carry neither and are treated as protocol=AGENTCORE_RUNTIME with
// zero behaviour change (back-compat invariant 6).
// ---------------------------------------------------------------------------

/**
 * Transport/protocol used to invoke an agent. The legacy AgentCore-only path
 * is represented by AGENTCORE_RUNTIME, which is also the back-compat default
 * for records with no invocation block.
 */
export type AgentInvocationProtocol =
  | 'AGENTCORE_RUNTIME'
  | 'BEDROCK_AGENT'
  | 'LAMBDA_INVOKE'
  | 'HTTP_ENDPOINT'
  | 'MCP'
  | 'A2A'
  | 'STEP_FUNCTIONS'
  | 'SAGEMAKER_ENDPOINT'
  | 'SQS_ASYNC';

/** Authentication mode used when reaching an invocation target. */
export type AgentInvocationAuthMode =
  | 'SIGV4'
  | 'API_KEY'
  | 'OAUTH2'
  | 'COGNITO'
  | 'NONE';

/** Synchronous request/response vs. asynchronous callback delivery. */
export type AgentInvocationMode = 'sync' | 'async_callback';

/**
 * How to reach and invoke an agent. `target` is protocol-specific (an ARN, an
 * HTTPS URL, an MCP endpoint, ...). Secrets are never inlined here — only a
 * `secretRef` pointing at Secrets Manager (RD1, least-privilege invariant 2).
 */
export interface AgentInvocationBlock {
  protocol: AgentInvocationProtocol;
  target: string;
  auth: {
    mode: AgentInvocationAuthMode;
    secretRef?: string;
  };
  mode: AgentInvocationMode;
  region?: string;
  account?: string;
  roleArn?: string;
  externalId?: string;
}

/**
 * Provenance for an imported agent. `ownership` is fixed at 'external' —
 * Citadel orchestrates imported agents but never owns, redeploys, or scales
 * the customer's infrastructure (invariant 1).
 */
export interface AgentOrigin {
  sourceArn?: string;
  account?: string;
  region?: string;
  substrate: string;
  discoveredAt: string;
  ownership: 'external';
}

export interface AgentCustomMetadata {
  categories: string[];
  icon: string;
  state: 'active' | 'inactive' | 'maintenance';
  appId?: string;
  manifest?: Record<string, any>;
  orgId?: string;
  /** Present only on imported agents (US-IMP-001). Absent ⇒ AGENTCORE_RUNTIME. */
  invocation?: AgentInvocationBlock;
  /** Present only on imported agents (US-IMP-001). */
  origin?: AgentOrigin;
  /**
   * Governance attestation stamped when an externally-owned agent is imported.
   * Additive: absent on every record that predates the governance retrofit and
   * on all non-import create paths. `status` advances 'pending' → 'attested'
   * once governance has acknowledged the requested authority grant.
   */
  governanceAttestation?: {
    status: 'pending' | 'attested';
    enforcementMode: string;
    authorityRequested: boolean;
    requestedAt: string;
    /**
     * Id of the system-generated Architecture Decision Record recorded when the
     * agent was imported (US-IMP ADR-on-import). Additive and best-effort:
     * absent when the import ADR write failed, and on every record that predates
     * ADR-on-import.
     */
    adrId?: string;
    /**
     * Identity (Cognito `sub`, falling back to `username`) of the admin/architect
     * who attested the import. Additive: set only when `status` advances to
     * 'attested' via the `attestAgentImport` mutation; absent while 'pending'.
     */
    attestedBy?: string;
    /**
     * ISO 8601 timestamp at which `status` advanced to 'attested'. Additive:
     * set alongside {@link attestedBy} on attestation; absent while 'pending'.
     */
    attestedAt?: string;
  };
}

/**
 * Returns the invocation protocol for an agent's metadata, defaulting to
 * AGENTCORE_RUNTIME for legacy records that carry no invocation block
 * (back-compat invariant 6). Accepts any object exposing an optional
 * `invocation` so callers can pass a full AgentCustomMetadata or a partial.
 */
export function getInvocationProtocol(meta: {
  invocation?: AgentInvocationBlock;
}): AgentInvocationProtocol {
  return meta.invocation?.protocol ?? 'AGENTCORE_RUNTIME';
}

export interface ToolCustomMetadata {
  categories: string[];
  icon: string;
  state: 'active' | 'inactive' | 'maintenance';
  integrationBindings?: IntegrationBinding[];
  dataStoreBindings?: DataStoreBinding[];
  appId?: string;
  config?: string;      // full tool config JSON (was previously dumped in `description`)
  createdBy?: string;   // AppSync caller identity or 'unknown'
  orgId?: string;
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
  CREATING: 'CREATING',
  UPDATING: 'UPDATING',
  CREATE_FAILED: 'CREATE_FAILED',
  UPDATE_FAILED: 'UPDATE_FAILED',
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
  name?: string;
  orgId: string;
  config: any;
  state: string;
  categories?: string[];
  createdAt?: string;
  updatedAt?: string;
  manifest?: Record<string, any>;
}

export interface ToolConfig {
  toolId: string;
  orgId: string;
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

  // ---------------------------------------------------------------------
  // resolveRecordId LRU cache
  //
  // Name-keyed lookups call ListRegistryRecords, which is O(N) over every
  // record in the registry. At hundreds of agents that becomes the dominant
  // cost of every binding/transition handler call. A small in-memory LRU
  // (insertion-order Map with a TTL guard) collapses repeated lookups for
  // the same name to a single list call within the TTL window.
  //
  // Notes:
  //   * The 12-char fast path bypasses the cache entirely — it's already O(1).
  //   * Cache lifetime is per-instance. The Lambda warm pool gets the benefit
  //     across invocations; cold starts pay the full list cost once.
  //   * Eviction is "oldest insertion first" (not strict LRU on read), but
  //     reads do refresh recency by re-inserting on hit, so it is effectively
  //     LRU for the workloads we care about.
  // ---------------------------------------------------------------------
  private readonly recordIdCache = new Map<
    string,
    { recordId: string; expiresAt: number }
  >();
  private readonly RECORD_ID_CACHE_MAX = 500;
  private readonly RECORD_ID_CACHE_TTL_MS = 60_000;

  constructor(config: RegistryServiceConfig) {
    this.registryId = config.registryId;
    this.client = new BedrockAgentCoreControlClient({
      region: config.region,
    });
  }

  // -- resolveRecordId cache helpers ---------------------------------------

  private cacheGet(key: string): string | undefined {
    const entry = this.recordIdCache.get(key);
    if (!entry) return undefined;
    if (Date.now() > entry.expiresAt) {
      this.recordIdCache.delete(key);
      return undefined;
    }
    // Refresh recency by re-inserting (Map iteration order is insertion order).
    this.recordIdCache.delete(key);
    this.recordIdCache.set(key, entry);
    return entry.recordId;
  }

  private cacheSet(key: string, recordId: string): void {
    if (this.recordIdCache.size >= this.RECORD_ID_CACHE_MAX) {
      const oldestKey = this.recordIdCache.keys().next().value;
      if (oldestKey !== undefined) this.recordIdCache.delete(oldestKey);
    }
    this.recordIdCache.set(key, {
      recordId,
      expiresAt: Date.now() + this.RECORD_ID_CACHE_TTL_MS,
    });
  }

  /**
   * Test-only helper: clear the resolveRecordId cache. Production code
   * should not need this — the cache is bounded by size and TTL.
   */
  clearRecordIdCache(): void {
    this.recordIdCache.clear();
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
      } catch (err: unknown) {
        lastError = err;
        const isTransient = this.isTransientError(err);
        if (!isTransient || attempt === maxAttempts) {
          throw err;
        }
        const delayMs = Math.pow(2, attempt - 1) * 100; // 100ms, 200ms, 400ms…
        console.warn(
          `Transient error on attempt ${attempt}/${maxAttempts}, retrying in ${delayMs}ms: ${
            err instanceof Error ? err.message : err
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
          // Use the literal 'CUSTOM' instead of DescriptorType.CUSTOM enum access.
          // governance-ui-resolver.ts is bundled with --external:@aws-sdk/* and
          // resolves the SDK from Lambda's bundled snapshot at runtime, which
          // doesn't yet ship the AgentCore registry-record DescriptorType enum.
          // The string literal is part of the field's TS union type ('MCP' | 'A2A'
          // | 'CUSTOM' | 'AGENT_SKILLS'), so this type-checks cleanly without the
          // runtime import dependency.
          descriptorType: 'CUSTOM',
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
    // Treat `id` as the Registry recordId. Callers that have a name-only
    // reference must resolve it via resolveRecordId first.
    const recordId = id;
    try {
      const result: GetRegistryRecordCommandOutput = await this.withRetry(() =>
        this.client.send(
          new GetRegistryRecordCommand({
            registryId: this.registryId,
            recordId,
          }),
        ),
      );

      const customDescriptorContent = result.descriptors?.custom?.inlineContent;

      // Enforce requested type vs descriptor content. Tools store their
      // config in the `description` field and have no manifest; agents
      // always have a manifest. Mismatches indicate the caller is reading
      // a record of the wrong type — throw rather than leaking mis-typed
      // data to the UI.
      const meta = customDescriptorContent
        ? JSON.parse(customDescriptorContent)
        : {};
      const hasManifest = meta.manifest !== undefined;
      if (type === 'agent' && !hasManifest) {
        throw new TypeMismatchError(
          `Record ${recordId} exists but is not an agent (no manifest)`,
        );
      }
      if (type === 'tool' && hasManifest) {
        throw new TypeMismatchError(
          `Record ${recordId} exists but is not a tool (has manifest)`,
        );
      }

      return {
        recordId: result.recordId ?? id,
        name: result.name ?? '',
        description: result.description,
        status: result.status ?? '',
        customDescriptorContent,
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
   *
   * Name-based lookups are cached for {@link RECORD_ID_CACHE_TTL_MS} ms
   * keyed on `${type}:${name}` to avoid re-listing the entire registry on
   * every call. The 12-char fast path bypasses the cache.
   */
  async resolveRecordId(type: ResourceType, id: string): Promise<string> {
    // Fast path: already a recordId. Do not cache — already O(1).
    if (/^[a-zA-Z0-9]{12}$/.test(id)) {
      return id;
    }

    // Cache hit?
    const cacheKey = `${type}:${id}`;
    const hit = this.cacheGet(cacheKey);
    if (hit) return hit;

    // Miss: existing list-and-find logic.
    const records = await this.listResources(type);
    const match = records.find((r) => r.name === id);
    if (!match) {
      throw new Error(`Registry record not found for ${type}: ${id}`);
    }
    this.cacheSet(cacheKey, match.recordId);
    return match.recordId;
  }

  /**
   * Updates an existing resource in the Registry.
   */
  async updateResource(
    type: ResourceType,
    id: string,
    input: UpdateResourceInput,
  ): Promise<RegistryRecord> {
    const recordId = id;
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
    const recordId = id;
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
    const recordId = id;
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
              descriptorType: 'CUSTOM',
              nextToken,
            }),
          ),
      );

      if (result.registryRecords) {
        for (const rec of result.registryRecords) {
          const recId = rec.recordId ?? '';
          if (!recId) {
            records.push(this.summaryToRecord(rec));
            continue;
          }
          try {
            // Call SDK directly — do NOT call getResource/resolveRecordId here,
            // which would recurse back into listResources for short ids.
            const detail: GetRegistryRecordCommandOutput = await this.withRetry(
              () =>
                this.client.send(
                  new GetRegistryRecordCommand({
                    registryId: this.registryId,
                    recordId: recId,
                  }),
                ),
            );
            const full: RegistryRecord = {
              recordId: detail.recordId ?? recId,
              name: detail.name ?? rec.name ?? '',
              description: detail.description,
              status: detail.status ?? rec.status ?? '',
              customDescriptorContent:
                detail.descriptors?.custom?.inlineContent,
              createdAt: detail.createdAt,
              updatedAt: detail.updatedAt,
            };
            // Filter by type using authoritative manifest-presence check:
            // agents always carry a `manifest` in customDescriptorContent;
            // tools store their config in the `description` field and have
            // no manifest.
            const meta = full.customDescriptorContent
              ? JSON.parse(full.customDescriptorContent)
              : {};
            const hasManifest = meta.manifest !== undefined;

            if (type === 'agent' && !hasManifest) {
              // Not an agent — agents always carry a manifest in
              // customDescriptorContent. Skip tool records (which store
              // their config in the `description` field instead).
              continue;
            }
            if (type === 'tool' && hasManifest) {
              // Not a tool — the presence of a manifest indicates this is
              // an agent record.
              continue;
            }
            records.push(full);
            continue;
          } catch {
            /* fall through */
          }
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
              descriptorType: 'CUSTOM',
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
        return RegistryRecordStatusValues.DEPRECATED;
      case 'maintenance':
        return RegistryRecordStatusValues.DRAFT;
      default:
        console.warn(
          `Unknown internal state "${internalState}", mapping to DEPRECATED`,
        );
        return RegistryRecordStatusValues.DEPRECATED;
    }
  }

  /**
   * Maps a Registry record status to the internal application state.
   *
   * Every RegistryRecordStatus value is mapped to the 3-value AgentState
   * enum (active | inactive | maintenance):
   *
   * | Registry          | Internal    |
   * |-------------------|-------------|
   * | APPROVED          | active      |
   * | UPDATING          | active      |
   * | PENDING_APPROVAL  | active      |
   * | DRAFT             | maintenance |
   * | CREATING          | maintenance |
   * | DEPRECATED        | inactive    |
   * | REJECTED          | inactive    |
   * | CREATE_FAILED     | inactive    |
   * | UPDATE_FAILED     | inactive    |
   *
   * PENDING_APPROVAL surfaces as 'active' because SubmitRegistryRecordForApproval
   * is async and reflecting user intent avoids UI flicker during auto-approval.
   *
   * Unknown Registry statuses default to 'inactive' with a warning log.
   */
  toInternalState(registryStatus: RegistryRecordStatusValue | string | undefined): string {
    // Map every RegistryRecordStatus value to the 3-value AgentState enum
    // (active | inactive | maintenance). PENDING_APPROVAL surfaces as 'active'
    // because SubmitRegistryRecordForApproval is async and reflecting user
    // intent avoids UI flicker during auto-approval.
    switch (registryStatus) {
      case RegistryRecordStatusValues.APPROVED:
      case RegistryRecordStatusValues.UPDATING:
      case RegistryRecordStatusValues.PENDING_APPROVAL:
        return 'active';
      case RegistryRecordStatusValues.DRAFT:
      case RegistryRecordStatusValues.CREATING:
        return 'maintenance';
      case RegistryRecordStatusValues.DEPRECATED:
      case RegistryRecordStatusValues.REJECTED:
      case RegistryRecordStatusValues.CREATE_FAILED:
      case RegistryRecordStatusValues.UPDATE_FAILED:
        return 'inactive';
      default:
        console.warn(`Unknown registry status "${registryStatus}", mapping to 'inactive'`);
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
    orgId: undefined,
    invocation: undefined,
    origin: undefined,
    governanceAttestation: undefined,
  };

  private static readonly TOOL_METADATA_DEFAULTS: ToolCustomMetadata = {
    categories: [],
    icon: '',
    state: 'active',
    integrationBindings: undefined,
    dataStoreBindings: undefined,
    appId: undefined,
    config: undefined,
    createdBy: undefined,
    orgId: undefined,
  };

  /**
   * Sanitises bindings read from custom_metadata so that GraphQL responses
   * never carry entries whose required string fields are null/empty. Mirrors
   * sanitizeIntegrationBindings / sanitizeDataStoreBindings in
   * tool-config-resolver.ts so both code paths agree on the response shape.
   * Returns null when no valid binding remains, matching the schema's
   * "[Binding]" (optional list) shape.
   */
  private static sanitizeIntegrationBindings(
    bindings: any,
  ): IntegrationBinding[] | null {
    if (!Array.isArray(bindings) || bindings.length === 0) return null;
    const cleaned = bindings.filter(
      (b: any) =>
        b &&
        typeof b.integrationId === 'string' && b.integrationId.length > 0 &&
        typeof b.integrationType === 'string' && b.integrationType.length > 0,
    );
    return cleaned.length > 0 ? (cleaned as IntegrationBinding[]) : null;
  }

  private static sanitizeDataStoreBindings(
    bindings: any,
  ): DataStoreBinding[] | null {
    if (!Array.isArray(bindings) || bindings.length === 0) return null;
    const cleaned = bindings.filter(
      (b: any) =>
        b &&
        typeof b.dataStoreId === 'string' && b.dataStoreId.length > 0 &&
        typeof b.dataStoreType === 'string' && b.dataStoreType.length > 0,
    );
    return cleaned.length > 0 ? (cleaned as DataStoreBinding[]) : null;
  }

  /**
   * Maps a Registry record to the AgentConfig GraphQL response shape.
   */
  mapToAgentConfig(record: RegistryRecord): AgentConfig {
    const meta = this.deserializeCustomMetadata<AgentCustomMetadata>(
      record.customDescriptorContent ?? null,
      RegistryService.AGENT_METADATA_DEFAULTS,
    );

    return {
      agentId: record.recordId,
      name: record.name ?? '',
      orgId: meta.orgId ?? '',
      config: record.description ?? '',
      state: this.toInternalState(record.status),
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
      toolId: record.recordId,
      orgId: meta.orgId ?? '',
      // New records: config comes from custom_metadata.config (see tool-config-resolver createToolConfigRegistry).
      // Legacy records: fall back to record.description which previously carried the full JSON blob.
      config: meta.config ?? record.description ?? '',
      state: this.toInternalState(record.status),
      categories: meta.categories,
      integrationBindings: RegistryService.sanitizeIntegrationBindings(meta.integrationBindings),
      dataStoreBindings: RegistryService.sanitizeDataStoreBindings(meta.dataStoreBindings),
      createdAt: record.createdAt?.toISOString(),
      updatedAt: record.updatedAt?.toISOString(),
    };
  }
}
