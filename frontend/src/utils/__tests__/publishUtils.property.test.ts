/**
 * Property-Based Tests — Publish Utility Functions
 *
 * Tests for maskApiKey and getHealthStatus pure functions
 * used by the publish confirmation screen and API dashboard.
 *
 * Uses fast-check for property-based testing.
 */

import * as fc from 'fast-check';
import { maskApiKey, getHealthStatus } from '../../utils/publishUtils';

// ---- Property 1: API key masking format ----

/**
 * Feature: app-publishing-frontend-gaps, Property 1: API key masking format
 *
 * For any API key prefix string of 8 characters, the maskApiKey function
 * should return a string that starts with exactly those 8 characters
 * followed by 8 asterisk characters, and the total length should be 16.
 *
 * **Validates: Requirements 5.3**
 */
describe('Property 1: API key masking format', () => {
  it('returns prefix followed by 8 asterisks with total length 16', () => {
    fc.assert(
      fc.property(fc.string({ minLength: 8, maxLength: 8 }), (prefix) => {
        const result = maskApiKey(prefix);

        // Total length should be 16
        expect(result.length).toBe(16);

        // Should start with the exact prefix
        expect(result.substring(0, 8)).toBe(prefix);

        // Should end with exactly 8 asterisks
        expect(result.substring(8)).toBe('********');
      }),
      { numRuns: 200 },
    );
  });
});

// ---- Property 3: Health status thresholds ----

/**
 * Feature: app-publishing-frontend-gaps, Property 3: Health status thresholds
 *
 * For any non-negative error rate, getHealthStatus should return 'green'
 * when the rate is below 0.05, 'yellow' when the rate is between 0.05
 * and 0.15 inclusive, and 'red' when the rate is above 0.15. The function
 * should be total (always return one of the three values) for all
 * non-negative floats.
 *
 * **Validates: Requirements 6.8**
 */
describe('Property 3: Health status thresholds', () => {
  it('returns correct status for any non-negative error rate', () => {
    fc.assert(
      fc.property(fc.double({ min: 0, noNaN: true }), (errorRate) => {
        const result = getHealthStatus(errorRate);

        // Function should be total — always return one of the three values
        expect(['green', 'yellow', 'red']).toContain(result);

        // Verify threshold logic
        if (errorRate < 0.05) {
          expect(result).toBe('green');
        } else if (errorRate <= 0.15) {
          expect(result).toBe('yellow');
        } else {
          expect(result).toBe('red');
        }
      }),
      { numRuns: 200 },
    );
  });
});
