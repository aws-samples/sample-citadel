/**
 * Unit Tests — validatePassword
 *
 * Example-based edge case tests for the validatePassword pure function.
 *
 * **Validates: Requirements 8.1, 8.2, 8.3, 8.4, 8.5, 8.6**
 */

import { validatePassword } from '@/utils/validatePassword';

describe('validatePassword', () => {
  describe('password length validation', () => {
    it('should reject an empty string password', () => {
      expect(validatePassword('', '')).toBe(
        'Password must be at least 8 characters long'
      );
    });

    it('should reject a 7-character password', () => {
      expect(validatePassword('1234567', '1234567')).toBe(
        'Password must be at least 8 characters long'
      );
    });

    it('should accept an 8-character password when confirmPassword matches', () => {
      expect(validatePassword('12345678', '12345678')).toBeNull();
    });
  });

  describe('password match validation', () => {
    it('should reject mismatched passwords when length is valid', () => {
      expect(validatePassword('12345678', 'abcdefgh')).toBe(
        'Passwords do not match'
      );
    });

    it('should accept matched passwords of valid length', () => {
      expect(validatePassword('MySecurePass1', 'MySecurePass1')).toBeNull();
    });
  });

  describe('validation priority', () => {
    it('should check length before checking match', () => {
      // Short AND mismatched — length error takes priority
      expect(validatePassword('short', 'different')).toBe(
        'Password must be at least 8 characters long'
      );
    });
  });
});
