/**
 * Tests for agent-import-resolver — MCP Gateway publish/unpublish (US-IMP-031).
 *
 * `publishImportToGateway` publishes a PUBLICLY-REACHABLE, governance-ATTESTED,
 * MCP-substrate imported agent as an `mcpServer` target on Citadel's shared
 * AgentCore Gateway (auth offload + tool exposure). `unpublishImportFromGateway`
 * removes the target (+ credential provider). Direct invoke stays the default;
 * publishing NEVER changes the import's DRAFT/activation state.
 *
 * Security invariants asserted here:
 *   (1) admin/architect-gated — a developer is rejected and never loads the record.
 *   (2) eligibility — ONLY invocation.protocol==='MCP' publishes; HTTP_ENDPOINT
 *       returns the deferred REST/OpenAPI message; every AWS-native protocol is
 *       rejected with no target created.
 *   (3) require governanceAttestation ATTESTED and reachability==='reachable';
 *       'pending' / non-'reachable' / absent are rejected.
 *   (4) auth offload supports NONE/API_KEY/BEARER only; OAUTH2/SIGV4/COGNITO
 *       rejected (no target).
 *   (5) publish writes ONLY customMetadata.gatewayPublication — never
 *       manifest/invocation/state/governanceAttestation (Object.keys==['customMetadata']);
 *       idempotent (second publish makes no duplicate target).
 *   (6) the fetched secret value is NEVER logged.
 *   - unpublish deletes target+provider and clears status; idempotent when
 *     nothing is published; never changes state/governanceAttestation.
 *
 * Mocking mirrors agent-import-resolver-reachability.test.ts (RegistryService,
 * auth-event, agent-discovery, events, authority-lifecycle, governance-flag, ADR
 * resolver) plus the gateway-publish dependencies: gateway-target-manager,
 * credential-provider-manager, credential-manager.getAgentInvocationSecret, and
 * the BedrockAgentCoreControlClient (via aws-sdk-client-mock).
 */

// ── Mock RegistryService ────────────────────────────────────────────────
const mockCreateResource = jest.fn();
const mockUpdateResource = jest.fn();
const mockListResources = jest.fn();
const mockGetResource = jest.fn();
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

// ── Mock gateway-target-manager (REUSED: build payload + delete) ────────
const mockBuildMCPServerTargetPayload = jest.fn(
  (input: { config?: { serverUrl?: string } }) => ({
    gatewayIdentifier: 'gw-from-builder',
    name: 'integration-from-builder',
    targetConfiguration: { mcp: { mcpServer: { serverUrl: input.config?.serverUrl } } },
    credentialProviderConfigurations: [],
  }),
);
const mockDeleteTargetAndProvider = jest.fn(async () => undefined);
jest.mock('../../utils/gateway-target-manager', () => ({
  __esModule: true,
  buildMCPServerTargetPayload: (...a: unknown[]) =>
    mockBuildMCPServerTargetPayload(...(a as [{ config?: { serverUrl?: string } }])),
  deleteTargetAndProvider: (...a: unknown[]) => mockDeleteTargetAndProvider(...a),
}));

// ── Mock credential-provider-manager (REUSED: createOrUpsertApiKeyProvider)
const mockCreateOrUpsertApiKeyProvider = jest.fn(async () => ({
  credentialProviderArn:
    'arn:aws:bedrock-agentcore:us-east-1:123456789012:credential-provider/integration-imp-1-api-key',
}));
jest.mock('../../utils/credential-provider-manager', () => ({
  __esModule: true,
  createOrUpsertApiKeyProvider: (...a: unknown[]) => mockCreateOrUpsertApiKeyProvider(...a),
}));

// ── Mock credential-manager.getAgentInvocationSecret (secret fetch) ─────
const SECRET_VALUE = 'sk-live-PUBLISH-super-secret-do-not-log-0123456789';
const mockGetAgentInvocationSecret = jest.fn(async () => SECRET_VALUE);
const mockStoreAgentInvocationSecret = jest.fn();
jest.mock('../../utils/credential-manager', () => ({
  __esModule: true,
  getAgentInvocationSecret: (...a: unknown[]) => mockGetAgentInvocationSecret(...a),
  storeAgentInvocationSecret: (...a: unknown[]) => mockStoreAgentInvocationSecret(...a),
}));

import { mockClient } from 'aws-sdk-client-mock';
import {
  BedrockAgentCoreControlClient,
  CreateGatewayTargetCommand,
  DeleteGatewayTargetCommand,
} from '@aws-sdk/client-bedrock-agentcore-control';

import {
  publishImportToGateway,
  unpublishImportFromGateway,
  handler,
  _resetRegistryService,
} from '../agent-import-resolver';

const bedrockMock = mockClient(BedrockAgentCoreControlClient);

// ── Fixtures ────────────────────────────────────────────────────────────
const ORG = 'test-org-a';
const MCP_TARGET = 'https://mcp.example.com/mcp';

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
      protocol: 'MCP',
      target: MCP_TARGET,
      auth: { mode: 'NONE' },
      mode: 'sync',
    },
    origin: { substrate: 'mcp', discoveredAt: '2026-06-30T00:00:00.000Z', ownership: 'external' },
    orgId: ORG,
    governanceAttestation: {
      status: 'attested',
      enforcementMode: 'permissive',
      authorityRequested: true,
      requestedAt: '2026-06-30T00:00:00.000Z',
      attestedBy: 'arch-1',
      attestedAt: '2026-06-30T01:00:00.000Z',
    },
    reachability: {
      reachable: true,
      classification: 'reachable',
      detail: 'HTTP 200',
      checkedAt: '2026-06-30T02:00:00.000Z',
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

beforeEach(() => {
  process.env.REGISTRY_ENABLED = 'true';
  process.env.REGISTRY_ID = 'test-registry';
  process.env.AWS_REGION = 'us-east-1';
  // Gateway id fast-path so the resolver never needs SSM in tests.
  process.env.AGENTCORE_GATEWAY_ID = 'gw-test-1';
  delete process.env.GATEWAY_ID_PARAM;
  _resetRegistryService();
  jest.clearAllMocks();
  bedrockMock.reset();
  bedrockMock.on(CreateGatewayTargetCommand).resolves({ targetId: 'tgt-123' });
  bedrockMock.on(DeleteGatewayTargetCommand).resolves({});
  mockIsAdminFromEvent.mockReturnValue(false);
  mockHasRoleFromEvent.mockReturnValue(false);
  mockExtractOrgFromEvent.mockResolvedValue(ORG);
  mockGetResource.mockResolvedValue(importRecord());
  mockUpdateResource.mockResolvedValue(importRecord());
});

// ── (1) authorization gate ───────────────────────────────────────────────
describe('publishImportToGateway — authorization gate', () => {
  it('rejects a developer and never loads the record', async () => {
    await expect(publishImportToGateway('imp-1', developerEvent)).rejects.toThrow(/unauthor/i);
    expect(mockGetResource).not.toHaveBeenCalled();
    expect(mockBuildMCPServerTargetPayload).not.toHaveBeenCalled();
    expect(bedrockMock.commandCalls(CreateGatewayTargetCommand)).toHaveLength(0);
  });

  it('allows an admin', async () => {
    mockIsAdminFromEvent.mockReturnValue(true);
    const res = await publishImportToGateway('imp-1', adminEvent);
    expect(res.status).toBe('published');
  });

  it('allows an architect', async () => {
    mockHasRoleFromEvent.mockImplementation((_e: unknown, role: string) => role === 'architect');
    const res = await publishImportToGateway('imp-1', architectEvent);
    expect(res.status).toBe('published');
  });

  it('throws a clean not-found for a missing record', async () => {
    mockIsAdminFromEvent.mockReturnValue(true);
    mockGetResource.mockResolvedValue(null);
    await expect(publishImportToGateway('missing', adminEvent)).rejects.toThrow(/not found/i);
    expect(bedrockMock.commandCalls(CreateGatewayTargetCommand)).toHaveLength(0);
  });
});

// ── (2) eligibility ───────────────────────────────────────────────────────
describe('publishImportToGateway — eligibility', () => {
  beforeEach(() => mockIsAdminFromEvent.mockReturnValue(true));

  it('MCP creates an mcpServer target named import-<importId> with serverUrl=invocation.target', async () => {
    const res = await publishImportToGateway('imp-1', adminEvent);

    expect(mockBuildMCPServerTargetPayload).toHaveBeenCalledWith(
      expect.objectContaining({ config: { serverUrl: MCP_TARGET } }),
    );
    const calls = bedrockMock.commandCalls(CreateGatewayTargetCommand);
    expect(calls).toHaveLength(1);
    expect(calls[0].args[0].input.name).toBe('import-imp-1');
    expect(res.status).toBe('published');
    expect(res.gatewayTargetId).toBe('tgt-123');
  });

  it('HTTP_ENDPOINT returns the deferred REST/OpenAPI message and creates no target', async () => {
    mockGetResource.mockResolvedValue(
      importRecord(
        baseMeta({
          invocation: {
            protocol: 'HTTP_ENDPOINT',
            target: 'https://api.example.com',
            auth: { mode: 'NONE' },
            mode: 'sync',
          },
        }),
      ),
    );
    await expect(publishImportToGateway('imp-1', adminEvent)).rejects.toThrow(
      /REST\/OpenAPI gateway publish not yet supported/i,
    );
    expect(bedrockMock.commandCalls(CreateGatewayTargetCommand)).toHaveLength(0);
    expect(mockUpdateResource).not.toHaveBeenCalled();
  });

  it.each([
    'AGENTCORE_RUNTIME',
    'LAMBDA_INVOKE',
    'BEDROCK_AGENT',
    'A2A',
    'STEP_FUNCTIONS',
    'SAGEMAKER_ENDPOINT',
    'SQS_ASYNC',
  ])('rejects AWS-native/other protocol %s with no target created', async (protocol) => {
    mockGetResource.mockResolvedValue(
      importRecord(
        baseMeta({
          invocation: { protocol, target: 'arn:aws:thing', auth: { mode: 'NONE' }, mode: 'sync' },
        }),
      ),
    );
    await expect(publishImportToGateway('imp-1', adminEvent)).rejects.toThrow();
    expect(bedrockMock.commandCalls(CreateGatewayTargetCommand)).toHaveLength(0);
    expect(mockUpdateResource).not.toHaveBeenCalled();
  });
});

// ── (3) attested + reachable gates ────────────────────────────────────────
describe('publishImportToGateway — governance + reachability gates', () => {
  beforeEach(() => mockIsAdminFromEvent.mockReturnValue(true));

  it('rejects when governanceAttestation is not attested (pending)', async () => {
    mockGetResource.mockResolvedValue(
      importRecord(
        baseMeta({
          governanceAttestation: {
            status: 'pending',
            enforcementMode: 'permissive',
            authorityRequested: true,
            requestedAt: '2026-06-30T00:00:00.000Z',
          },
        }),
      ),
    );
    await expect(publishImportToGateway('imp-1', adminEvent)).rejects.toThrow(/attest/i);
    expect(bedrockMock.commandCalls(CreateGatewayTargetCommand)).toHaveLength(0);
  });

  it('rejects when governanceAttestation is absent', async () => {
    mockGetResource.mockResolvedValue(
      importRecord(baseMeta({ governanceAttestation: undefined })),
    );
    await expect(publishImportToGateway('imp-1', adminEvent)).rejects.toThrow(/attest/i);
    expect(bedrockMock.commandCalls(CreateGatewayTargetCommand)).toHaveLength(0);
  });

  it.each(['unverifiable_private', 'no_endpoint', 'unreachable'])(
    'rejects when reachability classification is %s',
    async (classification) => {
      mockGetResource.mockResolvedValue(
        importRecord(
          baseMeta({ reachability: { reachable: false, classification, checkedAt: 'x' } }),
        ),
      );
      await expect(publishImportToGateway('imp-1', adminEvent)).rejects.toThrow(/reachab/i);
      expect(bedrockMock.commandCalls(CreateGatewayTargetCommand)).toHaveLength(0);
    },
  );

  it('rejects when reachability is absent (never probed)', async () => {
    mockGetResource.mockResolvedValue(importRecord(baseMeta({ reachability: undefined })));
    await expect(publishImportToGateway('imp-1', adminEvent)).rejects.toThrow(/reachab/i);
    expect(bedrockMock.commandCalls(CreateGatewayTargetCommand)).toHaveLength(0);
  });

  it('proceeds when both attested and reachable', async () => {
    const res = await publishImportToGateway('imp-1', adminEvent);
    expect(res.status).toBe('published');
    expect(bedrockMock.commandCalls(CreateGatewayTargetCommand)).toHaveLength(1);
  });
});

// ── gateway-id configuration gate ─────────────────────────────────────────
describe('publishImportToGateway — gateway not configured', () => {
  beforeEach(() => mockIsAdminFromEvent.mockReturnValue(true));

  it('throws when neither AGENTCORE_GATEWAY_ID nor GATEWAY_ID_PARAM is set', async () => {
    delete process.env.AGENTCORE_GATEWAY_ID;
    delete process.env.GATEWAY_ID_PARAM;
    await expect(publishImportToGateway('imp-1', adminEvent)).rejects.toThrow(
      /gateway not configured/i,
    );
    expect(bedrockMock.commandCalls(CreateGatewayTargetCommand)).toHaveLength(0);
  });
});

// ── (4) auth offload ──────────────────────────────────────────────────────
describe('publishImportToGateway — auth offload', () => {
  beforeEach(() => mockIsAdminFromEvent.mockReturnValue(true));

  it('NONE creates a target with no credential provider', async () => {
    await publishImportToGateway('imp-1', adminEvent);
    expect(mockGetAgentInvocationSecret).not.toHaveBeenCalled();
    expect(mockCreateOrUpsertApiKeyProvider).not.toHaveBeenCalled();
    expect(mockBuildMCPServerTargetPayload).toHaveBeenCalledWith(
      expect.not.objectContaining({ credentialProviderArn: expect.anything() }),
    );
    expect(bedrockMock.commandCalls(CreateGatewayTargetCommand)).toHaveLength(1);
  });

  it.each(['API_KEY', 'BEARER'])(
    '%s fetches the secret and provisions an api-key credential provider',
    async (mode) => {
      mockGetResource.mockResolvedValue(
        importRecord(
          baseMeta({
            invocation: {
              protocol: 'MCP',
              target: MCP_TARGET,
              auth: { mode, secretRef: 'arn:aws:secretsmanager:us-east-1:1:secret:/citadel/agents/x' },
              mode: 'sync',
            },
          }),
        ),
      );
      const res = await publishImportToGateway('imp-1', adminEvent);

      expect(mockGetAgentInvocationSecret).toHaveBeenCalledWith(
        'arn:aws:secretsmanager:us-east-1:1:secret:/citadel/agents/x',
      );
      expect(mockCreateOrUpsertApiKeyProvider).toHaveBeenCalledWith(
        expect.objectContaining({ integrationId: 'imp-1', apiKey: SECRET_VALUE }),
      );
      expect(mockBuildMCPServerTargetPayload).toHaveBeenCalledWith(
        expect.objectContaining({
          credentialProviderArn: expect.stringContaining('credential-provider/'),
        }),
      );
      expect(res.status).toBe('published');
      expect(bedrockMock.commandCalls(CreateGatewayTargetCommand)).toHaveLength(1);
    },
  );

  it.each(['OAUTH2', 'SIGV4', 'COGNITO'])(
    'rejects unsupported auth mode %s and creates no target',
    async (mode) => {
      mockGetResource.mockResolvedValue(
        importRecord(
          baseMeta({
            invocation: { protocol: 'MCP', target: MCP_TARGET, auth: { mode }, mode: 'sync' },
          }),
        ),
      );
      await expect(publishImportToGateway('imp-1', adminEvent)).rejects.toThrow();
      expect(mockCreateOrUpsertApiKeyProvider).not.toHaveBeenCalled();
      expect(bedrockMock.commandCalls(CreateGatewayTargetCommand)).toHaveLength(0);
    },
  );
});

// ── (5) persistence: customMetadata ONLY + idempotent + no half-write ─────
describe('publishImportToGateway — persistence', () => {
  beforeEach(() => mockIsAdminFromEvent.mockReturnValue(true));

  it('persists gatewayPublication to customMetadata ONLY, leaving everything else intact', async () => {
    await publishImportToGateway('imp-1', adminEvent);

    expect(mockUpdateResource).toHaveBeenCalledTimes(1);
    const [type, id, update] = mockUpdateResource.mock.calls[0] as [
      string,
      string,
      Record<string, unknown>,
    ];
    expect(type).toBe('agent');
    expect(id).toBe('imp-1');
    expect(Object.keys(update)).toEqual(['customMetadata']);

    const persisted = JSON.parse(update.customMetadata as string);
    expect(persisted.gatewayPublication.status).toBe('published');
    expect(persisted.gatewayPublication.targetType).toBe('mcpServer');
    expect(persisted.gatewayPublication.gatewayTargetId).toBe('tgt-123');
    expect(persisted.gatewayPublication.publishedBy).toBe('admin-1');
    expect(typeof persisted.gatewayPublication.publishedAt).toBe('string');
    // INVARIANT 5: nothing else is touched — record STAYS DRAFT.
    expect(persisted.manifest).toEqual({ name: 'imported' });
    expect(persisted.invocation.target).toBe(MCP_TARGET);
    expect(persisted.state).toBe('inactive');
    expect(persisted.governanceAttestation.status).toBe('attested');
  });

  it('is idempotent — a second publish makes no duplicate target and no second write', async () => {
    mockGetResource.mockResolvedValue(
      importRecord(
        baseMeta({
          gatewayPublication: {
            status: 'published',
            targetType: 'mcpServer',
            gatewayId: 'gw-test-1',
            gatewayTargetId: 'tgt-existing',
            publishedAt: '2026-06-30T03:00:00.000Z',
            publishedBy: 'arch-1',
          },
        }),
      ),
    );
    const res = await publishImportToGateway('imp-1', adminEvent);
    expect(res.status).toBe('published');
    expect(res.gatewayTargetId).toBe('tgt-existing');
    expect(mockBuildMCPServerTargetPayload).not.toHaveBeenCalled();
    expect(bedrockMock.commandCalls(CreateGatewayTargetCommand)).toHaveLength(0);
    expect(mockUpdateResource).not.toHaveBeenCalled();
  });

  it('does NOT write a half publication when target creation fails', async () => {
    bedrockMock.on(CreateGatewayTargetCommand).rejects(new Error('AgentCore boom'));
    await expect(publishImportToGateway('imp-1', adminEvent)).rejects.toThrow();
    expect(mockUpdateResource).not.toHaveBeenCalled();
  });
});

// ── (6) secret hygiene ────────────────────────────────────────────────────
describe('publishImportToGateway — secret hygiene', () => {
  it('never logs the fetched secret value', async () => {
    mockIsAdminFromEvent.mockReturnValue(true);
    mockGetResource.mockResolvedValue(
      importRecord(
        baseMeta({
          invocation: {
            protocol: 'MCP',
            target: MCP_TARGET,
            auth: { mode: 'API_KEY', secretRef: 'arn:aws:secretsmanager:us-east-1:1:secret:/citadel/agents/x' },
            mode: 'sync',
          },
        }),
      ),
    );
    const logSpy = jest.spyOn(console, 'log').mockImplementation(() => {});
    const errSpy = jest.spyOn(console, 'error').mockImplementation(() => {});
    const warnSpy = jest.spyOn(console, 'warn').mockImplementation(() => {});

    const res = await publishImportToGateway('imp-1', adminEvent);

    const logged = [...logSpy.mock.calls, ...errSpy.mock.calls, ...warnSpy.mock.calls]
      .flat()
      .map((a) => (typeof a === 'string' ? a : JSON.stringify(a)))
      .join(' ');
    expect(logged).not.toContain(SECRET_VALUE);
    expect(JSON.stringify(res)).not.toContain(SECRET_VALUE);
    // The serialized customMetadata must never carry the raw secret either.
    const update = mockUpdateResource.mock.calls[0]?.[2] as Record<string, unknown> | undefined;
    expect(JSON.stringify(update ?? {})).not.toContain(SECRET_VALUE);

    logSpy.mockRestore();
    errSpy.mockRestore();
    warnSpy.mockRestore();
  });
});

// ── unpublish ─────────────────────────────────────────────────────────────
describe('unpublishImportFromGateway', () => {
  beforeEach(() => mockIsAdminFromEvent.mockReturnValue(true));

  it('rejects a developer and never loads the record', async () => {
    mockIsAdminFromEvent.mockReturnValue(false);
    await expect(unpublishImportFromGateway('imp-1', developerEvent)).rejects.toThrow(/unauthor/i);
    expect(mockGetResource).not.toHaveBeenCalled();
  });

  it('deletes target + provider (API_KEY publication) and clears status to unpublished', async () => {
    mockGetResource.mockResolvedValue(
      importRecord(
        baseMeta({
          gatewayPublication: {
            status: 'published',
            targetType: 'mcpServer',
            gatewayId: 'gw-test-1',
            gatewayTargetId: 'tgt-123',
            credentialProviderArn:
              'arn:aws:bedrock-agentcore:us-east-1:1:credential-provider/integration-imp-1-api-key',
            publishedAt: '2026-06-30T03:00:00.000Z',
            publishedBy: 'admin-1',
          },
        }),
      ),
    );

    const res = await unpublishImportFromGateway('imp-1', adminEvent);

    expect(mockDeleteTargetAndProvider).toHaveBeenCalledWith(
      expect.objectContaining({
        targetId: 'tgt-123',
        integrationId: 'imp-1',
        credentialProviderType: 'API_KEY',
      }),
    );
    expect(res.status).toBe('unpublished');

    const [, , update] = mockUpdateResource.mock.calls[0] as [
      string,
      string,
      Record<string, unknown>,
    ];
    expect(Object.keys(update)).toEqual(['customMetadata']);
    const persisted = JSON.parse(update.customMetadata as string);
    expect(persisted.gatewayPublication.status).toBe('unpublished');
    // state / governanceAttestation untouched.
    expect(persisted.state).toBe('inactive');
    expect(persisted.governanceAttestation.status).toBe('attested');
  });

  it('deletes only the target (no provider) for a NONE publication', async () => {
    mockGetResource.mockResolvedValue(
      importRecord(
        baseMeta({
          gatewayPublication: {
            status: 'published',
            targetType: 'mcpServer',
            gatewayId: 'gw-test-1',
            gatewayTargetId: 'tgt-none',
            publishedAt: '2026-06-30T03:00:00.000Z',
            publishedBy: 'admin-1',
          },
        }),
      ),
    );

    const res = await unpublishImportFromGateway('imp-1', adminEvent);
    expect(mockDeleteTargetAndProvider).not.toHaveBeenCalled();
    const calls = bedrockMock.commandCalls(DeleteGatewayTargetCommand);
    expect(calls).toHaveLength(1);
    expect(calls[0].args[0].input.targetId).toBe('tgt-none');
    expect(res.status).toBe('unpublished');
  });

  it('is a no-op when nothing is published (idempotent)', async () => {
    // baseMeta has no gatewayPublication.
    const res = await unpublishImportFromGateway('imp-1', adminEvent);
    expect(res.status).toBe('unpublished');
    expect(mockDeleteTargetAndProvider).not.toHaveBeenCalled();
    expect(bedrockMock.commandCalls(DeleteGatewayTargetCommand)).toHaveLength(0);
    expect(mockUpdateResource).not.toHaveBeenCalled();
  });

  it('is a no-op when the publication was already unpublished', async () => {
    mockGetResource.mockResolvedValue(
      importRecord(
        baseMeta({
          gatewayPublication: {
            status: 'unpublished',
            targetType: 'mcpServer',
            gatewayId: 'gw-test-1',
            gatewayTargetId: 'tgt-123',
            publishedAt: '2026-06-30T03:00:00.000Z',
            publishedBy: 'admin-1',
          },
        }),
      ),
    );
    const res = await unpublishImportFromGateway('imp-1', adminEvent);
    expect(res.status).toBe('unpublished');
    expect(mockDeleteTargetAndProvider).not.toHaveBeenCalled();
    expect(bedrockMock.commandCalls(DeleteGatewayTargetCommand)).toHaveLength(0);
    expect(mockUpdateResource).not.toHaveBeenCalled();
  });
});

// ── handler routing ────────────────────────────────────────────────────────
describe('handler — gateway publish/unpublish routing', () => {
  it('routes publishImportToGateway and returns the result', async () => {
    mockIsAdminFromEvent.mockReturnValue(true);
    const res = (await handler({
      info: { fieldName: 'publishImportToGateway' },
      arguments: { importId: 'imp-1' },
      identity: adminEvent.identity,
    })) as { status: string };
    expect(res.status).toBe('published');
  });

  it('routes unpublishImportFromGateway and returns the result', async () => {
    mockIsAdminFromEvent.mockReturnValue(true);
    const res = (await handler({
      info: { fieldName: 'unpublishImportFromGateway' },
      arguments: { importId: 'imp-1' },
      identity: adminEvent.identity,
    })) as { status: string };
    expect(res.status).toBe('unpublished');
  });

  it('rejects an unauthenticated caller (no identity)', async () => {
    await expect(
      handler({ info: { fieldName: 'publishImportToGateway' }, arguments: { importId: 'imp-1' } }),
    ).rejects.toThrow(/unauthenticated/i);
    expect(mockGetResource).not.toHaveBeenCalled();
  });

  it('throws when importId is missing', async () => {
    await expect(
      handler({
        info: { fieldName: 'publishImportToGateway' },
        arguments: {},
        identity: adminEvent.identity,
      }),
    ).rejects.toThrow(/importId/i);
  });
});
