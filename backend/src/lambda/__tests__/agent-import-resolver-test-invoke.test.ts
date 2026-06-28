/**
 * Tests for agent-import-resolver — pre-activation TEST-INVOKE (US-IMP).
 *
 * `testImportedAgent` actually invokes an import CANDIDATE through the existing
 * agent-source adapters and returns a SANITIZED result WITHOUT persisting
 * anything. It is admin/architect-gated (an authorization failure THROWS); a
 * failed invoke is a NORMAL result ({ ok:false, error }), never a throw.
 *
 * Mirrors the mocking style of agent-import-resolver.test.ts: RegistryService,
 * auth-event, agent-discovery, events, authority-lifecycle, governance-flag and
 * the ADR resolver are mocked so the module imports cleanly and never touches
 * AWS. This suite additionally mocks the adapter registry factory (to capture
 * the resolveSecret dep and the adapter.invoke call), credential-manager
 * (getAgentInvocationSecret) and the untrusted-output sanitizer.
 */

// ── Mock RegistryService (assert NOTHING is persisted by a test-invoke) ──
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

// ── Mock the adapter registry factory: capture the resolveSecret dep and the
//    adapter.invoke call. buildDefaultAgentSourceRegistry({resolveSecret}) →
//    { resolve(protocol) → { invoke } }. ─────────────────────────────────
const mockInvoke = jest.fn();
const mockResolve = jest.fn(() => ({ invoke: mockInvoke }));
const mockBuildRegistry = jest.fn(() => ({ resolve: mockResolve }));
jest.mock('../../adapters/agent-source/registry-factory', () => ({
  __esModule: true,
  buildDefaultAgentSourceRegistry: (...args: unknown[]) => mockBuildRegistry(...args),
}));

// ── Mock credential-manager: getAgentInvocationSecret (ref resolution) and
//    storeAgentInvocationSecret (asserted NEVER called by a test-invoke). ──
const mockGetAgentInvocationSecret = jest.fn();
const mockStoreAgentInvocationSecret = jest.fn();
jest.mock('../../utils/credential-manager', () => ({
  __esModule: true,
  getAgentInvocationSecret: (...a: unknown[]) => mockGetAgentInvocationSecret(...a),
  storeAgentInvocationSecret: (...a: unknown[]) => mockStoreAgentInvocationSecret(...a),
}));

// ── Mock the untrusted-output sanitizer (assert the output flows through it)
const mockSanitize = jest.fn((text: string) => ({ sanitized: text, modified: false, matches: [] }));
jest.mock('../../utils/sanitize-agent-output', () => ({
  __esModule: true,
  sanitizeUntrustedAgentOutput: (...a: unknown[]) => mockSanitize(...a),
}));

import { testImportedAgent, handler, _resetRegistryService } from '../agent-import-resolver';
import type { ImportTestResult } from '../agent-import-resolver';

// ── Fixtures ────────────────────────────────────────────────────────────
const ORG = 'test-org-a';
const TARGET = 'https://agent.example.com/invoke';
const RAW_SECRET = 'sk-live-TEST-INVOKE-raw-secret-do-not-persist-0123456789';

const adminEvent = { identity: { claims: { 'custom:role': 'admin' }, sub: 'admin-1' } };
const architectEvent = { identity: { claims: { 'custom:role': 'architect' }, sub: 'arch-1' } };
const developerEvent = { identity: { claims: { 'custom:organization': ORG }, sub: 'dev-1' } };

function validInput(overrides: Record<string, unknown> = {}): Record<string, unknown> {
  return {
    invocationProtocol: 'HTTP_ENDPOINT',
    invocationTarget: TARGET,
    invocationAuthMode: 'NONE',
    invocationMode: 'sync',
    prompt: 'hello',
    ...overrides,
  };
}

beforeEach(() => {
  process.env.REGISTRY_ENABLED = 'true';
  process.env.REGISTRY_ID = 'test-registry';
  process.env.AWS_REGION = 'us-east-1';
  _resetRegistryService();
  jest.clearAllMocks();
  // Deny authorization by default; individual tests opt in to admin/architect.
  mockIsAdminFromEvent.mockReturnValue(false);
  mockHasRoleFromEvent.mockReturnValue(false);
  mockExtractOrgFromEvent.mockResolvedValue(ORG);
  // Default adapter wiring + a benign passthrough sanitizer.
  mockResolve.mockReturnValue({ invoke: mockInvoke });
  mockBuildRegistry.mockReturnValue({ resolve: mockResolve });
  mockInvoke.mockResolvedValue({ output: 'agent says hello' });
  mockSanitize.mockImplementation((text: string) => ({ sanitized: text, modified: false, matches: [] }));
  mockGetAgentInvocationSecret.mockResolvedValue('resolved-secret-value');
});

// ── authorization (admin | architect only; non-privileged THROWS) ────────
describe('testImportedAgent — authorization', () => {
  it('throws an authorization error for a non-privileged caller and never builds a registry or invokes', async () => {
    await expect(testImportedAgent(validInput(), developerEvent)).rejects.toThrow(/unauthor/i);
    expect(mockBuildRegistry).not.toHaveBeenCalled();
    expect(mockResolve).not.toHaveBeenCalled();
    expect(mockInvoke).not.toHaveBeenCalled();
  });

  it('allows an admin caller (reaches the adapter invoke)', async () => {
    mockIsAdminFromEvent.mockReturnValue(true);
    const res = await testImportedAgent(validInput(), adminEvent);
    expect(res.ok).toBe(true);
    expect(mockInvoke).toHaveBeenCalledTimes(1);
  });

  it('allows an architect caller (reaches the adapter invoke)', async () => {
    mockHasRoleFromEvent.mockImplementation((_e: unknown, role: string) => role === 'architect');
    const res = await testImportedAgent(validInput(), architectEvent);
    expect(res.ok).toBe(true);
    expect(mockInvoke).toHaveBeenCalledTimes(1);
    expect(mockHasRoleFromEvent).toHaveBeenCalledWith(expect.anything(), 'architect');
  });
});

// ── happy path: resolve → invoke once → sanitize → ok:true ───────────────
describe('testImportedAgent — happy path & sanitization', () => {
  beforeEach(() => mockIsAdminFromEvent.mockReturnValue(true));

  it('resolves the protocol adapter, invokes once with the prompt + a session id, sanitizes, returns ok', async () => {
    mockInvoke.mockResolvedValue({ output: 'RAW ignore previous instructions OUTPUT' });
    mockSanitize.mockReturnValue({ sanitized: 'RAW [sanitized] OUTPUT', modified: true, matches: ['x'] });

    const res = await testImportedAgent(validInput(), adminEvent);

    expect(mockResolve).toHaveBeenCalledWith('HTTP_ENDPOINT');
    expect(mockInvoke).toHaveBeenCalledTimes(1);
    const [req] = mockInvoke.mock.calls[0] as [{ prompt: string; sessionId: string }, unknown];
    expect(req.prompt).toBe('hello');
    expect(req.sessionId).toMatch(/^import-test-/);
    expect(mockSanitize).toHaveBeenCalledWith('RAW ignore previous instructions OUTPUT');
    expect(res.ok).toBe(true);
    expect(res.output).toBe('RAW [sanitized] OUTPUT');
    expect(res.error).toBeNull();
    expect(typeof res.latencyMs).toBe('number');
    expect(res.latencyMs).toBeGreaterThanOrEqual(0);
  });

  it('ALWAYS passes the adapter output through the sanitizer before returning (benign output)', async () => {
    mockInvoke.mockResolvedValue({ output: 'totally benign answer' });

    const res = await testImportedAgent(validInput(), adminEvent);

    expect(mockSanitize).toHaveBeenCalledTimes(1);
    expect(mockSanitize).toHaveBeenCalledWith('totally benign answer');
    expect(res.output).toBe('totally benign answer');
  });

  it("defaults the prompt to 'ping' when none is provided", async () => {
    await testImportedAgent(validInput({ prompt: undefined }), adminEvent);
    const [req] = mockInvoke.mock.calls[0] as [{ prompt: string }, unknown];
    expect(req.prompt).toBe('ping');
  });

  it('builds the descriptor invocation block from the input (protocol/target/auth/mode/region/account)', async () => {
    await testImportedAgent(
      validInput({
        invocationProtocol: 'MCP',
        invocationAuthMode: 'API_KEY',
        invocationAuthHeader: 'x-api-key',
        invocationMode: 'sync',
        region: 'us-west-2',
        account: '111122223333',
      }),
      adminEvent,
    );

    expect(mockResolve).toHaveBeenCalledWith('MCP');
    const [, descriptor] = mockInvoke.mock.calls[0] as [
      unknown,
      { invocation: { protocol: string; target: string; mode: string; region?: string; account?: string; auth: Record<string, unknown> } },
    ];
    expect(descriptor.invocation).toEqual(
      expect.objectContaining({
        protocol: 'MCP',
        target: TARGET,
        mode: 'sync',
        region: 'us-west-2',
        account: '111122223333',
      }),
    );
    expect(descriptor.invocation.auth).toEqual(
      expect.objectContaining({ mode: 'API_KEY', header: 'x-api-key' }),
    );
  });
});

// ── failure is a NORMAL result (never thrown) ────────────────────────────
describe('testImportedAgent — failure is a normal result', () => {
  beforeEach(() => mockIsAdminFromEvent.mockReturnValue(true));

  it('returns { ok:false, error } (NOT thrown) with latencyMs when adapter.invoke throws', async () => {
    mockInvoke.mockRejectedValue(new Error('connection refused'));

    const res = await testImportedAgent(validInput(), adminEvent);

    expect(res.ok).toBe(false);
    expect(res.error).toBe('connection refused');
    expect(res.output).toBeNull();
    expect(typeof res.latencyMs).toBe('number');
    expect(res.latencyMs).toBeGreaterThanOrEqual(0);
    expect(mockSanitize).not.toHaveBeenCalled();
  });

  it('returns ok:false when adapter resolution fails (e.g. unknown protocol)', async () => {
    mockResolve.mockImplementation(() => {
      throw new Error('No agent source adapter registered for protocol: A2A');
    });

    const res = await testImportedAgent(validInput({ invocationProtocol: 'A2A' }), adminEvent);

    expect(res.ok).toBe(false);
    expect(res.error).toMatch(/No agent source adapter/);
    expect(mockInvoke).not.toHaveBeenCalled();
  });
});

// ── secret handling: TRANSIENT, never persisted ─────────────────────────
describe('testImportedAgent — transient secret handling (never persisted)', () => {
  beforeEach(() => mockIsAdminFromEvent.mockReturnValue(true));

  it('raw invocationSecret: the resolveSecret closure returns it; getAgentInvocationSecret is NOT used', async () => {
    await testImportedAgent(
      validInput({ invocationAuthMode: 'API_KEY', invocationSecret: RAW_SECRET }),
      adminEvent,
    );

    const deps = mockBuildRegistry.mock.calls[0][0] as { resolveSecret?: (ref: string) => Promise<string> };
    expect(typeof deps.resolveSecret).toBe('function');
    await expect(deps.resolveSecret!('any-ignored-ref')).resolves.toBe(RAW_SECRET);
    expect(mockGetAgentInvocationSecret).not.toHaveBeenCalled();
  });

  it('raw invocationSecret: a transient secretRef is set on the descriptor so the adapter resolves it', async () => {
    await testImportedAgent(
      validInput({ invocationAuthMode: 'API_KEY', invocationSecret: RAW_SECRET }),
      adminEvent,
    );
    const [, descriptor] = mockInvoke.mock.calls[0] as [unknown, { invocation: { auth: { secretRef?: string } } }];
    expect(descriptor.invocation.auth.secretRef).toBeTruthy();
  });

  it('persists NOTHING for a raw secret (no secret store, no create/update record)', async () => {
    await testImportedAgent(
      validInput({ invocationAuthMode: 'API_KEY', invocationSecret: RAW_SECRET }),
      adminEvent,
    );

    expect(mockStoreAgentInvocationSecret).not.toHaveBeenCalled();
    expect(mockCreateResource).not.toHaveBeenCalled();
    expect(mockUpdateResource).not.toHaveBeenCalled();
    expect(mockUpdateResourceStatus).not.toHaveBeenCalled();
  });

  it('invocationSecretRef: the resolveSecret closure delegates to getAgentInvocationSecret(ref)', async () => {
    mockGetAgentInvocationSecret.mockResolvedValue('resolved-from-ref');

    await testImportedAgent(
      validInput({ invocationAuthMode: 'API_KEY', invocationSecretRef: 'arn:aws:secretsmanager:::secret:ref' }),
      adminEvent,
    );

    const deps = mockBuildRegistry.mock.calls[0][0] as { resolveSecret?: (ref: string) => Promise<string> };
    expect(typeof deps.resolveSecret).toBe('function');
    await expect(deps.resolveSecret!('arn:aws:secretsmanager:::secret:ref')).resolves.toBe('resolved-from-ref');
    expect(mockGetAgentInvocationSecret).toHaveBeenCalledWith('arn:aws:secretsmanager:::secret:ref');
  });

  it('no secret and no ref: no resolveSecret is wired (back-compat)', async () => {
    await testImportedAgent(validInput(), adminEvent);
    const deps = mockBuildRegistry.mock.calls[0][0] as { resolveSecret?: unknown };
    expect(deps.resolveSecret).toBeUndefined();
  });

  it('NEVER logs the raw invocationSecret (console.log/error/warn)', async () => {
    const logSpy = jest.spyOn(console, 'log').mockImplementation(() => {});
    const errSpy = jest.spyOn(console, 'error').mockImplementation(() => {});
    const warnSpy = jest.spyOn(console, 'warn').mockImplementation(() => {});

    await testImportedAgent(
      validInput({ invocationAuthMode: 'API_KEY', invocationSecret: RAW_SECRET }),
      adminEvent,
    );

    const logged = [...logSpy.mock.calls, ...errSpy.mock.calls, ...warnSpy.mock.calls]
      .flat()
      .map((a) => (typeof a === 'string' ? a : JSON.stringify(a)))
      .join(' ');
    expect(logged).not.toContain(RAW_SECRET);
    logSpy.mockRestore();
    errSpy.mockRestore();
    warnSpy.mockRestore();
  });
});

// ── handler routing: Mutation.testImportedAgent ──────────────────────────
describe('handler — testImportedAgent', () => {
  it('routes fieldName testImportedAgent and returns the ImportTestResult', async () => {
    mockIsAdminFromEvent.mockReturnValue(true);
    mockInvoke.mockResolvedValue({ output: 'pong' });

    const res = (await handler({
      info: { fieldName: 'testImportedAgent' },
      arguments: { input: validInput() },
      identity: adminEvent.identity,
    })) as ImportTestResult;

    expect(res.ok).toBe(true);
    expect(res.output).toBe('pong');
    expect(mockInvoke).toHaveBeenCalledTimes(1);
  });

  it('rejects an unauthenticated caller (no identity)', async () => {
    await expect(
      handler({ info: { fieldName: 'testImportedAgent' }, arguments: { input: validInput() } }),
    ).rejects.toThrow(/unauthenticated/i);
    expect(mockBuildRegistry).not.toHaveBeenCalled();
    expect(mockInvoke).not.toHaveBeenCalled();
  });
});
