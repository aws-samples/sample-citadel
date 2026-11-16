/**
 * workflowService — edge condition styling helper + fast-check round-trip property.
 * TDD Red Phase — tests written before implementation.
 *
 * CIT-291: applyConditionStyle helper; round-trip property for random conditions.
 */

jest.mock('uuid', () => ({ v4: () => 'generated-uuid' }));
jest.mock('../agentConfigService', () => ({
  agentConfigService: { listAgentConfigs: jest.fn() },
}));

import fc from 'fast-check';
import {
  applyConditionStyle,
  clearConditionStyle,
  deserializeWorkflow,
  serializeWorkflow,
} from '../workflowService';
import type { AgentConfig } from '../agentConfigService';
import type { EdgeCondition, WorkflowDefinition, WorkflowEdge } from '../../types';

const echoAgent = {
  agentId: 'demo-echo-agent',
  name: 'Demo Echo Agent',
  config: { name: 'Demo Echo Agent' },
  state: 'active',
} as unknown as AgentConfig;

const agentMap = new Map<string, AgentConfig>([['demo-echo-agent', echoAgent]]);

describe('applyConditionStyle', () => {
  it('applies dashed stroke, primary colour, and label from condition', () => {
    const edge: WorkflowEdge = {
      id: 'e1',
      source: 'n1',
      target: 'n2',
      sourceHandle: 'output',
      targetHandle: 'input',
      type: 'smoothstep',
      data: { sourceHandle: 'output', targetHandle: 'input' },
    };
    const cond: EdgeCondition = { field: 'result.route', operator: 'equals', value: 'branch-a' };
    const styled = applyConditionStyle(edge, cond);

    expect(styled.style).toEqual(expect.objectContaining({ strokeDasharray: '6 3' }));
    expect(styled.style?.stroke).toMatch(/primary/);
    expect(styled.label).toBe('result.route equals branch-a');
    expect(styled.data?.condition).toEqual(cond);
  });

  it('formats exists condition without value in label', () => {
    const edge: WorkflowEdge = {
      id: 'e1',
      source: 'n1',
      target: 'n2',
      sourceHandle: 'output',
      targetHandle: 'input',
      type: 'smoothstep',
      data: { sourceHandle: 'output', targetHandle: 'input' },
    };
    const cond: EdgeCondition = { field: 'result.ok', operator: 'exists', value: '' };
    const styled = applyConditionStyle(edge, cond);
    expect(styled.label).toBe('result.ok exists');
  });
});

describe('clearConditionStyle', () => {
  it('removes condition, style, label, and labelStyle', () => {
    const edge: WorkflowEdge = {
      id: 'e1',
      source: 'n1',
      target: 'n2',
      sourceHandle: 'output',
      targetHandle: 'input',
      type: 'smoothstep',
      style: { strokeDasharray: '6 3', stroke: 'hsl(var(--primary))' },
      label: 'result.route equals branch-a',
      labelStyle: { fontSize: 10, fill: 'hsl(var(--primary))' },
      data: {
        sourceHandle: 'output',
        targetHandle: 'input',
        condition: { field: 'result.route', operator: 'equals', value: 'branch-a' },
      },
    };
    const cleared = clearConditionStyle(edge);
    expect(cleared.style).toBeUndefined();
    expect(cleared.label).toBeUndefined();
    expect(cleared.labelStyle).toBeUndefined();
    expect(cleared.data?.condition).toBeUndefined();
  });
});

describe('fast-check round-trip property: random conditions survive serialize→deserialize', () => {
  const operators: EdgeCondition['operator'][] = [
    'equals', 'notEquals', 'contains', 'greaterThan', 'lessThan', 'exists',
  ];

  const arbCondition: fc.Arbitrary<EdgeCondition> = fc.record({
    field: fc.stringMatching(/^[A-Za-z_][A-Za-z0-9_.]{0,20}$/),
    operator: fc.constantFrom(...operators),
    value: fc.oneof(
      fc.string({ minLength: 0, maxLength: 50 }),
      fc.integer({ min: -1000, max: 1000 }),
      fc.double({ min: -1000, max: 1000, noNaN: true }),
    ),
  });

  it('preserves condition through serialize→deserialize round-trip', async () => {
    await fc.assert(
      fc.asyncProperty(
        fc.array(arbCondition, { minLength: 1, maxLength: 5 }),
        async (conditions) => {
          const def: WorkflowDefinition = {
            version: '1.0.0',
            id: 'wf-prop',
            name: 'Prop Test',
            createdAt: '2024-01-01T00:00:00Z',
            updatedAt: '2024-01-01T00:00:00Z',
            nodes: [
              { id: 'n1', agentId: 'demo-echo-agent', position: { x: 0, y: 0 }, configuration: {} },
              { id: 'n2', agentId: 'demo-echo-agent', position: { x: 200, y: 0 }, configuration: {} },
            ],
            edges: conditions.map((cond, i) => ({
              id: `e${i}`,
              source: 'n1',
              target: 'n2',
              sourceHandle: 'output',
              targetHandle: 'input',
              condition: cond,
            })),
          };

          const { nodes: rfNodes, edges: rfEdges } = await deserializeWorkflow(def, agentMap);
          const reserialized = serializeWorkflow(rfNodes, rfEdges, def);

          // Each condition must round-trip exactly
          for (let i = 0; i < conditions.length; i++) {
            expect(reserialized.edges[i].condition).toEqual(conditions[i]);
          }

          // Styling helper must have been applied during deserialization
          for (const rfEdge of rfEdges) {
            expect(rfEdge.style).toBeDefined();
            expect(rfEdge.style?.strokeDasharray).toBe('6 3');
            expect(rfEdge.label).toBeDefined();
          }
        },
      ),
      { numRuns: 50 },
    );
  });
});

describe('clearConditionStyle removes legacy top-level condition', () => {
  it('serializeWorkflow emits no condition after Remove on edge with both data.condition and top-level condition', () => {
    const cond: EdgeCondition = { field: 'status', operator: 'equals', value: 'done' };
    const edge: WorkflowEdge = {
      id: 'e1',
      source: 'n1',
      target: 'n2',
      type: 'smoothstep',
      data: { sourceHandle: 'output', targetHandle: 'input', condition: cond },
      style: { strokeDasharray: '6 3' },
      label: 'status equals done',
    };
    // Simulate a legacy top-level condition (the serializer fallback reads this)
    (edge as Record<string, unknown>).condition = cond;

    const cleaned = clearConditionStyle(edge);
    // Build minimal node set so serializeWorkflow succeeds
    const nodes = [
      { id: 'n1', type: 'agentTask', position: { x: 0, y: 0 }, data: { label: 'A', agentId: 'a', config: {} } },
      { id: 'n2', type: 'agentTask', position: { x: 100, y: 0 }, data: { label: 'B', agentId: 'b', config: {} } },
    ] as any;
    const result = serializeWorkflow(nodes, [cleaned]);
    expect(result.edges[0].condition).toBeUndefined();
  });
});