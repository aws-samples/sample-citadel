/**
 * Acceptance tests for CROSS-ACCOUNT describe wiring in `describeAgentCandidate`
 * (Phase 2, agent-import).
 *
 * `describeAgentCandidate` resolves a pasted ref to its protocol and delegates
 * to the per-protocol adapter's `describe()` (its List/Get capability reads).
 * When the caller supplies a `discoveryRoleArn` (a READ-ONLY role in the TARGET
 * account, externalId-gated), the resolver assumes it via
 * {@link assumeRoleCredentials}, maps the raw temp credentials onto the
 * invoke-credentials shape (reusing the REAL `toInvokeCredentials`), and builds
 * the adapter registry with that `credentialProvider` so the describe runs in
 * the target account. Absent ⇒ EXACTLY today's behaviour (default registry, no
 * credentialProvider, this Lambda's identity).
 *
 * UNLIKE the result-returning invoke paths (testImportedAgent /
 * probeAgentCandidate), describe is ERROR-shaped: a failed cross-account assume
 * THROWS (surfaced by the handler as a clean GraphQL error), never an ok/false
 * result. The assumed credentials are NEVER logged.
 *
 * Mirrors agent-import-resolver-cross-account-invoke.test.ts: the adapter
 * registry factory is mocked to capture the { credentialProvider } deps and the
 * adapter describe; assumeRoleCredentials is stubbed via a PARTIAL mock of
 * trust-path so the REAL toInvokeCredentials mapper keeps working;
 * resolveSourceRef is stubbed (keeping the real typed errors).
 */

// ── Mock RegistryService (nothing is persisted by a describe) ────────────
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

// ── Mock auth-event (gate is mocked; defaults deny) ──────────────────────
const mockExtractOrgFromEvent = jest.fn();
const mockIsAdminFromEvent = jest.fn(() => false);
const mockHasRoleFromEvent = jest.fn(() => false);
jest.mock('../../utils/auth-event', () => ({
  extractOrgFromEvent: (...args: unknown[]) => mockExtractOrgFromEvent(...args),
  isAdminFromEvent: (...args: unknown[]) => mockIsAdminFromEvent(...args),
  hasRoleFromEvent: (...args: unknown[]) => mockHasRoleFromEvent(...args),
}));

// ── Mock agent-discovery: stub resolveSourceRef, KEEP the real typed errors
//    so the resolver's `instanceof` checks and our fixtures share one class. ─
const mockResolveSourceRef = jest.fn();
jest.mock('../../services/agent-discovery', () => {
  const actual = jest.requireActual('../../services/agent-discovery');
  return {
    __esModule: true,
    ...actual,
    resolveSourceRef: (...args: unknown[]) => mockResolveSourceRef(...args),
  };
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

// ── Mock credential-manager (no AWS at load) ─────────────────────────────
const mockGetAgentInvocationSecret = jest.fn();
const mockStoreAgentInvocationSecret = jest.fn();
jest.mock('../../utils/credential-manager', () => ({
  __esModule: true,
  getAgentInvocationSecret: (...a: unknown[]) => mockGetAgentInvocationSecret(...a),
  storeAgentInvocationSecret: (...a: unknown[]) => mockStoreAgentInvocationSecret(...a),
}));

// ── Mock the untrusted-output sanitizer (passthrough) ───────────────────
jest.mock('../../utils/sanitize-agent-output', () => ({
  __esModule: true,
  sanitizeUntrustedAgentOutput: (text: string) => ({ sanitized: text, modified: false, matches: [] }),
}));

// ── Mock the adapter registry factory: capture the { credentialProvider }
//    deps and expose the adapter describe(). ───────────────────────────────
const mockDescribe = jest.fn();
const mockResolve = jest.fn(() => ({ describe: mockDescribe }));
const mockBuildRegistry = jest.fn(() => ({ resolve: mockResolve }));
jest.mock('../../adapters/agent-source/registry-factory', () => ({
  __esModule: true,
  buildDefaultAgentSourceRegistry: (...args: unknown[]) => mockBuildRegistry(...args),
}));

// ── trust-path: stub ONLY assumeRoleCredentials (keep the real pure helpers).
//    The REAL toInvokeCredentials (from invoke-support) is intentionally NOT
//    mocked, so the credential mapping is genuinely exercised. ───────────────
const mockAssumeRoleCredentials = jest.fn();
jest.mock('../../utils/trust-path', () => {
  const actual = jest.requireActual('../../utils/trust-path');
  return {
    __esModule: true,
    ...actual,
    assumeRoleCredentials: (...a: unknown[]) => mockAssumeRoleCredentials(...a),
  };
});

import { handler, _resetRegistryService } from '../agent-import-resolver';

// ── Fixtures ────────────────────────────────────────────────────────────
const ORG = 'test-org-a';
const TARGET_ACCOUNT = '999988887777';
const DISCOVERY_ROLE = `arn:aws:iam::${TARGET_ACCOUNT}:role/CitadelDiscoveryReadOnly`;
const EXTERNAL_ID = 'ext-describe-1';
const REF = `arn:aws:lambda:us-east-1:${TARGET_ACCOUNT}:function:imported`;
const ASSUMED_KEY = 'ASIA-DESCRIBE-ASSUMED';
const ASSUMED_SECRET = 'assumed-describe-secret-NEVER-LOG-0123456789';
const ASSUMED_TOKEN = 'assumed-describe-token-NEVER-LOG';

const adminIdentity = { claims: { 'custom:role': 'admin' }, sub: 'admin-1' };
const developerIdentity = { claims: { 'custom:organization': ORG }, sub: 'dev-1' };

function describeEvent(
  args: Record<string, unknown>,
  identity: unknown = adminIdentity,
): { info: { fieldName: string }; arguments: Record<string, unknown>; identity: unknown } {
  return { info: { fieldName: 'describeAgentCandidate' }, arguments: args, identity };
}

/** Raw temp credentials shape returned by assumeRoleCredentials (a success). */
function assumedOk() {
  return {
    accessKeyId: ASSUMED_KEY,
    secretAccessKey: ASSUMED_SECRET,
    sessionToken: ASSUMED_TOKEN,
    expiration: new Date('2030-01-01T00:00:00.000Z'),
  };
}

function descriptorFixture(): Record<string, unknown> {
  return {
    name: 'imported',
    description: 'a discovered agent',
    version: '1.0.0',
    skills: [],
    categories: [],
    inputSchema: {},
    outputSchema: {},
  };
}

/** The deps of the buildDefaultAgentSourceRegistry call carrying a credentialProvider. */
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
  process.env.ACCOUNT_ID = '111122223333';
  _resetRegistryService();
  jest.clearAllMocks();
  mockIsAdminFromEvent.mockReturnValue(false);
  mockHasRoleFromEvent.mockReturnValue(false);
  mockExtractOrgFromEvent.mockResolvedValue(ORG);
  mockResolveSourceRef.mockReturnValue({
    protocol: 'LAMBDA_INVOKE',
    substrate: 'lambda',
    target: REF,
  });
  mockResolve.mockReturnValue({ describe: mockDescribe });
  mockBuildRegistry.mockReturnValue({ resolve: mockResolve });
  mockDescribe.mockResolvedValue(descriptorFixture());
  mockAssumeRoleCredentials.mockReset();
});

afterAll(() => {
  delete process.env.ACCOUNT_ID;
});

// ===========================================================================
// describeAgentCandidate — cross-account describe
// ===========================================================================
describe('describeAgentCandidate — cross-account describe', () => {
  beforeEach(() => mockIsAdminFromEvent.mockReturnValue(true));

  it('with discoveryRoleArn+discoveryExternalId: assumes the role, builds the registry with the assumed credentialProvider, describes, and returns the descriptor', async () => {
    mockAssumeRoleCredentials.mockResolvedValue(assumedOk());
    const descriptor = descriptorFixture();
    mockDescribe.mockResolvedValue(descriptor);

    const res = (await handler(
      describeEvent({ ref: REF, discoveryRoleArn: DISCOVERY_ROLE, discoveryExternalId: EXTERNAL_ID }),
    )) as string;

    // assumeRoleCredentials was called with the role + externalId.
    expect(mockAssumeRoleCredentials).toHaveBeenCalledTimes(1);
    expect(mockAssumeRoleCredentials.mock.calls[0][0]).toBe(DISCOVERY_ROLE);
    expect(mockAssumeRoleCredentials.mock.calls[0][1]).toBe(EXTERNAL_ID);

    // The registry was built with the ASSUMED credentials (real toInvokeCredentials).
    const deps = crossAccountBuildDeps();
    expect(deps?.credentialProvider).toMatchObject({
      accessKeyId: ASSUMED_KEY,
      secretAccessKey: ASSUMED_SECRET,
      sessionToken: ASSUMED_TOKEN,
    });

    // describe ran on that registry's adapter and the descriptor is returned.
    expect(mockResolve).toHaveBeenCalledWith('LAMBDA_INVOKE');
    expect(mockDescribe).toHaveBeenCalledTimes(1);
    expect(typeof res).toBe('string');
    expect(JSON.parse(res)).toEqual(descriptor);
  });

  it('passes a missing discoveryExternalId through to assumeRoleCredentials as undefined', async () => {
    mockAssumeRoleCredentials.mockResolvedValue(assumedOk());

    await handler(describeEvent({ ref: REF, discoveryRoleArn: DISCOVERY_ROLE }));

    expect(mockAssumeRoleCredentials).toHaveBeenCalledTimes(1);
    expect(mockAssumeRoleCredentials.mock.calls[0][0]).toBe(DISCOVERY_ROLE);
    expect(mockAssumeRoleCredentials.mock.calls[0][1]).toBeUndefined();
    expect(crossAccountBuildDeps()?.credentialProvider).toMatchObject({ accessKeyId: ASSUMED_KEY });
  });

  it('WITHOUT discoveryRoleArn: does NOT assume; default registry (no credentialProvider) — unchanged', async () => {
    const descriptor = descriptorFixture();
    mockDescribe.mockResolvedValue(descriptor);

    const res = (await handler(describeEvent({ ref: REF }))) as string;

    expect(mockAssumeRoleCredentials).not.toHaveBeenCalled();
    // Byte-identical: the default registry is built with NO args.
    expect(mockBuildRegistry).toHaveBeenCalledTimes(1);
    expect(mockBuildRegistry.mock.calls[0][0]).toBeUndefined();
    expect(mockDescribe).toHaveBeenCalledTimes(1);
    expect(JSON.parse(res)).toEqual(descriptor);
  });

  it('a cross-account ASSUME FAILURE is surfaced as a thrown error (describe is error-shaped, NOT ok/false)', async () => {
    mockAssumeRoleCredentials.mockRejectedValue(
      new Error('AccessDenied: not authorized to perform sts:AssumeRole'),
    );

    await expect(
      handler(
        describeEvent({ ref: REF, discoveryRoleArn: DISCOVERY_ROLE, discoveryExternalId: EXTERNAL_ID }),
      ),
    ).rejects.toThrow(/assume|accessdenied/i);

    expect(mockAssumeRoleCredentials).toHaveBeenCalledTimes(1);
    // We never fell back to the handler identity to describe in the wrong account.
    expect(mockDescribe).not.toHaveBeenCalled();
  });

  it('NEVER logs the assumed credentials (success path)', async () => {
    const logSpy = jest.spyOn(console, 'log').mockImplementation(() => undefined);
    const warnSpy = jest.spyOn(console, 'warn').mockImplementation(() => undefined);
    const errorSpy = jest.spyOn(console, 'error').mockImplementation(() => undefined);
    mockAssumeRoleCredentials.mockResolvedValue(assumedOk());

    await handler(
      describeEvent({ ref: REF, discoveryRoleArn: DISCOVERY_ROLE, discoveryExternalId: EXTERNAL_ID }),
    );

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

  it('developer/non-privileged caller is still rejected (gate unchanged) and never assumes', async () => {
    mockIsAdminFromEvent.mockReturnValue(false);
    mockHasRoleFromEvent.mockReturnValue(false);

    await expect(
      handler(
        describeEvent(
          { ref: REF, discoveryRoleArn: DISCOVERY_ROLE, discoveryExternalId: EXTERNAL_ID },
          developerIdentity,
        ),
      ),
    ).rejects.toThrow(/admin or architect/i);

    expect(mockAssumeRoleCredentials).not.toHaveBeenCalled();
    expect(mockBuildRegistry).not.toHaveBeenCalled();
    expect(mockDescribe).not.toHaveBeenCalled();
  });
});
