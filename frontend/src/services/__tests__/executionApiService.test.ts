/**
 * executionApiService Tests
 * Tests for the execution GraphQL API service layer
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
import { executionApiService } from '../executionApiService';

describe('executionApiService', () => {
  beforeEach(() => jest.clearAllMocks());

  describe('getExecution', () => {
    it('calls query with executionId and returns execution', async () => {
      const mockExecution = { executionId: 'exec-1', status: 'running' };
      (serverService.query as jest.Mock).mockResolvedValue({ getExecution: mockExecution });

      const result = await executionApiService.getExecution('exec-1');

      expect(serverService.query).toHaveBeenCalledWith(
        expect.stringContaining('getExecution'),
        { executionId: 'exec-1' }
      );
      expect(result).toEqual(mockExecution);
    });
  });

  describe('listExecutions', () => {
    it('calls query with workflowId and returns execution connection', async () => {
      const mockItems = [{ executionId: 'exec-1' }, { executionId: 'exec-2' }];
      (serverService.query as jest.Mock).mockResolvedValue({
        listExecutions: { items: mockItems, nextToken: null },
      });

      const result = await executionApiService.listExecutions('wf-1');

      expect(serverService.query).toHaveBeenCalledWith(
        expect.stringContaining('listExecutions'),
        { workflowId: 'wf-1' }
      );
      expect(result.items).toEqual(mockItems);
    });
  });

  describe('startExecution', () => {
    it('calls mutate with workflowId and optional input', async () => {
      const mockExecution = { executionId: 'exec-new', status: 'pending', workflowId: 'wf-1' };
      (serverService.mutate as jest.Mock).mockResolvedValue({ startExecution: mockExecution });

      const inputPayload = JSON.stringify({ key: 'value' });
      const result = await executionApiService.startExecution('wf-1', inputPayload);

      expect(serverService.mutate).toHaveBeenCalledWith(
        expect.stringContaining('startExecution'),
        { workflowId: 'wf-1', input: inputPayload }
      );
      expect(result).toEqual(mockExecution);
    });

    it('calls mutate without input when not provided', async () => {
      const mockExecution = { executionId: 'exec-new', status: 'pending' };
      (serverService.mutate as jest.Mock).mockResolvedValue({ startExecution: mockExecution });

      const result = await executionApiService.startExecution('wf-1');

      expect(serverService.mutate).toHaveBeenCalledWith(
        expect.stringContaining('startExecution'),
        { workflowId: 'wf-1' }
      );
      expect(result).toEqual(mockExecution);
    });
  });

  describe('cancelExecution', () => {
    it('calls mutate with executionId and returns cancelled execution', async () => {
      const mockCancelled = { executionId: 'exec-1', status: 'cancelled' };
      (serverService.mutate as jest.Mock).mockResolvedValue({ cancelExecution: mockCancelled });

      const result = await executionApiService.cancelExecution('exec-1');

      expect(serverService.mutate).toHaveBeenCalledWith(
        expect.stringContaining('cancelExecution'),
        { executionId: 'exec-1' }
      );
      expect(result).toEqual(mockCancelled);
    });
  });
});
