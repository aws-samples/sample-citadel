/**
 * tagPolicyService Tests — getTagPolicy and updateTagPolicy payloads.
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
import { tagPolicyService } from '../tagPolicyService';

describe('tagPolicyService', () => {
  beforeEach(() => jest.clearAllMocks());

  describe('getTagPolicy', () => {
    it('calls getTagPolicy query with orgId and returns the policy', async () => {
      const policy = {
        requiredKeys: [
          { key: 'env', allowedValues: ['dev', 'staging', 'prod'] },
          { key: 'team', allowedValues: null },
        ],
        version: 1,
        updatedBy: 'admin-user',
        updatedAt: '2026-10-01T00:00:00Z',
      };
      (serverService.query as jest.Mock).mockResolvedValue({ getTagPolicy: policy });

      const result = await tagPolicyService.getTagPolicy('org-1');

      expect(serverService.query).toHaveBeenCalledWith(
        expect.stringContaining('getTagPolicy'),
        { orgId: 'org-1' },
      );
      expect(result).toEqual(policy);
    });

    it('returns null when no policy exists', async () => {
      (serverService.query as jest.Mock).mockResolvedValue({ getTagPolicy: null });

      const result = await tagPolicyService.getTagPolicy('org-1');

      expect(result).toBeNull();
    });

    it('propagates errors', async () => {
      (serverService.query as jest.Mock).mockRejectedValue(new Error('Network error'));

      await expect(tagPolicyService.getTagPolicy('org-1')).rejects.toThrow(
        'Network error',
      );
    });
  });

  describe('updateTagPolicy', () => {
    it('calls updateTagPolicy mutation with the full input', async () => {
      const input = {
        orgId: 'org-1',
        requiredKeys: [{ key: 'env', allowedValues: ['dev', 'prod'] }],
        expectedVersion: 1,
      };
      const updated = {
        requiredKeys: input.requiredKeys,
        version: 2,
        updatedBy: 'admin-user',
        updatedAt: '2026-10-02T00:00:00Z',
      };
      (serverService.mutate as jest.Mock).mockResolvedValue({
        updateTagPolicy: updated,
      });

      const result = await tagPolicyService.updateTagPolicy(input);

      expect(serverService.mutate).toHaveBeenCalledWith(
        expect.stringContaining('updateTagPolicy'),
        { input },
      );
      expect(result).toEqual(updated);
    });

    it('propagates errors', async () => {
      (serverService.mutate as jest.Mock).mockRejectedValue(
        new Error('Conflict'),
      );

      await expect(
        tagPolicyService.updateTagPolicy({
          orgId: 'org-1',
          requiredKeys: [],
        }),
      ).rejects.toThrow('Conflict');
    });
  });
});
