/**
 * Regression tests for the empty-description hazard in
 * ../registry-agent-record-resolver.ts (createApp + updateApp).
 *
 * Root cause: the AgentCore Registry API rejects records whose `description`
 * is an empty string ("Member must have length greater than or equal to 1").
 * The Import Blueprint dialog's New App mode sends only `{ name, orgId }`,
 * and createApp previously forwarded `input.description || ''` straight into
 * `createResource`, so app creation without a description failed at AWS.
 *
 * Contract under test:
 *  - createApp: an absent/blank description defaults to the app name in BOTH
 *    the registry `createResource` call and the AppsTable `#META` mirror.
 *  - createApp: a provided non-empty description is passed through verbatim.
 *  - updateApp: an explicit-blank description, or an absent description over
 *    a legacy record whose stored description is blank, must never forward
 *    '' to `updateResource` — it defaults to the (merged) app name, and the
 *    meta mirror receives the same resolved value.
 *
 * The registry service is mocked via the shared fixture, wrapped in jest.fn
 * spies so tests can assert on the exact arguments passed to
 * createResource / updateResource.
 */
// Env vars MUST be set BEFORE `import { handler }` — the resolver captures
// EVENT_BUS_NAME / APPS_TABLE / DEFAULT_REGION at module-load time.
process.env.REGISTRY_ID = 'test-registry-id';
process.env.APPS_TABLE = 'citadel-apps-test';
process.env.WORKFLOWS_TABLE = 'citadel-workflows-test';
process.env.AGENT_CONFIG_TABLE = 'citadel-agents-test';
process.env.EVENT_BUS_NAME = 'citadel-agents-test';
process.env.USER_POOL_ID = 'us-east-1_test';
process.env.AWS_REGION = 'us-east-1';
// Leave AUTHORITY_UNITS_TABLE unset so grantFabricatorAuthority becomes a
// no-op inside createApp and we do not need a DynamoDB mock for that path.
delete process.env.AUTHORITY_UNITS_TABLE;

import { EventBridgeClient, PutEventsCommand } from '@aws-sdk/client-eventbridge';
import {
  DynamoDBDocumentClient,
  QueryCommand,
  ScanCommand,
  PutCommand,
  UpdateCommand,
  DeleteCommand,
} from '@aws-sdk/lib-dynamodb';
import { mockClient } from 'aws-sdk-client-mock';

const ebMock = mockClient(EventBridgeClient);
const ddbMock = mockClient(DynamoDBDocumentClient);

import {
  seedMockRegistry,
  resetMockRegistry,
} from './fixtures/registry-service-mock';

jest.mock('../../services/registry-service', () => {
  const { getMockRegistryService } = jest.requireActual(
    './fixtures/registry-service-mock',
  );
  // Stable singleton wrapping the fixture with jest.fn spies so tests can
  // inspect the exact args the resolver passes to the registry writes.
  const base = getMockRegistryService();
  const service = {
    ...base,
    createResource: jest.fn(base.createResource),
    updateResource: jest.fn(base.updateResource),
  };
  return {
    RegistryService: jest.fn().mockImplementation(() => service),
    getRegistryService: jest.fn(() => service),
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

import { getRegistryService } from '../../services/registry-service';
import { handler } from '../registry-agent-record-resolver';
import type { Context } from 'aws-lambda';

const mockContext = {} as unknown as Context;

const registry = getRegistryService() as unknown as {
  createResource: jest.Mock;
  updateResource: jest.Mock;
};

function makeEvent(fieldName: string, args: any, sub = 'user-123') {
  return {
    info: { fieldName },
    arguments: args,
    identity: { sub, claims: { sub } },
  } as any;
}

/** Last createResource CreateResourceInput (third positional arg). */
function lastCreateResourceInput(): any {
  const calls = registry.createResource.mock.calls;
  expect(calls.length).toBeGreaterThanOrEqual(1);
  return calls[calls.length - 1][2];
}

/** Last updateResource UpdateResourceInput (third positional arg). */
function lastUpdateResourceInput(): any {
  const calls = registry.updateResource.mock.calls;
  expect(calls.length).toBeGreaterThanOrEqual(1);
  return calls[calls.length - 1][2];
}

/**
 * Returns the `:v_description` value from the most recent AppsTable meta
 * UpdateCommand that wrote a description (both upsertAppMeta and
 * updateAppMetaFields use `:v_description` placeholders).
 */
function lastMetaDescriptionWrite(): unknown {
  const calls = ddbMock
    .commandCalls(UpdateCommand)
    .filter((c) =>
      Object.prototype.hasOwnProperty.call(
        c.args[0].input.ExpressionAttributeValues ?? {},
        ':v_description',
      ),
    );
  expect(calls.length).toBeGreaterThanOrEqual(1);
  return calls[calls.length - 1].args[0].input.ExpressionAttributeValues![
    ':v_description'
  ];
}

function seedApp(opts: { name?: string; description?: string; version?: number } = {}): void {
  seedMockRegistry('agent', 'app-1', {
    name: opts.name ?? 'Legacy App',
    description: opts.description ?? 'Existing description',
    status: 'DRAFT',
    customDescriptorContent: JSON.stringify({
      appId: 'app-1',
      manifest: {
        orgId: 'org-1',
        version: opts.version ?? 1,
        status: 'DRAFT',
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

describe('registry-agent-record-resolver — description defaulting', () => {
  beforeEach(() => {
    resetMockRegistry();
    registry.createResource.mockClear();
    registry.updateResource.mockClear();
    ebMock.reset();
    ebMock.on(PutEventsCommand).resolves({});
    ddbMock.reset();
    ddbMock.on(PutCommand).resolves({});
    ddbMock.on(UpdateCommand).resolves({});
    ddbMock.on(DeleteCommand).resolves({});
    ddbMock.on(QueryCommand).resolves({ Items: [], LastEvaluatedKey: undefined });
    ddbMock.on(ScanCommand).resolves({ Items: [], LastEvaluatedKey: undefined });
  });

  afterAll(() => {
    delete process.env.APPS_TABLE;
    delete process.env.WORKFLOWS_TABLE;
    delete process.env.AGENT_CONFIG_TABLE;
    delete process.env.EVENT_BUS_NAME;
    delete process.env.USER_POOL_ID;
    delete process.env.AWS_REGION;
    delete process.env.REGISTRY_ID;
  });

  // ─── createApp ─────────────────────────────────────────────────

  describe('createApp', () => {
    test('defaults the registry description to the app name when description is omitted (Import Blueprint New App regression)', async () => {
      await handler(
        makeEvent('createApp', {
          input: { name: 'My New App', orgId: 'org-1' },
        }),
        mockContext,
        jest.fn(),
      );

      const created = lastCreateResourceInput();
      expect(created.description).toBe('My New App');
    });

    test('defaults a blank (whitespace-only) description to the app name', async () => {
      await handler(
        makeEvent('createApp', {
          input: { name: 'My New App', orgId: 'org-1', description: '   ' },
        }),
        mockContext,
        jest.fn(),
      );

      const created = lastCreateResourceInput();
      expect(created.description).toBe('My New App');
    });

    test('mirrors the defaulted description to the AppsTable #META row (registry/mirror consistency)', async () => {
      await handler(
        makeEvent('createApp', {
          input: { name: 'My New App', orgId: 'org-1' },
        }),
        mockContext,
        jest.fn(),
      );

      expect(lastMetaDescriptionWrite()).toBe('My New App');
    });

    test('passes a provided non-empty description to the registry verbatim', async () => {
      await handler(
        makeEvent('createApp', {
          input: {
            name: 'My New App',
            orgId: 'org-1',
            description: 'Hand-written description',
          },
        }),
        mockContext,
        jest.fn(),
      );

      const created = lastCreateResourceInput();
      expect(created.description).toBe('Hand-written description');
      expect(lastMetaDescriptionWrite()).toBe('Hand-written description');
    });
  });

  // ─── updateApp (sibling-path sweep) ────────────────────────────

  describe('updateApp', () => {
    test('never forwards an explicit-blank description to the registry — defaults to the app name', async () => {
      seedApp({ name: 'Legacy App' });

      await handler(
        makeEvent('updateApp', {
          input: { appId: 'app-1', version: 1, description: '' },
        }),
        mockContext,
        jest.fn(),
      );

      const updated = lastUpdateResourceInput();
      expect(updated.description).toBe('Legacy App');
    });

    test('defaults to the app name when description is omitted and the existing record description is blank (legacy record)', async () => {
      seedApp({ name: 'Legacy App', description: '' });

      await handler(
        makeEvent('updateApp', {
          input: { appId: 'app-1', version: 1, name: 'Renamed App' },
        }),
        mockContext,
        jest.fn(),
      );

      const updated = lastUpdateResourceInput();
      expect(updated.description).toBe('Renamed App');
    });

    test('mirrors the defaulted description to the AppsTable #META row when the caller sent a blank description', async () => {
      seedApp({ name: 'Legacy App' });

      await handler(
        makeEvent('updateApp', {
          input: { appId: 'app-1', version: 1, description: '   ' },
        }),
        mockContext,
        jest.fn(),
      );

      expect(lastMetaDescriptionWrite()).toBe('Legacy App');
    });

    test('preserves a provided non-empty description verbatim', async () => {
      seedApp({ name: 'Legacy App' });

      await handler(
        makeEvent('updateApp', {
          input: { appId: 'app-1', version: 1, description: 'Updated by hand' },
        }),
        mockContext,
        jest.fn(),
      );

      const updated = lastUpdateResourceInput();
      expect(updated.description).toBe('Updated by hand');
      expect(lastMetaDescriptionWrite()).toBe('Updated by hand');
    });

    test('keeps the existing non-blank description when the caller omits it', async () => {
      seedApp({ name: 'Legacy App', description: 'Existing description' });

      await handler(
        makeEvent('updateApp', {
          input: { appId: 'app-1', version: 1, name: 'Renamed App' },
        }),
        mockContext,
        jest.fn(),
      );

      const updated = lastUpdateResourceInput();
      expect(updated.description).toBe('Existing description');
    });
  });
});
