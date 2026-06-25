/**
 * Property-based tests for fabrication registration idempotence.
 *
 * Property 12: Fabrication registration idempotence
 * **Validates: Requirements 6.4, 6.6**
 *
 * For any fabrication event with an appId, processing the event N times (N >= 1)
 * should produce exactly one App_Component item with status = DESIGN — no duplicates.
 * The first call issues a PutCommand that succeeds; subsequent calls trigger
 * ConditionalCheckFailedException which is silently caught.
 */
import * as fc from 'fast-check';
import { DynamoDBDocumentClient, PutCommand } from '@aws-sdk/lib-dynamodb';
import { mockClient } from 'aws-sdk-client-mock';

const ddbMock = mockClient(DynamoDBDocumentClient);

import { handler } from '../app-component-registration-handler';

// ── Generators ──────────────────────────────────────────────

const appIdArb = fc.string({ minLength: 1, maxLength: 36 })
  .filter(s => /^[a-zA-Z0-9_-]+$/.test(s));

const agentIdArb = fc.string({ minLength: 1, maxLength: 36 })
  .filter(s => /^[a-zA-Z0-9_-]+$/.test(s));

/** N repetitions: 1..5 */
const repeatCountArb = fc.integer({ min: 1, max: 5 });

/** Component type: agent or tool */
const componentTypeArb = fc.constantFrom('agent' as const, 'tool' as const);

// ── Helpers ─────────────────────────────────────────────────

function makeEventBridgeEvent(
  detailType: string,
  detail: Record<string, any>,
) {
  return {
    version: '0',
    id: 'test-event-id',
    source: 'citadel.fabricator',
    account: '123456789012',
    time: '2024-01-01T00:00:00Z',
    region: 'us-east-1',
    'detail-type': detailType,
    detail,
  } as any;
}

function buildEvent(
  componentType: 'agent' | 'tool',
  componentId: string,
  appId: string,
) {
  const detailType = componentType === 'agent' ? 'agent.fabricated' : 'tool.fabricated';
  const idField = componentType === 'agent' ? 'agentId' : 'toolId';
  return makeEventBridgeEvent(detailType, {
    [idField]: componentId,
    appId,
    orchestrationId: 'orch-test',
  });
}

/**
 * Configure mock so the first PutCommand succeeds and all subsequent ones
 * throw ConditionalCheckFailedException (simulating the idempotency guard).
 */
function setupIdempotentMock() {
  let callCount = 0;
  ddbMock.on(PutCommand).callsFake(() => {
    callCount++;
    if (callCount === 1) {
      return {}; // first call succeeds
    }
    const err = new Error('The conditional request failed');
    err.name = 'ConditionalCheckFailedException';
    throw err;
  });
}

// ── Property 12: Fabrication registration idempotence ───────

describe('Property 12: Fabrication registration idempotence', () => {
  beforeAll(() => {
    process.env.APPS_TABLE = 'citadel-apps-test';
  });

  beforeEach(() => {
    ddbMock.reset();
  });

  afterAll(() => {
    delete process.env.APPS_TABLE;
  });

  /**
   * **Validates: Requirements 6.4, 6.6**
   *
   * For any fabrication event with appId, processing it N times (N >= 1)
   * should result in exactly one successful PutCommand (the first call).
   * Subsequent calls silently catch ConditionalCheckFailedException.
   */
  it('processing same event N times produces exactly one successful put', () => {
    return fc.assert(
      fc.asyncProperty(
        componentTypeArb,
        appIdArb,
        agentIdArb,
        repeatCountArb,
        async (componentType, appId, componentId, n) => {
          ddbMock.reset();
          setupIdempotentMock();

          const event = buildEvent(componentType, componentId, appId);

          // Process the same event N times — none should throw
          for (let i = 0; i < n; i++) {
            await handler(event);
          }

          // Exactly N PutCommand calls were made (one per invocation)
          const putCalls = ddbMock.commandCalls(PutCommand);
          expect(putCalls).toHaveLength(n);

          // The first call is the one that actually creates the item.
          // All calls target the same item with the same idempotency guard.
          const firstInput = putCalls[0].args[0].input;
          const prefix = componentType === 'agent' ? 'AGENT' : 'TOOL';
          expect(firstInput.Item).toEqual(
            expect.objectContaining({
              appId: `${appId}#${prefix}#${componentId}`,
              groupId: `APP#${appId}`,
              sortId: `${prefix}#${componentId}`,
              status: 'DESIGN',
            }),
          );
          expect(firstInput.ConditionExpression).toBe('attribute_not_exists(groupId)');
        },
      ),
      { numRuns: 50 },
    );
  });

  /**
   * **Validates: Requirements 6.4, 6.6**
   *
   * For any fabrication event processed exactly once, the handler issues
   * exactly one PutCommand that succeeds (no ConditionalCheckFailedException).
   */
  it('single invocation creates exactly one component item', () => {
    return fc.assert(
      fc.asyncProperty(
        componentTypeArb,
        appIdArb,
        agentIdArb,
        async (componentType, appId, componentId) => {
          ddbMock.reset();
          ddbMock.on(PutCommand).resolves({});

          const event = buildEvent(componentType, componentId, appId);
          await handler(event);

          const putCalls = ddbMock.commandCalls(PutCommand);
          expect(putCalls).toHaveLength(1);

          const input = putCalls[0].args[0].input;
          const prefix = componentType === 'agent' ? 'AGENT' : 'TOOL';
          const idField = componentType === 'agent' ? 'agentId' : 'toolId';

          expect(input.Item).toEqual(
            expect.objectContaining({
              appId: `${appId}#${prefix}#${componentId}`,
              groupId: `APP#${appId}`,
              sortId: `${prefix}#${componentId}`,
              [idField]: componentId,
              status: 'DESIGN',
            }),
          );
          expect(input.Item!.addedAt).toBeDefined();
          expect(input.ConditionExpression).toBe('attribute_not_exists(groupId)');
        },
      ),
      { numRuns: 50 },
    );
  });

  /**
   * **Validates: Requirements 6.4, 6.6**
   *
   * For any fabrication event processed N > 1 times, the handler never throws —
   * ConditionalCheckFailedException on subsequent calls is silently caught,
   * ensuring idempotent behavior.
   */
  it('duplicate invocations do not throw errors', () => {
    return fc.assert(
      fc.asyncProperty(
        componentTypeArb,
        appIdArb,
        agentIdArb,
        fc.integer({ min: 2, max: 5 }),
        async (componentType, appId, componentId, n) => {
          ddbMock.reset();
          setupIdempotentMock();

          const event = buildEvent(componentType, componentId, appId);

          // All N invocations should resolve without throwing
          const results = await Promise.allSettled(
            Array.from({ length: n }, () => handler(event)),
          );

          for (const result of results) {
            expect(result.status).toBe('fulfilled');
          }
        },
      ),
      { numRuns: 50 },
    );
  });
});
