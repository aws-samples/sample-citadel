// Feature: agent-wizard-binding-autoselect
// Validates: When tools are selected in the Create Worker wizard, their associated
// data stores and integrations should be automatically selected on the Data Stores & Integrations step.

import * as fc from 'fast-check';
import { computeAutoSelectedResources } from '../agent-wizard-utils';

// --- Arbitraries ---

const arbToolId = fc.stringMatching(/^tool-[a-z0-9]{4,8}$/);
const arbDsId = fc.stringMatching(/^ds-[a-z0-9]{6}$/);
const arbIntId = fc.stringMatching(/^int-[a-z0-9]{6}$/);
const arbDsType = fc.constantFrom('S3', 'DYNAMODB', 'RDS_POSTGRESQL', 'OPENSEARCH');
const arbIntType = fc.constantFrom('CONFLUENCE', 'JIRA', 'SLACK', 'SERVICENOW');
const arbDirection = fc.constantFrom('INPUT', 'OUTPUT', 'BIDIRECTIONAL');

const arbDataStoreBinding = fc.record({
  dataStoreId: arbDsId,
  dataStoreType: arbDsType,
  operations: fc.array(fc.constantFrom('read', 'write', 'query'), { minLength: 1, maxLength: 3 }),
  direction: arbDirection,
});

const arbIntegrationBinding = fc.record({
  integrationId: arbIntId,
  integrationType: arbIntType,
  operations: fc.array(fc.constantFrom('search', 'get', 'create'), { minLength: 1, maxLength: 3 }),
  direction: arbDirection,
});

const arbToolConfig = fc.record({
  toolId: arbToolId,
  config: fc.constant({ name: 'test', description: 'test' }),
  state: fc.constant('active' as const),
  integrationBindings: fc.option(
    fc.array(arbIntegrationBinding, { minLength: 0, maxLength: 3 }),
    { nil: null },
  ),
  dataStoreBindings: fc.option(
    fc.array(arbDataStoreBinding, { minLength: 0, maxLength: 3 }),
    { nil: null },
  ),
});

// --- Tests ---

describe('computeAutoSelectedResources', () => {
  it('returns all unique dataStoreIds from selected tools bindings', () => {
    fc.assert(
      fc.property(
        fc.array(arbToolConfig, { minLength: 1, maxLength: 10 }),
        (tools) => {
          const selectedToolIds = tools.map((t) => t.toolId);
          const result = computeAutoSelectedResources(selectedToolIds, tools as any);

          // Compute expected data store IDs
          const expectedDsIds = new Set<string>();
          for (const tool of tools) {
            if (selectedToolIds.includes(tool.toolId) && tool.dataStoreBindings) {
              for (const b of tool.dataStoreBindings) {
                expectedDsIds.add(b.dataStoreId);
              }
            }
          }

          expect(new Set(result.dataStoreIds)).toEqual(expectedDsIds);
        },
      ),
      { numRuns: 100 },
    );
  });

  it('returns all unique integrationIds from selected tools bindings', () => {
    fc.assert(
      fc.property(
        fc.array(arbToolConfig, { minLength: 1, maxLength: 10 }),
        (tools) => {
          const selectedToolIds = tools.map((t) => t.toolId);
          const result = computeAutoSelectedResources(selectedToolIds, tools as any);

          const expectedIntIds = new Set<string>();
          for (const tool of tools) {
            if (selectedToolIds.includes(tool.toolId) && tool.integrationBindings) {
              for (const b of tool.integrationBindings) {
                expectedIntIds.add(b.integrationId);
              }
            }
          }

          expect(new Set(result.integrationIds)).toEqual(expectedIntIds);
        },
      ),
      { numRuns: 100 },
    );
  });

  it('returns empty arrays when no tools are selected', () => {
    fc.assert(
      fc.property(
        fc.array(arbToolConfig, { minLength: 0, maxLength: 5 }),
        (tools) => {
          const result = computeAutoSelectedResources([], tools as any);
          expect(result.dataStoreIds).toEqual([]);
          expect(result.integrationIds).toEqual([]);
        },
      ),
      { numRuns: 100 },
    );
  });

  it('returns empty arrays when selected tools have no bindings', () => {
    fc.assert(
      fc.property(
        fc.array(arbToolId, { minLength: 1, maxLength: 5 }),
        (toolIds) => {
          const toolsWithNoBindings = toolIds.map((id) => ({
            toolId: id,
            config: { name: 'test' },
            state: 'active' as const,
            integrationBindings: null,
            dataStoreBindings: null,
          }));
          const result = computeAutoSelectedResources(toolIds, toolsWithNoBindings as any);
          expect(result.dataStoreIds).toEqual([]);
          expect(result.integrationIds).toEqual([]);
        },
      ),
      { numRuns: 100 },
    );
  });

  it('only includes bindings from selected tools, not all tools', () => {
    fc.assert(
      fc.property(
        fc.array(arbToolConfig, { minLength: 2, maxLength: 10 }),
        (tools) => {
          // Select only the first tool
          const selectedToolIds = [tools[0].toolId];
          const result = computeAutoSelectedResources(selectedToolIds, tools as any);

          // Result should only contain IDs from the first tool
          const expectedDsIds = new Set<string>();
          const expectedIntIds = new Set<string>();
          const firstTool = tools[0];
          if (firstTool.dataStoreBindings) {
            for (const b of firstTool.dataStoreBindings) expectedDsIds.add(b.dataStoreId);
          }
          if (firstTool.integrationBindings) {
            for (const b of firstTool.integrationBindings) expectedIntIds.add(b.integrationId);
          }

          expect(new Set(result.dataStoreIds)).toEqual(expectedDsIds);
          expect(new Set(result.integrationIds)).toEqual(expectedIntIds);
        },
      ),
      { numRuns: 100 },
    );
  });
});
