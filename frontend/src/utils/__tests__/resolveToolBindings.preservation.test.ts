/**
 * Preservation Property Tests — resolveToolBindings
 *
 * Property 2: Preservation — Non-Binding Drop Behavior Unchanged
 *
 * These tests verify that for all inputs where the bug condition does NOT hold,
 * `resolveToolBindings` returns `[]`. This captures the baseline behavior that
 * must be preserved after the fix is applied.
 *
 * Bug condition (isBugCondition) returns FALSE when:
 *   - Agent has no tools (config.tools is [] or undefined)
 *   - Agent has tools but none match any ToolConfig
 *   - Agent has matching tools but those ToolConfigs have no bindings
 *     (integrationBindings and dataStoreBindings are null, undefined, or [])
 *
 * **Validates: Requirements 3.1, 3.2, 3.3, 3.4, 3.5**
 */

import * as fc from 'fast-check';
import type { AgentConfig } from '@/services/agentConfigService';
import type { ToolConfig } from '@/services/toolConfigService';

// ---- Mock toolConfigService before importing the module under test ----
const mockListToolConfigs = jest.fn<Promise<ToolConfig[]>, []>();

jest.mock('@/services/toolConfigService', () => ({
  toolConfigService: {
    listToolConfigs: () => mockListToolConfigs(),
  },
}));

import { resolveToolBindings } from '@/utils/resolveToolBindings';

// ---- Arbitraries ----

const toolIdArb = fc
  .string({ minLength: 3, maxLength: 15 })
  .filter((s) => /^[a-z][a-z0-9-]+$/.test(s));

/**
 * Generate a ToolConfig with NO bindings (null, undefined, or empty arrays).
 */
function toolConfigWithoutBindingsArb(toolId: string): fc.Arbitrary<ToolConfig> {
  return fc
    .record({
      integrationBindingsVariant: fc.constantFrom('null', 'undefined', 'empty'),
      dataStoreBindingsVariant: fc.constantFrom('null', 'undefined', 'empty'),
    })
    .map(({ integrationBindingsVariant, dataStoreBindingsVariant }) => ({
      toolId,
      config: { name: `${toolId}-tool` },
      state: 'active' as const,
      integrationBindings:
        integrationBindingsVariant === 'null'
          ? null
          : integrationBindingsVariant === 'undefined'
            ? undefined
            : [],
      dataStoreBindings:
        dataStoreBindingsVariant === 'null'
          ? null
          : dataStoreBindingsVariant === 'undefined'
            ? undefined
            : [],
    }));
}

// ---- Tests ----

describe('Property 2: Preservation — Non-Binding Drop Behavior Unchanged', () => {
  afterEach(() => {
    jest.clearAllMocks();
  });

  /**
   * Property: For agents with no tools, resolveToolBindings returns [].
   *
   * Generates AgentConfig with config.tools as [] or undefined,
   * paired with arbitrary ToolConfig[] (which should be irrelevant).
   *
   * **Validates: Requirements 3.1**
   */
  it('returns [] for agents with no tools (config.tools is [] or undefined)', async () => {
    await fc.assert(
      fc.asyncProperty(
        fc.record({
          toolsVariant: fc.constantFrom('empty', 'undefined', 'missing'),
          toolConfigs: fc.array(
            toolIdArb.chain((id) => toolConfigWithoutBindingsArb(id)),
            { minLength: 0, maxLength: 3 },
          ),
        }),
        async ({ toolsVariant, toolConfigs }) => {
          jest.clearAllMocks();
          mockListToolConfigs.mockResolvedValue(toolConfigs);

          const config: Record<string, any> = { name: 'TestAgent' };
          if (toolsVariant === 'empty') {
            config.tools = [];
          } else if (toolsVariant === 'undefined') {
            config.tools = undefined;
          }
          // 'missing' — no tools key at all

          const agentConfig: AgentConfig = {
            agentId: 'agent-no-tools',
            config,
            state: 'active',
          };

          const result = await resolveToolBindings(agentConfig);
          expect(result).toEqual([]);
        },
      ),
      { numRuns: 30 },
    );
  });

  /**
   * Property: For agents with tool IDs that don't match any ToolConfig, result is [].
   *
   * Generates AgentConfig with tool IDs and ToolConfig[] where none of the
   * ToolConfig.toolId values overlap with the agent's tool IDs.
   *
   * **Validates: Requirements 3.2**
   */
  it('returns [] for agents whose tool IDs do not match any ToolConfig', async () => {
    await fc.assert(
      fc.asyncProperty(
        fc
          .tuple(
            fc.array(toolIdArb, { minLength: 1, maxLength: 3 }),
            fc.array(toolIdArb, { minLength: 1, maxLength: 3 }),
          )
          .filter(([agentToolIds, configToolIds]) => {
            // Ensure no overlap between agent tool IDs and config tool IDs
            const agentSet = new Set(agentToolIds);
            return configToolIds.every((id) => !agentSet.has(id));
          })
          .chain(([agentToolIds, configToolIds]) => {
            const toolConfigArbs = configToolIds.map((id) =>
              toolConfigWithoutBindingsArb(id),
            );
            return fc
              .tuple(fc.constant(agentToolIds), ...toolConfigArbs)
              .map(([ids, ...configs]) => ({
                agentToolIds: ids as string[],
                toolConfigs: configs as ToolConfig[],
              }));
          }),
        async ({ agentToolIds, toolConfigs }) => {
          jest.clearAllMocks();
          mockListToolConfigs.mockResolvedValue(toolConfigs);

          const agentConfig: AgentConfig = {
            agentId: 'agent-no-match',
            config: { name: 'NoMatchAgent', tools: agentToolIds },
            state: 'active',
          };

          const result = await resolveToolBindings(agentConfig);
          expect(result).toEqual([]);
        },
      ),
      { numRuns: 30 },
    );
  });

  /**
   * Property: For ToolConfig entries with null/undefined/empty bindings, result is [].
   *
   * Generates AgentConfig with tool IDs that DO match ToolConfig entries,
   * but those ToolConfigs have integrationBindings: null and dataStoreBindings: null
   * (or undefined, or []).
   *
   * **Validates: Requirements 3.2**
   */
  it('returns [] for matching ToolConfigs with null/undefined/empty bindings', async () => {
    await fc.assert(
      fc.asyncProperty(
        fc.array(toolIdArb, { minLength: 1, maxLength: 4 }).chain((toolIds) => {
          const uniqueIds = [...new Set(toolIds)];
          const toolConfigArbs = uniqueIds.map((id) =>
            toolConfigWithoutBindingsArb(id),
          );
          return fc
            .tuple(fc.constant(uniqueIds), ...toolConfigArbs)
            .map(([ids, ...configs]) => ({
              agentToolIds: ids as string[],
              toolConfigs: configs as ToolConfig[],
            }));
        }),
        async ({ agentToolIds, toolConfigs }) => {
          jest.clearAllMocks();
          mockListToolConfigs.mockResolvedValue(toolConfigs);

          const agentConfig: AgentConfig = {
            agentId: 'agent-no-bindings',
            config: { name: 'NoBindingsAgent', tools: agentToolIds },
            state: 'active',
          };

          const result = await resolveToolBindings(agentConfig);
          expect(result).toEqual([]);
        },
      ),
      { numRuns: 30 },
    );
  });
});
