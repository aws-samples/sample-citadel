/**
 * Regression tests for the READY-transition path in `updateAgentBinding`.
 *
 * Context: bindings persisted by legacy / DynamoDB flows can carry a
 * human-readable `agentId` (e.g. `"email_validator_agent"`) rather than the
 * Registry's 12-char recordId. Before this fix, the READY transition called
 * `getResource('agent', input.agentId)` directly, and the Registry SDK
 * rejected the call with:
 *
 *   Value at 'recordId' failed to satisfy constraint: Member must satisfy
 *   regular expression pattern: [a-zA-Z0-9]{12}
 *
 * The fix resolves the agentId through `RegistryService.resolveRecordId`
 * first, which has a fast path for recordIds and a name lookup for legacy
 * values. These tests exercise the transition-validation branch for the
 * three relevant input shapes and verify that non-READY mutations never
 * reach the resolver at all.
 */

process.env.REGISTRY_ID = 'test-registry-id';
process.env.APPS_TABLE = 'citadel-apps-test';
process.env.WORKFLOWS_TABLE = 'citadel-workflows-test';
process.env.AGENT_CONFIG_TABLE = 'citadel-agents-test';
process.env.EVENT_BUS_NAME = 'citadel-agents-test';
process.env.USER_POOL_ID = 'us-east-1_test';
process.env.AUTHORITY_UNITS_TABLE = 'test-authority-units';
process.env.APPSYNC_ENDPOINT =
  'https://test-api.appsync-api.us-east-1.amazonaws.com/graphql';
process.env.AWS_REGION = 'us-east-1';
process.env.MODEL_CATALOG_TABLE = 'citadel-model-catalog-test';

import { EventBridgeClient, PutEventsCommand } from '@aws-sdk/client-eventbridge';
import { DynamoDBDocumentClient, GetCommand } from '@aws-sdk/lib-dynamodb';
import { mockClient } from 'aws-sdk-client-mock';
import { TypeMismatchError } from '../../services/registry-service';

const ebMock = mockClient(EventBridgeClient);
const ddbMock = mockClient(DynamoDBDocumentClient);

// A stable jest.fn() trio so individual tests can override behaviour per-case
// without re-wiring the module mock. `updateResource` is overridden to honour
// the customMetadata → customDescriptorContent translation that the real
// RegistryService performs (the shared fixture leaves the old descriptor
// content in place, which would defeat the projection assertions here).
const resolveRecordIdMock = jest.fn();
const getResourceMock = jest.fn();
const updateResourceMock = jest.fn();

jest.mock('../../services/registry-service', () => {
  const actual = jest.requireActual('../../services/registry-service');
  const { getMockRegistryService } = jest.requireActual(
    './fixtures/registry-service-mock',
  );
  return {
    ...actual,
    RegistryService: jest.fn().mockImplementation(() => {
      const base = getMockRegistryService();
      return {
        ...base,
        resolveRecordId: (...args: unknown[]) => resolveRecordIdMock(...args),
        getResource: (...args: unknown[]) => getResourceMock(...args),
        updateResource: (...args: unknown[]) => updateResourceMock(...args),
      };
    }),
    getRegistryService: jest.fn(() => {
      const base = getMockRegistryService();
      return {
        ...base,
        resolveRecordId: (...args: unknown[]) => resolveRecordIdMock(...args),
        getResource: (...args: unknown[]) => getResourceMock(...args),
        updateResource: (...args: unknown[]) => updateResourceMock(...args),
      };
    }),
    _resetRegistryService: jest.fn(),
    isRegistryEnabled: jest.fn(() => true),
  };
});

jest.mock('../../utils/appsync', () => ({
  getUserId: jest.fn().mockReturnValue('user-123'),
}));

jest.mock('../../utils/appsync-publish', () => ({
  publishAppStatusEvent: jest.fn().mockResolvedValue({}),
}));

jest.mock('uuid', () => ({
  v4: jest.fn().mockReturnValue('test-correlation-id'),
}));

import {
  seedMockRegistry,
  resetMockRegistry,
} from './fixtures/registry-service-mock';
import { handler } from '../registry-agent-record-resolver';

// ---------------------------------------------------------------------------
// Fixtures
// ---------------------------------------------------------------------------

const APP_RECORD_ID = 'app000000001';
const AGENT_RECORD_ID = 'agt000000001'; // valid 12-char recordId
const AGENT_NAME = 'email_validator_agent'; // legacy human-readable id

function seedAppWithBinding(agentId: string) {
  seedMockRegistry('agent', APP_RECORD_ID, {
    name: 'Test App',
    description: 'Test',
    status: 'DRAFT',
    customDescriptorContent: JSON.stringify({
      appId: APP_RECORD_ID,
      manifest: {
        orgId: 'org-1',
        version: 1,
        status: 'DRAFT',
        workflowIds: [],
        agentBindings: [
          {
            agentId,
            status: 'DESIGN',
            addedAt: '2026-01-01T00:00:00Z',
          },
        ],
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

function activeAgentRecord(recordId: string) {
  return {
    recordId,
    name: 'email_validator_agent',
    status: 'ACTIVE',
    customDescriptorContent: JSON.stringify({ state: 'active' }),
  };
}

function inactiveAgentRecord(recordId: string) {
  return {
    recordId,
    name: 'email_validator_agent',
    status: 'DRAFT',
    customDescriptorContent: JSON.stringify({ state: 'draft' }),
  };
}

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

// ---------------------------------------------------------------------------
// Tests
// ---------------------------------------------------------------------------

describe('updateAgentBinding — READY transition agentId resolution', () => {
  beforeEach(() => {
    resetMockRegistry();
    ebMock.reset();
    ebMock.on(PutEventsCommand).resolves({});
    resolveRecordIdMock.mockReset();
    getResourceMock.mockReset();
    updateResourceMock.mockReset();
    // Default: translate the `customMetadata` input (the JSON blob that
    // wraps the new manifest) into `customDescriptorContent` on the
    // returned record, mimicking the real RegistryService. This is what
    // projectAgentApp consumes, so assertions can read the post-update
    // manifest via the normal projection path.
    updateResourceMock.mockImplementation(async (_type: unknown, id: unknown, input: { customMetadata?: string }) => ({
      recordId: id,
      name: 'Test App',
      status: 'DRAFT',
      customDescriptorContent: input.customMetadata,
    }));
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

  test('succeeds when agentId is already a 12-char recordId and the agent is active', async () => {
    seedAppWithBinding(AGENT_RECORD_ID);
    resolveRecordIdMock.mockImplementation(async (_type, id) => id);
    // First getResource call: app lookup. Second: agent lookup after resolve.
    getResourceMock
      .mockResolvedValueOnce({
        recordId: APP_RECORD_ID,
        name: 'Test App',
        status: 'DRAFT',
        customDescriptorContent: JSON.stringify({
          appId: APP_RECORD_ID,
          manifest: {
            orgId: 'org-1',
            version: 1,
            status: 'DRAFT',
            agentBindings: [
              { agentId: AGENT_RECORD_ID, status: 'DESIGN', addedAt: 't' },
            ],
          },
        }),
      })
      .mockResolvedValueOnce(activeAgentRecord(AGENT_RECORD_ID));

    const result = await invokeHandler(
      makeEvent('updateAgentBinding', {
        input: {
          appId: APP_RECORD_ID,
          agentId: AGENT_RECORD_ID,
          status: 'READY',
        },
      }),
    );

    expect(resolveRecordIdMock).toHaveBeenCalledWith('agent', AGENT_RECORD_ID);
    expect(result).toMatchObject({
      agentBindings: [
        expect.objectContaining({
          agentId: AGENT_RECORD_ID,
          status: 'READY',
        }),
      ],
    });
  });

  test('resolves a human-readable agentId to a recordId before calling getResource', async () => {
    seedAppWithBinding(AGENT_NAME);
    resolveRecordIdMock.mockImplementation(async (_type, id) => {
      expect(id).toBe(AGENT_NAME);
      return AGENT_RECORD_ID;
    });
    getResourceMock
      .mockResolvedValueOnce({
        recordId: APP_RECORD_ID,
        name: 'Test App',
        status: 'DRAFT',
        customDescriptorContent: JSON.stringify({
          appId: APP_RECORD_ID,
          manifest: {
            orgId: 'org-1',
            version: 1,
            status: 'DRAFT',
            agentBindings: [
              { agentId: AGENT_NAME, status: 'DESIGN', addedAt: 't' },
            ],
          },
        }),
      })
      .mockResolvedValueOnce(activeAgentRecord(AGENT_RECORD_ID));

    await invokeHandler(
      makeEvent('updateAgentBinding', {
        input: {
          appId: APP_RECORD_ID,
          agentId: AGENT_NAME,
          status: 'READY',
        },
      }),
    );

    // resolveRecordId was consulted for the binding's human name…
    expect(resolveRecordIdMock).toHaveBeenCalledWith('agent', AGENT_NAME);
    // …and the subsequent getResource call used the resolved recordId, never
    // the raw name (this is the branch that previously hit the SDK regex).
    const agentLookup = getResourceMock.mock.calls.find(
      ([type, id]) => type === 'agent' && id === AGENT_RECORD_ID,
    );
    expect(agentLookup).toBeDefined();
    const rawNameLookup = getResourceMock.mock.calls.find(
      ([type, id]) => type === 'agent' && id === AGENT_NAME,
    );
    expect(rawNameLookup).toBeUndefined();
  });

  test('surfaces "Agent not found" when resolveRecordId throws not-found', async () => {
    // Distinguishes the genuine missing-agent case from the activation-gate
    // failure. Previously both surfaced the same "must be active" message.
    seedAppWithBinding(AGENT_NAME);
    resolveRecordIdMock.mockRejectedValueOnce(
      new Error(`Registry record not found for agent: ${AGENT_NAME}`),
    );
    getResourceMock.mockResolvedValueOnce({
      recordId: APP_RECORD_ID,
      name: 'Test App',
      status: 'DRAFT',
      customDescriptorContent: JSON.stringify({
        appId: APP_RECORD_ID,
        manifest: {
          orgId: 'org-1',
          version: 1,
          status: 'DRAFT',
          agentBindings: [
            { agentId: AGENT_NAME, status: 'DESIGN', addedAt: 't' },
          ],
        },
      }),
    });

    await expect(
      invokeHandler(
        makeEvent('updateAgentBinding', {
          input: {
            appId: APP_RECORD_ID,
            agentId: AGENT_NAME,
            status: 'READY',
          },
        }),
      ),
    ).rejects.toThrow(`Agent ${AGENT_NAME} not found`);
    // The agent getResource path must not be reached when resolution failed.
    const agentLookups = getResourceMock.mock.calls.filter(
      ([type, id]) => type === 'agent' && id !== APP_RECORD_ID,
    );
    expect(agentLookups).toHaveLength(0);
  });

  test('surfaces the activation-gate error when getResource throws TypeMismatchError on the resolved agent', async () => {
    // Simulates the case where the resolved recordId exists but is not an
    // agent record (or the SDK otherwise rejects the lookup with a type
    // mismatch). The caller must see the normal activation-gate message
    // rather than a raw SDK validation error.
    seedAppWithBinding(AGENT_NAME);
    resolveRecordIdMock.mockResolvedValue(AGENT_RECORD_ID);
    getResourceMock
      .mockResolvedValueOnce({
        recordId: APP_RECORD_ID,
        name: 'Test App',
        status: 'DRAFT',
        customDescriptorContent: JSON.stringify({
          appId: APP_RECORD_ID,
          manifest: {
            orgId: 'org-1',
            version: 1,
            status: 'DRAFT',
            agentBindings: [
              { agentId: AGENT_NAME, status: 'DESIGN', addedAt: 't' },
            ],
          },
        }),
      })
      .mockImplementationOnce(async () => {
        throw new TypeMismatchError(
          `Record ${AGENT_RECORD_ID} exists but is not an agent (no manifest)`,
        );
      });

    await expect(
      invokeHandler(
        makeEvent('updateAgentBinding', {
          input: {
            appId: APP_RECORD_ID,
            agentId: AGENT_NAME,
            status: 'READY',
          },
        }),
      ),
    ).rejects.toThrow('Agent must be active before it can be marked as ready');
  });

  test('throws the activation-gate error when the resolved agent is not in active state', async () => {
    seedAppWithBinding(AGENT_RECORD_ID);
    resolveRecordIdMock.mockResolvedValue(AGENT_RECORD_ID);
    getResourceMock
      .mockResolvedValueOnce({
        recordId: APP_RECORD_ID,
        name: 'Test App',
        status: 'DRAFT',
        customDescriptorContent: JSON.stringify({
          appId: APP_RECORD_ID,
          manifest: {
            orgId: 'org-1',
            version: 1,
            status: 'DRAFT',
            agentBindings: [
              { agentId: AGENT_RECORD_ID, status: 'DESIGN', addedAt: 't' },
            ],
          },
        }),
      })
      .mockResolvedValueOnce(inactiveAgentRecord(AGENT_RECORD_ID));

    await expect(
      invokeHandler(
        makeEvent('updateAgentBinding', {
          input: {
            appId: APP_RECORD_ID,
            agentId: AGENT_RECORD_ID,
            status: 'READY',
          },
        }),
      ),
    ).rejects.toThrow('Agent must be active before it can be marked as ready');
  });

  test('does not invoke resolveRecordId or agent getResource when the transition is not READY', async () => {
    // Updating a binding back to DESIGN (or editing a non-status field) is
    // a pure manifest mutation and must never touch the activation gate.
    seedAppWithBinding(AGENT_NAME);
    getResourceMock.mockResolvedValueOnce({
      recordId: APP_RECORD_ID,
      name: 'Test App',
      status: 'DRAFT',
      customDescriptorContent: JSON.stringify({
        appId: APP_RECORD_ID,
        manifest: {
          orgId: 'org-1',
          version: 1,
          status: 'DRAFT',
          agentBindings: [
            { agentId: AGENT_NAME, status: 'READY', addedAt: 't' },
          ],
        },
      }),
    });

    await invokeHandler(
      makeEvent('updateAgentBinding', {
        input: {
          appId: APP_RECORD_ID,
          agentId: AGENT_NAME,
          status: 'DESIGN',
        },
      }),
    );

    expect(resolveRecordIdMock).not.toHaveBeenCalled();
    // The only getResource call is the app lookup at the top of the handler;
    // there must be no second call for the agent itself.
    const agentLookups = getResourceMock.mock.calls.filter(
      ([type, id]) => type === 'agent' && id !== APP_RECORD_ID,
    );
    expect(agentLookups).toHaveLength(0);
  });
});

// ---------------------------------------------------------------------------
// modelOverride catalog validation (feature/configurable-model-selection)
//
// Non-breaking contract:
//   - Validation runs ONLY when a non-empty modelOverride is set/changed to a
//     value that differs from the currently-stored binding value.
//   - Empty string (clear), unchanged values, and legacy values are
//     grandfathered — never validated.
//   - When MODEL_CATALOG_TABLE is not configured the helper is a safe no-op.
// Uses generic placeholder catalog keys — no real model-id literals.
// ---------------------------------------------------------------------------
describe('updateAgentBinding — modelOverride catalog validation', () => {
  const CATALOG_TABLE = 'citadel-model-catalog-test';
  const ENABLED_KEY = 'catalog-model-enabled';
  const DISABLED_KEY = 'catalog-model-disabled';
  const UNKNOWN_KEY = 'catalog-model-unknown';
  const LEGACY_KEY = 'legacy-model-key';

  beforeEach(() => {
    resetMockRegistry();
    ebMock.reset();
    ebMock.on(PutEventsCommand).resolves({});
    ddbMock.reset();
    resolveRecordIdMock.mockReset();
    getResourceMock.mockReset();
    updateResourceMock.mockReset();
    updateResourceMock.mockImplementation(async (_type: unknown, id: unknown, input: { customMetadata?: string }) => ({
      recordId: id,
      name: 'Test App',
      status: 'DRAFT',
      customDescriptorContent: input.customMetadata,
    }));
    process.env.MODEL_CATALOG_TABLE = CATALOG_TABLE;
  });

  afterAll(() => {
    delete process.env.MODEL_CATALOG_TABLE;
  });

  // Seeds the app lookup (getResource call #1) with a single agent binding
  // that optionally already carries a stored modelOverride.
  function seedApp(existingModelOverride?: string) {
    getResourceMock.mockResolvedValueOnce({
      recordId: APP_RECORD_ID,
      name: 'Test App',
      status: 'DRAFT',
      customDescriptorContent: JSON.stringify({
        appId: APP_RECORD_ID,
        manifest: {
          orgId: 'org-1',
          version: 1,
          status: 'DRAFT',
          agentBindings: [
            {
              agentId: AGENT_RECORD_ID,
              status: 'DESIGN',
              addedAt: 't',
              ...(existingModelOverride !== undefined && {
                modelOverride: existingModelOverride,
              }),
            },
          ],
        },
      }),
    });
  }

  function bindingEvent(modelOverride: string) {
    return makeEvent('updateAgentBinding', {
      input: { appId: APP_RECORD_ID, agentId: AGENT_RECORD_ID, modelOverride },
    });
  }

  test('(a) changing modelOverride to an enabled catalog key succeeds', async () => {
    seedApp();
    ddbMock
      .on(GetCommand, { TableName: CATALOG_TABLE, Key: { modelKey: ENABLED_KEY } })
      .resolves({ Item: { modelKey: ENABLED_KEY, status: 'enabled' } });

    const result = await invokeHandler(bindingEvent(ENABLED_KEY));

    expect(ddbMock.commandCalls(GetCommand)).toHaveLength(1);
    expect(result).toMatchObject({
      agentBindings: [expect.objectContaining({ modelOverride: ENABLED_KEY })],
    });
  });

  test('(b) changing modelOverride to an unknown catalog key throws', async () => {
    seedApp();
    ddbMock.on(GetCommand).resolves({}); // no Item

    await expect(
      invokeHandler(bindingEvent(UNKNOWN_KEY)),
    ).rejects.toThrow('not found in the model catalog');
    // Nothing persisted when validation fails.
    expect(updateResourceMock).not.toHaveBeenCalled();
  });

  test('(c) changing modelOverride to a disabled catalog key throws', async () => {
    seedApp();
    ddbMock
      .on(GetCommand)
      .resolves({ Item: { modelKey: DISABLED_KEY, status: 'disabled' } });

    await expect(
      invokeHandler(bindingEvent(DISABLED_KEY)),
    ).rejects.toThrow('is not enabled');
    expect(updateResourceMock).not.toHaveBeenCalled();
  });

  test('(d) empty string clears the override without catalog validation', async () => {
    seedApp(LEGACY_KEY);

    const result = await invokeHandler(bindingEvent(''));

    expect(ddbMock.commandCalls(GetCommand)).toHaveLength(0);
    expect(result).toMatchObject({
      agentBindings: [expect.objectContaining({ modelOverride: '' })],
    });
  });

  test('(e) unchanged legacy value is grandfathered — no catalog validation', async () => {
    seedApp(LEGACY_KEY);

    const result = await invokeHandler(bindingEvent(LEGACY_KEY));

    expect(ddbMock.commandCalls(GetCommand)).toHaveLength(0);
    expect(result).toMatchObject({
      agentBindings: [expect.objectContaining({ modelOverride: LEGACY_KEY })],
    });
  });

  test('unset MODEL_CATALOG_TABLE is a safe no-op (changed override still persists)', async () => {
    delete process.env.MODEL_CATALOG_TABLE;
    const warnSpy = jest.spyOn(console, 'warn').mockImplementation(() => {});
    seedApp();

    const result = await invokeHandler(bindingEvent('catalog-model-some-new'));

    // No catalog read attempted, mutation still persisted (non-breaking).
    expect(ddbMock.commandCalls(GetCommand)).toHaveLength(0);
    expect(warnSpy).toHaveBeenCalled();
    expect(result).toMatchObject({
      agentBindings: [
        expect.objectContaining({ modelOverride: 'catalog-model-some-new' }),
      ],
    });
    warnSpy.mockRestore();
  });
});
