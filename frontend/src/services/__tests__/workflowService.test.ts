/**
 * workflowService — tolerant deserialization of envelope-less definitions.
 * TDD Red phase — written before the implementation change.
 *
 * Seeded catalog blueprints historically stored bare {nodes, edges}
 * definitions without the WorkflowDefinition envelope (version/id/name/
 * createdAt/updatedAt), which the isWorkflowDefinition guard rejects with
 * INVALID_WORKFLOW_STRUCTURE. deserializeWorkflow must synthesize the
 * envelope for such definitions (via normalizeWorkflowDefinition) while
 * keeping nodes/edges STRICTLY validated by the existing guard.
 */

// uuid v13 is ESM-only and not in jest's transform whitelist; stub it so the
// workflow serializer (which pulls in uuid) can be parsed under ts-jest.
jest.mock('uuid', () => ({ v4: () => 'generated-uuid' }));

// workflowService imports agentConfigService (→ GraphQL client); stub it so
// this unit test never touches the network. Tests pass explicit config maps.
jest.mock('../agentConfigService', () => ({
  agentConfigService: { listAgentConfigs: jest.fn() },
}));

import {
  deserializeWorkflow,
  normalizeWorkflowDefinition,
  serializeWorkflow,
  WorkflowError,
} from '../workflowService';
import type { AgentConfig } from '../agentConfigService';
import type { WorkflowDefinition, WorkflowEdgeDefinition, EdgeCondition, WorkflowEdge } from '../../types';

const echoAgentConfig = {
  agentId: 'demo-echo-agent',
  name: 'Demo Echo Agent',
  config: { name: 'Demo Echo Agent' },
  state: 'active',
} as unknown as AgentConfig;

const agentConfigMap = new Map<string, AgentConfig>([
  ['demo-echo-agent', echoAgentConfig],
]);

/**
 * Exact shape of the seeded Echo Demo Workflow definition as historically
 * stored by backend/src/lambda/seed-blueprints/index.ts — bare nodes/edges,
 * no envelope fields.
 */
const bareEchoDemoDefinition = {
  nodes: [
    { id: 'echo-1', agentId: 'demo-echo-agent', position: { x: 150, y: 200 }, configuration: {} },
    { id: 'echo-2', agentId: 'demo-echo-agent', position: { x: 450, y: 200 }, configuration: {} },
  ],
  edges: [
    { id: 'edge-echo-1-2', source: 'echo-1', target: 'echo-2', sourceHandle: 'output', targetHandle: 'input' },
  ],
};

const fullEnvelopeDefinition: WorkflowDefinition = {
  version: '2.1.0',
  id: 'wf-original-id',
  name: 'Original Name',
  createdAt: '2024-01-01T00:00:00Z',
  updatedAt: '2024-06-01T00:00:00Z',
  nodes: bareEchoDemoDefinition.nodes,
  edges: bareEchoDemoDefinition.edges,
};

describe('normalizeWorkflowDefinition', () => {
  it('synthesizes default envelope fields on a bare {nodes,edges} object', () => {
    const before = Date.now();
    const normalized = normalizeWorkflowDefinition(bareEchoDemoDefinition) as WorkflowDefinition;
    const after = Date.now();

    expect(normalized.version).toBe('1.0.0');
    expect(normalized.id).toBe('generated-uuid');
    expect(normalized.name).toBe('Untitled Workflow');
    expect(Date.parse(normalized.createdAt)).toBeGreaterThanOrEqual(before);
    expect(Date.parse(normalized.createdAt)).toBeLessThanOrEqual(after);
    expect(normalized.updatedAt).toBe(normalized.createdAt);
    // nodes/edges are carried through untouched.
    expect(normalized.nodes).toEqual(bareEchoDemoDefinition.nodes);
    expect(normalized.edges).toEqual(bareEchoDemoDefinition.edges);
  });

  it('prefers meta.id and meta.name over synthesized defaults', () => {
    const normalized = normalizeWorkflowDefinition(bareEchoDemoDefinition, {
      id: 'catalog-workflow-id',
      name: 'Echo Demo Workflow',
    }) as WorkflowDefinition;

    expect(normalized.id).toBe('catalog-workflow-id');
    expect(normalized.name).toBe('Echo Demo Workflow');
  });

  it('passes a full-envelope definition through UNCHANGED (no field overwritten)', () => {
    const normalized = normalizeWorkflowDefinition(fullEnvelopeDefinition, {
      id: 'must-not-win',
      name: 'Must Not Win',
    }) as WorkflowDefinition;

    expect(normalized.version).toBe('2.1.0');
    expect(normalized.id).toBe('wf-original-id');
    expect(normalized.name).toBe('Original Name');
    expect(normalized.createdAt).toBe('2024-01-01T00:00:00Z');
    expect(normalized.updatedAt).toBe('2024-06-01T00:00:00Z');
    expect(normalized.nodes).toEqual(fullEnvelopeDefinition.nodes);
    expect(normalized.edges).toEqual(fullEnvelopeDefinition.edges);
  });

  it('fills only the missing/invalid envelope fields, keeping valid ones', () => {
    const partial = {
      ...bareEchoDemoDefinition,
      name: 'Kept Name',
      version: 42, // invalid type → synthesized
    };
    const normalized = normalizeWorkflowDefinition(partial) as WorkflowDefinition;

    expect(normalized.name).toBe('Kept Name');
    expect(normalized.version).toBe('1.0.0');
    expect(normalized.id).toBe('generated-uuid');
  });

  it('returns non {nodes,edges}-array candidates unchanged (guard rejects them later)', () => {
    const notAWorkflow = { nodes: 'nope', edges: [] };
    expect(normalizeWorkflowDefinition(notAWorkflow)).toBe(notAWorkflow);
    expect(normalizeWorkflowDefinition(null)).toBeNull();
    expect(normalizeWorkflowDefinition('str')).toBe('str');
  });
});

describe('deserializeWorkflow — tolerant envelope handling', () => {
  it('deserializes the exact seeded Echo Demo bare {nodes,edges} shape by synthesizing the envelope', async () => {
    const { nodes, edges } = await deserializeWorkflow(
      JSON.stringify(bareEchoDemoDefinition),
      agentConfigMap,
    );

    expect(nodes).toHaveLength(2);
    expect(edges).toHaveLength(1);
    expect(nodes[0]).toEqual(
      expect.objectContaining({
        id: 'echo-1',
        type: 'agentNode',
        position: { x: 150, y: 200 },
      }),
    );
    expect(nodes[0].data.agentId).toBe('demo-echo-agent');
    expect(edges[0]).toEqual(
      expect.objectContaining({ id: 'edge-echo-1-2', source: 'echo-1', target: 'echo-2' }),
    );
  });

  it('accepts a meta third param and threads it to the normalizer', async () => {
    const { nodes } = await deserializeWorkflow(
      JSON.stringify(bareEchoDemoDefinition),
      agentConfigMap,
      { id: 'bp-workflow-id', name: 'Echo Demo Workflow' },
    );
    expect(nodes).toHaveLength(2);
  });

  it('still rejects a bad node with INVALID_WORKFLOW_STRUCTURE (nodes stay strictly validated)', async () => {
    const badNodeDefinition = {
      nodes: [
        // agentId missing → isWorkflowNodeDefinition must reject.
        { id: 'echo-1', position: { x: 150, y: 200 }, configuration: {} },
      ],
      edges: [],
    };

    await expect(
      deserializeWorkflow(JSON.stringify(badNodeDefinition), agentConfigMap),
    ).rejects.toMatchObject({
      name: 'WorkflowError',
      code: 'INVALID_WORKFLOW_STRUCTURE',
    });
  });

  it('still rejects a candidate whose nodes/edges are not arrays', async () => {
    await expect(
      deserializeWorkflow(JSON.stringify({ nodes: 'nope', edges: 'nope' }), agentConfigMap),
    ).rejects.toMatchObject({ code: 'INVALID_WORKFLOW_STRUCTURE' });
  });

  it('deserializes a full-envelope definition exactly as before', async () => {
    const { nodes, edges } = await deserializeWorkflow(
      JSON.stringify(fullEnvelopeDefinition),
      agentConfigMap,
    );
    expect(nodes).toHaveLength(2);
    expect(edges).toHaveLength(1);
  });

  it('throws WorkflowError instances for structure failures', async () => {
    expect.assertions(1);
    try {
      await deserializeWorkflow(JSON.stringify({ nodes: 1, edges: 2 }), agentConfigMap);
    } catch (error) {
      expect(error).toBeInstanceOf(WorkflowError);
    }
  });
});

describe('deserializeWorkflow — node label prefers the definition name', () => {
  // Intake-generated envelopes carry the human-readable step name per node;
  // catalog configs for fabricated agents carry snake_case fabricator ids,
  // so the definition name must win over the catalog fallback chain
  // (agentConfig.name || config.name || agentId).
  const fabricatedCatalog = new Map<string, AgentConfig>([
    [
      'rec-a',
      {
        agentId: 'rec-a',
        name: 'ap_order_intake_agent_v1',
        config: { name: 'ap_order_intake_agent_v1' },
        state: 'active',
      } as unknown as AgentConfig,
    ],
  ]);

  const namedNodeDefinition = {
    nodes: [
      {
        id: 'rec-a',
        agentId: 'rec-a',
        name: 'Order Intake',
        position: { x: 100, y: 200 },
        configuration: {},
      },
    ],
    edges: [],
  };

  it('uses nodeDef.name as the canvas label when present', async () => {
    const { nodes } = await deserializeWorkflow(
      JSON.stringify(namedNodeDefinition),
      fabricatedCatalog,
    );

    expect(nodes[0].data.label).toBe('Order Intake');
  });

  it('falls back to the catalog chain when the definition has no name', async () => {
    const { nodes: legacy } = await deserializeWorkflow(
      JSON.stringify(bareEchoDemoDefinition),
      agentConfigMap,
    );

    expect(legacy[0].data.label).toBe('Demo Echo Agent');
  });

  it('rejects a node whose name is present but not a string (guard mirror)', async () => {
    const badName = {
      nodes: [
        {
          id: 'rec-a',
          agentId: 'rec-a',
          name: 123,
          position: { x: 100, y: 200 },
          configuration: {},
        },
      ],
      edges: [],
    };

    await expect(
      deserializeWorkflow(JSON.stringify(badName), fabricatedCatalog),
    ).rejects.toMatchObject({ code: 'INVALID_WORKFLOW_STRUCTURE' });
  });
});

describe('serializeWorkflow — edge condition preservation', () => {
  const liveConditionalRouterCondition: EdgeCondition = {
    field: 'result.route',
    operator: 'equals',
    value: 'branch-a',
  };

  it('copies condition from edge.data.condition into the serialized edge', () => {
    const edges: WorkflowEdge[] = [
      {
        id: 'e1',
        source: 'n1',
        target: 'n2',
        sourceHandle: 'output',
        targetHandle: 'input',
        type: 'smoothstep',
        data: {
          sourceHandle: 'output',
          targetHandle: 'input',
          condition: liveConditionalRouterCondition,
        },
      },
    ];

    const result = serializeWorkflow([], edges);
    expect(result.edges[0].condition).toEqual(liveConditionalRouterCondition);
  });

  it('copies condition from edge.condition (legacy shape) when edge.data is missing', () => {
    // Legacy edges may carry condition at top level (not in data)
    const edges = [
      {
        id: 'e1',
        source: 'n1',
        target: 'n2',
        sourceHandle: 'output',
        targetHandle: 'input',
        condition: liveConditionalRouterCondition,
      },
    ] as unknown as WorkflowEdge[];

    const result = serializeWorkflow([], edges);
    expect(result.edges[0].condition).toEqual(liveConditionalRouterCondition);
  });

  it('omits condition when edge has no condition', () => {
    const edges: WorkflowEdge[] = [
      {
        id: 'e1',
        source: 'n1',
        target: 'n2',
        sourceHandle: 'output',
        targetHandle: 'input',
        type: 'smoothstep',
        data: { sourceHandle: 'output', targetHandle: 'input' },
      },
    ];

    const result = serializeWorkflow([], edges);
    expect(result.edges[0].condition).toBeUndefined();
  });
});

describe('deserializeWorkflow — edge condition loading', () => {
  const conditionalDefinition: WorkflowDefinition = {
    version: '1.0.0',
    id: 'wf-cond',
    name: 'Conditional Workflow',
    createdAt: '2024-01-01T00:00:00Z',
    updatedAt: '2024-01-01T00:00:00Z',
    nodes: [
      { id: 'n1', agentId: 'demo-echo-agent', position: { x: 0, y: 0 }, configuration: {} },
      { id: 'n2', agentId: 'demo-echo-agent', position: { x: 200, y: 0 }, configuration: {} },
    ],
    edges: [
      {
        id: 'e1',
        source: 'n1',
        target: 'n2',
        sourceHandle: 'output',
        targetHandle: 'input',
        condition: { field: 'result.route', operator: 'equals', value: 'branch-a' },
      },
    ],
  };

  it('loads condition onto edge.data.condition', async () => {
    const { edges } = await deserializeWorkflow(conditionalDefinition, agentConfigMap);
    expect(edges[0].data?.condition).toEqual({
      field: 'result.route',
      operator: 'equals',
      value: 'branch-a',
    });
  });

  it('renders a visible label on conditional edges', async () => {
    const { edges } = await deserializeWorkflow(conditionalDefinition, agentConfigMap);
    expect(edges[0].label).toBe('result.route equals branch-a');
  });

  it('applies dashed stroke style to conditional edges', async () => {
    const { edges } = await deserializeWorkflow(conditionalDefinition, agentConfigMap);
    expect(edges[0].style).toEqual(expect.objectContaining({ strokeDasharray: '6 3' }));
  });

  it('does not set label or dashed style on unconditional edges', async () => {
    const unconditionalDef: WorkflowDefinition = {
      ...conditionalDefinition,
      edges: [
        { id: 'e1', source: 'n1', target: 'n2', sourceHandle: 'output', targetHandle: 'input' },
      ],
    };
    const { edges } = await deserializeWorkflow(unconditionalDef, agentConfigMap);
    expect(edges[0].label).toBeUndefined();
    expect(edges[0].style).toBeUndefined();
    expect(edges[0].data?.condition).toBeUndefined();
  });
});

describe('serialize → deserialize round-trip preserves edge conditions', () => {
  it('round-trips the live Conditional Router v2 edge shape', async () => {
    const originalEdges: WorkflowEdgeDefinition[] = [
      {
        id: 'e1',
        source: 'n1',
        target: 'n2',
        sourceHandle: 'output',
        targetHandle: 'input',
        condition: { field: 'result.route', operator: 'equals', value: 'branch-a' },
      },
      {
        id: 'e2',
        source: 'n1',
        target: 'n3',
        sourceHandle: 'output',
        targetHandle: 'input',
      },
    ];

    const originalDef: WorkflowDefinition = {
      version: '1.0.0',
      id: 'wf-rt',
      name: 'Round Trip',
      createdAt: '2024-01-01T00:00:00Z',
      updatedAt: '2024-01-01T00:00:00Z',
      nodes: [
        { id: 'n1', agentId: 'demo-echo-agent', position: { x: 0, y: 0 }, configuration: {} },
        { id: 'n2', agentId: 'demo-echo-agent', position: { x: 200, y: 0 }, configuration: {} },
        { id: 'n3', agentId: 'demo-echo-agent', position: { x: 200, y: 200 }, configuration: {} },
      ],
      edges: originalEdges,
    };

    // Deserialize → serialize → compare edges
    const { nodes: rfNodes, edges: rfEdges } = await deserializeWorkflow(
      originalDef,
      agentConfigMap,
    );
    const reserialized = serializeWorkflow(rfNodes, rfEdges, originalDef);

    // The reserialized edges must deep-equal the originals (condition preserved)
    expect(reserialized.edges).toEqual(originalEdges);
  });

  it('round-trips a definition with no conditions (no regression)', async () => {
    const noCond: WorkflowDefinition = {
      version: '1.0.0',
      id: 'wf-nc',
      name: 'No Cond',
      createdAt: '2024-01-01T00:00:00Z',
      updatedAt: '2024-01-01T00:00:00Z',
      nodes: [
        { id: 'n1', agentId: 'demo-echo-agent', position: { x: 0, y: 0 }, configuration: {} },
        { id: 'n2', agentId: 'demo-echo-agent', position: { x: 200, y: 0 }, configuration: {} },
      ],
      edges: [
        { id: 'e1', source: 'n1', target: 'n2', sourceHandle: 'output', targetHandle: 'input' },
      ],
    };

    const { nodes: rfNodes, edges: rfEdges } = await deserializeWorkflow(noCond, agentConfigMap);
    const reserialized = serializeWorkflow(rfNodes, rfEdges, noCond);

    expect(reserialized.edges).toEqual(noCond.edges);
  });
});
