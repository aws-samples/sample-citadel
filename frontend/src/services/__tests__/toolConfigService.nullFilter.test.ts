/**
 * Tests for toolConfigService.listToolConfigs null-element filtering (#342).
 *
 * AppSync may null individual array elements when a non-nullable field
 * (config: AWSJSON!) is absent on a row. The service must filter them out
 * and log a warning rather than passing them to the UI.
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
import { clearAll as clearQueryCache } from '../queryCache';

describe('toolConfigService.listToolConfigs null-element filtering (#342)', () => {
  beforeEach(() => { jest.clearAllMocks(); clearQueryCache(); });

  it('filters out null elements from listToolConfigs response', async () => {
    const warnSpy = jest.spyOn(console, 'warn').mockImplementation(() => {});

    (serverService.query as jest.Mock).mockResolvedValue({
      listToolConfigs: [
        {
          toolId: 'real-tool',
          config: JSON.stringify({ name: 'Valid Tool' }),
          state: 'active',
          categories: ['utility'],
        },
        null, // AppSync nulled a decision row with missing config
        {
          toolId: 'another-tool',
          config: JSON.stringify({ name: 'Another' }),
          state: 'active',
          categories: [],
        },
        null, // another null
      ],
    });

    const result = await toolConfigService.listToolConfigs();

    expect(result).toHaveLength(2);
    expect(result[0].toolId).toBe('real-tool');
    expect(result[1].toolId).toBe('another-tool');

    // Warning logged for the dropped elements
    expect(warnSpy).toHaveBeenCalledWith(
      expect.stringContaining('dropped 2 null element(s)'),
    );

    warnSpy.mockRestore();
  });

  it('returns full list when no null elements', async () => {
    (serverService.query as jest.Mock).mockResolvedValue({
      listToolConfigs: [
        {
          toolId: 't1',
          config: JSON.stringify({ name: 'Tool One' }),
          state: 'active',
          categories: [],
        },
      ],
    });

    const result = await toolConfigService.listToolConfigs();
    expect(result).toHaveLength(1);
    expect(result[0].toolId).toBe('t1');
  });

  it('returns empty list when response is all nulls', async () => {
    const warnSpy = jest.spyOn(console, 'warn').mockImplementation(() => {});

    (serverService.query as jest.Mock).mockResolvedValue({
      listToolConfigs: [null, null],
    });

    const result = await toolConfigService.listToolConfigs();
    expect(result).toHaveLength(0);

    expect(warnSpy).toHaveBeenCalledWith(
      expect.stringContaining('dropped 2 null element(s)'),
    );

    warnSpy.mockRestore();
  });
});
