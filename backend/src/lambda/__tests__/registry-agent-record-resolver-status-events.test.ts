/**
 * Unit tests for EventBridge + AppSync status-transition emissions on the
 * registry-native resolver. PR 6a replacement for:
 *   - agent-app-shim-status-events.test.ts
 *   - agent-app-shim-archive-transition.test.ts
 *   - agent-app-shim-archived-to-draft.test.ts
 * plus the `publishAppStatusEvent` IAM-authed passthrough from
 * agent-app-shim-resolver.test.ts.
 */

process.env.REGISTRY_ID = 'test-registry-id';
process.env.APPS_TABLE = 'citadel-apps-test';
process.env.WORKFLOWS_TABLE = 'citadel-workflows-test';
process.env.AGENT_CONFIG_TABLE = 'citadel-agents-test';
process.env.EVENT_BUS_NAME = 'citadel-agents-test';
process.env.USER_POOL_ID = 'us-east-1_test';
process.env.AUTHORITY_UNITS_TABLE = 'test-authority-units';
process.env.APPSYNC_ENDPOINT = 'https://test-api.appsync-api.us-east-1.amazonaws.com/graphql';
process.env.AWS_REGION = 'us-east-1';

import { EventBridgeClient, PutEventsCommand } from '@aws-sdk/client-eventbridge';
import { mockClient } from 'aws-sdk-client-mock';

const ebMock = mockClient(EventBridgeClient);

import {
  seedMockRegistry,
  resetMockRegistry,
} from './fixtures/registry-service-mock';

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

const mockPublishAppStatusEvent = jest.fn().mockResolvedValue({});
jest.mock('../../utils/appsync-publish', () => ({
  publishAppStatusEvent: mockPublishAppStatusEvent,
}));

jest.mock('uuid', () => ({
  v4: jest.fn().mockReturnValue('test-correlation-id'),
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
    info: { fieldName },
    arguments: args,
    identity: { sub: 'user-123', claims: { sub: 'user-123' } },
  } as unknown as HandlerEvent;
}

function seedApp(status: string, version: number = 1, orgId: string = 'org-1') {
  seedMockRegistry('agent', 'app-1', {
    name: 'Test App',
    description: 'Test',
    status,
    customDescriptorContent: JSON.stringify({
      appId: 'app-1',
      manifest: {
        orgId,
        version,
        status,
        workflowIds: [],
        agentBindings: [],
        permissions: [],
        configSchema: null,
        configValues: null,
        authConfig: null,
        access: {},
        routingConfig: null,
      },
    }),
  });
}

describe('registry-agent-record-resolver — status transition events', () => {
  beforeEach(() => {
    resetMockRegistry();
    ebMock.reset();
    mockPublishAppStatusEvent.mockClear();
    ebMock.on(PutEventsCommand).resolves({});
  });

  afterAll(() => {
    delete process.env.APPS_TABLE;
    delete process.env.WORKFLOWS_TABLE;
    delete process.env.AGENT_CONFIG_TABLE;
    delete process.env.EVENT_BUS_NAME;
    delete process.env.USER_POOL_ID;
    delete process.env.APPSYNC_ENDPOINT;
    delete process.env.AWS_REGION;
    delete process.env.REGISTRY_ID;
    delete process.env.AUTHORITY_UNITS_TABLE;
  });

  test('emits app.status.draft_to_approved on DRAFT→APPROVED transition', async () => {
    seedApp('DRAFT', 1);

    await invokeHandler(
      makeEvent('updateApp', {
        input: { appId: 'app-1', status: 'APPROVED', version: 1 },
      }),
    );

    const ebCalls = ebMock.commandCalls(PutEventsCommand);
    const allEntries = ebCalls.flatMap((c) => c.args[0].input.Entries || []);
    const statusEvent = allEntries.find(
      (e) => e?.DetailType === 'app.status.draft_to_approved',
    );

    expect(statusEvent).toBeDefined();
    expect(statusEvent!.Source).toBe('citadel.apps');
    expect(statusEvent!.EventBusName).toBe('citadel-agents-test');

    const detail = JSON.parse(statusEvent!.Detail!);
    expect(detail.appId).toBe('app-1');
    expect(detail.orgId).toBe('org-1');
    expect(detail.previousStatus).toBe('DRAFT');
    expect(detail.newStatus).toBe('APPROVED');
    expect(detail.userId).toBe('user-123');
    expect(detail.timestamp).toBeDefined();
    expect(detail.correlationId).toBe('test-correlation-id');
  });

  test('emits app.status.approved_to_deprecated on APPROVED→DEPRECATED transition', async () => {
    seedApp('APPROVED', 1);

    await invokeHandler(
      makeEvent('updateApp', {
        input: { appId: 'app-1', status: 'DEPRECATED', version: 1 },
      }),
    );

    const ebCalls = ebMock.commandCalls(PutEventsCommand);
    const allEntries = ebCalls.flatMap((c) => c.args[0].input.Entries || []);
    const statusEvent = allEntries.find(
      (e) => e?.DetailType === 'app.status.approved_to_deprecated',
    );

    expect(statusEvent).toBeDefined();
    const detail = JSON.parse(statusEvent!.Detail!);
    expect(detail.previousStatus).toBe('APPROVED');
    expect(detail.newStatus).toBe('DEPRECATED');
  });

  test('emits app.status.deprecated_to_draft on DEPRECATED→DRAFT transition', async () => {
    seedApp('DEPRECATED', 3);

    await invokeHandler(
      makeEvent('updateApp', {
        input: { appId: 'app-1', status: 'DRAFT', version: 3 },
      }),
    );

    const ebCalls = ebMock.commandCalls(PutEventsCommand);
    const allEntries = ebCalls.flatMap((c) => c.args[0].input.Entries || []);
    const statusEvent = allEntries.find(
      (e) => e?.DetailType === 'app.status.deprecated_to_draft',
    );

    expect(statusEvent).toBeDefined();
    const detail = JSON.parse(statusEvent!.Detail!);
    expect(detail.previousStatus).toBe('DEPRECATED');
    expect(detail.newStatus).toBe('DRAFT');
  });

  test('status event timestamp is valid ISO 8601', async () => {
    seedApp('DEPRECATED', 3);

    await invokeHandler(
      makeEvent('updateApp', {
        input: { appId: 'app-1', status: 'DRAFT', version: 3 },
      }),
    );

    const ebCalls = ebMock.commandCalls(PutEventsCommand);
    const allEntries = ebCalls.flatMap((c) => c.args[0].input.Entries || []);
    const statusEvent = allEntries.find(
      (e) => e?.DetailType === 'app.status.deprecated_to_draft',
    );
    const detail = JSON.parse(statusEvent!.Detail!);

    const parsed = new Date(detail.timestamp);
    expect(parsed.toISOString()).toBe(detail.timestamp);
  });

  test('does not emit status transition event for non-status updates', async () => {
    seedApp('DRAFT', 1);

    await invokeHandler(
      makeEvent('updateApp', {
        input: { appId: 'app-1', name: 'Updated Name', version: 1 },
      }),
    );

    const ebCalls = ebMock.commandCalls(PutEventsCommand);
    const allEntries = ebCalls.flatMap((c) => c.args[0].input.Entries || []);
    const statusEvents = allEntries.filter((e) =>
      e?.DetailType?.startsWith('app.status.'),
    );
    expect(statusEvents.length).toBe(0);
  });

  test('does not emit status transition event when status is unchanged', async () => {
    seedApp('DRAFT', 1);

    await invokeHandler(
      makeEvent('updateApp', {
        input: { appId: 'app-1', status: 'DRAFT', name: 'Updated', version: 1 },
      }),
    );

    const ebCalls = ebMock.commandCalls(PutEventsCommand);
    const allEntries = ebCalls.flatMap((c) => c.args[0].input.Entries || []);
    const statusEvents = allEntries.filter((e) =>
      e?.DetailType?.startsWith('app.status.'),
    );
    expect(statusEvents.length).toBe(0);
  });

  test('calls publishAppStatusEvent for DRAFT→APPROVED transition', async () => {
    seedApp('DRAFT', 1);

    await invokeHandler(
      makeEvent('updateApp', {
        input: { appId: 'app-1', status: 'APPROVED', version: 1 },
      }),
    );

    expect(mockPublishAppStatusEvent).toHaveBeenCalledTimes(1);
    expect(mockPublishAppStatusEvent).toHaveBeenCalledWith(
      expect.objectContaining({
        appId: 'app-1',
        previousStatus: 'DRAFT',
        newStatus: 'APPROVED',
        timestamp: expect.any(String),
      }),
    );
  });

  test('does not call publishAppStatusEvent for non-status updates', async () => {
    seedApp('DRAFT', 1);

    await invokeHandler(
      makeEvent('updateApp', {
        input: { appId: 'app-1', name: 'Updated Name', version: 1 },
      }),
    );

    expect(mockPublishAppStatusEvent).not.toHaveBeenCalled();
  });

  test('does not fail updateApp if publishAppStatusEvent throws', async () => {
    mockPublishAppStatusEvent.mockRejectedValueOnce(new Error('AppSync unreachable'));

    seedApp('DEPRECATED', 3);

    const result = await invokeHandler(
      makeEvent('updateApp', {
        input: { appId: 'app-1', status: 'DRAFT', version: 3 },
      }),
    );

    expect(result).toBeDefined();
    expect(result.appId).toBe('app-1');
  });

  test('publishAppStatusEvent mutation emits app.status.published and echoes payload', async () => {
    const input = {
      appId: 'app-xyz',
      previousStatus: 'DRAFT',
      newStatus: 'APPROVED',
      timestamp: '2025-05-08T10:00:00.000Z',
    };

    const result = await invokeHandler(
      makeEvent('publishAppStatusEvent', { input }),
    );

    expect(result).toEqual(input);
    const entries = ebMock
      .commandCalls(PutEventsCommand)
      .flatMap((c) => c.args[0].input.Entries || []);
    const published = entries.find(
      (e) => e?.DetailType === 'app.status.published',
    );
    expect(published).toBeDefined();
    expect(published!.Source).toBe('citadel.apps');
  });
});
