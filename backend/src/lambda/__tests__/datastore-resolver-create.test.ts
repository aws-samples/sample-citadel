/**
 * TDD Tests for datastore-resolver createDataStore
 *
 * Verifies that the resolver properly enriches the config with the
 * data store name before passing it to the adapter, so adapters that
 * use generic config fields (resourceName) can derive the resource name.
 */

// ---- Mock setup ----
const mockDynamoSend = jest.fn();
jest.mock('@aws-sdk/client-dynamodb', () => ({
  DynamoDBClient: jest.fn().mockImplementation(() => ({})),
}));
jest.mock('@aws-sdk/lib-dynamodb', () => {
  const actual = jest.requireActual('@aws-sdk/lib-dynamodb');
  return {
    ...actual,
    DynamoDBDocumentClient: {
      from: jest.fn().mockReturnValue({ send: mockDynamoSend }),
    },
    PutCommand: jest.fn().mockImplementation((input) => ({ _type: 'Put', input })),
    GetCommand: jest.fn().mockImplementation((input) => ({ _type: 'Get', input })),
    UpdateCommand: jest.fn().mockImplementation((input) => ({ _type: 'Update', input })),
    DeleteCommand: jest.fn().mockImplementation((input) => ({ _type: 'Delete', input })),
    QueryCommand: jest.fn().mockImplementation((input) => ({ _type: 'Query', input })),
  };
});

const mockSecretsSend = jest.fn();
jest.mock('@aws-sdk/client-secrets-manager', () => ({
  SecretsManagerClient: jest.fn().mockImplementation(() => ({ send: mockSecretsSend })),
  CreateSecretCommand: jest.fn().mockImplementation((input) => ({ _type: 'CreateSecret', input })),
  GetSecretValueCommand: jest.fn().mockImplementation((input) => ({ _type: 'GetSecretValue', input })),
  DeleteSecretCommand: jest.fn().mockImplementation((input) => ({ _type: 'DeleteSecret', input })),
}));

const mockAdapter = {
  category: 'datastore' as const,
  spec: { type: 'KNOWLEDGE_BASE', provider: 'AWS', category: 'datastore' as const, authentication: { method: 'IAM_ROLE', fields: [], secretStructure: {} }, configuration: { required: [], optional: [], ssmParameters: [] } },
  requiredPolicies: jest.fn().mockReturnValue({ provision: [], connect: [] }),
  provision: jest.fn().mockResolvedValue({ resourceArn: 'arn:aws:bedrock:us-east-1:123:knowledge-base/KB1' }),
  connect: jest.fn().mockResolvedValue(undefined),
  disconnect: jest.fn().mockResolvedValue(undefined),
  deprovision: jest.fn().mockResolvedValue(undefined),
  testConnection: jest.fn().mockResolvedValue({ success: true, message: 'OK' }),
  getMetrics: jest.fn().mockResolvedValue({ size: '0 MB', records: 0 }),
};
jest.mock('../adapters/registry', () => ({
  getAdapter: jest.fn().mockReturnValue(mockAdapter),
}));

const mockPolicyManager = {
  getAccountContext: jest.fn().mockResolvedValue({ accountId: '123456789012', region: 'us-east-1' }),
  ensureRole: jest.fn().mockResolvedValue(undefined),
  assumeScopedRole: jest.fn().mockResolvedValue({
    accessKeyId: 'AKID', secretAccessKey: 'SECRET', sessionToken: 'TOKEN',
  }),
  deleteRole: jest.fn().mockResolvedValue(undefined),
};
jest.mock('../../utils/policy-manager', () => ({
  PolicyManager: jest.fn().mockImplementation(() => mockPolicyManager),
}));

jest.mock('uuid', () => ({ v4: jest.fn().mockReturnValue('test-uuid') }));

process.env.DATASTORES_TABLE = 'TestDataStoresTable';

import { handler } from '../datastore-resolver';

describe('createDataStore - config enrichment', () => {
  beforeEach(() => {
    jest.clearAllMocks();
    // Default: QueryCommand returns empty (no idempotent match)
    // PutCommand succeeds, UpdateCommand succeeds
    mockDynamoSend.mockImplementation((cmd: any) => {
      if (cmd._type === 'Query') return Promise.resolve({ Items: [] });
      if (cmd._type === 'Put') return Promise.resolve({});
      if (cmd._type === 'Update') return Promise.resolve({ Attributes: { dataStoreId: 'test-uuid', status: 'CONNECTED', version: 1 } });
      return Promise.resolve({});
    });
  });

  const makeCreateEvent = (input: Record<string, any>) => ({
    info: { fieldName: 'createDataStore' },
    arguments: { input },
    identity: { username: 'test-user' },
  });

  test('injects input.name into config as name field for CREATE_NEW', async () => {
    const event = makeCreateEvent({
      name: 'og-test-kb',
      type: 'KNOWLEDGE_BASE',
      category: 'KNOWLEDGE_BASE',
      provisionMode: 'CREATE_NEW',
      orgId: 'org-test',
      config: JSON.stringify({ resourceName: 'og-test-kb' }),
      clientRequestToken: 'tok-123',
    });

    await handler(event as any);

    // The adapter.provision should receive config with name field set
    expect(mockAdapter.provision).toHaveBeenCalledTimes(1);
    const provisionConfig = mockAdapter.provision.mock.calls[0][0];
    expect(provisionConfig.name).toBe('og-test-kb');
  });

  test('does not overwrite existing config.name with input.name', async () => {
    const event = makeCreateEvent({
      name: 'display-name',
      type: 'KNOWLEDGE_BASE',
      category: 'KNOWLEDGE_BASE',
      provisionMode: 'CREATE_NEW',
      orgId: 'org-test',
      config: JSON.stringify({ name: 'explicit-config-name', resourceName: 'rn' }),
      clientRequestToken: 'tok-456',
    });

    await handler(event as any);

    const provisionConfig = mockAdapter.provision.mock.calls[0][0];
    // Existing config.name should be preserved
    expect(provisionConfig.name).toBe('explicit-config-name');
  });

  test('injects input.name into config for CONNECT_EXISTING too', async () => {
    const event = makeCreateEvent({
      name: 'my-existing-store',
      type: 'S3',
      category: 'S3_STORAGE',
      provisionMode: 'CONNECT_EXISTING',
      orgId: 'org-test',
      config: JSON.stringify({ bucketName: 'my-bucket' }),
      clientRequestToken: 'tok-789',
    });

    await handler(event as any);

    expect(mockAdapter.connect).toHaveBeenCalledTimes(1);
    const connectConfig = mockAdapter.connect.mock.calls[0][0];
    expect(connectConfig.name).toBe('my-existing-store');
  });
});
