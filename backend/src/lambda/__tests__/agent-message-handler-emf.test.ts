/**
 * Wave 0 EMF instrumentation tests for agent-message-handler.
 *
 * Asserts that one successful legacy AgentCore invocation emits EXACTLY ONE
 * CloudWatch EMF line carrying TimeToFirstToken_ms, AgentTurnTotal_ms and
 * HandlerOverhead_ms (namespace Citadel/Intake, Environment dimension,
 * sessionId/requestId as properties) — and that the instrumentation is
 * OBSERVABILITY ONLY: the stored + published agent message is unchanged.
 *
 * jest.mock factories are self-contained and registered before the SUT is
 * loaded (see agent-message-handler-cache.test.ts for the hoisting rationale).
 * The SUT reads its env (CONVERSATIONS_TABLE / APPSYNC_ENDPOINT) at module
 * load, so it is require()d in beforeAll AFTER env is set.
 */

jest.mock('../../utils/idempotency', () => ({
  IdempotencyGuard: jest.fn().mockImplementation(() => ({
    withIdempotency: jest.fn(async (_key: string, fn: () => Promise<void>) => {
      await fn();
      return { executed: true };
    }),
  })),
}));

jest.mock('@aws-sdk/client-ssm', () => ({
  SSMClient: jest.fn(() => ({ send: jest.fn() })),
  GetParameterCommand: jest.fn((params: unknown) => params),
}));

jest.mock('@aws-sdk/client-bedrock-agentcore', () => ({
  BedrockAgentCoreClient: jest.fn(() => ({ send: jest.fn() })),
  InvokeAgentRuntimeCommand: jest.fn((params: unknown) => params),
}));

jest.mock('@aws-sdk/client-dynamodb', () => ({
  DynamoDBClient: jest.fn(() => ({})),
}));

jest.mock('@aws-sdk/lib-dynamodb', () => {
  const send = jest.fn(async () => ({}));
  return {
    DynamoDBDocumentClient: { from: jest.fn(() => ({ send })) },
    PutCommand: jest.fn((params: unknown) => params),
    __docSend: send,
  };
});

jest.mock('@aws-sdk/credential-provider-node', () => ({
  defaultProvider: jest.fn(() => jest.fn(async () => ({
    accessKeyId: 'AK',
    secretAccessKey: 'SK',
  }))),
}));

jest.mock('@aws-sdk/signature-v4', () => ({
  SignatureV4: jest.fn(() => ({
    sign: jest.fn(async (req: { method: string; headers: Record<string, string>; body: string }) => req),
  })),
}));

process.env.CONVERSATIONS_TABLE = 'conversations-test';
process.env.APPSYNC_ENDPOINT = 'https://appsync.invalid/graphql';
process.env.IDEMPOTENCY_TABLE = 'idempotency-test';
process.env.ENVIRONMENT = 'test';
delete process.env.IMPORT_ENABLED; // force the legacy AgentCore path

type Handler = typeof import('../agent-message-handler').handler;
let handler: Handler;
let resetCaches: () => void;

const ssmModule = jest.requireMock('@aws-sdk/client-ssm') as { SSMClient: jest.Mock };
const agentCoreModule = jest.requireMock('@aws-sdk/client-bedrock-agentcore') as {
  BedrockAgentCoreClient: jest.Mock;
};
const libDynamo = jest.requireMock('@aws-sdk/lib-dynamodb') as { __docSend: jest.Mock };

/** Async-iterable of event-stream chunks, matching the AgentCore SSE shape. */
function makeStream(chunks: string[]): AsyncIterable<Uint8Array> {
  return (async function* () {
    for (const chunk of chunks) {
      yield Buffer.from(chunk);
    }
  })();
}

const makeEvent = () =>
  ({
    id: 'evt-emf-1',
    detail: {
      projectId: 'proj-emf',
      agentId: 'agent_intake_single',
      message: 'Hello agent',
      messageId: 'msg-emf-1',
      userId: 'user-1',
      timestamp: new Date().toISOString(),
    },
  }) as unknown as Parameters<Handler>[0];

/** All console.log lines that parse as EMF blobs (contain an _aws envelope). */
function emfLines(spy: jest.SpyInstance): Array<Record<string, unknown>> {
  const blobs: Array<Record<string, unknown>> = [];
  for (const call of spy.mock.calls) {
    if (typeof call[0] !== 'string') continue;
    try {
      const parsed = JSON.parse(call[0]) as Record<string, unknown>;
      if (parsed && typeof parsed === 'object' && parsed._aws) blobs.push(parsed);
    } catch {
      // not JSON — a normal handler log line
    }
  }
  return blobs;
}

type EmfEnvelope = {
  CloudWatchMetrics: Array<{
    Namespace: string;
    Dimensions: string[][];
    Metrics: Array<{ Name: string; Unit: string }>;
  }>;
};

describe('agent-message-handler — Wave 0 EMF instrumentation', () => {
  let logSpy: jest.SpyInstance;
  let errorSpy: jest.SpyInstance;
  let warnSpy: jest.SpyInstance;
  let fetchMock: jest.Mock;

  beforeAll(() => {
    // Loaded here so module-scope env reads see the values set above.
    // eslint-disable-next-line @typescript-eslint/no-var-requires
    const sut = require('../agent-message-handler');
    handler = sut.handler;
    resetCaches = sut._resetCaches;
  });

  beforeEach(() => {
    resetCaches();
    logSpy = jest.spyOn(console, 'log').mockImplementation(() => {});
    errorSpy = jest.spyOn(console, 'error').mockImplementation(() => {});
    warnSpy = jest.spyOn(console, 'warn').mockImplementation(() => {});

    const ssmSend = (ssmModule.SSMClient.mock.results[0]?.value as { send: jest.Mock }).send;
    ssmSend.mockReset();
    ssmSend.mockResolvedValue({
      Parameter: {
        Value: JSON.stringify({ agentRuntimeArn: 'arn:aws:bedrock:us-west-2:123:agent/intake' }),
      },
    });

    libDynamo.__docSend.mockClear();

    fetchMock = jest.fn(async () => ({ ok: true, json: async () => ({ data: {} }) }));
    (global as unknown as { fetch: unknown }).fetch = fetchMock;
  });

  afterEach(() => {
    logSpy.mockRestore();
    errorSpy.mockRestore();
    warnSpy.mockRestore();
  });

  /** Arm the (lazily-constructed) AgentCore client mock with a streaming reply. */
  function armAgentCoreStream(): void {
    agentCoreModule.BedrockAgentCoreClient.mockImplementation(() => ({
      send: jest.fn(async () => ({
        $metadata: { httpStatusCode: 200, requestId: 'req-emf-123' },
        contentType: 'text/event-stream',
        response: makeStream(['data: "Hello "\n', 'data: "world"\n']),
      })),
    }));
  }

  test('emits exactly one EMF line with TimeToFirstToken_ms, AgentTurnTotal_ms and HandlerOverhead_ms', async () => {
    armAgentCoreStream();
    await handler(makeEvent());

    const blobs = emfLines(logSpy);
    expect(blobs).toHaveLength(1);

    const blob = blobs[0];
    const aws = blob._aws as EmfEnvelope;
    expect(aws.CloudWatchMetrics[0].Namespace).toBe('Citadel/Intake');
    expect(aws.CloudWatchMetrics[0].Dimensions).toEqual([['Environment']]);

    const names = aws.CloudWatchMetrics[0].Metrics.map((m) => m.Name).sort();
    expect(names).toEqual(['AgentTurnTotal_ms', 'HandlerOverhead_ms', 'TimeToFirstToken_ms']);
    for (const metric of aws.CloudWatchMetrics[0].Metrics) {
      expect(metric.Unit).toBe('Milliseconds');
    }

    expect(typeof blob.TimeToFirstToken_ms).toBe('number');
    expect(typeof blob.AgentTurnTotal_ms).toBe('number');
    expect(typeof blob.HandlerOverhead_ms).toBe('number');
    expect(blob.AgentTurnTotal_ms as number).toBeGreaterThanOrEqual(blob.TimeToFirstToken_ms as number);
    expect(blob.Environment).toBe('test');
  });

  test('carries sessionId and requestId as properties, not dimensions', async () => {
    armAgentCoreStream();
    await handler(makeEvent());

    const blob = emfLines(logSpy)[0];
    expect(blob.sessionId).toBe('proj-emf'); // sessionId = projectId in this handler
    expect(blob.requestId).toBe('req-emf-123');
    const aws = blob._aws as EmfEnvelope;
    expect(aws.CloudWatchMetrics[0].Dimensions).toEqual([['Environment']]);
  });

  test('does not alter the stored or published agent message (observability only)', async () => {
    armAgentCoreStream();
    await handler(makeEvent());

    // DynamoDB write: progress update goes only to AppSync, so the single Put
    // is the agent response — its message must be the exact joined stream text.
    const putItems = libDynamo.__docSend.mock.calls
      .map((c) => (c[0] as { Item?: { message?: string; messageType?: string } }).Item)
      .filter((item): item is { message: string; messageType: string } => !!item);
    const agentResponses = putItems.filter((i) => i.messageType === 'AGENT_RESPONSE');
    expect(agentResponses).toHaveLength(1);
    expect(agentResponses[0].message).toBe('Hello world');

    // AppSync publish: final mutation carries the same unaltered message.
    const publishedMessages = fetchMock.mock.calls.map((c) => {
      const body = JSON.parse((c[1] as { body: string }).body) as {
        variables: { input: { message: string; messageType: string } };
      };
      return body.variables.input;
    });
    const finalPublish = publishedMessages.filter((m) => m.messageType === 'AGENT_RESPONSE');
    expect(finalPublish).toHaveLength(1);
    expect(finalPublish[0].message).toBe('Hello world');
  });

  test('a second invocation emits its own single EMF line (once per invocation)', async () => {
    armAgentCoreStream();
    await handler(makeEvent());
    await handler(makeEvent());
    expect(emfLines(logSpy)).toHaveLength(2);
  });

  test('non-streaming response still emits AgentTurnTotal_ms (no TTFT without a stream loop)', async () => {
    agentCoreModule.BedrockAgentCoreClient.mockImplementation(() => ({
      send: jest.fn(async () => ({
        $metadata: { httpStatusCode: 200, requestId: 'req-emf-456' },
        contentType: 'application/json',
        response: {
          transformToByteArray: async () =>
            new Uint8Array(Buffer.from(JSON.stringify({ response: 'plain reply' }))),
        },
      })),
    }));
    await handler(makeEvent());

    const blobs = emfLines(logSpy);
    expect(blobs).toHaveLength(1);
    const names = (blobs[0]._aws as EmfEnvelope).CloudWatchMetrics[0].Metrics.map((m) => m.Name);
    expect(names).toContain('AgentTurnTotal_ms');
    expect(names).toContain('HandlerOverhead_ms');
    expect(names).not.toContain('TimeToFirstToken_ms');
  });
});
