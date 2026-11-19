/**
 * Canonical classification of secret-like field keys.
 *
 * Mirror of backend/src/utils/secret-field-keys.ts — both copies MUST stay
 * in sync. A parity guard test asserts they are identical.
 */

/** Keys whose values are secrets (passwords, tokens, connection strings). */
export const SECRET_FIELD_KEYS = new Set([
  "masterPassword",
  "password",
  "apiKey",
  "connectionString",
  "token",
  "secretAccessKey",
  "sessionToken",
]);

/** Keys that are credential-adjacent (usernames) — not secrets, but co-located. */
export const CREDENTIAL_ADJACENT_KEYS = new Set([
  "masterUsername",
  "username",
]);

/** Combined: all keys routed to the credentials bag. */
export const CREDENTIAL_KEYS = new Set([
  ...SECRET_FIELD_KEYS,
  ...CREDENTIAL_ADJACENT_KEYS,
]);
