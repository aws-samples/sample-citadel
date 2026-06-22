/**
 * getFabricatorQueue tests
 *
 * Verifies the query forwards the optional projectId as a GraphQL variable and
 * that the no-arg call (Agent Catalog drawer) still works. The AppSync server
 * is fully mocked — these tests never hit the network and run under any test
 * environment (no DOM required).
 */

// Mock the AppSync server service (default export) before importing the SUT.
jest.mock('../server', () => ({
  __esModule: true,
  default: { query: jest.fn() },
}));

import serverService from '../server';
import { getFabricatorQueue } from '../fabricatorQueueService';

const mockQuery = (serverService as unknown as { query: jest.Mock }).query;

describe('getFabricatorQueue', () => {
  beforeEach(() => {
    mockQuery.mockReset();
    mockQuery.mockResolvedValue({ getFabricatorQueue: [] });
  });

  it('passes projectId as a GraphQL variable when provided', async () => {
    await getFabricatorQueue('project-123');

    expect(mockQuery).toHaveBeenCalledTimes(1);
    const [query, variables] = mockQuery.mock.calls[0];
    expect(query).toContain('query GetFabricatorQueue($projectId: ID)');
    expect(query).toContain('getFabricatorQueue(projectId: $projectId)');
    expect(variables).toEqual({ projectId: 'project-123' });
  });

  it('passes projectId as undefined when called with no argument', async () => {
    await getFabricatorQueue();

    expect(mockQuery).toHaveBeenCalledTimes(1);
    const [, variables] = mockQuery.mock.calls[0];
    expect(variables).toEqual({ projectId: undefined });
  });

  it('returns items and parses JSON-string metadata', async () => {
    mockQuery.mockResolvedValue({
      getFabricatorQueue: [
        {
          requestId: 'r1',
          agentName: 'agent_one',
          taskDescription: 'do work',
          status: 'PENDING',
          submittedAt: '2026-01-01T00:00:00Z',
          metadata: '{"appId":"a1"}',
        },
      ],
    });

    const items = await getFabricatorQueue('project-123');

    expect(items).toHaveLength(1);
    expect(items[0].metadata).toEqual({ appId: 'a1' });
  });

  it('propagates query errors', async () => {
    mockQuery.mockRejectedValue(new Error('boom'));
    await expect(getFabricatorQueue('project-123')).rejects.toThrow('boom');
  });
});
