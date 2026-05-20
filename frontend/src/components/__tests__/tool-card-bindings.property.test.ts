// Feature: tool-integration-binding, Property 11: ToolCard Displays Binding Badges
import * as fc from 'fast-check';
import { extractBindingBadges, BindingBadge } from '../tool-card-badge-helpers';

/**
 * Property 11: ToolCard Displays Binding Badges
 *
 * For any ToolConfig with non-empty integrationBindings or dataStoreBindings,
 * the extracted binding badges should contain a badge element for each binding entry.
 * Integration bindings produce badges with the integrationType text.
 * Data store bindings produce badges with the dataStoreType text.
 *
 * **Validates: Requirements 8.5**
 */

// --- Arbitraries ---

/** Generates a non-empty alphanumeric string suitable for IDs */
const arbId = fc.stringMatching(/^[a-zA-Z0-9_-]+$/).filter((s) => s.length > 0);

/** Generates a non-empty string for type names (e.g., CONFLUENCE, S3) */
const arbType = fc.stringMatching(/^[A-Z][A-Z0-9_]*$/).filter((s) => s.length > 0);

/** Generates an optional array of operation strings */
const arbOperations = fc.option(
  fc
    .array(
      fc.stringMatching(/^[a-z][a-z0-9_]*$/).filter((s) => s.length > 0),
      { minLength: 1, maxLength: 5 },
    )
    .map((ops) => [...new Set(ops)])
    .filter((ops) => ops.length > 0),
  { nil: undefined },
);

/** Generates a single IntegrationBinding */
const arbIntegrationBinding = fc.record({
  integrationId: arbId,
  integrationType: arbType,
  operations: arbOperations,
});

/** Generates a single DataStoreBinding */
const arbDataStoreBinding = fc.record({
  dataStoreId: arbId,
  dataStoreType: arbType,
  operations: arbOperations,
});

/** Generates a non-empty array of IntegrationBindings */
const arbIntegrationBindings = fc.array(arbIntegrationBinding, { minLength: 1, maxLength: 5 });

/** Generates a non-empty array of DataStoreBindings */
const arbDataStoreBindings = fc.array(arbDataStoreBinding, { minLength: 1, maxLength: 5 });

/** Generates a ToolConfig state */
const arbState = fc.constantFrom('active' as const, 'inactive' as const, 'maintenance' as const);

/** Generates a minimal ToolConfig with the given bindings */
function arbToolConfig(
  integrationBindings?: fc.Arbitrary<{ integrationId: string; integrationType: string; operations?: string[] }[]>,
  dataStoreBindings?: fc.Arbitrary<{ dataStoreId: string; dataStoreType: string; operations?: string[] }[]>,
) {
  return fc.record({
    toolId: arbId,
    config: fc.constant({ name: 'test-tool', description: 'A test tool', version: '1' }),
    state: arbState,
    integrationBindings: integrationBindings ?? fc.constant(undefined),
    dataStoreBindings: dataStoreBindings ?? fc.constant(undefined),
  });
}

describe('ToolCard Binding Badges - Property-Based Tests', () => {
  // Feature: tool-integration-binding, Property 11: ToolCard Displays Binding Badges
  describe('Property 11: ToolCard Displays Binding Badges', () => {
    test('each integration binding produces a badge with integrationType label', () => {
      fc.assert(
        fc.property(
          arbToolConfig(arbIntegrationBindings, fc.constant(undefined)),
          (tool) => {
            const badges = extractBindingBadges(tool as any);

            const integrationBadges = badges.filter((b: BindingBadge) => b.type === 'integration');

            // There must be exactly one badge per integration binding
            expect(integrationBadges).toHaveLength(tool.integrationBindings!.length);

            // Each badge label must contain the corresponding binding's integrationType
            for (const binding of tool.integrationBindings!) {
              const matchingBadge = integrationBadges.find(
                (b: BindingBadge) => b.label.includes(binding.integrationType),
              );
              expect(matchingBadge).toBeDefined();
              expect(matchingBadge!.type).toBe('integration');
            }
          },
        ),
        { numRuns: 100 },
      );
    });

    test('each data store binding produces a badge with dataStoreType label', () => {
      fc.assert(
        fc.property(
          arbToolConfig(fc.constant(undefined), arbDataStoreBindings),
          (tool) => {
            const badges = extractBindingBadges(tool as any);

            const dataStoreBadges = badges.filter((b: BindingBadge) => b.type === 'dataStore');

            // There must be exactly one badge per data store binding
            expect(dataStoreBadges).toHaveLength(tool.dataStoreBindings!.length);

            // Each badge label must contain the corresponding binding's dataStoreType
            for (const binding of tool.dataStoreBindings!) {
              const matchingBadge = dataStoreBadges.find(
                (b: BindingBadge) => b.label.includes(binding.dataStoreType),
              );
              expect(matchingBadge).toBeDefined();
              expect(matchingBadge!.type).toBe('dataStore');
            }
          },
        ),
        { numRuns: 100 },
      );
    });

    test('ToolConfig with both binding types produces badges for all entries', () => {
      fc.assert(
        fc.property(
          arbToolConfig(arbIntegrationBindings, arbDataStoreBindings),
          (tool) => {
            const badges = extractBindingBadges(tool as any);

            const expectedTotal =
              tool.integrationBindings!.length + tool.dataStoreBindings!.length;

            // Total badge count must equal sum of both binding arrays
            expect(badges).toHaveLength(expectedTotal);

            // Integration badges present
            const integrationBadges = badges.filter((b: BindingBadge) => b.type === 'integration');
            expect(integrationBadges).toHaveLength(tool.integrationBindings!.length);

            // Data store badges present
            const dataStoreBadges = badges.filter((b: BindingBadge) => b.type === 'dataStore');
            expect(dataStoreBadges).toHaveLength(tool.dataStoreBindings!.length);
          },
        ),
        { numRuns: 100 },
      );
    });

    test('ToolConfig with no bindings produces empty badges array', () => {
      fc.assert(
        fc.property(
          arbToolConfig(fc.constant(undefined), fc.constant(undefined)),
          (tool) => {
            const badges = extractBindingBadges(tool as any);
            expect(badges).toHaveLength(0);
          },
        ),
        { numRuns: 100 },
      );
    });

    test('ToolConfig with null bindings produces empty badges array', () => {
      fc.assert(
        fc.property(
          fc.record({
            toolId: arbId,
            config: fc.constant({ name: 'test-tool', description: 'A test tool', version: '1' }),
            state: arbState,
            integrationBindings: fc.constant(null),
            dataStoreBindings: fc.constant(null),
          }),
          (tool) => {
            const badges = extractBindingBadges(tool as any);
            expect(badges).toHaveLength(0);
          },
        ),
        { numRuns: 100 },
      );
    });

    test('ToolConfig with empty binding arrays produces empty badges array', () => {
      fc.assert(
        fc.property(
          fc.record({
            toolId: arbId,
            config: fc.constant({ name: 'test-tool', description: 'A test tool', version: '1' }),
            state: arbState,
            integrationBindings: fc.constant([]),
            dataStoreBindings: fc.constant([]),
          }),
          (tool) => {
            const badges = extractBindingBadges(tool as any);
            expect(badges).toHaveLength(0);
          },
        ),
        { numRuns: 100 },
      );
    });
  });
});
