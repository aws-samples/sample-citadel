// Feature: datastore-integration-pipeline, Property 10: Integration Picker Filtering Correctness
// **Validates: Requirements 4.3, 4.6**

import * as fc from 'fast-check';
import { filterIntegrationsByType } from '../integration-picker-utils';
import { Integration } from '../../services/integrationService';

/**
 * Property 10: Integration Picker Filtering Correctness
 *
 * For any list of integrations with various types and any `filterTypes` array:
 * - The Integration Picker displays exactly those integrations whose type is in the `filterTypes` array
 * - When `filterTypes` is empty or not provided, all integrations are displayed
 * - Filtering does not alter the order or content of integration objects
 */

// --- Known integration categories (from the integration service) ---
const KNOWN_CATEGORIES = [
  'productivity',
  'communication',
  'crm',
  'payments',
  'storage',
  'automation',
  'database',
  'analytics',
  'ai-services',
  'security',
] as const;

// --- Arbitraries ---

/** Generates a valid integration category */
const arbCategory = fc.constantFrom(...KNOWN_CATEGORIES);

/** Generates a minimal Integration object with the given category */
const arbIntegration: fc.Arbitrary<Integration> = fc.record({
  id: fc.uuid(),
  name: fc.string({ minLength: 1, maxLength: 50 }),
  description: fc.string({ maxLength: 100 }),
  category: arbCategory,
  provider: fc.string({ minLength: 1, maxLength: 30 }),
  status: fc.constantFrom('connected' as const, 'disconnected' as const, 'error' as const, 'configuring' as const),
  icon: fc.constantFrom('Cloud', 'Database', 'Zap', 'FileText', 'Brain'),
  isPopular: fc.boolean(),
  lastSync: fc.string({ maxLength: 20 }),
  features: fc.array(fc.string({ minLength: 1, maxLength: 20 }), { maxLength: 5 }),
  pricing: fc.constantFrom('free' as const, 'paid' as const, 'freemium' as const),
  setupComplexity: fc.constantFrom('easy' as const, 'medium' as const, 'advanced' as const),
});

/** Generates a list of integrations */
const arbIntegrationList = fc.array(arbIntegration, { minLength: 0, maxLength: 20 });

/** Generates a filterTypes array from known categories */
const arbFilterTypes = fc.array(arbCategory, { minLength: 0, maxLength: KNOWN_CATEGORIES.length });

// --- Tests ---

describe('Property 10: Integration Picker Filtering Correctness', () => {
  // Feature: datastore-integration-pipeline, Property 10: Integration Picker Filtering Correctness

  it('when filterTypes is provided, returns exactly integrations whose category is in filterTypes', () => {
    const arbNonEmptyFilterTypes = fc.array(arbCategory, { minLength: 1, maxLength: KNOWN_CATEGORIES.length });

    fc.assert(
      fc.property(arbIntegrationList, arbNonEmptyFilterTypes, (integrations, filterTypes) => {
        const result = filterIntegrationsByType(integrations, filterTypes);
        const filterSet = new Set(filterTypes);

        // Every returned integration must have a category in filterTypes
        for (const integration of result) {
          expect(filterSet.has(integration.category)).toBe(true);
        }

        // Every integration in the original list whose category is in filterTypes must be in the result
        const expected = integrations.filter((i) => filterSet.has(i.category));
        expect(result.length).toBe(expected.length);
      }),
      { numRuns: 100 },
    );
  });

  it('when filterTypes is empty, all integrations are displayed', () => {
    fc.assert(
      fc.property(arbIntegrationList, (integrations) => {
        const result = filterIntegrationsByType(integrations, []);
        expect(result).toEqual(integrations);
        expect(result.length).toBe(integrations.length);
      }),
      { numRuns: 100 },
    );
  });

  it('when filterTypes is undefined, all integrations are displayed', () => {
    fc.assert(
      fc.property(arbIntegrationList, (integrations) => {
        const result = filterIntegrationsByType(integrations, undefined);
        expect(result).toEqual(integrations);
        expect(result.length).toBe(integrations.length);
      }),
      { numRuns: 100 },
    );
  });

  it('when filterTypes is null, all integrations are displayed', () => {
    fc.assert(
      fc.property(arbIntegrationList, (integrations) => {
        const result = filterIntegrationsByType(integrations, null);
        expect(result).toEqual(integrations);
        expect(result.length).toBe(integrations.length);
      }),
      { numRuns: 100 },
    );
  });

  it('filtering preserves the original order of integration objects', () => {
    // Use non-empty filterTypes to test ordering under actual filtering
    const arbNonEmptyFilterTypes = fc.array(arbCategory, { minLength: 1, maxLength: KNOWN_CATEGORIES.length });

    fc.assert(
      fc.property(arbIntegrationList, arbNonEmptyFilterTypes, (integrations, filterTypes) => {
        const result = filterIntegrationsByType(integrations, filterTypes);
        const filterSet = new Set(filterTypes);

        // Build expected by filtering in order
        const expected = integrations.filter((i) => filterSet.has(i.category));

        // Order must match exactly
        expect(result).toEqual(expected);
      }),
      { numRuns: 100 },
    );
  });

  it('filtering does not alter the content of integration objects', () => {
    const arbNonEmptyFilterTypes = fc.array(arbCategory, { minLength: 1, maxLength: KNOWN_CATEGORIES.length });

    fc.assert(
      fc.property(arbIntegrationList, arbNonEmptyFilterTypes, (integrations, filterTypes) => {
        const result = filterIntegrationsByType(integrations, filterTypes);

        // Each result item must be referentially identical to the original
        for (const item of result) {
          const original = integrations.find(
            (i) => i.id === item.id && i.name === item.name && i.category === item.category,
          );
          expect(original).toBeDefined();
          expect(item).toEqual(original);
        }
      }),
      { numRuns: 100 },
    );
  });
});
