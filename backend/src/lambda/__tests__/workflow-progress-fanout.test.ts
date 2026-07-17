/**
 * Unit tests for workflow-progress-fanout Lambda
 * Tests EventBridge → AppSync mutation fan-out for real-time subscriptions
 *
 * Requirements: 20.3, 20.4, 20.5, 27.5
 */

// Mock global fetch before any imports
const mockFetch = jest.fn();
global.fetch = mockFetch as unknown as typeof fetch;

// Mock SignatureV4
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

// Mock the CloudWatch client used for best-effort failure-metric emission
const mockCwSend = jest.fn();
jest.mock('@aws-sdk/client-cloudwatch', () => ({
  CloudWatchClient: jest.fn().mockImplementation(() => ({ send: mockCwSend })),
  PutMetricDataCommand: jest
    .fn()
    .mockImplementation((input: unknown) => ({ __command: 'PutMetricData', input })),
}));

import { handler } from '../workflow-progress-fanout';

type HandlerEvent = Parameters<typeof handler>[0];

function makeEventBridgeEvent(detailType: string, detail: Record<string, unknown>): HandlerEvent {
  return {
    version: '0',
    id: 'evt-123',
    source: 'citadel.workflows',
    account: '123456789012',
    time: '2024-01-15T10:30:00Z',
    region: 'us-east-1',
    'detail-type': detailType,
    detail,
    resources: [],
  } as unknown as HandlerEvent;
}

// aws-lambda's Handler type declares legacy required context and callback
// parameters, but the implementation is a one-parameter async (event)
// function that never uses them — invoke through the real signature
// (single cast here) so calls don't pass superfluous arguments.
const invokeHandler = handler as (event: HandlerEvent) => Promise<unknown>;

describe('workflow-progress-fanout', () => {
  beforeAll(() => {
    process.env.APPSYNC_ENDPOINT = 'https://test-api.appsync-api.us-east-1.amazonaws.com/graphql';
    process.env.AWS_REGION = 'us-east-1';
  });

  beforeEach(() => {
    mockFetch.mockReset();
    mockSign.mockReset();
    mockCwSend.mockReset();
    mockCwSend.mockResolvedValue({});
    mockSign.mockResolvedValue({
      headers: {
        'Content-Type': 'application/json',
        host: 'test-api.appsync-api.us-east-1.amazonaws.com',
        authorization: 'AWS4-HMAC-SHA256 Credential=...',
        'x-amz-date': '20240115T103000Z',
      },
    });
    mockFetch.mockResolvedValue({
      ok: true,
      status: 200,
      json: async () => ({ data: { publishWorkflowProgress: {} } }),
    });
  });

  afterAll(() => {
    delete process.env.APPSYNC_ENDPOINT;
    delete process.env.AWS_REGION;
  });

  // ─── Event mapping ─────────────────────────────────────────────

  describe('event mapping', () => {
    test('maps EventBridge detail to WorkflowProgressInput and calls AppSync mutation', async () => {
      const detail = {
        executionId: 'exec-1',
        workflowId: 'wf-1',
        nodeId: 'node-1',
        status: 'running',
        output: { result: 'data' },
        error: null,
        timestamp: '2024-01-15T10:30:00Z',
      };

      await invokeHandler(
        makeEventBridgeEvent('workflow.node.started', detail)
      );

      // Verify fetch was called
      expect(mockFetch).toHaveBeenCalledTimes(1);

      // Verify the body sent to AppSync contains the correct input mapping
      const fetchCall = mockFetch.mock.calls[0];
      const body = JSON.parse(fetchCall[1].body);
      expect(body.query).toContain('publishWorkflowProgress');
      expect(body.variables.input).toEqual({
        executionId: 'exec-1',
        workflowId: 'wf-1',
        eventType: 'workflow.node.started',
        nodeId: 'node-1',
        status: 'running',
        output: JSON.stringify({ result: 'data' }),
        error: null,
        timestamp: '2024-01-15T10:30:00Z',
      });
    });
  });

  // ─── IAM auth ──────────────────────────────────────────────────

  describe('IAM auth', () => {
    test('includes correct IAM auth headers via SigV4 signing in AppSync call', async () => {
      const detail = {
        executionId: 'exec-2',
        workflowId: 'wf-2',
        timestamp: '2024-01-15T10:30:00Z',
      };

      await invokeHandler(
        makeEventBridgeEvent('workflow.started', detail)
      );

      // Verify SignatureV4.sign was called to sign the request
      expect(mockSign).toHaveBeenCalledTimes(1);

      // Verify the signed headers are used in the fetch call
      const fetchCall = mockFetch.mock.calls[0];
      expect(fetchCall[1].headers).toEqual(
        expect.objectContaining({
          authorization: expect.stringContaining('AWS4-HMAC-SHA256'),
        }),
      );
    });
  });

  // ─── All 7 event types ────────────────────────────────────────

  describe('event type handling', () => {
    const eventTypes = [
      'workflow.started',
      'workflow.node.started',
      'workflow.node.completed',
      'workflow.node.failed',
      'workflow.node.retrying',
      'workflow.completed',
      'workflow.failed',
    ];

    test.each(eventTypes)('handles %s event type', async (eventType) => {
      const detail = {
        executionId: 'exec-3',
        workflowId: 'wf-3',
        nodeId: eventType.includes('node') ? 'node-1' : undefined,
        status: 'running',
        timestamp: '2024-01-15T10:30:00Z',
      };

      await invokeHandler(
        makeEventBridgeEvent(eventType, detail)
      );

      expect(mockFetch).toHaveBeenCalledTimes(1);

      const body = JSON.parse(mockFetch.mock.calls[0][1].body);
      expect(body.variables.input.eventType).toBe(eventType);
      expect(body.variables.input.executionId).toBe('exec-3');
      expect(body.variables.input.workflowId).toBe('wf-3');
    });
  });

  // ─── Error handling ────────────────────────────────────────────

  describe('error handling', () => {
    test('throws when AppSync mutation returns non-ok response', async () => {
      mockFetch.mockResolvedValue({
        ok: false,
        status: 500,
      });

      const detail = {
        executionId: 'exec-4',
        workflowId: 'wf-4',
        timestamp: '2024-01-15T10:30:00Z',
      };

      await expect(
        invokeHandler(
          makeEventBridgeEvent('workflow.failed', detail)
        ),
      ).rejects.toThrow(/AppSync mutation failed/);
    });

    test('treats a 200 response carrying a GraphQL errors array as a failure', async () => {
      // AppSync returns HTTP 200 with an `errors` array for GraphQL-level
      // failures (e.g. unauthorized, resolver error). These must be treated
      // as publish failures, not silently swallowed.
      mockFetch.mockResolvedValue({
        ok: true,
        status: 200,
        json: async () => ({ errors: [{ message: 'Unauthorized' }] }),
      });

      const detail = {
        executionId: 'exec-graphql-err',
        workflowId: 'wf-6',
        timestamp: '2024-01-15T10:30:00Z',
      };

      await expect(
        invokeHandler(
          makeEventBridgeEvent('workflow.node.completed', detail)
        ),
      ).rejects.toThrow(/AppSync mutation failed/);
    });

    test('does not throw when a 200 response has an empty errors array', async () => {
      mockFetch.mockResolvedValue({
        ok: true,
        status: 200,
        json: async () => ({ data: { publishWorkflowProgress: {} }, errors: [] }),
      });

      const detail = {
        executionId: 'exec-empty-errs',
        workflowId: 'wf-7',
        timestamp: '2024-01-15T10:30:00Z',
      };

      await expect(
        invokeHandler(
          makeEventBridgeEvent('workflow.completed', detail)
        ),
      ).resolves.toBeUndefined();
    });
  });

  // ─── Failure logging + metric (WF-021) ─────────────────────────

  describe('failure observability', () => {
    test('logs the executionId when a GraphQL error causes a publish failure', async () => {
      const errorSpy = jest.spyOn(console, 'error').mockImplementation(() => {});
      mockFetch.mockResolvedValue({
        ok: true,
        status: 200,
        json: async () => ({ errors: [{ message: 'boom' }] }),
      });

      const detail = {
        executionId: 'exec-log-me',
        workflowId: 'wf-8',
        timestamp: '2024-01-15T10:30:00Z',
      };

      await expect(
        invokeHandler(makeEventBridgeEvent('workflow.node.failed', detail)),
      ).rejects.toThrow(/AppSync mutation failed/);

      // At least one structured error log carries the executionId.
      const loggedWithExecId = errorSpy.mock.calls
        .flat()
        .some((arg) => typeof arg === 'string' && arg.includes('exec-log-me'));
      expect(loggedWithExecId).toBe(true);
      errorSpy.mockRestore();
    });

    test('emits a Citadel/Workflows FanoutPublishFailure metric on failure', async () => {
      mockFetch.mockResolvedValue({
        ok: true,
        status: 200,
        json: async () => ({ errors: [{ message: 'boom' }] }),
      });

      const detail = {
        executionId: 'exec-metric',
        workflowId: 'wf-9',
        timestamp: '2024-01-15T10:30:00Z',
      };

      await expect(
        invokeHandler(makeEventBridgeEvent('workflow.failed', detail)),
      ).rejects.toThrow(/AppSync mutation failed/);

      expect(mockCwSend).toHaveBeenCalledTimes(1);
      const command = mockCwSend.mock.calls[0][0];
      expect(command.input.Namespace).toBe('Citadel/Workflows');
      expect(command.input.MetricData[0].MetricName).toBe('FanoutPublishFailure');
    });

    test('does not emit a failure metric on a clean publish', async () => {
      // Happy path: HTTP 200, no errors → no failure metric.
      const detail = {
        executionId: 'exec-clean',
        workflowId: 'wf-10',
        timestamp: '2024-01-15T10:30:00Z',
      };

      await invokeHandler(makeEventBridgeEvent('workflow.started', detail));

      expect(mockCwSend).not.toHaveBeenCalled();
    });

    test('a failed metric emit does not mask the underlying publish failure', async () => {
      mockCwSend.mockRejectedValue(new Error('cw down'));
      mockFetch.mockResolvedValue({ ok: false, status: 502 });

      const detail = {
        executionId: 'exec-best-effort',
        workflowId: 'wf-11',
        timestamp: '2024-01-15T10:30:00Z',
      };

      await expect(
        invokeHandler(makeEventBridgeEvent('workflow.failed', detail)),
      ).rejects.toThrow(/AppSync mutation failed/);
    });
  });

  // ─── Null/missing field handling ───────────────────────────────

  describe('null field handling', () => {
    test('maps missing optional fields to null', async () => {
      const detail = {
        executionId: 'exec-5',
        workflowId: 'wf-5',
        timestamp: '2024-01-15T10:30:00Z',
        // no nodeId, status, output, error
      };

      await invokeHandler(
        makeEventBridgeEvent('workflow.started', detail)
      );

      const body = JSON.parse(mockFetch.mock.calls[0][1].body);
      expect(body.variables.input.nodeId).toBeNull();
      expect(body.variables.input.status).toBeNull();
      expect(body.variables.input.output).toBeNull();
      expect(body.variables.input.error).toBeNull();
    });
  });
});
