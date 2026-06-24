// Feature: datastore-integration-pipeline, Property 9: Health Monitor Idempotency
// Validates: Requirements 6.3, 6.4, 10.4

import * as fc from 'fast-check';
import { STSClient } from '@aws-sdk/client-sts';
import { mockClient } from 'aws-sdk-client-mock';

// Import the testable health check logic (to be implemented)
import { processHealthChecks } from '../health-monitor';

// processHealthChecks assumes a scoped STS role per store (GetCallerIdentity +
// AssumeRole). With no real AWS credentials in the test environment, the
// un-mocked STS client hangs on credential resolution (IMDS) and retries,
// which blows past Jest's 30s timeout and leaks open handles. Mock STS so
// those calls resolve instantly. The assumed credentials are irrelevant to
// the idempotency invariant under test — the per-store testConnection mocks
// (wired below) are what drive the property assertions.
const stsMock = mockClient(STSClient);

beforeEach(() => {
  stsMock.reset();
  stsMock.onAnyCommand().resolves({});
});

// ---- Generators ----

const dataStoreIdArb = fc.stringMatching(/^ds-[a-z0-9]{8}$/);
const orgIdArb = fc.stringMatching(/^org-[a-z0-9]{8}$/);

const dataStoreTypeArb = fc.constantFrom(
  'S3', 'DYNAMODB', 'RDS_POSTGRESQL', 'RDS_MYSQL',
  'AURORA_POSTGRESQL', 'AURORA_MYSQL', 'REDSHIFT', 'OPENSEARCH',
  'NEPTUNE', 'TIMESTREAM', 'ELASTICACHE_REDIS', 'KEYSPACES',
  'DOCUMENTDB', 'KNOWLEDGE_BASE'
);

const healthyStatusArb = fc.constantFrom('CONNECTED', 'ERROR') as fc.Arbitrary<'CONNECTED' | 'ERROR'>;

/** Generate a deterministic connection test result (true = healthy, false = unhealthy) */
const connectionHealthArb = fc.boolean();

const errorMessageArb = fc.stringMatching(/^[A-Za-z ]{5,40}$/);

interface MockDataStore {
  dataStoreId: string;
  orgId: string;
  type: string;
  status: 'CONNECTED' | 'ERROR';
  config: string;
  errorMessage: string | null;
}

const dataStoreArb: fc.Arbitrary<MockDataStore> = fc.record({
  dataStoreId: dataStoreIdArb,
  orgId: orgIdArb,
  type: dataStoreTypeArb,
  status: healthyStatusArb,
  config: fc.constant(JSON.stringify({ endpoint: 'test' })),
  errorMessage: fc.oneof(fc.constant(null), errorMessageArb),
});

/** Generate a set of stores with unique IDs paired with deterministic health outcomes */
const storesWithHealthArb = fc.array(
  fc.tuple(dataStoreArb, connectionHealthArb, errorMessageArb),
  { minLength: 1, maxLength: 15 }
).map(entries => {
  // Ensure unique dataStoreIds
  const seen = new Set<string>();
  return entries.filter(([store]) => {
    if (seen.has(store.dataStoreId)) return false;
    seen.add(store.dataStoreId);
    return true;
  });
}).filter(entries => entries.length > 0);

// ---- Helper: build mock dependencies ----

function buildMockDeps(
  entries: Array<[MockDataStore, boolean, string]>
) {
  // Map from dataStoreId to deterministic health result
  const healthMap = new Map<string, { healthy: boolean; errorMsg: string }>();
  for (const [store, healthy, errMsg] of entries) {
    healthMap.set(store.dataStoreId, { healthy, errorMsg: errMsg });
  }

  // In-memory store state (mutable)
  const storeState = new Map<string, MockDataStore>();
  for (const [store] of entries) {
    storeState.set(store.dataStoreId, { ...store });
  }

  // Per-store adapter factory
  const perStoreGetAdapter = (store: MockDataStore) => {
    const health = healthMap.get(store.dataStoreId)!;
    return {
      testConnection: async (_config: any, _creds?: any) => {
        if (health.healthy) {
          return { success: true, message: 'OK' };
        } else {
          return { success: false, message: health.errorMsg };
        }
      },
    };
  };

  // Mock updateStore function: applies status changes to in-memory state
  const updateStoreFn = async (
    dataStoreId: string,
    newStatus: string,
    errorMessage: string | null
  ) => {
    const current = storeState.get(dataStoreId);
    if (current) {
      storeState.set(dataStoreId, {
        ...current,
        status: newStatus as 'CONNECTED' | 'ERROR',
        errorMessage,
      });
    }
  };

  return { storeState, perStoreGetAdapter, updateStoreFn };
}

// ---- Tests ----

describe('Property 9: Health Monitor Idempotency', () => {
  it('running the health monitor twice produces the same final status for each store', async () => {
    await fc.assert(
      fc.asyncProperty(
        storesWithHealthArb,
        async (entries) => {
          // Build mock dependencies
          const { storeState, perStoreGetAdapter, updateStoreFn } = buildMockDeps(entries);

          const stores = entries.map(([store]) => ({ ...store }));

          // Run health monitor first time
          await processHealthChecks(
            stores,
            (store) => perStoreGetAdapter(store),
            updateStoreFn
          );

          // Capture state after first run
          const stateAfterFirstRun = new Map<string, MockDataStore>();
          for (const [id, state] of storeState) {
            stateAfterFirstRun.set(id, { ...state });
          }

          // Run health monitor second time with updated stores
          const updatedStores = Array.from(storeState.values());
          await processHealthChecks(
            updatedStores,
            (store) => perStoreGetAdapter(store),
            updateStoreFn
          );

          // Capture state after second run
          const stateAfterSecondRun = new Map<string, MockDataStore>();
          for (const [id, state] of storeState) {
            stateAfterSecondRun.set(id, { ...state });
          }

          // Assert: same final status after both runs
          for (const [id, firstState] of stateAfterFirstRun) {
            const secondState = stateAfterSecondRun.get(id)!;
            expect(secondState.status).toBe(firstState.status);
            expect(secondState.errorMessage).toBe(firstState.errorMessage);
          }
        }
      ),
      { numRuns: 100 }
    );
  });

  it('a healthy store remains CONNECTED after both runs', async () => {
    await fc.assert(
      fc.asyncProperty(
        storesWithHealthArb,
        async (entries) => {
          const { storeState, perStoreGetAdapter, updateStoreFn } = buildMockDeps(entries);
          const stores = entries.map(([store]) => ({ ...store }));

          // Run twice
          await processHealthChecks(stores, (store) => perStoreGetAdapter(store), updateStoreFn);
          const updatedStores = Array.from(storeState.values());
          await processHealthChecks(updatedStores, (store) => perStoreGetAdapter(store), updateStoreFn);

          // Assert: all stores with healthy=true are CONNECTED
          for (const [store, healthy] of entries) {
            if (healthy) {
              const finalState = storeState.get(store.dataStoreId)!;
              expect(finalState.status).toBe('CONNECTED');
              expect(finalState.errorMessage).toBeNull();
            }
          }
        }
      ),
      { numRuns: 100 }
    );
  });

  it('an unhealthy store remains ERROR after both runs', async () => {
    await fc.assert(
      fc.asyncProperty(
        storesWithHealthArb,
        async (entries) => {
          const { storeState, perStoreGetAdapter, updateStoreFn } = buildMockDeps(entries);
          const stores = entries.map(([store]) => ({ ...store }));

          // Run twice
          await processHealthChecks(stores, (store) => perStoreGetAdapter(store), updateStoreFn);
          const updatedStores = Array.from(storeState.values());
          await processHealthChecks(updatedStores, (store) => perStoreGetAdapter(store), updateStoreFn);

          // Assert: all stores with healthy=false are ERROR
          for (const [store, healthy, errMsg] of entries) {
            if (!healthy) {
              const finalState = storeState.get(store.dataStoreId)!;
              expect(finalState.status).toBe('ERROR');
              expect(finalState.errorMessage).toBe(errMsg);
            }
          }
        }
      ),
      { numRuns: 100 }
    );
  });

  it('no store accumulates duplicate error messages across runs', async () => {
    await fc.assert(
      fc.asyncProperty(
        storesWithHealthArb,
        async (entries) => {
          const { storeState, perStoreGetAdapter, updateStoreFn } = buildMockDeps(entries);
          const stores = entries.map(([store]) => ({ ...store }));

          // Run three times to check for accumulation
          await processHealthChecks(stores, (store) => perStoreGetAdapter(store), updateStoreFn);
          let updatedStores = Array.from(storeState.values());
          await processHealthChecks(updatedStores, (store) => perStoreGetAdapter(store), updateStoreFn);
          updatedStores = Array.from(storeState.values());
          await processHealthChecks(updatedStores, (store) => perStoreGetAdapter(store), updateStoreFn);

          // Assert: errorMessage is either null or a single string (not concatenated/duplicated)
          for (const [store, healthy, errMsg] of entries) {
            const finalState = storeState.get(store.dataStoreId)!;
            if (healthy) {
              expect(finalState.errorMessage).toBeNull();
            } else {
              // Error message should be exactly the error, not duplicated
              expect(finalState.errorMessage).toBe(errMsg);
            }
          }
        }
      ),
      { numRuns: 100 }
    );
  });
});
