/**
 * Unit tests for project-progress-updater.ts (finding 186c2d8f).
 *
 * The handler consumes `intake.progress.updated` EventBridge events and must
 * write the NESTED `progress.<phase>` attribute of the project record.
 *
 * Contract pinned here:
 *  1. Nested-path SET with TWO ExpressionAttributeNames placeholders
 *     (`#progress.#field`) — a single placeholder valued 'progress.<phase>'
 *     is atomic in DynamoDB (the dot is literal) and writes a junk TOP-LEVEL
 *     attribute instead of the nested field.
 *  2. Monotonic ConditionExpression on the NESTED attribute; a
 *     ConditionalCheckFailedException is a stale-event skip, not an error.
 *  3. Unknown-field gate: unexpected phases write nothing.
 *  4. Overall recompute from the four nested phase values after a
 *     successful write.
 *  5. Negative completionPercentage (the fabricator's failure convention,
 *     -1) is a failure signal, not progress — no write at all.
 *  6. completionPercentage above 100 is clamped to 100.
 *  7. Missing `progress` map: nested SET under a missing map throws
 *     ValidationException — the handler initializes the map on an EXISTING
 *     row and retries once.
 *  8. Missing project row entirely: handler skips gracefully (never creates
 *     skeleton rows, never throws).
 */

process.env.PROJECTS_TABLE = 'citadel-projects-test';
process.env.IDEMPOTENCY_TABLE = 'citadel-idempotency-test';

import { DynamoDBDocumentClient, UpdateCommand, GetCommand } from '@aws-sdk/lib-dynamodb';
import { mockClient } from 'aws-sdk-client-mock';

// Pass-through idempotency guard: always executes the wrapped fn.
jest.mock('../../utils/idempotency', () => ({
  IdempotencyGuard: jest.fn().mockImplementation(() => ({
    withIdempotency: jest.fn(async (_id: string, fn: () => Promise<unknown>) => {
      await fn();
      return { executed: true };
    }),
  })),
}));

import { handler } from '../project-progress-updater';

const ddbMock = mockClient(DynamoDBDocumentClient);

function namedError(name: string, message = name): Error {
  const err = new Error(message);
  err.name = name;
  return err;
}

function makeEvent(overrides: Partial<{ sessionId: string; phase: string; completionPercentage: number }> = {}) {
  return {
    id: `evt-${Math.random().toString(36).slice(2)}`,
    detail: {
      sessionId: 'sess-1',
      phase: 'implementation',
      completionPercentage: 42,
      ...overrides,
    },
  };
}

/** Returns UpdateCommand call inputs in send order. */
function updateInputs() {
  return ddbMock.commandCalls(UpdateCommand).map((c) => c.args[0].input);
}

beforeEach(() => {
  ddbMock.reset();
  ddbMock.on(UpdateCommand).resolves({});
  ddbMock.on(GetCommand).resolves({
    Item: { id: 'sess-1', progress: { assessment: 100, design: 100, planning: 100, implementation: 42, overall: 75, currentPhase: 'PLANNING_COMPLETE' } },
  });
});

describe('nested-path progress write', () => {
  test('SETs progress.<phase> via TWO name placeholders, never a single dotted placeholder', async () => {
    await handler(makeEvent());

    const first = updateInputs()[0];
    const names = first.ExpressionAttributeNames as Record<string, string>;

    // The junk-attribute bug: one placeholder whose VALUE contains a dot.
    for (const value of Object.values(names)) {
      expect(value).not.toContain('.');
    }
    // Two-placeholder nested path.
    expect(names['#progress']).toBe('progress');
    expect(names['#field']).toBe('implementation');
    expect(first.UpdateExpression).toContain('#progress.#field = :pct');
    // currentPhase still updated, on the nested map.
    expect(first.UpdateExpression).toContain('#progress.#cpn = :cp');
    expect(names['#cpn']).toBe('currentPhase');
    const values = first.ExpressionAttributeValues as Record<string, unknown>;
    expect(values[':pct']).toBe(42);
    expect(values[':cp']).toBe('IMPLEMENTATION_IN_PROGRESS');
  });

  test('preserves monotonic condition semantics on the NESTED attribute', async () => {
    await handler(makeEvent());

    const first = updateInputs()[0];
    expect(first.ConditionExpression).toBe(
      'attribute_not_exists(#progress.#field) OR #progress.#field < :pct',
    );
  });

  test('marks the phase complete at 100', async () => {
    await handler(makeEvent({ completionPercentage: 100 }));

    const values = updateInputs()[0].ExpressionAttributeValues as Record<string, unknown>;
    expect(values[':pct']).toBe(100);
    expect(values[':cp']).toBe('IMPLEMENTATION_COMPLETE');
  });
});

describe('stale-event skip (ConditionalCheckFailedException)', () => {
  test('skips silently and does NOT recompute overall', async () => {
    ddbMock.on(UpdateCommand).rejects(namedError('ConditionalCheckFailedException'));

    await expect(handler(makeEvent({ completionPercentage: 10 }))).resolves.toBeUndefined();

    expect(ddbMock.commandCalls(GetCommand)).toHaveLength(0);
    expect(ddbMock.commandCalls(UpdateCommand)).toHaveLength(1);
  });

  test('rethrows non-conditional errors', async () => {
    ddbMock.on(UpdateCommand).rejects(namedError('ProvisionedThroughputExceededException'));

    await expect(handler(makeEvent())).rejects.toThrow('ProvisionedThroughputExceededException');
  });
});

describe('unknown-field gate', () => {
  test('writes nothing for a phase outside the whitelist', async () => {
    await handler(makeEvent({ phase: 'deployment' }));

    expect(ddbMock.commandCalls(UpdateCommand)).toHaveLength(0);
    expect(ddbMock.commandCalls(GetCommand)).toHaveLength(0);
  });
});

describe('overall recompute', () => {
  test('recomputes overall as the mean of the four nested phase values', async () => {
    ddbMock.on(GetCommand).resolves({
      Item: { id: 'sess-1', progress: { assessment: 100, design: 100, planning: 100, implementation: 60 } },
    });

    await handler(makeEvent({ completionPercentage: 60 }));

    const updates = updateInputs();
    expect(updates).toHaveLength(2);
    const overallUpdate = updates[1];
    // Overall write must also target the NESTED attribute via placeholders.
    const names = overallUpdate.ExpressionAttributeNames as Record<string, string>;
    expect(names['#progress']).toBe('progress');
    expect(names['#overall']).toBe('overall');
    expect(overallUpdate.UpdateExpression).toContain('#progress.#overall = :o');
    expect((overallUpdate.ExpressionAttributeValues as Record<string, unknown>)[':o']).toBe(90);
  });
});

describe('fabricator failure convention (negative percentage)', () => {
  test('ignores -1 entirely: failure signal, not progress', async () => {
    await handler(makeEvent({ completionPercentage: -1 }));

    expect(ddbMock.commandCalls(UpdateCommand)).toHaveLength(0);
    expect(ddbMock.commandCalls(GetCommand)).toHaveLength(0);
  });
});

describe('out-of-range clamp', () => {
  test('clamps completionPercentage above 100 down to 100', async () => {
    await handler(makeEvent({ completionPercentage: 150 }));

    const values = updateInputs()[0].ExpressionAttributeValues as Record<string, unknown>;
    expect(values[':pct']).toBe(100);
    expect(values[':cp']).toBe('IMPLEMENTATION_COMPLETE');
  });
});

describe('missing progress map initialization', () => {
  test('initializes the map on an existing row, then retries the nested write once', async () => {
    let call = 0;
    ddbMock.on(UpdateCommand).callsFake((input: { UpdateExpression?: string }) => {
      call += 1;
      if (call === 1) {
        // Nested SET under a missing map fails with ValidationException.
        throw namedError('ValidationException', 'The document path provided in the update expression is invalid for update');
      }
      return Promise.resolve({});
    });

    await handler(makeEvent({ completionPercentage: 70 }));

    const updates = updateInputs();
    // nested attempt + init + retried nested + overall recompute
    expect(updates).toHaveLength(4);

    const init = updates[1];
    expect(init.UpdateExpression).toContain('SET #progress = :init');
    // Never create skeleton rows: init only applies to an EXISTING project row.
    expect(init.ConditionExpression).toBe('attribute_exists(id) AND attribute_not_exists(#progress)');
    const initValue = (init.ExpressionAttributeValues as Record<string, unknown>)[':init'] as Record<string, unknown>;
    expect(initValue).toMatchObject({ assessment: 0, design: 0, planning: 0, implementation: 0, overall: 0 });

    const retried = updates[2];
    expect(retried.UpdateExpression).toContain('#progress.#field = :pct');
    expect((retried.ExpressionAttributeValues as Record<string, unknown>)[':pct']).toBe(70);
  });

  test('skips gracefully when the project row does not exist at all', async () => {
    let call = 0;
    ddbMock.on(UpdateCommand).callsFake(() => {
      call += 1;
      if (call === 2) {
        // init refuses to create a skeleton row
        throw namedError('ConditionalCheckFailedException');
      }
      // both nested attempts hit the missing document path
      throw namedError('ValidationException', 'The document path provided in the update expression is invalid for update');
    });

    await expect(handler(makeEvent())).resolves.toBeUndefined();

    expect(ddbMock.commandCalls(UpdateCommand)).toHaveLength(3);
    expect(ddbMock.commandCalls(GetCommand)).toHaveLength(0);
  });
});
