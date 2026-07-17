/**
 * Unit tests for registry-native resolver API-key surfaces.
 * PR 6a — replaces `agent-app-shim-apikey-response.test.ts`.
 *
 * The 4 api-key handler branches delegate to helpers in
 * `./app-api-key-management`. We mock those helpers so assertions focus
 * on the resolver's response-shape flattening (AppApiKey /
 * AppApiKeyWithPlaintext) rather than on the underlying DDB behaviour
 * (that is covered by app-api-key-management.test.ts).
 */

process.env.REGISTRY_ID = 'test-registry-id';
process.env.APPS_TABLE = 'test-apps';
process.env.WORKFLOWS_TABLE = 'test-workflows';
process.env.AGENT_CONFIG_TABLE = 'test-agents';
process.env.EVENT_BUS_NAME = 'test-bus';
process.env.USER_POOL_ID = 'us-east-1_test';
process.env.AUTHORITY_UNITS_TABLE = 'test-authority-units';

import { EventBridgeClient, PutEventsCommand } from '@aws-sdk/client-eventbridge';
import { mockClient } from 'aws-sdk-client-mock';

const ebMock = mockClient(EventBridgeClient);

import { resetMockRegistry } from './fixtures/registry-service-mock';

jest.mock('../../services/registry-service', () => {
  const { getMockRegistryService } = jest.requireActual('./fixtures/registry-service-mock');
  return {
    RegistryService: jest.fn().mockImplementation(() => getMockRegistryService()),
    getRegistryService: jest.fn(() => getMockRegistryService()),
    _resetRegistryService: jest.fn(),
    isRegistryEnabled: jest.fn(() => true),
  };
});

jest.mock('../../utils/appsync', () => ({
  getUserId: jest.fn().mockReturnValue('user-123'),
}));

const mockCreate = jest.fn();
const mockRevoke = jest.fn();
const mockRotate = jest.fn();
const mockList = jest.fn();
jest.mock('../app-api-key-management', () => ({
  createAppApiKey: (...args: unknown[]) => mockCreate(...args),
  revokeAppApiKey: (...args: unknown[]) => mockRevoke(...args),
  rotateAppApiKey: (...args: unknown[]) => mockRotate(...args),
  listAppApiKeys: (...args: unknown[]) => mockList(...args),
}));

import { handler } from '../registry-agent-record-resolver';

type HandlerEvent = Parameters<typeof handler>[0];

// aws-lambda's Handler type declares legacy required context and callback
// parameters, but the implementation is a one-parameter async (event)
// function that never uses them — invoke through the real signature
// (single cast here) so calls don't pass superfluous arguments.
const invokeHandler = handler as (event: HandlerEvent) => Promise<unknown>;

function makeEvent(fieldName: string, args: Record<string, unknown>) {
  return {
    info: { fieldName, parentTypeName: 'Mutation', selectionSetList: [] },
    arguments: args,
    identity: { sub: 'user-1', claims: {} },
    source: null,
    request: { headers: {} },
    prev: null,
    stash: {},
  } as unknown as HandlerEvent;
}

describe('registry-agent-record-resolver — API key surfaces', () => {
  beforeEach(() => {
    resetMockRegistry();
    ebMock.reset();
    ebMock.on(PutEventsCommand).resolves({});
    mockCreate.mockReset();
    mockRevoke.mockReset();
    mockRotate.mockReset();
    mockList.mockReset();
  });

  test('createAppApiKey returns flat AppApiKeyWithPlaintext with apiKey field', async () => {
    mockCreate.mockResolvedValueOnce({
      keyId: 'new-key-id',
      name: 'Test Key',
      prefix: 'abcd1234',
      status: 'ACTIVE',
      createdAt: '2025-05-08T00:00:00Z',
      expiresAt: undefined,
      plaintext: 'plaintext-secret-abcdef',
    });

    const result = await invokeHandler(
      makeEvent('createAppApiKey', { appId: 'app-1', name: 'Test Key' }),
    );

    expect(result).toHaveProperty('keyId', 'new-key-id');
    expect(result).toHaveProperty('name', 'Test Key');
    expect(result).toHaveProperty('prefix', 'abcd1234');
    expect(result).toHaveProperty('status', 'ACTIVE');
    expect(result).toHaveProperty('createdAt');
    expect(result).toHaveProperty('apiKey', 'plaintext-secret-abcdef');
    // Shape contract: plaintext is flattened into apiKey; no leaking internals.
    expect(result).not.toHaveProperty('plaintext');
    expect(result).not.toHaveProperty('hashedKey');
  });

  test('rotateAppApiKey returns flat response (not {newKey, revokedKeyId})', async () => {
    mockRotate.mockResolvedValueOnce({
      newKey: {
        keyId: 'new-key',
        name: 'Existing Key',
        prefix: 'efgh5678',
        status: 'ACTIVE',
        createdAt: '2025-05-08T00:00:00Z',
        plaintext: 'new-plaintext',
      },
      revokedKeyId: 'old-key',
    });

    const result = await invokeHandler(
      makeEvent('rotateAppApiKey', { appId: 'app-1', keyId: 'old-key' }),
    );

    expect(result).not.toHaveProperty('newKey');
    expect(result).not.toHaveProperty('revokedKeyId');
    expect(result).toHaveProperty('keyId', 'new-key');
    expect(result).toHaveProperty('name', 'Existing Key');
    expect(result).toHaveProperty('apiKey', 'new-plaintext');
  });

  test('revokeAppApiKey passes through the helper result unchanged', async () => {
    const revokedKey = {
      keyId: 'target-key',
      name: 'Old Key',
      prefix: 'ijkl9012',
      status: 'REVOKED',
      createdAt: '2025-01-01T00:00:00Z',
      expiresAt: null,
      lastUsedAt: null,
    };
    mockRevoke.mockResolvedValueOnce(revokedKey);

    const result = await invokeHandler(
      makeEvent('revokeAppApiKey', { appId: 'app-1', keyId: 'target-key' }),
    );

    expect(result).toEqual(revokedKey);
    expect(mockRevoke).toHaveBeenCalledWith(
      'app-1',
      'target-key',
      'user-123',
      expect.objectContaining({ appsTable: 'test-apps' }),
    );
  });

  test('listAppApiKeys items have no apiKey field', async () => {
    mockList.mockResolvedValueOnce([
      { keyId: 'k1', name: 'Key 1', prefix: 'aaaa1111', status: 'ACTIVE', createdAt: '2024-01-01T00:00:00Z' },
      { keyId: 'k2', name: 'Key 2', prefix: 'bbbb2222', status: 'REVOKED', createdAt: '2024-02-01T00:00:00Z' },
    ]);

    const result = await invokeHandler(
      makeEvent('listAppApiKeys', { appId: 'app-1' }),
    );

    expect(Array.isArray(result)).toBe(true);
    expect(result.length).toBe(2);
    for (const key of result) {
      expect(key).toHaveProperty('keyId');
      expect(key).toHaveProperty('name');
      expect(key).toHaveProperty('prefix');
      expect(key).toHaveProperty('status');
      expect(key).not.toHaveProperty('apiKey');
      expect(key).not.toHaveProperty('plaintext');
      expect(key).not.toHaveProperty('hashedKey');
    }
  });

  test('createAppApiKey forwards appId, name, userId, deps, expiresIn to impl', async () => {
    mockCreate.mockResolvedValueOnce({
      keyId: 'k',
      name: 'K',
      prefix: 'pppp1234',
      status: 'ACTIVE',
      createdAt: '2025-05-08T00:00:00Z',
      plaintext: 'pt',
    });

    await invokeHandler(
      makeEvent('createAppApiKey', { appId: 'app-9', name: 'K', expiresIn: 3600 }),
    );

    expect(mockCreate).toHaveBeenCalledWith(
      'app-9',
      'K',
      'user-123',
      expect.objectContaining({ appsTable: 'test-apps' }),
      3600,
    );
  });

  test('listAppApiKeys invokes impl with deps struct (no mutation of args)', async () => {
    mockList.mockResolvedValueOnce([]);

    await invokeHandler(
      makeEvent('listAppApiKeys', { appId: 'app-42' }),
    );

    expect(mockList).toHaveBeenCalledTimes(1);
    const call = mockList.mock.calls[0];
    expect(call[0]).toBe('app-42');
    expect(call[1]).toEqual(expect.objectContaining({ appsTable: 'test-apps' }));
  });
});
