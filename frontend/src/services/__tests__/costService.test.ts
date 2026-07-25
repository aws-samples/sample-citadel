/**
 * costService Tests
 *
 * Covers: Bearer idToken attachment from fetchAuthSession, graceful
 * degradation when costApiUrl is unconfigured (no fetch to a placeholder
 * origin), query-string construction, and error propagation for genuine
 * HTTP failures.
 */

jest.mock('aws-amplify/auth', () => ({
  fetchAuthSession: jest.fn(),
}));

jest.mock('../server', () => ({
  __esModule: true,
  default: {
    getConfig: jest.fn(),
  },
}));

import { fetchAuthSession } from 'aws-amplify/auth';
import serverService from '../server';
import { costService, isCostServiceAvailable } from '../costService';

const mockFetch = jest.fn();

describe('costService', () => {
  beforeEach(() => {
    jest.clearAllMocks();
    global.fetch = mockFetch as unknown as typeof fetch;
  });

  describe('isCostServiceAvailable / degraded state', () => {
    it('reports unavailable when costApiUrl is not configured', () => {
      (serverService.getConfig as jest.Mock).mockReturnValue({ costApiUrl: undefined });
      expect(isCostServiceAvailable()).toBe(false);
    });

    it('reports unavailable when costApiUrl is an empty string', () => {
      (serverService.getConfig as jest.Mock).mockReturnValue({ costApiUrl: '' });
      expect(isCostServiceAvailable()).toBe(false);
    });

    it('reports available when costApiUrl is configured', () => {
      (serverService.getConfig as jest.Mock).mockReturnValue({ costApiUrl: 'https://cost.example.com' });
      expect(isCostServiceAvailable()).toBe(true);
    });

    it('getSummary resolves to an unavailable result and never calls fetch when unconfigured', async () => {
      (serverService.getConfig as jest.Mock).mockReturnValue({ costApiUrl: undefined });

      const result = await costService.getSummary('app');

      expect(result).toEqual({ available: false, reason: 'unconfigured' });
      expect(mockFetch).not.toHaveBeenCalled();
      expect(fetchAuthSession).not.toHaveBeenCalled();
    });

    it('getSeries resolves to an unavailable result and never calls fetch when unconfigured', async () => {
      (serverService.getConfig as jest.Mock).mockReturnValue({ costApiUrl: '' });

      const result = await costService.getSeries('org', undefined, 'day');

      expect(result).toEqual({ available: false, reason: 'unconfigured' });
      expect(mockFetch).not.toHaveBeenCalled();
    });

    it('listBudgets resolves to an unavailable result when unconfigured', async () => {
      (serverService.getConfig as jest.Mock).mockReturnValue({});

      const result = await costService.listBudgets();

      expect(result).toEqual({ available: false, reason: 'unconfigured' });
      expect(mockFetch).not.toHaveBeenCalled();
    });

    it('putBudget resolves to an unavailable result when unconfigured', async () => {
      (serverService.getConfig as jest.Mock).mockReturnValue({});

      const result = await costService.putBudget('org', {
        periodType: 'monthly',
        limitMicros: 1000,
        thresholds: [0.8, 1],
        currency: 'USD',
      });

      expect(result).toEqual({ available: false, reason: 'unconfigured' });
      expect(mockFetch).not.toHaveBeenCalled();
    });
  });

  describe('Bearer token attachment', () => {
    beforeEach(() => {
      (serverService.getConfig as jest.Mock).mockReturnValue({ costApiUrl: 'https://cost.example.com' });
      (fetchAuthSession as jest.Mock).mockResolvedValue({
        tokens: { idToken: { toString: () => 'test-id-token' } },
      });
    });

    it('attaches Authorization: Bearer <idToken> from fetchAuthSession on getSummary', async () => {
      mockFetch.mockResolvedValue({
        ok: true,
        json: async () => ({ groupBy: 'app', buckets: [] }),
      });

      await costService.getSummary('app', '2026-01-01', '2026-02-01');

      expect(fetchAuthSession).toHaveBeenCalledTimes(1);
      const [url, init] = mockFetch.mock.calls[0];
      expect(url).toBe(
        'https://cost.example.com/cost/summary?groupBy=app&from=2026-01-01&to=2026-02-01',
      );
      expect(init.headers.Authorization).toBe('Bearer test-id-token');
    });

    it('builds the series query string with dimension/id/bucket and attaches the Bearer token', async () => {
      mockFetch.mockResolvedValue({
        ok: true,
        json: async () => ({ dimension: 'app', bucket: 'day', points: [] }),
      });

      await costService.getSeries('app', 'app-123', 'day');

      const [url, init] = mockFetch.mock.calls[0];
      expect(url).toBe(
        'https://cost.example.com/cost/series?dimension=app&id=app-123&bucket=day',
      );
      expect(init.headers.Authorization).toBe('Bearer test-id-token');
    });

    it('sends PUT with JSON body and Bearer token on putBudget', async () => {
      mockFetch.mockResolvedValue({
        ok: true,
        json: async () => ({ scope: 'org', limitMicros: 1000 }),
      });

      const body = { periodType: 'monthly' as const, limitMicros: 1000, thresholds: [0.8, 1], currency: 'USD' };
      await costService.putBudget('org', body);

      const [url, init] = mockFetch.mock.calls[0];
      expect(url).toBe('https://cost.example.com/budgets/org');
      expect(init.method).toBe('PUT');
      expect(init.headers.Authorization).toBe('Bearer test-id-token');
      expect(init.headers['Content-Type']).toBe('application/json');
      expect(JSON.parse(init.body)).toEqual(body);
    });

    it('throws when no authenticated session is available', async () => {
      (fetchAuthSession as jest.Mock).mockResolvedValue({ tokens: undefined });

      await expect(costService.getSummary('app')).rejects.toThrow(
        'No authenticated session',
      );
      expect(mockFetch).not.toHaveBeenCalled();
    });
  });

  describe('error propagation', () => {
    beforeEach(() => {
      (serverService.getConfig as jest.Mock).mockReturnValue({ costApiUrl: 'https://cost.example.com' });
      (fetchAuthSession as jest.Mock).mockResolvedValue({
        tokens: { idToken: { toString: () => 'test-id-token' } },
      });
    });

    it('throws with the server-provided error message on a non-2xx response', async () => {
      mockFetch.mockResolvedValue({
        ok: false,
        status: 403,
        json: async () => ({ error: 'Forbidden' }),
      });

      await expect(costService.getSummary('app')).rejects.toThrow('Forbidden');
    });

    it('falls back to a generic status message when the error body is not JSON', async () => {
      mockFetch.mockResolvedValue({
        ok: false,
        status: 500,
        json: async () => {
          throw new Error('not json');
        },
      });

      await expect(costService.getSummary('app')).rejects.toThrow(
        'Cost API request failed with status 500',
      );
    });

    it('propagates a successful typed response through the available wrapper', async () => {
      mockFetch.mockResolvedValue({
        ok: true,
        json: async () => ({ groupBy: 'app', buckets: [{ key: 'app-1' }] }),
      });

      const result = await costService.getSummary('app');

      expect(result.available).toBe(true);
      if (result.available) {
        expect(result.data.buckets).toEqual([{ key: 'app-1' }]);
      }
    });
  });
});
