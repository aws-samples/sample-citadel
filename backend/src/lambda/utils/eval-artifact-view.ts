/**
 * eval-artifact-view.ts (CIT-105 per-case artifact read path — pure
 * projection layer, memory projects/cit-105-artifacts-design).
 *
 * Pure, no I/O — takes an already-fetched replay-package envelope subset
 * and projects it into the bounded, paginated EvalArtifactSideView shape
 * consumed by getEvalCaseArtifactDiff (eval-comparison-resolver.ts). Same
 * split as eval-comparison.ts (pure) vs eval-comparison-resolver.ts (I/O).
 *
 * Ordering reuses the EXACT algorithm as eval-scoring-io.ts's
 * buildExecutionSteps (startedAt, tiebreak completedAt, then nodeId;
 * missing startedAt sorts last) so a case's trajectory here is byte-for-
 * byte the same order used for scoring — never a second, potentially
 * divergent ordering implementation.
 *
 * Bounding (design §4): truncation is ALWAYS visible via *Truncated flags
 * + total-vs-returned counts/bytes + an opaque cursor for resuming. Never
 * silent. toolOrder stays `null` — the honest CIT-121 gap — mirroring
 * buildToolSetAndOrder's discipline exactly.
 */

export const MAX_TRANSCRIPT_BYTES_PER_SIDE = 128 * 1024;
export const MAX_TRANSCRIPT_MESSAGES = 200;
export const MAX_TRAJECTORY_STEPS = 500;
export const MAX_STEP_OUTPUT_BYTES = 8 * 1024;

const TOOL_PERMITTED_PREFIX = "tool_permitted:not_on_deny_list:";

export interface ReplayEnvelopeViewNode {
  nodeId: string;
  outputs: unknown;
  startedAt?: string | null;
  completedAt?: string | null;
  agentId?: string | null;
  status?: unknown;
}

export interface ReplayEnvelopeViewMessage {
  role: string;
  content: string;
  timestamp?: string;
  [key: string]: unknown;
}

export interface ReplayEnvelopeViewFinding {
  decision?: string;
  reason?: string;
  [key: string]: unknown;
}

/** Subset of ReplayPackageEnvelope this module needs — deliberately
 * narrower than the full envelope shape so this module has zero coupling
 * to replay-package-builder.ts's other sections. */
export interface ReplayEnvelopeForView {
  orgId?: string;
  correlationId?: string;
  sanitisation?: {
    redactPiiVersion: string;
    secretPatternsVersion: string;
    gate: string;
  };
  sections: {
    nodes: ReplayEnvelopeViewNode[];
    messages?: ReplayEnvelopeViewMessage[];
    findings?: ReplayEnvelopeViewFinding[] | { partial: true };
  };
}

export interface EvalTranscriptMessageView {
  index: number;
  role: string;
  content: string;
  truncated: boolean;
}

export interface EvalTrajectoryStepView {
  stepIndex: number;
  nodeId: string;
  agentId: string | null;
  status: string | null;
  startedAt: string | null;
  completedAt: string | null;
  output: unknown;
  outputTruncated: boolean;
}

export interface EvalArtifactSideViewProjection {
  sanitisation: ReplayEnvelopeForView["sanitisation"];
  transcript: EvalTranscriptMessageView[];
  transcriptTotalCount: number;
  transcriptReturnedCount: number;
  transcriptTruncated: boolean;
  transcriptNextCursor: string | null;
  transcriptTotalBytes: number;
  transcriptReturnedBytes: number;
  trajectory: EvalTrajectoryStepView[];
  trajectoryTotalCount: number;
  trajectoryReturnedCount: number;
  trajectoryTruncated: boolean;
  trajectoryNextCursor: string | null;
  toolSet: string[];
  toolOrder: string[] | null;
}

export interface ProjectSideViewCursors {
  transcriptCursor?: string | null;
  trajectoryCursor?: string | null;
}

/** ValidationError — thrown on a malformed/tampered cursor. Never a raw
 * crash, never a silent full dump. */
export class ArtifactCursorError extends Error {
  constructor(detail: string) {
    super(`ValidationError: invalid artifact cursor — ${detail}`);
    this.name = "ArtifactCursorError";
  }
}

/** Opaque base64 cursor encoding `{index}` — a resume offset into the
 * already-ordered sequence. */
export function encodeArtifactCursor(index: number): string {
  return Buffer.from(JSON.stringify({ index }), "utf8").toString("base64");
}

/** Decodes and validates an opaque cursor. Throws ArtifactCursorError
 * (message prefixed "ValidationError:") on any malformed/tampered input —
 * never crashes, never falls back to returning everything. */
export function decodeArtifactCursor(cursor: string): number {
  let raw: string;
  try {
    raw = Buffer.from(cursor, "base64").toString("utf8");
  } catch {
    throw new ArtifactCursorError("not valid base64");
  }
  let parsed: unknown;
  try {
    parsed = JSON.parse(raw);
  } catch {
    throw new ArtifactCursorError("decoded payload is not valid JSON");
  }
  if (
    !parsed ||
    typeof parsed !== "object" ||
    typeof (parsed as { index?: unknown }).index !== "number" ||
    !Number.isInteger((parsed as { index: number }).index) ||
    (parsed as { index: number }).index < 0
  ) {
    throw new ArtifactCursorError(
      "decoded payload missing a valid non-negative integer index",
    );
  }
  return (parsed as { index: number }).index;
}

/** Timestamp -> epoch-ms, or +Infinity when absent/unparseable — mirrors
 * eval-scoring-io.ts's orderingKey exactly (nodes without startedAt sort
 * last, never guessed). */
function orderingKey(value: string | null | undefined): number {
  if (!value) return Number.POSITIVE_INFINITY;
  const ms = new Date(value).getTime();
  return Number.isFinite(ms) ? ms : Number.POSITIVE_INFINITY;
}

/** Sorted, deterministic total order — IDENTICAL algorithm to
 * eval-scoring-io.ts's buildExecutionSteps (startedAt, tiebreak
 * completedAt, then nodeId). */
function sortedNodes(
  nodes: ReplayEnvelopeViewNode[],
): ReplayEnvelopeViewNode[] {
  return [...nodes].sort((a, b) => {
    const startDiff = orderingKey(a.startedAt) - orderingKey(b.startedAt);
    if (startDiff !== 0) return startDiff;
    const completeDiff =
      orderingKey(a.completedAt) - orderingKey(b.completedAt);
    if (completeDiff !== 0) return completeDiff;
    return a.nodeId.localeCompare(b.nodeId);
  });
}

/** Chronological order by timestamp — mirrors
 * assembleConversationReplayPackage's own message ordering (lexicographic
 * sort over the ISO-8601 sort key), applied defensively here too since
 * this module must not assume the envelope's messages array is already
 * sorted (it always is today, but this keeps the guarantee local). */
function sortedMessages(
  messages: ReplayEnvelopeViewMessage[],
): ReplayEnvelopeViewMessage[] {
  return [...messages].sort((a, b) => {
    const ta = typeof a.timestamp === "string" ? a.timestamp : "";
    const tb = typeof b.timestamp === "string" ? b.timestamp : "";
    return ta < tb ? -1 : ta > tb ? 1 : 0;
  });
}

function buildToolSetAndOrder(
  findings: ReplayEnvelopeViewFinding[] | { partial: true } | undefined,
): { toolSet: string[]; toolOrder: string[] | null } {
  const tools = new Set<string>();
  if (Array.isArray(findings)) {
    for (const f of findings) {
      const reason = typeof f.reason === "string" ? f.reason : "";
      if (reason.startsWith(TOOL_PERMITTED_PREFIX)) {
        tools.add(reason.slice(TOOL_PERMITTED_PREFIX.length));
      }
    }
  }
  // toolOrder: always null — the honest CIT-121 gap. NEVER inferred from
  // finding array position (no guaranteed emission order).
  return { toolSet: [...tools].sort(), toolOrder: null };
}

interface PagedResult<T> {
  items: T[];
  totalCount: number;
  returnedCount: number;
  truncated: boolean;
  nextCursor: string | null;
  totalBytes: number;
  returnedBytes: number;
}

/**
 * Walks `allItems` starting at `startIndex`, accumulating byte budget via
 * `byteLength(item)`, stopping at whichever of {maxCount, maxBytes} hits
 * first. Truncation is always explicit via the returned metadata — never
 * silent.
 */
function paginate<T>(
  allItems: T[],
  startIndex: number,
  maxCount: number,
  maxBytes: number,
  byteLength: (item: T) => number,
): PagedResult<T> {
  const totalCount = allItems.length;
  const totalBytes = allItems.reduce((sum, item) => sum + byteLength(item), 0);

  const page = allItems.slice(startIndex);
  const items: T[] = [];
  let returnedBytes = 0;
  let truncated = false;

  for (const item of page) {
    if (items.length >= maxCount) {
      truncated = true;
      break;
    }
    const len = byteLength(item);
    if (returnedBytes + len > maxBytes && items.length > 0) {
      truncated = true;
      break;
    }
    items.push(item);
    returnedBytes += len;
    if (returnedBytes >= maxBytes) {
      // Included this item even if it alone exceeds maxBytes (avoids an
      // infinite-truncation deadlock on a single oversized item); any
      // further item is deferred to the next page.
      truncated = startIndex + items.length < totalCount;
      break;
    }
  }

  if (!truncated && startIndex + items.length < totalCount) {
    truncated = true;
  }

  const nextCursor = truncated
    ? encodeArtifactCursor(startIndex + items.length)
    : null;

  return {
    items,
    totalCount,
    returnedCount: items.length,
    truncated,
    nextCursor,
    totalBytes,
    returnedBytes,
  };
}

function projectMessage(
  message: ReplayEnvelopeViewMessage,
  index: number,
): EvalTranscriptMessageView {
  const content = typeof message.content === "string" ? message.content : "";
  const contentBytes = Buffer.byteLength(content, "utf8");
  const sliceCapExceeded = contentBytes > MAX_TRANSCRIPT_BYTES_PER_SIDE;
  const slicedContent = sliceCapExceeded
    ? Buffer.from(content, "utf8")
        .subarray(0, MAX_TRANSCRIPT_BYTES_PER_SIDE)
        .toString("utf8")
    : content;
  return {
    index,
    role: typeof message.role === "string" ? message.role : "",
    content: slicedContent,
    truncated: sliceCapExceeded,
  };
}

function projectTrajectoryStep(
  node: ReplayEnvelopeViewNode,
  stepIndex: number,
): EvalTrajectoryStepView {
  const outputJson = JSON.stringify(node.outputs ?? null) ?? "null";
  const outputBytes = Buffer.byteLength(outputJson, "utf8");
  const outputTruncated = outputBytes > MAX_STEP_OUTPUT_BYTES;
  let output: unknown = node.outputs ?? null;
  if (outputTruncated) {
    const sliced = Buffer.from(outputJson, "utf8")
      .subarray(0, MAX_STEP_OUTPUT_BYTES)
      .toString("utf8");
    output = { truncatedRaw: sliced };
  }
  return {
    stepIndex,
    nodeId: node.nodeId,
    agentId: typeof node.agentId === "string" ? node.agentId : null,
    status: typeof node.status === "string" ? node.status : null,
    startedAt: node.startedAt ?? null,
    completedAt: node.completedAt ?? null,
    output,
    outputTruncated,
  };
}

/**
 * Projects one side's envelope into the bounded EvalArtifactSideView
 * shape. Pure — no I/O, no sanitisation call here (the caller re-runs
 * sanitizeBundle + assertBundleSecretFree on the RESULT of this function,
 * per the design's defence-in-depth requirement).
 *
 * Throws ArtifactCursorError (message prefixed "ValidationError:") on a
 * malformed/tampered cursor.
 */
export function projectSideView(
  envelope: ReplayEnvelopeForView,
  caseKind: "CONVERSATION" | "EXECUTION",
  cursors: ProjectSideViewCursors,
): EvalArtifactSideViewProjection {
  const transcriptStart = cursors.transcriptCursor
    ? decodeArtifactCursor(cursors.transcriptCursor)
    : 0;
  const trajectoryStart = cursors.trajectoryCursor
    ? decodeArtifactCursor(cursors.trajectoryCursor)
    : 0;

  const rawMessages =
    caseKind === "CONVERSATION" ? (envelope.sections.messages ?? []) : [];
  const orderedMessages = sortedMessages(rawMessages);
  const transcriptPage = paginate(
    orderedMessages,
    transcriptStart,
    MAX_TRANSCRIPT_MESSAGES,
    MAX_TRANSCRIPT_BYTES_PER_SIDE,
    (m) =>
      Buffer.byteLength(typeof m.content === "string" ? m.content : "", "utf8"),
  );
  const transcript = transcriptPage.items.map((m, i) =>
    projectMessage(m, transcriptStart + i),
  );

  const rawNodes = caseKind === "EXECUTION" ? envelope.sections.nodes : [];
  const orderedNodes = sortedNodes(rawNodes);
  const trajectoryPage = paginate(
    orderedNodes,
    trajectoryStart,
    MAX_TRAJECTORY_STEPS,
    Number.POSITIVE_INFINITY, // trajectory bounding is by step count, not aggregate bytes
    () => 0,
  );
  const trajectory = trajectoryPage.items.map((n, i) =>
    projectTrajectoryStep(n, trajectoryStart + i),
  );

  const { toolSet, toolOrder } = buildToolSetAndOrder(
    envelope.sections.findings,
  );

  return {
    sanitisation: envelope.sanitisation,
    transcript,
    transcriptTotalCount: transcriptPage.totalCount,
    transcriptReturnedCount: transcriptPage.returnedCount,
    transcriptTruncated: transcriptPage.truncated,
    transcriptNextCursor: transcriptPage.nextCursor,
    transcriptTotalBytes: transcriptPage.totalBytes,
    transcriptReturnedBytes: transcriptPage.returnedBytes,
    trajectory,
    trajectoryTotalCount: trajectoryPage.totalCount,
    trajectoryReturnedCount: trajectoryPage.returnedCount,
    trajectoryTruncated: trajectoryPage.truncated,
    trajectoryNextCursor: trajectoryPage.nextCursor,
    toolSet,
    toolOrder,
  };
}
