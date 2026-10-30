/**
 * Agent-code S3 key safety helper.
 *
 * Design: CIT-254 SH-4. Ensures every key is bound within the `agents/`
 * prefix — same traversal / control-char guards as
 * {@link resolveProjectDocumentKey} but scoped to the agent-code bucket.
 *
 * ## Key Shapes
 *
 * The fabricator writes at `agents/{recordId}/{basename}` (scoped key).
 * The worker reads scoped-first with legacy fallback to `agents/{basename}`.
 * The seeder writes at `agents/{basename}` (legacy flat key — no recordId).
 *
 * This resolver ALWAYS serves the record-scoped key for reads and writes.
 * On a read, if the scoped key is absent the resolver falls back to the
 * legacy flat key ONLY when the config's own filename matches (i.e. the
 * basename derived from config.filename lives under `agents/{basename}`).
 * This supports the seeder's flat keys and pre-scoped-key agents while
 * ensuring new writes always land at the scoped path.
 */

import { basename as pathBasename } from "path";

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
// Metric
// ---------------------------------------------------------------------------

/**
 * Emit a `Citadel/AgentCodeKey Refused` CloudWatch EMF metric.
 * Never throws — metrics must never break the caller.
 */
export function emitAgentCodeKeyRefused(site: string): void {
  try {
    console.log(
      JSON.stringify({
        _aws: {
          Timestamp: Date.now(),
          CloudWatchMetrics: [
            {
              Namespace: "Citadel/AgentCodeKey",
              Dimensions: [["Site"]],
              Metrics: [{ Name: "Refused", Unit: "Count" }],
            },
          ],
        },
        Site: site,
        Refused: 1,
      }),
    );
  } catch {
    // metrics must never break the caller
  }
}

// ---------------------------------------------------------------------------
// Internal helpers
// ---------------------------------------------------------------------------

/**
 * Validate and extract the safe basename from a raw filename.
 *
 * @throws {AgentCodeKeyError} on any safety violation.
 */
function safeBasename(raw: string): string {
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

  // Extract the terminal basename (last path component).
  // This strips any subdirectory from config.filename so only the bare
  // file lands under the record's prefix. A config.filename like
  // `arbiter-agent/arbiter_agent.py` yields basename `arbiter_agent.py`.
  const bn = pathBasename(decoded);
  if (!bn) {
    throw new AgentCodeKeyError("filename has no basename");
  }

  return bn;
}

// ---------------------------------------------------------------------------
// Public API
// ---------------------------------------------------------------------------

/**
 * Legacy (flat) key resolution — kept only for backward-compatible tests.
 * New call sites should use {@link resolveRecordScopedAgentCodeKey}.
 *
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

/**
 * Record-scoped key result. The resolver should try {@link scopedKey}
 * first; on a NoSuchKey error during reads it may fall back to
 * {@link legacyKey} (for seeded or pre-scoped agents).
 */
export interface RecordScopedKeys {
  /** `agents/{recordId}/{basename}` — the canonical key for new writes. */
  scopedKey: string;
  /** `agents/{basename}` — fallback for legacy/seeded agents (read only). */
  legacyKey: string;
  /** The bare filename component (no directories). */
  basename: string;
}

/**
 * Resolve record-scoped S3 keys for an agent code object.
 *
 * Produces a scoped key (`agents/{recordId}/{basename}`) and a legacy
 * fallback key (`agents/{basename}`). The scoped key MUST be used for all
 * writes. On reads the caller may fall back to the legacy key when the
 * scoped key returns NoSuchKey.
 *
 * @param recordId - the owning Registry record's id (agentId).
 * @param filename - the filename from the DynamoDB config (may be undefined).
 * @returns the scoped and legacy key pair.
 * @throws {AgentCodeKeyError} on any safety violation.
 */
export function resolveRecordScopedAgentCodeKey(
  recordId: string,
  filename?: string,
): RecordScopedKeys {
  if (!recordId) throw new AgentCodeKeyError("recordId must be non-empty");

  // Validate recordId — must not contain traversal or dangerous chars.
  if (CONTROL_CHAR_RE.test(recordId)) {
    throw new AgentCodeKeyError("recordId contains control characters");
  }
  if (recordId.includes("..") || recordId.includes("/")) {
    throw new AgentCodeKeyError("recordId must not contain path separators");
  }

  const raw = filename || `${recordId}.py`;
  const bn = safeBasename(raw);

  const scopedKey = `${PREFIX}${recordId}/${bn}`;
  const legacyKey = `${PREFIX}${bn}`;

  // Belt-and-suspenders
  if (!scopedKey.startsWith(PREFIX) || !legacyKey.startsWith(PREFIX)) {
    throw new AgentCodeKeyError(
      "filename normalises outside the agents/ prefix",
    );
  }

  return { scopedKey, legacyKey, basename: bn };
}
