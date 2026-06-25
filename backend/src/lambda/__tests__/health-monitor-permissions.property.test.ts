/**
 * Property tests for health monitor permission-error handling.
 *
 * Validates that the health monitor does NOT mark a data store as ERROR
 * when the testConnection failure is due to insufficient Lambda permissions
 * (AccessDenied), as opposed to a genuine connectivity failure.
 *
 * Requirement references: 6.3, 6.4, 6.8
 */

import * as fc from 'fast-check';
import { STSClient } from '@aws-sdk/client-sts';
import { mockClient } from 'aws-sdk-client-mock';
import { processHealthChecks } from '../health-monitor';

// processHealthChecks assumes a scoped STS role per store (GetCallerIdentity +
// AssumeRole). With no real AWS credentials in the test environment, the
// un-mocked STS client hangs on credential resolution (IMDS) and retries,
// blowing past Jest's 30s timeout. Mock STS so those calls resolve instantly;
// the assumed credentials are irrelevant to the permission-error invariants
// under test (driven by the per-store testConnection mocks below).
const stsMock = mockClient(STSClient);

beforeEach(() => {
  stsMock.reset();
  stsMock.onAnyCommand().resolves({});
});

// ---- Generators ----

const dataStoreIdArb = fc.stringMatching(/^ds-[a-z0-9]{8}$/);
const orgIdArb = fc.stringMatching(/^org-[a-z0-9]{8}$/);
const dataStoreTypeArb = fc.constantFrom('S3', 'DYNAMODB', 'RDS_POSTGRESQL', 'AURORA_MYSQL');

interface MockDataStore {
  dataStoreId: string;
  orgId: string;
  type: string;
  status: 'CONNECTED' | 'ERROR';
  config: string;
  errorMessage: string | null;
}

const connectedStoreArb: fc.Arbitrary<MockDataStore> = fc.record({
  dataStoreId: dataStoreIdArb,
  orgId: orgIdArb,
  type: dataStoreTypeArb,
  status: fc.constant('CONNECTED' as const),
  config: fc.constant(JSON.stringify({ bucketName: 'test-bucket' })),
  errorMessage: fc.constant(null),
});

const errorStoreArb: fc.Arbitrary<MockDataStore> = fc.record({
  dataStoreId: dataStoreIdArb,
  orgId: orgIdArb,
  type: dataStoreTypeArb,
  status: fc.constant('ERROR' as const),
  config: fc.constant(JSON.stringify({ bucketName: 'test-bucket' })),
  errorMessage: fc.constant('Previous error'),
});

const uniqueStoresArb = (arb: fc.Arbitrary<MockDataStore>) =>
  fc.array(arb, { minLength: 1, maxLength: 10 }).map(stores => {
    const seen = new Set<string>();
    return stores.filter(s => {
      if (seen.has(s.dataStoreId)) return false;
      seen.add(s.dataStoreId);
      return true;
    });
  }).filter(stores => stores.length > 0);

// ---- Tests ----

describe('Health Monitor: permission error handling', () => {
  it('a CONNECTED store stays CONNECTED when testConnection fails with AccessDenied', async () => {
    await fc.assert(
      fc.asyncProperty(
        uniqueStoresArb(connectedStoreArb),
        async (stores) => {
          const storeState = new Map(stores.map(s => [s.dataStoreId, { ...s }]));

          const getAdapterFn = (_store: any) => ({
            testConnection: async () => ({
              success: false,
              message: 'Permission denied accessing bucket test-bucket',
              details: { errorName: 'AccessDenied', isPermissionError: true },
            }),
          });

          const updateStoreFn = async (id: string, status: string, errMsg: string | null) => {
            const current = storeState.get(id);
            if (current) storeState.set(id, { ...current, status: status as any, errorMessage: errMsg });
          };

          await processHealthChecks(stores, getAdapterFn, updateStoreFn);

          for (const store of stores) {
            const final = storeState.get(store.dataStoreId)!;
            expect(final.status).toBe('CONNECTED');
            expect(final.errorMessage).toBeNull();
          }
        }
      ),
      { numRuns: 50 }
    );
  });

  it('a CONNECTED store moves to ERROR when testConnection fails with a genuine connectivity error', async () => {
    await fc.assert(
      fc.asyncProperty(
        uniqueStoresArb(connectedStoreArb),
        async (stores) => {
          const storeState = new Map(stores.map(s => [s.dataStoreId, { ...s }]));

          const getAdapterFn = (_store: any) => ({
            testConnection: async () => ({
              success: false,
              message: 'Connection timed out',
              details: { errorName: 'TimeoutError' },
            }),
          });

          const updateStoreFn = async (id: string, status: string, errMsg: string | null) => {
            const current = storeState.get(id);
            if (current) storeState.set(id, { ...current, status: status as any, errorMessage: errMsg });
          };

          await processHealthChecks(stores, getAdapterFn, updateStoreFn);

          for (const store of stores) {
            const final = storeState.get(store.dataStoreId)!;
            expect(final.status).toBe('ERROR');
            expect(final.errorMessage).toBe('Connection timed out');
          }
        }
      ),
      { numRuns: 50 }
    );
  });

  it('an ERROR store stays ERROR when testConnection fails with AccessDenied (does not flip-flop)', async () => {
    await fc.assert(
      fc.asyncProperty(
        uniqueStoresArb(errorStoreArb),
        async (stores) => {
          const storeState = new Map(stores.map(s => [s.dataStoreId, { ...s }]));

          const getAdapterFn = (_store: any) => ({
            testConnection: async () => ({
              success: false,
              message: 'Access denied',
              details: { errorName: 'AccessDeniedException', isPermissionError: true },
            }),
          });

          const updateStoreFn = async (id: string, status: string, errMsg: string | null) => {
            const current = storeState.get(id);
            if (current) storeState.set(id, { ...current, status: status as any, errorMessage: errMsg });
          };

          await processHealthChecks(stores, getAdapterFn, updateStoreFn);

          for (const store of stores) {
            const final = storeState.get(store.dataStoreId)!;
            // Should preserve existing status, not update
            expect(final.status).toBe('ERROR');
            expect(final.errorMessage).toBe('Previous error');
          }
        }
      ),
      { numRuns: 50 }
    );
  });

  it('when adapter throws an AccessDenied exception, store status is preserved', async () => {
    await fc.assert(
      fc.asyncProperty(
        uniqueStoresArb(connectedStoreArb),
        async (stores) => {
          const storeState = new Map(stores.map(s => [s.dataStoreId, { ...s }]));

          const getAdapterFn = (_store: any) => ({
            testConnection: async () => {
              const err: any = new Error('User: arn:aws:iam::123:role/foo is not authorized');
              err.name = 'AccessDeniedException';
              throw err;
            },
          });

          const updateStoreFn = async (id: string, status: string, errMsg: string | null) => {
            const current = storeState.get(id);
            if (current) storeState.set(id, { ...current, status: status as any, errorMessage: errMsg });
          };

          await processHealthChecks(stores, getAdapterFn, updateStoreFn);

          for (const store of stores) {
            const final = storeState.get(store.dataStoreId)!;
            expect(final.status).toBe('CONNECTED');
            expect(final.errorMessage).toBeNull();
          }
        }
      ),
      { numRuns: 50 }
    );
  });

  it('healthy stores still recover from ERROR to CONNECTED', async () => {
    await fc.assert(
      fc.asyncProperty(
        uniqueStoresArb(errorStoreArb),
        async (stores) => {
          const storeState = new Map(stores.map(s => [s.dataStoreId, { ...s }]));

          const getAdapterFn = (_store: any) => ({
            testConnection: async () => ({
              success: true,
              message: 'OK',
            }),
          });

          const updateStoreFn = async (id: string, status: string, errMsg: string | null) => {
            const current = storeState.get(id);
            if (current) storeState.set(id, { ...current, status: status as any, errorMessage: errMsg });
          };

          await processHealthChecks(stores, getAdapterFn, updateStoreFn);

          for (const store of stores) {
            const final = storeState.get(store.dataStoreId)!;
            expect(final.status).toBe('CONNECTED');
            expect(final.errorMessage).toBeNull();
          }
        }
      ),
      { numRuns: 50 }
    );
  });

  it('a CONNECTED store stays CONNECTED when testConnection fails with UnknownError (no service permissions)', async () => {
    await fc.assert(
      fc.asyncProperty(
        uniqueStoresArb(connectedStoreArb),
        async (stores) => {
          const storeState = new Map(stores.map(s => [s.dataStoreId, { ...s }]));

          const getAdapterFn = (_store: any) => ({
            testConnection: async () => ({
              success: false,
              message: 'Failed to connect to bucket test-bucket: UnknownError',
              details: { errorName: 'UnknownError' },
            }),
          });

          const updateStoreFn = async (id: string, status: string, errMsg: string | null) => {
            const current = storeState.get(id);
            if (current) storeState.set(id, { ...current, status: status as any, errorMessage: errMsg });
          };

          await processHealthChecks(stores, getAdapterFn, updateStoreFn);

          for (const store of stores) {
            const final = storeState.get(store.dataStoreId)!;
            expect(final.status).toBe('CONNECTED');
            expect(final.errorMessage).toBeNull();
          }
        }
      ),
      { numRuns: 50 }
    );
  });
});
