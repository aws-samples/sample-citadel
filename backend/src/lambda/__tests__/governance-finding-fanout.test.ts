/**
 * Tests for governance-finding-fanout Lambda — Wave 3.C.
 *
 * Mirrors the workflow-progress-fanout.test.ts structure: mock fetch +
 * SignatureV4 before importing the handler, then assert on the projection
 * + signing + posting sequence, the best-effort metric path on AppSync
 * failures, and the INSERT-only filter.
 */

// Mock global fetch before any imports (handler uses node 18+ global fetch).
const mockFetch = jest.fn();
(global as any).fetch = mockFetch;

// Mock SignatureV4 + Sha256 + credential provider so the signer never
// reaches AWS in unit tests.
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

import { mockClient } from 'aws-sdk-client-mock';
import {
  CloudWatchClient,
  PutMetricDataCommand,
} from '@aws-sdk/client-cloudwatch';

import {
  handler,
  projectRow,
  __resetForTest,
} from '../governance-finding-fanout';

const cwMock = mockClient(CloudWatchClient);

// DynamoDB stream NewImage uses the AttributeValue ({S: ..., N: ...}) shape
// — these helpers keep the test rows readable.
function S(v: string) {
  return { S: v };
}
function N(v: number | string) {
  return { N: String(v) };
}
function BOOL(v: boolean) {
  return { BOOL: v };
}

function makeRecord(opts: {
  eventName?: 'INSERT' | 'MODIFY' | 'REMOVE';
  newImage?: Record<string, any>;
  eventID?: string;
}) {
  return {
    eventID: opts.eventID ?? 'rec-1',
    eventName: opts.eventName ?? 'INSERT',
    eventVersion: '1.1',
    eventSource: 'aws:dynamodb',
    awsRegion: 'us-east-1',
    dynamodb: {
      ApproximateCreationDateTime: 1715000000,
      Keys: { findingId: S('f-1') },
      NewImage: opts.newImage,
      SequenceNumber: '1',
      SizeBytes: 100,
      StreamViewType: 'NEW_AND_OLD_IMAGES',
    },
  } as any;
}

const validNewImage = {
  findingId: S('f-1'),
  workflowId: S('wf-1'),
  decision: S('permit'),
  reason: S('unit_match:unit-a'),
  requesting_agent: S('agent-a'),
  target_agent: S('agent-b'),
  scope_evaluated: S('unit-a'),
  residual_authority_denial: BOOL(false),
  timestamp: N(1715000000.5),
};

beforeAll(() => {
  process.env.APPSYNC_ENDPOINT = 'https://test-api.appsync-api.us-east-1.amazonaws.com/graphql';
  process.env.AWS_REGION = 'us-east-1';
});

beforeEach(() => {
  cwMock.reset();
  mockFetch.mockReset();
  mockSign.mockReset();
  __resetForTest();
  mockSign.mockResolvedValue({
    headers: {
      'Content-Type': 'application/json',
      host: 'test-api.appsync-api.us-east-1.amazonaws.com',
      authorization: 'AWS4-HMAC-SHA256 Credential=test/...',
      'x-amz-date': '20260519T000000Z',
    },
  });
  mockFetch.mockResolvedValue({
    ok: true,
    status: 200,
    json: async () => ({ data: { publishGovernanceFinding: {} } }),
  });
  // Silence the per-record warn/error logs to keep test output clean.
  jest.spyOn(console, 'warn').mockImplementation(() => {});
  jest.spyOn(console, 'error').mockImplementation(() => {});
});

afterEach(() => {
  (console.warn as jest.Mock).mockRestore?.();
  (console.error as jest.Mock).mockRestore?.();
});

afterAll(() => {
  delete process.env.APPSYNC_ENDPOINT;
  delete process.env.AWS_REGION;
});

// ---------------------------------------------------------------------------
// Pure projection
// ---------------------------------------------------------------------------

describe('projectRow', () => {
  test('maps snake_case ledger fields to camelCase mutation input', () => {
    const result = projectRow({
      findingId: 'f-1',
      workflowId: 'wf-1',
      decision: 'deny',
      reason: 'rivalrous_claim:winner=X',
      requesting_agent: 'agent-a',
      target_agent: 'agent-b',
      scope_evaluated: 'unit-1',
      contract_evaluated: 'contract-1',
      escalation_target: null,
      residual_authority_denial: true,
      timestamp: 1715000000.25,
    });

    expect(result).toEqual({
      findingId: 'f-1',
      workflowId: 'wf-1',
      decision: 'deny',
      reason: 'rivalrous_claim:winner=X',
      requestingAgent: 'agent-a',
      targetAgent: 'agent-b',
      scopeEvaluated: 'unit-1',
      contractEvaluated: 'contract-1',
      escalationTarget: null,
      residualAuthorityDenial: true,
      timestamp: 1715000000.25,
    });
  });

  test('returns null when findingId is missing', () => {
    expect(projectRow({ workflowId: 'wf-1' })).toBeNull();
  });

  test('returns null when workflowId is missing', () => {
    expect(projectRow({ findingId: 'f-1' })).toBeNull();
  });

  test('coerces string-typed timestamp to number', () => {
    const result = projectRow({
      findingId: 'f-1',
      workflowId: 'wf-1',
      timestamp: '1715000000',
    });
    expect(result?.timestamp).toBe(1715000000);
  });

  test('falls back to 0 timestamp when malformed', () => {
    const result = projectRow({
      findingId: 'f-1',
      workflowId: 'wf-1',
      timestamp: 'not-a-number',
    });
    expect(result?.timestamp).toBe(0);
  });
});

// ---------------------------------------------------------------------------
// Handler — happy path
// ---------------------------------------------------------------------------

describe('governance-finding-fanout handler', () => {
  test('projects an INSERT record and POSTs the publishGovernanceFinding mutation', async () => {
    await handler(
      { Records: [makeRecord({ newImage: validNewImage })] } as any,
      {} as any,
      {} as any,
    );

    expect(mockSign).toHaveBeenCalledTimes(1);
    expect(mockFetch).toHaveBeenCalledTimes(1);

    const fetchCall = mockFetch.mock.calls[0];
    const body = JSON.parse(fetchCall[1].body);
    expect(body.query).toContain('publishGovernanceFinding');
    expect(body.variables.input).toEqual({
      findingId: 'f-1',
      workflowId: 'wf-1',
      decision: 'permit',
      reason: 'unit_match:unit-a',
      requestingAgent: 'agent-a',
      targetAgent: 'agent-b',
      scopeEvaluated: 'unit-a',
      contractEvaluated: null,
      escalationTarget: null,
      residualAuthorityDenial: false,
      timestamp: 1715000000.5,
    });

    // SigV4 headers reach the fetch call.
    expect(fetchCall[1].headers).toEqual(
      expect.objectContaining({
        authorization: expect.stringContaining('AWS4-HMAC-SHA256'),
      }),
    );

    // No metric on success.
    expect(cwMock.commandCalls(PutMetricDataCommand)).toHaveLength(0);
  });

  test('skips MODIFY records (defence-in-depth past the EventSourceMapping filter)', async () => {
    await handler(
      {
        Records: [
          makeRecord({ eventName: 'MODIFY', newImage: validNewImage }),
        ],
      } as any,
      {} as any,
      {} as any,
    );

    expect(mockFetch).not.toHaveBeenCalled();
    expect(cwMock.commandCalls(PutMetricDataCommand)).toHaveLength(0);
  });

  test('skips REMOVE records', async () => {
    await handler(
      {
        Records: [
          makeRecord({ eventName: 'REMOVE', newImage: undefined }),
        ],
      } as any,
      {} as any,
      {} as any,
    );

    expect(mockFetch).not.toHaveBeenCalled();
  });

  test('skips records with missing NewImage and does not metricise', async () => {
    await handler(
      { Records: [makeRecord({ newImage: undefined })] } as any,
      {} as any,
      {} as any,
    );
    expect(mockFetch).not.toHaveBeenCalled();
    expect(cwMock.commandCalls(PutMetricDataCommand)).toHaveLength(0);
  });

  test('skips malformed rows (missing findingId) and emits PublishFailure metric', async () => {
    const malformed = {
      // findingId intentionally omitted
      workflowId: S('wf-1'),
      decision: S('permit'),
      timestamp: N(1715000000),
    };

    await handler(
      { Records: [makeRecord({ newImage: malformed })] } as any,
      {} as any,
      {} as any,
    );

    // No AppSync call (projectRow returned null).
    expect(mockFetch).not.toHaveBeenCalled();
    // But a PublishFailure metric is emitted so operators can see drift.
    const cwCalls = cwMock.commandCalls(PutMetricDataCommand);
    expect(cwCalls).toHaveLength(1);
    const cmdInput = cwCalls[0].args[0].input;
    expect(cmdInput.Namespace).toBe('Citadel/Governance/Fanout');
    expect(cmdInput.MetricData?.[0].MetricName).toBe('PublishFailure');
    expect(cmdInput.MetricData?.[0].Value).toBe(1);
  });
});

// ---------------------------------------------------------------------------
// Handler — failure paths (best-effort)
// ---------------------------------------------------------------------------

describe('governance-finding-fanout handler — failure paths', () => {
  test('emits PublishFailure metric on 5xx and returns success (no throw)', async () => {
    mockFetch.mockResolvedValue({ ok: false, status: 500 });

    await expect(
      handler(
        { Records: [makeRecord({ newImage: validNewImage })] } as any,
        {} as any,
        {} as any,
      ),
    ).resolves.toBeUndefined();

    const cwCalls = cwMock.commandCalls(PutMetricDataCommand);
    expect(cwCalls).toHaveLength(1);
    expect(cwCalls[0].args[0].input.Namespace).toBe('Citadel/Governance/Fanout');
    expect(cwCalls[0].args[0].input.MetricData?.[0].MetricName).toBe('PublishFailure');
  });

  test('emits PublishFailure metric on 4xx and returns success', async () => {
    mockFetch.mockResolvedValue({ ok: false, status: 400 });

    await expect(
      handler(
        { Records: [makeRecord({ newImage: validNewImage })] } as any,
        {} as any,
        {} as any,
      ),
    ).resolves.toBeUndefined();

    expect(cwMock.commandCalls(PutMetricDataCommand)).toHaveLength(1);
  });

  test('absorbs signer rejection and continues to next record', async () => {
    mockSign.mockRejectedValueOnce(new Error('credentials unavailable'));
    // Second record will succeed.
    mockSign.mockResolvedValue({
      headers: { authorization: 'AWS4-HMAC-SHA256 ok' },
    });

    await expect(
      handler(
        {
          Records: [
            makeRecord({ eventID: 'rec-a', newImage: validNewImage }),
            makeRecord({ eventID: 'rec-b', newImage: validNewImage }),
          ],
        } as any,
        {} as any,
        {} as any,
      ),
    ).resolves.toBeUndefined();

    // Second record succeeds → fetch only called once.
    expect(mockFetch).toHaveBeenCalledTimes(1);
    // First record metricises.
    expect(cwMock.commandCalls(PutMetricDataCommand)).toHaveLength(1);
  });

  test('absorbs CloudWatch metric failures (never throws)', async () => {
    mockFetch.mockResolvedValue({ ok: false, status: 500 });
    cwMock.on(PutMetricDataCommand).rejects(new Error('cw down'));

    await expect(
      handler(
        { Records: [makeRecord({ newImage: validNewImage })] } as any,
        {} as any,
        {} as any,
      ),
    ).resolves.toBeUndefined();
  });

  test('processes multiple records independently — one failure does not block the rest', async () => {
    // First record succeeds, second fails on AppSync, third succeeds.
    mockFetch
      .mockResolvedValueOnce({ ok: true, status: 200 })
      .mockResolvedValueOnce({ ok: false, status: 502 })
      .mockResolvedValueOnce({ ok: true, status: 200 });

    await handler(
      {
        Records: [
          makeRecord({ eventID: 'r-1', newImage: validNewImage }),
          makeRecord({ eventID: 'r-2', newImage: validNewImage }),
          makeRecord({ eventID: 'r-3', newImage: validNewImage }),
        ],
      } as any,
      {} as any,
      {} as any,
    );

    expect(mockFetch).toHaveBeenCalledTimes(3);
    // Exactly one PublishFailure for the 5xx — not three.
    expect(cwMock.commandCalls(PutMetricDataCommand)).toHaveLength(1);
  });

  test('throws synchronously when APPSYNC_ENDPOINT is missing — but handler still returns success', async () => {
    delete process.env.APPSYNC_ENDPOINT;

    await expect(
      handler(
        { Records: [makeRecord({ newImage: validNewImage })] } as any,
        {} as any,
        {} as any,
      ),
    ).resolves.toBeUndefined();

    // The publish attempt threw inside the per-record try/catch and
    // metricised PublishFailure rather than propagating.
    expect(cwMock.commandCalls(PutMetricDataCommand)).toHaveLength(1);

    // Restore for subsequent tests.
    process.env.APPSYNC_ENDPOINT = 'https://test-api.appsync-api.us-east-1.amazonaws.com/graphql';
  });

  test('handles an empty Records array', async () => {
    await expect(
      handler({ Records: [] } as any, {} as any, {} as any),
    ).resolves.toBeUndefined();
    expect(mockFetch).not.toHaveBeenCalled();
  });
});
