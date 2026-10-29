/**
 * Shared helper for normalising and validating document keys against a
 * project prefix.  Both document-upload-resolver (uploads, deletes, status)
 * and document-resolver (reads, versions, PDF gen) MUST route every
 * client-supplied documentKey through this function before it touches S3 or
 * DynamoDB.
 *
 * Accepts either:
 *   • a full key already prefixed with `${projectId}/…` (idempotent), or
 *   • a bare suffix (basename / sub-path) which is prefixed automatically.
 *
 * Rejects anything that would normalise outside the project's own prefix:
 *   path traversal (`..`), double slashes, leading slashes, URL-encoded
 *   tricks, control characters, or an empty key.
 */

/** Characters that must never appear in a document key (C0/C1 control block). */
// eslint-disable-next-line no-control-regex
const CONTROL_CHAR_RE = /[\x00-\x1f\x7f-\x9f]/;

export class DocumentKeyError extends Error {
  constructor(message: string) {
    super(message);
    this.name = "DocumentKeyError";
  }
}

/**
 * Resolve a client-supplied document key into the canonical
 * `${projectId}/<suffix>` form, or throw `DocumentKeyError` if the key is
 * invalid or escapes the project prefix.
 */
export function resolveProjectDocumentKey(
  projectId: string,
  documentKey: string,
): string {
  if (!projectId || !documentKey) {
    throw new DocumentKeyError("projectId and documentKey must be non-empty");
  }

  // Decode percent-encoded characters so traversal tricks like `%2e%2e` are
  // caught by the literal checks below.
  let decoded: string;
  try {
    decoded = decodeURIComponent(documentKey);
  } catch {
    throw new DocumentKeyError("documentKey contains invalid percent-encoding");
  }

  // Reject control characters.
  if (CONTROL_CHAR_RE.test(decoded)) {
    throw new DocumentKeyError("documentKey contains control characters");
  }

  // Reject path traversal segments.
  if (decoded.includes("..")) {
    throw new DocumentKeyError('documentKey must not contain ".."');
  }

  // Reject double slashes (ambiguous path).
  if (decoded.includes("//")) {
    throw new DocumentKeyError('documentKey must not contain "//"');
  }

  // Reject leading slash (absolute path).
  if (decoded.startsWith("/")) {
    throw new DocumentKeyError('documentKey must not start with "/"');
  }

  // Strip the projectId prefix if the caller already included it
  // (idempotent normalisation).
  const prefix = `${projectId}/`;
  const suffix = decoded.startsWith(prefix)
    ? decoded.slice(prefix.length)
    : decoded;

  // After stripping the prefix the suffix must still be non-empty.
  if (!suffix) {
    throw new DocumentKeyError("documentKey resolves to an empty suffix");
  }

  // Final sanity: the canonical key must start with the prefix.
  const canonical = `${prefix}${suffix}`;

  // Belt-and-suspenders: re-check the canonical key truly starts with the
  // project prefix (guards against edge-cases we might not have foreseen).
  if (!canonical.startsWith(prefix)) {
    throw new DocumentKeyError(
      "documentKey normalises outside the project prefix",
    );
  }

  return canonical;
}
