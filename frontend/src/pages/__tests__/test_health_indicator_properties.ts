/**
 * Property test: Health status indicator thresholds (P14)
 *
 * For any error rate (float >= 0), the health indicator returns:
 * - 'green' when error rate < 0.05
 * - 'yellow' when 0.05 <= error rate <= 0.15
 * - 'red' when error rate > 0.15
 *
 * The function is total for all non-negative floats.
 *
 * **Validates: Requirements 7.6**
 */
import * as fc from 'fast-check';

export type HealthStatus = 'green' | 'yellow' | 'red';

/**
 * Pure function: determines health status from error rate.
 * Extracted from AppDetailView for testability.
 */
export function getHealthStatus(errorRate: number): HealthStatus {
  if (errorRate < 0.05) return 'green';
  if (errorRate <= 0.15) return 'yellow';
  return 'red';
}

describe('Feature: app-publishing-gateway, Property 14: Health status indicator thresholds', () => {
  it('returns green for error rates below 5%', () => {
    fc.assert(
      fc.property(
        fc.double({ min: 0, max: 0.0499999, noNaN: true }),
        (errorRate) => {
          expect(getHealthStatus(errorRate)).toBe('green');
        },
      ),
      { numRuns: 200 },
    );
  });

  it('returns yellow for error rates between 5% and 15% inclusive', () => {
    fc.assert(
      fc.property(
        fc.double({ min: 0.05, max: 0.15, noNaN: true }),
        (errorRate) => {
          expect(getHealthStatus(errorRate)).toBe('yellow');
        },
      ),
      { numRuns: 200 },
    );
  });

  it('returns red for error rates above 15%', () => {
    fc.assert(
      fc.property(
        fc.double({ min: 0.1500001, max: 1e6, noNaN: true }),
        (errorRate) => {
          expect(getHealthStatus(errorRate)).toBe('red');
        },
      ),
      { numRuns: 200 },
    );
  });

  it('is total for all non-negative floats', () => {
    fc.assert(
      fc.property(
        fc.double({ min: 0, noNaN: true }),
        (errorRate) => {
          const result = getHealthStatus(errorRate);
          expect(['green', 'yellow', 'red']).toContain(result);
        },
      ),
      { numRuns: 500 },
    );
  });

  // Boundary tests
  it('returns green at exactly 0', () => {
    expect(getHealthStatus(0)).toBe('green');
  });

  it('returns yellow at exactly 0.05', () => {
    expect(getHealthStatus(0.05)).toBe('yellow');
  });

  it('returns yellow at exactly 0.15', () => {
    expect(getHealthStatus(0.15)).toBe('yellow');
  });
});
