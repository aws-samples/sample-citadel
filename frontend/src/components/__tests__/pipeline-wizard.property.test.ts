// Feature: datastore-integration-pipeline, Property 8: Pipeline Submission Directional Bindings
// **Validates: Requirements 9.2, 9.3, 9.5**

import * as fc from 'fast-check';
import {
  buildPipelineBindings,
  buildPipelineToolPayload,
  PipelineResourceSelection,
} from '../pipeline-wizard-utils';

/**
 * Property 8: Pipeline Submission Directional Bindings
 *
 * For any input source selection (data store or integration with ID, type, operations)
 * and output destination selection, the resulting ToolConfig creation payload contains:
 * - Exactly one binding with `direction: 'input'` matching the input source
 * - Exactly one binding with `direction: 'output'` matching the output destination
 * - Input binding's resource ID, type, and operations match the selected input source
 * - Output binding's resource ID, type, and operations match the selected output destination
 */

// --- Arbitraries ---

/** Generates a non-empty alphanumeric string suitable for IDs */
const arbId = fc.stringMatching(/^[a-zA-Z0-9_-]+$/).filter((s) => s.length > 0);

/** Generates a non-empty string for type names */
const arbType = fc.stringMatching(/^[A-Z][A-Z0-9_]*$/).filter((s) => s.length > 0);

/** Generates a non-empty array of unique operation strings */
const arbOperations = fc
  .array(
    fc.stringMatching(/^[a-z][a-z0-9_]*$/).filter((s) => s.length > 0),
    { minLength: 1, maxLength: 10 },
  )
  .map((ops) => [...new Set(ops)])
  .filter((ops) => ops.length > 0);

/** Generates a resource kind */
const arbKind = fc.constantFrom('dataStore' as const, 'integration' as const);

/** Generates a pipeline resource selection */
const arbResourceSelection: fc.Arbitrary<PipelineResourceSelection> = fc.record({
  kind: arbKind,
  id: arbId,
  type: arbType,
  operations: arbOperations,
});

/** Generates a non-empty tool name */
const arbToolName = fc.string({ minLength: 1, maxLength: 100 }).filter((s) => s.trim().length > 0);

/** Generates a non-empty tool description */
const arbToolDescription = fc
  .string({ minLength: 1, maxLength: 500 })
  .filter((s) => s.trim().length > 0);

/** Generates a non-empty processing logic string */
const arbProcessingLogic = fc
  .string({ minLength: 1, maxLength: 500 })
  .filter((s) => s.trim().length > 0);

// --- Helper: collect all bindings from the result into a flat list with direction ---
function collectAllBindings(result: ReturnType<typeof buildPipelineBindings>) {
  const all: Array<{
    direction: string;
    resourceId: string;
    resourceType: string;
    operations: string[];
    kind: 'dataStore' | 'integration';
  }> = [];

  for (const b of result.dataStoreBindings) {
    all.push({
      direction: b.direction!,
      resourceId: b.dataStoreId,
      resourceType: b.dataStoreType,
      operations: b.operations || [],
      kind: 'dataStore',
    });
  }

  for (const b of result.integrationBindings) {
    all.push({
      direction: b.direction!,
      resourceId: b.integrationId,
      resourceType: b.integrationType,
      operations: b.operations || [],
      kind: 'integration',
    });
  }

  return all;
}

// --- Tests ---

describe('Property 8: Pipeline Submission Directional Bindings', () => {
  // Feature: datastore-integration-pipeline, Property 8: Pipeline Submission Directional Bindings

  it('buildPipelineBindings produces exactly one input and one output binding', () => {
    fc.assert(
      fc.property(arbResourceSelection, arbResourceSelection, (inputSource, outputDest) => {
        const result = buildPipelineBindings(inputSource, outputDest);
        const all = collectAllBindings(result);

        // Must have exactly 2 bindings total
        expect(all).toHaveLength(2);

        // Exactly one with direction 'input'
        const inputBindings = all.filter((b) => b.direction === 'INPUT');
        expect(inputBindings).toHaveLength(1);

        // Exactly one with direction 'output'
        const outputBindings = all.filter((b) => b.direction === 'OUTPUT');
        expect(outputBindings).toHaveLength(1);
      }),
      { numRuns: 100 },
    );
  });

  it('input binding matches the selected input source ID, type, and operations', () => {
    fc.assert(
      fc.property(arbResourceSelection, arbResourceSelection, (inputSource, outputDest) => {
        const result = buildPipelineBindings(inputSource, outputDest);
        const all = collectAllBindings(result);

        const inputBinding = all.find((b) => b.direction === 'INPUT')!;

        // Resource ID must match
        expect(inputBinding.resourceId).toBe(inputSource.id);

        // Resource type must match
        expect(inputBinding.resourceType).toBe(inputSource.type);

        // Operations must match exactly
        expect(inputBinding.operations).toEqual(inputSource.operations);

        // Kind must match
        expect(inputBinding.kind).toBe(inputSource.kind);
      }),
      { numRuns: 100 },
    );
  });

  it('output binding matches the selected output destination ID, type, and operations', () => {
    fc.assert(
      fc.property(arbResourceSelection, arbResourceSelection, (inputSource, outputDest) => {
        const result = buildPipelineBindings(inputSource, outputDest);
        const all = collectAllBindings(result);

        const outputBinding = all.find((b) => b.direction === 'OUTPUT')!;

        // Resource ID must match
        expect(outputBinding.resourceId).toBe(outputDest.id);

        // Resource type must match
        expect(outputBinding.resourceType).toBe(outputDest.type);

        // Operations must match exactly
        expect(outputBinding.operations).toEqual(outputDest.operations);

        // Kind must match
        expect(outputBinding.kind).toBe(outputDest.kind);
      }),
      { numRuns: 100 },
    );
  });

  it('data store selections produce DataStoreBinding entries, integration selections produce IntegrationBinding entries', () => {
    fc.assert(
      fc.property(arbResourceSelection, arbResourceSelection, (inputSource, outputDest) => {
        const result = buildPipelineBindings(inputSource, outputDest);

        // Count expected data store bindings
        const expectedDsCount =
          (inputSource.kind === 'dataStore' ? 1 : 0) +
          (outputDest.kind === 'dataStore' ? 1 : 0);

        // Count expected integration bindings
        const expectedIntCount =
          (inputSource.kind === 'integration' ? 1 : 0) +
          (outputDest.kind === 'integration' ? 1 : 0);

        expect(result.dataStoreBindings).toHaveLength(expectedDsCount);
        expect(result.integrationBindings).toHaveLength(expectedIntCount);
      }),
      { numRuns: 100 },
    );
  });

  it('buildPipelineToolPayload includes correct directional bindings in the full payload', () => {
    fc.assert(
      fc.property(
        arbToolName,
        arbToolDescription,
        arbProcessingLogic,
        arbResourceSelection,
        arbResourceSelection,
        (toolName, toolDescription, processingLogic, inputSource, outputDest) => {
          const payload = buildPipelineToolPayload({
            toolName,
            toolDescription,
            processingLogic,
            inputSource,
            outputDestination: outputDest,
          });

          // Payload must have the tool name
          expect(payload.toolName).toBe(toolName);

          // Payload description must be non-empty
          expect(payload.toolDescription.length).toBeGreaterThan(0);

          // Collect all bindings from the payload
          const dsBindings = payload.dataStoreBindings || [];
          const intBindings = payload.integrationBindings || [];
          const totalBindings = dsBindings.length + intBindings.length;

          // Must have exactly 2 bindings total
          expect(totalBindings).toBe(2);

          // Verify input binding exists with correct direction
          const allDirections = [
            ...dsBindings.map((b) => b.direction),
            ...intBindings.map((b) => b.direction),
          ];
          expect(allDirections.filter((d) => d === 'INPUT')).toHaveLength(1);
          expect(allDirections.filter((d) => d === 'OUTPUT')).toHaveLength(1);
        },
      ),
      { numRuns: 100 },
    );
  });
});
