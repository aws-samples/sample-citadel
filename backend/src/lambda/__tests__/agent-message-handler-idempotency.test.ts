/**
 * Finding #1 (consumer side): agent-message-handler must dedupe on the
 * logical message identity (`event.detail.messageId`) rather than the
 * EventBridge envelope id (`event.id`, unique per emit). The deterministic
 * messageId set by emitAssessmentTrigger lets two overlapping poller emits
 * for the same document collapse to a single processed message.
 *
 * The IdempotencyGuard is mocked with an in-memory set that mirrors the real
 * DynamoDB conditional-put semantics (first key wins, duplicates are skipped),
 * so this unit isolates the KEY-SELECTION decision in the handler.
 */
jest.mock('../../utils/idempotency', () => {
  const records: Array<{ key: string; executed: boolean }> = [];
  const seen = new Set<string>();
  return {
    IdempotencyGuard: jest.fn().mockImplementation(() => ({
      withIdempotency: jest.fn(async (key: string) => {
        const executed = !seen.has(key);
        if (executed) seen.add(key);
        records.push({ key, executed });
        return { executed };
      }),
    })),
    __records: records,
    __reset: () => {
      records.length = 0;
      seen.clear();
    },
  };
});

import { handler } from '../agent-message-handler';

const idem = jest.requireMock('../../utils/idempotency') as {
  __records: Array<{ key: string; executed: boolean }>;
  __reset: () => void;
};

const makeEvent = (id: string, messageId?: string) =>
  ({
    id,
    detail: {
      projectId: 'proj-1',
      agentId: 'agent_intake_single',
      message: 'A document has been uploaded and indexed.',
      messageId,
      userId: 'system',
      timestamp: new Date().toISOString(),
    },
  }) as any;

describe('agent-message-handler idempotency key (Finding #1)', () => {
  beforeEach(() => {
    idem.__reset();
  });

  test('uses detail.messageId as the idempotency key', async () => {
    await handler(makeEvent('evt-1', 'doc-indexed-proj-1-proj-1/a.pdf'));
    expect(idem.__records[0].key).toBe('doc-indexed-proj-1-proj-1/a.pdf');
  });

  test('dedupes a second event with the same messageId but a different event.id', async () => {
    await handler(makeEvent('evt-1', 'doc-indexed-proj-1-proj-1/a.pdf'));
    await handler(makeEvent('evt-2', 'doc-indexed-proj-1-proj-1/a.pdf'));
    expect(idem.__records.map((r) => r.executed)).toEqual([true, false]);
  });

  test('two events with different messageIds both execute', async () => {
    await handler(makeEvent('evt-1', 'doc-indexed-proj-1-proj-1/a.pdf'));
    await handler(makeEvent('evt-2', 'doc-indexed-proj-1-proj-1/b.pdf'));
    expect(idem.__records.map((r) => r.executed)).toEqual([true, true]);
  });

  test('falls back to event.id when detail.messageId is absent', async () => {
    await handler(makeEvent('evt-1', undefined));
    expect(idem.__records[0].key).toBe('evt-1');
  });
});
