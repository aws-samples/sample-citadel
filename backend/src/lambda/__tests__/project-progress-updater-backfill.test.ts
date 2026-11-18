/**
 * project-progress-updater must set earlier phases to 100 when an event
 * for a later phase arrives. E.g. a design event at 50% should force
 * assessment to 100 if it isn't already, so the frontend phase bars
 * render earlier phases as complete (green, no pulse).
 *
 * Phase ordering: assessment < design < planning < implementation.
 */

process.env.PROJECTS_TABLE = 'citadel-projects-test';
process.env.IDEMPOTENCY_TABLE = 'citadel-idempotency-test';

import { DynamoDBDocumentClient, UpdateCommand, GetCommand } from '@aws-sdk/lib-dynamodb';
import { mockClient } from 'aws-sdk-client-mock';

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
    Item: {
      id: 'sess-1',
      progress: {
        assessment: 93, // stuck at 93 from LLM estimate
        design: 100,
        planning: 100,
        implementation: 42,
        overall: 75,
        currentPhase: 'IMPLEMENTATION_IN_PROGRESS',
      },
    },
  });
});

describe('earlier-phase backfill', () => {
  it('sets assessment to 100 when an implementation event arrives and assessment < 100', async () => {
    await handler(makeEvent({ phase: 'implementation', completionPercentage: 50 }));

    const updates = updateInputs();
    // Expect: (1) the implementation write, (2) backfill assessment=100,
    // (3) overall recompute. The backfill is the key new behavior.
    const backfillUpdates = updates.filter((u) => {
      const names = u.ExpressionAttributeNames as Record<string, string>;
      const vals = u.ExpressionAttributeValues as Record<string, unknown>;
      return names?.['#field'] === 'assessment' && vals?.[':pct'] === 100;
    });
    expect(backfillUpdates.length).toBeGreaterThanOrEqual(1);
  });

  it('sets design to 100 when a planning event arrives and design < 100', async () => {
    ddbMock.on(GetCommand).resolves({
      Item: {
        id: 'sess-1',
        progress: {
          assessment: 100,
          design: 80, // not yet 100
          planning: 30,
          implementation: 0,
          overall: 50,
          currentPhase: 'PLANNING_IN_PROGRESS',
        },
      },
    });

    await handler(makeEvent({ phase: 'planning', completionPercentage: 30 }));

    const updates = updateInputs();
    const backfillUpdates = updates.filter((u) => {
      const names = u.ExpressionAttributeNames as Record<string, string>;
      const vals = u.ExpressionAttributeValues as Record<string, unknown>;
      return names?.['#field'] === 'design' && vals?.[':pct'] === 100;
    });
    expect(backfillUpdates.length).toBeGreaterThanOrEqual(1);
  });

  it('does NOT backfill phases that are already at 100', async () => {
    ddbMock.on(GetCommand).resolves({
      Item: {
        id: 'sess-1',
        progress: {
          assessment: 100,
          design: 100,
          planning: 100,
          implementation: 50,
          overall: 87,
          currentPhase: 'IMPLEMENTATION_IN_PROGRESS',
        },
      },
    });

    await handler(makeEvent({ phase: 'implementation', completionPercentage: 50 }));

    const updates = updateInputs();
    // No backfill update should exist for any earlier phase since they're all 100.
    const backfillUpdates = updates.filter((u) => {
      const names = u.ExpressionAttributeNames as Record<string, string>;
      return names?.['#field'] === 'assessment' || names?.['#field'] === 'design' || names?.['#field'] === 'planning';
    });
    expect(backfillUpdates).toHaveLength(0);
  });

  it('never lowers a phase value (monotonic guarantee)', async () => {
    // Backfill should only SET to 100 via the same monotonic condition.
    await handler(makeEvent({ phase: 'implementation', completionPercentage: 50 }));

    const updates = updateInputs();
    const backfillUpdates = updates.filter((u) => {
      const names = u.ExpressionAttributeNames as Record<string, string>;
      return names?.['#field'] === 'assessment';
    });
    for (const u of backfillUpdates) {
      expect(u.ConditionExpression).toContain('#progress.#field < :pct');
    }
  });
});
