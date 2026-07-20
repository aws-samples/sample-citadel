/**
 * Unit tests for `findAppBySourceProjectId` — the intakeCreateApp idempotency
 * lookup (triplicate-create fix).
 *
 * Contract:
 *  - Scans the AppsTable for the #META mirror row carrying the session's
 *    server-stamped `sourceProjectId`, scoped to the caller's org — NEVER a
 *    registry list-scan (the latency fix removed those from the create path).
 *  - Follows LastEvaluatedKey to exhaustion (Scan filters post-evaluation).
 *  - On a hit, returns the SAME registry-backed projection createApp returns
 *    (projectAgentAppNormalized), so an idempotent retry response is
 *    indistinguishable from the original create response.
 *  - Mirror hit whose registry record is gone (deleted app with a stale
 *    mirror) → null, so a fresh create proceeds.
 *  - No hit → null.
 */
process.env.REGISTRY_ID = 'test-registry-id';
process.env.APPS_TABLE = 'citadel-apps-test';
process.env.WORKFLOWS_TABLE = 'citadel-workflows-test';
process.env.AGENT_CONFIG_TABLE = 'citadel-agents-test';
process.env.EVENT_BUS_NAME = 'citadel-agents-test';
process.env.AWS_REGION = 'us-east-1';
delete process.env.AUTHORITY_UNITS_TABLE;

import { EventBridgeClient } from '@aws-sdk/client-eventbridge';
import { DynamoDBDocumentClient, ScanCommand } from '@aws-sdk/lib-dynamodb';
import { mockClient } from 'aws-sdk-client-mock';

const ebMock = mockClient(EventBridgeClient);
const ddbMock = mockClient(DynamoDBDocumentClient);

import { seedMockRegistry, resetMockRegistry } from './fixtures/registry-service-mock';

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

jest.mock('../../utils/appsync-publish', () => ({
  publishAppStatusEvent: jest.fn().mockResolvedValue(undefined),
}));

import { findAppBySourceProjectId } from '../registry-agent-record-resolver';
import { APP_META_SORT_VALUE } from '../../utils/apps-table-meta';

const SESSION_ID = 'sess-1111';
const ORG_ID = 'org-1';
const APP_ID = 'rec123456789';

function metaRow(overrides: Record<string, unknown> = {}): Record<string, unknown> {
  return {
    appId: APP_ID,
    sortId: APP_META_SORT_VALUE,
    orgId: ORG_ID,
    name: 'My App',
    status: 'DRAFT',
    sourceProjectId: SESSION_ID,
    ...overrides,
  };
}

function seedRegistryApp(): void {
  seedMockRegistry('agent', APP_ID, {
    name: 'My App',
    description: 'Desc',
    status: 'DRAFT',
    customDescriptorContent: JSON.stringify({
      appId: APP_ID,
      manifest: {
        orgId: ORG_ID,
        version: 1,
        status: 'DRAFT',
        createdBy: 'user-123',
        workflowIds: [],
        agentBindings: [{ agentId: 'agt000000001', status: 'READY' }],
        permissions: [],
        configSchema: null,
        configValues: null,
        authConfig: null,
        access: {},
        routingConfig: null,
        sourceProjectId: SESSION_ID,
      },
    }),
  });
}

describe('findAppBySourceProjectId', () => {
  beforeEach(() => {
    ddbMock.reset();
    ebMock.reset();
    resetMockRegistry();
  });

  test('scans the AppsTable mirror filtered on metadata rows + sourceProjectId + org', async () => {
    ddbMock.on(ScanCommand).resolves({ Items: [] });

    await findAppBySourceProjectId(SESSION_ID, ORG_ID);

    const calls = ddbMock.commandCalls(ScanCommand);
    expect(calls).toHaveLength(1);
    const input = calls[0].args[0].input;
    expect(input.TableName).toBe('citadel-apps-test');
    // Filter must pin all three: metadata row family, the session linkage,
    // and the caller's org (cross-org rows can never satisfy the guard).
    const values = Object.values(input.ExpressionAttributeValues ?? {});
    expect(values).toEqual(
      expect.arrayContaining([APP_META_SORT_VALUE, SESSION_ID, ORG_ID]),
    );
  });

  test('returns the registry-backed app projection on a mirror hit', async () => {
    seedRegistryApp();
    ddbMock.on(ScanCommand).resolves({ Items: [metaRow()] });

    const result = (await findAppBySourceProjectId(SESSION_ID, ORG_ID)) as Record<
      string,
      unknown
    > | null;

    expect(result).not.toBeNull();
    // Same normalization createApp returns: appId is the registry recordId,
    // and the manifest-backed fields (agentBindings) are present so the
    // Python client's "linked N agents" copy keeps working on a retry.
    expect(result).toMatchObject({
      appId: APP_ID,
      orgId: ORG_ID,
      status: 'DRAFT',
      sourceProjectId: SESSION_ID,
    });
    expect(result?.agentBindings).toEqual([{ agentId: 'agt000000001', status: 'READY' }]);
  });

  test('follows LastEvaluatedKey until the mirror row is found', async () => {
    seedRegistryApp();
    const lastKey = { appId: 'other-app' };
    ddbMock
      .on(ScanCommand)
      .resolvesOnce({ Items: [], LastEvaluatedKey: lastKey })
      .resolvesOnce({ Items: [metaRow()] });

    const result = await findAppBySourceProjectId(SESSION_ID, ORG_ID);

    const calls = ddbMock.commandCalls(ScanCommand);
    expect(calls).toHaveLength(2);
    expect(calls[0].args[0].input.ExclusiveStartKey).toBeUndefined();
    expect(calls[1].args[0].input.ExclusiveStartKey).toEqual(lastKey);
    expect(result).toMatchObject({ appId: APP_ID });
  });

  test('returns null when no mirror row matches', async () => {
    ddbMock.on(ScanCommand).resolves({ Items: [] });

    await expect(findAppBySourceProjectId(SESSION_ID, ORG_ID)).resolves.toBeNull();
  });

  test('returns null when the mirror row is stale (registry record deleted)', async () => {
    // deleteApp removes the registry record first and the mirror row
    // best-effort; a surviving mirror must not resurrect a deleted app —
    // a fresh create is the correct outcome.
    ddbMock.on(ScanCommand).resolves({ Items: [metaRow()] });

    await expect(findAppBySourceProjectId(SESSION_ID, ORG_ID)).resolves.toBeNull();
  });

  test('skips mirror rows without a usable appId', async () => {
    seedRegistryApp();
    ddbMock.on(ScanCommand).resolves({ Items: [metaRow({ appId: undefined }), metaRow()] });

    const result = await findAppBySourceProjectId(SESSION_ID, ORG_ID);

    expect(result).toMatchObject({ appId: APP_ID });
  });
});
