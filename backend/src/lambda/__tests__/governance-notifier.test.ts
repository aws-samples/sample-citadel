/**
 * Tests for governance-notifier Lambda — AppSync subscription relay.
 *
 * Mirrors governance-finding-fanout.test.ts mock style: jest.mock() the
 * SignatureV4 / Sha256 / credential-provider modules, mock global fetch,
 * then assert on signing + posting + rethrow semantics for each of the
 * 14 governance.* detail-types declared in
 * backend/src/utils/notifier-base.ts.
 */

// Mock global fetch before any imports (handler uses node 18+ global fetch).
const mockFetch = jest.fn();
(global as any).fetch = mockFetch;

const mockSign = jest.fn();
jest.mock('@smithy/signature-v4', () => ({
  SignatureV4: jest.fn().mockImplementation(() => ({
    sign: mockSign,
  })),
}));

jest.mock('@aws-crypto/sha256-js', () => ({
  Sha256: jest.fn(),
}));

jest.mock('@aws-sdk/credential-provider-node', () => ({
  defaultProvider: jest.fn().mockReturnValue('mock-credentials'),
}));

import type { EventBridgeEvent } from 'aws-lambda';
import { GOVERNANCE_DETAIL_TYPES } from '../../utils/notifier-base';

// Lazy-import the handler (must come after the env var setup) so the
// production module is required only once per test process and the
// internal lazy-signer cache is exercised under realistic conditions.
import { handler, __resetForTest } from '../governance-notifier';

const APPSYNC_ENDPOINT_VAL =
  'https://test-api.appsync-api.us-east-1.amazonaws.com/graphql';

beforeAll(() => {
  process.env.APPSYNC_ENDPOINT = APPSYNC_ENDPOINT_VAL;
  process.env.AWS_REGION = 'us-east-1';
});

beforeEach(() => {
  mockFetch.mockReset();
  mockSign.mockReset();
  __resetForTest();
  mockSign.mockResolvedValue({
    headers: {
      'Content-Type': 'application/json',
      host: 'test-api.appsync-api.us-east-1.amazonaws.com',
      authorization:
        'AWS4-HMAC-SHA256 Credential=test/20260519/us-east-1/appsync/aws4_request, SignedHeaders=host;x-amz-date, Signature=abc',
      'x-amz-date': '20260519T000000Z',
      'x-amz-security-token': 'test-session-token',
    },
    body: JSON.stringify({ query: 'mutation', variables: {} }),
  });
  mockFetch.mockResolvedValue({
    ok: true,
    status: 200,
    json: async () => ({
      data: {
        publishGovernanceEvent: {
          detailType: 'governance.adr.locked',
          source: 'citadel.backend',
          eventTime: '2026-04-30T00:00:00Z',
          detail: '{}',
          version: 1,
        },
      },
    }),
  });
  jest.spyOn(console, 'error').mockImplementation(() => {});
  jest.spyOn(console, 'log').mockImplementation(() => {});
});

afterEach(() => {
  (console.error as jest.Mock).mockRestore?.();
  (console.log as jest.Mock).mockRestore?.();
});

afterAll(() => {
  delete process.env.APPSYNC_ENDPOINT;
  delete process.env.AWS_REGION;
});

function makeEvent(
  detailType: string,
  detail: Record<string, unknown> = { projectId: 'p1' },
): EventBridgeEvent<string, Record<string, unknown>> {
  return {
    version: '0',
    id: `evt-${detailType}`,
    'detail-type': detailType,
    source: 'citadel.backend',
    account: '123456789012',
    time: '2026-04-30T00:00:00Z',
    region: 'us-east-1',
    resources: [],
    detail,
  };
}

// ---------------------------------------------------------------------------
// Sanity: notifier-base.ts is the single source of truth for governance.*
// detail-types. The test suite must iterate every entry it exposes.
// ---------------------------------------------------------------------------

describe('governance-notifier — detail-type catalogue invariant', () => {
  test('GOVERNANCE_DETAIL_TYPES has exactly 14 entries (canonical list)', () => {
    expect(GOVERNANCE_DETAIL_TYPES).toHaveLength(14);
  });

  test('every entry begins with the "governance." namespace prefix', () => {
    for (const dt of GOVERNANCE_DETAIL_TYPES) {
      expect(dt.startsWith('governance.')).toBe(true);
    }
  });
});

// ---------------------------------------------------------------------------
// Parameterised happy path — POSTs the right mutation input for each of the
// 14 governance.* detail-types.
// ---------------------------------------------------------------------------

describe('governance-notifier — relays each governance.* detail-type', () => {
  test.each(GOVERNANCE_DETAIL_TYPES.map((d) => [d]))(
    'POSTs publishGovernanceEvent for %s',
    async (detailType) => {
      const detail = { projectId: 'p1', marker: detailType };
      const event = makeEvent(detailType, detail);

      await handler(event);

      expect(mockSign).toHaveBeenCalledTimes(1);
      expect(mockFetch).toHaveBeenCalledTimes(1);

      const fetchCall = mockFetch.mock.calls[0];
      const body = JSON.parse(fetchCall[1].body);
      expect(body.query).toContain('publishGovernanceEvent');
      expect(body.variables.input).toEqual({
        detailType,
        source: 'citadel.backend',
        eventTime: '2026-04-30T00:00:00Z',
        detail: JSON.stringify(detail),
        version: 1,
      });
    },
  );
});

// ---------------------------------------------------------------------------
// Defence-in-depth — drop non-governance-prefixed events.
// ---------------------------------------------------------------------------

describe('governance-notifier — defence in depth', () => {
  test('drops a non-governance-prefixed detail-type without POSTing', async () => {
    const event = makeEvent('design.progress.updated', { projectId: 'p1' });

    await handler(event);

    expect(mockSign).not.toHaveBeenCalled();
    expect(mockFetch).not.toHaveBeenCalled();
  });

  test('drops an unknown governance.* detail-type without POSTing', async () => {
    const event = makeEvent('governance.unknown.future', { projectId: 'p1' });

    await handler(event);

    expect(mockSign).not.toHaveBeenCalled();
    expect(mockFetch).not.toHaveBeenCalled();
  });
});

// ---------------------------------------------------------------------------
// Configuration errors — missing APPSYNC_ENDPOINT must throw.
// ---------------------------------------------------------------------------

describe('governance-notifier — configuration errors', () => {
  test('throws a structured error when APPSYNC_ENDPOINT is missing', async () => {
    const saved = process.env.APPSYNC_ENDPOINT;
    delete process.env.APPSYNC_ENDPOINT;
    try {
      const event = makeEvent('governance.adr.locked', { projectId: 'p1' });
      await expect(handler(event)).rejects.toThrow(/APPSYNC_ENDPOINT/);
    } finally {
      process.env.APPSYNC_ENDPOINT = saved;
    }
  });
});

// ---------------------------------------------------------------------------
// Failure paths — AppSync 4xx and 5xx must rethrow so EventBridge retries.
// ---------------------------------------------------------------------------

describe('governance-notifier — AppSync failure paths', () => {
  test('rethrows when AppSync responds 4xx (so EventBridge retries / DLQ)', async () => {
    mockFetch.mockResolvedValue({
      ok: false,
      status: 400,
      json: async () => ({ errors: [{ message: 'Bad request' }] }),
      text: async () => '{"errors":[{"message":"Bad request"}]}',
    });

    const event = makeEvent('governance.adr.locked', { projectId: 'p1' });
    await expect(handler(event)).rejects.toThrow();
  });

  test('rethrows when AppSync responds 5xx', async () => {
    mockFetch.mockResolvedValue({
      ok: false,
      status: 500,
      json: async () => ({ errors: [{ message: 'Server error' }] }),
      text: async () => 'Server error',
    });

    const event = makeEvent('governance.round.started', {
      projectId: 'p1',
      roundN: 1,
    });
    await expect(handler(event)).rejects.toThrow();
  });

  test('rethrows when GraphQL returns errors with HTTP 200', async () => {
    mockFetch.mockResolvedValue({
      ok: true,
      status: 200,
      json: async () => ({
        errors: [{ message: 'Field publishGovernanceEvent unknown' }],
      }),
    });

    const event = makeEvent('governance.adr.locked', { projectId: 'p1' });
    await expect(handler(event)).rejects.toThrow();
  });
});

// ---------------------------------------------------------------------------
// SigV4 wiring — the signed HttpRequest reaches the fetch call with the
// AWS auth headers our SignatureV4 mock produced.
// ---------------------------------------------------------------------------

describe('governance-notifier — SigV4 signing', () => {
  test('forwards Authorization, x-amz-date, x-amz-security-token headers from the signer', async () => {
    const event = makeEvent('governance.specification.created', {
      projectId: 'p1',
      specId: 's1',
      version: 1,
    });

    await handler(event);

    const fetchCall = mockFetch.mock.calls[0];
    const headers = fetchCall[1].headers;
    expect(headers).toEqual(
      expect.objectContaining({
        authorization: expect.stringContaining('AWS4-HMAC-SHA256'),
        'x-amz-date': '20260519T000000Z',
        'x-amz-security-token': 'test-session-token',
      }),
    );
  });

  test('signs the request once per invocation (lazy-singleton signer survives multiple calls)', async () => {
    const event = makeEvent('governance.archetype.classified', {
      projectId: 'p1',
      archetype: 'MONOLITHIC_DB',
      confidence: 0.9,
    });

    await handler(event);
    await handler(event);

    expect(mockSign).toHaveBeenCalledTimes(2);
    expect(mockFetch).toHaveBeenCalledTimes(2);
  });
});
