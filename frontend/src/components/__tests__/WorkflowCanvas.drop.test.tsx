/**
 * Integration Tests — WorkflowCanvas Drop Flow
 *
 * Tests the data transformation pipeline that the onDrop handler relies on:
 * agent config → tool config fetch → binding transformation → ToolBindingSummary[]
 *
 * Since WorkflowCanvas is a complex ReactFlow component that's hard to render
 * in tests, we test the integration at the resolveToolBindings + setNodes level
 * using realistic agent configs that simulate what onDrop would receive.
 *
 * **Validates: Requirements 2.1, 2.2, 2.3, 3.3, 3.4, 3.5**
 */

import type { AgentConfig } from '@/services/agentConfigService';
import type {
  ToolConfig,
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

afterEach(() => {
  jest.clearAllMocks();
});

describe('WorkflowCanvas drop flow — integration tests', () => {
  /**
   * Test 1: Full pipeline — agent with integration bindings produces correct
   * ToolBindingSummary[] that would populate node data.
   *
   * Simulates what happens when onDrop receives an agent whose tools have
   * integration bindings, and resolveToolBindings transforms them into the
   * ToolBindingSummary[] that setNodes would apply to the node.
   *
   * **Validates: Requirements 2.1, 3.3**
   */
  it('agent with integration bindings produces correct ToolBindingSummary[] for node data', async () => {
    // Realistic agent config as it would arrive via dataTransfer in onDrop
    const droppedAgentConfig: AgentConfig = {
      agentId: 'agent-email-processor',
      config: {
        name: 'Email Processor',
        description: 'Processes incoming emails',
        icon: '📧',
        tools: ['email-reader-tool', 'notification-tool'],
      },
      state: 'active',
      categories: ['communication'],
    };

    // Tool configs as they would be returned by the backend
    const backendToolConfigs: ToolConfig[] = [
      {
        toolId: 'email-reader-tool',
        config: { name: 'Email Reader' },
        state: 'active',
        integrationBindings: [
          { integrationId: 'gmail-workspace', integrationType: 'GMAIL', direction: 'INPUT' as BindingDirection },
        ],
        dataStoreBindings: [],
      },
      {
        toolId: 'notification-tool',
        config: { name: 'Slack Notifier' },
        state: 'active',
        integrationBindings: [
          { integrationId: 'slack-general', integrationType: 'SLACK', direction: 'OUTPUT' as BindingDirection },
        ],
        dataStoreBindings: [],
      },
    ];

    mockListToolConfigs.mockResolvedValue(backendToolConfigs);

    // This is what onDrop calls after creating the node
    const toolBindings = await resolveToolBindings(droppedAgentConfig);

    // Verify the bindings that would be set on node.data.toolBindings
    expect(toolBindings).toHaveLength(2);

    expect(toolBindings[0]).toEqual({
      toolId: 'email-reader-tool',
      toolName: 'Email Reader',
      resourceName: 'gmail-workspace',
      resourceType: 'integration',
      direction: 'input',
    });

    expect(toolBindings[1]).toEqual({
      toolId: 'notification-tool',
      toolName: 'Slack Notifier',
      resourceName: 'slack-general',
      resourceType: 'integration',
      direction: 'output',
    });
  });

  /**
   * Test 2: Full pipeline — agent with data store bindings produces correct
   * ToolBindingSummary[].
   *
   * **Validates: Requirements 2.2, 3.3**
   */
  it('agent with data store bindings produces correct ToolBindingSummary[] for node data', async () => {
    const droppedAgentConfig: AgentConfig = {
      agentId: 'agent-data-pipeline',
      config: {
        name: 'Data Pipeline Agent',
        description: 'ETL pipeline agent',
        tools: ['etl-tool'],
      },
      state: 'active',
    };

    const backendToolConfigs: ToolConfig[] = [
      {
        toolId: 'etl-tool',
        config: { name: 'ETL Processor' },
        state: 'active',
        integrationBindings: [],
        dataStoreBindings: [
          { dataStoreId: 'source-dynamo', dataStoreType: 'DYNAMODB', direction: 'INPUT' as BindingDirection },
          { dataStoreId: 'target-s3', dataStoreType: 'S3', direction: 'OUTPUT' as BindingDirection },
        ],
      },
    ];

    mockListToolConfigs.mockResolvedValue(backendToolConfigs);

    const toolBindings = await resolveToolBindings(droppedAgentConfig);

    expect(toolBindings).toHaveLength(2);

    expect(toolBindings[0]).toEqual({
      toolId: 'etl-tool',
      toolName: 'ETL Processor',
      resourceName: 'source-dynamo',
      resourceType: 'datastore',
      direction: 'input',
    });

    expect(toolBindings[1]).toEqual({
      toolId: 'etl-tool',
      toolName: 'ETL Processor',
      resourceName: 'target-s3',
      resourceType: 'datastore',
      direction: 'output',
    });
  });

  /**
   * Test 3: Full pipeline — listToolConfigs throws → returns [] (graceful
   * degradation, node created without badges).
   *
   * When the backend is unavailable, onDrop should still create the node
   * successfully. resolveToolBindings catches the error and returns [].
   *
   * **Validates: Requirements 3.4**
   */
  it('listToolConfigs throwing returns empty array for graceful degradation', async () => {
    const droppedAgentConfig: AgentConfig = {
      agentId: 'agent-resilient',
      config: {
        name: 'Resilient Agent',
        tools: ['some-tool'],
      },
      state: 'active',
    };

    mockListToolConfigs.mockRejectedValue(new Error('Service unavailable'));

    const toolBindings = await resolveToolBindings(droppedAgentConfig);

    // Node would be created without badges — no crash
    expect(toolBindings).toEqual([]);
    expect(mockListToolConfigs).toHaveBeenCalledTimes(1);
  });

  /**
   * Test 4: Full pipeline — agent with no tools → returns [] (no badges).
   *
   * Agents without tools assigned should produce no bindings and should
   * not even trigger a listToolConfigs call.
   *
   * **Validates: Requirements 3.1**
   */
  it('agent with no tools returns empty array without calling listToolConfigs', async () => {
    const droppedAgentConfig: AgentConfig = {
      agentId: 'agent-simple',
      config: {
        name: 'Simple Agent',
        description: 'No tools assigned',
        tools: [],
      },
      state: 'active',
    };

    const toolBindings = await resolveToolBindings(droppedAgentConfig);

    expect(toolBindings).toEqual([]);
    // Should short-circuit without calling the service
    expect(mockListToolConfigs).not.toHaveBeenCalled();
  });

  /**
   * Test 5: Full pipeline — verify existing tool configs for other agents
   * are not included (isolation).
   *
   * When the backend returns tool configs for many agents, only the configs
   * matching the dropped agent's tool IDs should be included in the result.
   * This ensures dropping one agent doesn't pick up another agent's bindings.
   *
   * **Validates: Requirements 3.5**
   */
  it('only includes bindings for the dropped agent tools, not other agents', async () => {
    const droppedAgentConfig: AgentConfig = {
      agentId: 'agent-focused',
      config: {
        name: 'Focused Agent',
        tools: ['my-tool'],
      },
      state: 'active',
    };

    // Backend returns configs for many tools — only 'my-tool' belongs to this agent
    const backendToolConfigs: ToolConfig[] = [
      {
        toolId: 'my-tool',
        config: { name: 'My Tool' },
        state: 'active',
        integrationBindings: [
          { integrationId: 'my-integration', integrationType: 'JIRA', direction: 'BIDIRECTIONAL' as BindingDirection },
        ],
        dataStoreBindings: [],
      },
      {
        toolId: 'other-agent-tool',
        config: { name: 'Other Tool' },
        state: 'active',
        integrationBindings: [
          { integrationId: 'other-integration', integrationType: 'GMAIL', direction: 'INPUT' as BindingDirection },
        ],
        dataStoreBindings: [
          { dataStoreId: 'other-datastore', dataStoreType: 'DYNAMODB', direction: 'OUTPUT' as BindingDirection },
        ],
      },
      {
        toolId: 'unrelated-tool',
        config: { name: 'Unrelated Tool' },
        state: 'active',
        integrationBindings: [],
        dataStoreBindings: [
          { dataStoreId: 'unrelated-ds', dataStoreType: 'S3', direction: 'INPUT' as BindingDirection },
        ],
      },
    ];

    mockListToolConfigs.mockResolvedValue(backendToolConfigs);

    const toolBindings = await resolveToolBindings(droppedAgentConfig);

    // Only the dropped agent's tool bindings should appear
    expect(toolBindings).toHaveLength(1);
    expect(toolBindings[0]).toEqual({
      toolId: 'my-tool',
      toolName: 'My Tool',
      resourceName: 'my-integration',
      resourceType: 'integration',
      direction: 'bidirectional',
    });

    // Verify none of the other tools' bindings leaked in
    const allResourceNames = toolBindings.map((b) => b.resourceName);
    expect(allResourceNames).not.toContain('other-integration');
    expect(allResourceNames).not.toContain('other-datastore');
    expect(allResourceNames).not.toContain('unrelated-ds');
  });
});
