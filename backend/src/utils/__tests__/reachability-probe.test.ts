/**
 * Tests for the BACKEND-ONLY best-effort reachability probe (US-IMP-017b).
 *
 * The import-resolver Lambda runs OUTSIDE any customer VPC, so it can only
 * verify PUBLIC endpoints. Invariants pinned here:
 *   - classifyEndpointHost flags RFC1918 / loopback / link-local / internal DNS
 *     suffixes / AWS internal ALB DNS as 'private'; normal public DNS 'public'.
 *   - probeReachability is BEST-EFFORT and NEVER throws — a network error or a
 *     bounded AbortController timeout becomes { reachable:false } classified
 *     'unreachable'; a private host is 'unverifiable_private' WITHOUT a fetch;
 *     a missing/invalid endpoint is 'no_endpoint' WITHOUT a fetch; any HTTP
 *     response (even non-2xx) is 'reachable'.
 *   - the probe issues a plain GET and NEVER reads the response body (no
 *     body/secret exfiltration) and is bounded by an AbortController so a
 *     hanging endpoint cannot stall the Lambda.
 */
import {
  classifyEndpointHost,
  probeReachability,
} from '../reachability-probe';

describe('classifyEndpointHost', () => {
  it.each([
    'https://10.0.0.5/x', // 10.0.0.0/8
    'https://10.255.255.255',
    'https://172.16.0.1/y', // 172.16.0.0/12 lower bound
    'https://172.31.255.254',
    'https://192.168.1.1', // 192.168.0.0/16
    'https://127.0.0.1:8080', // 127.0.0.0/8 loopback
    'https://169.254.169.254/latest/meta-data', // link-local / IMDS
    'http://service.internal/health', // .internal suffix
    'http://db.local', // .local suffix
    'http://api.localhost:3000', // .localhost suffix
    'http://localhost:3000', // bare loopback name
    'http://internal-my-alb-1234567890.us-east-1.elb.amazonaws.com/x', // AWS internal ALB
  ])('classifies %s as private', (url) => {
    expect(classifyEndpointHost(url)).toBe('private');
  });

  it.each([
    'https://api.example.com/invoke',
    'https://agent.acme.io',
    'https://173.0.0.1', // public IP, not RFC1918
    'https://172.15.0.1', // just BELOW the 172.16/12 block
    'https://172.32.0.1', // just ABOVE the 172.16/12 block
    'https://192.167.0.1', // not 192.168
    'https://my-alb-123.us-east-1.elb.amazonaws.com', // public ELB (no internal- prefix)
  ])('classifies %s as public', (url) => {
    expect(classifyEndpointHost(url)).toBe('public');
  });
});

describe('probeReachability — classification rules', () => {
  it('public + any HTTP response (even non-2xx) -> reachable', async () => {
    const fetchFn = jest.fn().mockResolvedValue({ status: 503 });
    const result = await probeReachability('https://public.example.com', { fetchFn });
    expect(result.reachable).toBe(true);
    expect(result.classification).toBe('reachable');
    expect(fetchFn).toHaveBeenCalledTimes(1);
  });

  it('issues a bounded GET (method GET + an AbortSignal)', async () => {
    const fetchFn = jest.fn().mockResolvedValue({ status: 204 });
    await probeReachability('https://public.example.com', { fetchFn });
    const [, init] = fetchFn.mock.calls[0] as [unknown, { method?: string; signal?: AbortSignal }];
    expect(init.method).toBe('GET');
    expect(init.signal).toBeInstanceOf(AbortSignal);
  });

  it('does NOT read the response body (no body/secret exfiltration)', async () => {
    const textSpy = jest.fn();
    const fetchFn = jest.fn().mockResolvedValue({ status: 200, text: textSpy });
    await probeReachability('https://public.example.com', { fetchFn });
    expect(textSpy).not.toHaveBeenCalled();
  });

  it('public + network error -> unreachable (never throws)', async () => {
    const fetchFn = jest.fn().mockRejectedValue(new Error('ECONNREFUSED'));
    const result = await probeReachability('https://public.example.com', { fetchFn });
    expect(result.reachable).toBe(false);
    expect(result.classification).toBe('unreachable');
    expect(fetchFn).toHaveBeenCalledTimes(1);
  });

  it('public + hanging endpoint -> AbortController fires -> unreachable (does not hang)', async () => {
    // A fetch that NEVER settles on its own; it only rejects when its signal
    // aborts. With an unbounded implementation this test would hit the Jest
    // timeout and FAIL — proving the AbortController bound.
    const hangingFetch = jest.fn(
      (_input: unknown, init?: { signal?: AbortSignal }) =>
        new Promise<{ status: number }>((_resolve, reject) => {
          init?.signal?.addEventListener('abort', () => {
            const e = new Error('The operation was aborted');
            e.name = 'AbortError';
            reject(e);
          });
        }),
    );
    const result = await probeReachability('https://public.example.com/slow', {
      timeoutMs: 10,
      fetchFn: hangingFetch as unknown as typeof fetch,
    });
    expect(result.reachable).toBe(false);
    expect(result.classification).toBe('unreachable');
    const [, init] = hangingFetch.mock.calls[0] as [unknown, { signal?: AbortSignal }];
    expect(init.signal).toBeInstanceOf(AbortSignal);
    expect(init.signal!.aborted).toBe(true);
  });

  it('private host -> unverifiable_private WITHOUT calling fetch', async () => {
    const fetchFn = jest.fn();
    const result = await probeReachability('https://10.1.2.3/invoke', {
      fetchFn: fetchFn as unknown as typeof fetch,
    });
    expect(result.reachable).toBe(false);
    expect(result.classification).toBe('unverifiable_private');
    expect(result.detail).toMatch(/VPC|PrivateLink|out of scope/i);
    expect(fetchFn).not.toHaveBeenCalled();
  });

  it.each([undefined, '', '   '])(
    'missing endpoint (%p) -> no_endpoint WITHOUT calling fetch',
    async (bad) => {
      const fetchFn = jest.fn();
      const result = await probeReachability(bad as unknown as string, {
        fetchFn: fetchFn as unknown as typeof fetch,
      });
      expect(result.reachable).toBe(false);
      expect(result.classification).toBe('no_endpoint');
      expect(fetchFn).not.toHaveBeenCalled();
    },
  );

  it.each(['not a url', 'ftp://x', 'arn:aws:lambda:us-east-1:1:function:f'])(
    'invalid / non-http endpoint (%s) -> no_endpoint WITHOUT calling fetch',
    async (bad) => {
      const fetchFn = jest.fn();
      const result = await probeReachability(bad, {
        fetchFn: fetchFn as unknown as typeof fetch,
      });
      expect(result.classification).toBe('no_endpoint');
      expect(fetchFn).not.toHaveBeenCalled();
    },
  );
});
