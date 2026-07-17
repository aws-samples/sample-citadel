/**
 * workflowApiService Tests
 * Tests for the workflow GraphQL API service layer
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
import { workflowApiService } from '../workflowApiService';

describe('workflowApiService', () => {
  beforeEach(() => jest.clearAllMocks());

  describe('getWorkflow', () => {
    it('calls query with workflowId and returns workflow', async () => {
      const mockWorkflow = { workflowId: 'wf-1', name: 'Test Workflow' };
      (serverService.query as jest.Mock).mockResolvedValue({ getWorkflow: mockWorkflow });

      const result = await workflowApiService.getWorkflow('wf-1');

      expect(serverService.query).toHaveBeenCalledWith(
        expect.stringContaining('getWorkflow'),
        { workflowId: 'wf-1' }
      );
      expect(result).toEqual(mockWorkflow);
    });
  });

  describe('listWorkflows', () => {
    it('calls query with orgId and optional status filter', async () => {
      const mockItems = [{ workflowId: 'wf-1' }, { workflowId: 'wf-2' }];
      (serverService.query as jest.Mock).mockResolvedValue({
        listWorkflows: { items: mockItems, nextToken: null },
      });

      const result = await workflowApiService.listWorkflows('org-1', 'DRAFT');

      expect(serverService.query).toHaveBeenCalledWith(
        expect.stringContaining('listWorkflows'),
        { orgId: 'org-1', status: 'DRAFT' }
      );
      expect(result.items).toEqual(mockItems);
    });
  });

  describe('listBlueprints', () => {
    it('calls query with optional category filter', async () => {
      const mockItems = [{ workflowId: 'bp-1', isBlueprint: true }];
      (serverService.query as jest.Mock).mockResolvedValue({
        listBlueprints: { items: mockItems, nextToken: null },
      });

      const result = await workflowApiService.listBlueprints('data-processing');

      expect(serverService.query).toHaveBeenCalledWith(
        expect.stringContaining('listBlueprints'),
        { category: 'data-processing' }
      );
      expect(result.items).toEqual(mockItems);
    });
  });

  describe('createWorkflow', () => {
    it('calls mutate with CreateWorkflowInput and returns created workflow', async () => {
      const input = { name: 'New WF', orgId: 'org-1', definition: '{}' };
      const mockCreated = { workflowId: 'wf-new', ...input, version: 1, status: 'DRAFT' };
      (serverService.mutate as jest.Mock).mockResolvedValue({ createWorkflow: mockCreated });

      const result = await workflowApiService.createWorkflow(input);

      expect(serverService.mutate).toHaveBeenCalledWith(
        expect.stringContaining('createWorkflow'),
        { input }
      );
      expect(result).toEqual(mockCreated);
    });
  });

  describe('updateWorkflow', () => {
    it('calls mutate with UpdateWorkflowInput and returns updated workflow', async () => {
      const input = { workflowId: 'wf-1', name: 'Updated', version: 2 };
      const mockUpdated = { workflowId: 'wf-1', name: 'Updated', version: 3 };
      (serverService.mutate as jest.Mock).mockResolvedValue({ updateWorkflow: mockUpdated });

      const result = await workflowApiService.updateWorkflow(input);

      expect(serverService.mutate).toHaveBeenCalledWith(
        expect.stringContaining('updateWorkflow'),
        { input }
      );
      expect(result).toEqual(mockUpdated);
    });
  });

  describe('deleteWorkflow', () => {
    it('calls mutate with workflowId and returns result', async () => {
      const mockResult = { success: true, message: 'Deleted' };
      (serverService.mutate as jest.Mock).mockResolvedValue({ deleteWorkflow: mockResult });

      const result = await workflowApiService.deleteWorkflow('wf-1');

      expect(serverService.mutate).toHaveBeenCalledWith(
        expect.stringContaining('deleteWorkflow'),
        { workflowId: 'wf-1' }
      );
      expect(result).toEqual(mockResult);
    });
  });

  describe('publishWorkflow', () => {
    it('calls mutate with workflowId and returns published workflow', async () => {
      const mockPublished = { workflowId: 'wf-1', status: 'PUBLISHED' };
      (serverService.mutate as jest.Mock).mockResolvedValue({ publishWorkflow: mockPublished });

      const result = await workflowApiService.publishWorkflow('wf-1');

      expect(serverService.mutate).toHaveBeenCalledWith(
        expect.stringContaining('publishWorkflow'),
        { workflowId: 'wf-1' }
      );
      expect(result).toEqual(mockPublished);
    });
  });

  describe('updateWorkflowConfiguration', () => {
    it('calls mutate with workflowId, configuration, and version', async () => {
      const config = JSON.stringify({ integrations: { slack: {} } });
      const mockUpdated = { workflowId: 'wf-1', configuration: config, version: 3 };
      (serverService.mutate as jest.Mock).mockResolvedValue({ updateWorkflowConfiguration: mockUpdated });

      const result = await workflowApiService.updateWorkflowConfiguration('wf-1', config, 2);

      expect(serverService.mutate).toHaveBeenCalledWith(
        expect.stringContaining('updateWorkflowConfiguration'),
        { workflowId: 'wf-1', configuration: config, version: 2 }
      );
      expect(result).toEqual(mockUpdated);
    });
  });

  describe('importBlueprint', () => {
    it('calls mutate with blueprintId, appId, and optional name', async () => {
      const mockImported = { workflowId: 'wf-imported', status: 'DRAFT' };
      (serverService.mutate as jest.Mock).mockResolvedValue({ importBlueprint: mockImported });

      const result = await workflowApiService.importBlueprint('bp-1', 'app-1', 'My Copy');

      expect(serverService.mutate).toHaveBeenCalledWith(
        expect.stringContaining('importBlueprint'),
        { blueprintId: 'bp-1', appId: 'app-1', name: 'My Copy' }
      );
      expect(result).toEqual(mockImported);
    });

    it('serializes agentMapping as an AWSJSON string variable when provided', async () => {
      const mockImported = { workflowId: 'wf-imported', status: 'DRAFT' };
      (serverService.mutate as jest.Mock).mockResolvedValue({ importBlueprint: mockImported });

      const agentMapping = { 'placeholder-agent-1': 'agent-real-1' };
      await workflowApiService.importBlueprint('bp-1', 'app-1', undefined, agentMapping);

      const [doc, variables] = (serverService.mutate as jest.Mock).mock.calls[0];
      expect(doc).toEqual(expect.stringContaining('$agentMapping: AWSJSON'));
      expect(variables).toEqual({
        blueprintId: 'bp-1',
        appId: 'app-1',
        name: undefined,
        agentMapping: JSON.stringify(agentMapping),
      });
    });
  });

  describe('importWorkflow', () => {
    it('calls mutate with ImportWorkflowInput', async () => {
      const input = { orgId: 'org-1', workflowJson: '{}', name: 'Imported' };
      const mockImported = { workflowId: 'wf-imp', status: 'DRAFT' };
      (serverService.mutate as jest.Mock).mockResolvedValue({ importWorkflow: mockImported });

      const result = await workflowApiService.importWorkflow(input);

      expect(serverService.mutate).toHaveBeenCalledWith(
        expect.stringContaining('importWorkflow'),
        { input }
      );
      expect(result).toEqual(mockImported);
    });
  });

  describe('exportWorkflow', () => {
    it('calls query with workflowId and returns JSON', async () => {
      const mockJson = '{"nodes":[],"edges":[]}';
      (serverService.query as jest.Mock).mockResolvedValue({ exportWorkflow: mockJson });

      const result = await workflowApiService.exportWorkflow('wf-1');

      expect(serverService.query).toHaveBeenCalledWith(
        expect.stringContaining('exportWorkflow'),
        { workflowId: 'wf-1' }
      );
      expect(result).toBe(mockJson);
    });
  });

  describe('getWorkflowVersion', () => {
    it('calls query with workflowId and version number', async () => {
      const mockVersion = { workflowId: 'wf-1', version: 2, definition: '{}' };
      (serverService.query as jest.Mock).mockResolvedValue({ getWorkflowVersion: mockVersion });

      const result = await workflowApiService.getWorkflowVersion('wf-1', 2);

      expect(serverService.query).toHaveBeenCalledWith(
        expect.stringContaining('getWorkflowVersion'),
        { workflowId: 'wf-1', version: 2 }
      );
      expect(result).toEqual(mockVersion);
    });
  });

  describe('listAppWorkflows', () => {
    it('calls query with appId and returns workflow list', async () => {
      const mockWorkflows = [{ workflowId: 'wf-1' }, { workflowId: 'wf-2' }];
      (serverService.query as jest.Mock).mockResolvedValue({ listAppWorkflows: mockWorkflows });

      const result = await workflowApiService.listAppWorkflows('app-1');

      expect(serverService.query).toHaveBeenCalledWith(
        expect.stringContaining('listAppWorkflows'),
        { appId: 'app-1' }
      );
      expect(result).toEqual(mockWorkflows);
    });
  });
});
