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
jest.mock('../../utils/auth-event', () => ({
  extractOrgFromEvent: (...args: unknown[]) => mockExtractOrgFromEvent(...args),
  isAdminFromEvent: (...args: unknown[]) => mockIsAdminFromEvent(...args),
}));

import {
  importAgent,
  handler,
  buildImportCopyName,
  buildImportDescriptor,
  toImportAgentResult,
  _resetRegistryService,
} from '../agent-import-resolver';
import type { ImportConflictResult, ImportAgentResult } from '../agent-import-resolver';

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
  mockListResources.mockResolvedValue([]);
  mockCreateResource.mockImplementation(async (_type: string, id: string) =>
    existingRecord({ recordId: 'rec-new', name: id, sourceArn: SOURCE_ARN }),
  );
  mockUpdateResource.mockImplementation(async (_type: string, id: string) =>
    existingRecord({ recordId: id, name: 'PaymentsAgent', sourceArn: SOURCE_ARN }),
  );
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
    const res: ImportAgentResult = await handler({
      info: { fieldName: 'importAgent' },
      arguments: { input: validFlatInput() },
      identity: eventWithOrg.identity,
    });
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
    const res: ImportAgentResult = await handler({
      info: { fieldName: 'importAgent' },
      arguments: { input: validFlatInput() },
      identity: eventWithOrg.identity,
    });
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
