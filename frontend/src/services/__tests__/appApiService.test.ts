/**
 * appApiService Tests
 * Tests for the app GraphQL API service layer
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
import { appApiService } from '../appApiService';

describe('appApiService', () => {
  beforeEach(() => jest.clearAllMocks());

  describe('getApp', () => {
    it('calls query with appId and returns app', async () => {
      const mockApp = { appId: 'app-1', name: 'Test App' };
      (serverService.query as jest.Mock).mockResolvedValue({ getApp: mockApp });

      const result = await appApiService.getApp('app-1');

      expect(serverService.query).toHaveBeenCalledWith(
        expect.stringContaining('getApp'),
        { appId: 'app-1' }
      );
      expect(result).toEqual(mockApp);
    });
  });

  describe('listApps', () => {
    it('calls query with orgId and returns app connection', async () => {
      const mockItems = [{ appId: 'app-1' }, { appId: 'app-2' }];
      (serverService.query as jest.Mock).mockResolvedValue({
        listApps: { items: mockItems, nextToken: null },
      });

      const result = await appApiService.listApps('org-1');

      expect(serverService.query).toHaveBeenCalledWith(
        expect.stringContaining('listApps'),
        { orgId: 'org-1' }
      );
      expect(result.items).toEqual(mockItems);
    });
  });

  describe('createApp', () => {
    it('calls mutate with CreateAppInput and returns created app', async () => {
      const input = { name: 'New App', orgId: 'org-1' };
      const mockCreated = { appId: 'app-new', ...input, version: 1, status: 'DRAFT' };
      (serverService.mutate as jest.Mock).mockResolvedValue({ createApp: mockCreated });

      const result = await appApiService.createApp(input);

      expect(serverService.mutate).toHaveBeenCalledWith(
        expect.stringContaining('createApp'),
        { input }
      );
      expect(result).toEqual(mockCreated);
    });
  });

  describe('updateApp', () => {
    it('calls mutate with UpdateAppInput and returns updated app', async () => {
      const input = { appId: 'app-1', name: 'Updated App', version: 2 };
      const mockUpdated = { appId: 'app-1', name: 'Updated App', version: 3 };
      (serverService.mutate as jest.Mock).mockResolvedValue({ updateApp: mockUpdated });

      const result = await appApiService.updateApp(input);

      expect(serverService.mutate).toHaveBeenCalledWith(
        expect.stringContaining('updateApp'),
        { input }
      );
      expect(result).toEqual(mockUpdated);
    });
  });

  describe('deleteApp', () => {
    it('calls mutate with appId and returns result', async () => {
      const mockResult = { success: true, message: 'Deleted' };
      (serverService.mutate as jest.Mock).mockResolvedValue({ deleteApp: mockResult });

      const result = await appApiService.deleteApp('app-1');

      expect(serverService.mutate).toHaveBeenCalledWith(
        expect.stringContaining('deleteApp'),
        { appId: 'app-1' }
      );
      expect(result).toEqual(mockResult);
    });
  });

  describe('bindWorkflowToApp', () => {
    it('calls mutate with appId and workflowId', async () => {
      const mockApp = { appId: 'app-1', workflowIds: ['wf-1'] };
      (serverService.mutate as jest.Mock).mockResolvedValue({ bindWorkflowToApp: mockApp });

      const result = await appApiService.bindWorkflowToApp('app-1', 'wf-1');

      expect(serverService.mutate).toHaveBeenCalledWith(
        expect.stringContaining('bindWorkflowToApp'),
        { appId: 'app-1', workflowId: 'wf-1' }
      );
      expect(result).toEqual(mockApp);
    });
  });

  describe('unbindWorkflowFromApp', () => {
    it('calls mutate with appId and workflowId', async () => {
      const mockApp = { appId: 'app-1', workflowIds: [] };
      (serverService.mutate as jest.Mock).mockResolvedValue({ unbindWorkflowFromApp: mockApp });

      const result = await appApiService.unbindWorkflowFromApp('app-1', 'wf-1');

      expect(serverService.mutate).toHaveBeenCalledWith(
        expect.stringContaining('unbindWorkflowFromApp'),
        { appId: 'app-1', workflowId: 'wf-1' }
      );
      expect(result).toEqual(mockApp);
    });
  });
});
