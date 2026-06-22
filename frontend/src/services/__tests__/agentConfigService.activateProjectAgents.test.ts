/**
 * @jest-environment node
 *
 * activateProjectAgents service tests.
 *
 * Verifies the mutation forwards the projectId GraphQL variable and returns
 * the parsed { activated, failed, alreadyActive } result. The AppSync server
 * is fully mocked — no DOM required, so this runs under the node environment.
 */

jest.mock('../server', () => ({
  __esModule: true,
  default: {
    query: jest.fn(),
    mutate: jest.fn(),
    subscribe: jest.fn(),
  },
}));

import serverService from '../server';
import { agentConfigService } from '../agentConfigService';

describe('agentConfigService.activateProjectAgents', () => {
  beforeEach(() => jest.clearAllMocks());

  it('passes projectId as a variable and returns the parsed result', async () => {
    const result = {
      activated: ['Agent One'],
      failed: [],
      alreadyActive: ['Agent Two'],
    };
    (serverService.mutate as jest.Mock).mockResolvedValue({ activateProjectAgents: result });

    const out = await agentConfigService.activateProjectAgents('proj-1');

    expect(serverService.mutate).toHaveBeenCalledWith(
      expect.stringContaining('activateProjectAgents'),
      { projectId: 'proj-1' }
    );
    expect(out).toEqual(result);
  });

  it('propagates errors from the server', async () => {
    (serverService.mutate as jest.Mock).mockRejectedValue(new Error('network down'));

    await expect(agentConfigService.activateProjectAgents('proj-1')).rejects.toThrow('network down');
  });
});
