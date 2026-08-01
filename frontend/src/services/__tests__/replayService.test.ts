/**
 * replayService.test.ts — client for the CIT-026 replay-package routes.
 * Mirrors traceService's conventions: unconfigured -> {available:false};
 * 403 -> {available:true, unauthorized:true, reason} (never a generic
 * throw for the gate-refusal path, since a 5xx gate-refusal from the
 * backend must degrade gracefully in the UI, not crash it); other
 * non-2xx -> throws.
 */
import { fetchAuthSession } from 'aws-amplify/auth';
import serverService from '../server';
import { replayService } from '../replayService';

jest.mock('aws-amplify/auth', () => ({
  fetchAuthSession: jest.fn(),
}));

jest.mock('../server', () => ({
  __esModule: true,
  default: {
    getConfig: jest.fn(),
  },
}));

const mockFetch = jest.fn();

beforeEach(() => {
  jest.clearAllMocks();
  global.fetch = mockFetch as unknown as typeof fetch;
  (fetchAuthSession as jest.Mock).mockResolvedValue({
    tokens: { idToken: { toString: () => 'test-id-token' } },
  });
});

describe('replayService — unconfigured (no costApiUrl)', () => {
  test('getByExecution resolves to {available:false} with zero fetches when costApiUrl is missing', async () => {
    (serverService.getConfig as jest.Mock).mockReturnValue({});

    const result = await replayService.getByExecution('exec-1');
    expect(result).toEqual({ available: false, reason: 'unconfigured' });
    expect(mockFetch).not.toHaveBeenCalled();
    expect(fetchAuthSession).not.toHaveBeenCalled();
  });
});

describe('replayService — configured, happy path', () => {
  beforeEach(() => {
    (serverService.getConfig as jest.Mock).mockReturnValue({
      costApiUrl: 'https://api.example.com',
    });
  });

  test('getByExecution calls the correct route with a Bearer token and returns {available:true, data}', async () => {
    mockFetch.mockResolvedValue({
      ok: true,
      status: 200,
      json: async () => ({ url: 'https://signed-url.example.com', expiresInSeconds: 300 }),
    });

    const result = await replayService.getByExecution('exec-1');
    expect(mockFetch).toHaveBeenCalledWith(
      'https://api.example.com/replay/by-execution/exec-1',
      expect.objectContaining({
        method: 'GET',
        headers: { Authorization: 'Bearer test-id-token' },
      }),
    );
    expect(result).toEqual({
      available: true,
      data: { url: 'https://signed-url.example.com', expiresInSeconds: 300 },
    });
  });

  test('getByConversation calls the by-conversation route', async () => {
    mockFetch.mockResolvedValue({
      ok: true,
      status: 200,
      json: async () => ({ url: 'https://signed-url.example.com' }),
    });

    await replayService.getByConversation('conv-1');
    expect(mockFetch).toHaveBeenCalledWith(
      'https://api.example.com/replay/by-conversation/conv-1',
      expect.anything(),
    );
  });
});

describe('replayService — gate-refusal graceful handling (5xx -> honest UI message, never a crash)', () => {
  beforeEach(() => {
    (serverService.getConfig as jest.Mock).mockReturnValue({
      costApiUrl: 'https://api.example.com',
    });
  });

  test('a 500 gate-refusal response resolves to a typed gateRefused result, never throws', async () => {
    mockFetch.mockResolvedValue({
      ok: false,
      status: 500,
      json: async () => ({
        error: 'Replay package could not be produced: sanitisation gate refused publication.',
        patternIds: ['github-token'],
      }),
    });

    const result = await replayService.getByExecution('exec-1');
    expect(result).toEqual({
      available: true,
      gateRefused: true,
      reason: 'Replay package could not be produced: sanitisation gate refused publication.',
    });
  });

  test('a 500 with an unparseable body still resolves to a generic honest message, never throws', async () => {
    mockFetch.mockResolvedValue({
      ok: false,
      status: 500,
      json: async () => {
        throw new Error('not json');
      },
    });

    const result = await replayService.getByExecution('exec-1');
    expect(result).toEqual({
      available: true,
      gateRefused: true,
      reason: 'Replay package could not be produced.',
    });
  });
});

describe('replayService — 403 unauthorized (ownership gate)', () => {
  beforeEach(() => {
    (serverService.getConfig as jest.Mock).mockReturnValue({
      costApiUrl: 'https://api.example.com',
    });
  });

  test('a 403 response resolves to {available:true, unauthorized:true, reason}', async () => {
    mockFetch.mockResolvedValue({
      ok: false,
      status: 403,
      json: async () => ({ error: 'Forbidden' }),
    });

    const result = await replayService.getByExecution('exec-1');
    expect(result).toEqual({ available: true, unauthorized: true, reason: 'Forbidden' });
  });
});

describe('replayService — other errors still throw (400/404)', () => {
  beforeEach(() => {
    (serverService.getConfig as jest.Mock).mockReturnValue({
      costApiUrl: 'https://api.example.com',
    });
  });

  test('a 404 response throws', async () => {
    mockFetch.mockResolvedValue({
      ok: false,
      status: 404,
      json: async () => ({ error: 'Not found' }),
    });

    await expect(replayService.getByExecution('exec-1')).rejects.toThrow();
  });
});

describe('replayService — download trigger', () => {
  test('downloadReplayPackage opens the presigned url in a new tab (no fetch of the url itself, browser handles the download)', () => {
    const openSpy = jest.spyOn(window, 'open').mockImplementation(() => null);
    replayService.downloadReplayPackage('https://signed-url.example.com/package.json');
    expect(openSpy).toHaveBeenCalledWith(
      'https://signed-url.example.com/package.json',
      '_blank',
      'noopener,noreferrer',
    );
    openSpy.mockRestore();
  });
});
