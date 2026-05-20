/**
 * Property-based tests for JSON Schema validation correctness.
 *
 * Property 13: JSON Schema validation correctness
 * **Validates: Requirements 7.3**
 */
import * as fc from 'fast-check';
import { DynamoDBDocumentClient, GetCommand, PutCommand, QueryCommand, UpdateCommand } from '@aws-sdk/lib-dynamodb';
import { EventBridgeClient, PutEventsCommand } from '@aws-sdk/client-eventbridge';
import { CognitoIdentityProviderClient, AdminGetUserCommand } from '@aws-sdk/client-cognito-identity-provider';
import { mockClient } from 'aws-sdk-client-mock';

const ddbMock = mockClient(DynamoDBDocumentClient);
const ebMock = mockClient(EventBridgeClient);
const cognitoMock = mockClient(CognitoIdentityProviderClient);

jest.mock('../../utils/appsync', () => ({
  getUserId: jest.fn().mockReturnValue('user-123'),
}));

import { handler } from '../app-resolver';

// ── Helpers ─────────────────────────────────────────────────

function makeEvent(fieldName: string, args: any) {
  return {
    info: { fieldName },
    arguments: args,
    identity: { sub: 'user-123', claims: { sub: 'user-123' } },
  } as any;
}

function mockCognitoOrg(orgId: string) {
  cognitoMock.on(AdminGetUserCommand).resolves({
    UserAttributes: [
      { Name: 'sub', Value: 'user-123' },
      { Name: 'custom:organization', Value: orgId },
    ],
  });
}

const APP_ITEM = {
  appId: 'app-cfg',
  orgId: 'org-cfg',
  groupId: 'APP#app-cfg',
  sortId: 'METADATA',
  name: 'Config Test App',
  status: 'DRAFT',
  version: 1,
  workflowIds: [],
  createdBy: 'user-123',
  createdAt: '2024-01-01T00:00:00.000Z',
  updatedAt: '2024-01-01T00:00:00.000Z',
};

// ── Generators ──────────────────────────────────────────────

/** Valid JSON Schema type keywords per draft-07 */
const validSchemaTypeArb = fc.constantFrom(
  'object', 'string', 'number', 'integer', 'array', 'boolean', 'null',
);

/** Generate a valid JSON Schema object with a valid type keyword */
const validJsonSchemaArb = fc.record({
  type: validSchemaTypeArb,
  properties: fc.option(
    fc.dictionary(
      fc.string({ minLength: 1, maxLength: 30 }).filter(s => /^[a-zA-Z_][a-zA-Z0-9_]*$/.test(s)),
      fc.record({ type: validSchemaTypeArb }),
      { minKeys: 0, maxKeys: 5 },
    ),
    { nil: undefined },
  ),
}).map(schema => {
  const result: Record<string, any> = { type: schema.type };
  if (schema.properties !== undefined) {
    result.properties = schema.properties;
  }
  return result;
});

/** Strings that are NOT valid JSON Schema type keywords */
const invalidTypeArb = fc.string({ minLength: 1, maxLength: 30 })
  .filter(s => !['object', 'string', 'number', 'integer', 'array', 'boolean', 'null'].includes(s))
  .filter(s => s.trim().length > 0);

/** Non-object JSON values that should be rejected as schemas */
const nonObjectArb = fc.oneof(
  fc.string({ minLength: 0, maxLength: 50 }),
  fc.double({ min: -1e6, max: 1e6, noNaN: true }),
  fc.integer({ min: -1000, max: 1000 }),
  fc.boolean(),
  fc.constant(null),
  fc.array(fc.integer(), { minLength: 0, maxLength: 5 }),
);

// ── Property 13: JSON Schema validation correctness ─────────

describe('Property 13: JSON Schema validation correctness', () => {
  beforeAll(() => {
    process.env.APPS_TABLE = 'citadel-apps-test';
    process.env.WORKFLOWS_TABLE = 'citadel-workflows-test';
    process.env.EVENT_BUS_NAME = 'citadel-agents-test';
    process.env.USER_POOL_ID = 'us-east-1_test';
    process.env.AGENT_CONFIG_TABLE = 'citadel-agents-test';
  });

  beforeEach(() => {
    ddbMock.reset();
    ebMock.reset();
    cognitoMock.reset();
  });

  afterAll(() => {
    delete process.env.APPS_TABLE;
    delete process.env.WORKFLOWS_TABLE;
    delete process.env.EVENT_BUS_NAME;
    delete process.env.USER_POOL_ID;
    delete process.env.AGENT_CONFIG_TABLE;
  });

  /**
   * **Validates: Requirements 7.3**
   *
   * For any JSON object with a valid JSON Schema type keyword
   * (object, string, number, integer, array, boolean, null),
   * setAppConfigSchema should accept it without error.
   */
  it('valid JSON Schema objects with valid type keywords are accepted', () => {
    return fc.assert(
      fc.asyncProperty(validJsonSchemaArb, async (schema) => {
        ddbMock.reset();
        ebMock.reset();
        cognitoMock.reset();
        mockCognitoOrg('org-cfg');
        ebMock.on(PutEventsCommand).resolves({});
        ddbMock.on(GetCommand).resolves({ Item: APP_ITEM });
        ddbMock.on(UpdateCommand).resolves({ Attributes: { ...APP_ITEM, version: 2 } });
        ddbMock.on(PutCommand).resolves({});
        ddbMock.on(QueryCommand).resolves({ Items: [APP_ITEM] });

        const event = makeEvent('setAppConfigSchema', {
          appId: 'app-cfg',
          schema: JSON.stringify(schema),
          version: 1,
        });

        const result = await handler(event, {} as any, {} as any);
        expect(result).toBeDefined();
        expect(result.appId).toBe('app-cfg');
      }),
      { numRuns: 100 },
    );
  });

  /**
   * **Validates: Requirements 7.3**
   *
   * For any object with an invalid type value (not one of the
   * draft-07 type keywords), setAppConfigSchema should reject it.
   */
  it('objects with invalid type values are rejected', () => {
    return fc.assert(
      fc.asyncProperty(invalidTypeArb, async (invalidType) => {
        ddbMock.reset();
        ebMock.reset();
        cognitoMock.reset();
        mockCognitoOrg('org-cfg');
        ebMock.on(PutEventsCommand).resolves({});
        ddbMock.on(GetCommand).resolves({ Item: APP_ITEM });

        const invalidSchema = { type: invalidType };
        const event = makeEvent('setAppConfigSchema', {
          appId: 'app-cfg',
          schema: JSON.stringify(invalidSchema),
          version: 1,
        });

        await expect(
          handler(event, {} as any, {} as any),
        ).rejects.toThrow(/Invalid JSON Schema/);
      }),
      { numRuns: 100 },
    );
  });

  /**
   * **Validates: Requirements 7.3**
   *
   * Non-object values (strings, numbers, arrays, booleans, null)
   * should be rejected as schemas since JSON Schema must be an object.
   */
  it('non-object values are rejected as schemas', () => {
    return fc.assert(
      fc.asyncProperty(nonObjectArb, async (nonObject) => {
        ddbMock.reset();
        ebMock.reset();
        cognitoMock.reset();
        mockCognitoOrg('org-cfg');
        ebMock.on(PutEventsCommand).resolves({});
        ddbMock.on(GetCommand).resolves({ Item: APP_ITEM });

        const event = makeEvent('setAppConfigSchema', {
          appId: 'app-cfg',
          schema: JSON.stringify(nonObject),
          version: 1,
        });

        await expect(
          handler(event, {} as any, {} as any),
        ).rejects.toThrow(/Invalid JSON Schema/);
      }),
      { numRuns: 100 },
    );
  });
});

// ── Property 14: Config values validation against schema ────

/**
 * Property-based tests for config values validation against schema.
 *
 * Property 14: Config values validation against schema
 * **Validates: Requirements 7.4**
 */

// Fixed schema used across all P14 tests
const FIXED_SCHEMA = {
  type: 'object',
  properties: {
    apiKey: { type: 'string' },
    count: { type: 'number' },
  },
  required: ['apiKey'],
};

const SCHEMA_ITEM = {
  appId: 'app-cfg',
  groupId: 'APP#app-cfg',
  sortId: 'CONFIG#schema',
  schema: FIXED_SCHEMA,
};

// ── P14 Generators ──────────────────────────────────────────

/** Generate conforming values: apiKey is always a string, count is an optional number */
const conformingValuesArb = fc.record({
  apiKey: fc.string({ minLength: 1, maxLength: 100 }),
  count: fc.option(fc.double({ min: -1e6, max: 1e6, noNaN: true, noDefaultInfinity: true }), { nil: undefined }),
}).map(({ apiKey, count }) => {
  const obj: Record<string, any> = { apiKey };
  if (count !== undefined) {
    obj.count = count;
  }
  return obj;
});

/** Generate values missing the required 'apiKey' property */
const missingRequiredArb = fc.record({
  count: fc.option(fc.double({ min: -1e6, max: 1e6, noNaN: true, noDefaultInfinity: true }), { nil: undefined }),
}).map(({ count }) => {
  const obj: Record<string, any> = {};
  if (count !== undefined) {
    obj.count = count;
  }
  return obj;
});

/** Generate values where apiKey has a wrong type (not string) */
const wrongTypeApiKeyArb = fc.oneof(
  fc.integer({ min: -1000, max: 1000 }),
  fc.boolean(),
  fc.constant(null),
  fc.array(fc.integer(), { minLength: 0, maxLength: 3 }),
).map(badValue => ({ apiKey: badValue }));

describe('Property 14: Config values validation against schema', () => {
  beforeAll(() => {
    process.env.APPS_TABLE = 'citadel-apps-test';
    process.env.WORKFLOWS_TABLE = 'citadel-workflows-test';
    process.env.EVENT_BUS_NAME = 'citadel-agents-test';
    process.env.USER_POOL_ID = 'us-east-1_test';
    process.env.AGENT_CONFIG_TABLE = 'citadel-agents-test';
  });

  beforeEach(() => {
    ddbMock.reset();
    ebMock.reset();
    cognitoMock.reset();
  });

  afterAll(() => {
    delete process.env.APPS_TABLE;
    delete process.env.WORKFLOWS_TABLE;
    delete process.env.EVENT_BUS_NAME;
    delete process.env.USER_POOL_ID;
    delete process.env.AGENT_CONFIG_TABLE;
  });

  /**
   * **Validates: Requirements 7.4**
   *
   * For any JSON values object that conforms to the stored schema
   * (apiKey is a string, count is an optional number),
   * setAppConfigValues should accept it without error.
   */
  it('conforming values are accepted by setAppConfigValues', () => {
    return fc.assert(
      fc.asyncProperty(conformingValuesArb, async (values) => {
        ddbMock.reset();
        ebMock.reset();
        cognitoMock.reset();
        mockCognitoOrg('org-cfg');
        ebMock.on(PutEventsCommand).resolves({});
        ddbMock.on(GetCommand).resolves({ Item: APP_ITEM });
        ddbMock.on(QueryCommand).resolves({ Items: [APP_ITEM, SCHEMA_ITEM] });
        ddbMock.on(UpdateCommand).resolves({ Attributes: { ...APP_ITEM, version: 2 } });
        ddbMock.on(PutCommand).resolves({});

        const event = makeEvent('setAppConfigValues', {
          appId: 'app-cfg',
          values: JSON.stringify(values),
          version: 1,
        });

        const result = await handler(event, {} as any, {} as any);
        expect(result).toBeDefined();
      }),
      { numRuns: 100 },
    );
  });

  /**
   * **Validates: Requirements 7.4**
   *
   * For any values object missing the required 'apiKey' property,
   * setAppConfigValues should reject with a validation error.
   */
  it('values missing required properties are rejected', () => {
    return fc.assert(
      fc.asyncProperty(missingRequiredArb, async (values) => {
        ddbMock.reset();
        ebMock.reset();
        cognitoMock.reset();
        mockCognitoOrg('org-cfg');
        ebMock.on(PutEventsCommand).resolves({});
        ddbMock.on(GetCommand).resolves({ Item: APP_ITEM });
        ddbMock.on(QueryCommand).resolves({ Items: [APP_ITEM, SCHEMA_ITEM] });

        const event = makeEvent('setAppConfigValues', {
          appId: 'app-cfg',
          values: JSON.stringify(values),
          version: 1,
        });

        await expect(
          handler(event, {} as any, {} as any),
        ).rejects.toThrow(/Config validation failed/);
      }),
      { numRuns: 100 },
    );
  });

  /**
   * **Validates: Requirements 7.4**
   *
   * For any values object where apiKey has a wrong type (not string),
   * setAppConfigValues should reject with a validation error mentioning
   * the specific property.
   */
  it('values with wrong types are rejected with specific errors', () => {
    return fc.assert(
      fc.asyncProperty(wrongTypeApiKeyArb, async (values) => {
        ddbMock.reset();
        ebMock.reset();
        cognitoMock.reset();
        mockCognitoOrg('org-cfg');
        ebMock.on(PutEventsCommand).resolves({});
        ddbMock.on(GetCommand).resolves({ Item: APP_ITEM });
        ddbMock.on(QueryCommand).resolves({ Items: [APP_ITEM, SCHEMA_ITEM] });

        const event = makeEvent('setAppConfigValues', {
          appId: 'app-cfg',
          values: JSON.stringify(values),
          version: 1,
        });

        await expect(
          handler(event, {} as any, {} as any),
        ).rejects.toThrow(/Config validation failed/);
      }),
      { numRuns: 100 },
    );
  });
});
