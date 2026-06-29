/**
 * Tests for Tier-3 agent-import increment B2 (backend REQUEST + ACCEPT side):
 *   - `proposeAgentManifestTier3` — admin/architect-gated; gathers SECRET-FREE
 *     signals by reusing the describe path and enqueues a `manifest-proposal`
 *     job to the Fabricator queue. NEVER mutates the record; NEVER enqueues or
 *     logs a secret VALUE.
 *   - `acceptProposedManifestTier3` — the ONLY (human-gated) promotion path. It
 *     promotes the already-sanitized `proposedManifest.manifest` into the
 *     record's trusted manifest but NEVER changes status/state or
 *     governanceAttestation (the record STAYS DRAFT). Idempotent.
 *
 * Mocking mirrors agent-import-resolver-cross-account-describe.test.ts (the
 * proven describe-path mock set) plus an `@aws-sdk/client-sqs` mock so the
 * enqueue is asserted without contacting AWS.
 */

// ── Mock RegistryService ─────────────────────────────────────────────────
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
const mockMapToAgentConfig = jest.fn((record: { recordId: string; name?: string }) => ({
  agentId: record.recordId,
  name: record.name ?? '',
  orgId: 'test-org-a',
  config: '',
  state: 'inactive',
  categories: [],
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

// ── Mock auth-event (gate is mocked; defaults DENY) ──────────────────────
const mockExtractOrgFromEvent = jest.fn();
const mockIsAdminFromEvent = jest.fn(() => false);
const mockHasRoleFromEvent = jest.fn(() => false);
jest.mock('../../utils/auth-event', () => ({
  extractOrgFromEvent: (...args: unknown[]) => mockExtractOrgFromEvent(...args),
  isAdminFromEvent: (...args: unknown[]) => mockIsAdminFromEvent(...args),
  hasRoleFromEvent: (...args: unknown[]) => mockHasRoleFromEvent(...args),
}));

// ── Mock agent-discovery: stub resolveSourceRef, KEEP the real typed errors. ─
const mockResolveSourceRef = jest.fn();
jest.mock('../../services/agent-discovery', () => {
  const actual = jest.requireActual('../../services/agent-discovery');
  return {
    __esModule: true,
    ...actual,
    resolveSourceRef: (...args: unknown[]) => mockResolveSourceRef(...args),
  };
});

// ── Mock events publish helper (keep real EventTypes; never hit EventBridge) ─
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

// ── Mock credential-manager (no AWS at load) ─────────────────────────────
jest.mock('../../utils/credential-manager', () => ({
  __esModule: true,
  getAgentInvocationSecret: jest.fn(),
  storeAgentInvocationSecret: jest.fn(),
}));

// ── Mock untrusted-output sanitizer (passthrough) ────────────────────────
jest.mock('../../utils/sanitize-agent-output', () => ({
  __esModule: true,
  sanitizeUntrustedAgentOutput: (text: string) => ({ sanitized: text, modified: false, matches: [] }),
}));

// ── Mock adapter registry factory: expose adapter.describe() ─────────────
const mockDescribe = jest.fn();
const mockResolve = jest.fn(() => ({ describe: mockDescribe }));
const mockBuildRegistry = jest.fn(() => ({ resolve: mockResolve }));
jest.mock('../../adapters/agent-source/registry-factory', () => ({
  __esModule: true,
  buildDefaultAgentSourceRegistry: (...args: unknown[]) => mockBuildRegistry(...args),
}));

// ── trust-path: stub ONLY assumeRoleCredentials (keep the real pure helpers) ─
const mockAssumeRoleCredentials = jest.fn();
jest.mock('../../utils/trust-path', () => {
  const actual = jest.requireActual('../../utils/trust-path');
  return {
    __esModule: true,
    ...actual,
    assumeRoleCredentials: (...a: unknown[]) => mockAssumeRoleCredentials(...a),
  };
});

// ── Mock @aws-sdk/client-sqs: capture the SendMessageCommand input. ───────
const mockSqsSend = jest.fn().mockResolvedValue({ MessageId: 'm-1' });
jest.mock('@aws-sdk/client-sqs', () => ({
  __esModule: true,
  SQSClient: jest.fn().mockImplementation(() => ({ send: mockSqsSend })),
  SendMessageCommand: jest.fn().mockImplementation((input: unknown) => ({ input })),
}));

import {
  proposeAgentManifestTier3,
  acceptProposedManifestTier3,
  handler,
  _resetRegistryService,
} from '../agent-import-resolver';

// ── Fixtures ──────────────────────────────────────────────────────────────
const ORG = 'test-org-a';
const ARN = 'arn:aws:bedrock-agentcore:us-east-1:111122223333:runtime/pay';
const QUEUE_URL =
  'https://sqs.us-east-1.amazonaws.com/111122223333/citadel-fabricator-queue-dev';

/** A distinctive secret VALUE that must NEVER cross to the Fabricator or logs. */
const SECRET_VALUE = 'sk-live-DO-NOT-LEAK-9999-abcdef';

const adminEvent = { identity: { sub: 'admin-1' } };
const architectEvent = { identity: { sub: 'arch-1', username: 'arch' } };
const developerEvent = { identity: { sub: 'dev-1' } };

interface SqsSendInput {
  QueueUrl: string;
  MessageBody: string;
  MessageAttributes: Record<string, { DataType: string; StringValue: string }>;
}
function lastSqsInput(): SqsSendInput {
  const calls = mockSqsSend.mock.calls;
  return (calls[calls.length - 1][0] as { input: SqsSendInput }).input;
}

interface ProposalBody {
  requestId: string;
  correlationId: string;
  importId: string;
  signals: {
    substrate: string;
    arn: string | null;
    displayName: string;
    tier1Hints: Record<string, unknown>;
    tier2Probe?: string;
    openApiFragment?: unknown;
  };
}
function lastProposalBody(): ProposalBody {
  return JSON.parse(lastSqsInput().MessageBody) as ProposalBody;
}

/** Describe descriptor that embeds a secret in invocation.auth (must be dropped). */
function describedWithSecret(): Record<string, unknown> {
  return {
    name: 'PaymentsAgent',
    description: 'Handles payments',
    version: '1.0.0',
    skills: [{ name: 'charge' }, { name: 'refund' }],
    categories: ['payments'],
    inputSchema: { type: 'object', properties: { amount: { type: 'number' } } },
    outputSchema: {},
    fieldConfidence: { outputSchema: 'low' },
    invocation: {
      protocol: 'HTTP_ENDPOINT',
      target: 'https://api.example.com/agent',
      auth: { mode: 'API_KEY', header: 'x-api-key', secretRef: SECRET_VALUE, token: SECRET_VALUE },
    },
    origin: { substrate: 'http-endpoint', sourceArn: ARN, ownership: 'external', discoveredAt: 'x' },
  };
}

function draftRecordWithProposal(
  proposalOverrides: Record<string, unknown> = {},
  metaOverrides: Record<string, unknown> = {},
): { recordId: string; name: string; status: string; customDescriptorContent: string } {
  const meta = {
    categories: ['payments'],
    icon: '',
    state: 'inactive',
    orgId: ORG,
    manifest: { name: 'OldName', version: '0.0.1' },
    invocation: { protocol: 'HTTP_ENDPOINT', target: 'https://x', auth: { mode: 'NONE' } },
    origin: { substrate: 'http-endpoint', discoveredAt: 'x', ownership: 'external' },
    governanceAttestation: {
      status: 'pending',
      enforcementMode: 'permissive',
      authorityRequested: true,
      requestedAt: '2026-06-01T00:00:00.000Z',
    },
    proposedManifest: {
      manifest: { name: 'ProposedPayments', version: '2.0.0', skills: ['charge'] },
      confidence: 'low',
      reviewState: 'pending_review',
      source: 'llm_tier3',
      fieldConfidence: { name: 'low' },
      proposedAt: '2026-06-02T00:00:00.000Z',
      correlationId: 'corr-prior',
      sanitized: true,
      ...proposalOverrides,
    },
    ...metaOverrides,
  };
  return {
    recordId: 'rec-1',
    name: 'PaymentsAgent',
    status: 'DRAFT',
    customDescriptorContent: JSON.stringify(meta),
  };
}

beforeEach(() => {
  jest.clearAllMocks();
  _resetRegistryService();
  process.env.FABRICATOR_QUEUE_URL = QUEUE_URL;
  process.env.REGISTRY_ID = 'test-registry';
  mockResolveSourceRef.mockReturnValue({
    protocol: 'HTTP_ENDPOINT',
    substrate: 'http-endpoint',
    target: ARN,
  });
  mockDescribe.mockResolvedValue(describedWithSecret());
});

// ===========================================================================
// proposeAgentManifestTier3
// ===========================================================================
describe('proposeAgentManifestTier3', () => {
  it('rejects a developer (non admin/architect) caller and enqueues nothing', async () => {
    mockIsAdminFromEvent.mockReturnValue(false);
    mockHasRoleFromEvent.mockReturnValue(false);

    await expect(proposeAgentManifestTier3(ARN, developerEvent)).rejects.toThrow(
      /Unauthorized/i,
    );
    expect(mockSqsSend).not.toHaveBeenCalled();
    expect(mockDescribe).not.toHaveBeenCalled();
  });

  it('allows an architect and enqueues a manifest-proposal with the B1 contract body + PENDING', async () => {
    mockIsAdminFromEvent.mockReturnValue(false);
    mockHasRoleFromEvent.mockReturnValue(true); // architect

    const result = await proposeAgentManifestTier3(ARN, architectEvent);

    expect(result.status).toBe('PENDING');
    expect(typeof result.requestId).toBe('string');
    expect(result.requestId.length).toBeGreaterThan(0);

    expect(mockSqsSend).toHaveBeenCalledTimes(1);
    const input = lastSqsInput();
    expect(input.QueueUrl).toBe(QUEUE_URL);
    expect(input.MessageAttributes.requestType.StringValue).toBe('manifest-proposal');
    expect(input.MessageAttributes.requestId.StringValue).toBe(result.requestId);

    const body = lastProposalBody();
    expect(body.requestId).toBe(result.requestId);
    expect(typeof body.correlationId).toBe('string');
    expect(body.importId).toBe(ARN); // importId := ref
    expect(body.signals.substrate).toBe('http-endpoint');
    expect(body.signals.arn).toBe(ARN);
    expect(body.signals.displayName).toBe('PaymentsAgent');
    expect(body.signals.tier1Hints.name).toBe('PaymentsAgent');
    expect(body.signals.tier1Hints.protocol).toBe('HTTP_ENDPOINT');
  });

  it('NEVER enqueues a secret VALUE even when the candidate carries a secretRef/token', async () => {
    mockIsAdminFromEvent.mockReturnValue(true);

    await proposeAgentManifestTier3(ARN, adminEvent);

    const raw = lastSqsInput().MessageBody;
    expect(raw).not.toContain(SECRET_VALUE);

    const body = lastProposalBody();
    // The whole invocation.auth block (where secrets live) must be absent.
    expect(JSON.stringify(body.signals)).not.toContain(SECRET_VALUE);
    expect(body.signals.tier1Hints).not.toHaveProperty('auth');
    expect(body.signals.tier1Hints).not.toHaveProperty('secretRef');
    expect(body.signals.tier1Hints).not.toHaveProperty('target');
  });

  it('NEVER logs credentials/secrets', async () => {
    mockIsAdminFromEvent.mockReturnValue(true);
    const logSpy = jest.spyOn(console, 'log').mockImplementation(() => {});
    const errSpy = jest.spyOn(console, 'error').mockImplementation(() => {});

    await proposeAgentManifestTier3(ARN, adminEvent);

    const logged = [...logSpy.mock.calls, ...errSpy.mock.calls]
      .map((args) => args.map((a) => (typeof a === 'string' ? a : JSON.stringify(a))).join(' '))
      .join('\n');
    expect(logged).not.toContain(SECRET_VALUE);

    logSpy.mockRestore();
    errSpy.mockRestore();
  });

  it('gathers cross-account signals via the assume-creds path when discoveryRoleArn is given', async () => {
    mockIsAdminFromEvent.mockReturnValue(true);
    mockAssumeRoleCredentials.mockResolvedValue({
      accessKeyId: 'AKIA',
      secretAccessKey: 'shh',
      sessionToken: 'tok',
      expiration: new Date('2026-06-30T00:00:00.000Z'),
    });

    const result = await proposeAgentManifestTier3(
      ARN,
      adminEvent,
      'arn:aws:iam::999988887777:role/citadel-discovery',
      'ext-1',
    );

    expect(result.status).toBe('PENDING');
    expect(mockAssumeRoleCredentials).toHaveBeenCalledTimes(1);
    expect(mockSqsSend).toHaveBeenCalledTimes(1);
  });

  it('dispatches via the handler on fieldName and requires authentication', async () => {
    mockIsAdminFromEvent.mockReturnValue(true);

    const res = (await handler({
      info: { fieldName: 'proposeAgentManifestTier3' },
      arguments: { ref: ARN },
      identity: { sub: 'admin-1' },
    })) as { requestId: string; status: string };

    expect(res.status).toBe('PENDING');
    expect(mockSqsSend).toHaveBeenCalledTimes(1);

    await expect(
      handler({ info: { fieldName: 'proposeAgentManifestTier3' }, arguments: { ref: ARN } }),
    ).rejects.toThrow(/Unauthenticated/i);
  });
});

// ===========================================================================
// acceptProposedManifestTier3
// ===========================================================================
describe('acceptProposedManifestTier3', () => {
  it('rejects a developer (non admin/architect) caller and writes nothing', async () => {
    mockIsAdminFromEvent.mockReturnValue(false);
    mockHasRoleFromEvent.mockReturnValue(false);
    mockGetResource.mockResolvedValue(draftRecordWithProposal());

    await expect(acceptProposedManifestTier3('rec-1', developerEvent)).rejects.toThrow(
      /Unauthorized/i,
    );
    expect(mockUpdateResource).not.toHaveBeenCalled();
  });

  it('promotes proposedManifest.manifest into manifest, marks accepted, and leaves status/state/governanceAttestation UNCHANGED (stays DRAFT)', async () => {
    mockIsAdminFromEvent.mockReturnValue(true);
    const record = draftRecordWithProposal();
    mockGetResource.mockResolvedValue(record);
    mockUpdateResource.mockResolvedValue({ recordId: 'rec-1', name: 'PaymentsAgent', status: 'DRAFT' });

    const result = await acceptProposedManifestTier3('rec-1', adminEvent);
    expect(result.agentId).toBe('rec-1');

    // updateResource called with ONLY customMetadata — no name/status/description.
    expect(mockUpdateResource).toHaveBeenCalledTimes(1);
    const [type, id, update] = mockUpdateResource.mock.calls[0] as [
      string,
      string,
      Record<string, unknown>,
    ];
    expect(type).toBe('agent');
    expect(id).toBe('rec-1');
    expect(Object.keys(update)).toEqual(['customMetadata']);

    const meta = JSON.parse(update.customMetadata as string);
    // Promotion: manifest := the proposed (already-sanitized) manifest body.
    expect(meta.manifest).toEqual({ name: 'ProposedPayments', version: '2.0.0', skills: ['charge'] });
    // Review audit stamped.
    expect(meta.proposedManifest.reviewState).toBe('accepted');
    expect(meta.proposedManifest.reviewedBy).toBe('admin-1');
    expect(typeof meta.proposedManifest.reviewedAt).toBe('string');
    // Provenance preserved.
    expect(meta.proposedManifest.source).toBe('llm_tier3');
    expect(meta.proposedManifest.confidence).toBe('low');
    // INVARIANT 2: governanceAttestation + state UNCHANGED; record stays DRAFT.
    expect(meta.governanceAttestation).toEqual({
      status: 'pending',
      enforcementMode: 'permissive',
      authorityRequested: true,
      requestedAt: '2026-06-01T00:00:00.000Z',
    });
    expect(meta.state).toBe('inactive');
    expect(mockUpdateResourceStatus).not.toHaveBeenCalled();
  });

  it('is idempotent: accepting an already-accepted proposal is a no-op returning the record', async () => {
    mockIsAdminFromEvent.mockReturnValue(true);
    mockGetResource.mockResolvedValue(
      draftRecordWithProposal({ reviewState: 'accepted', reviewedBy: 'admin-1', reviewedAt: 'x' }),
    );

    const result = await acceptProposedManifestTier3('rec-1', adminEvent);
    expect(result.agentId).toBe('rec-1');
    expect(mockUpdateResource).not.toHaveBeenCalled();
  });

  it('throws a clear error when there is no pending proposal', async () => {
    mockIsAdminFromEvent.mockReturnValue(true);
    mockGetResource.mockResolvedValue({
      recordId: 'rec-1',
      name: 'PaymentsAgent',
      status: 'DRAFT',
      customDescriptorContent: JSON.stringify({
        categories: [],
        icon: '',
        state: 'inactive',
        orgId: ORG,
      }),
    });

    await expect(acceptProposedManifestTier3('rec-1', adminEvent)).rejects.toThrow(
      /no proposed manifest/i,
    );
    expect(mockUpdateResource).not.toHaveBeenCalled();
  });

  it('throws a clear error when the proposal is a failed marker (nothing to promote)', async () => {
    mockIsAdminFromEvent.mockReturnValue(true);
    mockGetResource.mockResolvedValue(
      draftRecordWithProposal({ reviewState: 'failed', manifest: undefined, error: 'boom' }),
    );

    await expect(acceptProposedManifestTier3('rec-1', adminEvent)).rejects.toThrow(
      /pending review|failed/i,
    );
    expect(mockUpdateResource).not.toHaveBeenCalled();
  });

  it('masks cross-tenant records as not-found for a non-admin architect', async () => {
    mockIsAdminFromEvent.mockReturnValue(false);
    mockHasRoleFromEvent.mockReturnValue(true); // architect
    mockExtractOrgFromEvent.mockResolvedValue('my-org');
    mockGetResource.mockResolvedValue(draftRecordWithProposal({}, { orgId: 'other-org' }));

    await expect(acceptProposedManifestTier3('rec-1', architectEvent)).rejects.toThrow(
      /Agent not found/i,
    );
    expect(mockUpdateResource).not.toHaveBeenCalled();
  });

  it('dispatches via the handler on fieldName', async () => {
    mockIsAdminFromEvent.mockReturnValue(true);
    mockGetResource.mockResolvedValue(draftRecordWithProposal());
    mockUpdateResource.mockResolvedValue({ recordId: 'rec-1', name: 'PaymentsAgent', status: 'DRAFT' });

    const res = (await handler({
      info: { fieldName: 'acceptProposedManifestTier3' },
      arguments: { importId: 'rec-1' },
      identity: { sub: 'admin-1' },
    })) as { agentId: string };

    expect(res.agentId).toBe('rec-1');
    expect(mockUpdateResource).toHaveBeenCalledTimes(1);
  });
});
