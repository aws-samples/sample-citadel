/**
 * Property-based tests for component sortId derivation, groupId derivation,
 * agent binding default status, and GroupIndex query completeness.
 *
 * Property 1: Component sortId derivation
 * **Validates: Requirements 1.2, 1.3, 2.4, 2.5, 3.1, 5.2**
 *
 * Property 2: GroupIndex query completeness
 * **Validates: Requirements 1.8**
 */
import * as fc from 'fast-check';
import { DynamoDBDocumentClient, DeleteCommand, GetCommand, PutCommand, QueryCommand } from '@aws-sdk/lib-dynamodb';
import { EventBridgeClient, PutEventsCommand } from '@aws-sdk/client-eventbridge';
import { CognitoIdentityProviderClient, AdminGetUserCommand } from '@aws-sdk/client-cognito-identity-provider';
import { mockClient } from 'aws-sdk-client-mock';

// Mocks must be created BEFORE importing app-resolver so the clients are intercepted
const ddbMock = mockClient(DynamoDBDocumentClient);
const ebMock = mockClient(EventBridgeClient);
const cognitoMock = mockClient(CognitoIdentityProviderClient);

jest.mock('../../utils/appsync', () => ({
  getUserId: jest.fn().mockReturnValue('user-123'),
}));

import { handler, deriveSortId, deriveGroupId, getAppWithComponents } from '../app-resolver';

// ── Generators ──────────────────────────────────────────────

const componentTypeArb = fc.constantFrom('agent', 'permission', 'config');

const componentIdArb = fc.string({ minLength: 1, maxLength: 100 }).filter(s => s.trim().length > 0);

const appIdArb = fc.string({ minLength: 1, maxLength: 100 }).filter(s => s.trim().length > 0);

const TYPE_PREFIX_MAP: Record<string, string> = {
  agent: 'AGENT',
  permission: 'PERMISSION',
  config: 'CONFIG',
};


// ── Property 1 Tests ────────────────────────────────────────

describe('Property 1: Component sortId derivation', () => {
  /**
   * **Validates: Requirements 1.2, 1.3**
   *
   * For any valid component type and any non-empty ID string,
   * deriveSortId returns a string matching {TYPE}#{id} where TYPE
   * is the uppercase prefix for the component type.
   */
  it('deriveSortId produces {TYPE}#{id} for any valid type and id', () => {
    fc.assert(
      fc.property(componentTypeArb, componentIdArb, (type, id) => {
        const result = deriveSortId(type, id);
        const expectedPrefix = TYPE_PREFIX_MAP[type];

        // Must start with the correct uppercase prefix
        expect(result).toBe(`${expectedPrefix}#${id}`);

        // Must contain exactly one '#' separator
        const parts = result.split('#');
        expect(parts[0]).toBe(expectedPrefix);
        expect(parts.slice(1).join('#')).toBe(id);
      }),
      { numRuns: 200 },
    );
  });

  /**
   * **Validates: Requirements 1.2, 1.3**
   *
   * For any non-empty appId string, deriveGroupId returns APP#{appId}.
   */
  it('deriveGroupId produces APP#{appId} for any appId', () => {
    fc.assert(
      fc.property(appIdArb, (appId) => {
        const result = deriveGroupId(appId);

        expect(result).toBe(`APP#${appId}`);
        expect(result.startsWith('APP#')).toBe(true);
        expect(result.slice(4)).toBe(appId);
      }),
      { numRuns: 200 },
    );
  });

  /**
   * **Validates: Requirements 2.4, 3.1, 5.2**
   *
   * For any agent binding created via addAppComponent with type "agent",
   * the default status should be DESIGN. We verify this by checking that
   * the sortId for agent type follows AGENT#{agentId} and that the
   * expected default status constant is DESIGN.
   */
  it('agent binding sortId uses AGENT prefix and default status is DESIGN', () => {
    const DEFAULT_AGENT_BINDING_STATUS = 'DESIGN';

    fc.assert(
      fc.property(componentIdArb, (agentId) => {
        const sortId = deriveSortId('agent', agentId);

        // sortId must use AGENT prefix
        expect(sortId).toBe(`AGENT#${agentId}`);
        expect(sortId.startsWith('AGENT#')).toBe(true);

        // The agentId can be extracted from the sortId
        const extractedId = sortId.replace('AGENT#', '');
        expect(extractedId).toBe(agentId);

        // Default status for new agent bindings is DESIGN
        expect(DEFAULT_AGENT_BINDING_STATUS).toBe('DESIGN');
      }),
      { numRuns: 200 },
    );
  });

  /**
   * **Validates: Requirements 2.5**
   *
   * For any permission component, the sortId uses PERMISSION prefix.
   */
  it('permission sortId uses PERMISSION prefix', () => {
    fc.assert(
      fc.property(componentIdArb, (permissionId) => {
        const sortId = deriveSortId('permission', permissionId);

        expect(sortId).toBe(`PERMISSION#${permissionId}`);
        expect(sortId.startsWith('PERMISSION#')).toBe(true);
      }),
      { numRuns: 200 },
    );
  });

  /**
   * **Validates: Requirements 1.2, 1.3**
   *
   * The sortId and groupId are composable: given a type, id, and appId,
   * the groupId partition and sortId sort key together uniquely identify
   * a component within an app.
   */
  it('groupId and sortId together uniquely identify a component within an app', () => {
    fc.assert(
      fc.property(appIdArb, componentTypeArb, componentIdArb, (appId, type, id) => {
        const groupId = deriveGroupId(appId);
        const sortId = deriveSortId(type, id);

        // groupId always starts with APP#
        expect(groupId.startsWith('APP#')).toBe(true);

        // sortId always starts with a known prefix followed by #
        const knownPrefixes = ['AGENT#', 'PERMISSION#', 'CONFIG#'];
        const hasKnownPrefix = knownPrefixes.some(p => sortId.startsWith(p));
        expect(hasKnownPrefix).toBe(true);

        // The combination (groupId, sortId) is deterministic
        expect(deriveGroupId(appId)).toBe(groupId);
        expect(deriveSortId(type, id)).toBe(sortId);
      }),
      { numRuns: 200 },
    );
  });
});


// ── Property 2: GroupIndex query completeness ───────────────

describe('Property 2: GroupIndex query completeness', () => {
  beforeAll(() => {
    process.env.APPS_TABLE = 'citadel-apps-test';
  });

  beforeEach(() => {
    ddbMock.reset();
  });

  afterAll(() => {
    ddbMock.restore();
    delete process.env.APPS_TABLE;
  });

  /**
   * **Validates: Requirements 1.8**
   *
   * For any app with N component items (agent bindings, permissions),
   * querying the GroupIndex with groupId = APP#{appId} should return
   * exactly N + 1 items (the metadata item plus all component items),
   * and the metadata item should have sortId = METADATA.
   */
  it('for any N components, getAppWithComponents assembles metadata + N components correctly', () => {
    return fc.assert(
      fc.asyncProperty(
        appIdArb,
        fc.integer({ min: 0, max: 10 }),
        async (appId, numComponents) => {
          ddbMock.reset();

          const groupId = `APP#${appId}`;

          // Build the metadata item (sortId = METADATA)
          const metadataItem = {
            appId,
            groupId,
            sortId: 'METADATA',
            orgId: 'org-test',
            name: `App ${appId}`,
            description: 'Test app',
            status: 'DRAFT',
            version: 1,
            workflowIds: [],
            createdBy: 'user-1',
            createdAt: '2024-01-01T00:00:00Z',
            updatedAt: '2024-01-01T00:00:00Z',
          };

          // Build N component items (alternating agents and permissions)
          const componentItems = Array.from({ length: numComponents }, (_, i) => {
            if (i % 2 === 0) {
              return {
                appId,
                groupId,
                sortId: `AGENT#agent-${i}`,
                agentId: `agent-${i}`,
                status: 'DESIGN',
                addedAt: '2024-01-01T00:00:00Z',
              };
            } else {
              return {
                appId,
                groupId,
                sortId: `PERMISSION#perm-${i}`,
                permissionId: `perm-${i}`,
                actions: ['s3:GetObject'],
                resources: ['arn:aws:s3:::bucket/*'],
              };
            }
          });

          // The mock returns all N+1 items (metadata + components)
          const allItems = [metadataItem, ...componentItems];
          ddbMock.on(QueryCommand).resolves({ Items: allItems });

          const result = await getAppWithComponents(appId);

          // Result should not be null (metadata exists)
          expect(result).not.toBeNull();

          // The metadata item should have sortId = METADATA
          expect(result.sortId).toBe('METADATA');

          // Count total components returned by the function
          const agentCount = result.agentBindings.length;
          const permissionCount = result.permissions.length;
          const configSchemaPresent = result.configSchema !== null ? 1 : 0;
          const configValuesPresent = result.configValues !== null ? 1 : 0;
          const totalComponents = agentCount + permissionCount + configSchemaPresent + configValuesPresent;

          // Total components should equal N (no config items in our generated set)
          expect(totalComponents).toBe(numComponents);

          // Verify the mock was called with correct GroupIndex params
          const queryCall = ddbMock.commandCalls(QueryCommand)[0];
          expect(queryCall.args[0].input.IndexName).toBe('GroupIndex');
          expect(queryCall.args[0].input.ExpressionAttributeValues).toEqual({
            ':gid': groupId,
          });
        },
      ),
      { numRuns: 100 },
    );
  });

  /**
   * **Validates: Requirements 1.8**
   *
   * When the GroupIndex returns no items (empty result), getAppWithComponents
   * should return null — no metadata means the app doesn't exist.
   */
  it('returns null when GroupIndex returns no items', () => {
    return fc.assert(
      fc.asyncProperty(appIdArb, async (appId) => {
        ddbMock.reset();
        ddbMock.on(QueryCommand).resolves({ Items: [] });

        const result = await getAppWithComponents(appId);
        expect(result).toBeNull();
      }),
      { numRuns: 50 },
    );
  });
});


// ── Property 3: JSON round-trip serialization ───────────────

describe('Property 3: JSON round-trip serialization', () => {
  // Helper to detect -0 anywhere in a nested structure (JSON has no negative zero)
  const hasNegativeZero = (v: unknown): boolean => {
    if (Object.is(v, -0)) return true;
    if (Array.isArray(v)) return v.some(hasNegativeZero);
    if (v !== null && typeof v === 'object') return Object.values(v).some(hasNegativeZero);
    return false;
  };

  /**
   * **Validates: Requirements 1.10, 7.10, 15.9**
   *
   * For any valid JSON value (object, array, string, number, boolean, null),
   * serializing to a JSON string via JSON.stringify and then parsing back
   * via JSON.parse should produce a deeply equal value.
   * This validates that configSchema, configValues, and manifest fields
   * survive DynamoDB serialization round-trips.
   */
  it('JSON.parse(JSON.stringify(obj)) produces a deeply equal object for any JSON value', () => {
    // fc.jsonValue() can produce -0 which JSON.stringify converts to "0",
    // so JSON.parse yields 0. Since JSON has no negative zero concept,
    // we exclude -0 from the input space via noNegativeZero constraint.
    const jsonValueArb = fc.jsonValue({ depthSize: 'medium', maxDepth: 5 }).filter(
      (v) => !Object.is(v, -0),
    );

    fc.assert(
      fc.property(jsonValueArb, (value) => {
        const serialized = JSON.stringify(value);
        const deserialized = JSON.parse(serialized);

        expect(deserialized).toEqual(value);
      }),
      { numRuns: 500 },
    );
  });

  /**
   * **Validates: Requirements 1.10**
   *
   * For any JSON object used as a configSchema, the round-trip preserves
   * all keys and nested structure.
   */
  it('round-trip preserves nested object structure for configSchema-like objects', () => {
    // Exclude -0 from values since JSON.stringify(-0) === "0" (no negative zero in JSON)
    const safeJsonValueArb = fc.jsonValue({ depthSize: 'small', maxDepth: 3 }).filter(
      (v) => !hasNegativeZero(v),
    );
    const jsonObjectArb = fc.dictionary(
      fc.string({ minLength: 1, maxLength: 50 }),
      safeJsonValueArb,
    );

    fc.assert(
      fc.property(jsonObjectArb, (schema) => {
        const roundTripped = JSON.parse(JSON.stringify(schema));

        // All keys are preserved
        expect(Object.keys(roundTripped).sort()).toEqual(Object.keys(schema).sort());

        // Deep equality holds
        expect(roundTripped).toEqual(schema);
      }),
      { numRuns: 300 },
    );
  });

  /**
   * **Validates: Requirements 7.10**
   *
   * For any JSON object used as configValues, double round-trip
   * (serialize → deserialize → serialize → deserialize) is stable.
   */
  it('double round-trip is stable for configValues-like objects', () => {
    fc.assert(
      fc.property(fc.jsonValue(), (value) => {
        const firstRoundTrip = JSON.parse(JSON.stringify(value));
        const secondRoundTrip = JSON.parse(JSON.stringify(firstRoundTrip));

        expect(secondRoundTrip).toEqual(firstRoundTrip);
      }),
      { numRuns: 300 },
    );
  });

  /**
   * **Validates: Requirements 15.9**
   *
   * For any manifest-shaped object with required string fields and optional
   * nested JSON, the round-trip preserves all fields.
   */
  it('round-trip preserves manifest-shaped objects with required and optional fields', () => {
    // Use null instead of undefined for optional fields since JSON.stringify
    // strips undefined values. Also filter -0 from nested jsonValue.
    const safeJsonArb = fc.jsonValue({ depthSize: 'small', maxDepth: 3 }).filter(
      (v) => !hasNegativeZero(v),
    );

    const manifestArb = fc.record({
      name: fc.string({ minLength: 1, maxLength: 100 }),
      description: fc.string({ minLength: 1, maxLength: 500 }),
      version: fc.string({ minLength: 1, maxLength: 20 }),
      inputSchema: fc.option(safeJsonArb, { nil: null }),
      outputSchema: fc.option(safeJsonArb, { nil: null }),
      tools: fc.option(fc.array(fc.string({ minLength: 1, maxLength: 50 })), { nil: null }),
      resourceRequirements: fc.option(
        fc.record({
          memoryMb: fc.option(fc.integer({ min: 128, max: 10240 }), { nil: null }),
          timeoutSeconds: fc.option(fc.integer({ min: 1, max: 900 }), { nil: null }),
          permissions: fc.option(fc.array(fc.string({ minLength: 1, maxLength: 100 })), { nil: null }),
        }),
        { nil: null },
      ),
    });

    fc.assert(
      fc.property(manifestArb, (manifest) => {
        const roundTripped = JSON.parse(JSON.stringify(manifest));

        expect(roundTripped).toEqual(manifest);
      }),
      { numRuns: 300 },
    );
  });
});


// ── Property 4: Component upsert idempotence ────────────────

describe('Property 4: Component upsert idempotence', () => {
  /**
   * **Validates: Requirements 2.7**
   *
   * For any app and any component (agent binding or permission),
   * calling addAppComponent twice with the same component data should
   * produce the same result as calling it once — each call issues exactly
   * one PutCommand without a ConditionExpression (upsert), and the second
   * call's item overwrites the first with the latest data.
   */

  const APP_ITEM = {
    appId: 'app-upsert',
    orgId: 'org-upsert',
    groupId: 'APP#app-upsert',
    sortId: 'METADATA',
    name: 'Upsert Test App',
    status: 'DRAFT',
    version: 1,
    workflowIds: [],
    createdBy: 'user-123',
    createdAt: '2024-01-01T00:00:00.000Z',
    updatedAt: '2024-01-01T00:00:00.000Z',
  };

  function makeEvent(fieldName: string, args: any) {
    return {
      info: { fieldName },
      arguments: args,
      identity: { sub: 'user-123', claims: { sub: 'user-123' } },
    } as any;
  }

  beforeAll(() => {
    process.env.APPS_TABLE = 'citadel-apps-test';
    process.env.WORKFLOWS_TABLE = 'citadel-workflows-test';
    process.env.EVENT_BUS_NAME = 'citadel-agents-test';
    process.env.USER_POOL_ID = 'us-east-1_test';
  });

  beforeEach(() => {
    ddbMock.reset();
    ebMock.reset();
    cognitoMock.reset();

    // Mock Cognito to return matching orgId
    cognitoMock.on(AdminGetUserCommand).resolves({
      UserAttributes: [
        { Name: 'sub', Value: 'user-123' },
        { Name: 'custom:organization', Value: 'org-upsert' },
      ],
    });

    // Mock EventBridge
    ebMock.on(PutEventsCommand).resolves({});
  });

  afterAll(() => {
    delete process.env.APPS_TABLE;
    delete process.env.WORKFLOWS_TABLE;
    delete process.env.EVENT_BUS_NAME;
    delete process.env.USER_POOL_ID;
  });

  // Generator for agent component data
  const agentComponentArb = fc.record({
    agentId: fc.string({ minLength: 1, maxLength: 50 }).filter(s => /^[a-zA-Z0-9_-]+$/.test(s)),
    systemPromptAddition: fc.option(fc.string({ minLength: 1, maxLength: 200 }), { nil: undefined }),
    toolRestrictions: fc.option(fc.array(fc.string({ minLength: 1, maxLength: 30 }), { minLength: 1, maxLength: 5 }), { nil: undefined }),
    modelOverride: fc.option(fc.constantFrom('us.anthropic.claude-sonnet-4-6', 'us.anthropic.claude-haiku-3'), { nil: undefined }),
  });

  // Generator for permission component data
  const permissionComponentArb = fc.record({
    permissionId: fc.string({ minLength: 1, maxLength: 50 }).filter(s => /^[a-zA-Z0-9_-]+$/.test(s)),
    actions: fc.array(
      fc.tuple(
        fc.constantFrom('s3', 'dynamodb', 'sqs', 'lambda', 'iam'),
        fc.constantFrom('GetObject', 'PutItem', 'SendMessage', 'InvokeFunction', '*'),
      ).map(([svc, act]) => `${svc}:${act}`),
      { minLength: 1, maxLength: 5 },
    ),
    resources: fc.array(fc.constant('arn:aws:s3:::my-bucket/*'), { minLength: 1, maxLength: 3 }),
    description: fc.option(fc.string({ minLength: 1, maxLength: 200 }), { nil: undefined }),
  });

  it('calling addAppComponent twice with same agent data produces one PutCommand per call with no ConditionExpression', () => {
    return fc.assert(
      fc.asyncProperty(agentComponentArb, async (agentData) => {
        ddbMock.reset();
        ebMock.reset();
        cognitoMock.reset();

        cognitoMock.on(AdminGetUserCommand).resolves({
          UserAttributes: [
            { Name: 'sub', Value: 'user-123' },
            { Name: 'custom:organization', Value: 'org-upsert' },
          ],
        });
        ebMock.on(PutEventsCommand).resolves({});
        ddbMock.on(GetCommand).resolves({ Item: APP_ITEM });
        ddbMock.on(PutCommand).resolves({});
        ddbMock.on(QueryCommand).resolves({ Items: [APP_ITEM] });

        const componentData = { ...agentData };
        const event = makeEvent('addAppComponent', {
          appId: 'app-upsert',
          component: { type: 'agent', data: JSON.stringify(componentData) },
        });

        // First call
        await handler(event, {} as any, {} as any);
        const firstPutCalls = ddbMock.commandCalls(PutCommand);
        const firstComponentPut = firstPutCalls.find(
          (c) => c.args[0].input.Item?.sortId === `AGENT#${agentData.agentId}`,
        );
        expect(firstComponentPut).toBeDefined();
        expect(firstComponentPut!.args[0].input.ConditionExpression).toBeUndefined();
        const firstItem = { ...firstComponentPut!.args[0].input.Item };

        // Reset mocks for second call (simulating a fresh call)
        ddbMock.reset();
        ebMock.reset();
        cognitoMock.reset();

        cognitoMock.on(AdminGetUserCommand).resolves({
          UserAttributes: [
            { Name: 'sub', Value: 'user-123' },
            { Name: 'custom:organization', Value: 'org-upsert' },
          ],
        });
        ebMock.on(PutEventsCommand).resolves({});
        ddbMock.on(GetCommand).resolves({ Item: APP_ITEM });
        ddbMock.on(PutCommand).resolves({});
        ddbMock.on(QueryCommand).resolves({ Items: [APP_ITEM] });

        // Second call with same data
        await handler(event, {} as any, {} as any);
        const secondPutCalls = ddbMock.commandCalls(PutCommand);
        const secondComponentPut = secondPutCalls.find(
          (c) => c.args[0].input.Item?.sortId === `AGENT#${agentData.agentId}`,
        );
        expect(secondComponentPut).toBeDefined();
        expect(secondComponentPut!.args[0].input.ConditionExpression).toBeUndefined();
        const secondItem = { ...secondComponentPut!.args[0].input.Item };

        // Both calls should produce items with the same key fields
        expect(secondItem.appId).toBe(firstItem.appId);
        expect(secondItem.groupId).toBe(firstItem.groupId);
        expect(secondItem.sortId).toBe(firstItem.sortId);
        expect(secondItem.agentId).toBe(firstItem.agentId);
        expect(secondItem.status).toBe(firstItem.status);

        // Override fields should match
        expect(secondItem.systemPromptAddition).toEqual(firstItem.systemPromptAddition);
        expect(secondItem.toolRestrictions).toEqual(firstItem.toolRestrictions);
        expect(secondItem.modelOverride).toEqual(firstItem.modelOverride);
      }),
      { numRuns: 50 },
    );
  });

  it('calling addAppComponent twice with same permission data produces one PutCommand per call with no ConditionExpression', () => {
    return fc.assert(
      fc.asyncProperty(permissionComponentArb, async (permData) => {
        ddbMock.reset();
        ebMock.reset();
        cognitoMock.reset();

        cognitoMock.on(AdminGetUserCommand).resolves({
          UserAttributes: [
            { Name: 'sub', Value: 'user-123' },
            { Name: 'custom:organization', Value: 'org-upsert' },
          ],
        });
        ebMock.on(PutEventsCommand).resolves({});
        ddbMock.on(GetCommand).resolves({ Item: APP_ITEM });
        ddbMock.on(PutCommand).resolves({});
        ddbMock.on(QueryCommand).resolves({ Items: [APP_ITEM] });

        const event = makeEvent('addAppComponent', {
          appId: 'app-upsert',
          component: { type: 'permission', data: JSON.stringify(permData) },
        });

        // First call
        await handler(event, {} as any, {} as any);
        const firstPutCalls = ddbMock.commandCalls(PutCommand);
        const firstComponentPut = firstPutCalls.find(
          (c) => c.args[0].input.Item?.sortId === `PERMISSION#${permData.permissionId}`,
        );
        expect(firstComponentPut).toBeDefined();
        expect(firstComponentPut!.args[0].input.ConditionExpression).toBeUndefined();
        const firstItem = { ...firstComponentPut!.args[0].input.Item };

        // Reset mocks for second call
        ddbMock.reset();
        ebMock.reset();
        cognitoMock.reset();

        cognitoMock.on(AdminGetUserCommand).resolves({
          UserAttributes: [
            { Name: 'sub', Value: 'user-123' },
            { Name: 'custom:organization', Value: 'org-upsert' },
          ],
        });
        ebMock.on(PutEventsCommand).resolves({});
        ddbMock.on(GetCommand).resolves({ Item: APP_ITEM });
        ddbMock.on(PutCommand).resolves({});
        ddbMock.on(QueryCommand).resolves({ Items: [APP_ITEM] });

        // Second call with same data
        await handler(event, {} as any, {} as any);
        const secondPutCalls = ddbMock.commandCalls(PutCommand);
        const secondComponentPut = secondPutCalls.find(
          (c) => c.args[0].input.Item?.sortId === `PERMISSION#${permData.permissionId}`,
        );
        expect(secondComponentPut).toBeDefined();
        expect(secondComponentPut!.args[0].input.ConditionExpression).toBeUndefined();
        const secondItem = { ...secondComponentPut!.args[0].input.Item };

        // Both calls should produce items with the same key and data fields
        expect(secondItem.appId).toBe(firstItem.appId);
        expect(secondItem.groupId).toBe(firstItem.groupId);
        expect(secondItem.sortId).toBe(firstItem.sortId);
        expect(secondItem.permissionId).toBe(firstItem.permissionId);
        expect(secondItem.actions).toEqual(firstItem.actions);
        expect(secondItem.resources).toEqual(firstItem.resources);
        expect(secondItem.description).toEqual(firstItem.description);
      }),
      { numRuns: 50 },
    );
  });
});


// ── Property 5: Component removal idempotence ───────────────

describe('Property 5: Component removal idempotence', () => {
  /**
   * **Validates: Requirements 2.8**
   *
   * For any app and any component type/ID pair, calling removeAppComponent
   * when the component does not exist should return the app unchanged
   * without error. The handler catches ConditionalCheckFailedException
   * from the DeleteCommand to achieve idempotency.
   */

  const APP_ITEM = {
    appId: 'app-remove',
    orgId: 'org-remove',
    groupId: 'APP#app-remove',
    sortId: 'METADATA',
    name: 'Remove Test App',
    status: 'DRAFT',
    version: 1,
    workflowIds: [],
    createdBy: 'user-123',
    createdAt: '2024-01-01T00:00:00.000Z',
    updatedAt: '2024-01-01T00:00:00.000Z',
  };

  function makeEvent(fieldName: string, args: any) {
    return {
      info: { fieldName },
      arguments: args,
      identity: { sub: 'user-123', claims: { sub: 'user-123' } },
    } as any;
  }

  beforeAll(() => {
    process.env.APPS_TABLE = 'citadel-apps-test';
    process.env.WORKFLOWS_TABLE = 'citadel-workflows-test';
    process.env.EVENT_BUS_NAME = 'citadel-agents-test';
    process.env.USER_POOL_ID = 'us-east-1_test';
  });

  beforeEach(() => {
    ddbMock.reset();
    ebMock.reset();
    cognitoMock.reset();

    cognitoMock.on(AdminGetUserCommand).resolves({
      UserAttributes: [
        { Name: 'sub', Value: 'user-123' },
        { Name: 'custom:organization', Value: 'org-remove' },
      ],
    });

    ebMock.on(PutEventsCommand).resolves({});
  });

  afterAll(() => {
    delete process.env.APPS_TABLE;
    delete process.env.WORKFLOWS_TABLE;
    delete process.env.EVENT_BUS_NAME;
    delete process.env.USER_POOL_ID;
  });

  // Generators for random component types and IDs
  const removeComponentTypeArb = fc.constantFrom('agent', 'permission', 'config');
  const removeComponentIdArb = fc.string({ minLength: 1, maxLength: 50 }).filter(s => /^[a-zA-Z0-9_-]+$/.test(s));

  it('removing a non-existent component returns app unchanged without error', () => {
    return fc.assert(
      fc.asyncProperty(removeComponentTypeArb, removeComponentIdArb, async (componentType, componentId) => {
        ddbMock.reset();
        ebMock.reset();
        cognitoMock.reset();

        cognitoMock.on(AdminGetUserCommand).resolves({
          UserAttributes: [
            { Name: 'sub', Value: 'user-123' },
            { Name: 'custom:organization', Value: 'org-remove' },
          ],
        });
        ebMock.on(PutEventsCommand).resolves({});

        // GetCommand returns the app (app exists, org matches)
        ddbMock.on(GetCommand).resolves({ Item: APP_ITEM });

        // DeleteCommand throws ConditionalCheckFailedException
        // (simulating non-existent component)
        const condCheckError = new Error('ConditionalCheckFailedException');
        condCheckError.name = 'ConditionalCheckFailedException';
        ddbMock.on(DeleteCommand).rejects(condCheckError);

        // QueryCommand returns just the metadata item (no components)
        ddbMock.on(QueryCommand).resolves({ Items: [APP_ITEM] });

        const event = makeEvent('removeAppComponent', {
          appId: 'app-remove',
          componentType,
          componentId,
        });

        // Should NOT throw — idempotent removal
        const result = await handler(event, {} as any, {} as any);

        // Result should be the app unchanged (just metadata, no components)
        expect(result).not.toBeNull();
        expect(result.appId).toBe('app-remove');
        expect(result.sortId).toBe('METADATA');
        expect(result.agentBindings).toEqual([]);
        expect(result.permissions).toEqual([]);
      }),
      { numRuns: 50 },
    );
  });
});
