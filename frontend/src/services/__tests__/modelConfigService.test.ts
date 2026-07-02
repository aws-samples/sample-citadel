/**
 * modelConfigService tests.
 *
 * Focused on the AWSJSON marshalling contract: regionProfiles / slotDefaults
 * arrive as JSON strings and must be parsed on read; slotDefaults must be
 * stringified into the mutation input on write.
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
import { modelConfigService } from '../modelConfigService';

describe('modelConfigService', () => {
  beforeEach(() => jest.clearAllMocks());

  describe('listModelCatalog', () => {
    it('unwraps the query and parses regionProfiles from a JSON string', async () => {
      (serverService.query as jest.Mock).mockResolvedValue({
        listModelCatalog: [
          {
            modelKey: 'provider-a.model-x',
            provider: 'provider-a',
            baseModelId: 'model-x-base',
            status: 'enabled',
            modality: 'text',
            invocationMode: 'on_demand',
            supportsTools: true,
            supportsSystemPrompt: true,
            supportsStreaming: true,
            regionProfiles: JSON.stringify({
              'us-east-1': 'model-x-base',
              'eu-west-1': 'model-x-base-eu',
            }),
          },
        ],
      });

      const result = await modelConfigService.listModelCatalog();

      expect(serverService.query).toHaveBeenCalledWith(
        expect.stringContaining('listModelCatalog')
      );
      expect(result).toHaveLength(1);
      expect(result[0].regionProfiles).toEqual({
        'us-east-1': 'model-x-base',
        'eu-west-1': 'model-x-base-eu',
      });
    });

    it('returns an empty array when the query yields nothing', async () => {
      (serverService.query as jest.Mock).mockResolvedValue({
        listModelCatalog: null,
      });

      const result = await modelConfigService.listModelCatalog();
      expect(result).toEqual([]);
    });
  });

  describe('getModelConfig', () => {
    it('defaults to the platform scope and parses slotDefaults', async () => {
      (serverService.query as jest.Mock).mockResolvedValue({
        getModelConfig: {
          scope: 'platform',
          globalDefaultKey: 'provider-a.model-x',
          slotDefaults: JSON.stringify({ supervisor: 'provider-b.model-y' }),
          orgDefaults: JSON.stringify({}),
          agentOverrides: JSON.stringify({}),
          localityMode: 'off',
        },
      });

      const result = await modelConfigService.getModelConfig();

      expect(serverService.query).toHaveBeenCalledWith(
        expect.stringContaining('getModelConfig'),
        { scope: 'platform' }
      );
      expect(result?.slotDefaults).toEqual({ supervisor: 'provider-b.model-y' });
      expect(result?.orgDefaults).toEqual({});
      expect(result?.agentOverrides).toEqual({});
    });

    it('returns null when no config exists', async () => {
      (serverService.query as jest.Mock).mockResolvedValue({
        getModelConfig: null,
      });

      const result = await modelConfigService.getModelConfig('platform');
      expect(result).toBeNull();
    });
  });

  describe('updateModelConfig', () => {
    it('stringifies slotDefaults into the mutation input', async () => {
      (serverService.mutate as jest.Mock).mockResolvedValue({
        updateModelConfig: {
          scope: 'platform',
          globalDefaultKey: 'provider-a.model-x',
          slotDefaults: JSON.stringify({ extraction: 'provider-a.model-x' }),
          orgDefaults: JSON.stringify({}),
          agentOverrides: JSON.stringify({}),
          localityMode: 'off',
        },
      });

      const result = await modelConfigService.updateModelConfig({
        slotDefaults: { extraction: 'provider-a.model-x' },
      });

      expect(serverService.mutate).toHaveBeenCalledWith(
        expect.stringContaining('updateModelConfig'),
        { input: { slotDefaults: JSON.stringify({ extraction: 'provider-a.model-x' }) } }
      );
      // Response is parsed back into a plain object.
      expect(result.slotDefaults).toEqual({ extraction: 'provider-a.model-x' });
    });

    it('leaves slotDefaults undefined when not provided', async () => {
      (serverService.mutate as jest.Mock).mockResolvedValue({
        updateModelConfig: {
          scope: 'platform',
          globalDefaultKey: 'provider-b.model-y',
          slotDefaults: JSON.stringify({}),
          orgDefaults: JSON.stringify({}),
          agentOverrides: JSON.stringify({}),
          localityMode: 'strict',
        },
      });

      await modelConfigService.updateModelConfig({
        globalDefaultKey: 'provider-b.model-y',
        localityMode: 'strict',
      });

      expect(serverService.mutate).toHaveBeenCalledWith(expect.any(String), {
        input: {
          globalDefaultKey: 'provider-b.model-y',
          localityMode: 'strict',
          slotDefaults: undefined,
        },
      });
    });
  });

  describe('setModelCatalogEntryStatus', () => {
    it('passes modelKey and status and parses the returned regionProfiles', async () => {
      (serverService.mutate as jest.Mock).mockResolvedValue({
        setModelCatalogEntryStatus: {
          modelKey: 'provider-a.model-x',
          provider: 'provider-a',
          baseModelId: 'model-x-base',
          status: 'disabled',
          modality: 'text',
          invocationMode: 'on_demand',
          supportsTools: false,
          supportsSystemPrompt: true,
          supportsStreaming: false,
          regionProfiles: JSON.stringify({ 'us-east-1': 'model-x-base' }),
        },
      });

      const result = await modelConfigService.setModelCatalogEntryStatus(
        'provider-a.model-x',
        'disabled'
      );

      expect(serverService.mutate).toHaveBeenCalledWith(
        expect.stringContaining('setModelCatalogEntryStatus'),
        { modelKey: 'provider-a.model-x', status: 'disabled' }
      );
      expect(result.status).toBe('disabled');
      expect(result.regionProfiles).toEqual({ 'us-east-1': 'model-x-base' });
    });
  });

  describe('error handling', () => {
    it('logs and rethrows when the query fails', async () => {
      const consoleSpy = jest
        .spyOn(console, 'error')
        .mockImplementation(() => undefined);
      (serverService.query as jest.Mock).mockRejectedValue(
        new Error('network down')
      );

      await expect(modelConfigService.listModelCatalog()).rejects.toThrow(
        'network down'
      );
      expect(consoleSpy).toHaveBeenCalled();
      consoleSpy.mockRestore();
    });
  });
});
