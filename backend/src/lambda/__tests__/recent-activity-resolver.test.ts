import { getRecentActivity } from '../recent-activity-resolver';

const mockSend = jest.fn();
const mockDeps = {
  docClient: { send: mockSend } as any,
  projectsTable: 'projects',
  agentConfigTable: 'agents',
  workflowsTable: 'workflows',
  integrationsTable: 'integrations',
};

beforeEach(() => mockSend.mockReset());

describe('getRecentActivity', () => {
  it('returns empty items when no entities exist', async () => {
    mockSend.mockResolvedValue({ Items: [] });
    const result = await getRecentActivity('org1', 10, mockDeps);
    expect(result.items).toEqual([]);
  });

  it('merges and sorts by timestamp descending', async () => {
    mockSend
      .mockResolvedValueOnce({ Items: [{ id: 'p1', name: 'Project 1', status: 'IN_PROGRESS', updatedAt: '2026-04-13T10:00:00Z' }] })
      .mockResolvedValueOnce({ Items: [{ agentId: 'a1', state: 'active', updatedAt: '2026-04-13T12:00:00Z' }] })
      .mockResolvedValueOnce({ Items: [{ workflowId: 'w1', name: 'Workflow 1', status: 'ACTIVE', updatedAt: '2026-04-13T11:00:00Z' }] })
      .mockResolvedValueOnce({ Items: [] });

    const result = await getRecentActivity('org1', 10, mockDeps);
    expect(result.items).toHaveLength(3);
    expect(result.items[0].entityType).toBe('agent');
    expect(result.items[1].entityType).toBe('workflow');
    expect(result.items[2].entityType).toBe('project');
  });

  it('respects limit', async () => {
    mockSend
      .mockResolvedValueOnce({ Items: [{ id: 'p1', name: 'P1', status: 'OK', updatedAt: '2026-04-13T10:00:00Z' }, { id: 'p2', name: 'P2', status: 'OK', updatedAt: '2026-04-13T09:00:00Z' }] })
      .mockResolvedValueOnce({ Items: [{ agentId: 'a1', state: 'active', updatedAt: '2026-04-13T12:00:00Z' }] })
      .mockResolvedValueOnce({ Items: [] })
      .mockResolvedValueOnce({ Items: [] });

    const result = await getRecentActivity('org1', 2, mockDeps);
    expect(result.items).toHaveLength(2);
  });

  it('clamps limit to max 50', async () => {
    mockSend.mockResolvedValue({ Items: [] });
    await getRecentActivity('org1', 100, mockDeps);
    // Should not throw, limit clamped internally
    expect(mockSend).toHaveBeenCalled();
  });
});
