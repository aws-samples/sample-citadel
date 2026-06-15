/**
 * agentConfigService Tests
 * Focused on searchAgentConfigs semantic search and client-side fallback.
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

describe('agentConfigService.searchAgentConfigs', () => {
  beforeEach(() => jest.clearAllMocks());

  it('calls the searchAgentConfigs GraphQL query and parses config JSON', async () => {
    const raw = [
      {
        agentId: 'a-1',
        config: JSON.stringify({ name: 'Alpha', description: 'first agent' }),
        state: 'active',
        categories: ['ops'],
      },
      {
        agentId: 'a-2',
        config: { name: 'Beta', description: 'second agent' },
        state: 'inactive',
        categories: ['dev'],
      },
    ];
    (serverService.query as jest.Mock).mockResolvedValue({ searchAgentConfigs: raw });

    const result = await agentConfigService.searchAgentConfigs('alpha');

    expect(serverService.query).toHaveBeenCalledWith(
      expect.stringContaining('searchAgentConfigs'),
      { query: 'alpha' }
    );
    expect(result).toHaveLength(2);
    expect(result[0].config).toEqual({ name: 'Alpha', description: 'first agent' });
    expect(result[1].config).toEqual({ name: 'Beta', description: 'second agent' });
  });

  it('falls back to client-side filtering via listAgentConfigs when search errors out', async () => {
    const all = [
      {
        agentId: 'weather-bot',
        config: JSON.stringify({ name: 'Weather Bot', description: 'forecasts' }),
        state: 'active',
        categories: ['utility'],
      },
      {
        agentId: 'finance-bot',
        config: { name: 'Finance Bot', description: 'handles invoices' },
        state: 'active',
        categories: ['finance'],
      },
    ];

    (serverService.query as jest.Mock).mockImplementation((q: string) => {
      if (q.includes('searchAgentConfigs')) {
        return Promise.reject(new Error('Registry search unavailable'));
      }
      if (q.includes('listAgentConfigs')) {
        return Promise.resolve({ listAgentConfigs: all });
      }
      return Promise.resolve({});
    });

    const result = await agentConfigService.searchAgentConfigs('WEATHER');

    expect(result).toHaveLength(1);
    expect(result[0].agentId).toBe('weather-bot');
  });

  it('fallback matches against agentId, config.name, config.description, and categories', async () => {
    const all = [
      {
        agentId: 'aaa',
        config: { name: 'unrelated', description: 'nothing' },
        state: 'active',
        categories: ['other'],
      },
      {
        agentId: 'bbb',
        config: { name: 'FindMeByName', description: 'nothing' },
        state: 'active',
        categories: ['other'],
      },
      {
        agentId: 'ccc',
        config: { name: 'x', description: 'FindMeByDescription here' },
        state: 'active',
        categories: ['other'],
      },
      {
        agentId: 'ddd',
        config: { name: 'x', description: 'y' },
        state: 'active',
        categories: ['FindMeByCategory'],
      },
    ];

    (serverService.query as jest.Mock).mockImplementation((q: string) => {
      if (q.includes('searchAgentConfigs')) {
        return Promise.reject(new Error('boom'));
      }
      return Promise.resolve({ listAgentConfigs: all });
    });

    const byName = await agentConfigService.searchAgentConfigs('findmebyname');
    expect(byName.map((a) => a.agentId)).toEqual(['bbb']);

    const byDesc = await agentConfigService.searchAgentConfigs('findmebydescription');
    expect(byDesc.map((a) => a.agentId)).toEqual(['ccc']);

    const byCategory = await agentConfigService.searchAgentConfigs('findmebycategory');
    expect(byCategory.map((a) => a.agentId)).toEqual(['ddd']);
  });

  it('fallback with empty query returns all agents', async () => {
    const all = [
      { agentId: 'a', config: { name: 'A' }, state: 'active', categories: [] },
      { agentId: 'b', config: { name: 'B' }, state: 'active', categories: [] },
    ];

    (serverService.query as jest.Mock).mockImplementation((q: string) => {
      if (q.includes('searchAgentConfigs')) {
        return Promise.reject(new Error('fail'));
      }
      return Promise.resolve({ listAgentConfigs: all });
    });

    const result = await agentConfigService.searchAgentConfigs('');
    expect(result).toHaveLength(2);
  });
});
