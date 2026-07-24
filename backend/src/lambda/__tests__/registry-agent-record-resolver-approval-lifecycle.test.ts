/**
 * Approval lifecycle gate tests for registry-agent-record-resolver's
 * updateApp mutation:
 *   - no auto-approval regression (submit leaves the record PENDING_APPROVAL)
 *   - full REGISTRY_TRANSITIONS matrix (every legal + representative illegal)
 *   - pending-immutability (content edits rejected while PENDING_APPROVAL)
 *   - statusReason required on REJECTED
 *   - approve/reject is admin-only (role gating)
 *   - decidedBy is always server-derived, never from client input
 *   - REJECTED -> DRAFT resubmit path works and clears the prior decision
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
  getMockRegistryService,
} from './fixtures/registry-service-mock';

jest.mock('../../services/registry-service', () => {
  const { getMockRegistryService } = jest.requireActual('./fixtures/registry-service-mock');
  const actual = jest.requireActual('../../services/registry-service');
  return {
    RegistryService: jest.fn().mockImplementation(() => getMockRegistryService()),
    getRegistryService: jest.fn(() => getMockRegistryService()),
    _resetRegistryService: jest.fn(),
    isRegistryEnabled: jest.fn(() => true),
    TypeMismatchError: actual.TypeMismatchError,
    RegistryLifecycleError: actual.RegistryLifecycleError,
    RegistryRecordStatusValues: actual.RegistryRecordStatusValues,
  };
});

jest.mock('../../utils/appsync', () => ({
  getUserId: jest.fn((identity: { sub?: string; claims?: { sub?: string } }) =>
    identity?.sub || identity?.claims?.sub || 'anonymous',
  ),
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
const invokeHandler = handler as (event: HandlerEvent) => Promise<unknown>;

function makeEvent(fieldName: string, args: Record<string, unknown>, admin = false) {
  return {
    info: { fieldName },
    arguments: args,
    identity: admin
      ? { sub: 'admin-1', claims: { sub: 'admin-1', 'custom:role': 'admin' }, 'custom:role': 'admin' }
      : { sub: 'user-123', claims: { sub: 'user-123' } },
  } as unknown as HandlerEvent;
}

function seedApp(
  status: string,
  version = 1,
  orgId = 'org-1',
  manifestExtra: Record<string, unknown> = {},
) {
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
        ...manifestExtra,
      },
    }),
  });
}

describe('registry-agent-record-resolver — approval lifecycle gate', () => {
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

  // -- Regression: submit must leave the record PENDING_APPROVAL ----------

  describe('no auto-approval regression', () => {
    it('DRAFT -> PENDING_APPROVAL (submit) leaves the record PENDING_APPROVAL, not APPROVED', async () => {
      seedApp('DRAFT', 1);

      const result = (await invokeHandler(
        makeEvent('updateApp', {
          input: { appId: 'app-1', status: 'PENDING_APPROVAL', version: 1 },
        }),
      )) as Record<string, unknown>;

      expect(result.status).toBe('PENDING_APPROVAL');
      const persisted = await getMockRegistryService().getResource('agent', 'app-1');
      expect(persisted?.status).toBe('PENDING_APPROVAL');
    });
  });

  // -- Full transition matrix ----------------------------------------------

  describe('legal transitions', () => {
    it.each([
      ['DRAFT', 'PENDING_APPROVAL', false],
      ['DRAFT', 'DEPRECATED', false],
      ['PENDING_APPROVAL', 'APPROVED', true],
      ['PENDING_APPROVAL', 'REJECTED', true],
      ['REJECTED', 'DRAFT', false],
      ['REJECTED', 'DEPRECATED', false],
      ['APPROVED', 'DEPRECATED', false],
    ])('%s -> %s succeeds', async (current, next, admin) => {
      seedApp(current, 1);
      const input: Record<string, unknown> = { appId: 'app-1', status: next, version: 1 };
      if (next === 'REJECTED') input.statusReason = 'does not meet policy';

      const result = (await invokeHandler(
        makeEvent('updateApp', { input }, admin as boolean),
      )) as Record<string, unknown>;

      expect(result.status).toBe(next);
    });
  });

  describe('illegal transitions are rejected with a structured error', () => {
    it.each([
      ['DRAFT', 'APPROVED'],
      ['DRAFT', 'REJECTED'],
      ['APPROVED', 'DRAFT'],
      ['APPROVED', 'PENDING_APPROVAL'],
      ['DEPRECATED', 'DRAFT'],
      ['PENDING_APPROVAL', 'DRAFT'],
    ])('%s -> %s throws INVALID_TRANSITION', async (current, next) => {
      seedApp(current, 1);

      await expect(
        invokeHandler(
          makeEvent(
            'updateApp',
            { input: { appId: 'app-1', status: next, version: 1, statusReason: 'x' } },
            true,
          ),
        ),
      ).rejects.toMatchObject({ code: 'INVALID_TRANSITION' });
    });
  });

  // -- Pending-immutability -------------------------------------------------

  describe('pending-immutability', () => {
    it('rejects a content update (name) while PENDING_APPROVAL', async () => {
      seedApp('PENDING_APPROVAL', 1);

      await expect(
        invokeHandler(
          makeEvent('updateApp', { input: { appId: 'app-1', name: 'New Name', version: 1 } }),
        ),
      ).rejects.toMatchObject({ code: 'RECORD_IMMUTABLE' });
    });

    it('rejects a description update while PENDING_APPROVAL', async () => {
      seedApp('PENDING_APPROVAL', 1);

      await expect(
        invokeHandler(
          makeEvent('updateApp', {
            input: { appId: 'app-1', description: 'changed', version: 1 },
          }),
        ),
      ).rejects.toMatchObject({ code: 'RECORD_IMMUTABLE' });
    });

    it('allows a status-only decision (approve) while PENDING_APPROVAL', async () => {
      seedApp('PENDING_APPROVAL', 1);

      const result = (await invokeHandler(
        makeEvent(
          'updateApp',
          { input: { appId: 'app-1', status: 'APPROVED', version: 1 } },
          true,
        ),
      )) as Record<string, unknown>;

      expect(result.status).toBe('APPROVED');
    });
  });

  // -- statusReason required on reject -------------------------------------

  describe('reject requires statusReason', () => {
    it('rejects REJECTED with no statusReason', async () => {
      seedApp('PENDING_APPROVAL', 1);

      await expect(
        invokeHandler(
          makeEvent('updateApp', { input: { appId: 'app-1', status: 'REJECTED', version: 1 } }, true),
        ),
      ).rejects.toThrow(/statusReason is required/);
    });

    it('rejects REJECTED with a blank/whitespace statusReason', async () => {
      seedApp('PENDING_APPROVAL', 1);

      await expect(
        invokeHandler(
          makeEvent(
            'updateApp',
            { input: { appId: 'app-1', status: 'REJECTED', version: 1, statusReason: '   ' } },
            true,
          ),
        ),
      ).rejects.toThrow(/statusReason is required/);
    });

    it('accepts REJECTED with a non-empty statusReason and persists it', async () => {
      seedApp('PENDING_APPROVAL', 1);

      const result = (await invokeHandler(
        makeEvent(
          'updateApp',
          { input: { appId: 'app-1', status: 'REJECTED', version: 1, statusReason: 'missing tests' } },
          true,
        ),
      )) as Record<string, unknown>;

      expect(result.status).toBe('REJECTED');
      expect(result.statusReason).toBe('missing tests');
    });
  });

  // -- Role gating: approve/reject is admin-only ---------------------------

  describe('role gating', () => {
    it('refuses APPROVED from a non-admin caller', async () => {
      seedApp('PENDING_APPROVAL', 1);

      await expect(
        invokeHandler(
          makeEvent(
            'updateApp',
            { input: { appId: 'app-1', status: 'APPROVED', version: 1 } },
            false,
          ),
        ),
      ).rejects.toThrow(/admin role required/);
    });

    it('refuses REJECTED from a non-admin caller even with a statusReason', async () => {
      seedApp('PENDING_APPROVAL', 1);

      await expect(
        invokeHandler(
          makeEvent(
            'updateApp',
            { input: { appId: 'app-1', status: 'REJECTED', version: 1, statusReason: 'no' } },
            false,
          ),
        ),
      ).rejects.toThrow(/admin role required/);
    });

    it('allows a non-admin caller to submit (DRAFT -> PENDING_APPROVAL)', async () => {
      seedApp('DRAFT', 1);

      const result = (await invokeHandler(
        makeEvent(
          'updateApp',
          { input: { appId: 'app-1', status: 'PENDING_APPROVAL', version: 1 } },
          false,
        ),
      )) as Record<string, unknown>;

      expect(result.status).toBe('PENDING_APPROVAL');
    });

    it('allows an admin caller to approve', async () => {
      seedApp('PENDING_APPROVAL', 1);

      const result = (await invokeHandler(
        makeEvent(
          'updateApp',
          { input: { appId: 'app-1', status: 'APPROVED', version: 1 } },
          true,
        ),
      )) as Record<string, unknown>;

      expect(result.status).toBe('APPROVED');
    });
  });

  // -- decidedBy is always server-derived -----------------------------------

  describe('decidedBy is derived server-side, never from client input', () => {
    it('stamps decidedBy from the admin auth identity on approve, ignoring any client-supplied value', async () => {
      seedApp('PENDING_APPROVAL', 1);

      const result = (await invokeHandler(
        makeEvent(
          'updateApp',
          {
            input: {
              appId: 'app-1',
              status: 'APPROVED',
              version: 1,
              // Not a real input field — even if a client tried to smuggle
              // this through, the resolver never reads input.decidedBy.
              decidedBy: 'attacker-controlled',
            },
          },
          true,
        ),
      )) as Record<string, unknown>;

      expect(result.decidedBy).toBe('admin-1');
      expect(result.decidedBy).not.toBe('attacker-controlled');
    });

    it('stamps decidedBy from the admin auth identity on reject', async () => {
      seedApp('PENDING_APPROVAL', 1);

      const result = (await invokeHandler(
        makeEvent(
          'updateApp',
          { input: { appId: 'app-1', status: 'REJECTED', version: 1, statusReason: 'no' } },
          true,
        ),
      )) as Record<string, unknown>;

      expect(result.decidedBy).toBe('admin-1');
    });
  });

  // -- Resubmit path ---------------------------------------------------------

  describe('resubmit path (REJECTED -> DRAFT)', () => {
    it('succeeds and clears the prior decidedBy/statusReason', async () => {
      seedApp('REJECTED', 2, 'org-1', {
        decidedBy: 'admin-1',
        statusReason: 'missing tests',
      });

      const result = (await invokeHandler(
        makeEvent('updateApp', { input: { appId: 'app-1', status: 'DRAFT', version: 2 } }),
      )) as Record<string, unknown>;

      expect(result.status).toBe('DRAFT');
      expect(result.decidedBy).toBeNull();
      expect(result.statusReason).toBeNull();
    });

    it('allows a non-admin caller to resubmit', async () => {
      seedApp('REJECTED', 2);

      const result = (await invokeHandler(
        makeEvent(
          'updateApp',
          { input: { appId: 'app-1', status: 'DRAFT', version: 2 } },
          false,
        ),
      )) as Record<string, unknown>;

      expect(result.status).toBe('DRAFT');
    });
  });
});
