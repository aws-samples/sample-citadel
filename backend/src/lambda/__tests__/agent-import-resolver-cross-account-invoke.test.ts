/**
 * Acceptance tests for CROSS-ACCOUNT invoke wiring in the agent-import-resolver
 * INVOKE paths (Phase 2, agent-import): testImportedAgent + probeAgentCandidate.
 *
 * These two paths actually invoke an operator-supplied import candidate through
 * the existing per-protocol agent-source adapters. When the candidate's
 * invocation `roleArn` is in a DIFFERENT account than ACCOUNT_ID, they assume
 * that operator-supplied invoke role (reusing vendImportCredentials), map it via
 * toInvokeCredentials, and build the adapter registry with that
 * `credentialProvider` so the AWS-native invoke runs under the assumed
 * credentials. The mechanism mirrors the message handler's resolveImportRegistry
 * (commit 345f157) — but because these resolver paths are RESULT-RETURNING, a
 * cross-account ASSUME FAILURE is a NORMAL result (testImportedAgent →
 * { ok:false, error }; probeAgentCandidate → describe-only + probeNote), NEVER a
 * thrown 500. The assumed credentials are NEVER logged. Same-account (or no
 * roleArn) is byte-identical to today: no vend, no credentialProvider.
 *
 * Mirrors agent-message-handler-cross-account-invoke.test.ts: vendImportCredentials
 * is stubbed via a PARTIAL mock of invoke-support so the REAL toInvokeCredentials
 * mapper keeps working; isCrossAccountRoleArn is the REAL pure helper driven by
 * process.env.ACCOUNT_ID. The adapter registry factory is mocked to capture the
 * { resolveSecret, credentialProvider } deps and the adapter describe/invoke.
 */

// ── Mock RegistryService (assert NOTHING is persisted by an invoke/probe) ──
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

// ── Mock the adapter registry factory: capture the { resolveSecret,
//    credentialProvider } deps and expose BOTH describe + invoke. ──────────
const mockDescribe = jest.fn();
const mockInvoke = jest.fn();
const mockResolve = jest.fn(() => ({ describe: mockDescribe, invoke: mockInvoke }));
const mockBuildRegistry = jest.fn(() => ({ resolve: mockResolve }));
jest.mock('../../adapters/agent-source/registry-factory', () => ({
  __esModule: true,
  buildDefaultAgentSourceRegistry: (...args: unknown[]) => mockBuildRegistry(...args),
}));

// ── Mock credential-manager: getAgentInvocationSecret + storeAgentInvocationSecret
const mockGetAgentInvocationSecret = jest.fn();
const mockStoreAgentInvocationSecret = jest.fn();
jest.mock('../../utils/credential-manager', () => ({
  __esModule: true,
  getAgentInvocationSecret: (...a: unknown[]) => mockGetAgentInvocationSecret(...a),
  storeAgentInvocationSecret: (...a: unknown[]) => mockStoreAgentInvocationSecret(...a),
}));

// ── Mock the untrusted-output sanitizer (passthrough) ───────────────────
const mockSanitize = jest.fn((text: string) => ({ sanitized: text, modified: false, matches: [] }));
jest.mock('../../utils/sanitize-agent-output', () => ({
  __esModule: true,
  sanitizeUntrustedAgentOutput: (...a: unknown[]) => mockSanitize(...a),
}));

// ── invoke-support: stub ONLY vendImportCredentials (keep real helpers,
//    including the real toInvokeCredentials mapper). ──────────────────────
const mockVend = jest.fn();
jest.mock('../../adapters/agent-source/invoke-support', () => {
  const actual = jest.requireActual('../../adapters/agent-source/invoke-support');
  return { __esModule: true, ...actual, vendImportCredentials: (...a: unknown[]) => mockVend(...a) };
});

import { testImportedAgent, probeAgentCandidate, _resetRegistryService } from '../agent-import-resolver';

// ── Fixtures ────────────────────────────────────────────────────────────
const ORG = 'test-org-a';
const DEPLOY_ACCOUNT = '111122223333';
const FOREIGN_ACCOUNT = '999988887777';
const CROSS_ROLE = `arn:aws:iam::${FOREIGN_ACCOUNT}:role/CitadelInvoke`;
const SAME_ROLE = `arn:aws:iam::${DEPLOY_ACCOUNT}:role/SameAccount`;
const CROSS_TARGET = `arn:aws:lambda:us-east-1:${FOREIGN_ACCOUNT}:function:imported`;
const SAME_TARGET = `arn:aws:lambda:us-east-1:${DEPLOY_ACCOUNT}:function:imported`;
const ASSUMED_KEY = 'ASIA-ASSUMED';
const ASSUMED_SECRET = 'assumed-secret-NEVER-LOG-0123456789';
const ASSUMED_TOKEN = 'assumed-token-NEVER-LOG';

const adminEvent = { identity: { claims: { 'custom:role': 'admin' }, sub: 'admin-1' } };
const developerEvent = { identity: { claims: { 'custom:organization': ORG }, sub: 'dev-1' } };

/** A CROSS-ACCOUNT invoke input (roleArn in FOREIGN_ACCOUNT). */
function crossInput(overrides: Record<string, unknown> = {}): Record<string, unknown> {
  return {
    invocationProtocol: 'LAMBDA_INVOKE',
    invocationTarget: CROSS_TARGET,
    invocationAuthMode: 'NONE',
    invocationMode: 'sync',
    region: 'us-east-1',
    account: FOREIGN_ACCOUNT,
    invocationRoleArn: CROSS_ROLE,
    invocationExternalId: 'ext-1',
    prompt: 'hello',
    ...overrides,
  };
}

/** A successfully-vended VendedCredentials shape. */
function vendedOk() {
  return {
    roleArn: CROSS_ROLE,
    accessKeyId: ASSUMED_KEY,
    secretAccessKey: ASSUMED_SECRET,
    sessionToken: ASSUMED_TOKEN,
    expiresAt: '2030-01-01T00:00:00.000Z',
  };
}

/** A STATIC describe() result with GAPS (forces a probe dry-run). */
function gappyDescriptor(overrides: Record<string, unknown> = {}): Record<string, unknown> {
  return {
    name: 'import-candidate',
    description: 'a discovered agent',
    version: '1.0.0',
    skills: [],
    categories: [],
    inputSchema: {},
    outputSchema: {},
    invocation: { protocol: 'LAMBDA_INVOKE', target: CROSS_TARGET, auth: { mode: 'NONE' }, mode: 'sync' },
    origin: { substrate: 'lambda', discoveredAt: '2026-06-28T00:00:00.000Z', ownership: 'external' },
    fieldConfidence: { name: 'high', outputSchema: 'low', skills: 'low' },
    ...overrides,
  };
}

type ParsedDescriptor = {
  outputSchema: Record<string, unknown>;
  fieldConfidence?: Record<string, string>;
  outputSample?: string;
  probeNote?: string;
};

/** The deps of the FIRST buildDefaultAgentSourceRegistry call carrying a credentialProvider. */
function crossAccountBuildDeps(): { credentialProvider?: Record<string, unknown> } | undefined {
  const call = mockBuildRegistry.mock.calls.find(
    (c) => (c[0] as { credentialProvider?: unknown } | undefined)?.credentialProvider,
  );
  return call?.[0] as { credentialProvider?: Record<string, unknown> } | undefined;
}

beforeEach(() => {
  process.env.REGISTRY_ENABLED = 'true';
  process.env.REGISTRY_ID = 'test-registry';
  process.env.AWS_REGION = 'us-east-1';
  process.env.ACCOUNT_ID = DEPLOY_ACCOUNT;
  _resetRegistryService();
  jest.clearAllMocks();
  mockIsAdminFromEvent.mockReturnValue(false);
  mockHasRoleFromEvent.mockReturnValue(false);
  mockExtractOrgFromEvent.mockResolvedValue(ORG);
  mockResolve.mockReturnValue({ describe: mockDescribe, invoke: mockInvoke });
  mockBuildRegistry.mockReturnValue({ resolve: mockResolve });
  mockDescribe.mockResolvedValue(gappyDescriptor());
  mockInvoke.mockResolvedValue({ output: 'agent says hello' });
  mockSanitize.mockImplementation((text: string) => ({ sanitized: text, modified: false, matches: [] }));
  mockGetAgentInvocationSecret.mockResolvedValue('resolved-secret-value');
  mockVend.mockReset();
});

afterAll(() => {
  delete process.env.ACCOUNT_ID;
});

// ===========================================================================
// testImportedAgent — cross-account invoke
// ===========================================================================
describe('testImportedAgent — cross-account invoke', () => {
  beforeEach(() => mockIsAdminFromEvent.mockReturnValue(true));

  it('assumes the invoke role, builds the registry with the assumed credentialProvider, invokes, and returns ok:true', async () => {
    mockVend.mockResolvedValue(vendedOk());
    mockInvoke.mockResolvedValue({ output: 'cross-account pong' });

    const res = await testImportedAgent(crossInput(), adminEvent);

    // vendImportCredentials assumed the cross-account invoke role.
    expect(mockVend).toHaveBeenCalledTimes(1);
    expect(mockVend.mock.calls[0][0]).toMatchObject({
      roleArn: CROSS_ROLE,
      externalId: 'ext-1',
      account: FOREIGN_ACCOUNT,
    });

    // The registry was built with the ASSUMED credentials (real toInvokeCredentials).
    const deps = crossAccountBuildDeps();
    expect(deps?.credentialProvider).toMatchObject({
      accessKeyId: ASSUMED_KEY,
      secretAccessKey: ASSUMED_SECRET,
      sessionToken: ASSUMED_TOKEN,
    });

    // The invoke happened on that registry's adapter and the result is ok.
    expect(mockInvoke).toHaveBeenCalledTimes(1);
    expect(res.ok).toBe(true);
    expect(res.output).toBe('cross-account pong');
    expect(res.error).toBeNull();
  });

  it('a cross-account ASSUME FAILURE is a NORMAL result { ok:false, error } (NOT thrown)', async () => {
    mockVend.mockRejectedValue(new Error('AccessDenied: not authorized to perform sts:AssumeRole'));

    const res = await testImportedAgent(crossInput(), adminEvent);

    expect(mockVend).toHaveBeenCalledTimes(1);
    expect(res.ok).toBe(false);
    expect(res.error).toMatch(/assume|accessdenied/i);
    expect(res.output).toBeNull();
    // We did NOT silently fall back to the handler identity and invoke anyway.
    expect(mockInvoke).not.toHaveBeenCalled();
    expect(typeof res.latencyMs).toBe('number');
  });

  it('NEVER logs the assumed credentials (success path)', async () => {
    const logSpy = jest.spyOn(console, 'log').mockImplementation(() => undefined);
    const warnSpy = jest.spyOn(console, 'warn').mockImplementation(() => undefined);
    const errorSpy = jest.spyOn(console, 'error').mockImplementation(() => undefined);
    mockVend.mockResolvedValue(vendedOk());

    await testImportedAgent(crossInput(), adminEvent);

    const all = [...logSpy.mock.calls, ...warnSpy.mock.calls, ...errorSpy.mock.calls]
      .flat()
      .map((a) => (typeof a === 'string' ? a : JSON.stringify(a)))
      .join('\n');
    expect(all).not.toContain(ASSUMED_SECRET);
    expect(all).not.toContain(ASSUMED_TOKEN);
    expect(all).not.toContain(ASSUMED_KEY);
    logSpy.mockRestore();
    warnSpy.mockRestore();
    errorSpy.mockRestore();
  });

  it('SAME-ACCOUNT roleArn: does NOT vend; registry built WITHOUT a credentialProvider (unchanged)', async () => {
    const res = await testImportedAgent(
      crossInput({ invocationRoleArn: SAME_ROLE, account: DEPLOY_ACCOUNT, invocationTarget: SAME_TARGET }),
      adminEvent,
    );

    expect(mockVend).not.toHaveBeenCalled();
    const deps = mockBuildRegistry.mock.calls[0][0] as { credentialProvider?: unknown };
    expect(deps.credentialProvider).toBeUndefined();
    expect(res.ok).toBe(true);
    expect(mockInvoke).toHaveBeenCalledTimes(1);
  });

  it('NO roleArn: does NOT vend; registry built WITHOUT a credentialProvider (back-compat)', async () => {
    const res = await testImportedAgent(
      crossInput({ invocationRoleArn: undefined, invocationExternalId: undefined, account: undefined, invocationTarget: SAME_TARGET }),
      adminEvent,
    );

    expect(mockVend).not.toHaveBeenCalled();
    const deps = mockBuildRegistry.mock.calls[0][0] as { credentialProvider?: unknown };
    expect(deps.credentialProvider).toBeUndefined();
    expect(res.ok).toBe(true);
  });

  it('developer/non-privileged caller is still rejected (gate unchanged) and never vends', async () => {
    mockIsAdminFromEvent.mockReturnValue(false);
    await expect(testImportedAgent(crossInput(), developerEvent)).rejects.toThrow(/unauthor/i);
    expect(mockVend).not.toHaveBeenCalled();
    expect(mockBuildRegistry).not.toHaveBeenCalled();
  });
});

// ===========================================================================
// probeAgentCandidate — cross-account dry-run
// ===========================================================================
describe('probeAgentCandidate — cross-account dry-run', () => {
  beforeEach(() => mockIsAdminFromEvent.mockReturnValue(true));

  it('assumes the invoke role and uses the assumed credentialProvider for the dry-run', async () => {
    mockVend.mockResolvedValue(vendedOk());
    mockInvoke.mockResolvedValue({ output: '{"answer":"42"}' });

    const raw = await probeAgentCandidate(crossInput(), adminEvent);
    const merged = JSON.parse(raw) as ParsedDescriptor;

    expect(mockVend).toHaveBeenCalledTimes(1);
    expect(mockVend.mock.calls[0][0]).toMatchObject({
      roleArn: CROSS_ROLE,
      externalId: 'ext-1',
      account: FOREIGN_ACCOUNT,
    });
    // The dry-run registry carried the assumed credentialProvider.
    const deps = crossAccountBuildDeps();
    expect(deps?.credentialProvider).toMatchObject({
      accessKeyId: ASSUMED_KEY,
      secretAccessKey: ASSUMED_SECRET,
      sessionToken: ASSUMED_TOKEN,
    });
    // describe ran + the dry-run invoke ran + the descriptor was enriched.
    expect(mockDescribe).toHaveBeenCalledTimes(1);
    expect(mockInvoke).toHaveBeenCalledTimes(1);
    expect(merged.fieldConfidence?.outputSchema).toBe('medium');
    expect(merged.outputSample).toBe('{"answer":"42"}');
  });

  it('a cross-account ASSUME FAILURE is best-effort: describe-only + probe note (NOT thrown)', async () => {
    mockVend.mockRejectedValue(new Error('AccessDenied: not authorized to perform sts:AssumeRole'));

    const raw = await probeAgentCandidate(crossInput(), adminEvent);
    const merged = JSON.parse(raw) as ParsedDescriptor;

    expect(mockVend).toHaveBeenCalledTimes(1);
    // describe still produced the static descriptor; the dry-run never invoked.
    expect(mockDescribe).toHaveBeenCalledTimes(1);
    expect(mockInvoke).not.toHaveBeenCalled();
    // No confidence bump, no fabricated sample — describe-only + a probe note.
    expect(merged.fieldConfidence?.outputSchema).toBe('low');
    expect(merged.outputSample).toBeUndefined();
    expect(typeof merged.probeNote).toBe('string');
    expect(merged.probeNote).toMatch(/probe/i);
  });

  it('NEVER logs the assumed credentials (success path)', async () => {
    const logSpy = jest.spyOn(console, 'log').mockImplementation(() => undefined);
    const warnSpy = jest.spyOn(console, 'warn').mockImplementation(() => undefined);
    const errorSpy = jest.spyOn(console, 'error').mockImplementation(() => undefined);
    mockVend.mockResolvedValue(vendedOk());
    mockInvoke.mockResolvedValue({ output: '{"answer":"42"}' });

    await probeAgentCandidate(crossInput(), adminEvent);

    const all = [...logSpy.mock.calls, ...warnSpy.mock.calls, ...errorSpy.mock.calls]
      .flat()
      .map((a) => (typeof a === 'string' ? a : JSON.stringify(a)))
      .join('\n');
    expect(all).not.toContain(ASSUMED_SECRET);
    expect(all).not.toContain(ASSUMED_TOKEN);
    expect(all).not.toContain(ASSUMED_KEY);
    logSpy.mockRestore();
    warnSpy.mockRestore();
    errorSpy.mockRestore();
  });

  it('SAME-ACCOUNT roleArn: does NOT vend; the dry-run registry has no credentialProvider', async () => {
    mockInvoke.mockResolvedValue({ output: '{"answer":"42"}' });

    await probeAgentCandidate(
      crossInput({ invocationRoleArn: SAME_ROLE, account: DEPLOY_ACCOUNT }),
      adminEvent,
    );

    expect(mockVend).not.toHaveBeenCalled();
    expect(crossAccountBuildDeps()).toBeUndefined();
    expect(mockInvoke).toHaveBeenCalledTimes(1);
  });

  it('developer/non-privileged caller is still rejected (gate unchanged) and never vends', async () => {
    mockIsAdminFromEvent.mockReturnValue(false);
    await expect(probeAgentCandidate(crossInput(), developerEvent)).rejects.toThrow(/unauthor/i);
    expect(mockVend).not.toHaveBeenCalled();
    expect(mockDescribe).not.toHaveBeenCalled();
  });
});
