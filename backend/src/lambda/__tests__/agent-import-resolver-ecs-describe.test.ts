/**
 * Acceptance tests for ECS substrate dispatch in `describeAgentCandidate`
 * (US-IMP-018).
 *
 * ECS is a DISCOVERY SUBSTRATE. When a pasted ref resolves to substrate 'ecs',
 * `describeAgentCandidate` must dispatch describe() to the EcsSourceAdapter
 * (which resolves the service's HTTP endpoint) via
 * `getDiscoveryAdapterForSubstrate`, NOT to the protocol-keyed HTTP adapter.
 * Non-ecs refs are unchanged (protocol-keyed registry). A cross-account
 * describe reuses the SAME assume-creds path (the assumed credentialProvider is
 * threaded into the ECS adapter).
 *
 * Mirrors agent-import-resolver-cross-account-describe.test.ts: the same mock
 * harness, but agent-discovery additionally stubs `getDiscoveryAdapterForSubstrate`
 * so we can observe substrate dispatch and the threaded credentialProvider. The
 * REAL toInvokeCredentials mapper is exercised (trust-path is only partially
 * mocked).
 */

// ── Mock RegistryService (nothing is persisted by a describe) ────────────
jest.mock('../../services/registry-service', () => ({
  RegistryService: jest.fn().mockImplementation(() => ({
    getRegistryId: () => 'test-registry',
    createResource: jest.fn(),
    updateResource: jest.fn(),
    listResources: jest.fn(),
    getResource: jest.fn(),
    updateResourceStatus: jest.fn(),
    serializeCustomMetadata: jest.fn((meta: unknown) => JSON.stringify(meta)),
    deserializeCustomMetadata: jest.fn(),
    mapToAgentConfig: jest.fn(),
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

// ── Mock agent-discovery: stub resolveSourceRef + getDiscoveryAdapterForSubstrate,
//    KEEP the real typed errors so the resolver's instanceof checks still hold. ─
const mockResolveSourceRef = jest.fn();
const mockGetDiscoveryAdapter = jest.fn();
jest.mock('../../services/agent-discovery', () => {
  const actual = jest.requireActual('../../services/agent-discovery');
  return {
    __esModule: true,
    ...actual,
    resolveSourceRef: (...args: unknown[]) => mockResolveSourceRef(...args),
    getDiscoveryAdapterForSubstrate: (...args: unknown[]) => mockGetDiscoveryAdapter(...args),
  };
});

// ── Mock events publish helper (keep real EventTypes) ────────────────────
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

// ── Mock the untrusted-output sanitizer (passthrough) ───────────────────
jest.mock('../../utils/sanitize-agent-output', () => ({
  __esModule: true,
  sanitizeUntrustedAgentOutput: (text: string) => ({ sanitized: text, modified: false, matches: [] }),
}));

// ── Mock the protocol adapter registry factory ───────────────────────────
const mockProtocolDescribe = jest.fn();
const mockResolve = jest.fn(() => ({ describe: mockProtocolDescribe }));
const mockBuildRegistry = jest.fn(() => ({ resolve: mockResolve }));
jest.mock('../../adapters/agent-source/registry-factory', () => ({
  __esModule: true,
  buildDefaultAgentSourceRegistry: (...args: unknown[]) => mockBuildRegistry(...args),
}));

// ── trust-path: stub ONLY assumeRoleCredentials (keep real pure helpers). ──
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
const EXTERNAL_ID = 'ext-ecs-describe-1';
const ECS_REF = `arn:aws:ecs:us-east-1:${TARGET_ACCOUNT}:service/my-cluster/my-agent-svc`;
const LAMBDA_REF = `arn:aws:lambda:us-east-1:${TARGET_ACCOUNT}:function:imported`;
const ASSUMED_KEY = 'ASIA-ECS-DESCRIBE-ASSUMED';
const ASSUMED_SECRET = 'assumed-ecs-secret-NEVER-LOG-0123456789';
const ASSUMED_TOKEN = 'assumed-ecs-token-NEVER-LOG';

const adminIdentity = { claims: { 'custom:role': 'admin' }, sub: 'admin-1' };

function describeEvent(args: Record<string, unknown>, identity: unknown = adminIdentity) {
  return { info: { fieldName: 'describeAgentCandidate' }, arguments: args, identity };
}

function ecsDescriptor(): Record<string, unknown> {
  return {
    name: 'my-agent-svc',
    description: 'ECS service my-agent-svc',
    version: '7',
    skills: [],
    categories: [],
    inputSchema: {},
    outputSchema: {},
    invocation: {
      protocol: 'HTTP_ENDPOINT',
      target: 'https://my-alb.us-east-1.elb.amazonaws.com',
      auth: { mode: 'NONE' },
      mode: 'sync',
    },
    origin: { substrate: 'ecs', sourceArn: ECS_REF, ownership: 'external', discoveredAt: 'now' },
  };
}

const mockEcsDescribe = jest.fn();

beforeEach(() => {
  process.env.REGISTRY_ENABLED = 'true';
  process.env.REGISTRY_ID = 'test-registry';
  process.env.AWS_REGION = 'us-east-1';
  process.env.ACCOUNT_ID = '111122223333';
  _resetRegistryService();
  jest.clearAllMocks();
  mockIsAdminFromEvent.mockReturnValue(true);
  mockHasRoleFromEvent.mockReturnValue(false);
  mockExtractOrgFromEvent.mockResolvedValue(ORG);
  mockResolve.mockReturnValue({ describe: mockProtocolDescribe });
  mockBuildRegistry.mockReturnValue({ resolve: mockResolve });
  mockProtocolDescribe.mockResolvedValue({ name: 'protocol-described' });
  mockEcsDescribe.mockResolvedValue(ecsDescriptor());
  // Default substrate dispatch: 'ecs' -> ECS adapter; others -> undefined.
  mockGetDiscoveryAdapter.mockImplementation((substrate: string) =>
    substrate === 'ecs' ? { describe: mockEcsDescribe } : undefined,
  );
  mockAssumeRoleCredentials.mockReset();
});

afterAll(() => {
  delete process.env.ACCOUNT_ID;
});

describe('describeAgentCandidate — ECS substrate dispatch', () => {
  it('routes an ecs candidate to the EcsSourceAdapter (substrate dispatch), NOT the protocol registry', async () => {
    mockResolveSourceRef.mockReturnValue({
      protocol: 'HTTP_ENDPOINT',
      substrate: 'ecs',
      target: ECS_REF,
    });
    const descriptor = ecsDescriptor();
    mockEcsDescribe.mockResolvedValue(descriptor);

    const res = (await handler(describeEvent({ ref: ECS_REF }))) as string;

    // Dispatched by substrate to the ECS adapter.
    expect(mockGetDiscoveryAdapter).toHaveBeenCalledWith('ecs', expect.anything());
    expect(mockEcsDescribe).toHaveBeenCalledTimes(1);
    // The protocol-keyed registry was NOT used for an ecs describe.
    expect(mockBuildRegistry).not.toHaveBeenCalled();
    expect(mockProtocolDescribe).not.toHaveBeenCalled();
    // The ECS adapter's descriptor is returned (HTTP_ENDPOINT invocation).
    expect(JSON.parse(res)).toEqual(descriptor);
    expect(JSON.parse(res).invocation.protocol).toBe('HTTP_ENDPOINT');
  });

  it('passes the ecs candidate (reference=service ARN) to the ECS adapter describe', async () => {
    mockResolveSourceRef.mockReturnValue({
      protocol: 'HTTP_ENDPOINT',
      substrate: 'ecs',
      target: ECS_REF,
    });

    await handler(describeEvent({ ref: ECS_REF }));

    const candidate = mockEcsDescribe.mock.calls[0][0] as {
      reference: string;
      origin: { substrate: string; sourceArn?: string };
    };
    expect(candidate.reference).toBe(ECS_REF);
    expect(candidate.origin.substrate).toBe('ecs');
    expect(candidate.origin.sourceArn).toBe(ECS_REF);
  });

  it('leaves a NON-ecs ref on the protocol-keyed registry (unchanged)', async () => {
    mockResolveSourceRef.mockReturnValue({
      protocol: 'LAMBDA_INVOKE',
      substrate: 'lambda',
      target: LAMBDA_REF,
    });
    const descriptor = { name: 'lambda-described' };
    mockProtocolDescribe.mockResolvedValue(descriptor);

    const res = (await handler(describeEvent({ ref: LAMBDA_REF }))) as string;

    // Protocol path used; ECS adapter NOT used.
    expect(mockBuildRegistry).toHaveBeenCalledTimes(1);
    expect(mockResolve).toHaveBeenCalledWith('LAMBDA_INVOKE');
    expect(mockProtocolDescribe).toHaveBeenCalledTimes(1);
    expect(mockEcsDescribe).not.toHaveBeenCalled();
    expect(JSON.parse(res)).toEqual(descriptor);
  });

  it('cross-account ecs describe assumes the role and threads the assumed credentialProvider into the ECS adapter', async () => {
    mockResolveSourceRef.mockReturnValue({
      protocol: 'HTTP_ENDPOINT',
      substrate: 'ecs',
      target: ECS_REF,
    });
    mockAssumeRoleCredentials.mockResolvedValue({
      accessKeyId: ASSUMED_KEY,
      secretAccessKey: ASSUMED_SECRET,
      sessionToken: ASSUMED_TOKEN,
      expiration: new Date('2030-01-01T00:00:00.000Z'),
    });

    await handler(
      describeEvent({ ref: ECS_REF, discoveryRoleArn: DISCOVERY_ROLE, discoveryExternalId: EXTERNAL_ID }),
    );

    expect(mockAssumeRoleCredentials).toHaveBeenCalledTimes(1);
    expect(mockAssumeRoleCredentials.mock.calls[0][0]).toBe(DISCOVERY_ROLE);
    expect(mockAssumeRoleCredentials.mock.calls[0][1]).toBe(EXTERNAL_ID);
    // The ECS adapter was constructed with the ASSUMED credentialProvider.
    const deps = mockGetDiscoveryAdapter.mock.calls[0][1] as {
      credentialProvider?: Record<string, unknown>;
    };
    expect(deps.credentialProvider).toMatchObject({
      accessKeyId: ASSUMED_KEY,
      secretAccessKey: ASSUMED_SECRET,
      sessionToken: ASSUMED_TOKEN,
    });
    expect(mockEcsDescribe).toHaveBeenCalledTimes(1);
  });

  it('NEVER logs the assumed credentials on the cross-account ecs path', async () => {
    mockResolveSourceRef.mockReturnValue({
      protocol: 'HTTP_ENDPOINT',
      substrate: 'ecs',
      target: ECS_REF,
    });
    mockAssumeRoleCredentials.mockResolvedValue({
      accessKeyId: ASSUMED_KEY,
      secretAccessKey: ASSUMED_SECRET,
      sessionToken: ASSUMED_TOKEN,
    });
    const logSpy = jest.spyOn(console, 'log').mockImplementation(() => undefined);
    const warnSpy = jest.spyOn(console, 'warn').mockImplementation(() => undefined);
    const errorSpy = jest.spyOn(console, 'error').mockImplementation(() => undefined);

    await handler(
      describeEvent({ ref: ECS_REF, discoveryRoleArn: DISCOVERY_ROLE, discoveryExternalId: EXTERNAL_ID }),
    );

    const all = [...logSpy.mock.calls, ...warnSpy.mock.calls, ...errorSpy.mock.calls]
      .flat()
      .map((a) => (typeof a === 'string' ? a : JSON.stringify(a)))
      .join('\n');
    expect(all).not.toContain(ASSUMED_SECRET);
    expect(all).not.toContain(ASSUMED_TOKEN);
    logSpy.mockRestore();
    warnSpy.mockRestore();
    errorSpy.mockRestore();
  });
});
