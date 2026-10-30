/**
 * Agent-code S3 key safety helper.
 *
 * Design: CIT-254 SH-4. Ensures every key is bound within the `agents/`
 * prefix — same traversal / control-char guards as
 * {@link resolveProjectDocumentKey} but scoped to the agent-code bucket.
 */

// ---------------------------------------------------------------------------
// Error
// ---------------------------------------------------------------------------

export class AgentCodeKeyError extends Error {
  constructor(message: string) {
    super(message);
    this.name = "AgentCodeKeyError";
  }
}

// ---------------------------------------------------------------------------
// Constants
// ---------------------------------------------------------------------------

const PREFIX = "agents/";

/** Characters that must never appear in a filename (C0/C1 control block). */
// eslint-disable-next-line no-control-regex
const CONTROL_CHAR_RE = /[\x00-\x1f\x7f-\x9f]/;

// ---------------------------------------------------------------------------
// Public API
// ---------------------------------------------------------------------------

/**
 * Resolve a (recordId|agentId, filename) pair into a validated S3 key
 * under the `agents/` prefix.
 *
 * Follows the same safety rules as `resolveProjectDocumentKey`:
 *   - No `..` traversal
 *   - No leading `/`
 *   - No `//` (ambiguous)
 *   - No control characters
 *   - Percent-encoded tricks decoded before checks
 *
 * Accepted filename shapes (from live bucket survey):
 *   - `{snake_name}.py`
 *   - `{kebab-dir}/{snake_name}.py`
 *
 * @param agentId - the agent or record id (used as fallback filename).
 * @param filename - the filename from the DynamoDB config (may be undefined).
 * @returns the full S3 key (e.g. `agents/my_agent.py`).
 * @throws {AgentCodeKeyError} on any safety violation.
 */
export function resolveAgentCodeKey(
  agentId: string,
  filename?: string,
): string {
  if (!agentId) throw new AgentCodeKeyError("agentId must be non-empty");

  const raw = filename || `${agentId}.py`;

  // Decode percent-encoded characters.
  let decoded: string;
  try {
    decoded = decodeURIComponent(raw);
  } catch {
    throw new AgentCodeKeyError("filename contains invalid percent-encoding");
  }

  // Control characters
  if (CONTROL_CHAR_RE.test(decoded)) {
    throw new AgentCodeKeyError("filename contains control characters");
  }

  // Path traversal
  if (decoded.includes("..")) {
    throw new AgentCodeKeyError('filename must not contain ".."');
  }

  // Leading slash (absolute path)
  if (decoded.startsWith("/")) {
    throw new AgentCodeKeyError('filename must not start with "/"');
  }

  // Double slashes (ambiguous)
  if (decoded.includes("//")) {
    throw new AgentCodeKeyError('filename must not contain "//"');
  }

  // Trailing slash (directory, not a file)
  if (decoded.endsWith("/")) {
    throw new AgentCodeKeyError('filename must not end with "/"');
  }

  // Ensure the filename is non-empty after decoding
  if (!decoded) {
    throw new AgentCodeKeyError("filename resolves to empty");
  }

  const key = `${PREFIX}${decoded}`;

  // Belt-and-suspenders: canonical key must start with the prefix.
  if (!key.startsWith(PREFIX)) {
    throw new AgentCodeKeyError(
      "filename normalises outside the agents/ prefix",
    );
  }

  return key;
}
