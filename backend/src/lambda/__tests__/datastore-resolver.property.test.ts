import * as fc from 'fast-check';


// ---- Mock setup ----

// Track all DynamoDB calls
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
    UpdateCommand: jest.fn().mockImplementation((input) => ({ _type: 'Update', input })),
    DeleteCommand: jest.fn().mockImplementation((input) => ({ _type: 'Delete', input })),
    QueryCommand: jest.fn().mockImplementation((input) => ({ _type: 'Query', input })),
  };
});

const mockSecretsSend = jest.fn();
jest.mock('@aws-sdk/client-secrets-manager', () => ({
  SecretsManagerClient: jest.fn().mockImplementation(() => ({ send: mockSecretsSend })),
  CreateSecretCommand: jest.fn().mockImplementation((input) => ({ _type: 'CreateSecret', input })),
  GetSecretValueCommand: jest.fn().mockImplementation((input) => ({ _type: 'GetSecretValue', input })),
  UpdateSecretCommand: jest.fn().mockImplementation((input) => ({ _type: 'UpdateSecret', input })),
  DeleteSecretCommand: jest.fn().mockImplementation((input) => ({ _type: 'DeleteSecret', input })),
}));

// Mock the registry
const mockAdapter = {
  requiredPolicies: jest.fn().mockReturnValue({ provision: [], connect: [] }),
  provision: jest.fn().mockResolvedValue({ resourceArn: 'arn:aws:s3:::test-bucket' }),
  connect: jest.fn().mockResolvedValue(undefined),
  disconnect: jest.fn().mockResolvedValue(undefined),
  testConnection: jest.fn().mockResolvedValue({ success: true, message: 'OK' }),
  getMetrics: jest.fn().mockResolvedValue({ size: '0 MB', records: 0 }),
};
jest.mock('../adapters/registry', () => ({
  getAdapter: jest.fn().mockReturnValue(mockAdapter),
}));

// Mock the PolicyManager
const mockPolicyManager = {
  getAccountContext: jest.fn().mockResolvedValue({ accountId: '123456789012', region: 'us-east-1' }),
  ensureRole: jest.fn().mockResolvedValue(undefined),
  assumeScopedRole: jest.fn().mockResolvedValue({
    accessKeyId: 'AKID',
    secretAccessKey: 'SECRET',
    sessionToken: 'TOKEN',
  }),
  deleteRole: jest.fn().mockResolvedValue(undefined),
};
jest.mock('../../utils/policy-manager', () => ({
  PolicyManager: jest.fn().mockImplementation(() => mockPolicyManager),
}));

jest.mock('uuid', () => ({
  v4: jest.fn().mockReturnValue('test-uuid-1234'),
}));

// Set env before import
process.env.DATASTORES_TABLE = 'TestDataStoresTable';

// Import handler after all mocks
import { handler } from '../datastore-resolver';

// ---- Generators ----

const dataStoreTypeArb = fc.constantFrom(
  'S3', 'DYNAMODB', 'RDS_POSTGRESQL', 'RDS_MYSQL',
  'AURORA_POSTGRESQL', 'AURORA_MYSQL', 'REDSHIFT', 'OPENSEARCH',
  'NEPTUNE', 'TIMESTREAM', 'ELASTICACHE_REDIS', 'KEYSPACES',
  'DOCUMENTDB', 'LAKE_FORMATION', 'S3_TABLES', 'SAGEMAKER_LAKEHOUSE',
  'SAGEMAKER_FEATURE_STORE', 'KNOWLEDGE_BASE', 'QLDB',
  'EXTERNAL_POSTGRESQL', 'EXTERNAL_MYSQL', 'EXTERNAL_MONGODB',
);

const categoryArb = fc.constantFrom(
  'S3_STORAGE', 'NOSQL_DATABASE', 'RELATIONAL_DATABASE',
  'KNOWLEDGE_BASE', 'DATA_WAREHOUSE', 'SEARCH_ENGINE',
);

const provisionModeArb = fc.constantFrom('CREATE_NEW', 'CONNECT_EXISTING');

const nameArb = fc.stringMatching(/^[A-Za-z][A-Za-z0-9 -]{2,30}$/);

const orgIdArb = fc.stringMatching(/^org-[a-z0-9]{8}$/);

const clientRequestTokenArb = fc.stringMatching(
  /^tok-[a-f0-9]{8}$/
);

function makeAppSyncEvent(fieldName: string, args: Record<string, any>): any {
  return {
    info: { fieldName },
    arguments: args,
    identity: { username: 'test-user' },
  };
}

// ---- Tests ----

beforeEach(() => {
  jest.clearAllMocks();
  mockAdapter.requiredPolicies.mockReturnValue({ provision: [], connect: [] });
  mockAdapter.provision.mockResolvedValue({ resourceArn: 'arn:aws:s3:::test-bucket' });
  mockAdapter.connect.mockResolvedValue(undefined);
  mockAdapter.disconnect.mockResolvedValue(undefined);
  mockAdapter.testConnection.mockResolvedValue({ success: true, message: 'OK' });
  mockAdapter.getMetrics.mockResolvedValue({ size: '0 MB', records: 0 });
  mockPolicyManager.getAccountContext.mockResolvedValue({ accountId: '123456789012', region: 'us-east-1' });
  mockPolicyManager.ensureRole.mockResolvedValue(undefined);
  mockPolicyManager.assumeScopedRole.mockResolvedValue({
    accessKeyId: 'AKID', secretAccessKey: 'SECRET', sessionToken: 'TOKEN',
  });
  mockPolicyManager.deleteRole.mockResolvedValue(undefined);
});

// Feature: datastore-adapter-pattern, Property 13: Resolver cleans up failed entry on mutation failure
// Validates: Requirements 10.5
describe('Property 13: Resolver cleans up failed entry on mutation failure', () => {
  it('for any adapter error during createDataStore, the resolver deletes the failed record before re-throwing', () => {
    return fc.assert(
      fc.asyncProperty(
        nameArb,
        dataStoreTypeArb,
        categoryArb,
        provisionModeArb,
        orgIdArb,
        fc.string({ minLength: 3, maxLength: 50 }),
        async (name, type, category, provisionMode, orgId, errorMsg) => {
          // Reset mocks for each run
          mockDynamoSend.mockReset();

          // Track DeleteCommand calls to verify cleanup
          const deleteInputs: any[] = [];

          mockDynamoSend.mockImplementation((cmd: any) => {
            if (cmd._type === 'Query') {
              return Promise.resolve({ Items: [] });
            }
            if (cmd._type === 'Put') {
              return Promise.resolve({});
            }
            if (cmd._type === 'Update') {
              return Promise.resolve({ Attributes: {} });
            }
            if (cmd._type === 'Delete') {
              deleteInputs.push(cmd.input);
              return Promise.resolve({});
            }
            return Promise.resolve({});
          });

          // Make the adapter throw during provision/connect
          const adapterError = new Error(errorMsg);
          if (provisionMode === 'CREATE_NEW') {
            mockAdapter.provision.mockRejectedValue(adapterError);
          } else {
            mockAdapter.connect.mockRejectedValue(adapterError);
          }

          const event = makeAppSyncEvent('createDataStore', {
            input: {
              name,
              type,
              category,
              provisionMode,
              orgId,
              config: JSON.stringify({ bucketName: 'test' }),
              clientRequestToken: 'tok-12345678',
            },
          });

          await expect(handler(event)).rejects.toThrow(errorMsg);

          // Verify that a DeleteCommand was sent to clean up the failed entry
          expect(deleteInputs.length).toBeGreaterThanOrEqual(1);
          const cleanupDelete = deleteInputs.find(
            (d: any) => d?.Key?.dataStoreId !== undefined
          );
          expect(cleanupDelete).toBeDefined();
        }
      ),
      { numRuns: 20 }
    );
  });
});

// Feature: datastore-adapter-pattern, Property 14: Idempotent creation via clientRequestToken
// Validates: Requirements 11.1
describe('Property 14: Idempotent creation via clientRequestToken', () => {
  it('calling createDataStore twice with the same clientRequestToken returns the same record without creating a duplicate', () => {
    return fc.assert(
      fc.asyncProperty(
        nameArb,
        dataStoreTypeArb,
        categoryArb,
        orgIdArb,
        clientRequestTokenArb,
        async (name, type, category, orgId, token) => {
          mockDynamoSend.mockReset();

          const existingItem = {
            dataStoreId: 'existing-id-1234',
            name,
            type,
            category,
            status: 'CONNECTED',
            orgId,
            clientRequestToken: token,
            version: 1,
          };

          // The QueryCommand for idempotency check returns the existing item
          mockDynamoSend.mockImplementation((cmd: any) => {
            if (cmd._type === 'Query') {
              return Promise.resolve({ Items: [existingItem] });
            }
            return Promise.resolve({});
          });

          const event = makeAppSyncEvent('createDataStore', {
            input: {
              name,
              type,
              category,
              provisionMode: 'CONNECT_EXISTING',
              orgId,
              config: JSON.stringify({}),
              clientRequestToken: token,
            },
          });

          const result = await handler(event) as any;

          // Should return the existing item
          expect(result).toEqual(existingItem);
          expect(result.dataStoreId).toBe('existing-id-1234');

          // Should NOT have called PutCommand (no new item created)
          const putCalls = mockDynamoSend.mock.calls.filter(
            ([cmd]: any) => cmd._type === 'Put'
          );
          expect(putCalls).toHaveLength(0);
        }
      ),
      { numRuns: 20 }
    );
  });
});

// Feature: datastore-adapter-pattern, Property 15: Optimistic locking rejects stale versions
// Validates: Requirements 11.2
describe('Property 15: Optimistic locking rejects stale versions', () => {
  it('connectDataStore with a stale version throws ConflictError after retries', () => {
    return fc.assert(
      fc.asyncProperty(
        fc.integer({ min: 2, max: 100 }),
        async (currentVersion) => {
          mockDynamoSend.mockReset();

          const existingItem = {
            dataStoreId: 'ds-lock-test',
            name: 'Test Store',
            type: 'S3',
            category: 'S3_STORAGE',
            status: 'DISCONNECTED',
            orgId: 'org-test1234',
            config: JSON.stringify({ bucketName: 'test' }),
            version: currentVersion,
          };

          // GetCommand always returns the item with currentVersion
          // UpdateCommand always fails with ConditionalCheckFailedException
          // (simulating another process bumping the version)
          mockDynamoSend.mockImplementation((cmd: any) => {
            if (cmd._type === 'Get') {
              return Promise.resolve({ Item: existingItem });
            }
            if (cmd._type === 'Update') {
              const err: any = new Error('Conditional check failed');
              err.name = 'ConditionalCheckFailedException';
              return Promise.reject(err);
            }
            return Promise.resolve({});
          });

          const event = makeAppSyncEvent('connectDataStore', {
            dataStoreId: 'ds-lock-test',
          });

          await expect(handler(event)).rejects.toThrow(
            /[Vv]ersion conflict/
          );
        }
      ),
      { numRuns: 20 }
    );
  });

  it('disconnectDataStore with a stale version throws ConflictError after retries', () => {
    return fc.assert(
      fc.asyncProperty(
        fc.integer({ min: 2, max: 100 }),
        async (currentVersion) => {
          mockDynamoSend.mockReset();

          const existingItem = {
            dataStoreId: 'ds-lock-test-2',
            name: 'Test Store 2',
            type: 'DYNAMODB',
            category: 'NOSQL_DATABASE',
            status: 'CONNECTED',
            orgId: 'org-test5678',
            config: JSON.stringify({ tableName: 'test' }),
            version: currentVersion,
          };

          mockDynamoSend.mockImplementation((cmd: any) => {
            if (cmd._type === 'Get') {
              return Promise.resolve({ Item: existingItem });
            }
            if (cmd._type === 'Update') {
              const err: any = new Error('Conditional check failed');
              err.name = 'ConditionalCheckFailedException';
              return Promise.reject(err);
            }
            return Promise.resolve({});
          });

          const event = makeAppSyncEvent('disconnectDataStore', {
            dataStoreId: 'ds-lock-test-2',
          });

          await expect(handler(event)).rejects.toThrow(
            /[Vv]ersion conflict/
          );
        }
      ),
      { numRuns: 20 }
    );
  });
});


// Feature: datastore-integration-pipeline, Property 1: Usage Field Round-Trip
// Validates: Requirements 1.1, 1.3, 1.5, 1.6
describe('Property 1: Usage Field Round-Trip', () => {
  const usageArb = fc.constantFrom('KNOWLEDGE', 'OPERATIONAL', 'BOTH');

  it('createDataStore followed by getDataStore returns usage as uppercase GraphQL enum value', () => {
    return fc.assert(
      fc.asyncProperty(
        nameArb,
        dataStoreTypeArb,
        categoryArb,
        orgIdArb,
        usageArb,
        async (name, type, category, orgId, usage) => {
          mockDynamoSend.mockReset();

          // Track what gets persisted via PutCommand
          let persistedItem: any = null;

          mockDynamoSend.mockImplementation((cmd: any) => {
            if (cmd._type === 'Query') {
              // Idempotency check — no existing item
              return Promise.resolve({ Items: [] });
            }
            if (cmd._type === 'Put') {
              persistedItem = cmd.input.Item;
              return Promise.resolve({});
            }
            if (cmd._type === 'Update') {
              // Final status update — merge into persisted item and return
              const updated = { ...persistedItem, status: 'CONNECTED' };
              return Promise.resolve({ Attributes: updated });
            }
            if (cmd._type === 'Get') {
              // Return the persisted item
              return Promise.resolve({ Item: persistedItem });
            }
            return Promise.resolve({});
          });

          // Create with usage
          const createEvent = makeAppSyncEvent('createDataStore', {
            input: {
              name,
              type,
              category,
              provisionMode: 'CONNECT_EXISTING',
              orgId,
              config: JSON.stringify({ bucketName: 'test' }),
              clientRequestToken: 'tok-roundtrip',
              usage,
            },
          });

          await handler(createEvent);

          // Now getDataStore should return the same usage
          const getEvent = makeAppSyncEvent('getDataStore', {
            dataStoreId: persistedItem.dataStoreId,
          });

          const result = await handler(getEvent) as any;
          expect(result.usage).toBe(usage);
        }
      ),
      { numRuns: 100 }
    );
  });

  it('createDataStore without usage defaults to "both"', () => {
    return fc.assert(
      fc.asyncProperty(
        nameArb,
        dataStoreTypeArb,
        categoryArb,
        orgIdArb,
        async (name, type, category, orgId) => {
          mockDynamoSend.mockReset();

          let persistedItem: any = null;

          mockDynamoSend.mockImplementation((cmd: any) => {
            if (cmd._type === 'Query') {
              return Promise.resolve({ Items: [] });
            }
            if (cmd._type === 'Put') {
              persistedItem = cmd.input.Item;
              return Promise.resolve({});
            }
            if (cmd._type === 'Update') {
              const updated = { ...persistedItem, status: 'CONNECTED' };
              return Promise.resolve({ Attributes: updated });
            }
            if (cmd._type === 'Get') {
              return Promise.resolve({ Item: persistedItem });
            }
            return Promise.resolve({});
          });

          // Create WITHOUT usage field
          const createEvent = makeAppSyncEvent('createDataStore', {
            input: {
              name,
              type,
              category,
              provisionMode: 'CONNECT_EXISTING',
              orgId,
              config: JSON.stringify({ bucketName: 'test' }),
              clientRequestToken: 'tok-nodefault',
            },
          });

          await handler(createEvent);

          const getEvent = makeAppSyncEvent('getDataStore', {
            dataStoreId: persistedItem.dataStoreId,
          });

          const result = await handler(getEvent) as any;
          expect(result.usage).toBe('BOTH');
        }
      ),
      { numRuns: 100 }
    );
  });

  it('updateDataStore with a new usage value followed by getDataStore returns the updated value', () => {
    return fc.assert(
      fc.asyncProperty(
        usageArb,
        usageArb.filter((u) => true), // second usage value (may be same or different)
        async (initialUsage, newUsage) => {
          mockDynamoSend.mockReset();

          // Simulate an existing item with initialUsage
          let storedItem: any = {
            dataStoreId: 'ds-update-usage',
            name: 'Test Store',
            type: 'S3',
            category: 'S3_STORAGE',
            status: 'CONNECTED',
            orgId: 'org-test0001',
            usage: initialUsage,
            version: 1,
            config: JSON.stringify({ bucketName: 'test' }),
          };

          mockDynamoSend.mockImplementation((cmd: any) => {
            if (cmd._type === 'Get') {
              return Promise.resolve({ Item: { ...storedItem } });
            }
            if (cmd._type === 'Update') {
              // Apply the update to storedItem
              const exprValues = cmd.input.ExpressionAttributeValues || {};
              if (exprValues[':usage'] !== undefined) {
                storedItem = { ...storedItem, usage: exprValues[':usage'], version: storedItem.version + 1 };
              } else {
                storedItem = { ...storedItem, version: storedItem.version + 1 };
              }
              return Promise.resolve({ Attributes: { ...storedItem } });
            }
            return Promise.resolve({});
          });

          // Update with new usage
          const updateEvent = makeAppSyncEvent('updateDataStore', {
            input: {
              dataStoreId: 'ds-update-usage',
              usage: newUsage,
              version: 1,
            },
          });

          await handler(updateEvent);

          // Get should return the new usage
          const getEvent = makeAppSyncEvent('getDataStore', {
            dataStoreId: 'ds-update-usage',
          });

          const result = await handler(getEvent) as any;
          expect(result.usage).toBe(newUsage);
        }
      ),
      { numRuns: 100 }
    );
  });
});


// Feature: datastore-integration-pipeline, Property 2: Usage Field Backward Compatibility
// Validates: Requirements 1.5, 1.10
describe('Property 2: Usage Field Backward Compatibility', () => {
  it('getDataStore returns usage "both" for legacy items that lack a usage field', () => {
    return fc.assert(
      fc.asyncProperty(
        nameArb,
        dataStoreTypeArb,
        categoryArb,
        orgIdArb,
        async (name, type, category, orgId) => {
          mockDynamoSend.mockReset();

          // Legacy item — no usage field
          const legacyItem: any = {
            dataStoreId: 'ds-legacy-compat',
            name,
            type,
            category,
            status: 'CONNECTED',
            orgId,
            version: 1,
            config: JSON.stringify({ bucketName: 'test' }),
          };
          // Explicitly ensure no usage field
          delete legacyItem.usage;

          mockDynamoSend.mockImplementation((cmd: any) => {
            if (cmd._type === 'Get') {
              return Promise.resolve({ Item: { ...legacyItem } });
            }
            return Promise.resolve({});
          });

          const getEvent = makeAppSyncEvent('getDataStore', {
            dataStoreId: 'ds-legacy-compat',
          });

          const result = await handler(getEvent) as any;
          expect(result.usage).toBe('BOTH');
        }
      ),
      { numRuns: 100 }
    );
  });

  it('listDataStores returns usage "both" for legacy items that lack a usage field', () => {
    return fc.assert(
      fc.asyncProperty(
        orgIdArb,
        fc.array(
          fc.record({
            name: nameArb,
            type: dataStoreTypeArb,
            category: categoryArb,
          }),
          { minLength: 1, maxLength: 5 }
        ),
        async (orgId, items) => {
          mockDynamoSend.mockReset();

          // Create legacy items without usage field
          const legacyItems = items.map((item, i) => ({
            dataStoreId: `ds-legacy-list-${i}`,
            name: item.name,
            type: item.type,
            category: item.category,
            status: 'CONNECTED',
            orgId,
            version: 1,
            config: JSON.stringify({}),
          }));

          mockDynamoSend.mockImplementation((cmd: any) => {
            if (cmd._type === 'Query') {
              return Promise.resolve({ Items: legacyItems });
            }
            return Promise.resolve({});
          });

          const listEvent = makeAppSyncEvent('listDataStores', {
            orgId,
          });

          const result = await handler(listEvent) as any[];
          for (const item of result) {
            expect(item.usage).toBe('BOTH');
          }
        }
      ),
      { numRuns: 100 }
    );
  });
});


// Feature: datastore-integration-pipeline, Property 5: Discovery API Returns Only CONNECTED Stores with Correct Capabilities
// **Validates: Requirements 3.3, 3.5, 3.6, 3.7**
describe('Property 5: Discovery API Returns Only CONNECTED Stores with Correct Capabilities', () => {
  // Import the real getDataStoreOperations for capability assertions
  const { getDataStoreOperations } = jest.requireActual('../../utils/operations-registry') as typeof import('../../utils/operations-registry');

  const usageArb = fc.constantFrom('knowledge', 'operational', 'both');
  const statusArb = fc.constantFrom('CONNECTED', 'ERROR', 'PROVISIONING', 'DELETING', 'CREATED');

  const dataStoreItemArb = fc.record({
    dataStoreId: fc.stringMatching(/^ds-[a-z0-9]{8}$/),
    name: fc.stringMatching(/^[A-Za-z][A-Za-z0-9 -]{2,20}$/),
    type: dataStoreTypeArb,
    category: categoryArb,
    status: statusArb,
    usage: usageArb,
    provider: fc.constantFrom('Amazon Web Services', 'External'),
    orgId: orgIdArb,
    version: fc.integer({ min: 1, max: 10 }),
    config: fc.constant(JSON.stringify({ bucketName: 'test' })),
  });

  it('returns only stores with status CONNECTED', () => {
    return fc.assert(
      fc.asyncProperty(
        orgIdArb,
        fc.array(dataStoreItemArb, { minLength: 1, maxLength: 10 }),
        async (orgId, stores) => {
          mockDynamoSend.mockReset();

          // Assign all stores to the same org
          const orgStores = stores.map((s) => ({ ...s, orgId }));

          // Mock DynamoDB query to return all org stores
          mockDynamoSend.mockImplementation((cmd: any) => {
            if (cmd._type === 'Query') {
              return Promise.resolve({ Items: orgStores });
            }
            return Promise.resolve({});
          });

          const event = makeAppSyncEvent('listAvailableDataSources', {
            orgId,
          });

          const result = await handler(event) as any[];

          // Assert only CONNECTED stores are returned
          const connectedStores = orgStores.filter((s) => s.status === 'CONNECTED');
          expect(result.length).toBe(connectedStores.length);
          for (const item of result) {
            expect(item.status).toBe('CONNECTED');
          }
        }
      ),
      { numRuns: 100 }
    );
  });

  it('filters by usage parameter correctly (both matches either knowledge or operational)', () => {
    return fc.assert(
      fc.asyncProperty(
        orgIdArb,
        fc.array(dataStoreItemArb, { minLength: 1, maxLength: 10 }),
        fc.constantFrom('KNOWLEDGE', 'OPERATIONAL', 'BOTH'),
        async (orgId, stores, usageFilter) => {
          mockDynamoSend.mockReset();

          // All stores CONNECTED so we only test usage filtering
          const orgStores = stores.map((s) => ({ ...s, orgId, status: 'CONNECTED' }));

          mockDynamoSend.mockImplementation((cmd: any) => {
            if (cmd._type === 'Query') {
              return Promise.resolve({ Items: orgStores });
            }
            return Promise.resolve({});
          });

          const event = makeAppSyncEvent('listAvailableDataSources', {
            orgId,
            usage: usageFilter,
          });

          const result = await handler(event) as any[];

          // Compute expected filtered stores
          const filterUpper = usageFilter.toUpperCase();
          const expectedStores = orgStores.filter((s) => {
            const storeUsage = (s.usage || 'BOTH').toUpperCase();
            if (filterUpper === 'BOTH') {
              return true;
            }
            return storeUsage === filterUpper || storeUsage === 'BOTH';
          });

          expect(result.length).toBe(expectedStores.length);
        }
      ),
      { numRuns: 100 }
    );
  });

  it('each returned store has capabilities matching getDataStoreOperations(store.type)', () => {
    return fc.assert(
      fc.asyncProperty(
        orgIdArb,
        fc.array(dataStoreItemArb, { minLength: 1, maxLength: 10 }),
        async (orgId, stores) => {
          mockDynamoSend.mockReset();

          // All stores CONNECTED
          const orgStores = stores.map((s) => ({ ...s, orgId, status: 'CONNECTED' }));

          mockDynamoSend.mockImplementation((cmd: any) => {
            if (cmd._type === 'Query') {
              return Promise.resolve({ Items: orgStores });
            }
            return Promise.resolve({});
          });

          const event = makeAppSyncEvent('listAvailableDataSources', {
            orgId,
          });

          const result = await handler(event) as any[];

          // Assert capabilities match the operations registry
          for (const item of result) {
            const expectedCapabilities = getDataStoreOperations(item.type);
            expect(item.capabilities).toEqual(expectedCapabilities);
          }
        }
      ),
      { numRuns: 100 }
    );
  });

  it('returns empty array for orgs with no connected stores', () => {
    return fc.assert(
      fc.asyncProperty(
        orgIdArb,
        async (orgId) => {
          mockDynamoSend.mockReset();

          // Return stores that are all non-CONNECTED
          const nonConnectedStores = [
            { dataStoreId: 'ds-err00001', status: 'ERROR', orgId, type: 'S3', usage: 'both' },
            { dataStoreId: 'ds-prov0001', status: 'PROVISIONING', orgId, type: 'DYNAMODB', usage: 'operational' },
          ];

          mockDynamoSend.mockImplementation((cmd: any) => {
            if (cmd._type === 'Query') {
              return Promise.resolve({ Items: nonConnectedStores });
            }
            return Promise.resolve({});
          });

          const event = makeAppSyncEvent('listAvailableDataSources', {
            orgId,
          });

          const result = await handler(event) as any[];
          expect(result).toEqual([]);
        }
      ),
      { numRuns: 100 }
    );
  });
});
