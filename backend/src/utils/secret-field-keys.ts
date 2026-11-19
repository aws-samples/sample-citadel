/**
 * Canonical classification of secret-like field keys.
 *
 * Any field whose key appears in SECRET_FIELD_KEYS carries a credential or
 * token and MUST travel in the `credentials` bag, never in `config`.
 *
 * CREDENTIAL_ADJACENT_KEYS are not secrets themselves (usernames) but should
 * travel alongside their secret counterpart for co-location.
 *
 * CREDENTIAL_KEYS = SECRET_FIELD_KEYS ∪ CREDENTIAL_ADJACENT_KEYS — the full
 * set of keys routed into the credentials bag by the frontend wizard.
 *
 * IMPORTANT: this list is mirrored in frontend/src/utils/secret-field-keys.ts.
 * A parity guard test asserts both copies are identical.
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
export const CREDENTIAL_ADJACENT_KEYS = new Set(["masterUsername", "username"]);

/** Combined: all keys routed to the credentials bag. */
export const CREDENTIAL_KEYS = new Set([
  ...SECRET_FIELD_KEYS,
  ...CREDENTIAL_ADJACENT_KEYS,
]);
