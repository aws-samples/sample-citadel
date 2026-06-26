/**
 * Tests for agent-import-resolver — agent import registration with conflict
 * resolution (US-IMP). Handler logic only; AppSync/CDK wiring is deferred.
 *
 * RegistryService and auth-event are mocked. fast-check drives the
 * idempotence property. Mirrors the mocking style of
 * agent-config-resolver-registry-crud.test.ts.
 */
import * as fc from 'fast-check';

// ── Mock RegistryService ────────────────────────────────────────────────
const mockCreateResource = jest.fn();
const mockUpdateResource = jest.fn();
const mockListResources = jest.fn();
const mockGetResource = jest.fn();
const mockUpdateResourceStatus = jest.fn();
const mockSerializeCustomMetadata = jest.fn((meta: unknown) => JSON.stringify(meta));
const mockDeserializeCustomMetadata = jest.fn(
  (json: string | null | undefined, defaults: Record<string, unknown>) => {
    if (!json) return defaults;
    try {
      return { ...defaults, ...JSON.parse(json) };
    } catch {
      return defaults;
    }
  },
);
const mockMapToAgentConfig = jest.fn(
  (record: { recordId: string; name?: string; description?: string }) => ({
    agentId: record.recordId,
    name: record.name ?? '',
    orgId: 'test-org-a',
    config: record.description ?? '',
    state: 'inactive',
    categories: [],
  }),
);

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

// ── Mock agent-discovery (functions only; KEEP the real typed errors so the
//    resolver's `instanceof` checks and our thrown fixtures share one class) ─
const mockResolveSourceRef = jest.fn();
const mockTagScanDiscover = jest.fn();
const mockCandidateFromManifest = jest.fn();
jest.mock('../../services/agent-discovery', () => {
  const actual = jest.requireActual('../../services/agent-discovery');
  return {
    __esModule: true,
    ...actual,
    resolveSourceRef: (...args: unknown[]) => mockResolveSourceRef(...args),
    tagScanDiscover: (...args: unknown[]) => mockTagScanDiscover(...args),
    candidateFromManifest: (...args: unknown[]) => mockCandidateFromManifest(...args),
  };
});

// ── Mock the agent-source registry factory (adapter.describe() hits AWS) ──
const mockDescribe = jest.fn();
const mockResolveAdapter = jest.fn(() => ({ describe: mockDescribe }));
jest.mock('../../adapters/agent-source/registry-factory', () => ({
  __esModule: true,
  buildDefaultAgentSourceRegistry: jest.fn(() => ({ resolve: mockResolveAdapter })),
}));

// ── Mock the events publish helper (KEEP the real EventTypes constants so the
//    resolver emits the correct detail-type strings, and the EventBridge client
//    is never constructed/contacted) ──────────────────────────────────────
const mockPublishEvent = jest.fn();
jest.mock('../../utils/events', () => {
  const actual = jest.requireActual('../../utils/events');
  return {
    __esModule: true,
    ...actual,
    publishEvent: (...args: unknown[]) => mockPublishEvent(...args),
  };
});

// ── Mock the fabricator-authority lifecycle (writes to DynamoDB; never AWS).
//    Governance attestation grants one authority unit per imported record. ──
const mockGrantFabricatorAuthority = jest.fn();
jest.mock('../registry-agent-authority-lifecycle', () => ({
  __esModule: true,
  grantFabricatorAuthority: (...args: unknown[]) => mockGrantFabricatorAuthority(...args),
}));

// ── Mock the governance rollout flag reader (reads SSM; never AWS). The
//    import stamps the resolved enforcement mode into the attestation. ──
const mockGetGovernanceEnforce = jest.fn();
jest.mock('../../utils/governance-flag', () => ({
  __esModule: true,
  getGovernanceEnforce: (...args: unknown[]) => mockGetGovernanceEnforce(...args),
}));

import {
  importAgent,
  handler,
  buildImportCopyName,
  buildImportDescriptor,
  toImportAgentResult,
  _resetRegistryService,
} from '../agent-import-resolver';
import type {
  ImportConflictResult,
  ImportAgentResult,
  FlatAgentCandidate,
} from '../agent-import-resolver';
import { UnsupportedSourceError, InvalidSourceRefError } from '../../services/agent-discovery';
import { EventTypes } from '../../utils/events';

// ── Fixtures ────────────────────────────────────────────────────────────
const ORG = 'test-org-a';
const SOURCE_ARN = 'arn:aws:bedrock-agentcore:us-east-1:111122223333:runtime/pay';
const eventWithOrg = {
  identity: { claims: { 'custom:organization': ORG }, sub: 'user-1' },
};

type Overrides = Record<string, unknown>;

function validInput(overrides: Overrides = {}): Record<string, unknown> {
  return {
    name: 'PaymentsAgent',
    manifest: { name: 'PaymentsAgent', description: 'Handles payments', version: '1.0.0' },
    invocation: {
      protocol: 'AGENTCORE_RUNTIME',
      target: SOURCE_ARN,
      auth: { mode: 'SIGV4' },
      mode: 'sync',
    },
    origin: {
      sourceArn: SOURCE_ARN,
      substrate: 'agentcore_runtime',
      discoveredAt: '2026-06-26T00:00:00.000Z',
      ownership: 'external',
    },
    categories: ['payments'],
    ...overrides,
  };
}

/**
 * Flat AppSync `ImportAgentInput` fixture (what the resolver receives over the
 * wire) — mirrors {@link validInput} but with the invocation/origin fields
 * flattened, to exercise the handler's flat → nested mapping.
 */
function validFlatInput(overrides: Overrides = {}): Record<string, unknown> {
  return {
    name: 'PaymentsAgent',
    manifest: { name: 'PaymentsAgent', description: 'Handles payments', version: '1.0.0' },
    invocationProtocol: 'AGENTCORE_RUNTIME',
    invocationTarget: SOURCE_ARN,
    invocationAuthMode: 'SIGV4',
    invocationMode: 'sync',
    sourceArn: SOURCE_ARN,
    substrate: 'agentcore_runtime',
    categories: ['payments'],
    ...overrides,
  };
}

function existingRecord(opts: {
  recordId: string;
  name: string;
  sourceArn?: string;
  orgId?: string;
}) {
  return {
    recordId: opts.recordId,
    name: opts.name,
    description: '{"name":"' + opts.name + '"}',
    status: 'DRAFT',
    customDescriptorContent: JSON.stringify({
      orgId: opts.orgId ?? ORG,
      manifest: {},
      origin: { sourceArn: opts.sourceArn, ownership: 'external' },
    }),
    createdAt: new Date('2026-01-01'),
    updatedAt: new Date('2026-01-01'),
  };
}

beforeEach(() => {
  process.env.REGISTRY_ENABLED = 'true';
  process.env.REGISTRY_ID = 'test-registry';
  process.env.AWS_REGION = 'us-east-1';
  _resetRegistryService();
  jest.clearAllMocks();
  mockExtractOrgFromEvent.mockResolvedValue(ORG);
  // Discovery authz: deny by default each test (clearAllMocks preserves a
  // prior test's mockReturnValue, so re-establish the safe default here).
  mockIsAdminFromEvent.mockReturnValue(false);
  mockHasRoleFromEvent.mockReturnValue(false);
  mockListResources.mockResolvedValue([]);
  mockCreateResource.mockImplementation(async (_type: string, id: string) =>
    existingRecord({ recordId: 'rec-new', name: id, sourceArn: SOURCE_ARN }),
  );
  mockUpdateResource.mockImplementation(async (_type: string, id: string) =>
    existingRecord({ recordId: id, name: 'PaymentsAgent', sourceArn: SOURCE_ARN }),
  );
  // Governance attestation: the authority grant resolves cleanly and the
  // rollout flag has a deterministic default; individual tests override.
  mockGrantFabricatorAuthority.mockResolvedValue(undefined);
  mockGetGovernanceEnforce.mockResolvedValue('permissive');
});

// ── importAgent: create (no conflict) ───────────────────────────────────
describe('importAgent — create (no existing match)', () => {
  it('creates exactly one DRAFT/inactive record, never auto-activating', async () => {
    const created = existingRecord({ recordId: 'rec-1', name: 'PaymentsAgent', sourceArn: SOURCE_ARN });
    mockCreateResource.mockResolvedValue(created);

    // Input deliberately tries to inject an orgId — it must be ignored.
    const result = await importAgent(validInput({ orgId: 'evil-org' }), eventWithOrg);

    expect(mockCreateResource).toHaveBeenCalledTimes(1);
    const [type, id] = mockCreateResource.mock.calls[0];
    expect(type).toBe('agent');
    expect(id).toBe('PaymentsAgent');
    expect(result).toEqual(expect.objectContaining({ agentId: 'rec-1' }));
  });

  it('serializes metadata with state inactive, external ownership, and event-derived orgId', async () => {
    mockCreateResource.mockResolvedValue(
      existingRecord({ recordId: 'rec-1', name: 'PaymentsAgent', sourceArn: SOURCE_ARN }),
    );

    await importAgent(validInput({ orgId: 'evil-org' }), eventWithOrg);

    expect(mockSerializeCustomMetadata).toHaveBeenCalledWith(
      expect.objectContaining({
        state: 'inactive',
        orgId: ORG,
        origin: expect.objectContaining({ ownership: 'external' }),
      }),
    );
    const metaArg = mockSerializeCustomMetadata.mock.calls[0][0] as { orgId: string };
    expect(metaArg.orgId).toBe(ORG);
    expect(metaArg.orgId).not.toBe('evil-org');
  });

  it('passes a stringified customMetadata to createResource', async () => {
    mockCreateResource.mockResolvedValue(
      existingRecord({ recordId: 'rec-1', name: 'PaymentsAgent', sourceArn: SOURCE_ARN }),
    );
    await importAgent(validInput(), eventWithOrg);
    const payload = mockCreateResource.mock.calls[0][2] as { customMetadata: unknown; description: unknown };
    expect(typeof payload.customMetadata).toBe('string');
    expect(typeof payload.description).toBe('string');
  });

  it('never calls updateResourceStatus (no APPROVED auto-activation)', async () => {
    mockCreateResource.mockResolvedValue(
      existingRecord({ recordId: 'rec-1', name: 'PaymentsAgent', sourceArn: SOURCE_ARN }),
    );
    await importAgent(validInput(), eventWithOrg);
    expect(mockUpdateResourceStatus).not.toHaveBeenCalled();
  });
});

// ── importAgent: validation / auth guards ───────────────────────────────
describe('importAgent — guards', () => {
  it('throws when the caller organization cannot be determined', async () => {
    mockExtractOrgFromEvent.mockResolvedValue(null);
    await expect(importAgent(validInput(), eventWithOrg)).rejects.toThrow(/organization/i);
    expect(mockCreateResource).not.toHaveBeenCalled();
  });

  it('throws listing invocation.protocol when the invocation block is invalid', async () => {
    const bad = validInput({ invocation: { target: 't', auth: { mode: 'NONE' }, mode: 'sync' } });
    await expect(importAgent(bad, eventWithOrg)).rejects.toThrow(/invocation\.protocol/);
    expect(mockCreateResource).not.toHaveBeenCalled();
  });

  it('throws listing origin.ownership when ownership is not external', async () => {
    const bad = validInput({
      origin: { sourceArn: SOURCE_ARN, substrate: 's', discoveredAt: 'd', ownership: 'internal' },
    });
    await expect(importAgent(bad, eventWithOrg)).rejects.toThrow(/origin\.ownership/);
  });
});

// ── importAgent: conflict resolution ────────────────────────────────────
describe('importAgent — conflict resolution', () => {
  it('returns a conflict result (no create) on sourceArn match with no onConflict', async () => {
    mockListResources.mockResolvedValue([
      existingRecord({ recordId: 'rec-existing', name: 'OldPay', sourceArn: SOURCE_ARN }),
    ]);

    const result = (await importAgent(validInput(), eventWithOrg)) as ImportConflictResult;

    expect(result).toEqual(
      expect.objectContaining({
        conflict: true,
        existingId: 'rec-existing',
        reason: 'sourceArn',
        options: expect.arrayContaining(['link', 'replace', 'copy']),
      }),
    );
    expect(mockCreateResource).not.toHaveBeenCalled();
    expect(mockUpdateResource).not.toHaveBeenCalled();
  });

  it('detects a name collision (reason="name") when sourceArn differs', async () => {
    mockListResources.mockResolvedValue([
      existingRecord({ recordId: 'rec-name', name: 'PaymentsAgent', sourceArn: 'arn:other' }),
    ]);

    const result = (await importAgent(validInput(), eventWithOrg)) as ImportConflictResult;

    expect(result.conflict).toBe(true);
    expect(result.reason).toBe('name');
    expect(result.existingId).toBe('rec-name');
    expect(mockCreateResource).not.toHaveBeenCalled();
  });

  it('does NOT treat a same-sourceArn record in another org as a conflict (tenant isolation)', async () => {
    mockListResources.mockResolvedValue([
      existingRecord({ recordId: 'rec-other-org', name: 'OldPay', sourceArn: SOURCE_ARN, orgId: 'other-org' }),
    ]);
    mockCreateResource.mockResolvedValue(
      existingRecord({ recordId: 'rec-fresh', name: 'PaymentsAgent', sourceArn: SOURCE_ARN }),
    );

    const result = await importAgent(validInput(), eventWithOrg);

    expect(result).toEqual(expect.objectContaining({ agentId: 'rec-fresh' }));
    expect(mockCreateResource).toHaveBeenCalledTimes(1);
  });

  it('onConflict="link" returns the existing mapped record with no create/update', async () => {
    const existing = existingRecord({ recordId: 'rec-existing', name: 'OldPay', sourceArn: SOURCE_ARN });
    mockListResources.mockResolvedValue([existing]);

    const result = await importAgent(validInput({ onConflict: 'link' }), eventWithOrg);

    expect(mockMapToAgentConfig).toHaveBeenCalledWith(existing);
    expect(result).toEqual(expect.objectContaining({ agentId: 'rec-existing' }));
    expect(mockCreateResource).not.toHaveBeenCalled();
    expect(mockUpdateResource).not.toHaveBeenCalled();
  });

  it('onConflict="replace" updates the existing recordId in place', async () => {
    const existing = existingRecord({ recordId: 'rec-existing', name: 'OldPay', sourceArn: SOURCE_ARN });
    mockListResources.mockResolvedValue([existing]);
    mockUpdateResource.mockResolvedValue(existing);

    await importAgent(validInput({ onConflict: 'replace' }), eventWithOrg);

    expect(mockUpdateResource).toHaveBeenCalledTimes(1);
    const [type, id] = mockUpdateResource.mock.calls[0];
    expect(type).toBe('agent');
    expect(id).toBe('rec-existing');
    expect(mockCreateResource).not.toHaveBeenCalled();
  });

  it('onConflict="copy" creates a record with a suffixed name', async () => {
    const existing = existingRecord({ recordId: 'rec-existing', name: 'PaymentsAgent', sourceArn: SOURCE_ARN });
    mockListResources.mockResolvedValue([existing]);
    mockCreateResource.mockResolvedValue(
      existingRecord({ recordId: 'rec-copy', name: 'PaymentsAgent (imported copy)', sourceArn: SOURCE_ARN }),
    );

    await importAgent(validInput({ onConflict: 'copy' }), eventWithOrg);

    expect(mockCreateResource).toHaveBeenCalledTimes(1);
    expect(mockCreateResource.mock.calls[0][1]).toBe('PaymentsAgent (imported copy)');
  });
});

// ── importAgent: governance attestation (US governance retrofit) ─────────
// On a record-creating import (create / replace / copy) the resolver stamps a
// 'pending' governanceAttestation into the customMetadata AND best-effort
// grants exactly one fabricator authority unit for the new recordId. A no-op
// link or unresolved conflict (neither creates a record) does NEITHER.
describe('importAgent — governance attestation', () => {
  const ISO = /^\d{4}-\d{2}-\d{2}T\d{2}:\d{2}:\d{2}\.\d{3}Z$/;

  /** The metadata object handed to serializeCustomMetadata (pre-stringify). */
  const stampedMeta = (): Record<string, unknown> | undefined => {
    const call = mockSerializeCustomMetadata.mock.calls[0];
    return call ? (call[0] as Record<string, unknown>) : undefined;
  };

  it('stamps a pending governanceAttestation with the resolved enforcement mode on create', async () => {
    mockGetGovernanceEnforce.mockResolvedValue('shadow');
    mockCreateResource.mockResolvedValue(
      existingRecord({ recordId: 'rec-1', name: 'PaymentsAgent', sourceArn: SOURCE_ARN }),
    );

    await importAgent(validInput(), eventWithOrg);

    expect(mockSerializeCustomMetadata).toHaveBeenCalledWith(
      expect.objectContaining({
        governanceAttestation: expect.objectContaining({
          status: 'pending',
          enforcementMode: 'shadow',
          authorityRequested: true,
          requestedAt: expect.stringMatching(ISO),
        }),
      }),
    );
  });

  it('grants exactly one fabricator authority unit for the created recordId', async () => {
    mockCreateResource.mockResolvedValue(
      existingRecord({ recordId: 'rec-1', name: 'PaymentsAgent', sourceArn: SOURCE_ARN }),
    );

    await importAgent(validInput(), eventWithOrg);

    expect(mockGrantFabricatorAuthority).toHaveBeenCalledTimes(1);
    expect(mockGrantFabricatorAuthority).toHaveBeenCalledWith('rec-1');
  });

  it('still returns the created agent when grantFabricatorAuthority throws (best-effort, logged)', async () => {
    mockCreateResource.mockResolvedValue(
      existingRecord({ recordId: 'rec-1', name: 'PaymentsAgent', sourceArn: SOURCE_ARN }),
    );
    mockGrantFabricatorAuthority.mockRejectedValue(new Error('authority-units table down'));
    const errSpy = jest.spyOn(console, 'error').mockImplementation(() => {});

    const result = await importAgent(validInput(), eventWithOrg);

    expect(result).toEqual(expect.objectContaining({ agentId: 'rec-1' }));
    expect(errSpy).toHaveBeenCalled();
    errSpy.mockRestore();
  });

  it('stamps attestation and grants authority on replace (existing recordId)', async () => {
    const existing = existingRecord({ recordId: 'rec-existing', name: 'OldPay', sourceArn: SOURCE_ARN });
    mockListResources.mockResolvedValue([existing]);
    mockUpdateResource.mockResolvedValue(existing);

    await importAgent(validInput({ onConflict: 'replace' }), eventWithOrg);

    expect(stampedMeta()).toEqual(
      expect.objectContaining({
        governanceAttestation: expect.objectContaining({ status: 'pending', authorityRequested: true }),
      }),
    );
    expect(mockGrantFabricatorAuthority).toHaveBeenCalledTimes(1);
    expect(mockGrantFabricatorAuthority).toHaveBeenCalledWith('rec-existing');
  });

  it('stamps attestation and grants authority on copy (new recordId)', async () => {
    const existing = existingRecord({ recordId: 'rec-existing', name: 'PaymentsAgent', sourceArn: SOURCE_ARN });
    mockListResources.mockResolvedValue([existing]);
    mockCreateResource.mockResolvedValue(
      existingRecord({ recordId: 'rec-copy', name: 'PaymentsAgent (imported copy)', sourceArn: SOURCE_ARN }),
    );

    await importAgent(validInput({ onConflict: 'copy' }), eventWithOrg);

    expect(stampedMeta()).toEqual(
      expect.objectContaining({ governanceAttestation: expect.objectContaining({ status: 'pending' }) }),
    );
    expect(mockGrantFabricatorAuthority).toHaveBeenCalledTimes(1);
    expect(mockGrantFabricatorAuthority).toHaveBeenCalledWith('rec-copy');
  });

  it('does NOT grant authority or stamp attestation on a no-op link', async () => {
    const existing = existingRecord({ recordId: 'rec-existing', name: 'OldPay', sourceArn: SOURCE_ARN });
    mockListResources.mockResolvedValue([existing]);

    await importAgent(validInput({ onConflict: 'link' }), eventWithOrg);

    expect(mockGrantFabricatorAuthority).not.toHaveBeenCalled();
    expect(mockSerializeCustomMetadata).not.toHaveBeenCalled();
    expect(mockCreateResource).not.toHaveBeenCalled();
    expect(mockUpdateResource).not.toHaveBeenCalled();
  });

  it('does NOT grant authority or stamp attestation on an unresolved conflict', async () => {
    mockListResources.mockResolvedValue([
      existingRecord({ recordId: 'rec-existing', name: 'OldPay', sourceArn: SOURCE_ARN }),
    ]);

    const result = await importAgent(validInput(), eventWithOrg);

    expect(result).toEqual(expect.objectContaining({ conflict: true }));
    expect(mockGrantFabricatorAuthority).not.toHaveBeenCalled();
    expect(mockSerializeCustomMetadata).not.toHaveBeenCalled();
  });
});

// ── buildImportCopyName ─────────────────────────────────────────────────
describe('buildImportCopyName', () => {
  it('returns "<name> (imported copy)" when there is no collision', () => {
    expect(buildImportCopyName('Agent', new Set())).toBe('Agent (imported copy)');
  });

  it('appends an incrementing integer when the copy name also collides', () => {
    const taken = new Set(['Agent (imported copy)', 'Agent (imported copy 2)']);
    expect(buildImportCopyName('Agent', taken)).toBe('Agent (imported copy 3)');
  });
});

// ── buildImportDescriptor: flat AppSync input → nested descriptor ────────
describe('buildImportDescriptor', () => {
  it('nests flat invocation/origin fields and forces external ownership', () => {
    const d = buildImportDescriptor(validFlatInput());
    expect(d).toEqual(
      expect.objectContaining({
        name: 'PaymentsAgent',
        invocation: expect.objectContaining({
          protocol: 'AGENTCORE_RUNTIME',
          target: SOURCE_ARN,
          auth: { mode: 'SIGV4' },
          mode: 'sync',
        }),
        origin: expect.objectContaining({
          sourceArn: SOURCE_ARN,
          substrate: 'agentcore_runtime',
          ownership: 'external',
        }),
      }),
    );
  });

  it('parses an AWSJSON manifest delivered as a JSON string', () => {
    const d = buildImportDescriptor(validFlatInput({ manifest: '{"name":"X"}' }));
    expect(d.manifest).toEqual({ name: 'X' });
  });

  it('maps secretRef/region/account into invocation and origin', () => {
    const d = buildImportDescriptor(
      validFlatInput({
        invocationSecretRef: 'secret-1',
        region: 'us-west-2',
        account: '111122223333',
      }),
    );
    expect(d).toEqual(
      expect.objectContaining({
        invocation: expect.objectContaining({
          auth: { mode: 'SIGV4', secretRef: 'secret-1' },
          region: 'us-west-2',
          account: '111122223333',
        }),
        origin: expect.objectContaining({ region: 'us-west-2', account: '111122223333' }),
      }),
    );
  });

  it('lowercases the ImportConflictPolicy enum (REPLACE → replace)', () => {
    expect(buildImportDescriptor(validFlatInput({ onConflict: 'REPLACE' })).onConflict).toBe(
      'replace',
    );
    // Absent policy → omitted entirely (caller is re-prompted on conflict).
    expect('onConflict' in buildImportDescriptor(validFlatInput())).toBe(false);
  });
});

// ── toImportAgentResult: union → flat result shape ──────────────────────
describe('toImportAgentResult', () => {
  it('wraps a mapped AgentConfig as { agent, conflict:false }', () => {
    const agent = { agentId: 'rec-1', orgId: ORG, config: '{}', state: 'inactive' };
    expect(toImportAgentResult(agent)).toEqual({
      agent,
      conflict: false,
      existingId: null,
      reason: null,
      options: null,
    });
  });

  it('wraps a conflict as { agent:null, conflict:true, existingId, reason, options }', () => {
    const conflict: ImportConflictResult = {
      conflict: true,
      existingId: 'rec-existing',
      reason: 'sourceArn',
      options: ['link', 'replace', 'copy'],
    };
    expect(toImportAgentResult(conflict)).toEqual({
      agent: null,
      conflict: true,
      existingId: 'rec-existing',
      reason: 'sourceArn',
      options: ['link', 'replace', 'copy'],
    });
  });
});

// ── handler dispatch ────────────────────────────────────────────────────
describe('handler', () => {
  it('maps flat input, routes importAgent, and returns the success ImportAgentResult shape', async () => {
    mockCreateResource.mockResolvedValue(
      existingRecord({ recordId: 'rec-h', name: 'PaymentsAgent', sourceArn: SOURCE_ARN }),
    );
    const res = (await handler({
      info: { fieldName: 'importAgent' },
      arguments: { input: validFlatInput() },
      identity: eventWithOrg.identity,
    })) as ImportAgentResult;
    expect(res).toEqual({
      agent: expect.objectContaining({ agentId: 'rec-h' }),
      conflict: false,
      existingId: null,
      reason: null,
      options: null,
    });
  });

  it('returns the conflict ImportAgentResult shape (agent null) on a sourceArn match', async () => {
    mockListResources.mockResolvedValue([
      existingRecord({ recordId: 'rec-existing', name: 'OldPay', sourceArn: SOURCE_ARN }),
    ]);
    const res = (await handler({
      info: { fieldName: 'importAgent' },
      arguments: { input: validFlatInput() },
      identity: eventWithOrg.identity,
    })) as ImportAgentResult;
    expect(res).toEqual({
      agent: null,
      conflict: true,
      existingId: 'rec-existing',
      reason: 'sourceArn',
      options: expect.arrayContaining(['link', 'replace', 'copy']),
    });
    expect(mockCreateResource).not.toHaveBeenCalled();
  });

  it('throws on an unknown field', async () => {
    await expect(
      handler({ info: { fieldName: 'somethingElse' }, arguments: {} }),
    ).rejects.toThrow(/Unknown field/);
  });
});

// ── Property: idempotence under onConflict="link" ───────────────────────
describe('importAgent — idempotence property', () => {
  it('importing the same descriptor (same sourceArn) twice with link never creates twice', async () => {
    await fc.assert(
      fc.asyncProperty(
        fc.record({
          token: fc.string({ minLength: 4, maxLength: 10 }),
          name: fc.constantFrom('Alpha', 'Beta', 'Gamma'),
        }),
        async ({ token, name }) => {
          // Per-iteration isolation: reset only the call-sensitive mocks and
          // re-establish their implementations (impls survive between runs).
          mockCreateResource.mockReset();
          mockListResources.mockReset();
          mockExtractOrgFromEvent.mockResolvedValue(ORG);
          mockSerializeCustomMetadata.mockImplementation((m: unknown) => JSON.stringify(m));
          mockDeserializeCustomMetadata.mockImplementation(
            (j: string | null | undefined, d: Record<string, unknown>) =>
              j ? { ...d, ...JSON.parse(j) } : d,
          );
          mockMapToAgentConfig.mockImplementation((r: { recordId: string }) => ({
            agentId: r.recordId,
          }));

          const arn = `arn:aws:lambda:us-east-1:111122223333:function:${token}`;
          const created = existingRecord({ recordId: 'rec-x', name, sourceArn: arn });
          // 1st import: registry empty. 2nd import: the just-created record.
          mockListResources.mockResolvedValueOnce([]).mockResolvedValueOnce([created]);
          mockCreateResource.mockResolvedValue(created);

          const input = validInput({
            name,
            invocation: { protocol: 'LAMBDA_INVOKE', target: arn, auth: { mode: 'SIGV4' }, mode: 'sync' },
            origin: { sourceArn: arn, substrate: 'lambda', discoveredAt: 'd', ownership: 'external' },
            onConflict: 'link',
          });

          await importAgent(input, eventWithOrg);
          await importAgent(input, eventWithOrg);

          expect(mockCreateResource).toHaveBeenCalledTimes(1);
        },
      ),
      { numRuns: 25 },
    );
  });
});

// ── handler — discoverAgents query (SCAN / PASTE / MANIFEST) ─────────────
describe('handler — discoverAgents', () => {
  const authedEvent = (input: Record<string, unknown>) => ({
    info: { fieldName: 'discoverAgents' },
    arguments: { input },
    identity: eventWithOrg.identity,
  });

  beforeEach(() => {
    // File-level beforeEach only clears call data; reset impls so a fixture
    // from one discovery test cannot leak into the next.
    mockResolveSourceRef.mockReset();
    mockTagScanDiscover.mockReset();
    mockCandidateFromManifest.mockReset();
    mockResolveAdapter.mockReset();
    mockResolveAdapter.mockReturnValue({ describe: mockDescribe });
    mockDescribe.mockReset();
    // These tests exercise discovery LOGIC, so run as an authorized (admin)
    // caller. The role gate itself is covered in the authorization describe.
    mockIsAdminFromEvent.mockReturnValue(true);
  });

  it('SCAN maps internal (origin-nested) candidates to the flat GraphQL shape', async () => {
    const scannedArn = 'arn:aws:lambda:us-east-1:111122223333:function:scanned';
    mockTagScanDiscover.mockResolvedValue([
      {
        origin: {
          sourceArn: scannedArn,
          substrate: 'lambda',
          region: 'us-east-1',
          account: '111122223333',
          discoveredAt: '2026-06-26T00:00:00.000Z',
          ownership: 'external',
        },
        displayName: 'scanned',
        reference: scannedArn,
      },
    ]);

    const res = (await handler(
      authedEvent({ source: 'SCAN', tagKey: 'citadel:agent', tagValue: 'true' }),
    )) as FlatAgentCandidate[];

    expect(mockTagScanDiscover).toHaveBeenCalledWith({
      region: undefined,
      tagKey: 'citadel:agent',
      tagValue: 'true',
    });
    expect(res).toEqual([
      {
        displayName: 'scanned',
        reference: scannedArn,
        substrate: 'lambda',
        sourceArn: scannedArn,
        region: 'us-east-1',
        account: '111122223333',
        ownership: 'external',
        discoveredAt: '2026-06-26T00:00:00.000Z',
      },
    ]);
  });

  it('PASTE builds a single flat candidate from a resolved ARN ref', async () => {
    const arn = 'arn:aws:lambda:us-west-2:444455556666:function:pay';
    mockResolveSourceRef.mockReturnValue({
      protocol: 'LAMBDA_INVOKE',
      substrate: 'lambda',
      target: arn,
    });

    const res = (await handler(authedEvent({ source: 'PASTE', ref: arn }))) as FlatAgentCandidate[];

    expect(mockResolveSourceRef).toHaveBeenCalledWith(arn);
    expect(res).toHaveLength(1);
    expect(res[0]).toEqual(
      expect.objectContaining({
        displayName: 'pay',
        reference: arn,
        substrate: 'lambda',
        sourceArn: arn,
        region: 'us-west-2',
        account: '444455556666',
        ownership: 'external',
      }),
    );
    expect(typeof res[0].discoveredAt).toBe('string');
  });

  it('PASTE sets sourceArn/region/account to null for a non-ARN (URL) ref', async () => {
    const url = 'https://agent.example.com/svc';
    mockResolveSourceRef.mockReturnValue({
      protocol: 'HTTP_ENDPOINT',
      substrate: 'http',
      target: url,
    });

    const res = (await handler(authedEvent({ source: 'PASTE', ref: url }))) as FlatAgentCandidate[];

    expect(res[0]).toEqual(
      expect.objectContaining({
        reference: url,
        substrate: 'http',
        sourceArn: null,
        region: null,
        account: null,
        ownership: 'external',
      }),
    );
  });

  it('throws when PASTE is missing its ref', async () => {
    await expect(handler(authedEvent({ source: 'PASTE' }))).rejects.toThrow(/ref is required/i);
    expect(mockResolveSourceRef).not.toHaveBeenCalled();
  });

  it('MANIFEST maps the candidate from candidateFromManifest to the flat shape', async () => {
    mockCandidateFromManifest.mockReturnValue({
      candidate: {
        origin: {
          substrate: 'mcp',
          discoveredAt: '2026-06-26T00:00:00.000Z',
          ownership: 'external',
        },
        displayName: 'ManifestAgent',
        reference: 'https://m.example.com',
      },
      descriptor: { name: 'ManifestAgent' },
    });

    const res = (await handler(
      authedEvent({ source: 'MANIFEST', manifest: '{"name":"ManifestAgent"}' }),
    )) as FlatAgentCandidate[];

    expect(mockCandidateFromManifest).toHaveBeenCalledWith('{"name":"ManifestAgent"}');
    expect(res).toEqual([
      {
        displayName: 'ManifestAgent',
        reference: 'https://m.example.com',
        substrate: 'mcp',
        sourceArn: null,
        region: null,
        account: null,
        ownership: 'external',
        discoveredAt: '2026-06-26T00:00:00.000Z',
      },
    ]);
  });

  it('surfaces InvalidSourceRefError from a bad PASTE ref as a clean GraphQL error', async () => {
    mockResolveSourceRef.mockImplementation(() => {
      throw new InvalidSourceRefError('unrecognised source ref: nonsense');
    });

    await expect(handler(authedEvent({ source: 'PASTE', ref: 'nonsense' }))).rejects.toThrow(
      /unrecognised source ref/,
    );
  });

  it('surfaces UnsupportedSourceError (e.g. an unsupported substrate) as a clean GraphQL error', async () => {
    mockTagScanDiscover.mockRejectedValue(new UnsupportedSourceError('ecs'));

    await expect(handler(authedEvent({ source: 'SCAN' }))).rejects.toThrow(
      /ecs not supported in phase 1/,
    );
  });

  it('rejects an unrecognised discovery source', async () => {
    await expect(handler(authedEvent({ source: 'BOGUS' }))).rejects.toThrow(/unsupported source/i);
  });

  it('rejects an unauthenticated caller (no identity)', async () => {
    await expect(
      handler({ info: { fieldName: 'discoverAgents' }, arguments: { input: { source: 'SCAN' } } }),
    ).rejects.toThrow(/authenticated/i);
    expect(mockTagScanDiscover).not.toHaveBeenCalled();
  });
});

// ── handler — describeAgentCandidate query ──────────────────────────────
describe('handler — describeAgentCandidate', () => {
  const arn = 'arn:aws:lambda:us-east-1:111122223333:function:pay';

  beforeEach(() => {
    mockResolveSourceRef.mockReset();
    mockResolveAdapter.mockReset();
    mockResolveAdapter.mockReturnValue({ describe: mockDescribe });
    mockDescribe.mockReset();
    // Logic tests run as an authorized (admin) caller; the role gate is
    // covered in the dedicated authorization describe.
    mockIsAdminFromEvent.mockReturnValue(true);
  });

  it('resolves the ref, dispatches to the protocol adapter, and returns the descriptor as a JSON string', async () => {
    mockResolveSourceRef.mockReturnValue({
      protocol: 'LAMBDA_INVOKE',
      substrate: 'lambda',
      target: arn,
    });
    const descriptor = {
      name: 'pay',
      description: 'Handles payments',
      version: '1.0.0',
      skills: [],
    };
    mockDescribe.mockResolvedValue(descriptor);

    const res = (await handler({
      info: { fieldName: 'describeAgentCandidate' },
      arguments: { ref: arn },
      identity: eventWithOrg.identity,
    })) as string;

    expect(mockResolveSourceRef).toHaveBeenCalledWith(arn);
    expect(mockResolveAdapter).toHaveBeenCalledWith('LAMBDA_INVOKE');
    expect(typeof res).toBe('string');
    expect(JSON.parse(res)).toEqual(descriptor);
    // The constructed candidate carries the resolved target + external ownership.
    const passedCandidate = mockDescribe.mock.calls[0][0];
    expect(passedCandidate).toEqual(
      expect.objectContaining({
        reference: arn,
        displayName: 'pay',
        origin: expect.objectContaining({
          substrate: 'lambda',
          sourceArn: arn,
          ownership: 'external',
        }),
      }),
    );
  });

  it('surfaces InvalidSourceRefError for an unparseable ref as a clean GraphQL error', async () => {
    mockResolveSourceRef.mockImplementation(() => {
      throw new InvalidSourceRefError('malformed ARN: arn:bogus');
    });

    await expect(
      handler({
        info: { fieldName: 'describeAgentCandidate' },
        arguments: { ref: 'arn:bogus' },
        identity: eventWithOrg.identity,
      }),
    ).rejects.toThrow(/malformed ARN/);
    expect(mockDescribe).not.toHaveBeenCalled();
  });

  it('throws when ref is missing', async () => {
    await expect(
      handler({
        info: { fieldName: 'describeAgentCandidate' },
        arguments: {},
        identity: eventWithOrg.identity,
      }),
    ).rejects.toThrow(/ref is required/);
  });

  it('rejects an unauthenticated caller', async () => {
    await expect(
      handler({ info: { fieldName: 'describeAgentCandidate' }, arguments: { ref: arn } }),
    ).rejects.toThrow(/authenticated/i);
    expect(mockResolveSourceRef).not.toHaveBeenCalled();
  });
});

// ── handler — discovery authorization gate (admin | architect only) ──────
// discoverAgents/describeAgentCandidate enumerate/inspect the customer's AWS
// account, so authentication alone is insufficient: only admin or architect
// may run them. importAgent is intentionally NOT gated by this check.
describe('handler — discoverAgents authorization', () => {
  const scanEvent = () => ({
    info: { fieldName: 'discoverAgents' },
    arguments: { input: { source: 'SCAN' } },
    identity: eventWithOrg.identity,
  });

  beforeEach(() => {
    mockTagScanDiscover.mockReset();
    // Let an authorized caller fall through to (mocked) discovery logic.
    mockTagScanDiscover.mockResolvedValue([]);
  });

  it('allows a caller with role admin (reaches discovery logic)', async () => {
    mockIsAdminFromEvent.mockReturnValue(true);
    mockHasRoleFromEvent.mockReturnValue(false);

    await expect(handler(scanEvent())).resolves.toEqual([]);
    expect(mockTagScanDiscover).toHaveBeenCalledTimes(1);
  });

  it('allows a caller with role architect (reaches discovery logic)', async () => {
    mockIsAdminFromEvent.mockReturnValue(false);
    mockHasRoleFromEvent.mockReturnValue(true);

    await expect(handler(scanEvent())).resolves.toEqual([]);
    expect(mockTagScanDiscover).toHaveBeenCalledTimes(1);
    // The gate must check specifically for the architect role.
    expect(mockHasRoleFromEvent).toHaveBeenCalledWith(expect.anything(), 'architect');
  });

  it('denies a caller with role developer (authenticated but neither admin nor architect)', async () => {
    mockIsAdminFromEvent.mockReturnValue(false);
    mockHasRoleFromEvent.mockReturnValue(false);

    await expect(handler(scanEvent())).rejects.toThrow(/admin or architect/i);
    expect(mockTagScanDiscover).not.toHaveBeenCalled();
  });
});

describe('handler — describeAgentCandidate authorization', () => {
  const arn = 'arn:aws:lambda:us-east-1:111122223333:function:pay';
  const describeEvent = () => ({
    info: { fieldName: 'describeAgentCandidate' },
    arguments: { ref: arn },
    identity: eventWithOrg.identity,
  });

  beforeEach(() => {
    mockResolveSourceRef.mockReset();
    mockResolveSourceRef.mockReturnValue({
      protocol: 'LAMBDA_INVOKE',
      substrate: 'lambda',
      target: arn,
    });
    mockResolveAdapter.mockReset();
    mockResolveAdapter.mockReturnValue({ describe: mockDescribe });
    mockDescribe.mockReset();
    mockDescribe.mockResolvedValue({ name: 'pay' });
  });

  it('allows a caller with role admin (reaches the protocol adapter)', async () => {
    mockIsAdminFromEvent.mockReturnValue(true);
    mockHasRoleFromEvent.mockReturnValue(false);

    await expect(handler(describeEvent())).resolves.toBe(JSON.stringify({ name: 'pay' }));
    expect(mockDescribe).toHaveBeenCalledTimes(1);
  });

  it('allows a caller with role architect (reaches the protocol adapter)', async () => {
    mockIsAdminFromEvent.mockReturnValue(false);
    mockHasRoleFromEvent.mockReturnValue(true);

    await expect(handler(describeEvent())).resolves.toBe(JSON.stringify({ name: 'pay' }));
    expect(mockDescribe).toHaveBeenCalledTimes(1);
    expect(mockHasRoleFromEvent).toHaveBeenCalledWith(expect.anything(), 'architect');
  });

  it('denies a caller with role developer (authenticated but neither admin nor architect)', async () => {
    mockIsAdminFromEvent.mockReturnValue(false);
    mockHasRoleFromEvent.mockReturnValue(false);

    await expect(handler(describeEvent())).rejects.toThrow(/admin or architect/i);
    expect(mockResolveSourceRef).not.toHaveBeenCalled();
    expect(mockDescribe).not.toHaveBeenCalled();
  });
});

// ── Import lifecycle events (best-effort EventBridge emission) ───────────
// The resolver additively emits agent.import.{registered,discovered,failed}
// via the shared events.ts publishEvent helper. Emission is BEST-EFFORT: it
// is wrapped in try/catch, logged on failure, and must NEVER fail (or alter)
// the underlying mutation/query. Every event carries a correlationId and an
// ISO timestamp.
describe('import lifecycle events', () => {
  const ISO = /^\d{4}-\d{2}-\d{2}T\d{2}:\d{2}:\d{2}\.\d{3}Z$/;

  interface CapturedEvent {
    eventType: string;
    projectId: string;
    agentId?: string;
    payload: Record<string, unknown>;
    timestamp: string;
    correlationId?: string;
  }

  /** All events of a given detail-type passed to the (mocked) publishEvent. */
  const emitted = (type: string): CapturedEvent[] =>
    (mockPublishEvent.mock.calls as unknown[][])
      .map((c) => c[0] as CapturedEvent)
      .filter((e) => e.eventType === type);

  beforeEach(() => {
    // Isolate the publish mock from other describes (clearAllMocks only clears
    // call data, not queued implementations). Default to a successful publish.
    mockPublishEvent.mockReset();
    mockPublishEvent.mockResolvedValue(undefined);
    mockTagScanDiscover.mockReset();
    mockResolveSourceRef.mockReset();
    mockResolveAdapter.mockReset();
    mockResolveAdapter.mockReturnValue({ describe: mockDescribe });
    mockDescribe.mockReset();
  });

  describe('agent.import.registered', () => {
    it('emits exactly once on a create, with payload, correlationId, and ISO timestamp', async () => {
      mockCreateResource.mockResolvedValue(
        existingRecord({ recordId: 'rec-1', name: 'PaymentsAgent', sourceArn: SOURCE_ARN }),
      );

      await importAgent(validInput(), eventWithOrg);

      const regs = emitted(EventTypes.AGENT_IMPORT_REGISTERED);
      expect(regs).toHaveLength(1);
      expect(regs[0].correlationId).toEqual(expect.any(String));
      expect(regs[0].correlationId).toBeTruthy();
      expect(regs[0].timestamp).toMatch(ISO);
      expect(regs[0].payload).toEqual(
        expect.objectContaining({
          agentId: 'rec-1',
          sourceArn: SOURCE_ARN,
          substrate: 'agentcore_runtime',
          orgId: ORG,
        }),
      );
    });

    it('emits on a replace (onConflict="replace")', async () => {
      const existing = existingRecord({ recordId: 'rec-existing', name: 'OldPay', sourceArn: SOURCE_ARN });
      mockListResources.mockResolvedValue([existing]);
      mockUpdateResource.mockResolvedValue(existing);

      await importAgent(validInput({ onConflict: 'replace' }), eventWithOrg);

      expect(emitted(EventTypes.AGENT_IMPORT_REGISTERED)).toHaveLength(1);
    });

    it('emits on a copy (onConflict="copy")', async () => {
      const existing = existingRecord({ recordId: 'rec-existing', name: 'PaymentsAgent', sourceArn: SOURCE_ARN });
      mockListResources.mockResolvedValue([existing]);
      mockCreateResource.mockResolvedValue(
        existingRecord({ recordId: 'rec-copy', name: 'PaymentsAgent (imported copy)', sourceArn: SOURCE_ARN }),
      );

      await importAgent(validInput({ onConflict: 'copy' }), eventWithOrg);

      expect(emitted(EventTypes.AGENT_IMPORT_REGISTERED)).toHaveLength(1);
    });

    it('does NOT emit on a no-op link (onConflict="link")', async () => {
      const existing = existingRecord({ recordId: 'rec-existing', name: 'OldPay', sourceArn: SOURCE_ARN });
      mockListResources.mockResolvedValue([existing]);

      await importAgent(validInput({ onConflict: 'link' }), eventWithOrg);

      expect(emitted(EventTypes.AGENT_IMPORT_REGISTERED)).toHaveLength(0);
    });

    it('does NOT emit on an unresolved conflict (no onConflict supplied)', async () => {
      mockListResources.mockResolvedValue([
        existingRecord({ recordId: 'rec-existing', name: 'OldPay', sourceArn: SOURCE_ARN }),
      ]);

      const result = await importAgent(validInput(), eventWithOrg);

      expect(result).toEqual(expect.objectContaining({ conflict: true }));
      expect(emitted(EventTypes.AGENT_IMPORT_REGISTERED)).toHaveLength(0);
    });
  });

  describe('agent.import.discovered', () => {
    it('emits once per discovery call with source, candidateCount, substrates, correlationId, timestamp', async () => {
      mockIsAdminFromEvent.mockReturnValue(true);
      const scannedArn = 'arn:aws:lambda:us-east-1:111122223333:function:scanned';
      mockTagScanDiscover.mockResolvedValue([
        {
          origin: {
            sourceArn: scannedArn,
            substrate: 'lambda',
            region: 'us-east-1',
            account: '111122223333',
            discoveredAt: '2026-06-26T00:00:00.000Z',
            ownership: 'external',
          },
          displayName: 'scanned',
          reference: scannedArn,
        },
      ]);

      await handler({
        info: { fieldName: 'discoverAgents' },
        arguments: { input: { source: 'SCAN' } },
        identity: eventWithOrg.identity,
      });

      const discs = emitted(EventTypes.AGENT_IMPORT_DISCOVERED);
      expect(discs).toHaveLength(1);
      expect(discs[0].payload).toEqual(
        expect.objectContaining({ source: 'SCAN', candidateCount: 1, substrates: ['lambda'] }),
      );
      expect(discs[0].correlationId).toBeTruthy();
      expect(discs[0].timestamp).toMatch(ISO);
    });
  });

  describe('agent.import.failed', () => {
    it('emits operation="import" and still propagates the original error', async () => {
      // org cannot be resolved → importAgent throws before any create.
      mockExtractOrgFromEvent.mockResolvedValue(null);

      await expect(
        handler({
          info: { fieldName: 'importAgent' },
          arguments: { input: validFlatInput() },
          identity: eventWithOrg.identity,
        }),
      ).rejects.toThrow(/organization/i);

      const fails = emitted(EventTypes.AGENT_IMPORT_FAILED);
      expect(fails).toHaveLength(1);
      expect(fails[0].payload).toEqual(expect.objectContaining({ operation: 'import' }));
      expect(fails[0].payload.message).toEqual(expect.any(String));
      expect(fails[0].correlationId).toBeTruthy();
      expect(fails[0].timestamp).toMatch(ISO);
      // A failed import never also reports a registration.
      expect(emitted(EventTypes.AGENT_IMPORT_REGISTERED)).toHaveLength(0);
    });

    it('emits operation="discover" and still propagates the original error', async () => {
      mockIsAdminFromEvent.mockReturnValue(true);
      mockTagScanDiscover.mockRejectedValue(new Error('scan boom'));

      await expect(
        handler({
          info: { fieldName: 'discoverAgents' },
          arguments: { input: { source: 'SCAN' } },
          identity: eventWithOrg.identity,
        }),
      ).rejects.toThrow('scan boom');

      const fails = emitted(EventTypes.AGENT_IMPORT_FAILED);
      expect(fails).toHaveLength(1);
      expect(fails[0].payload).toEqual(expect.objectContaining({ operation: 'discover' }));
    });

    it('emits operation="describe" and still propagates the original error', async () => {
      mockIsAdminFromEvent.mockReturnValue(true);
      const arn = 'arn:aws:lambda:us-east-1:111122223333:function:pay';
      mockResolveSourceRef.mockReturnValue({ protocol: 'LAMBDA_INVOKE', substrate: 'lambda', target: arn });
      mockResolveAdapter.mockReturnValue({ describe: mockDescribe });
      mockDescribe.mockRejectedValue(new Error('describe boom'));

      await expect(
        handler({
          info: { fieldName: 'describeAgentCandidate' },
          arguments: { ref: arn },
          identity: eventWithOrg.identity,
        }),
      ).rejects.toThrow('describe boom');

      const fails = emitted(EventTypes.AGENT_IMPORT_FAILED);
      expect(fails).toHaveLength(1);
      expect(fails[0].payload).toEqual(expect.objectContaining({ operation: 'describe' }));
    });
  });

  describe('best-effort emission', () => {
    it('a publish failure does NOT fail importAgent — the created record is still returned', async () => {
      mockCreateResource.mockResolvedValue(
        existingRecord({ recordId: 'rec-1', name: 'PaymentsAgent', sourceArn: SOURCE_ARN }),
      );
      mockPublishEvent.mockRejectedValue(new Error('eventbridge down'));

      const result = await importAgent(validInput(), eventWithOrg);

      expect(result).toEqual(expect.objectContaining({ agentId: 'rec-1' }));
      expect(mockPublishEvent).toHaveBeenCalled(); // emission was attempted
    });

    it('a publish failure does NOT fail discoverAgents — candidates are still returned', async () => {
      mockIsAdminFromEvent.mockReturnValue(true);
      mockTagScanDiscover.mockResolvedValue([]);
      mockPublishEvent.mockRejectedValue(new Error('eventbridge down'));

      const res = await handler({
        info: { fieldName: 'discoverAgents' },
        arguments: { input: { source: 'SCAN' } },
        identity: eventWithOrg.identity,
      });

      expect(res).toEqual([]);
    });
  });
});
