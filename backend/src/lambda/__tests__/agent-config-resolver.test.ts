/**
 * Tests for agent-config-resolver Lambda
 */
import { DynamoDBDocumentClient, GetCommand, PutCommand, ScanCommand, DeleteCommand } from '@aws-sdk/lib-dynamodb';
import { mockClient } from 'aws-sdk-client-mock';

const dynamoMock = mockClient(DynamoDBDocumentClient);

// Mock the RegistryService so registry-backed paths (activateProjectAgents)
// can be driven without hitting the AgentCore Registry SDK. DynamoDB-only
// tests never construct a RegistryService, so this mock does not affect them.
const mockListResources = jest.fn();
const mockUpdateResourceStatus = jest.fn();
const mockGetResource = jest.fn();
const mockUpdateResource = jest.fn();
const mockMapToAgentConfig = jest.fn((record: any) => ({
  agentId: record?.recordId,
  state: 'active',
}));
const mockSerializeCustomMetadata = jest.fn((meta: any) => JSON.stringify(meta));
const mockToRegistryStatus = jest.fn((state: string) =>
  state === 'active' ? 'APPROVED' : state === 'inactive' ? 'DEPRECATED' : 'DRAFT',
);
// Faithful to the real registry-service: the activation gate (US-IMP) added to
// activateProjectAgents reads customMetadata via deserializeCustomMetadata.
// These records carry no governanceAttestation, so the gate is a no-op here.
const mockDeserializeCustomMetadata = jest.fn((json: string | null, defaults: any) => {
  if (!json) return defaults;
  try {
    return { ...defaults, ...JSON.parse(json) };
  } catch {
    return defaults;
  }
});

jest.mock('../../services/registry-service', () => ({
  RegistryService: jest.fn().mockImplementation(() => ({
    listResources: mockListResources,
    updateResourceStatus: mockUpdateResourceStatus,
    deserializeCustomMetadata: mockDeserializeCustomMetadata,
    getResource: mockGetResource,
    updateResource: mockUpdateResource,
    serializeCustomMetadata: mockSerializeCustomMetadata,
    toRegistryStatus: mockToRegistryStatus,
    mapToAgentConfig: mockMapToAgentConfig,
  })),
  RegistryRecordStatusValues: {
    DRAFT: 'DRAFT',
    PENDING_APPROVAL: 'PENDING_APPROVAL',
    APPROVED: 'APPROVED',
    REJECTED: 'REJECTED',
    DEPRECATED: 'DEPRECATED',
    CREATING: 'CREATING',
    UPDATING: 'UPDATING',
    CREATE_FAILED: 'CREATE_FAILED',
    UPDATE_FAILED: 'UPDATE_FAILED',
  },
}));

// Lazy IAM trust-path core — only computeTrustPath is mocked so activation
// tests drive clean / findings / throw deterministically without touching IAM.
// The pure helpers (isCrossAccountRoleArn, accountIdFromArn) keep their real
// implementations via requireActual so cross-account detection is exercised
// for real, driven by process.env.ACCOUNT_ID.
const mockComputeTrustPath = jest.fn();
const mockAssumeAnalysisRoleClient = jest.fn();
jest.mock('../../utils/trust-path', () => ({
  ...jest.requireActual('../../utils/trust-path'),
  computeTrustPath: mockComputeTrustPath,
  assumeAnalysisRoleClient: mockAssumeAnalysisRoleClient,
}));

// Governance rollout flag + event emitter used by the activation gate.
const mockGetGovernanceEnforce = jest.fn();
jest.mock('../../utils/governance-flag', () => ({
  getGovernanceEnforce: mockGetGovernanceEnforce,
  getGovernanceEffectiveAt: jest.fn(),
}));
const mockPublishEvent = jest.fn();
jest.mock('../../utils/events', () => ({
  publishEvent: mockPublishEvent,
}));

import { handler, _resetRegistryService } from '../agent-config-resolver';

describe('agent-config-resolver', () => {
  beforeEach(() => {
    dynamoMock.reset();
    process.env.AGENT_CONFIG_TABLE = 'test-agent-config';
  });

  afterEach(() => {
    delete process.env.AGENT_CONFIG_TABLE;
  });

  const makeEvent = (fieldName: string, args: any) => ({
    info: { fieldName },
    arguments: args,
  });

  describe('listAgentConfigs', () => {
    test('returns all configs with stringified config field', async () => {
      dynamoMock.on(ScanCommand).resolves({
        Items: [
          { agentId: 'a1', config: { name: 'Agent1' }, state: 'active', categories: ['cat1'] },
          { agentId: 'a2', config: '{"name":"Agent2"}', state: 'inactive' },
        ],
      });

      const result = await handler(makeEvent('listAgentConfigs', {}));

      expect(result).toHaveLength(2);
      expect(result[0].agentId).toBe('a1');
      expect(typeof result[0].config).toBe('string');
      expect(JSON.parse(result[0].config)).toEqual({ name: 'Agent1' });
      expect(result[1].state).toBe('inactive');
    });

    test('returns empty array when no configs exist', async () => {
      dynamoMock.on(ScanCommand).resolves({ Items: [] });
      const result = await handler(makeEvent('listAgentConfigs', {}));
      expect(result).toEqual([]);
    });
  });

  describe('getAgentConfig', () => {
    test('returns config when found', async () => {
      dynamoMock.on(GetCommand).resolves({
        Item: { agentId: 'a1', config: { name: 'Agent1' }, state: 'active' },
      });

      const result = await handler(makeEvent('getAgentConfig', { agentId: 'a1' }));
      expect(result).toBeDefined();
      expect(result!.agentId).toBe('a1');
    });

    test('returns null when not found', async () => {
      dynamoMock.on(GetCommand).resolves({});
      const result = await handler(makeEvent('getAgentConfig', { agentId: 'missing' }));
      expect(result).toBeNull();
    });
  });

  describe('createAgentConfig', () => {
    test('creates config and returns stringified config', async () => {
      dynamoMock.on(PutCommand).resolves({});

      const result = await handler(makeEvent('createAgentConfig', {
        input: { agentId: 'new-agent', config: '{"name":"New"}', state: 'active' },
      }));

      expect(result.agentId).toBe('new-agent');
      expect(typeof result.config).toBe('string');
      expect(result.createdAt).toBeDefined();
    });
  });

  describe('updateAgentConfig', () => {
    test('throws when config not found', async () => {
      dynamoMock.on(GetCommand).resolves({});

      await expect(
        handler(makeEvent('updateAgentConfig', { input: { agentId: 'missing' } }))
      ).rejects.toThrow('Agent config not found');
    });

    test('updates existing config', async () => {
      dynamoMock.on(GetCommand).resolves({
        Item: { agentId: 'a1', config: '{"old":true}', state: 'active', createdAt: '2025-01-01' },
      });
      dynamoMock.on(PutCommand).resolves({});

      const result = await handler(makeEvent('updateAgentConfig', {
        input: { agentId: 'a1', config: '{"new":true}' },
      }));

      expect(result.agentId).toBe('a1');
      expect(JSON.parse(result.config)).toEqual({ new: true });
    });
  });

  describe('deleteAgentConfig', () => {
    test('returns success on delete', async () => {
      dynamoMock.on(DeleteCommand).resolves({});

      const result = await handler(makeEvent('deleteAgentConfig', { agentId: 'a1' }));
      expect(result.success).toBe(true);
    });
  });

  describe('activateProjectAgents', () => {
    beforeEach(() => {
      process.env.REGISTRY_ID = 'reg-123';
      _resetRegistryService();
      mockListResources.mockReset();
      mockUpdateResourceStatus.mockReset();
    });

    afterEach(() => {
      delete process.env.REGISTRY_ID;
    });

    const agentRecord = (
      recordId: string,
      name: string,
      sourceProjectId: string | undefined,
      status: string,
    ) => ({
      recordId,
      name,
      status,
      customDescriptorContent: JSON.stringify({ sourceProjectId, manifest: {} }),
    });

    test('filters by sourceProjectId, activates non-active, skips already-active', async () => {
      mockListResources.mockResolvedValue([
        agentRecord('r1', 'Agent One', 'proj-1', 'DRAFT'),
        agentRecord('r2', 'Agent Two', 'proj-1', 'APPROVED'),
        agentRecord('r3', 'Other Project', 'proj-2', 'DRAFT'),
      ]);
      mockUpdateResourceStatus.mockResolvedValue({});

      const result = await handler(makeEvent('activateProjectAgents', { projectId: 'proj-1' }));

      expect(mockListResources).toHaveBeenCalledWith('agent');
      expect(mockUpdateResourceStatus).toHaveBeenCalledTimes(1);
      expect(mockUpdateResourceStatus).toHaveBeenCalledWith('agent', 'r1', 'APPROVED');
      expect(result.activated).toEqual(['Agent One']);
      expect(result.alreadyActive).toEqual(['Agent Two']);
      expect(result.failed).toEqual([]);
    });

    test('continues and records failed when one agent errors', async () => {
      mockListResources.mockResolvedValue([
        agentRecord('r1', 'Agent One', 'proj-1', 'DRAFT'),
        agentRecord('r2', 'Agent Two', 'proj-1', 'DRAFT'),
      ]);
      mockUpdateResourceStatus
        .mockRejectedValueOnce(new Error('boom'))
        .mockResolvedValueOnce({});

      const result = await handler(makeEvent('activateProjectAgents', { projectId: 'proj-1' }));

      expect(result.activated).toEqual(['Agent Two']);
      expect(result.failed).toEqual(['Agent One']);
      expect(result.alreadyActive).toEqual([]);
    });

    test('returns empty arrays when no agents match the project', async () => {
      mockListResources.mockResolvedValue([
        agentRecord('r3', 'Other Project', 'proj-2', 'DRAFT'),
        agentRecord('r4', 'No Project', undefined, 'DRAFT'),
      ]);

      const result = await handler(makeEvent('activateProjectAgents', { projectId: 'proj-1' }));

      expect(mockUpdateResourceStatus).not.toHaveBeenCalled();
      expect(result).toEqual({ activated: [], failed: [], alreadyActive: [] });
    });
  });

  test('throws on unknown field', async () => {
    await expect(handler(makeEvent('unknownField', {}))).rejects.toThrow('Unknown field');
  });
});

describe('updateAgentConfigRegistry — lazy IAM trust-path activation (US-IMP)', () => {
  const AGENT_ID = 'agent-import-1';
  const ROLE_ARN = 'arn:aws:iam::123456789012:role/imported-agent-role';

  beforeEach(() => {
    process.env.REGISTRY_ENABLED = 'true';
    process.env.REGISTRY_ID = 'reg-123';
    process.env.ENVIRONMENT = 'dev';
    _resetRegistryService();
    mockListResources.mockReset();
    mockUpdateResourceStatus.mockReset().mockResolvedValue({});
    mockGetResource.mockReset();
    mockUpdateResource
      .mockReset()
      .mockImplementation(async (_type: string, id: string, input: any) => ({
        recordId: id,
        name: input.name,
        description: input.description,
        status: 'UPDATING',
        customDescriptorContent: input.customMetadata,
      }));
    mockComputeTrustPath.mockReset();
    mockAssumeAnalysisRoleClient.mockReset();
    mockGetGovernanceEnforce.mockReset().mockResolvedValue('strict');
    mockPublishEvent.mockReset().mockResolvedValue(undefined);
    mockMapToAgentConfig.mockClear();
    mockToRegistryStatus.mockClear();
    mockSerializeCustomMetadata.mockClear();
    mockDeserializeCustomMetadata.mockClear();
  });

  afterEach(() => {
    delete process.env.REGISTRY_ENABLED;
    delete process.env.REGISTRY_ID;
    delete process.env.ENVIRONMENT;
    delete process.env.ACCOUNT_ID;
  });

  // An imported Registry record (governanceAttestation present). orgId is set
  // so updateAgentConfigRegistry never needs extractOrgFromEvent.
  function importedRecord(
    opts: {
      status?: 'pending' | 'attested';
      roleArn?: string;
      recordStatus?: string;
      analysisRoleArn?: string;
      externalId?: string;
    } = {},
  ) {
    const meta: Record<string, unknown> = {
      orgId: 'org-1',
      categories: [],
      icon: '',
      state: 'inactive',
      governanceAttestation: {
        status: opts.status ?? 'pending',
        enforcementMode: 'strict',
        authorityRequested: true,
        requestedAt: '2026-01-01T00:00:00.000Z',
      },
    };
    if (opts.roleArn !== undefined) {
      meta.invocation = {
        protocol: 'AGENTCORE_RUNTIME',
        target: opts.roleArn,
        auth: { mode: 'SIGV4' },
        mode: 'sync',
        roleArn: opts.roleArn,
        ...(opts.analysisRoleArn !== undefined ? { analysisRoleArn: opts.analysisRoleArn } : {}),
        ...(opts.externalId !== undefined ? { externalId: opts.externalId } : {}),
      };
    }
    return {
      recordId: AGENT_ID,
      name: 'Imported Agent',
      status: opts.recordStatus ?? 'PENDING_APPROVAL',
      customDescriptorContent: JSON.stringify(meta),
    };
  }

  const approvedRecord = () => ({
    recordId: AGENT_ID,
    name: 'Imported Agent',
    status: 'APPROVED',
    customDescriptorContent: '{}',
  });

  const activateEvent = () => ({
    info: { fieldName: 'updateAgentConfig' },
    arguments: { input: { agentId: AGENT_ID, state: 'active' } },
  });

  test('imported+pending+roleArn+clean → auto-attests (system:trust-path) and activation proceeds', async () => {
    mockGetResource
      .mockResolvedValueOnce(importedRecord({ roleArn: ROLE_ARN }))
      .mockResolvedValueOnce(approvedRecord());
    mockComputeTrustPath.mockResolvedValue({ hops: [], notes: [], findings: [], clean: true });

    await handler(activateEvent());

    expect(mockComputeTrustPath).toHaveBeenCalledWith(ROLE_ARN);
    const persisted = JSON.parse(mockUpdateResource.mock.calls[0][2].customMetadata);
    expect(persisted.governanceAttestation.status).toBe('attested');
    expect(persisted.governanceAttestation.attestedBy).toBe('system:trust-path');
    expect(persisted.governanceAttestation.attestedAt).toBeDefined();
    expect(persisted.governanceAttestation.trustPath.clean).toBe(true);
    // strict mode, yet activation proceeds because the gate now sees 'attested'.
    expect(mockUpdateResourceStatus).toHaveBeenCalledWith('agent', AGENT_ID, 'APPROVED');
  });

  test('imported+pending+roleArn+findings → stays pending, findings stored, strict gate blocks', async () => {
    mockGetResource.mockResolvedValue(importedRecord({ roleArn: ROLE_ARN }));
    mockComputeTrustPath.mockResolvedValue({
      hops: [],
      notes: [],
      findings: ['over-broad-action: arn:...:role/imported-agent-role'],
      clean: false,
    });

    await expect(handler(activateEvent())).rejects.toThrow('Activation blocked');

    expect(mockComputeTrustPath).toHaveBeenCalledWith(ROLE_ARN);
    const persisted = JSON.parse(mockUpdateResource.mock.calls[0][2].customMetadata);
    expect(persisted.governanceAttestation.status).toBe('pending');
    expect(persisted.governanceAttestation.trustPath.clean).toBe(false);
    expect(persisted.governanceAttestation.trustPath.findings).toEqual([
      'over-broad-action: arn:...:role/imported-agent-role',
    ]);
    expect(mockUpdateResourceStatus).not.toHaveBeenCalled();
  });

  test('trust-path throws → activation not crashed, no auto-attest (permissive proceeds)', async () => {
    mockGetGovernanceEnforce.mockResolvedValue('permissive');
    mockGetResource
      .mockResolvedValueOnce(importedRecord({ roleArn: ROLE_ARN }))
      .mockResolvedValueOnce(approvedRecord());
    mockComputeTrustPath.mockRejectedValue(new Error('cross-account role unresolvable'));

    await expect(handler(activateEvent())).resolves.toBeDefined();

    expect(mockComputeTrustPath).toHaveBeenCalledWith(ROLE_ARN);
    // best-effort skip — no attestation folded into the persisted metadata.
    const persisted = JSON.parse(mockUpdateResource.mock.calls[0][2].customMetadata);
    expect(persisted.governanceAttestation).toBeUndefined();
    // permissive gate proceeds (telemetry only), so activation still happens.
    expect(mockUpdateResourceStatus).toHaveBeenCalledWith('agent', AGENT_ID, 'APPROVED');
  });

  test('roleless imported+pending → no trust-path call, gate governs (strict blocks)', async () => {
    mockGetResource.mockResolvedValue(importedRecord({}));

    await expect(handler(activateEvent())).rejects.toThrow('Activation blocked');

    expect(mockComputeTrustPath).not.toHaveBeenCalled();
    expect(mockUpdateResourceStatus).not.toHaveBeenCalled();
  });

  test('non-imported record → no trust-path call, activation unchanged', async () => {
    mockGetResource
      .mockResolvedValueOnce({
        recordId: AGENT_ID,
        name: 'Plain',
        status: 'DRAFT',
        customDescriptorContent: JSON.stringify({ orgId: 'org-1', categories: [], state: 'inactive' }),
      })
      .mockResolvedValueOnce(approvedRecord());

    await handler(activateEvent());

    expect(mockComputeTrustPath).not.toHaveBeenCalled();
    expect(mockUpdateResourceStatus).toHaveBeenCalledWith('agent', AGENT_ID, 'APPROVED');
  });

  // ─── Phase-2: cross-account roleArn awareness ──────────────────────────────
  // ROLE_ARN lives in account 123456789012. A deployment ACCOUNT_ID that differs
  // makes the invocation.roleArn cross-account: the in-process, same-account
  // computeTrustPath cannot introspect it (GetRole runs in the home account), so
  // the check is skipped and the attestation stays 'pending' for the gate.
  const CROSS_ACCOUNT_DEPLOYMENT = '999999999999';

  test('imported+pending+CROSS-ACCOUNT roleArn → skips computeTrustPath, records crossAccount, stays pending, strict gate blocks (not crashed)', async () => {
    process.env.ACCOUNT_ID = CROSS_ACCOUNT_DEPLOYMENT;
    mockGetResource.mockResolvedValue(importedRecord({ roleArn: ROLE_ARN }));
    // strict is the beforeEach default — the gate must block on the still-pending record.

    await expect(handler(activateEvent())).rejects.toThrow('Activation blocked');

    // The same-account IAM check is never attempted for a cross-account role.
    expect(mockComputeTrustPath).not.toHaveBeenCalled();

    // The crossAccount trust-path summary IS persisted (updateResource runs before
    // the gate throws), leaving the attestation 'pending' with a manual finding.
    const persisted = JSON.parse(mockUpdateResource.mock.calls[0][2].customMetadata);
    expect(persisted.governanceAttestation.status).toBe('pending');
    expect(persisted.governanceAttestation.trustPath.crossAccount).toBe(true);
    expect(persisted.governanceAttestation.trustPath.clean).toBe(false);
    expect(persisted.governanceAttestation.trustPath.findings).toEqual([
      'cross-account-role: automated trust-path unavailable; manual attestation required',
    ]);

    // Gated: the APPROVED status write never happened.
    expect(mockUpdateResourceStatus).not.toHaveBeenCalled();
  });

  test('REGRESSION: imported+pending+SAME-ACCOUNT roleArn (ACCOUNT_ID set) + clean → computeTrustPath runs and auto-attests', async () => {
    // Deployment account matches the role's account → NOT cross-account, so the
    // Phase-1 same-account path runs byte-identically.
    process.env.ACCOUNT_ID = '123456789012';
    mockGetResource
      .mockResolvedValueOnce(importedRecord({ roleArn: ROLE_ARN }))
      .mockResolvedValueOnce(approvedRecord());
    mockComputeTrustPath.mockResolvedValue({ hops: [], notes: [], findings: [], clean: true });

    await handler(activateEvent());

    expect(mockComputeTrustPath).toHaveBeenCalledWith(ROLE_ARN);
    const persisted = JSON.parse(mockUpdateResource.mock.calls[0][2].customMetadata);
    expect(persisted.governanceAttestation.status).toBe('attested');
    expect(persisted.governanceAttestation.attestedBy).toBe('system:trust-path');
    expect(persisted.governanceAttestation.trustPath.crossAccount).toBeUndefined();
    expect(mockUpdateResourceStatus).toHaveBeenCalledWith('agent', AGENT_ID, 'APPROVED');
  });

  // ─── Phase-2: CROSS-ACCOUNT FULL introspection via operator analysis role ───
  // When the invoke role is cross-account AND the operator supplied a read-only
  // analysisRoleArn, the resolver assumes that role (externalId-gated), builds a
  // cross-account IAM client, and runs computeTrustPath against it — then behaves
  // like the same-account success path (auto-attest clean / pending+findings).
  const ANALYSIS_ROLE_ARN = 'arn:aws:iam::123456789012:role/citadel-readonly-analysis';
  const EXTERNAL_ID = 'citadel-ext-xyz789';

  test('CROSS-ACCOUNT + analysisRoleArn + clean → assumes analysis role w/ ExternalId, computeTrustPath uses x-acct client, auto-attests (crossAccount summary)', async () => {
    process.env.ACCOUNT_ID = CROSS_ACCOUNT_DEPLOYMENT;
    const fakeIamClient = { __brand: 'x-acct-iam-client' };
    mockAssumeAnalysisRoleClient.mockResolvedValue(fakeIamClient);
    mockComputeTrustPath.mockResolvedValue({ hops: [], notes: [], findings: [], clean: true });
    mockGetResource
      .mockResolvedValueOnce(
        importedRecord({ roleArn: ROLE_ARN, analysisRoleArn: ANALYSIS_ROLE_ARN, externalId: EXTERNAL_ID }),
      )
      .mockResolvedValueOnce(approvedRecord());

    await handler(activateEvent());

    expect(mockAssumeAnalysisRoleClient).toHaveBeenCalledWith(ANALYSIS_ROLE_ARN, EXTERNAL_ID);
    expect(mockComputeTrustPath).toHaveBeenCalledWith(ROLE_ARN, { iamClient: fakeIamClient });
    const persisted = JSON.parse(mockUpdateResource.mock.calls[0][2].customMetadata);
    expect(persisted.governanceAttestation.status).toBe('attested');
    expect(persisted.governanceAttestation.attestedBy).toBe('system:trust-path');
    expect(persisted.governanceAttestation.attestedAt).toBeDefined();
    expect(persisted.governanceAttestation.trustPath.crossAccount).toBe(true);
    expect(persisted.governanceAttestation.trustPath.clean).toBe(true);
    expect(mockUpdateResourceStatus).toHaveBeenCalledWith('agent', AGENT_ID, 'APPROVED');
  });

  test('CROSS-ACCOUNT + analysisRoleArn + findings → stays pending with findings, strict gate blocks', async () => {
    process.env.ACCOUNT_ID = CROSS_ACCOUNT_DEPLOYMENT;
    mockAssumeAnalysisRoleClient.mockResolvedValue({ __brand: 'x-acct-iam-client' });
    mockComputeTrustPath.mockResolvedValue({
      hops: [],
      notes: [],
      findings: ['over-broad-action: arn:aws:iam::123456789012:role/imported-agent-role'],
      clean: false,
    });
    mockGetResource.mockResolvedValue(
      importedRecord({ roleArn: ROLE_ARN, analysisRoleArn: ANALYSIS_ROLE_ARN, externalId: EXTERNAL_ID }),
    );

    await expect(handler(activateEvent())).rejects.toThrow('Activation blocked');

    expect(mockAssumeAnalysisRoleClient).toHaveBeenCalledWith(ANALYSIS_ROLE_ARN, EXTERNAL_ID);
    expect(mockComputeTrustPath).toHaveBeenCalledWith(ROLE_ARN, { iamClient: expect.anything() });
    const persisted = JSON.parse(mockUpdateResource.mock.calls[0][2].customMetadata);
    expect(persisted.governanceAttestation.status).toBe('pending');
    expect(persisted.governanceAttestation.trustPath.crossAccount).toBe(true);
    expect(persisted.governanceAttestation.trustPath.clean).toBe(false);
    expect(persisted.governanceAttestation.trustPath.findings).toEqual([
      'over-broad-action: arn:aws:iam::123456789012:role/imported-agent-role',
    ]);
    expect(mockUpdateResourceStatus).not.toHaveBeenCalled();
  });

  test('CROSS-ACCOUNT + analysisRoleArn but assume THROWS → finding recorded, pending, NOT crashed (permissive proceeds), no computeTrustPath, creds not logged', async () => {
    process.env.ACCOUNT_ID = CROSS_ACCOUNT_DEPLOYMENT;
    mockGetGovernanceEnforce.mockResolvedValue('permissive');
    mockAssumeAnalysisRoleClient.mockRejectedValue(new Error('AccessDenied: not authorized to sts:AssumeRole'));
    mockGetResource
      .mockResolvedValueOnce(
        importedRecord({ roleArn: ROLE_ARN, analysisRoleArn: ANALYSIS_ROLE_ARN, externalId: EXTERNAL_ID }),
      )
      .mockResolvedValueOnce(approvedRecord());
    const errorSpy = jest.spyOn(console, 'error').mockImplementation(() => {});

    try {
      await expect(handler(activateEvent())).resolves.toBeDefined();

      expect(mockAssumeAnalysisRoleClient).toHaveBeenCalledWith(ANALYSIS_ROLE_ARN, EXTERNAL_ID);
      // Assume failed → introspection never attempted.
      expect(mockComputeTrustPath).not.toHaveBeenCalled();
      const persisted = JSON.parse(mockUpdateResource.mock.calls[0][2].customMetadata);
      expect(persisted.governanceAttestation.status).toBe('pending');
      expect(persisted.governanceAttestation.trustPath.crossAccount).toBe(true);
      expect(persisted.governanceAttestation.trustPath.clean).toBe(false);
      expect(persisted.governanceAttestation.trustPath.findings).toEqual([
        'cross-account analysis-role assume failed; manual attestation required',
      ]);
      // permissive gate proceeds (telemetry only), so activation still happens.
      expect(mockUpdateResourceStatus).toHaveBeenCalledWith('agent', AGENT_ID, 'APPROVED');
      // The externalId (and any creds, which never reach this scope) must never
      // appear in a log line.
      const logged = errorSpy.mock.calls
        .map((args) => args.map((a) => (typeof a === 'string' ? a : JSON.stringify(a))).join(' '))
        .join('\n');
      expect(logged).not.toContain(EXTERNAL_ID);
    } finally {
      errorSpy.mockRestore();
    }
  });
});
