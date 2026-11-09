/**
 * CIT-289: workflowListHelpers unit tests
 */
import '@testing-library/jest-dom';
import {
  parseDefinitionNodes,
  hasPlaceholderNodes,
  shortId,
  sortByNameThenDate,
} from '../../utils/workflowListHelpers';

describe('parseDefinitionNodes', () => {
  it('returns nodes array from valid JSON definition', () => {
    const def = JSON.stringify({ nodes: [{ id: 'n1' }, { id: 'n2' }], edges: [] });
    expect(parseDefinitionNodes(def)).toHaveLength(2);
  });

  it('returns empty array for null/undefined', () => {
    expect(parseDefinitionNodes(null)).toEqual([]);
    expect(parseDefinitionNodes(undefined)).toEqual([]);
  });

  it('returns empty array for invalid JSON', () => {
    expect(parseDefinitionNodes('not-json')).toEqual([]);
  });

  it('returns empty array when nodes is not an array', () => {
    expect(parseDefinitionNodes(JSON.stringify({ nodes: 'bad' }))).toEqual([]);
  });
});

describe('hasPlaceholderNodes', () => {
  it('returns true when any node has placeholder- agentId', () => {
    const def = JSON.stringify({
      nodes: [
        { id: 'n1', agentId: 'placeholder-analyst' },
        { id: 'n2', agentId: 'real-agent' },
      ],
    });
    expect(hasPlaceholderNodes(def)).toBe(true);
  });

  it('returns false when no node has placeholder agentId', () => {
    const def = JSON.stringify({
      nodes: [
        { id: 'n1', agentId: 'agent-a' },
        { id: 'n2', agentId: 'agent-b' },
      ],
    });
    expect(hasPlaceholderNodes(def)).toBe(false);
  });

  it('returns false for empty/null definition', () => {
    expect(hasPlaceholderNodes(null)).toBe(false);
    expect(hasPlaceholderNodes('')).toBe(false);
  });
});

describe('shortId', () => {
  it('returns last 6 chars of a long ID', () => {
    expect(shortId('wf-abcdef123456')).toBe('123456');
  });

  it('returns full string if 6 chars or fewer', () => {
    expect(shortId('abc')).toBe('abc');
    expect(shortId('123456')).toBe('123456');
  });
});

describe('sortByNameThenDate', () => {
  it('sorts by name ascending, then createdAt descending', () => {
    const items = [
      { name: 'Bravo', createdAt: '2024-01-01' },
      { name: 'Alpha', createdAt: '2024-02-01' },
      { name: 'Alpha', createdAt: '2024-03-01' },
    ];
    items.sort(sortByNameThenDate);
    expect(items.map((i) => i.name)).toEqual(['Alpha', 'Alpha', 'Bravo']);
    // Among Alphas, newest first
    expect(items[0].createdAt).toBe('2024-03-01');
    expect(items[1].createdAt).toBe('2024-02-01');
  });

  it('handles missing createdAt gracefully', () => {
    const items = [
      { name: 'A', createdAt: undefined },
      { name: 'A', createdAt: '2024-01-01' },
    ];
    items.sort(sortByNameThenDate);
    // One with date sorts before one without (desc: '2024...' > '')
    expect(items[0].createdAt).toBe('2024-01-01');
  });
});
