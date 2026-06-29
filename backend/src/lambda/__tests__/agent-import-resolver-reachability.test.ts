/**
 * Tests for agent-import-resolver — BACKEND-ONLY reachability probe (US-IMP-017b).
 *
 * `probeImportReachability` loads a DRAFT import record, probes its resolved
 * endpoint (invocation.target) from THIS (non-VPC) Lambda, and persists the
 * classified result to customMetadata.reachability ONLY.
 *
 * Invariants asserted here:
 *   - admin/architect-gated; a non-privileged caller THROWS (the only throw)
 *     and never loads the record.
 *   - BEST-EFFORT: a thrown fetch (and even a persistence failure) still yields
 *     a classified result — no handler throw.
 *   - the persisted update touches customMetadata ONLY (Object.keys==['customMetadata'])
 *     and leaves manifest/invocation/state/governanceAttestation byte-for-byte.
 *   - a private endpoint is 'unverifiable_private' WITHOUT a fetch; a record
 *     with no endpoint is 'no_endpoint'.
 *   - no secret/credential is ever logged or returned.
 *
 * Mirrors agent-import-resolver-test-invoke.test.ts mocking: RegistryService,
 * auth-event, agent-discovery, events, authority-lifecycle, governance-flag and
 * the ADR resolver are mocked so the module imports cleanly and never touches
 * AWS. The probe uses global.fetch (stubbed per-test); the REAL reachability
 * probe runs (it is not mocked).
 */

// ── Mock RegistryService ────────────────────────────────────────────────
const mockCreateResource = jest.fn();
const mockUpdateResource = jest.fn();
const mockListResources = jest.fn();
const mockGetResource = jest.fn();
const mockUpdateResourceStatus = jest.fn();
const mockSerializeCustomMetadata = jest.fn((meta: unknown) => JSON.stringify(meta));
const mockDeserializeCustomMetadata = jest.fn(
  (json: string | null | undefined, defaults: Record<string, unknown>) =>
    json ? { ...defaults, ...JSON.parse(json) } : defaults,
);
const mockMapToAgentConfig = jest.fn((record: { recordId: string }) => ({
  agentId: record.recordId,
}));
jest.mock('../../services/registry-service', () => ({
  RegistryService: jest.fn().mockImplementation(() => ({
    getRegistryId: () => 'test-registry',
    createResource: mockCreateResource,
    updateResource: mockUpdateResource,
    listResources: mockListResources,
    getResource: mockGetResource,
    updateResourceStatus: mockUpdateResourceStatus,
    serializeCustomMetadata: mockSerializeCustomMetadata,
    deserializeCustomMetadata: mockDeserializeCustomMetadata,
    mapToAgentConfig: mockMapToAgentConfig,
  })),
}));

// ── Mock auth-event ─────────────────────────────────────────────────────
const mockExtractOrgFromEvent = jest.fn();
const mockIsAdminFromEvent = jest.fn(() => false);
const mockHasRoleFromEvent = jest.fn(() => false);
jest.mock('../../utils/auth-event', () => ({
  extractOrgFromEvent: (...args: unknown[]) => mockExtractOrgFromEvent(...args),
  isAdminFromEvent: (...args: unknown[]) => mockIsAdminFromEvent(...args),
  hasRoleFromEvent: (...args: unknown[]) => mockHasRoleFromEvent(...args),
}));

// ── Mock agent-discovery (keep the real typed errors) ───────────────────
jest.mock('../../services/agent-discovery', () => {
  const actual = jest.requireActual('../../services/agent-discovery');
  return { __esModule: true, ...actual };
});

// ── Mock events publish helper (keep real EventTypes; never hit EventBridge)
const mockPublishEvent = jest.fn();
jest.mock('../../utils/events', () => {
  const actual = jest.requireActual('../../utils/events');
  return { __esModule: true, ...actual, publishEvent: (...a: unknown[]) => mockPublishEvent(...a) };
});

// ── Mock fabricator-authority lifecycle, governance flag, ADR resolver ──
jest.mock('../registry-agent-authority-lifecycle', () => ({
  __esModule: true,
  grantFabricatorAuthority: jest.fn(),
}));
jest.mock('../../utils/governance-flag', () => ({
  __esModule: true,
  getGovernanceEnforce: jest.fn().mockResolvedValue('permissive'),
}));
jest.mock('../adr-resolver', () => ({ __esModule: true, createADR: jest.fn() }));

import { probeImportReachability, handler, _resetRegistryService } from '../agent-import-resolver';

// ── Fixtures ────────────────────────────────────────────────────────────
const ORG = 'test-org-a';
const PUBLIC_TARGET = 'https://agent.example.com/invoke';
const PRIVATE_TARGET = 'https://10.0.0.5/invoke';

const adminEvent = { identity: { claims: { 'custom:role': 'admin' }, sub: 'admin-1' } };
const architectEvent = { identity: { claims: { 'custom:role': 'architect' }, sub: 'arch-1' } };
const developerEvent = { identity: { claims: { 'custom:organization': ORG }, sub: 'dev-1' } };

function baseMeta(overrides: Record<string, unknown> = {}): Record<string, unknown> {
  return {
    categories: [],
    icon: '',
    state: 'inactive',
    manifest: { name: 'imported' },
    invocation: {
      protocol: 'HTTP_ENDPOINT',
      target: PUBLIC_TARGET,
      auth: { mode: 'NONE' },
      mode: 'sync',
    },
    origin: {
      substrate: 'http',
      discoveredAt: '2026-06-28T00:00:00.000Z',
      ownership: 'external',
    },
    orgId: ORG,
    governanceAttestation: {
      status: 'pending',
      enforcementMode: 'permissive',
      authorityRequested: true,
      requestedAt: '2026-06-28T00:00:00.000Z',
    },
    ...overrides,
  };
}

function importRecord(meta: Record<string, unknown> = baseMeta()): Record<string, unknown> {
  return {
    recordId: 'imp-1',
    name: 'imported-agent',
    status: 'DRAFT',
    customDescriptorContent: JSON.stringify(meta),
  };
}

const realFetch = global.fetch;
afterAll(() => {
  global.fetch = realFetch;
});

beforeEach(() => {
  process.env.REGISTRY_ENABLED = 'true';
  process.env.REGISTRY_ID = 'test-registry';
  process.env.AWS_REGION = 'us-east-1';
  _resetRegistryService();
  jest.clearAllMocks();
  mockIsAdminFromEvent.mockReturnValue(false);
  mockHasRoleFromEvent.mockReturnValue(false);
  mockExtractOrgFromEvent.mockResolvedValue(ORG);
  mockGetResource.mockResolvedValue(importRecord());
  mockUpdateResource.mockResolvedValue(importRecord());
  // Default: a responding public endpoint.
  global.fetch = jest.fn().mockResolvedValue({ status: 200 }) as unknown as typeof fetch;
});

// ── authorization (admin | architect only; non-privileged THROWS) ────────
describe('probeImportReachability — authorization', () => {
  it('throws for a non-privileged caller and never loads the record', async () => {
    await expect(probeImportReachability('imp-1', developerEvent)).rejects.toThrow(/unauthor/i);
    expect(mockGetResource).not.toHaveBeenCalled();
    expect(mockUpdateResource).not.toHaveBeenCalled();
  });

  it('allows an admin and returns a classified reachable result', async () => {
    mockIsAdminFromEvent.mockReturnValue(true);
    const result = await probeImportReachability('imp-1', adminEvent);
    expect(result.reachable).toBe(true);
    expect(result.classification).toBe('reachable');
    expect(typeof result.checkedAt).toBe('string');
  });

  it('allows an architect caller', async () => {
    mockHasRoleFromEvent.mockImplementation((_e: unknown, role: string) => role === 'architect');
    const result = await probeImportReachability('imp-1', architectEvent);
    expect(result.classification).toBe('reachable');
    expect(mockHasRoleFromEvent).toHaveBeenCalledWith(expect.anything(), 'architect');
  });
});

// ── persistence: customMetadata ONLY, everything else untouched ──────────
describe('probeImportReachability — persists reachability to customMetadata ONLY', () => {
  beforeEach(() => mockIsAdminFromEvent.mockReturnValue(true));

  it('writes ONLY customMetadata and preserves manifest/invocation/state/governanceAttestation', async () => {
    await probeImportReachability('imp-1', adminEvent);

    expect(mockUpdateResource).toHaveBeenCalledTimes(1);
    const [type, id, update] = mockUpdateResource.mock.calls[0] as [
      string,
      string,
      Record<string, unknown>,
    ];
    expect(type).toBe('agent');
    expect(id).toBe('imp-1');
    // INVARIANT 4: the update touches customMetadata and nothing else.
    expect(Object.keys(update)).toEqual(['customMetadata']);

    const persisted = JSON.parse(update.customMetadata as string);
    // reachability stamped
    expect(persisted.reachability.classification).toBe('reachable');
    expect(persisted.reachability.reachable).toBe(true);
    expect(typeof persisted.reachability.checkedAt).toBe('string');
    // everything else byte-for-byte preserved
    expect(persisted.manifest).toEqual({ name: 'imported' });
    expect(persisted.invocation.target).toBe(PUBLIC_TARGET);
    expect(persisted.state).toBe('inactive');
    expect(persisted.governanceAttestation.status).toBe('pending');
  });

  it('classifies a private endpoint as unverifiable_private WITHOUT fetching', async () => {
    mockGetResource.mockResolvedValue(
      importRecord(
        baseMeta({
          invocation: {
            protocol: 'HTTP_ENDPOINT',
            target: PRIVATE_TARGET,
            auth: { mode: 'NONE' },
            mode: 'sync',
          },
        }),
      ),
    );
    const fetchSpy = jest.fn();
    global.fetch = fetchSpy as unknown as typeof fetch;

    const result = await probeImportReachability('imp-1', adminEvent);
    expect(result.classification).toBe('unverifiable_private');
    expect(result.reachable).toBe(false);
    expect(fetchSpy).not.toHaveBeenCalled();
    const [, , update] = mockUpdateResource.mock.calls[0] as [string, string, Record<string, unknown>];
    expect(JSON.parse(update.customMetadata as string).reachability.classification).toBe(
      'unverifiable_private',
    );
  });

  it('classifies a record with no invocation endpoint as no_endpoint', async () => {
    mockGetResource.mockResolvedValue(importRecord(baseMeta({ invocation: undefined })));
    const result = await probeImportReachability('imp-1', adminEvent);
    expect(result.classification).toBe('no_endpoint');
    expect(result.reachable).toBe(false);
  });
});

// ── best-effort (never throws on probe/persist failure) ──────────────────
describe('probeImportReachability — best-effort', () => {
  beforeEach(() => mockIsAdminFromEvent.mockReturnValue(true));

  it('a thrown fetch yields an unreachable result (no handler throw) and still persists', async () => {
    global.fetch = jest.fn().mockRejectedValue(new Error('ECONNRESET')) as unknown as typeof fetch;
    const result = await probeImportReachability('imp-1', adminEvent);
    expect(result.reachable).toBe(false);
    expect(result.classification).toBe('unreachable');
    expect(mockUpdateResource).toHaveBeenCalledTimes(1);
  });

  it('still returns a classified result when persistence throws', async () => {
    mockUpdateResource.mockRejectedValue(new Error('registry down'));
    const result = await probeImportReachability('imp-1', adminEvent);
    expect(result.classification).toBe('reachable');
    expect(result.reachable).toBe(true);
  });

  it('throws a clean not-found for a missing record', async () => {
    mockGetResource.mockResolvedValue(null);
    await expect(probeImportReachability('missing', adminEvent)).rejects.toThrow(/not found/i);
    expect(mockUpdateResource).not.toHaveBeenCalled();
  });
});

// ── secrets never logged or returned ─────────────────────────────────────
describe('probeImportReachability — secret hygiene', () => {
  it('never logs or returns a secret/credential', async () => {
    const SECRET = 'sk-live-REACH-super-secret-do-not-log-0123456789';
    mockIsAdminFromEvent.mockReturnValue(true);
    mockGetResource.mockResolvedValue(
      importRecord(
        baseMeta({
          invocation: {
            protocol: 'HTTP_ENDPOINT',
            target: PUBLIC_TARGET,
            auth: { mode: 'API_KEY', secretRef: SECRET },
            mode: 'sync',
          },
        }),
      ),
    );
    const logSpy = jest.spyOn(console, 'log').mockImplementation(() => {});
    const errSpy = jest.spyOn(console, 'error').mockImplementation(() => {});
    const warnSpy = jest.spyOn(console, 'warn').mockImplementation(() => {});
    // Also exercise the persist-failure log path.
    mockUpdateResource.mockRejectedValue(new Error('registry down'));

    const result = await probeImportReachability('imp-1', adminEvent);

    const logged = [...logSpy.mock.calls, ...errSpy.mock.calls, ...warnSpy.mock.calls]
      .flat()
      .map((a) => (typeof a === 'string' ? a : JSON.stringify(a)))
      .join(' ');
    expect(logged).not.toContain(SECRET);
    expect(JSON.stringify(result)).not.toContain(SECRET);

    logSpy.mockRestore();
    errSpy.mockRestore();
    warnSpy.mockRestore();
  });
});

// ── handler routing: Mutation.probeImportReachability ────────────────────
describe('handler — probeImportReachability', () => {
  it('routes the fieldName and returns the classified result', async () => {
    mockIsAdminFromEvent.mockReturnValue(true);
    const res = (await handler({
      info: { fieldName: 'probeImportReachability' },
      arguments: { importId: 'imp-1' },
      identity: adminEvent.identity,
    })) as { classification: string };
    expect(res.classification).toBe('reachable');
  });

  it('rejects an unauthenticated caller (no identity)', async () => {
    await expect(
      handler({ info: { fieldName: 'probeImportReachability' }, arguments: { importId: 'imp-1' } }),
    ).rejects.toThrow(/unauthenticated/i);
    expect(mockGetResource).not.toHaveBeenCalled();
  });

  it('throws when importId is missing', async () => {
    await expect(
      handler({
        info: { fieldName: 'probeImportReachability' },
        arguments: {},
        identity: adminEvent.identity,
      }),
    ).rejects.toThrow(/importId/i);
  });
});
