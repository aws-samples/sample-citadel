/**
 * Bug Condition Exploration Test — resolveToolBindings
 *
 * Property 1: Bug Condition — Tool Bindings Not Populated on Agent Drop
 *
 * This test encodes the EXPECTED (correct) behavior. On UNFIXED code it MUST FAIL,
 * confirming the bug exists. After the fix is applied, it should PASS.
 *
 * Bug condition (isBugCondition):
 *   agentConfig.config.tools.length > 0 AND at least one matching ToolConfig
 *   has non-empty integrationBindings or dataStoreBindings
 *
 * **Validates: Requirements 1.1, 1.2, 1.3, 2.1, 2.2, 2.3**
 */

import * as fc from 'fast-check';
import type { AgentConfig } from '@/services/agentConfigService';
import type {
  ToolConfig,
  IntegrationBinding,
  DataStoreBinding,
  BindingDirection,
} from '@/services/toolConfigService';
import type { ToolBindingSummary } from '@/types/workflow';

// ---- Mock toolConfigService before importing the module under test ----
const mockListToolConfigs = jest.fn<Promise<ToolConfig[]>, []>();

jest.mock('@/services/toolConfigService', () => ({
  toolConfigService: {
    listToolConfigs: () => mockListToolConfigs(),
  },
}));

// ---- Import the module under test (does NOT exist yet — will cause failure) ----
import { resolveToolBindings } from '@/utils/resolveToolBindings';

// ---- Arbitraries ----

const bindingDirectionArb: fc.Arbitrary<BindingDirection> = fc.constantFrom(
  'INPUT',
  'OUTPUT',
  'BIDIRECTIONAL',
);

const integrationBindingArb: fc.Arbitrary<IntegrationBinding> = fc.record({
  integrationId: fc.string({ minLength: 1, maxLength: 20 }).filter((s) => s.trim().length > 0),
  integrationType: fc.constantFrom('GMAIL', 'SLACK', 'JIRA', 'CONFLUENCE', 'SERVICENOW'),
  operations: fc.constant(undefined),
  direction: bindingDirectionArb,
});

const dataStoreBindingArb: fc.Arbitrary<DataStoreBinding> = fc.record({
  dataStoreId: fc.string({ minLength: 1, maxLength: 20 }).filter((s) => s.trim().length > 0),
  dataStoreType: fc.constantFrom('DYNAMODB', 'S3', 'POSTGRESQL', 'OPENSEARCH'),
  operations: fc.constant(undefined),
  direction: bindingDirectionArb,
});

const toolIdArb = fc
  .string({ minLength: 3, maxLength: 15 })
  .filter((s) => /^[a-z][a-z0-9-]+$/.test(s));

/**
 * Generate a ToolConfig that satisfies the bug condition:
 * has at least one integrationBinding OR dataStoreBinding.
 */
function toolConfigWithBindingsArb(toolId: string): fc.Arbitrary<ToolConfig> {
  return fc
    .record({
      hasIntegration: fc.boolean(),
      integrationBindings: fc.array(integrationBindingArb, { minLength: 1, maxLength: 3 }),
      dataStoreBindings: fc.array(dataStoreBindingArb, { minLength: 1, maxLength: 3 }),
    })
    .map(({ hasIntegration, integrationBindings, dataStoreBindings }) => ({
      toolId,
      config: { name: `${toolId}-tool` },
      state: 'active' as const,
      // Ensure at least one binding type is non-empty
      integrationBindings: hasIntegration ? integrationBindings : [],
      dataStoreBindings: hasIntegration ? [] : dataStoreBindings,
    }));
}

/**
 * Generate an AgentConfig + ToolConfig[] pair that satisfies the bug condition:
 * - agent has at least one tool
 * - at least one matching ToolConfig has non-empty bindings
 */
const bugConditionInputArb = fc
  .array(toolIdArb, { minLength: 1, maxLength: 4 })
  .chain((toolIds) => {
    const uniqueIds = [...new Set(toolIds)];
    const toolConfigArbs = uniqueIds.map((id) => toolConfigWithBindingsArb(id));

    return fc.tuple(fc.constant(uniqueIds), ...toolConfigArbs).map(([ids, ...configs]) => {
      const agentConfig: AgentConfig = {
        agentId: 'agent-test-001',
        config: { name: 'TestAgent', tools: ids },
        state: 'active',
      };
      return { agentConfig, toolConfigs: configs as ToolConfig[] };
    });
  });

// ---- Helper: expected direction mapping ----
function expectedDirection(dir?: BindingDirection): 'input' | 'output' | 'bidirectional' {
  if (dir === 'INPUT') return 'input';
  if (dir === 'OUTPUT') return 'output';
  if (dir === 'BIDIRECTIONAL') return 'bidirectional';
  return 'bidirectional';
}

// ---- Tests ----

describe('Property 1: Bug Condition — Tool Bindings Not Populated on Agent Drop', () => {
  afterEach(() => {
    jest.clearAllMocks();
  });

  /**
   * Scoped PBT case 1: Agent with integration bindings
   *
   * On UNFIXED code this WILL FAIL because resolveToolBindings does not exist.
   *
   * **Validates: Requirements 1.1, 2.1**
   */
  it('should return non-empty ToolBindingSummary[] for agent with integration bindings', async () => {
    const agentConfig: AgentConfig = {
      agentId: 'agent-email-001',
      config: { name: 'EmailProcessor', tools: ['email-tool'] },
      state: 'active',
    };

    const toolConfigs: ToolConfig[] = [
      {
        toolId: 'email-tool',
        config: { name: 'Email Tool' },
        state: 'active',
        integrationBindings: [
          { integrationId: 'gmail-int', integrationType: 'GMAIL', direction: 'INPUT' },
        ],
        dataStoreBindings: [],
      },
    ];

    mockListToolConfigs.mockResolvedValue(toolConfigs);

    const result = await resolveToolBindings(agentConfig);

    expect(result.length).toBeGreaterThan(0);
    expect(result[0].toolId).toBe('email-tool');
    expect(result[0].toolName).toBe('Email Tool');
    expect(result[0].resourceName).toBe('gmail-int');
    expect(result[0].resourceType).toBe('integration');
    expect(result[0].direction).toBe('input');
  });

  /**
   * Scoped PBT case 2: Agent with data store bindings
   *
   * On UNFIXED code this WILL FAIL because resolveToolBindings does not exist.
   *
   * **Validates: Requirements 1.2, 2.2**
   */
  it('should return non-empty ToolBindingSummary[] for agent with data store bindings', async () => {
    const agentConfig: AgentConfig = {
      agentId: 'agent-data-001',
      config: { name: 'DataAnalyzer', tools: ['query-tool'] },
      state: 'active',
    };

    const toolConfigs: ToolConfig[] = [
      {
        toolId: 'query-tool',
        config: { name: 'Query Tool' },
        state: 'active',
        integrationBindings: [],
        dataStoreBindings: [
          { dataStoreId: 'analytics-ds', dataStoreType: 'DYNAMODB', direction: 'BIDIRECTIONAL' },
        ],
      },
    ];

    mockListToolConfigs.mockResolvedValue(toolConfigs);

    const result = await resolveToolBindings(agentConfig);

    expect(result.length).toBeGreaterThan(0);
    expect(result[0].toolId).toBe('query-tool');
    expect(result[0].toolName).toBe('Query Tool');
    expect(result[0].resourceName).toBe('analytics-ds');
    expect(result[0].resourceType).toBe('datastore');
    expect(result[0].direction).toBe('bidirectional');
  });

  /**
   * Scoped PBT case 3: Agent with both integration and data store bindings
   *
   * On UNFIXED code this WILL FAIL because resolveToolBindings does not exist.
   *
   * **Validates: Requirements 1.3, 2.3**
   */
  it('should return combined ToolBindingSummary[] for agent with both binding types', async () => {
    const agentConfig: AgentConfig = {
      agentId: 'agent-full-001',
      config: { name: 'FullStack', tools: ['api-tool', 'db-tool'] },
      state: 'active',
    };

    const toolConfigs: ToolConfig[] = [
      {
        toolId: 'api-tool',
        config: { name: 'API Tool' },
        state: 'active',
        integrationBindings: [
          { integrationId: 'slack-int', integrationType: 'SLACK', direction: 'OUTPUT' },
        ],
        dataStoreBindings: [],
      },
      {
        toolId: 'db-tool',
        config: { name: 'DB Tool' },
        state: 'active',
        integrationBindings: [],
        dataStoreBindings: [
          { dataStoreId: 'main-db', dataStoreType: 'DYNAMODB', direction: 'INPUT' },
          { dataStoreId: 'cache-db', dataStoreType: 'S3', direction: 'OUTPUT' },
        ],
      },
    ];

    mockListToolConfigs.mockResolvedValue(toolConfigs);

    const result = await resolveToolBindings(agentConfig);

    expect(result).toHaveLength(3);

    // Validate each entry has required fields
    for (const entry of result) {
      expect(['api-tool', 'db-tool']).toContain(entry.toolId);
      expect(entry.toolName).toBeTruthy();
      expect(entry.resourceName).toBeTruthy();
      expect(['datastore', 'integration']).toContain(entry.resourceType);
      expect(['input', 'output', 'bidirectional']).toContain(entry.direction);
    }
  });

  /**
   * Property-based test using fast-check:
   * For any AgentConfig + ToolConfig[] satisfying the bug condition,
   * resolveToolBindings returns a non-empty array with valid entries.
   *
   * On UNFIXED code this WILL FAIL because resolveToolBindings does not exist.
   *
   * **Validates: Requirements 1.1, 1.2, 1.3, 2.1, 2.2, 2.3**
   */
  it('for any bug-condition input, resolveToolBindings returns non-empty valid ToolBindingSummary[]', async () => {
    await fc.assert(
      fc.asyncProperty(bugConditionInputArb, async ({ agentConfig, toolConfigs }) => {
        jest.clearAllMocks();
        mockListToolConfigs.mockResolvedValue(toolConfigs);

        const result = await resolveToolBindings(agentConfig);

        // Property: result is non-empty for bug-condition inputs
        expect(result.length).toBeGreaterThan(0);

        // Property: each entry has valid fields
        for (const entry of result) {
          expect(agentConfig.config.tools).toContain(entry.toolId);
          expect(entry.toolName).toBeTruthy();
          expect(entry.resourceName).toBeTruthy();
          expect(['datastore', 'integration']).toContain(entry.resourceType);
          expect(['input', 'output', 'bidirectional']).toContain(entry.direction);
        }

        // Property: total count equals sum of all bindings across matching tools
        const expectedCount = toolConfigs.reduce((sum, tc) => {
          if (!agentConfig.config.tools.includes(tc.toolId)) return sum;
          return (
            sum +
            (tc.integrationBindings?.length ?? 0) +
            (tc.dataStoreBindings?.length ?? 0)
          );
        }, 0);
        expect(result).toHaveLength(expectedCount);
      }),
      { numRuns: 20 },
    );
  });
});
