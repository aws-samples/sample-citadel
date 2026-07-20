/**
 * Unit tests for `ensureAppAgentBindings` — the exported idempotent
 * bind-and-promote orchestration the intake post-fabrication resolver uses to
 * associate a session's fabricated agents with an intake-created app.
 *
 * Contract under test (reuses the canonical addAppComponent /
 * updateAgentBinding cores — no new binding logic):
 *  - missing agents are bound and promoted to READY (registry-fabricated
 *    agents: descriptor `state: 'inactive'` but record status APPROVED must
 *    pass the READY gate — the authoritative state is
 *    toInternalState(record.status), NOT the stale descriptor mirror);
 *  - existing READY bindings are untouched (no demotion, no duplicates,
 *    addedAt preserved);
 *  - existing DESIGN bindings are promoted (convergent healing);
 *  - a per-agent failure is itemized, never thrown (partial success);
 *  - transient registry conflicts (UPDATING / ConflictException) are retried
 *    with a small bounded budget;
 *  - the final projection carries all bindings READY — exactly what
 *    AppDetailView's `buildPreconditions` "All agents are READY" check
 *    consumes for publish.
 */

process.env.REGISTRY_ID = 'test-registry-id';
process.env.APPS_TABLE = 'citadel-apps-test';
process.env.WORKFLOWS_TABLE = 'citadel-workflows-test';
process.env.AGENT_CONFIG_TABLE = 'citadel-agents-test';
process.env.EVENT_BUS_NAME = 'citadel-agents-test';
process.env.USER_POOL_ID = 'us-east-1_test';
process.env.AUTHORITY_UNITS_TABLE = 'test-authority-units';
process.env.AWS_REGION = 'us-east-1';
// No model catalog wired — bindings here never carry a modelOverride, so the
// catalog validator must not be reached at all.
delete process.env.MODEL_CATALOG_TABLE;

import { EventBridgeClient, PutEventsCommand } from '@aws-sdk/client-eventbridge';
import { mockClient } from 'aws-sdk-client-mock';

const ebMock = mockClient(EventBridgeClient);

// ── Stateful in-memory registry ─────────────────────────────────────────────
// The shared fixture's updateResource does not translate `customMetadata` →
// `customDescriptorContent`, which breaks multi-step read-after-write flows.
// This suite needs sequential addAppComponent → updateAgentBinding calls to
// observe each other's writes, so it keeps its own tiny stateful store with
// the same translation the real RegistryService performs.

interface StoredRecord {
  recordId: string;
  name: string;
  description?: string;
  status: string;
  customDescriptorContent?: string;
}

const store = new Map<string, StoredRecord>();

/** Per-call failure injection: `updateResource` throws these (in order) first. */
let updateFailureQueue: Error[] = [];
let updateResourceCalls = 0;

function seed(recordId: string, record: Omit<StoredRecord, 'recordId'>): void {
  store.set(recordId, { recordId, ...record });
}

jest.mock('../../services/registry-service', () => {
  const actual = jest.requireActual('../../services/registry-service');
  // Mirrors RegistryService.toInternalState (service semantics:
  // PENDING_APPROVAL → 'active'), NOT registry-sync's cache-facing mirror.
  const toInternalState = (status: string | undefined): string => {
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
  };
  const service = {
    async getResource(_type: string, id: string) {
      return store.get(id) ?? null;
    },
    async resolveRecordId(_type: string, id: string) {
      return id;
    },
    async listResources() {
      return Array.from(store.values());
    },
    async updateResource(
      _type: string,
      id: string,
      input: { customMetadata?: string; name?: string },
    ) {
      updateResourceCalls += 1;
      const injected = updateFailureQueue.shift();
      if (injected) throw injected;
      const existing = store.get(id);
      if (!existing) throw new Error(`Record not found: ${id}`);
      const updated: StoredRecord = {
        ...existing,
        ...(input.name !== undefined && { name: input.name }),
        ...(input.customMetadata !== undefined && {
          customDescriptorContent: input.customMetadata,
        }),
      };
      store.set(id, updated);
      return updated;
    },
    toInternalState,
  };
  return {
    ...actual,
    RegistryService: jest.fn().mockImplementation(() => service),
    getRegistryService: jest.fn(() => service),
    _resetRegistryService: jest.fn(),
    isRegistryEnabled: jest.fn(() => true),
  };
});

jest.mock('../../utils/appsync', () => ({
  getUserId: jest.fn().mockReturnValue('user-123'),
}));

jest.mock('../../utils/appsync-publish', () => ({
  publishAppStatusEvent: jest.fn().mockResolvedValue(undefined),
}));

import { ensureAppAgentBindings } from '../registry-agent-record-resolver';

// ── Fixtures ────────────────────────────────────────────────────────────────

const APP_ID = 'app000000001';

function seedApp(agentBindings: Array<Record<string, unknown>> = []): void {
  seed(APP_ID, {
    name: 'Intake App',
    description: 'Test',
    status: 'DRAFT',
    customDescriptorContent: JSON.stringify({
      appId: APP_ID,
      manifest: {
        orgId: 'org-1',
        version: 1,
        status: 'DRAFT',
        createdBy: 'user-123',
        workflowIds: [],
        agentBindings,
        permissions: [],
        configSchema: null,
        configValues: null,
        authConfig: null,
        access: {},
        routingConfig: null,
      },
    }),
  });
}

/**
 * A registry-fabricated agent after intakeActivateProjectAgents: the
 * fabricator wrote descriptor `state: 'inactive'` and activation flipped ONLY
 * the record status to APPROVED (SubmitRegistryRecordForApproval never
 * rewrites the descriptor). The stale descriptor is the dual-store trap.
 */
function seedFabricatedActiveAgent(recordId: string): void {
  seed(recordId, {
    name: `fabricated_${recordId}`,
    status: 'APPROVED',
    customDescriptorContent: JSON.stringify({
      categories: ['worker'],
      icon: '',
      state: 'inactive',
      manifest: { name: recordId, tools: [] },
      sourceProjectId: 'sess-1111',
    }),
  });
}

/** A fabricated agent whose activation FAILED — still DRAFT. */
function seedFabricatedDraftAgent(recordId: string): void {
  seed(recordId, {
    name: `fabricated_${recordId}`,
    status: 'DRAFT',
    customDescriptorContent: JSON.stringify({
      categories: ['worker'],
      state: 'inactive',
      manifest: { name: recordId, tools: [] },
      sourceProjectId: 'sess-1111',
    }),
  });
}

function appBindings(): Array<{ agentId: string; status: string; addedAt: string }> {
  const record = store.get(APP_ID)!;
  const descriptor = JSON.parse(record.customDescriptorContent ?? '{}');
  return descriptor.manifest?.agentBindings ?? [];
}

function conflictError(): Error {
  const err = new Error('Registry record is in UPDATING state');
  err.name = 'ConflictException';
  return err;
}

// ── Tests ───────────────────────────────────────────────────────────────────

describe('ensureAppAgentBindings', () => {
  beforeEach(() => {
    store.clear();
    updateFailureQueue = [];
    updateResourceCalls = 0;
    ebMock.reset();
    ebMock.on(PutEventsCommand).resolves({});
  });

  test('binds missing fabricated agents and promotes them to READY (stale inactive descriptor, APPROVED status)', async () => {
    seedApp();
    seedFabricatedActiveAgent('agt000000001');
    seedFabricatedActiveAgent('agt000000002');

    const result = await ensureAppAgentBindings(
      APP_ID,
      ['agt000000001', 'agt000000002'],
      'user-123',
    );

    expect(result.bound).toEqual(['agt000000001', 'agt000000002']);
    expect(result.failed).toEqual([]);
    expect(result.alreadyBound).toEqual([]);

    const bindings = appBindings();
    expect(bindings).toHaveLength(2);
    // The publish-precondition evidence: AppDetailView buildPreconditions
    // passes "All agents are READY" iff bindings.length > 0 and none DESIGN.
    expect(bindings.every((b) => b.status === 'READY')).toBe(true);
    expect(bindings.map((b) => b.agentId).sort()).toEqual([
      'agt000000001',
      'agt000000002',
    ]);
  });

  test('returns the final app projection with READY bindings for the mutation response', async () => {
    seedApp();
    seedFabricatedActiveAgent('agt000000001');

    const result = await ensureAppAgentBindings(APP_ID, ['agt000000001'], 'user-123');

    const projected = result.finalApp as { agentBindings?: Array<{ status: string }> } | null;
    expect(projected).not.toBeNull();
    expect(projected!.agentBindings).toHaveLength(1);
    expect(projected!.agentBindings![0].status).toBe('READY');
  });

  test('leaves existing READY bindings untouched — no duplicate, no reset, addedAt preserved', async () => {
    seedApp([
      { agentId: 'agt000000001', status: 'READY', addedAt: '2026-01-01T00:00:00Z' },
    ]);
    seedFabricatedActiveAgent('agt000000001');
    seedFabricatedActiveAgent('agt000000002');

    const result = await ensureAppAgentBindings(
      APP_ID,
      ['agt000000001', 'agt000000002'],
      'user-123',
    );

    expect(result.alreadyBound).toEqual(['agt000000001']);
    expect(result.bound).toEqual(['agt000000002']);

    const bindings = appBindings();
    expect(bindings).toHaveLength(2);
    const existing = bindings.find((b) => b.agentId === 'agt000000001')!;
    expect(existing.status).toBe('READY');
    expect(existing.addedAt).toBe('2026-01-01T00:00:00Z');
  });

  test('is idempotent: a second identical call performs no registry writes', async () => {
    seedApp();
    seedFabricatedActiveAgent('agt000000001');
    await ensureAppAgentBindings(APP_ID, ['agt000000001'], 'user-123');

    const writesAfterFirst = updateResourceCalls;
    const second = await ensureAppAgentBindings(APP_ID, ['agt000000001'], 'user-123');

    expect(second.alreadyBound).toEqual(['agt000000001']);
    expect(second.bound).toEqual([]);
    expect(updateResourceCalls).toBe(writesAfterFirst);
    expect(appBindings()).toHaveLength(1);
  });

  test('promotes an existing DESIGN binding to READY without re-adding it (heals strays)', async () => {
    seedApp([
      { agentId: 'agt000000001', status: 'DESIGN', addedAt: '2026-01-01T00:00:00Z' },
    ]);
    seedFabricatedActiveAgent('agt000000001');

    const result = await ensureAppAgentBindings(APP_ID, ['agt000000001'], 'user-123');

    expect(result.bound).toEqual(['agt000000001']);
    const bindings = appBindings();
    expect(bindings).toHaveLength(1);
    expect(bindings[0].status).toBe('READY');
    expect(bindings[0].addedAt).toBe('2026-01-01T00:00:00Z');
  });

  test('itemizes a per-agent failure without aborting the rest', async () => {
    seedApp();
    seedFabricatedDraftAgent('agt000000001'); // READY gate must reject: not active
    seedFabricatedActiveAgent('agt000000002');

    const result = await ensureAppAgentBindings(
      APP_ID,
      ['agt000000001', 'agt000000002'],
      'user-123',
    );

    expect(result.bound).toEqual(['agt000000002']);
    expect(result.failed).toHaveLength(1);
    expect(result.failed[0].agentId).toBe('agt000000001');
    expect(result.failed[0].error).toMatch(/active/i);

    const ready = appBindings().filter((b) => b.status === 'READY');
    expect(ready.map((b) => b.agentId)).toEqual(['agt000000002']);
  });

  test('retries a transient registry conflict with a bounded budget and still lands the binding', async () => {
    seedApp();
    seedFabricatedActiveAgent('agt000000001');
    updateFailureQueue = [conflictError()]; // first write attempt conflicts

    const result = await ensureAppAgentBindings(APP_ID, ['agt000000001'], 'user-123');

    expect(result.bound).toEqual(['agt000000001']);
    expect(result.failed).toEqual([]);
    expect(appBindings()[0].status).toBe('READY');
  });

  test('gives up after the bounded retry budget and itemizes the failure', async () => {
    seedApp();
    seedFabricatedActiveAgent('agt000000001');
    // More consecutive conflicts than the retry budget allows.
    updateFailureQueue = [conflictError(), conflictError(), conflictError(), conflictError(), conflictError(), conflictError()];

    const result = await ensureAppAgentBindings(APP_ID, ['agt000000001'], 'user-123');

    expect(result.bound).toEqual([]);
    expect(result.failed).toHaveLength(1);
    expect(result.failed[0].agentId).toBe('agt000000001');
  });

  test('is a no-op for an empty agentId list', async () => {
    seedApp();

    const result = await ensureAppAgentBindings(APP_ID, [], 'user-123');

    expect(result).toMatchObject({ bound: [], alreadyBound: [], failed: [] });
    expect(updateResourceCalls).toBe(0);
  });

  test('deduplicates repeated agentIds in the input', async () => {
    seedApp();
    seedFabricatedActiveAgent('agt000000001');

    const result = await ensureAppAgentBindings(
      APP_ID,
      ['agt000000001', 'agt000000001'],
      'user-123',
    );

    expect(result.bound).toEqual(['agt000000001']);
    expect(appBindings()).toHaveLength(1);
  });

  test('throws when the app record does not exist (caller decides severity)', async () => {
    seedFabricatedActiveAgent('agt000000001');

    await expect(
      ensureAppAgentBindings('app-missing-1', ['agt000000001'], 'user-123'),
    ).rejects.toThrow('App not found');
  });
});
