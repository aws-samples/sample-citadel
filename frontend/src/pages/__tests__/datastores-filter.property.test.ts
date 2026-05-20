// Feature: datastore-integration-pipeline, Property 6: Usage Filter Correctness
// **Validates: Requirements 2.2, 2.3, 2.4, 2.5**

import * as fc from 'fast-check';
import { DataStoreUsage, DataStoreCategory } from '@/services/datastoreService';
import {
  filterDataStoresByUsage,
  UsageFilterTab,
} from '@/pages/datastoreFilterUtils';

// ---- Generators ----

const usageArb = fc.constantFrom(
  DataStoreUsage.KNOWLEDGE,
  DataStoreUsage.OPERATIONAL,
  DataStoreUsage.BOTH,
);

const categoryArb = fc.constantFrom(
  DataStoreCategory.S3_STORAGE,
  DataStoreCategory.NOSQL_DATABASE,
  DataStoreCategory.RELATIONAL_DATABASE,
  DataStoreCategory.KNOWLEDGE_BASE,
  DataStoreCategory.DATA_WAREHOUSE,
  DataStoreCategory.SEARCH_ENGINE,
  DataStoreCategory.GRAPH_DATABASE,
  DataStoreCategory.EXTERNAL,
);

interface MinimalDataStore {
  dataStoreId: string;
  name: string;
  usage?: DataStoreUsage;
  category: DataStoreCategory;
}

const dataStoreArb: fc.Arbitrary<MinimalDataStore> = fc.record({
  dataStoreId: fc.stringMatching(/^ds-[a-z0-9]{6}$/),
  name: fc.stringMatching(/^[A-Za-z][A-Za-z0-9 ]{2,15}$/),
  usage: fc.oneof(usageArb, fc.constant(undefined)),
  category: categoryArb,
});

const dataStoreWithUsageArb: fc.Arbitrary<MinimalDataStore> = fc.record({
  dataStoreId: fc.stringMatching(/^ds-[a-z0-9]{6}$/),
  name: fc.stringMatching(/^[A-Za-z][A-Za-z0-9 ]{2,15}$/),
  usage: usageArb,
  category: categoryArb,
});

// ---- Tests ----

describe('Property 6: Usage Filter Correctness', () => {
  it('"Knowledge Stores" filter returns exactly stores with usage knowledge or both', () => {
    return fc.assert(
      fc.property(
        fc.array(dataStoreWithUsageArb, { minLength: 0, maxLength: 20 }),
        (stores) => {
          const result = filterDataStoresByUsage(stores as any[], 'knowledge');
          const expected = stores.filter(
            (s) => s.usage === DataStoreUsage.KNOWLEDGE || s.usage === DataStoreUsage.BOTH,
          );
          expect(result).toHaveLength(expected.length);
          for (const item of result) {
            expect(
              item.usage === DataStoreUsage.KNOWLEDGE || item.usage === DataStoreUsage.BOTH,
            ).toBe(true);
          }
          // Ensure no stores were missed
          for (const s of stores) {
            if (s.usage === DataStoreUsage.KNOWLEDGE || s.usage === DataStoreUsage.BOTH) {
              expect(result).toContainEqual(s);
            }
          }
        },
      ),
      { numRuns: 100 },
    );
  });

  it('"Writable Stores" filter returns exactly stores with usage operational or both', () => {
    return fc.assert(
      fc.property(
        fc.array(dataStoreWithUsageArb, { minLength: 0, maxLength: 20 }),
        (stores) => {
          const result = filterDataStoresByUsage(stores as any[], 'operational');
          const expected = stores.filter(
            (s) => s.usage === DataStoreUsage.OPERATIONAL || s.usage === DataStoreUsage.BOTH,
          );
          expect(result).toHaveLength(expected.length);
          for (const item of result) {
            expect(
              item.usage === DataStoreUsage.OPERATIONAL || item.usage === DataStoreUsage.BOTH,
            ).toBe(true);
          }
          for (const s of stores) {
            if (s.usage === DataStoreUsage.OPERATIONAL || s.usage === DataStoreUsage.BOTH) {
              expect(result).toContainEqual(s);
            }
          }
        },
      ),
      { numRuns: 100 },
    );
  });

  it('"All" filter returns all stores', () => {
    return fc.assert(
      fc.property(
        fc.array(dataStoreWithUsageArb, { minLength: 0, maxLength: 20 }),
        (stores) => {
          const result = filterDataStoresByUsage(stores as any[], 'all');
          expect(result).toHaveLength(stores.length);
          expect(result).toEqual(stores);
        },
      ),
      { numRuns: 100 },
    );
  });

  it('usage filter and category filter compose correctly (intersection of both filter results)', () => {
    const usageTabArb = fc.constantFrom<UsageFilterTab>('all', 'knowledge', 'operational');

    return fc.assert(
      fc.property(
        fc.array(dataStoreWithUsageArb, { minLength: 0, maxLength: 20 }),
        usageTabArb,
        categoryArb,
        (stores, usageTab, category) => {
          // Apply usage filter
          const usageFiltered = filterDataStoresByUsage(stores as any[], usageTab);
          // Apply category filter on top
          const combined = usageFiltered.filter((s: any) => s.category === category);

          // Independently compute expected: stores matching BOTH filters
          const expected = stores.filter((s) => {
            const matchesUsage =
              usageTab === 'all' ||
              (usageTab === 'knowledge' &&
                (s.usage === DataStoreUsage.KNOWLEDGE || s.usage === DataStoreUsage.BOTH)) ||
              (usageTab === 'operational' &&
                (s.usage === DataStoreUsage.OPERATIONAL || s.usage === DataStoreUsage.BOTH));
            const matchesCategory = s.category === category;
            return matchesUsage && matchesCategory;
          });

          expect(combined).toHaveLength(expected.length);
          for (const item of expected) {
            expect(combined).toContainEqual(item);
          }
        },
      ),
      { numRuns: 100 },
    );
  });
});
