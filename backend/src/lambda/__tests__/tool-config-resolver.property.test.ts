// Feature: tool-integration-binding, Property 1: ToolConfig Binding Round-Trip
import * as fc from 'fast-check';

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
    ScanCommand: jest.fn().mockImplementation((input) => ({ _type: 'Scan', input })),
    DeleteCommand: jest.fn().mockImplementation((input) => ({ _type: 'Delete', input })),
  };
});

// Set env before import
process.env.TOOLS_CONFIG_TABLE = 'TestToolsConfigTable';

// Import handler after all mocks
import { handler } from '../tool-config-resolver';

// ---- Generators ----

const integrationTypeArb = fc.constantFrom(
  'CONFLUENCE', 'JIRA', 'SLACK', 'SERVICENOW',
  'ZENDESK', 'PAGERDUTY', 'MICROSOFT',
  'AWS_LAMBDA', 'AWS_SMITHY', 'MCP_SERVER',
);

const dataStoreTypeArb = fc.constantFrom(
  'S3', 'DYNAMODB', 'RDS_POSTGRESQL', 'RDS_MYSQL',
  'AURORA_POSTGRESQL', 'AURORA_MYSQL', 'REDSHIFT', 'OPENSEARCH',
  'NEPTUNE', 'TIMESTREAM', 'ELASTICACHE_REDIS', 'DOCUMENTDB',
  'KNOWLEDGE_BASE',
);

const operationIdArb = fc.stringMatching(/^[a-z][a-z_]{2,20}$/);

/** Binding shapes generated below; `direction` is absent in the legacy arbs. */
interface IntegrationBinding {
  integrationId: string;
  integrationType: string;
  operations?: string[] | undefined;
  direction?: string;
}

interface DataStoreBinding {
  dataStoreId: string;
  dataStoreType: string;
  operations?: string[] | undefined;
  direction?: string;
}

const integrationBindingArb: fc.Arbitrary<IntegrationBinding> = fc.record({
  integrationId: fc.stringMatching(/^int-[a-z0-9]{6,12}$/),
  integrationType: integrationTypeArb,
  operations: fc.option(fc.array(operationIdArb, { minLength: 1, maxLength: 5 }), { nil: undefined }),
});

const dataStoreBindingArb: fc.Arbitrary<DataStoreBinding> = fc.record({
  dataStoreId: fc.stringMatching(/^ds-[a-z0-9]{6,12}$/),
  dataStoreType: dataStoreTypeArb,
  operations: fc.option(fc.array(operationIdArb, { minLength: 1, maxLength: 5 }), { nil: undefined }),
});

const toolIdArb = fc.stringMatching(/^tool-[a-z0-9]{4,12}$/);

/**
 * Shape produced by the lib-dynamodb command mocks at the top of this file
 * (each command constructor is replaced by `{ _type, input }`).
 */
interface FakeCommand {
  _type: 'Put' | 'Get' | 'Scan' | 'Delete';
  input: { Item?: Record<string, unknown> };
}

/** Result fields the assertions below read off resolver results. */
interface ToolConfigResult {
  integrationBindings?: IntegrationBinding[] | null;
  dataStoreBindings?: DataStoreBinding[] | null;
}

function makeEvent(fieldName: string, args: Record<string, unknown>) {
  return {
    info: { fieldName },
    arguments: args,
  };
}

// ---- Tests ----

beforeEach(() => {
  mockDynamoSend.mockReset();
});

/**
 * Property 1: ToolConfig Binding Round-Trip
 *
 * For any valid ToolConfig input containing integrationBindings and/or dataStoreBindings,
 * creating the tool config via createToolConfig and then reading it back via getToolConfig
 * should return bindings that are deeply equal to the original input bindings.
 *
 * **Validates: Requirements 1.1, 1.2, 1.3, 1.5**
 */
describe('Property 1: ToolConfig Binding Round-Trip', () => {
  it('createToolConfig followed by getToolConfig returns deeply equal bindings', () => {
    return fc.assert(
      fc.asyncProperty(
        toolIdArb,
        fc.array(integrationBindingArb, { minLength: 0, maxLength: 4 }),
        fc.array(dataStoreBindingArb, { minLength: 0, maxLength: 4 }),
        async (toolId, integrationBindings, dataStoreBindings) => {
          mockDynamoSend.mockReset();

          // Capture what PutCommand receives so we can return it from GetCommand
          let storedItem: Record<string, unknown> | null = null;

          mockDynamoSend.mockImplementation((cmd: FakeCommand) => {
            if (cmd._type === 'Put') {
              storedItem = { ...cmd.input.Item };
              return Promise.resolve({});
            }
            if (cmd._type === 'Get') {
              return Promise.resolve({ Item: storedItem ? { ...storedItem } : undefined });
            }
            return Promise.resolve({});
          });

          const configObj = { name: `tool_${toolId}`, filename: `${toolId}.py`, version: '1', description: 'test' };

          const input: Record<string, unknown> = {
            toolId,
            config: JSON.stringify(configObj),
          };

          if (integrationBindings.length > 0) {
            input.integrationBindings = integrationBindings;
          }
          if (dataStoreBindings.length > 0) {
            input.dataStoreBindings = dataStoreBindings;
          }

          // Create the tool config
          await handler(makeEvent('createToolConfig', { input }));

          // Read it back
          const result = await handler(makeEvent("getToolConfig", { toolId })) as ToolConfigResult;

          // Assert bindings round-trip
          if (integrationBindings.length > 0) {
            const expectedIntBindings = integrationBindings.map((b) => ({
              ...b,
              direction: b.direction ? b.direction.toUpperCase() : 'BIDIRECTIONAL',
            }));
            expect(result.integrationBindings).toEqual(expectedIntBindings);
          } else {
            // When no bindings provided, should be null or undefined (backward compat)
            expect(result.integrationBindings ?? null).toBeNull();
          }

          if (dataStoreBindings.length > 0) {
            const expectedDsBindings = dataStoreBindings.map((b) => ({
              ...b,
              direction: b.direction ? b.direction.toUpperCase() : 'BIDIRECTIONAL',
            }));
            expect(result.dataStoreBindings).toEqual(expectedDsBindings);
          } else {
            // When no bindings provided, should be null or undefined (backward compat)
            expect(result.dataStoreBindings ?? null).toBeNull();
          }
        }
      ),
      { numRuns: 100 }
    );
  });
});

// Feature: tool-integration-binding, Property 2: Partial Update Preserves Unrelated Bindings

/**
 * Property 2: ToolConfig Partial Update Preserves Unrelated Bindings
 *
 * For any existing ToolConfig with both integrationBindings and dataStoreBindings,
 * updating only integrationBindings via updateToolConfig should preserve the existing
 * dataStoreBindings unchanged, and vice versa.
 *
 * **Validates: Requirements 1.4**
 */
describe('Property 2: Partial Update Preserves Unrelated Bindings', () => {
  it('updating only integrationBindings preserves dataStoreBindings', () => {
    return fc.assert(
      fc.asyncProperty(
        toolIdArb,
        fc.array(integrationBindingArb, { minLength: 1, maxLength: 4 }),
        fc.array(dataStoreBindingArb, { minLength: 1, maxLength: 4 }),
        fc.array(integrationBindingArb, { minLength: 1, maxLength: 4 }),
        async (toolId, originalIntBindings, originalDsBindings, updatedIntBindings) => {
          mockDynamoSend.mockReset();

          // In-memory store keyed by toolId
          let storedItem: Record<string, unknown> | null = null;

          mockDynamoSend.mockImplementation((cmd: FakeCommand) => {
            if (cmd._type === 'Put') {
              storedItem = { ...cmd.input.Item };
              return Promise.resolve({});
            }
            if (cmd._type === 'Get') {
              // Return a deep copy so mutations don't leak
              return Promise.resolve({
                Item: storedItem ? JSON.parse(JSON.stringify(storedItem)) : undefined,
              });
            }
            return Promise.resolve({});
          });

          const configObj = { name: `tool_${toolId}`, filename: `${toolId}.py`, version: '1', description: 'test' };

          // Step 1: Create with both binding types
          await handler(makeEvent('createToolConfig', {
            input: {
              toolId,
              config: JSON.stringify(configObj),
              integrationBindings: originalIntBindings,
              dataStoreBindings: originalDsBindings,
            },
          }));

          // Step 2: Update only integrationBindings (omit dataStoreBindings from input)
          await handler(makeEvent('updateToolConfig', {
            input: {
              toolId,
              integrationBindings: updatedIntBindings,
            },
          }));

          // Step 3: Read back and verify
          const result = await handler(makeEvent("getToolConfig", { toolId })) as ToolConfigResult;

          // integrationBindings should reflect the update
          const expectedUpdatedInt = updatedIntBindings.map((b) => ({
            ...b,
            direction: b.direction ? b.direction.toUpperCase() : 'BIDIRECTIONAL',
          }));
          expect(result.integrationBindings).toEqual(expectedUpdatedInt);

          // dataStoreBindings should be preserved unchanged
          const expectedOriginalDs = originalDsBindings.map((b) => ({
            ...b,
            direction: b.direction ? b.direction.toUpperCase() : 'BIDIRECTIONAL',
          }));
          expect(result.dataStoreBindings).toEqual(expectedOriginalDs);
        }
      ),
      { numRuns: 100 }
    );
  });

  it('updating only dataStoreBindings preserves integrationBindings', () => {
    return fc.assert(
      fc.asyncProperty(
        toolIdArb,
        fc.array(integrationBindingArb, { minLength: 1, maxLength: 4 }),
        fc.array(dataStoreBindingArb, { minLength: 1, maxLength: 4 }),
        fc.array(dataStoreBindingArb, { minLength: 1, maxLength: 4 }),
        async (toolId, originalIntBindings, originalDsBindings, updatedDsBindings) => {
          mockDynamoSend.mockReset();

          let storedItem: Record<string, unknown> | null = null;

          mockDynamoSend.mockImplementation((cmd: FakeCommand) => {
            if (cmd._type === 'Put') {
              storedItem = { ...cmd.input.Item };
              return Promise.resolve({});
            }
            if (cmd._type === 'Get') {
              return Promise.resolve({
                Item: storedItem ? JSON.parse(JSON.stringify(storedItem)) : undefined,
              });
            }
            return Promise.resolve({});
          });

          const configObj = { name: `tool_${toolId}`, filename: `${toolId}.py`, version: '1', description: 'test' };

          // Step 1: Create with both binding types
          await handler(makeEvent('createToolConfig', {
            input: {
              toolId,
              config: JSON.stringify(configObj),
              integrationBindings: originalIntBindings,
              dataStoreBindings: originalDsBindings,
            },
          }));

          // Step 2: Update only dataStoreBindings (omit integrationBindings from input)
          await handler(makeEvent('updateToolConfig', {
            input: {
              toolId,
              dataStoreBindings: updatedDsBindings,
            },
          }));

          // Step 3: Read back and verify
          const result = await handler(makeEvent("getToolConfig", { toolId })) as ToolConfigResult;

          // dataStoreBindings should reflect the update
          const expectedUpdatedDs = updatedDsBindings.map((b) => ({
            ...b,
            direction: b.direction ? b.direction.toUpperCase() : 'BIDIRECTIONAL',
          }));
          expect(result.dataStoreBindings).toEqual(expectedUpdatedDs);

          // integrationBindings should be preserved unchanged
          const expectedOriginalInt = originalIntBindings.map((b) => ({
            ...b,
            direction: b.direction ? b.direction.toUpperCase() : 'BIDIRECTIONAL',
          }));
          expect(result.integrationBindings).toEqual(expectedOriginalInt);
        }
      ),
      { numRuns: 100 }
    );
  });
});


// Feature: datastore-integration-pipeline, Property 3: Direction Field Round-Trip
// Validates: Requirements 8.1, 8.2, 8.5

const directionArb = fc.constantFrom('INPUT', 'OUTPUT', 'BIDIRECTIONAL');

const integrationBindingWithDirectionArb = fc.record({
  integrationId: fc.stringMatching(/^int-[a-z0-9]{6,12}$/),
  integrationType: integrationTypeArb,
  operations: fc.option(fc.array(operationIdArb, { minLength: 1, maxLength: 5 }), { nil: undefined }),
  direction: directionArb,
});

const dataStoreBindingWithDirectionArb = fc.record({
  dataStoreId: fc.stringMatching(/^ds-[a-z0-9]{6,12}$/),
  dataStoreType: dataStoreTypeArb,
  operations: fc.option(fc.array(operationIdArb, { minLength: 1, maxLength: 5 }), { nil: undefined }),
  direction: directionArb,
});

/**
 * Property 3: Direction Field Round-Trip
 *
 * For any valid ToolConfig input with integrationBindings and dataStoreBindings
 * where each binding has a `direction` from {input, output, bidirectional},
 * creating the tool config via createToolConfig and then reading it back via
 * getToolConfig should return bindings with `direction` fields deeply equal
 * to the original input.
 *
 * **Validates: Requirements 8.1, 8.2, 8.5**
 */
describe('Property 3: Direction Field Round-Trip', () => {
  it('createToolConfig followed by getToolConfig returns bindings with direction fields deeply equal to the original input', () => {
    return fc.assert(
      fc.asyncProperty(
        toolIdArb,
        fc.array(integrationBindingWithDirectionArb, { minLength: 1, maxLength: 4 }),
        fc.array(dataStoreBindingWithDirectionArb, { minLength: 1, maxLength: 4 }),
        async (toolId, integrationBindings, dataStoreBindings) => {
          mockDynamoSend.mockReset();

          let storedItem: Record<string, unknown> | null = null;

          mockDynamoSend.mockImplementation((cmd: FakeCommand) => {
            if (cmd._type === 'Put') {
              storedItem = JSON.parse(JSON.stringify(cmd.input.Item));
              return Promise.resolve({});
            }
            if (cmd._type === 'Get') {
              return Promise.resolve({
                Item: storedItem ? JSON.parse(JSON.stringify(storedItem)) : undefined,
              });
            }
            return Promise.resolve({});
          });

          const configObj = { name: `tool_${toolId}`, filename: `${toolId}.py`, version: '1', description: 'test' };

          // Create with directional bindings
          await handler(makeEvent('createToolConfig', {
            input: {
              toolId,
              config: JSON.stringify(configObj),
              integrationBindings,
              dataStoreBindings,
            },
          }));

          // Read back
          const result = await handler(makeEvent("getToolConfig", { toolId })) as ToolConfigResult;

          // Assert integration bindings direction round-trip
          expect(result.integrationBindings).toBeDefined();
          expect(result.integrationBindings).toHaveLength(integrationBindings.length);
          for (let i = 0; i < integrationBindings.length; i++) {
            expect(result.integrationBindings[i].direction).toBe(integrationBindings[i].direction);
            expect(result.integrationBindings[i].integrationId).toBe(integrationBindings[i].integrationId);
            expect(result.integrationBindings[i].integrationType).toBe(integrationBindings[i].integrationType);
          }

          // Assert data store bindings direction round-trip
          expect(result.dataStoreBindings).toBeDefined();
          expect(result.dataStoreBindings).toHaveLength(dataStoreBindings.length);
          for (let i = 0; i < dataStoreBindings.length; i++) {
            expect(result.dataStoreBindings[i].direction).toBe(dataStoreBindings[i].direction);
            expect(result.dataStoreBindings[i].dataStoreId).toBe(dataStoreBindings[i].dataStoreId);
            expect(result.dataStoreBindings[i].dataStoreType).toBe(dataStoreBindings[i].dataStoreType);
          }
        }
      ),
      { numRuns: 100 }
    );
  });
});


// Feature: datastore-integration-pipeline, Property 4: Direction Field Backward Compatibility
// Validates: Requirements 8.5, 8.6

/**
 * Property 4: Direction Field Backward Compatibility
 *
 * For any ToolConfig DynamoDB items with bindings that lack a `direction` field
 * (legacy bindings), getToolConfig should return each binding with `direction`
 * equal to `bidirectional`.
 *
 * **Validates: Requirements 8.5, 8.6**
 */
describe('Property 4: Direction Field Backward Compatibility', () => {
  it('getToolConfig returns direction "bidirectional" for legacy bindings that lack a direction field', () => {
    return fc.assert(
      fc.asyncProperty(
        toolIdArb,
        fc.array(integrationBindingArb, { minLength: 1, maxLength: 4 }),
        fc.array(dataStoreBindingArb, { minLength: 1, maxLength: 4 }),
        async (toolId, integrationBindings, dataStoreBindings) => {
          mockDynamoSend.mockReset();

          // Simulate legacy DynamoDB item — bindings have NO direction field
          const legacyIntBindings = integrationBindings.map((b) => {
            const { direction: _direction, ...rest } = b;
            return rest;
          });
          const legacyDsBindings = dataStoreBindings.map((b) => {
            const { direction: _direction, ...rest } = b;
            return rest;
          });

          const legacyItem: Record<string, unknown> = {
            toolId,
            config: { name: `tool_${toolId}`, filename: `${toolId}.py`, version: '1', description: 'test' },
            state: 'active',
            categories: [],
            integrationBindings: legacyIntBindings,
            dataStoreBindings: legacyDsBindings,
            createdAt: '2025-01-01T00:00:00Z',
            updatedAt: '2025-01-01T00:00:00Z',
          };

          mockDynamoSend.mockImplementation((cmd: FakeCommand) => {
            if (cmd._type === 'Get') {
              return Promise.resolve({
                Item: JSON.parse(JSON.stringify(legacyItem)),
              });
            }
            return Promise.resolve({});
          });

          const result = await handler(makeEvent("getToolConfig", { toolId })) as ToolConfigResult;

          // Every integration binding should have direction = 'bidirectional'
          expect(result.integrationBindings).toBeDefined();
          expect(result.integrationBindings).toHaveLength(legacyIntBindings.length);
          for (const binding of result.integrationBindings) {
            expect(binding.direction).toBe('BIDIRECTIONAL');
          }

          // Every data store binding should have direction = 'bidirectional'
          expect(result.dataStoreBindings).toBeDefined();
          expect(result.dataStoreBindings).toHaveLength(legacyDsBindings.length);
          for (const binding of result.dataStoreBindings) {
            expect(binding.direction).toBe('BIDIRECTIONAL');
          }
        }
      ),
      { numRuns: 100 }
    );
  });
});
