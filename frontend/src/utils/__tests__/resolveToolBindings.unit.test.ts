/**
 * Unit + Property-Based Tests — resolveToolBindings
 *
 * Validates the resolveToolBindings utility function with deterministic
 * unit tests and fast-check property-based tests.
 *
 * **Validates: Requirements 2.1, 2.2, 2.3, 3.1, 3.2, 3.4**
 */

import * as fc from 'fast-check';
import type { AgentConfig } from '@/services/agentConfigService';
import type {
  ToolConfig,
  IntegrationBinding,
  DataStoreBinding,
  BindingDirection,
} from '@/services/toolConfigService';

// ---- Mock toolConfigService before importing the module under test ----
const mockListToolConfigs = jest.fn<Promise<ToolConfig[]>, []>();

jest.mock('@/services/toolConfigService', () => ({
  toolConfigService: {
    listToolConfigs: () => mockListToolConfigs(),
  },
}));

import { resolveToolBindings } from '@/utils/resolveToolBindings';

// ---- Helpers ----

afterEach(() => {
  jest.clearAllMocks();
});

// ---- Unit Tests ----

describe('resolveToolBindings — unit tests', () => {
  it('1. agent with one tool having integration bindings → returns ToolBindingSummary[] with resourceType integration', async () => {
    const agent: AgentConfig = {
      agentId: 'a1',
      config: { name: 'IntAgent', tools: ['tool-int'] },
      state: 'active',
    };

    const toolConfigs: ToolConfig[] = [
      {
        toolId: 'tool-int',
        config: { name: 'Integration Tool' },
        state: 'active',
        integrationBindings: [
          { integrationId: 'slack-1', integrationType: 'SLACK', direction: 'OUTPUT' as BindingDirection },
        ],
        dataStoreBindings: [],
      },
    ];

    mockListToolConfigs.mockResolvedValue(toolConfigs);
    const result = await resolveToolBindings(agent);

    expect(result).toHaveLength(1);
    expect(result[0]).toEqual({
      toolId: 'tool-int',
      toolName: 'Integration Tool',
      resourceName: 'slack-1',
      resourceType: 'integration',
      direction: 'output',
    });
  });

  it('2. agent with one tool having data store bindings → returns ToolBindingSummary[] with resourceType datastore', async () => {
    const agent: AgentConfig = {
      agentId: 'a2',
      config: { name: 'DSAgent', tools: ['tool-ds'] },
      state: 'active',
    };

    const toolConfigs: ToolConfig[] = [
      {
        toolId: 'tool-ds',
        config: { name: 'DataStore Tool' },
        state: 'active',
        integrationBindings: [],
        dataStoreBindings: [
          { dataStoreId: 'dynamo-1', dataStoreType: 'DYNAMODB', direction: 'INPUT' as BindingDirection },
        ],
      },
    ];

    mockListToolConfigs.mockResolvedValue(toolConfigs);
    const result = await resolveToolBindings(agent);

    expect(result).toHaveLength(1);
    expect(result[0]).toEqual({
      toolId: 'tool-ds',
      toolName: 'DataStore Tool',
      resourceName: 'dynamo-1',
      resourceType: 'datastore',
      direction: 'input',
    });
  });

  it('3. agent with tools having both integration and data store bindings → returns combined array', async () => {
    const agent: AgentConfig = {
      agentId: 'a3',
      config: { name: 'MixedAgent', tools: ['tool-a', 'tool-b'] },
      state: 'active',
    };

    const toolConfigs: ToolConfig[] = [
      {
        toolId: 'tool-a',
        config: { name: 'Tool A' },
        state: 'active',
        integrationBindings: [
          { integrationId: 'jira-1', integrationType: 'JIRA', direction: 'BIDIRECTIONAL' as BindingDirection },
        ],
        dataStoreBindings: [],
      },
      {
        toolId: 'tool-b',
        config: { name: 'Tool B' },
        state: 'active',
        integrationBindings: [],
        dataStoreBindings: [
          { dataStoreId: 's3-bucket', dataStoreType: 'S3', direction: 'OUTPUT' as BindingDirection },
          { dataStoreId: 'pg-db', dataStoreType: 'POSTGRESQL', direction: 'INPUT' as BindingDirection },
        ],
      },
    ];

    mockListToolConfigs.mockResolvedValue(toolConfigs);
    const result = await resolveToolBindings(agent);

    expect(result).toHaveLength(3);
    expect(result).toEqual(
      expect.arrayContaining([
        { toolId: 'tool-a', toolName: 'Tool A', resourceName: 'jira-1', resourceType: 'integration', direction: 'bidirectional' },
        { toolId: 'tool-b', toolName: 'Tool B', resourceName: 's3-bucket', resourceType: 'datastore', direction: 'output' },
        { toolId: 'tool-b', toolName: 'Tool B', resourceName: 'pg-db', resourceType: 'datastore', direction: 'input' },
      ]),
    );
  });

  it('4. agent with no tools (config.tools = []) → returns []', async () => {
    const agent: AgentConfig = {
      agentId: 'a4',
      config: { name: 'EmptyAgent', tools: [] },
      state: 'active',
    };

    mockListToolConfigs.mockResolvedValue([]);
    const result = await resolveToolBindings(agent);

    expect(result).toEqual([]);
    // listToolConfigs should not even be called when there are no tools
    expect(mockListToolConfigs).not.toHaveBeenCalled();
  });

  it('5. agent with tools that have no bindings → returns []', async () => {
    const agent: AgentConfig = {
      agentId: 'a5',
      config: { name: 'NoBindAgent', tools: ['tool-empty'] },
      state: 'active',
    };

    const toolConfigs: ToolConfig[] = [
      {
        toolId: 'tool-empty',
        config: { name: 'Empty Tool' },
        state: 'active',
        integrationBindings: [],
        dataStoreBindings: [],
      },
    ];

    mockListToolConfigs.mockResolvedValue(toolConfigs);
    const result = await resolveToolBindings(agent);

    expect(result).toEqual([]);
  });

  it('6. listToolConfigs() throws error → returns [] (graceful degradation)', async () => {
    const agent: AgentConfig = {
      agentId: 'a6',
      config: { name: 'ErrorAgent', tools: ['tool-x'] },
      state: 'active',
    };

    mockListToolConfigs.mockRejectedValue(new Error('Network failure'));
    const result = await resolveToolBindings(agent);

    expect(result).toEqual([]);
  });

  it('7. direction mapping — INPUT→input, OUTPUT→output, BIDIRECTIONAL→bidirectional, undefined→bidirectional', async () => {
    const agent: AgentConfig = {
      agentId: 'a7',
      config: { name: 'DirAgent', tools: ['tool-dir'] },
      state: 'active',
    };

    const toolConfigs: ToolConfig[] = [
      {
        toolId: 'tool-dir',
        config: { name: 'Dir Tool' },
        state: 'active',
        integrationBindings: [
          { integrationId: 'int-input', integrationType: 'GMAIL', direction: 'INPUT' as BindingDirection },
          { integrationId: 'int-output', integrationType: 'SLACK', direction: 'OUTPUT' as BindingDirection },
          { integrationId: 'int-bidir', integrationType: 'JIRA', direction: 'BIDIRECTIONAL' as BindingDirection },
          { integrationId: 'int-undef', integrationType: 'CONFLUENCE' } as IntegrationBinding,
        ],
        dataStoreBindings: [],
      },
    ];

    mockListToolConfigs.mockResolvedValue(toolConfigs);
    const result = await resolveToolBindings(agent);

    expect(result).toHaveLength(4);
    expect(result[0].direction).toBe('input');
    expect(result[1].direction).toBe('output');
    expect(result[2].direction).toBe('bidirectional');
    expect(result[3].direction).toBe('bidirectional');
  });

  it('8. agent tool IDs that do not match any ToolConfig → returns []', async () => {
    const agent: AgentConfig = {
      agentId: 'a8',
      config: { name: 'NoMatchAgent', tools: ['tool-missing-1', 'tool-missing-2'] },
      state: 'active',
    };

    const toolConfigs: ToolConfig[] = [
      {
        toolId: 'tool-other',
        config: { name: 'Other Tool' },
        state: 'active',
        integrationBindings: [
          { integrationId: 'int-x', integrationType: 'GMAIL', direction: 'INPUT' as BindingDirection },
        ],
        dataStoreBindings: [],
      },
    ];

    mockListToolConfigs.mockResolvedValue(toolConfigs);
    const result = await resolveToolBindings(agent);

    expect(result).toEqual([]);
  });
});


// ---- Property-Based Tests ----

describe('resolveToolBindings — property-based tests', () => {
  // ---- Arbitraries ----

  const toolIdArb = fc
    .string({ minLength: 3, maxLength: 12 })
    .filter((s) => /^[a-z][a-z0-9-]+$/.test(s));

  const bindingDirectionArb: fc.Arbitrary<BindingDirection> = fc.constantFrom(
    'INPUT',
    'OUTPUT',
    'BIDIRECTIONAL',
  );

  const integrationBindingArb: fc.Arbitrary<IntegrationBinding> = fc.record({
    integrationId: fc.string({ minLength: 1, maxLength: 15 }).filter((s) => s.trim().length > 0),
    integrationType: fc.constantFrom('GMAIL', 'SLACK', 'JIRA', 'CONFLUENCE'),
    operations: fc.constant(undefined),
    direction: bindingDirectionArb,
  });

  const dataStoreBindingArb: fc.Arbitrary<DataStoreBinding> = fc.record({
    dataStoreId: fc.string({ minLength: 1, maxLength: 15 }).filter((s) => s.trim().length > 0),
    dataStoreType: fc.constantFrom('DYNAMODB', 'S3', 'POSTGRESQL'),
    operations: fc.constant(undefined),
    direction: bindingDirectionArb,
  });

  function toolConfigArb(toolId: string): fc.Arbitrary<ToolConfig> {
    return fc
      .record({
        integrationBindings: fc.array(integrationBindingArb, { minLength: 0, maxLength: 3 }),
        dataStoreBindings: fc.array(dataStoreBindingArb, { minLength: 0, maxLength: 3 }),
      })
      .map(({ integrationBindings, dataStoreBindings }) => ({
        toolId,
        config: { name: `${toolId}-tool` },
        state: 'active' as const,
        integrationBindings,
        dataStoreBindings,
      }));
  }

  /**
   * Property 9: For any generated AgentConfig + ToolConfig[], output length equals
   * total count of integration bindings + data store bindings across matching tools.
   *
   * **Validates: Requirements 2.1, 2.2, 2.3**
   */
  it('9. output length equals total binding count across matching tools', async () => {
    await fc.assert(
      fc.asyncProperty(
        fc
          .array(toolIdArb, { minLength: 1, maxLength: 4 })
          .chain((ids) => {
            const uniqueIds = [...new Set(ids)];
            const configArbs = uniqueIds.map((id) => toolConfigArb(id));
            return fc
              .tuple(fc.constant(uniqueIds), ...configArbs)
              .map(([toolIds, ...configs]) => ({
                toolIds: toolIds as string[],
                toolConfigs: configs as ToolConfig[],
              }));
          }),
        async ({ toolIds, toolConfigs }) => {
          jest.clearAllMocks();
          mockListToolConfigs.mockResolvedValue(toolConfigs);

          const agent: AgentConfig = {
            agentId: 'prop-agent',
            config: { name: 'PropAgent', tools: toolIds },
            state: 'active',
          };

          const result = await resolveToolBindings(agent);

          const expectedCount = toolConfigs.reduce((sum, tc) => {
            if (!toolIds.includes(tc.toolId)) return sum;
            return (
              sum +
              (tc.integrationBindings?.length ?? 0) +
              (tc.dataStoreBindings?.length ?? 0)
            );
          }, 0);

          expect(result).toHaveLength(expectedCount);
        },
      ),
      { numRuns: 50 },
    );
  });

  /**
   * Property 10: For any generated binding direction, output direction is always
   * the lowercase equivalent or 'bidirectional' default.
   *
   * **Validates: Requirements 2.1, 2.2, 2.3**
   */
  it('10. output direction is always lowercase equivalent or bidirectional default', async () => {
    const optionalDirectionArb: fc.Arbitrary<BindingDirection | undefined> = fc.oneof(
      bindingDirectionArb,
      fc.constant(undefined),
    );

    await fc.assert(
      fc.asyncProperty(optionalDirectionArb, async (dir) => {
        jest.clearAllMocks();

        const toolConfigs: ToolConfig[] = [
          {
            toolId: 'dir-tool',
            config: { name: 'DirTool' },
            state: 'active',
            integrationBindings: [
              { integrationId: 'res-1', integrationType: 'GMAIL', direction: dir } as IntegrationBinding,
            ],
            dataStoreBindings: [],
          },
        ];

        mockListToolConfigs.mockResolvedValue(toolConfigs);

        const agent: AgentConfig = {
          agentId: 'dir-agent',
          config: { name: 'DirAgent', tools: ['dir-tool'] },
          state: 'active',
        };

        const result = await resolveToolBindings(agent);

        expect(result).toHaveLength(1);

        const expected =
          dir === 'INPUT'
            ? 'input'
            : dir === 'OUTPUT'
              ? 'output'
              : 'bidirectional';

        expect(result[0].direction).toBe(expected);
      }),
      { numRuns: 50 },
    );
  });
});
