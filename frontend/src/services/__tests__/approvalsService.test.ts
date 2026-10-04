import { approvalsService } from '../approvalsService';
import serverService from '../server';
import { appApiService } from '../appApiService';
import { toolConfigService } from '../toolConfigService';

jest.mock('../server', () => ({
  __esModule: true,
  default: { query: jest.fn(), mutate: jest.fn() },
}));

jest.mock('../appApiService', () => ({
  appApiService: { updateApp: jest.fn() },
}));

jest.mock('../toolConfigService', () => ({
  toolConfigService: { updateToolConfig: jest.fn() },
}));

const mockQuery = serverService.query as jest.Mock;
const mockUpdateApp = appApiService.updateApp as jest.Mock;
const mockUpdateToolConfig = toolConfigService.updateToolConfig as jest.Mock;

describe('approvalsService', () => {
  beforeEach(() => jest.clearAllMocks());

  describe('listPendingApprovals', () => {
    it('sends the correct query document and variables', async () => {
      const fakeConnection = {
        items: [
          {
            recordId: 'r1',
            recordType: 'agent',
            name: 'MyAgent',
            displayName: 'My Agent',
            orgId: 'org1',
            submittedAt: '2026-01-01T00:00:00Z',
            createdBy: 'user1',
            status: 'PENDING_APPROVAL',
          },
        ],
        nextToken: 'tok',
      };
      mockQuery.mockResolvedValue({ listPendingApprovals: fakeConnection });

      const result = await approvalsService.listPendingApprovals({ limit: 10, nextToken: 'prev' });

      expect(mockQuery).toHaveBeenCalledTimes(1);
      const [queryDoc, vars] = mockQuery.mock.calls[0];
      expect(queryDoc).toContain('listPendingApprovals');
      expect(queryDoc).toContain('recordId');
      expect(queryDoc).toContain('recordType');
      expect(queryDoc).toContain('displayName');
      expect(vars).toEqual({ limit: 10, nextToken: 'prev' });
      expect(result).toEqual(fakeConnection);
    });

    it('defaults limit and nextToken to undefined', async () => {
      mockQuery.mockResolvedValue({ listPendingApprovals: { items: [], nextToken: null } });

      await approvalsService.listPendingApprovals();

      const [, vars] = mockQuery.mock.calls[0];
      expect(vars).toEqual({ limit: undefined, nextToken: undefined });
    });
  });

  describe('decideApproval', () => {
    it('calls updateApp with APPROVED for agent records', async () => {
      mockUpdateApp.mockResolvedValue({});

      await approvalsService.decideApproval({
        recordId: 'app1',
        recordType: 'agent',
        decision: 'APPROVED',
        version: 3,
      });

      expect(mockUpdateApp).toHaveBeenCalledWith({
        appId: 'app1',
        version: 3,
        status: 'APPROVED',
        statusReason: undefined,
      });
      expect(mockUpdateToolConfig).not.toHaveBeenCalled();
    });

    it('passes statusReason for REJECTED agent records', async () => {
      mockUpdateApp.mockResolvedValue({});

      await approvalsService.decideApproval({
        recordId: 'app2',
        recordType: 'agent',
        decision: 'REJECTED',
        version: 1,
        statusReason: 'Not ready',
      });

      expect(mockUpdateApp).toHaveBeenCalledWith({
        appId: 'app2',
        version: 1,
        status: 'REJECTED',
        statusReason: 'Not ready',
      });
    });

    it('calls updateToolConfig with APPROVED for tool records', async () => {
      mockUpdateToolConfig.mockResolvedValue({});

      await approvalsService.decideApproval({
        recordId: 'tool1',
        recordType: 'tool',
        decision: 'APPROVED',
        version: 1,
      });

      expect(mockUpdateToolConfig).toHaveBeenCalledWith({
        toolId: 'tool1',
        status: 'APPROVED',
        statusReason: undefined,
      });
      expect(mockUpdateApp).not.toHaveBeenCalled();
    });

    it('passes statusReason for REJECTED tool records', async () => {
      mockUpdateToolConfig.mockResolvedValue({});

      await approvalsService.decideApproval({
        recordId: 'tool2',
        recordType: 'tool',
        decision: 'REJECTED',
        version: 1,
        statusReason: 'Security concern',
      });

      expect(mockUpdateToolConfig).toHaveBeenCalledWith({
        toolId: 'tool2',
        status: 'REJECTED',
        statusReason: 'Security concern',
      });
    });
  });
});
