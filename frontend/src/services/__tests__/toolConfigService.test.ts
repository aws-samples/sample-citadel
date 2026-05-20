/**
 * toolConfigService Tests
 * Focused on searchToolConfigs semantic search and client-side fallback.
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
import { toolConfigService } from '../toolConfigService';

describe('toolConfigService.searchToolConfigs', () => {
  beforeEach(() => jest.clearAllMocks());

  it('calls the searchToolConfigs GraphQL query and parses config JSON', async () => {
    const raw = [
      {
        toolId: 't-1',
        config: JSON.stringify({ name: 'Alpha', description: 'first tool' }),
        state: 'active',
        categories: ['ops'],
        integrationBindings: [],
        dataStoreBindings: [],
      },
      {
        toolId: 't-2',
        config: { name: 'Beta', description: 'second tool' },
        state: 'inactive',
        categories: ['dev'],
        integrationBindings: null,
        dataStoreBindings: null,
      },
    ];
    (serverService.query as jest.Mock).mockResolvedValue({ searchToolConfigs: raw });

    const result = await toolConfigService.searchToolConfigs('alpha');

    expect(serverService.query).toHaveBeenCalledWith(
      expect.stringContaining('searchToolConfigs'),
      { query: 'alpha' }
    );
    expect(result).toHaveLength(2);
    expect(result[0].config).toEqual({ name: 'Alpha', description: 'first tool' });
    expect(result[1].config).toEqual({ name: 'Beta', description: 'second tool' });
  });

  it('falls back to client-side filtering via listToolConfigs when search errors out', async () => {
    const all = [
      {
        toolId: 'weather-tool',
        config: JSON.stringify({ name: 'Weather Tool', description: 'forecasts' }),
        state: 'active',
        categories: ['utility'],
        integrationBindings: [],
        dataStoreBindings: [],
      },
      {
        toolId: 'finance-tool',
        config: { name: 'Finance Tool', description: 'handles invoices' },
        state: 'active',
        categories: ['finance'],
        integrationBindings: [],
        dataStoreBindings: [],
      },
    ];

    (serverService.query as jest.Mock).mockImplementation((q: string) => {
      if (q.includes('searchToolConfigs')) {
        return Promise.reject(new Error('Registry search unavailable'));
      }
      if (q.includes('listToolConfigs')) {
        return Promise.resolve({ listToolConfigs: all });
      }
      return Promise.resolve({});
    });

    const result = await toolConfigService.searchToolConfigs('WEATHER');

    expect(result).toHaveLength(1);
    expect(result[0].toolId).toBe('weather-tool');
  });

  it('fallback matches against toolId, config.name, config.description, and categories', async () => {
    const all = [
      {
        toolId: 'aaa',
        config: { name: 'unrelated', description: 'nothing' },
        state: 'active',
        categories: ['other'],
        integrationBindings: [],
        dataStoreBindings: [],
      },
      {
        toolId: 'bbb',
        config: { name: 'FindMeByName', description: 'nothing' },
        state: 'active',
        categories: ['other'],
        integrationBindings: [],
        dataStoreBindings: [],
      },
      {
        toolId: 'ccc',
        config: { name: 'x', description: 'FindMeByDescription here' },
        state: 'active',
        categories: ['other'],
        integrationBindings: [],
        dataStoreBindings: [],
      },
      {
        toolId: 'ddd',
        config: { name: 'x', description: 'y' },
        state: 'active',
        categories: ['FindMeByCategory'],
        integrationBindings: [],
        dataStoreBindings: [],
      },
    ];

    (serverService.query as jest.Mock).mockImplementation((q: string) => {
      if (q.includes('searchToolConfigs')) {
        return Promise.reject(new Error('boom'));
      }
      return Promise.resolve({ listToolConfigs: all });
    });

    const byName = await toolConfigService.searchToolConfigs('findmebyname');
    expect(byName.map((t) => t.toolId)).toEqual(['bbb']);

    const byDesc = await toolConfigService.searchToolConfigs('findmebydescription');
    expect(byDesc.map((t) => t.toolId)).toEqual(['ccc']);

    const byCategory = await toolConfigService.searchToolConfigs('findmebycategory');
    expect(byCategory.map((t) => t.toolId)).toEqual(['ddd']);
  });

  it('fallback with empty query returns all tools', async () => {
    const all = [
      {
        toolId: 'a',
        config: { name: 'A' },
        state: 'active',
        categories: [],
        integrationBindings: [],
        dataStoreBindings: [],
      },
      {
        toolId: 'b',
        config: { name: 'B' },
        state: 'active',
        categories: [],
        integrationBindings: [],
        dataStoreBindings: [],
      },
    ];

    (serverService.query as jest.Mock).mockImplementation((q: string) => {
      if (q.includes('searchToolConfigs')) {
        return Promise.reject(new Error('fail'));
      }
      return Promise.resolve({ listToolConfigs: all });
    });

    const result = await toolConfigService.searchToolConfigs('');
    expect(result).toHaveLength(2);
  });
});
