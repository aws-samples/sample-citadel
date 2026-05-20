/**
 * Property test: Precondition checklist enables publish button (P9)
 *
 * For any list of preconditions, "Confirm Publish" is enabled iff every
 * precondition has `passed === true`. Any `passed === false` disables the button.
 *
 * **Validates: Requirements 4.4**
 */
import * as fc from 'fast-check';

interface Precondition {
  label: string;
  passed: boolean;
  detail?: string;
}

/**
 * Pure function: determines whether the Confirm Publish button should be enabled.
 * Extracted from AppDetailView for testability.
 */
export function shouldEnablePublish(preconditions: Precondition[]): boolean {
  return preconditions.length > 0 && preconditions.every((p) => p.passed);
}

const preconditionArb = fc.record({
  label: fc.string({ minLength: 1, maxLength: 50 }),
  passed: fc.boolean(),
  detail: fc.option(fc.string({ maxLength: 100 }), { nil: undefined }),
});

describe('Feature: app-publishing-gateway, Property 9: Precondition checklist enables publish button', () => {
  it('enables publish iff every precondition has passed === true', () => {
    fc.assert(
      fc.property(
        fc.array(preconditionArb, { minLength: 1, maxLength: 20 }),
        (preconditions) => {
          const allPassed = preconditions.every((p) => p.passed);
          const result = shouldEnablePublish(preconditions);
          expect(result).toBe(allPassed);
        },
      ),
      { numRuns: 200 },
    );
  });

  it('disables publish when any single precondition fails', () => {
    fc.assert(
      fc.property(
        fc.array(preconditionArb, { minLength: 0, maxLength: 10 }),
        fc.record({
          label: fc.string({ minLength: 1, maxLength: 50 }),
          passed: fc.constant(false as boolean),
          detail: fc.option(fc.string({ maxLength: 100 }), { nil: undefined }),
        }),
        fc.array(preconditionArb, { minLength: 0, maxLength: 10 }),
        (before, failing, after) => {
          const preconditions = [...before, failing, ...after];
          expect(shouldEnablePublish(preconditions)).toBe(false);
        },
      ),
      { numRuns: 200 },
    );
  });

  it('disables publish for empty precondition list', () => {
    expect(shouldEnablePublish([])).toBe(false);
  });
});
