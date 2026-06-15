/**
 * Property-based tests for status transition event structure (Property 3)
 *
 * **Validates: Requirements 1.8, 5.9, 8.6**
 *
 * For any valid app status transition (APPROVED→PUBLISHED, PUBLISHED→DRAFT),
 * the constructed EventBridge event should have:
 * (a) the correct detail type (`app.status.{from}_to_{to}` in lowercase),
 * (b) source `citadel.apps`,
 * (c) all required fields present: appId, orgId, userId, timestamp (ISO 8601), correlationId.
 * For APPROVED→PUBLISHED, the event should additionally contain endpointUrl and apiKeyId.
 */
import * as fc from 'fast-check';
import { buildStatusTransitionEvent } from '../app-publish-handler';

// ── Generators ──────────────────────────────────────────────

/** Valid appId: alphanumeric + hyphens/underscores */
const appIdArb = fc.string({ minLength: 1, maxLength: 30 })
  .filter(s => /^[a-zA-Z0-9_-]+$/.test(s));

/** Valid org ID */
const orgIdArb = fc.string({ minLength: 1, maxLength: 30 })
  .filter(s => /^[a-zA-Z0-9_-]+$/.test(s));

/** Valid user ID */
const userIdArb = fc.string({ minLength: 1, maxLength: 30 })
  .filter(s => /^[a-zA-Z0-9_-]+$/.test(s));

/** Valid ISO 8601 timestamp — use integer millis to avoid invalid Date values */
const timestampArb = fc.integer({
  min: new Date('2020-01-01T00:00:00Z').getTime(),
  max: new Date('2030-12-31T23:59:59Z').getTime(),
}).map(ms => new Date(ms).toISOString());

/** Valid correlation ID (UUID-like) */
const correlationIdArb = fc.uuid();

/** Valid endpoint URL */
const endpointUrlArb = fc.string({ minLength: 1, maxLength: 20 })
  .filter(s => /^[a-zA-Z0-9]+$/.test(s))
  .map(id => `https://${id}.execute-api.us-east-1.amazonaws.com`);

/** Valid API key ID */
const apiKeyIdArb = fc.uuid();

/** Base detail fields required for all transitions */
const baseDetailArb = fc.record({
  appId: appIdArb,
  orgId: orgIdArb,
  userId: userIdArb,
  timestamp: timestampArb,
  correlationId: correlationIdArb,
});

/** Detail fields for APPROVED→PUBLISHED (includes endpointUrl and apiKeyId) */
const publishDetailArb = fc.record({
  appId: appIdArb,
  orgId: orgIdArb,
  userId: userIdArb,
  timestamp: timestampArb,
  correlationId: correlationIdArb,
  endpointUrl: endpointUrlArb,
  apiKeyId: apiKeyIdArb,
});

// ── Valid transitions ───────────────────────────────────────

type Transition = { from: string; to: string };

const APPROVED_TO_PUBLISHED: Transition = { from: 'APPROVED', to: 'PUBLISHED' };
const PUBLISHED_TO_DRAFT: Transition = { from: 'PUBLISHED', to: 'DRAFT' };

/** Arbitrary that picks a valid transition with matching detail */
const transitionWithDetailArb = fc.oneof(
  publishDetailArb.map(detail => ({
    transition: APPROVED_TO_PUBLISHED,
    detail,
  })),
  baseDetailArb.map(detail => ({
    transition: PUBLISHED_TO_DRAFT,
    detail,
  })),
);

// ── Property 3 Tests ────────────────────────────────────────

describe('Property 3: Status transition event structure', () => {

  /**
   * **Validates: Requirements 1.8, 5.9, 8.6**
   *
   * For any valid status transition, the detail type follows the pattern
   * `app.status.{from}_to_{to}` with both statuses lowercased.
   */
  it('detail type follows app.status.{from}_to_{to} pattern in lowercase', () => {
    fc.assert(
      fc.property(
        transitionWithDetailArb,
        ({ transition, detail }) => {
          const event = buildStatusTransitionEvent(transition.from, transition.to, detail);

          const expectedDetailType = `app.status.${transition.from.toLowerCase()}_to_${transition.to.toLowerCase()}`;
          expect(event.detailType).toBe(expectedDetailType);
        },
      ),
      { numRuns: 200 },
    );
  });

  /**
   * **Validates: Requirements 1.8, 8.6**
   *
   * For any valid status transition, the source is always `citadel.apps`.
   */
  it('source is always citadel.apps for any valid transition', () => {
    fc.assert(
      fc.property(
        transitionWithDetailArb,
        ({ transition, detail }) => {
          const event = buildStatusTransitionEvent(transition.from, transition.to, detail);

          expect(event.source).toBe('citadel.apps');
        },
      ),
      { numRuns: 200 },
    );
  });

  /**
   * **Validates: Requirements 1.8, 5.9, 8.6**
   *
   * For any valid status transition, the event detail contains all required
   * fields: appId, orgId, userId, timestamp (valid ISO 8601), correlationId.
   */
  it('event detail contains all required fields for any valid transition', () => {
    fc.assert(
      fc.property(
        transitionWithDetailArb,
        ({ transition, detail }) => {
          const event = buildStatusTransitionEvent(transition.from, transition.to, detail);

          // All required fields present
          expect(event.detail.appId).toBe(detail.appId);
          expect(event.detail.orgId).toBe(detail.orgId);
          expect(event.detail.userId).toBe(detail.userId);
          expect(event.detail.correlationId).toBe(detail.correlationId);

          // Timestamp is a valid ISO 8601 string
          expect(event.detail.timestamp).toBeDefined();
          const parsed = new Date(event.detail.timestamp);
          expect(parsed.toISOString()).toBe(event.detail.timestamp);
        },
      ),
      { numRuns: 200 },
    );
  });

  /**
   * **Validates: Requirements 1.8**
   *
   * For APPROVED→PUBLISHED transitions, the event detail additionally contains
   * endpointUrl and apiKeyId fields.
   */
  it('APPROVED→PUBLISHED event additionally contains endpointUrl and apiKeyId', () => {
    fc.assert(
      fc.property(
        publishDetailArb,
        (detail) => {
          const event = buildStatusTransitionEvent('APPROVED', 'PUBLISHED', detail);

          expect(event.detail.endpointUrl).toBe(detail.endpointUrl);
          expect(event.detail.apiKeyId).toBe(detail.apiKeyId);
        },
      ),
      { numRuns: 200 },
    );
  });

  /**
   * **Validates: Requirements 8.6**
   *
   * For PUBLISHED→DRAFT transitions, the event detail does NOT contain
   * endpointUrl or apiKeyId (they are not passed in the detail).
   */
  it('PUBLISHED→DRAFT event does not contain endpointUrl or apiKeyId', () => {
    fc.assert(
      fc.property(
        baseDetailArb,
        (detail) => {
          const event = buildStatusTransitionEvent('PUBLISHED', 'DRAFT', detail);

          expect(event.detail.endpointUrl).toBeUndefined();
          expect(event.detail.apiKeyId).toBeUndefined();
        },
      ),
      { numRuns: 200 },
    );
  });
});


// ── Property 6 Imports ──────────────────────────────────────

import { buildInvokeEventDetail } from '../utils/invoke-event-builder';

// ── Property 6 Generators ───────────────────────────────────

/** Arbitrary JSON object for request body */
const jsonValueArb: fc.Arbitrary<any> = fc.letrec(tie => ({
  value: fc.oneof(
    fc.string(),
    fc.integer(),
    fc.double({ noNaN: true, noDefaultInfinity: true }),
    fc.boolean(),
    fc.constant(null),
    fc.array(tie('value'), { maxLength: 3 }),
    fc.dictionary(fc.string({ minLength: 1, maxLength: 10 }).filter(s => /^[a-zA-Z_]/.test(s)), tie('value'), { maxKeys: 5 }),
  ),
})).value;

const requestBodyArb = fc.dictionary(
  fc.string({ minLength: 1, maxLength: 20 }).filter(s => /^[a-zA-Z_][a-zA-Z0-9_]*$/.test(s)),
  jsonValueArb,
  { minKeys: 0, maxKeys: 10 },
);

/** App context generator */
const appContextArb = fc.record({
  appId: appIdArb,
  appName: fc.string({ minLength: 1, maxLength: 50 }).filter(s => /^[a-zA-Z0-9 _-]+$/.test(s)),
  groupId: appIdArb.map(id => `APP#${id}`),
});

// ── Property 6 Tests ────────────────────────────────────────

describe('Property 6: Invoke event detail construction', () => {

  /**
   * **Validates: Requirements 2.3, 2.5**
   *
   * For any request body, app context, and API key ID, the event detail
   * contains the original request body unchanged.
   */
  it('event detail contains the original request body', () => {
    fc.assert(
      fc.property(
        requestBodyArb,
        appContextArb,
        apiKeyIdArb,
        (body, appContext, apiKeyId) => {
          const detail = buildInvokeEventDetail(body, appContext, apiKeyId);

          expect(detail.body).toEqual(body);
        },
      ),
      { numRuns: 200 },
    );
  });

  /**
   * **Validates: Requirements 2.3, 2.5**
   *
   * For any app context, the x-citadel-group-id header equals APP#{appId}.
   */
  it('x-citadel-group-id header equals APP#{appId}', () => {
    fc.assert(
      fc.property(
        requestBodyArb,
        appContextArb,
        apiKeyIdArb,
        (body, appContext, apiKeyId) => {
          const detail = buildInvokeEventDetail(body, appContext, apiKeyId);

          expect(detail.headers['x-citadel-group-id']).toBe(`APP#${appContext.appId}`);
        },
      ),
      { numRuns: 200 },
    );
  });

  /**
   * **Validates: Requirements 2.3, 2.5**
   *
   * For any app context, the x-citadel-app-name header equals the app name.
   */
  it('x-citadel-app-name header equals appName from context', () => {
    fc.assert(
      fc.property(
        requestBodyArb,
        appContextArb,
        apiKeyIdArb,
        (body, appContext, apiKeyId) => {
          const detail = buildInvokeEventDetail(body, appContext, apiKeyId);

          expect(detail.headers['x-citadel-app-name']).toBe(appContext.appName);
        },
      ),
      { numRuns: 200 },
    );
  });

  /**
   * **Validates: Requirements 2.3, 2.5**
   *
   * For any API key ID, the x-citadel-api-key-id header equals the provided key ID.
   */
  it('x-citadel-api-key-id header equals the provided apiKeyId', () => {
    fc.assert(
      fc.property(
        requestBodyArb,
        appContextArb,
        apiKeyIdArb,
        (body, appContext, apiKeyId) => {
          const detail = buildInvokeEventDetail(body, appContext, apiKeyId);

          expect(detail.headers['x-citadel-api-key-id']).toBe(apiKeyId);
        },
      ),
      { numRuns: 200 },
    );
  });

  /**
   * **Validates: Requirements 2.3, 2.5**
   *
   * For any inputs, the x-citadel-timestamp header is a valid ISO 8601 string.
   */
  it('x-citadel-timestamp header is a valid ISO 8601 string', () => {
    fc.assert(
      fc.property(
        requestBodyArb,
        appContextArb,
        apiKeyIdArb,
        (body, appContext, apiKeyId) => {
          const detail = buildInvokeEventDetail(body, appContext, apiKeyId);

          const ts = detail.headers['x-citadel-timestamp'];
          expect(ts).toBeDefined();
          expect(typeof ts).toBe('string');
          // Validate ISO 8601 by round-tripping through Date
          const parsed = new Date(ts);
          expect(isNaN(parsed.getTime())).toBe(false);
          expect(parsed.toISOString()).toBe(ts);
        },
      ),
      { numRuns: 200 },
    );
  });

  /**
   * **Validates: Requirements 2.5**
   *
   * For any inputs, the event detail contains a unique requestId (non-empty string).
   */
  it('event detail contains a non-empty requestId', () => {
    fc.assert(
      fc.property(
        requestBodyArb,
        appContextArb,
        apiKeyIdArb,
        (body, appContext, apiKeyId) => {
          const detail = buildInvokeEventDetail(body, appContext, apiKeyId);

          expect(detail.requestId).toBeDefined();
          expect(typeof detail.requestId).toBe('string');
          expect(detail.requestId.length).toBeGreaterThan(0);
        },
      ),
      { numRuns: 200 },
    );
  });

  /**
   * **Validates: Requirements 2.5**
   *
   * Two invocations with the same inputs produce different requestIds (uniqueness).
   */
  it('two invocations produce different requestIds', () => {
    fc.assert(
      fc.property(
        requestBodyArb,
        appContextArb,
        apiKeyIdArb,
        (body, appContext, apiKeyId) => {
          const detail1 = buildInvokeEventDetail(body, appContext, apiKeyId);
          const detail2 = buildInvokeEventDetail(body, appContext, apiKeyId);

          expect(detail1.requestId).not.toBe(detail2.requestId);
        },
      ),
      { numRuns: 200 },
    );
  });

  /**
   * **Validates: Requirements 2.3, 2.5**
   *
   * For any inputs, all four required injected headers are present in the detail.
   */
  it('all four injected headers are present', () => {
    fc.assert(
      fc.property(
        requestBodyArb,
        appContextArb,
        apiKeyIdArb,
        (body, appContext, apiKeyId) => {
          const detail = buildInvokeEventDetail(body, appContext, apiKeyId);

          const requiredHeaders = [
            'x-citadel-group-id',
            'x-citadel-app-name',
            'x-citadel-api-key-id',
            'x-citadel-timestamp',
          ];
          for (const header of requiredHeaders) {
            expect(detail.headers).toHaveProperty(header);
          }
        },
      ),
      { numRuns: 200 },
    );
  });
});
