/**
 * Pure password validation function.
 *
 * Validates password length (minimum 8 characters) and confirms
 * password and confirmPassword match.
 *
 * @param password - The password to validate
 * @param confirmPassword - The confirmation password to match against
 * @returns Error message string if validation fails, null if validation passes
 */
export function validatePassword(
  password: string,
  confirmPassword: string
): string | null {
  if (password.length < 8) {
    return 'Password must be at least 8 characters long';
  }
  if (password !== confirmPassword) {
    return 'Passwords do not match';
  }
  return null;
}
