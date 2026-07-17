/**
 * Unit tests for registry-native resolver component + config + binding
 * surfaces. PR 6a replacement for:
 *   - agent-app-shim-addcomponent.test.ts
 *   - agent-app-shim-removecomponent.test.ts
 *   - agent-app-shim-setappconfigschema.test.ts
 *   - agent-app-shim-setappconfigvalues.test.ts
 *   - agent-app-shim-updateagentbinding.test.ts
 *   - agent-app-shim-permission-validation.test.ts (pure validator unit +
 *     addAppComponent integration — both kept here).
 *
 * Tests ported verbatim; only imports, describe labels, and the resolver
 * path differ.
 */

process.env.REGISTRY_ID = 'test-registry-id';
process.env.APPS_TABLE = 'citadel-apps-test';
process.env.WORKFLOWS_TABLE = 'citadel-workflows-test';
process.env.AGENT_CONFIG_TABLE = 'citadel-agents-test';
process.env.EVENT_BUS_NAME = 'citadel-agents-test';
process.env.USER_POOL_ID = 'us-east-1_test';
process.env.AUTHORITY_UNITS_TABLE = 'test-authority-units';
process.env.AWS_REGION = 'us-east-1';
// This suite exercises addAppComponent with a modelOverride but does not wire a
// model catalog. Ensure MODEL_CATALOG_TABLE is unset so binding catalog
// validation deterministically takes its non-breaking no-op path here,
// independent of any env set by other test files sharing the worker process.
delete process.env.MODEL_CATALOG_TABLE;

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

jest.mock('../../utils/appsync-publish', () => ({
  publishAppStatusEvent: jest.fn().mockResolvedValue(undefined),
}));

import { handler, validatePermissionActions } from '../registry-agent-record-resolver';

const VALID_SCHEMA = {
  type: 'object',
  properties: {
    apiKey: { type: 'string' },
    maxRetries: { type: 'number' },
  },
  required: ['apiKey'],
};

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

function seedApp(
  opts: {
    appId?: string;
    agentBindings?: unknown[];
    permissions?: unknown[];
    version?: number;
    configSchema?: unknown;
    configValues?: unknown;
  } = {},
) {
  const appId = opts.appId ?? 'app-1';
  seedMockRegistry('agent', appId, {
    name: 'Test App',
    description: 'Test',
    status: 'DRAFT',
    customDescriptorContent: JSON.stringify({
      appId,
      manifest: {
        orgId: 'org-1',
        version: opts.version ?? 1,
        status: 'DRAFT',
        workflowIds: [],
        agentBindings: opts.agentBindings ?? [],
        permissions: opts.permissions ?? [],
        configSchema: opts.configSchema ?? null,
        configValues: opts.configValues ?? null,
        authConfig: null,
        access: {},
        routingConfig: null,
      },
    }),
  });
}

function seedAppWithBinding(opts: { bindingStatus?: string; agentId?: string } = {}) {
  const agentId = opts.agentId ?? 'agent-1';
  seedApp({
    agentBindings: [
      {
        agentId,
        status: opts.bindingStatus ?? 'DESIGN',
        addedAt: '2024-01-01T00:00:00Z',
      },
    ],
  });
}

function seedTargetAgent(opts: { agentId?: string; state?: string } = {}) {
  const agentId = opts.agentId ?? 'agent-1';
  seedMockRegistry('agent', agentId, {
    name: 'Target Agent',
    description: 'A registered agent',
    status: 'ACTIVE',
    customDescriptorContent: JSON.stringify({ state: opts.state ?? 'active' }),
  });
}

// =====================================================================
// validatePermissionActions — pure unit
// =====================================================================

describe('validatePermissionActions', () => {
  test('rejects bare wildcard *', () => {
    const result = validatePermissionActions(['*']);
    expect(result.valid).toBe(false);
    expect(result.errors).toHaveLength(1);
    expect(result.errors[0]).toContain('Bare wildcard');
  });

  test('accepts service-prefixed actions like s3:GetObject', () => {
    const result = validatePermissionActions(['s3:GetObject']);
    expect(result.valid).toBe(true);
    expect(result.errors).toHaveLength(0);
  });

  test('accepts service-prefixed wildcard like s3:*', () => {
    const result = validatePermissionActions(['s3:*']);
    expect(result.valid).toBe(true);
    expect(result.errors).toHaveLength(0);
  });

  test('accepts dynamodb:Query', () => {
    const result = validatePermissionActions(['dynamodb:Query']);
    expect(result.valid).toBe(true);
  });

  test('rejects invalid format without colon', () => {
    const result = validatePermissionActions(['s3GetObject']);
    expect(result.valid).toBe(false);
    expect(result.errors[0]).toContain('Invalid IAM action format');
  });

  test('rejects empty string', () => {
    const result = validatePermissionActions(['']);
    expect(result.valid).toBe(false);
  });

  test('rejects action with spaces', () => {
    const result = validatePermissionActions(['s3: GetObject']);
    expect(result.valid).toBe(false);
  });

  test('validates multiple actions and collects all errors', () => {
    const result = validatePermissionActions(['*', 's3:GetObject', 'invalid']);
    expect(result.valid).toBe(false);
    expect(result.errors.length).toBe(2);
  });

  test('accepts multiple valid actions', () => {
    const result = validatePermissionActions(['s3:GetObject', 'dynamodb:Query', 'lambda:InvokeFunction']);
    expect(result.valid).toBe(true);
  });

  test('accepts service names with hyphens like cognito-idp:AdminGetUser', () => {
    const result = validatePermissionActions(['cognito-idp:AdminGetUser']);
    expect(result.valid).toBe(true);
  });
});

// =====================================================================
// addAppComponent
// =====================================================================

describe('registry-agent-record-resolver — addAppComponent', () => {
  beforeEach(() => {
    resetMockRegistry();
    ebMock.reset();
    ebMock.on(PutEventsCommand).resolves({});
  });

  describe('type "agent"', () => {
    test('emits app.component.added event with agent component detail', async () => {
      seedApp();

      await invokeHandler(
        makeEvent('addAppComponent', {
          appId: 'app-1',
          component: {
            type: 'agent',
            data: JSON.stringify({ agentId: 'agent-1' }),
          },
        }),
      );

      const entries = ebMock
        .commandCalls(PutEventsCommand)
        .flatMap((c) => c.args[0].input.Entries ?? []);
      const added = entries.find((e) => e?.DetailType === 'app.component.added');
      expect(added).toBeDefined();
      expect(added!.Source).toBe('citadel.apps');

      const detail = JSON.parse(added!.Detail!);
      expect(detail.appId).toBe('app-1');
      expect(detail.componentType).toBe('agent');
      expect(detail.componentId).toBe('agent-1');
      expect(detail.userId).toBe('user-123');
    });

    test('accepts override fields without throwing', async () => {
      seedApp();

      const result = await invokeHandler(
        makeEvent('addAppComponent', {
          appId: 'app-1',
          component: {
            type: 'agent',
            data: JSON.stringify({
              agentId: 'agent-2',
              systemPromptAddition: 'Be helpful',
              toolRestrictions: ['tool-x'],
              modelOverride: 'us.anthropic.claude-sonnet-4-6',
            }),
          },
        }),
      );

      expect(result).toBeDefined();
      expect(result.appId).toBe('app-1');
    });
  });

  describe('type "permission"', () => {
    test('emits app.component.added event with permission component detail', async () => {
      seedApp();

      await invokeHandler(
        makeEvent('addAppComponent', {
          appId: 'app-1',
          component: {
            type: 'permission',
            data: JSON.stringify({
              permissionId: 'perm-1',
              actions: ['s3:GetObject'],
              resources: ['arn:aws:s3:::my-bucket/*'],
              description: 'Read access to S3',
            }),
          },
        }),
      );

      const entries = ebMock
        .commandCalls(PutEventsCommand)
        .flatMap((c) => c.args[0].input.Entries ?? []);
      const added = entries.find((e) => e?.DetailType === 'app.component.added');
      expect(added).toBeDefined();

      const detail = JSON.parse(added!.Detail!);
      expect(detail.componentType).toBe('permission');
      expect(detail.componentId).toBe('perm-1');
    });

    test('rejects permission with invalid IAM action format', async () => {
      seedApp();

      await expect(
        invokeHandler(
          makeEvent('addAppComponent', {
            appId: 'app-1',
            component: {
              type: 'permission',
              data: JSON.stringify({
                permissionId: 'perm-bad',
                actions: ['*'],
                resources: ['*'],
              }),
            },
          }),
        ),
      ).rejects.toThrow(/Permission validation failed/);
    });
  });

  describe('error paths', () => {
    test('rejects when app not found', async () => {
      await expect(
        invokeHandler(
          makeEvent('addAppComponent', {
            appId: 'nonexistent',
            component: {
              type: 'agent',
              data: JSON.stringify({ agentId: 'agent-1' }),
            },
          }),
        ),
      ).rejects.toThrow('App not found');
    });

    test('rejects unsupported component type', async () => {
      seedApp();

      await expect(
        invokeHandler(
          makeEvent('addAppComponent', {
            appId: 'app-1',
            component: { type: 'unknown-type', data: JSON.stringify({ id: 'x' }) },
          }),
        ),
      ).rejects.toThrow(/Unsupported component type/);
    });
  });

  describe('permission validation integration', () => {
    test('rejects permission component with bare wildcard * in actions', async () => {
      seedApp();

      await expect(
        invokeHandler(
          makeEvent('addAppComponent', {
            appId: 'app-1',
            component: {
              type: 'permission',
              data: JSON.stringify({
                permissionId: 'perm-bad',
                actions: ['*'],
                resources: ['arn:aws:s3:::my-bucket/*'],
              }),
            },
          }),
        ),
      ).rejects.toThrow('Bare wildcard');
    });

    test('rejects permission component with invalid action format', async () => {
      seedApp();

      await expect(
        invokeHandler(
          makeEvent('addAppComponent', {
            appId: 'app-1',
            component: {
              type: 'permission',
              data: JSON.stringify({
                permissionId: 'perm-bad',
                actions: ['noColonHere'],
                resources: ['arn:aws:s3:::my-bucket/*'],
              }),
            },
          }),
        ),
      ).rejects.toThrow('Invalid IAM action format');
    });

    test('allows permission component with valid service-prefixed actions', async () => {
      seedApp();

      const result = await invokeHandler(
        makeEvent('addAppComponent', {
          appId: 'app-1',
          component: {
            type: 'permission',
            data: JSON.stringify({
              permissionId: 'perm-ok',
              actions: ['s3:GetObject', 'dynamodb:*'],
              resources: ['arn:aws:s3:::my-bucket/*'],
            }),
          },
        }),
      );

      expect(result).toBeDefined();
      expect(result.appId).toBe('app-1');
    });
  });

  describe('return value', () => {
    test('returns app projection with agentBindings and permissions arrays present', async () => {
      seedApp();

      const result = await invokeHandler(
        makeEvent('addAppComponent', {
          appId: 'app-1',
          component: {
            type: 'agent',
            data: JSON.stringify({ agentId: 'agent-1' }),
          },
        }),
      );

      expect(result.appId).toBe('app-1');
      expect(Array.isArray(result.agentBindings)).toBe(true);
      expect(Array.isArray(result.permissions)).toBe(true);
    });
  });
});

// =====================================================================
// removeAppComponent
// =====================================================================

describe('registry-agent-record-resolver — removeAppComponent', () => {
  beforeEach(() => {
    resetMockRegistry();
    ebMock.reset();
    ebMock.on(PutEventsCommand).resolves({});
  });

  function seedAppForRemove(opts: { agentBindings?: unknown[]; permissions?: unknown[] } = {}) {
    seedApp({
      agentBindings: opts.agentBindings ?? [
        { agentId: 'agent-1', status: 'DESIGN', addedAt: '2024-01-01T00:00:00Z' },
      ],
      permissions: opts.permissions ?? [
        { permissionId: 'perm-1', actions: ['s3:GetObject'], resources: ['*'] },
      ],
    });
  }

  test('emits app.component.removed event for agent type', async () => {
    seedAppForRemove();

    await invokeHandler(
      makeEvent('removeAppComponent', {
        appId: 'app-1',
        componentType: 'agent',
        componentId: 'agent-1',
      }),
    );

    const entries = ebMock
      .commandCalls(PutEventsCommand)
      .flatMap((c) => c.args[0].input.Entries ?? []);
    const removed = entries.find((e) => e?.DetailType === 'app.component.removed');
    expect(removed).toBeDefined();
    expect(removed!.Source).toBe('citadel.apps');

    const detail = JSON.parse(removed!.Detail!);
    expect(detail.appId).toBe('app-1');
    expect(detail.componentType).toBe('agent');
    expect(detail.componentId).toBe('agent-1');
  });

  test('emits app.component.removed event for permission type', async () => {
    seedAppForRemove();

    await invokeHandler(
      makeEvent('removeAppComponent', {
        appId: 'app-1',
        componentType: 'permission',
        componentId: 'perm-1',
      }),
    );

    const entries = ebMock
      .commandCalls(PutEventsCommand)
      .flatMap((c) => c.args[0].input.Entries ?? []);
    const removed = entries.find((e) => e?.DetailType === 'app.component.removed');
    expect(removed).toBeDefined();

    const detail = JSON.parse(removed!.Detail!);
    expect(detail.componentType).toBe('permission');
    expect(detail.componentId).toBe('perm-1');
  });

  test('returns app unchanged when component does not exist (idempotent)', async () => {
    seedAppForRemove({ agentBindings: [] });

    const result = await invokeHandler(
      makeEvent('removeAppComponent', {
        appId: 'app-1',
        componentType: 'agent',
        componentId: 'nonexistent-agent',
      }),
    );

    expect(result).toBeDefined();
    expect(result.appId).toBe('app-1');
  });

  test('rejects when app not found', async () => {
    await expect(
      invokeHandler(
        makeEvent('removeAppComponent', {
          appId: 'nonexistent',
          componentType: 'agent',
          componentId: 'agent-1',
        }),
      ),
    ).rejects.toThrow('App not found');
  });

  test('rejects unsupported component type', async () => {
    seedAppForRemove();

    await expect(
      invokeHandler(
        makeEvent('removeAppComponent', {
          appId: 'app-1',
          componentType: 'unknown',
          componentId: 'x',
        }),
      ),
    ).rejects.toThrow(/Unsupported component type/);
  });
});

// =====================================================================
// updateAgentBinding
// =====================================================================

describe('registry-agent-record-resolver — updateAgentBinding', () => {
  beforeEach(() => {
    resetMockRegistry();
    ebMock.reset();
    ebMock.on(PutEventsCommand).resolves({});
  });

  test('throws when agent binding does not exist for the app', async () => {
    seedApp({ agentBindings: [] });

    await expect(
      invokeHandler(
        makeEvent('updateAgentBinding', {
          input: {
            appId: 'app-1',
            agentId: 'agent-1',
            systemPromptAddition: 'Be helpful',
          },
        }),
      ),
    ).rejects.toThrow('Agent is not a component of this app');
  });

  test('throws when app does not exist', async () => {
    await expect(
      invokeHandler(
        makeEvent('updateAgentBinding', {
          input: { appId: 'nonexistent', agentId: 'agent-1' },
        }),
      ),
    ).rejects.toThrow('App not found');
  });

  test('updates systemPromptAddition without throwing and emits event', async () => {
    seedAppWithBinding();

    const result = await invokeHandler(
      makeEvent('updateAgentBinding', {
        input: {
          appId: 'app-1',
          agentId: 'agent-1',
          systemPromptAddition: 'Be helpful',
        },
      }),
    );

    expect(result).toBeDefined();
    expect(result.appId).toBe('app-1');

    const entries = ebMock
      .commandCalls(PutEventsCommand)
      .flatMap((c) => c.args[0].input.Entries ?? []);
    const updated = entries.find(
      (e) => e?.DetailType === 'app.agent.binding.updated',
    );
    expect(updated).toBeDefined();
    const detail = JSON.parse(updated!.Detail!);
    expect(detail.appId).toBe('app-1');
    expect(detail.agentId).toBe('agent-1');
  });

  test('status change to READY succeeds when target agent descriptor.state === "active"', async () => {
    seedAppWithBinding();
    seedTargetAgent({ agentId: 'agent-1', state: 'active' });

    const result = await invokeHandler(
      makeEvent('updateAgentBinding', {
        input: {
          appId: 'app-1',
          agentId: 'agent-1',
          status: 'READY',
        },
      }),
    );

    expect(result).toBeDefined();
  });

  test('throws when target agent record does not exist', async () => {
    seedAppWithBinding();

    await expect(
      invokeHandler(
        makeEvent('updateAgentBinding', {
          input: {
            appId: 'app-1',
            agentId: 'agent-1',
            status: 'READY',
          },
        }),
      ),
    ).rejects.toThrow('Agent must be active before it can be marked as ready');
  });

  test('throws when target agent descriptor.state is not "active"', async () => {
    seedAppWithBinding();
    seedTargetAgent({ agentId: 'agent-1', state: 'inactive' });

    await expect(
      invokeHandler(
        makeEvent('updateAgentBinding', {
          input: {
            appId: 'app-1',
            agentId: 'agent-1',
            status: 'READY',
          },
        }),
      ),
    ).rejects.toThrow('Agent must be active before it can be marked as ready');
  });

  test('status change to DESIGN does not require target agent validation', async () => {
    seedAppWithBinding({ bindingStatus: 'READY' });

    const result = await invokeHandler(
      makeEvent('updateAgentBinding', {
        input: {
          appId: 'app-1',
          agentId: 'agent-1',
          status: 'DESIGN',
        },
      }),
    );

    expect(result).toBeDefined();
  });

  test('returns full app projection with agentBindings present', async () => {
    seedAppWithBinding();

    const result = await invokeHandler(
      makeEvent('updateAgentBinding', {
        input: {
          appId: 'app-1',
          agentId: 'agent-1',
          systemPromptAddition: 'Updated',
        },
      }),
    );

    expect(result.appId).toBe('app-1');
    expect(Array.isArray(result.agentBindings)).toBe(true);
    expect(result.agentBindings.length).toBe(1);
    expect(result.agentBindings[0].agentId).toBe('agent-1');
  });
});

// =====================================================================
// setAppConfigSchema
// =====================================================================

describe('registry-agent-record-resolver — setAppConfigSchema', () => {
  beforeEach(() => {
    resetMockRegistry();
    ebMock.reset();
    ebMock.on(PutEventsCommand).resolves({});
  });

  test('stores valid JSON Schema and emits app.config.schema.set event', async () => {
    seedApp({ version: 3 });

    const result = await invokeHandler(
      makeEvent('setAppConfigSchema', {
        appId: 'app-1',
        schema: JSON.stringify(VALID_SCHEMA),
        version: 3,
      }),
    );

    expect(result).toBeDefined();
    expect(result.appId).toBe('app-1');

    const entries = ebMock
      .commandCalls(PutEventsCommand)
      .flatMap((c) => c.args[0].input.Entries ?? []);
    const set = entries.find((e) => e?.DetailType === 'app.config.schema.set');
    expect(set).toBeDefined();
  });

  test('rejects schema with invalid type keyword', async () => {
    seedApp({ version: 3 });

    await expect(
      invokeHandler(
        makeEvent('setAppConfigSchema', {
          appId: 'app-1',
          schema: JSON.stringify({ type: 'not-a-real-type' }),
          version: 3,
        }),
      ),
    ).rejects.toThrow(/invalid.*schema/i);
  });

  test('rejects non-object schema input (string)', async () => {
    seedApp({ version: 3 });

    await expect(
      invokeHandler(
        makeEvent('setAppConfigSchema', {
          appId: 'app-1',
          schema: JSON.stringify('just a string'),
          version: 3,
        }),
      ),
    ).rejects.toThrow(/invalid.*schema/i);
  });

  test('throws Conflict when the caller-supplied version does not match', async () => {
    seedApp({ version: 5 });

    await expect(
      invokeHandler(
        makeEvent('setAppConfigSchema', {
          appId: 'app-1',
          schema: JSON.stringify(VALID_SCHEMA),
          version: 3,
        }),
      ),
    ).rejects.toThrow(/Conflict/i);
  });

  test('throws when app not found', async () => {
    await expect(
      invokeHandler(
        makeEvent('setAppConfigSchema', {
          appId: 'nonexistent',
          schema: JSON.stringify(VALID_SCHEMA),
          version: 3,
        }),
      ),
    ).rejects.toThrow('App not found');
  });
});

// =====================================================================
// setAppConfigValues
// =====================================================================

describe('registry-agent-record-resolver — setAppConfigValues', () => {
  beforeEach(() => {
    resetMockRegistry();
    ebMock.reset();
    ebMock.on(PutEventsCommand).resolves({});
  });

  test('stores valid values and emits app.config.values.set event', async () => {
    seedApp({ version: 3, configSchema: VALID_SCHEMA });
    const values = { apiKey: 'sk-test-123', maxRetries: 3 };

    await invokeHandler(
      makeEvent('setAppConfigValues', {
        appId: 'app-1',
        values: JSON.stringify(values),
        version: 3,
      }),
    );

    const entries = ebMock
      .commandCalls(PutEventsCommand)
      .flatMap((c) => c.args[0].input.Entries ?? []);
    const set = entries.find((e) => e?.DetailType === 'app.config.values.set');
    expect(set).toBeDefined();
  });

  test('accepts values when no schema exists (allows any values)', async () => {
    const values = { anything: 'goes', nested: { deep: true } };
    seedApp({ version: 3, configSchema: null });

    const result = await invokeHandler(
      makeEvent('setAppConfigValues', {
        appId: 'app-1',
        values: JSON.stringify(values),
        version: 3,
      }),
    );

    expect(result).toBeDefined();
  });

  test('rejects values missing required properties', async () => {
    seedApp({ version: 3, configSchema: VALID_SCHEMA });

    await expect(
      invokeHandler(
        makeEvent('setAppConfigValues', {
          appId: 'app-1',
          values: JSON.stringify({ maxRetries: 3 }),
          version: 3,
        }),
      ),
    ).rejects.toThrow(/validation/i);
  });

  test('rejects values with wrong property types', async () => {
    seedApp({ version: 3, configSchema: VALID_SCHEMA });

    await expect(
      invokeHandler(
        makeEvent('setAppConfigValues', {
          appId: 'app-1',
          values: JSON.stringify({ apiKey: 12345, maxRetries: 3 }),
          version: 3,
        }),
      ),
    ).rejects.toThrow(/validation/i);
  });

  test('throws Conflict when caller-supplied version does not match manifest', async () => {
    seedApp({ version: 5 });

    await expect(
      invokeHandler(
        makeEvent('setAppConfigValues', {
          appId: 'app-1',
          values: JSON.stringify({ apiKey: 'sk-test-123' }),
          version: 3,
        }),
      ),
    ).rejects.toThrow(/Conflict/i);
  });

  test('throws when app not found', async () => {
    await expect(
      invokeHandler(
        makeEvent('setAppConfigValues', {
          appId: 'nonexistent',
          values: JSON.stringify({ apiKey: 'test' }),
          version: 3,
        }),
      ),
    ).rejects.toThrow('App not found');
  });
});
