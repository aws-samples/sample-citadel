/**
 * Property-Based Tests — validatePassword
 *
 * Tests universal correctness properties of the validatePassword pure function
 * using fast-check to generate arbitrary inputs.
 */

import * as fc from 'fast-check';
import { validatePassword } from '@/utils/validatePassword';

describe('validatePassword — property-based tests', () => {
  // Feature: password-reset-flow, Property 7: Short passwords rejected
  // **Validates: Requirements 8.1, 8.4**
  it('Property 7: all strings shorter than 8 characters are rejected with length error', () => {
    fc.assert(
      fc.property(fc.string({ maxLength: 7 }), (shortPassword) => {
        const result = validatePassword(shortPassword, shortPassword);
        expect(result).toBe('Password must be at least 8 characters long');
      }),
      { numRuns: 100 }
    );
  });

  // Feature: password-reset-flow, Property 8: Mismatched passwords rejected
  // **Validates: Requirements 8.2, 8.5**
  it('Property 8: all mismatched password pairs (length >= 8) are rejected with mismatch error', () => {
    fc.assert(
      fc.property(
        fc.string({ minLength: 8 }),
        fc.string().filter((s) => s.length > 0),
        (password, other) => {
          // Ensure the two strings are actually different
          fc.pre(password !== other);
          const result = validatePassword(password, other);
          expect(result).toBe('Passwords do not match');
        }
      ),
      { numRuns: 100 }
    );
  });

  // Feature: password-reset-flow, Property 9: Valid passwords accepted
  // **Validates: Requirements 8.6**
  it('Property 9: all strings of length >= 8 pass validation when password equals confirmPassword', () => {
    fc.assert(
      fc.property(fc.string({ minLength: 8, maxLength: 100 }), (password) => {
        const result = validatePassword(password, password);
        expect(result).toBeNull();
      }),
      { numRuns: 100 }
    );
  });
});
