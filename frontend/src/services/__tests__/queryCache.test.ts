/**
 * queryCache tests — dedupe, TTL, invalidate, clearAll.
 */

import { cached, invalidate, clearAll } from '../queryCache';

beforeEach(() => {
  clearAll();
  jest.restoreAllMocks();
});

describe('queryCache.cached', () => {
  it('deduplicates concurrent calls to the same key', async () => {
    let calls = 0;
    const fetcher = () =>
      new Promise<string>((resolve) =>
        setTimeout(() => {
          calls += 1;
          resolve('result');
        }, 10),
      );

    const [a, b, c] = await Promise.all([
      cached('k', fetcher),
      cached('k', fetcher),
      cached('k', fetcher),
    ]);

    expect(calls).toBe(1);
    expect(a).toBe('result');
    expect(b).toBe('result');
    expect(c).toBe('result');
  });

  it('returns cached value within TTL without re-fetching', async () => {
    let calls = 0;
    const fetcher = async () => {
      calls += 1;
      return 'value';
    };

    await cached('x', fetcher, 5_000);
    const second = await cached('x', fetcher, 5_000);

    expect(calls).toBe(1);
    expect(second).toBe('value');
  });

  it('re-fetches after TTL expires', async () => {
    let calls = 0;
    const fetcher = async () => {
      calls += 1;
      return `v${calls}`;
    };

    const now = jest.spyOn(Date, 'now');
    now.mockReturnValue(1000);

    const first = await cached('ttl', fetcher, 100);
    expect(first).toBe('v1');

    // Move time past TTL
    now.mockReturnValue(1200);

    const second = await cached('ttl', fetcher, 100);
    expect(second).toBe('v2');
    expect(calls).toBe(2);

    now.mockRestore();
  });

  it('does not cache a rejected fetch', async () => {
    let calls = 0;
    const fetcher = async () => {
      calls += 1;
      if (calls === 1) throw new Error('boom');
      return 'ok';
    };

    await expect(cached('fail', fetcher)).rejects.toThrow('boom');
    const result = await cached('fail', fetcher);

    expect(result).toBe('ok');
    expect(calls).toBe(2);
  });
});

describe('queryCache.invalidate', () => {
  it('evicts entries matching a prefix so next call re-fetches', async () => {
    let calls = 0;
    const fetcher = async () => {
      calls += 1;
      return calls;
    };

    await cached('agentConfigs:list', fetcher);
    expect(calls).toBe(1);

    invalidate('agentConfigs:');

    const fresh = await cached('agentConfigs:list', fetcher);
    expect(calls).toBe(2);
    expect(fresh).toBe(2);
  });

  it('does not evict entries with a different prefix', async () => {
    let agentCalls = 0;
    let toolCalls = 0;

    await cached('agentConfigs:list', async () => ++agentCalls);
    await cached('toolConfigs:list', async () => ++toolCalls);

    invalidate('agentConfigs:');

    await cached('toolConfigs:list', async () => ++toolCalls);
    expect(toolCalls).toBe(1); // still cached
  });
});

describe('queryCache.clearAll', () => {
  it('drops every entry so all keys re-fetch', async () => {
    let calls = 0;
    const fetcher = async () => ++calls;

    await cached('a', fetcher);
    await cached('b', fetcher);
    expect(calls).toBe(2);

    clearAll();

    await cached('a', fetcher);
    await cached('b', fetcher);
    expect(calls).toBe(4);
  });
});
