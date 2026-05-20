/**
 * Property-based tests for IAM permission validation.
 *
 * Property 8: IAM permission validation
 * **Validates: Requirements 4.1, 4.8**
 */
import * as fc from 'fast-check';
import { validatePermissionActions, aggregatePermissions } from '../app-resolver';

// ── Generators ──────────────────────────────────────────────

/** Valid service name: 1+ alphanumeric or hyphen chars */
const serviceNameArb = fc.stringMatching(/^[a-zA-Z0-9][a-zA-Z0-9-]{0,29}$/);

/** Valid action name: 1+ alphanumeric or * chars */
const actionNameArb = fc.stringMatching(/^[a-zA-Z0-9*]{1,30}$/);

/** A valid IAM action string matching {service}:{action} */
const validIamActionArb = fc
  .tuple(serviceNameArb, actionNameArb)
  .map(([svc, act]) => `${svc}:${act}`);

/** Strings that do NOT contain a colon — guaranteed invalid format (and not bare *) */
const noColonStringArb = fc
  .stringMatching(/^[a-zA-Z0-9-]{1,30}$/)
  .filter((s) => s !== '*');

/** Strings with spaces around the colon — invalid format */
const spacedActionArb = fc
  .tuple(serviceNameArb, actionNameArb)
  .map(([svc, act]) => `${svc}: ${act}`);

/** Strings with leading/trailing spaces — invalid format */
const paddedActionArb = validIamActionArb.map((a) => ` ${a} `);

// ── Property 8 Tests ────────────────────────────────────────

describe('Property 8: IAM permission validation', () => {
  /**
   * **Validates: Requirements 4.8**
   *
   * For any actions array containing only bare wildcard `*`,
   * validatePermissionActions must reject it (valid === false)
   * and include an error mentioning "Bare wildcard".
   */
  it('bare wildcard * is always rejected', () => {
    fc.assert(
      fc.property(
        fc.array(fc.constant('*'), { minLength: 1, maxLength: 5 }),
        (actions) => {
          const result = validatePermissionActions(actions);

          expect(result.valid).toBe(false);
          expect(result.errors.length).toBe(actions.length);
          for (const err of result.errors) {
            expect(err).toContain('Bare wildcard');
          }
        },
      ),
      { numRuns: 100 },
    );
  });

  /**
   * **Validates: Requirements 4.1**
   *
   * For any string matching the pattern {service}:{action} where
   * service is [a-zA-Z0-9-]+ and action is [a-zA-Z0-9*]+,
   * validatePermissionActions must accept it (valid === true, no errors).
   */
  it('service-prefixed actions matching {service}:{action} pattern are accepted', () => {
    fc.assert(
      fc.property(
        fc.array(validIamActionArb, { minLength: 1, maxLength: 10 }),
        (actions) => {
          const result = validatePermissionActions(actions);

          expect(result.valid).toBe(true);
          expect(result.errors).toHaveLength(0);
        },
      ),
      { numRuns: 200 },
    );
  });

  /**
   * **Validates: Requirements 4.1, 4.8**
   *
   * For any string that does not contain a colon (and is not bare *),
   * validatePermissionActions must reject it as invalid format.
   */
  it('strings without a colon are rejected as invalid format', () => {
    fc.assert(
      fc.property(
        fc.array(noColonStringArb, { minLength: 1, maxLength: 5 }),
        (actions) => {
          const result = validatePermissionActions(actions);

          expect(result.valid).toBe(false);
          expect(result.errors.length).toBe(actions.length);
          for (const err of result.errors) {
            expect(err).toContain('Invalid IAM action format');
          }
        },
      ),
      { numRuns: 200 },
    );
  });

  /**
   * **Validates: Requirements 4.1**
   *
   * For any action string with spaces (e.g., "s3: GetObject"),
   * validatePermissionActions must reject it.
   */
  it('actions with spaces are rejected', () => {
    fc.assert(
      fc.property(spacedActionArb, (action) => {
        const result = validatePermissionActions([action]);

        expect(result.valid).toBe(false);
        expect(result.errors.length).toBe(1);
        expect(result.errors[0]).toContain('Invalid IAM action format');
      }),
      { numRuns: 100 },
    );
  });

  /**
   * **Validates: Requirements 4.1**
   *
   * For any action string with leading/trailing whitespace,
   * validatePermissionActions must reject it.
   */
  it('actions with leading/trailing whitespace are rejected', () => {
    fc.assert(
      fc.property(paddedActionArb, (action) => {
        const result = validatePermissionActions([action]);

        expect(result.valid).toBe(false);
        expect(result.errors.length).toBe(1);
        expect(result.errors[0]).toContain('Invalid IAM action format');
      }),
      { numRuns: 100 },
    );
  });

  /**
   * **Validates: Requirements 4.1, 4.8**
   *
   * For any mixed array of valid and invalid actions,
   * the result is invalid iff at least one action is invalid,
   * and the number of errors equals the number of invalid actions.
   */
  it('mixed valid and invalid actions: valid iff all actions are valid', () => {
    const mixedActionsArb = fc.array(
      fc.oneof(
        validIamActionArb.map((a) => ({ action: a, shouldBeValid: true })),
        fc.constant({ action: '*', shouldBeValid: false }),
        noColonStringArb.map((a) => ({ action: a, shouldBeValid: false })),
      ),
      { minLength: 1, maxLength: 10 },
    );

    fc.assert(
      fc.property(mixedActionsArb, (items) => {
        const actions = items.map((i) => i.action);
        const expectedInvalidCount = items.filter((i) => !i.shouldBeValid).length;

        const result = validatePermissionActions(actions);

        if (expectedInvalidCount === 0) {
          expect(result.valid).toBe(true);
          expect(result.errors).toHaveLength(0);
        } else {
          expect(result.valid).toBe(false);
          expect(result.errors.length).toBe(expectedInvalidCount);
        }
      }),
      { numRuns: 200 },
    );
  });

  /**
   * **Validates: Requirements 4.1**
   *
   * An empty actions array is trivially valid (no actions to reject).
   */
  it('empty actions array is valid', () => {
    const result = validatePermissionActions([]);
    expect(result.valid).toBe(true);
    expect(result.errors).toHaveLength(0);
  });
});

// ── Property 9 Generators ───────────────────────────────────

/** A single permission item with random actions and resources arrays */
const permissionItemArb = fc.record({
  permissionId: fc.stringMatching(/^[a-z0-9]{4,12}$/),
  actions: fc.array(validIamActionArb, { minLength: 0, maxLength: 5 }),
  resources: fc.array(
    fc.stringMatching(/^arn:aws:[a-z0-9-]+:\*:\*:[a-z0-9/*-]{1,30}$/).map(
      (s) => s,
    ),
    { minLength: 0, maxLength: 5 },
  ),
  description: fc.option(fc.string({ minLength: 1, maxLength: 50 }), { nil: undefined }),
});

// ── Property 9 Tests ────────────────────────────────────────

describe('Property 9: Permission aggregation as set union', () => {
  /**
   * **Validates: Requirements 4.2**
   *
   * For any set of permission items, the aggregated actions
   * should equal the deduplicated union of all individual items' actions.
   */
  it('aggregated actions equal the set union of all permission items actions', () => {
    fc.assert(
      fc.property(
        fc.array(permissionItemArb, { minLength: 0, maxLength: 10 }),
        (permissionItems) => {
          const result = aggregatePermissions(permissionItems);

          const expectedActions = [
            ...new Set(permissionItems.flatMap((p) => p.actions)),
          ];

          expect(new Set(result.actions)).toEqual(new Set(expectedActions));
          // No duplicates in result
          expect(result.actions.length).toBe(new Set(result.actions).size);
        },
      ),
      { numRuns: 200 },
    );
  });

  /**
   * **Validates: Requirements 4.2**
   *
   * For any set of permission items, the aggregated resources
   * should equal the deduplicated union of all individual items' resources.
   */
  it('aggregated resources equal the set union of all permission items resources', () => {
    fc.assert(
      fc.property(
        fc.array(permissionItemArb, { minLength: 0, maxLength: 10 }),
        (permissionItems) => {
          const result = aggregatePermissions(permissionItems);

          const expectedResources = [
            ...new Set(permissionItems.flatMap((p) => p.resources)),
          ];

          expect(new Set(result.resources)).toEqual(new Set(expectedResources));
          // No duplicates in result
          expect(result.resources.length).toBe(new Set(result.resources).size);
        },
      ),
      { numRuns: 200 },
    );
  });

  /**
   * **Validates: Requirements 4.2**
   *
   * For any set of permission items with overlapping actions/resources,
   * the aggregated result should contain each unique value exactly once.
   */
  it('duplicate actions and resources across items are deduplicated', () => {
    const sharedAction = 's3:GetObject';
    const sharedResource = 'arn:aws:s3:::my-bucket/*';

    const overlappingItemsArb = fc
      .array(permissionItemArb, { minLength: 2, maxLength: 6 })
      .map((items) =>
        items.map((item) => ({
          ...item,
          actions: [sharedAction, ...item.actions],
          resources: [sharedResource, ...item.resources],
        })),
      );

    fc.assert(
      fc.property(overlappingItemsArb, (permissionItems) => {
        const result = aggregatePermissions(permissionItems);

        // Shared values appear exactly once
        expect(result.actions.filter((a: string) => a === sharedAction).length).toBe(1);
        expect(
          result.resources.filter((r: string) => r === sharedResource).length,
        ).toBe(1);
      }),
      { numRuns: 100 },
    );
  });

  /**
   * **Validates: Requirements 4.2**
   *
   * An empty array of permission items produces empty actions and resources.
   */
  it('empty permission items produce empty aggregation', () => {
    const result = aggregatePermissions([]);
    expect(result.actions).toEqual([]);
    expect(result.resources).toEqual([]);
  });
});
