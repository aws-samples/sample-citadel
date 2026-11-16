/**
 * workflowService — conditional-edge CSS-class styling.
 * TDD Red Phase: tests for CIT-291 bug A — applyConditionStyle must use a CSS
 * class rather than inline hsl(var(--primary)) (which is invalid in Tailwind v4
 * where --primary holds a full colour value).
 */

jest.mock('uuid', () => ({ v4: () => 'generated-uuid' }));
jest.mock('../agentConfigService', () => ({
  agentConfigService: { listAgentConfigs: jest.fn() },
}));

import {
  applyConditionStyle,
  clearConditionStyle,
} from '../workflowService';
import type { EdgeCondition, WorkflowEdge } from '../../types';

const baseEdge: WorkflowEdge = {
  id: 'e1',
  source: 'n1',
  target: 'n2',
  sourceHandle: 'output',
  targetHandle: 'input',
  type: 'smoothstep',
  data: { sourceHandle: 'output', targetHandle: 'input' },
};

const cond: EdgeCondition = {
  field: 'result.route',
  operator: 'equals',
  value: 'branch-a',
};

describe('applyConditionStyle CSS-class approach (CIT-291 bug A)', () => {
  it('never emits var(--primary) anywhere in the returned edge JSON', () => {
    const styled = applyConditionStyle(baseEdge, cond);
    const json = JSON.stringify(styled);
    expect(json).not.toMatch(/var\(--primary\)/);
  });

  it('sets className to conditional-edge', () => {
    const styled = applyConditionStyle(baseEdge, cond);
    expect(styled.className).toBe('conditional-edge');
  });

  it('sets labelBgPadding and labelBgBorderRadius', () => {
    const styled = applyConditionStyle(baseEdge, cond);
    expect(styled.labelBgPadding).toEqual([6, 3]);
    expect(styled.labelBgBorderRadius).toBe(4);
  });

  it('does not set any inline colour-related style properties', () => {
    const styled = applyConditionStyle(baseEdge, cond);
    // No inline style with stroke/fill colour
    expect(styled.style?.stroke).toBeUndefined();
    expect(styled.labelStyle?.fill).toBeUndefined();
    // style object may be absent entirely or have non-colour properties
    if (styled.style) {
      expect(styled.style).not.toHaveProperty('stroke');
    }
  });

  it('preserves label text and condition data', () => {
    const styled = applyConditionStyle(baseEdge, cond);
    expect(styled.label).toBe('result.route equals branch-a');
    expect(styled.data?.condition).toEqual(cond);
  });
});

describe('clearConditionStyle removes CSS-class properties (CIT-291 bug A)', () => {
  it('removes className, labelBgPadding, and labelBgBorderRadius', () => {
    const styled = applyConditionStyle(baseEdge, cond);
    const cleared = clearConditionStyle(styled);
    expect(cleared.className).toBeUndefined();
    expect((cleared as Record<string, unknown>).labelBgPadding).toBeUndefined();
    expect((cleared as Record<string, unknown>).labelBgBorderRadius).toBeUndefined();
    expect(cleared.label).toBeUndefined();
    expect(cleared.data?.condition).toBeUndefined();
  });
});
