/**
 * traceService Tests
 *
 * Covers: graceful degradation when costApiUrl (aws_cost_api_url) is
 * unconfigured (zero fetches), Bearer idToken attachment from
 * fetchAuthSession, and 403 surfaced as a typed `unauthorized` reason
 * rather than a thrown error (design §2 error responses / the "honest
 * unauthorized state" requirement).
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
import { traceService, isTraceServiceAvailable } from '../traceService';

const mockFetch = jest.fn();

describe('traceService', () => {
  beforeEach(() => {
    jest.clearAllMocks();
    global.fetch = mockFetch as unknown as typeof fetch;
  });

  describe('unconfigured (zero fetches)', () => {
    it('reports unavailable when costApiUrl is not configured', () => {
      (serverService.getConfig as jest.Mock).mockReturnValue({ costApiUrl: undefined });
      expect(isTraceServiceAvailable()).toBe(false);
    });

    it('reports unavailable when costApiUrl is an empty string', () => {
      (serverService.getConfig as jest.Mock).mockReturnValue({ costApiUrl: '' });
      expect(isTraceServiceAvailable()).toBe(false);
    });

    it('reports available when costApiUrl is configured (reused from cost API)', () => {
      (serverService.getConfig as jest.Mock).mockReturnValue({ costApiUrl: 'https://cost.example.com' });
      expect(isTraceServiceAvailable()).toBe(true);
    });

    it('getByExecution resolves to an unavailable result and never calls fetch when unconfigured', async () => {
      (serverService.getConfig as jest.Mock).mockReturnValue({ costApiUrl: undefined });

      const result = await traceService.getByExecution('exec-1');

      expect(result).toEqual({ available: false, reason: 'unconfigured' });
      expect(mockFetch).not.toHaveBeenCalled();
      expect(fetchAuthSession).not.toHaveBeenCalled();
    });

    it('getByConversation resolves to an unavailable result and never calls fetch when unconfigured', async () => {
      (serverService.getConfig as jest.Mock).mockReturnValue({ costApiUrl: '' });

      const result = await traceService.getByConversation('proj-1');

      expect(result).toEqual({ available: false, reason: 'unconfigured' });
      expect(mockFetch).not.toHaveBeenCalled();
    });

    it('getByTraceId resolves to an unavailable result and never calls fetch when unconfigured', async () => {
      (serverService.getConfig as jest.Mock).mockReturnValue({});

      const result = await traceService.getByTraceId('1-abc-def');

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

    it('attaches Authorization: Bearer <idToken> from fetchAuthSession on getByExecution', async () => {
      mockFetch.mockResolvedValue({
        ok: true,
        status: 200,
        json: async () => ({ query: { kind: 'execution', id: 'exec-1' }, status: 'ready', traces: [] }),
      });

      await traceService.getByExecution('exec-1');

      expect(fetchAuthSession).toHaveBeenCalledTimes(1);
      const [url, init] = mockFetch.mock.calls[0];
      expect(url).toBe('https://cost.example.com/traces/by-execution/exec-1');
      expect(init.headers.Authorization).toBe('Bearer test-id-token');
    });

    it('builds the by-conversation URL and attaches the Bearer token', async () => {
      mockFetch.mockResolvedValue({
        ok: true,
        status: 200,
        json: async () => ({ query: { kind: 'conversation', id: 'proj-1' }, status: 'ready', traces: [] }),
      });

      await traceService.getByConversation('proj-1');

      const [url, init] = mockFetch.mock.calls[0];
      expect(url).toBe('https://cost.example.com/traces/by-conversation/proj-1');
      expect(init.headers.Authorization).toBe('Bearer test-id-token');
    });

    it('builds the raw traceId URL (admin-only route) and attaches the Bearer token', async () => {
      mockFetch.mockResolvedValue({
        ok: true,
        status: 200,
        json: async () => ({ query: { kind: 'traceId', id: '1-abc-def' }, status: 'ready', traces: [] }),
      });

      await traceService.getByTraceId('1-abc-def');

      const [url, init] = mockFetch.mock.calls[0];
      expect(url).toBe('https://cost.example.com/traces/1-abc-def');
      expect(init.headers.Authorization).toBe('Bearer test-id-token');
    });

    it('encodes path segments to avoid path injection via the id', async () => {
      mockFetch.mockResolvedValue({
        ok: true,
        status: 200,
        json: async () => ({ traces: [] }),
      });

      await traceService.getByExecution('exec/../etc');

      const [url] = mockFetch.mock.calls[0];
      expect(url).toBe('https://cost.example.com/traces/by-execution/exec%2F..%2Fetc');
    });
  });

  describe('unauthorized (403) surfaced as a typed reason, not a throw', () => {
    beforeEach(() => {
      (serverService.getConfig as jest.Mock).mockReturnValue({ costApiUrl: 'https://cost.example.com' });
      (fetchAuthSession as jest.Mock).mockResolvedValue({
        tokens: { idToken: { toString: () => 'test-id-token' } },
      });
    });

    it('returns an unauthorized result on a 403 response instead of throwing', async () => {
      mockFetch.mockResolvedValue({
        ok: false,
        status: 403,
        json: async () => ({ error: 'Forbidden' }),
      });

      const result = await traceService.getByExecution('exec-1');

      expect(result).toEqual({ available: true, unauthorized: true, reason: 'Forbidden' });
    });

    it('falls back to a generic reason when the 403 body is not JSON', async () => {
      mockFetch.mockResolvedValue({
        ok: false,
        status: 403,
        json: async () => {
          throw new Error('not json');
        },
      });

      const result = await traceService.getByExecution('exec-1');

      expect(result).toEqual({ available: true, unauthorized: true, reason: 'Forbidden' });
    });

    it('still throws on genuine non-403 HTTP errors (e.g. 500)', async () => {
      mockFetch.mockResolvedValue({
        ok: false,
        status: 500,
        json: async () => ({ error: 'Internal server error' }),
      });

      await expect(traceService.getByExecution('exec-1')).rejects.toThrow('Internal server error');
    });

    it('throws when no authenticated session is available', async () => {
      (fetchAuthSession as jest.Mock).mockResolvedValue({ tokens: undefined });

      await expect(traceService.getByExecution('exec-1')).rejects.toThrow('No authenticated session');
      expect(mockFetch).not.toHaveBeenCalled();
    });
  });

  describe('successful response propagation', () => {
    beforeEach(() => {
      (serverService.getConfig as jest.Mock).mockReturnValue({ costApiUrl: 'https://cost.example.com' });
      (fetchAuthSession as jest.Mock).mockResolvedValue({
        tokens: { idToken: { toString: () => 'test-id-token' } },
      });
    });

    it('propagates a ready response with traces through the available wrapper', async () => {
      const payload = {
        query: { kind: 'execution', id: 'exec-1', correlationId: 'exec-1' },
        status: 'ready',
        linkedBy: 'correlation_id',
        traces: [{ traceId: '1-a-b', spans: [] }],
        truncated: false,
        meta: { traceCount: 1, spanCount: 0, estimate: false },
      };
      mockFetch.mockResolvedValue({ ok: true, status: 200, json: async () => payload });

      const result = await traceService.getByExecution('exec-1');

      expect(result.available).toBe(true);
      if (result.available && !result.unauthorized) {
        expect(result.data).toEqual(payload);
      }
    });
  });
});
