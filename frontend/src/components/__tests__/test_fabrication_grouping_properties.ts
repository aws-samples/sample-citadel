/**
 * Property test: Fabrication tray grouping (P19)
 *
 * For any list of fabrication items (some with appId, some without),
 * grouping produces one group per distinct appId, an "Unassigned" group
 * for items without appId, every item in exactly one group, and total
 * count equals input count.
 *
 * **Validates: Requirements 11.1, 11.4**
 */
import * as fc from 'fast-check';
import { groupFabricationItems } from '../fabricationGrouping';

interface GroupableFabricationItem {
  requestId: string;
  agentName: string;
  taskDescription: string;
  status: 'PENDING' | 'PROCESSING' | 'COMPLETED' | 'FAILED';
  submittedAt: string;
  appId?: string;
  appName?: string;
}

// Arbitraries
const baseItemFields = {
  agentName: fc.string({ minLength: 1, maxLength: 20 }),
  taskDescription: fc.string({ minLength: 1, maxLength: 50 }),
  status: fc.constantFrom('PENDING' as const, 'PROCESSING' as const, 'COMPLETED' as const, 'FAILED' as const),
  submittedAt: fc.constant('2024-01-01T00:00:00Z'),
};

const itemWithAppArb: fc.Arbitrary<GroupableFabricationItem> = fc.record({
  requestId: fc.uuid(),
  ...baseItemFields,
  appId: fc.stringMatching(/^app-[a-z0-9]{3,8}$/),
  appName: fc.string({ minLength: 1, maxLength: 30 }),
});

const itemWithoutAppArb: fc.Arbitrary<GroupableFabricationItem> = fc.record({
  requestId: fc.uuid(),
  ...baseItemFields,
});

const fabricationItemArb = fc.oneof(itemWithAppArb, itemWithoutAppArb);

describe('Feature: app-publishing-gateway, Property 19: Fabrication tray grouping', () => {
  it('produces one group per distinct appId plus Unassigned for items without appId', () => {
    fc.assert(
      fc.property(
        fc.array(fabricationItemArb, { minLength: 1, maxLength: 30 }),
        (items) => {
          const groups = groupFabricationItems(items);

          const distinctAppIds = new Set(
            items.filter((i) => i.appId).map((i) => i.appId),
          );
          const hasUnassigned = items.some((i) => !i.appId);

          const expectedGroupCount = distinctAppIds.size + (hasUnassigned ? 1 : 0);
          expect(groups.length).toBe(expectedGroupCount);
        },
      ),
      { numRuns: 200 },
    );
  });

  it('every item appears in exactly one group', () => {
    fc.assert(
      fc.property(
        fc.array(fabricationItemArb, { minLength: 1, maxLength: 30 }),
        (items) => {
          const groups = groupFabricationItems(items);

          const allGroupedIds = groups.flatMap((g) =>
            g.items.map((i) => i.requestId),
          );

          // No duplicates
          expect(new Set(allGroupedIds).size).toBe(allGroupedIds.length);

          // Every input item is present
          const inputIds = new Set(items.map((i) => i.requestId));
          const groupedIds = new Set(allGroupedIds);
          for (const id of inputIds) {
            expect(groupedIds.has(id)).toBe(true);
          }
        },
      ),
      { numRuns: 200 },
    );
  });

  it('total count across all groups equals input count', () => {
    fc.assert(
      fc.property(
        fc.array(fabricationItemArb, { minLength: 0, maxLength: 30 }),
        (items) => {
          const groups = groupFabricationItems(items);
          const totalGrouped = groups.reduce((sum, g) => sum + g.items.length, 0);
          expect(totalGrouped).toBe(items.length);
        },
      ),
      { numRuns: 200 },
    );
  });

  it('Unassigned group contains only items without appId', () => {
    fc.assert(
      fc.property(
        fc.array(fabricationItemArb, { minLength: 1, maxLength: 30 }),
        (items) => {
          const groups = groupFabricationItems(items);
          const unassigned = groups.find((g) => g.appId === null);
          if (unassigned) {
            for (const item of unassigned.items) {
              expect(item.appId).toBeUndefined();
            }
          }
        },
      ),
      { numRuns: 200 },
    );
  });
});
