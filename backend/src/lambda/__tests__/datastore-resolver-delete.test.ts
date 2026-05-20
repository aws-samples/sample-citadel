/**
 * TDD Tests for datastore-resolver deleteDataStore
 *
 * Verifies that deleting a provisioned data store calls adapter.deprovision()
 * to clean up the underlying infrastructure.
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
  requiredPolicies: jest.fn().mockReturnValue({ provision: [], connect: [] }),
  provision: jest.fn().mockResolvedValue({ resourceArn: 'arn:aws:s3:::test-bucket' }),
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

describe('deleteDataStore - infrastructure cleanup', () => {
  beforeEach(() => {
    jest.clearAllMocks();
  });

  const makeDeleteEvent = (dataStoreId: string) => ({
    info: { fieldName: 'deleteDataStore' },
    arguments: { dataStoreId },
    identity: { username: 'test-user' },
  });

  test('calls adapter.deprovision for CREATE_NEW data stores', async () => {
    // Mock getDataStore returning a provisioned store
    mockDynamoSend.mockResolvedValueOnce({
      Item: {
        dataStoreId: 'ds-123',
        type: 'S3',
        status: 'CONNECTED',
        provisionMode: 'CREATE_NEW',
        config: JSON.stringify({ bucketName: 'my-bucket' }),
        secretArn: 'arn:aws:secretsmanager:us-east-1:123:secret:test',
        version: 1,
      },
    });
    // Mock delete operations
    mockDynamoSend.mockResolvedValue({});
    mockSecretsSend.mockResolvedValue({});

    const result = await handler(makeDeleteEvent('ds-123') as any);

    expect(result.success).toBe(true);
    expect(mockAdapter.deprovision).toHaveBeenCalledWith(
      { bucketName: 'my-bucket' },
      expect.anything()
    );
  });

  test('does NOT call adapter.deprovision for CONNECT_EXISTING data stores', async () => {
    mockDynamoSend.mockResolvedValueOnce({
      Item: {
        dataStoreId: 'ds-456',
        type: 'S3',
        status: 'CONNECTED',
        provisionMode: 'CONNECT_EXISTING',
        config: JSON.stringify({ bucketName: 'existing-bucket' }),
        secretArn: 'arn:aws:secretsmanager:us-east-1:123:secret:test',
        version: 1,
      },
    });
    mockDynamoSend.mockResolvedValue({});
    mockSecretsSend.mockResolvedValue({});

    const result = await handler(makeDeleteEvent('ds-456') as any);

    expect(result.success).toBe(true);
    expect(mockAdapter.deprovision).not.toHaveBeenCalled();
  });

  test('calls adapter.disconnect before deprovision', async () => {
    const callOrder: string[] = [];
    mockAdapter.disconnect.mockImplementation(async () => { callOrder.push('disconnect'); });
    mockAdapter.deprovision.mockImplementation(async () => { callOrder.push('deprovision'); });

    mockDynamoSend.mockResolvedValueOnce({
      Item: {
        dataStoreId: 'ds-789',
        type: 'S3',
        status: 'CONNECTED',
        provisionMode: 'CREATE_NEW',
        config: JSON.stringify({ bucketName: 'bucket' }),
        version: 1,
      },
    });
    mockDynamoSend.mockResolvedValue({});
    mockSecretsSend.mockResolvedValue({});

    await handler(makeDeleteEvent('ds-789') as any);

    expect(callOrder).toEqual(['disconnect', 'deprovision']);
  });

  test('continues deletion even if deprovision fails', async () => {
    mockAdapter.deprovision.mockRejectedValueOnce(new Error('deprovision failed'));

    mockDynamoSend.mockResolvedValueOnce({
      Item: {
        dataStoreId: 'ds-fail',
        type: 'S3',
        status: 'CONNECTED',
        provisionMode: 'CREATE_NEW',
        config: JSON.stringify({ bucketName: 'bucket' }),
        version: 1,
      },
    });
    mockDynamoSend.mockResolvedValue({});
    mockSecretsSend.mockResolvedValue({});

    const result = await handler(makeDeleteEvent('ds-fail') as any);

    // Should still succeed — deprovision failure is non-fatal
    expect(result.success).toBe(true);
  });
});
