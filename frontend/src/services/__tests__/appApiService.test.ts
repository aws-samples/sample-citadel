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

    it('requests createdByName and agentBindings.name so display names never need client-side resolution', async () => {
      (serverService.query as jest.Mock).mockResolvedValue({ getApp: {} });

      await appApiService.getApp('app-1');

      const [query] = (serverService.query as jest.Mock).mock.calls[0];
      expect(query).toContain('createdByName');
      // Scoped to the agentBindings selection set specifically, not just
      // anywhere in the document — guards against `name` being present only
      // on some unrelated field.
      const bindingsSelection = query.slice(
        query.indexOf('agentBindings {'),
        query.indexOf('}', query.indexOf('agentBindings {')),
      );
      expect(bindingsSelection).toContain('name');
    });

    it('returns the server response unchanged — no client-side createdBy/agent-name mutation', async () => {
      const serverApp = {
        appId: 'app-1',
        name: 'Test App',
        createdBy: 'user-abc-123',
        createdByName: 'Jane Doe',
        agentBindings: [
          { agentId: 'agent-1', name: 'Support Agent', status: 'READY' },
          { agentId: 'agent-2', status: 'DESIGN' },
        ],
      };
      (serverService.query as jest.Mock).mockResolvedValue({ getApp: serverApp });

      const result = await appApiService.getApp('app-1');

      // Deep-equal, not just a subset check — the service must be a pure
      // pass-through of whatever the server returns for these fields.
      expect(result).toEqual(serverApp);
      expect(result.createdBy).toBe('user-abc-123');
      expect(result.agentBindings[1].name).toBeUndefined();
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

    it('requests createdByName in the items selection', async () => {
      (serverService.query as jest.Mock).mockResolvedValue({
        listApps: { items: [], nextToken: null },
      });

      await appApiService.listApps('org-1');

      const [query] = (serverService.query as jest.Mock).mock.calls[0];
      expect(query).toContain('createdByName');
    });

    it('returns each item unchanged, including createdByName, from the server response', async () => {
      const mockItems = [
        { appId: 'app-1', createdBy: 'user-1', createdByName: 'Ann Lee' },
        { appId: 'app-2', createdBy: 'user-2', createdByName: 'user-2' },
      ];
      (serverService.query as jest.Mock).mockResolvedValue({
        listApps: { items: mockItems, nextToken: null },
      });

      const result = await appApiService.listApps('org-1');

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
