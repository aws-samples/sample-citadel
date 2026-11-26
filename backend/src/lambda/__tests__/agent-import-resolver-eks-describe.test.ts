/**
 * Acceptance tests for EKS substrate dispatch in `describeAgentCandidate`
 * (US-IMP-019).
 *
 * EKS is a DISCOVERY SUBSTRATE. When a pasted ref resolves to substrate 'eks',
 * `describeAgentCandidate` must dispatch describe() to the EksSourceAdapter
 * (which resolves the cluster's agent HTTP endpoint) via
 * `getDiscoveryAdapterForSubstrate`, NOT to the protocol-keyed HTTP adapter.
 * Non-eks refs are unchanged (protocol-keyed registry). A cross-account
 * describe reuses the SAME assume-creds path (the assumed credentialProvider is
 * threaded into the EKS adapter).
 *
 * Mirrors agent-import-resolver-ecs-describe.test.ts: the same mock harness,
 * stubbing `getDiscoveryAdapterForSubstrate` so we can observe substrate
 * dispatch and the threaded credentialProvider. The resolver itself is
 * UNCHANGED for EKS — it already dispatches by substrate.
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
const EXTERNAL_ID = 'ext-eks-describe-1';
const EKS_REF = `arn:aws:eks:us-east-1:${TARGET_ACCOUNT}:cluster/my-agent-cluster`;
const LAMBDA_REF = `arn:aws:lambda:us-east-1:${TARGET_ACCOUNT}:function:imported`;
const ASSUMED_KEY = 'ASIA-EKS-DESCRIBE-ASSUMED';
const ASSUMED_SECRET = 'assumed-eks-secret-NEVER-LOG-0123456789';
const ASSUMED_TOKEN = 'assumed-eks-token-NEVER-LOG';

const adminIdentity = { claims: { 'custom:role': 'admin' }, sub: 'admin-1' };

function describeEvent(args: Record<string, unknown>, identity: unknown = adminIdentity) {
  return { info: { fieldName: 'describeAgentCandidate' }, arguments: args, identity };
}

function eksDescriptor(): Record<string, unknown> {
  return {
    name: 'my-agent-cluster',
    description: '[eks k8sVersion=1.29 status=ACTIVE]',
    version: '1.29',
    skills: [],
    categories: [],
    inputSchema: {},
    outputSchema: {},
    invocation: {
      protocol: 'HTTP_ENDPOINT',
      target: 'https://agent.example.com/run',
      auth: { mode: 'NONE' },
      mode: 'sync',
    },
    origin: { substrate: 'eks', sourceArn: EKS_REF, ownership: 'external', discoveredAt: 'now' },
  };
}

const mockEksDescribe = jest.fn();

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
  mockEksDescribe.mockResolvedValue(eksDescriptor());
  // Default substrate dispatch: 'eks' -> EKS adapter; others -> undefined.
  mockGetDiscoveryAdapter.mockImplementation((substrate: string) =>
    substrate === 'eks' ? { describe: mockEksDescribe } : undefined,
  );
  mockAssumeRoleCredentials.mockReset();
});

afterAll(() => {
  delete process.env.ACCOUNT_ID;
});

describe('describeAgentCandidate — EKS substrate dispatch', () => {
  it('routes an eks candidate to the EksSourceAdapter (substrate dispatch), NOT the protocol registry', async () => {
    mockResolveSourceRef.mockReturnValue({
      protocol: 'HTTP_ENDPOINT',
      substrate: 'eks',
      target: EKS_REF,
    });
    const descriptor = eksDescriptor();
    mockEksDescribe.mockResolvedValue(descriptor);

    const res = (await handler(describeEvent({ ref: EKS_REF }))) as string;

    // Dispatched by substrate to the EKS adapter.
    expect(mockGetDiscoveryAdapter).toHaveBeenCalledWith('eks', expect.anything());
    expect(mockEksDescribe).toHaveBeenCalledTimes(1);
    // The protocol-keyed registry was NOT used for an eks describe.
    expect(mockBuildRegistry).not.toHaveBeenCalled();
    expect(mockProtocolDescribe).not.toHaveBeenCalled();
    // The EKS adapter's descriptor is returned (HTTP_ENDPOINT invocation).
    expect(JSON.parse(res)).toEqual(descriptor);
    expect(JSON.parse(res).invocation.protocol).toBe('HTTP_ENDPOINT');
  });

  it('passes the eks candidate (reference=cluster ARN) to the EKS adapter describe', async () => {
    mockResolveSourceRef.mockReturnValue({
      protocol: 'HTTP_ENDPOINT',
      substrate: 'eks',
      target: EKS_REF,
    });

    await handler(describeEvent({ ref: EKS_REF }));

    const candidate = mockEksDescribe.mock.calls[0][0] as {
      reference: string;
      origin: { substrate: string; sourceArn?: string };
    };
    expect(candidate.reference).toBe(EKS_REF);
    expect(candidate.origin.substrate).toBe('eks');
    expect(candidate.origin.sourceArn).toBe(EKS_REF);
  });

  it('leaves a NON-eks ref on the protocol-keyed registry (unchanged)', async () => {
    mockResolveSourceRef.mockReturnValue({
      protocol: 'LAMBDA_INVOKE',
      substrate: 'lambda',
      target: LAMBDA_REF,
    });
    const descriptor = { name: 'lambda-described' };
    mockProtocolDescribe.mockResolvedValue(descriptor);

    const res = (await handler(describeEvent({ ref: LAMBDA_REF }))) as string;

    // Protocol path used; EKS adapter NOT used.
    expect(mockBuildRegistry).toHaveBeenCalledTimes(1);
    expect(mockResolve).toHaveBeenCalledWith('LAMBDA_INVOKE');
    expect(mockProtocolDescribe).toHaveBeenCalledTimes(1);
    expect(mockEksDescribe).not.toHaveBeenCalled();
    expect(JSON.parse(res)).toEqual(descriptor);
  });

  it('cross-account eks describe assumes the role and threads the assumed credentialProvider into the EKS adapter', async () => {
    mockResolveSourceRef.mockReturnValue({
      protocol: 'HTTP_ENDPOINT',
      substrate: 'eks',
      target: EKS_REF,
    });
    mockAssumeRoleCredentials.mockResolvedValue({
      accessKeyId: ASSUMED_KEY,
      secretAccessKey: ASSUMED_SECRET,
      sessionToken: ASSUMED_TOKEN,
      expiration: new Date('2030-01-01T00:00:00.000Z'),
    });

    await handler(
      describeEvent({ ref: EKS_REF, discoveryRoleArn: DISCOVERY_ROLE, discoveryExternalId: EXTERNAL_ID }),
    );

    expect(mockAssumeRoleCredentials).toHaveBeenCalledTimes(1);
    expect(mockAssumeRoleCredentials.mock.calls[0][0]).toBe(DISCOVERY_ROLE);
    expect(mockAssumeRoleCredentials.mock.calls[0][1]).toBe(EXTERNAL_ID);
    // The EKS adapter was constructed with the ASSUMED credentialProvider.
    const deps = mockGetDiscoveryAdapter.mock.calls[0][1] as {
      credentialProvider?: Record<string, unknown>;
    };
    expect(deps.credentialProvider).toMatchObject({
      accessKeyId: ASSUMED_KEY,
      secretAccessKey: ASSUMED_SECRET,
      sessionToken: ASSUMED_TOKEN,
    });
    expect(mockEksDescribe).toHaveBeenCalledTimes(1);
  });

  it('NEVER logs the assumed credentials on the cross-account eks path', async () => {
    mockResolveSourceRef.mockReturnValue({
      protocol: 'HTTP_ENDPOINT',
      substrate: 'eks',
      target: EKS_REF,
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
      describeEvent({ ref: EKS_REF, discoveryRoleArn: DISCOVERY_ROLE, discoveryExternalId: EXTERNAL_ID }),
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
