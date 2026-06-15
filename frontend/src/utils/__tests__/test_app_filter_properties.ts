/**
 * Property-Based Tests — App Filtering Utilities
 *
 * Tests for filterAppsBySearch and filterAppsByStatus pure functions
 * used by the Agent Apps page.
 *
 * Uses fast-check for property-based testing.
 */

import * as fc from 'fast-check';
import { filterAppsBySearch, filterAppsByStatus, AppItem } from '../appFilters';

// ---- Types ----

interface TestAppItem extends AppItem {
  appId: string;
  name: string;
  description: string;
  status: 'DRAFT' | 'APPROVED' | 'DEPRECATED';
}

// ---- Arbitraries ----

const appStatusArb = fc.constantFrom<'DRAFT' | 'APPROVED' | 'DEPRECATED'>('DRAFT', 'APPROVED', 'DEPRECATED');

const appItemArb: fc.Arbitrary<TestAppItem> = fc.record({
  appId: fc.uuid(),
  name: fc.string({ minLength: 1, maxLength: 100 }).filter(s => s.trim().length > 0),
  description: fc.string({ minLength: 0, maxLength: 500 }),
  status: appStatusArb,
});

const appListArb = fc.array(appItemArb, { minLength: 0, maxLength: 20 });

const searchQueryArb = fc.string({ minLength: 0, maxLength: 50 });

// ---- Property 18: App search filter ----

/**
 * Feature: agent-apps-platform, Property 18: App search filter
 *
 * For any list of apps and any search query string, the filtered results
 * should contain only apps whose name or description contains the query
 * as a case-insensitive substring.
 *
 * **Validates: Requirements 9.4**
 */
describe('Property 18: App search filter', () => {
  it('filtered results contain only apps whose name or description contains query as case-insensitive substring', () => {
    fc.assert(
      fc.property(appListArb, searchQueryArb, (apps, query) => {
        const result = filterAppsBySearch(apps, query);

        // Every result must have name or description containing query (case-insensitive)
        const lowerQuery = query.toLowerCase();
        for (const app of result) {
          const nameMatch = app.name.toLowerCase().includes(lowerQuery);
          const descMatch = app.description.toLowerCase().includes(lowerQuery);
          expect(nameMatch || descMatch).toBe(true);
        }

        // Every app that matches should be in the result
        for (const app of apps) {
          const nameMatch = app.name.toLowerCase().includes(lowerQuery);
          const descMatch = app.description.toLowerCase().includes(lowerQuery);
          if (nameMatch || descMatch) {
            expect(result).toContainEqual(app);
          }
        }
      }),
      { numRuns: 100 },
    );
  });

  it('empty query returns all apps', () => {
    fc.assert(
      fc.property(appListArb, (apps) => {
        const result = filterAppsBySearch(apps, '');
        expect(result).toEqual(apps);
      }),
      { numRuns: 100 },
    );
  });

  it('result is a subset of the input', () => {
    fc.assert(
      fc.property(appListArb, searchQueryArb, (apps, query) => {
        const result = filterAppsBySearch(apps, query);
        expect(result.length).toBeLessThanOrEqual(apps.length);
        for (const app of result) {
          expect(apps).toContainEqual(app);
        }
      }),
      { numRuns: 100 },
    );
  });
});

// ---- Property 19: App status filter ----

/**
 * Feature: agent-apps-platform, Property 19: App status filter
 *
 * For any list of apps and any selected status filter (DRAFT, ACTIVE, ARCHIVED),
 * the filtered results should contain only apps with the matching status.
 * When "All" is selected, all apps should be returned.
 *
 * **Validates: Requirements 9.5**
 */
describe('Property 19: App status filter', () => {
  it('filtered results contain only apps with matching status', () => {
    fc.assert(
      fc.property(appListArb, appStatusArb, (apps, status) => {
        const result = filterAppsByStatus(apps, status);

        // Every result must have the matching status
        for (const app of result) {
          expect(app.status).toBe(status);
        }

        // Every app with matching status should be in the result
        for (const app of apps) {
          if (app.status === status) {
            expect(result).toContainEqual(app);
          }
        }
      }),
      { numRuns: 100 },
    );
  });

  it('"All" returns all apps unchanged', () => {
    fc.assert(
      fc.property(appListArb, (apps) => {
        const result = filterAppsByStatus(apps, 'All');
        expect(result).toEqual(apps);
      }),
      { numRuns: 100 },
    );
  });

  it('result is a subset of the input', () => {
    fc.assert(
      fc.property(appListArb, appStatusArb, (apps, status) => {
        const result = filterAppsByStatus(apps, status);
        expect(result.length).toBeLessThanOrEqual(apps.length);
        for (const app of result) {
          expect(apps).toContainEqual(app);
        }
      }),
      { numRuns: 100 },
    );
  });
});
