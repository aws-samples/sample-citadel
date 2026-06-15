// Feature: tool-integration-binding, Property 9: Wizard Submission Includes Correct Bindings
import * as fc from 'fast-check';
import {
  buildDataStoreToolPayload,
  buildIntegrationToolPayload,
} from '../wizard-payload-builders';

/**
 * Property 9: Wizard Submission Includes Correct Bindings
 *
 * For any data store selection (dataStoreId, dataStoreType, operations) or
 * integration selection (integrationId, integrationType, operations), the wizard
 * submission payload should contain a bindings array where each binding's
 * dataStoreId/integrationId, type, and operations match the user's selections exactly.
 *
 * Validates: Requirements 5.5, 6.6
 */

// --- Arbitraries ---

/** Generates a non-empty alphanumeric string suitable for IDs */
const arbId = fc.stringMatching(/^[a-zA-Z0-9_-]+$/).filter((s) => s.length > 0);

/** Generates a non-empty string for type names */
const arbType = fc.stringMatching(/^[A-Z][A-Z0-9_]*$/).filter((s) => s.length > 0);

/** Generates a non-empty array of operation strings */
const arbOperations = fc
  .array(
    fc.stringMatching(/^[a-z][a-z0-9_]*$/).filter((s) => s.length > 0),
    { minLength: 1, maxLength: 10 },
  )
  .map((ops) => [...new Set(ops)]) // deduplicate
  .filter((ops) => ops.length > 0);

/** Generates a data store selection */
const arbDataStoreSelection = fc.record({
  dataStoreId: arbId,
  dataStoreType: arbType,
  operations: arbOperations,
});

/** Generates an integration selection */
const arbIntegrationSelection = fc.record({
  integrationId: arbId,
  integrationType: arbType,
  operations: arbOperations,
});

/** Generates a non-empty tool name */
const arbToolName = fc.string({ minLength: 1, maxLength: 100 }).filter((s) => s.trim().length > 0);

/** Generates a non-empty tool description */
const arbToolDescription = fc
  .string({ minLength: 1, maxLength: 500 })
  .filter((s) => s.trim().length > 0);

describe('Wizard Submission - Property-Based Tests', () => {
  // Feature: tool-integration-binding, Property 9: Wizard Submission Includes Correct Bindings
  describe('Property 9: Wizard Submission Includes Correct Bindings', () => {
    test('buildDataStoreToolPayload produces payload with dataStoreBindings matching selections exactly', () => {
      fc.assert(
        fc.property(
          arbToolName,
          arbToolDescription,
          arbDataStoreSelection,
          (toolName, toolDescription, dataStoreSelection) => {
            const payload = buildDataStoreToolPayload({
              toolName,
              toolDescription,
              dataStoreId: dataStoreSelection.dataStoreId,
              dataStoreType: dataStoreSelection.dataStoreType,
              operations: dataStoreSelection.operations,
            });

            // Payload must have toolName and toolDescription
            expect(payload.toolName).toBe(toolName);
            expect(typeof payload.toolDescription).toBe('string');
            expect(payload.toolDescription.length).toBeGreaterThan(0);

            // Payload must have dataStoreBindings array with exactly one binding
            expect(Array.isArray(payload.dataStoreBindings)).toBe(true);
            expect(payload.dataStoreBindings).toHaveLength(1);

            const binding = payload.dataStoreBindings![0];

            // Binding ID must match selection
            expect(binding.dataStoreId).toBe(dataStoreSelection.dataStoreId);

            // Binding type must match selection
            expect(binding.dataStoreType).toBe(dataStoreSelection.dataStoreType);

            // Binding operations must match selection exactly
            expect(binding.operations).toEqual(dataStoreSelection.operations);
          },
        ),
        { numRuns: 100 },
      );
    });

    test('buildIntegrationToolPayload produces payload with integrationBindings matching selections exactly', () => {
      fc.assert(
        fc.property(
          arbToolName,
          arbToolDescription,
          arbIntegrationSelection,
          (toolName, toolDescription, integrationSelection) => {
            const payload = buildIntegrationToolPayload({
              toolName,
              toolDescription,
              integrationId: integrationSelection.integrationId,
              integrationType: integrationSelection.integrationType,
              operations: integrationSelection.operations,
            });

            // Payload must have toolName and toolDescription
            expect(payload.toolName).toBe(toolName);
            expect(typeof payload.toolDescription).toBe('string');
            expect(payload.toolDescription.length).toBeGreaterThan(0);

            // Payload must have integrationBindings array with exactly one binding
            expect(Array.isArray(payload.integrationBindings)).toBe(true);
            expect(payload.integrationBindings).toHaveLength(1);

            const binding = payload.integrationBindings![0];

            // Binding ID must match selection
            expect(binding.integrationId).toBe(integrationSelection.integrationId);

            // Binding type must match selection
            expect(binding.integrationType).toBe(integrationSelection.integrationType);

            // Binding operations must match selection exactly (as operation IDs)
            expect(binding.operations).toEqual(integrationSelection.operations);
          },
        ),
        { numRuns: 100 },
      );
    });

    test('dataStore payload does not include integrationBindings', () => {
      fc.assert(
        fc.property(
          arbToolName,
          arbToolDescription,
          arbDataStoreSelection,
          (toolName, toolDescription, dataStoreSelection) => {
            const payload = buildDataStoreToolPayload({
              toolName,
              toolDescription,
              dataStoreId: dataStoreSelection.dataStoreId,
              dataStoreType: dataStoreSelection.dataStoreType,
              operations: dataStoreSelection.operations,
            });

            // DataStore payload must NOT have integrationBindings
            expect(payload.integrationBindings).toBeUndefined();
          },
        ),
        { numRuns: 100 },
      );
    });

    test('integration payload does not include dataStoreBindings', () => {
      fc.assert(
        fc.property(
          arbToolName,
          arbToolDescription,
          arbIntegrationSelection,
          (toolName, toolDescription, integrationSelection) => {
            const payload = buildIntegrationToolPayload({
              toolName,
              toolDescription,
              integrationId: integrationSelection.integrationId,
              integrationType: integrationSelection.integrationType,
              operations: integrationSelection.operations,
            });

            // Integration payload must NOT have dataStoreBindings
            expect(payload.dataStoreBindings).toBeUndefined();
          },
        ),
        { numRuns: 100 },
      );
    });
  });
});
