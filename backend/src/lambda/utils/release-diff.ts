/**
 * release-diff.ts — pure, per-constituent semantic diff between two
 * AgentRelease bundles (releaseDiff(a, b)).
 *
 * Grounded in AgentReleaseConstituents (../../types.ts) and
 * release-hash.ts's Class A / Class B split:
 *   - agentConfig (ContentSnapshot)            -> constituent "agentConfig"
 *   - promptVersions (Record<name, ContentSnapshot>) -> one constituent
 *     PER PROMPT NAME, "prompt:<name>" — a single prompt edit must not
 *     force every other prompt into the diff.
 *   - execSpecId/execSpecVersion (Class A, pinned by reference)
 *                                               -> constituent "execSpec"
 *   - modelConfigSnapshots (ModelConfigSnapshot[]) -> one constituent PER
 *     SLOT, "model:<slot>"
 *   - toolConfigs (ContentSnapshot[])           -> constituent "tools"
 *     (list membership ± — see design note below)
 *   - policySnapshot (PolicySnapshot)           -> constituent "policy"
 *     (field-level delta)
 *   - evalEvidence (AgentReleaseEvalEvidence, pointer-only) -> constituent
 *     "evalEvidence". Score-vector movement is NOT computed here — this
 *     module is pure and has no I/O, and the score vector lives on the
 *     (out-of-bundle) EvalRun row, not on AgentReleaseConstituents. The
 *     resolver layer (release-diff-resolver.ts) resolves each side's
 *     EvalRun.scoreAggregates and passes them in via `scoreVectorA` /
 *     `scoreVectorB` on ReleaseDiffOptions — see diffScoreVectors below,
 *     which IS pure (DimensionAggregate[] in, delta out).
 *
 * Semantics (per task spec):
 *   - Only CHANGED constituents are enumerated; unchanged ones are
 *     omitted entirely from the result.
 *   - diff(a, a) === { changes: [] } for ANY bundle (identity).
 *   - diff(a, b) and diff(b, a) enumerate the IDENTICAL set of changed
 *     constituent keys, with before/after swapped on every field
 *     (symmetric-inverse).
 *
 * Equality is by content, not by object identity — mirrors
 * release-hash.ts's own canonicalization discipline (structurally-equal
 * input, e.g. differently-key-ordered policySnapshot, must never appear
 * as a spurious diff). Two ContentSnapshot values are equal when their
 * `digest` is equal (the digest IS the content-equality witness — same
 * doctrine as release-store.ts's content-addressing).
 */
import type {
  AgentReleaseConstituents,
  ContentSnapshot,
  ModelConfigSnapshot,
  PolicySnapshot,
  AgentReleaseEvalEvidence,
} from "../../types";
import type { DimensionAggregate } from "./eval-score-aggregate";
import type { DimensionName } from "./eval-scoring";

/** Per-constituent size cap before truncation kicks in (bytes of the
 * JSON-stringified before/after pair). Mirrors eval-resolver.ts's /
 * eval-comparison-resolver.ts's MAX_JSON_FIELD_BYTES precedent (256KB) —
 * reused verbatim rather than inventing a new cap. */
export const MAX_CONSTITUENT_DIFF_BYTES = 256 * 1024;

export type ReleaseDiffConstituentKind =
  | "agentConfig"
  | "prompt"
  | "execSpec"
  | "model"
  | "tools"
  | "policy"
  | "evalEvidence"
  | "scoreVector";

/** Exhaustiveness guard: maps every key of AgentReleaseConstituents to
 * the ReleaseDiffConstituentKind that covers it (execSpecId and
 * execSpecVersion both map to the single "execSpec" constituent; every
 * other field maps 1:1). Compiler-enforced via `satisfies` below — if a
 * future field is added to AgentReleaseConstituents in ../../types
 * without a corresponding entry here, this fails to compile, so a new
 * bundle field can never be silently dropped from releaseDiff (the
 * feedback-round-1 exhaustiveness finding). Kept next to
 * ReleaseDiffConstituentKind, not exported — it exists purely as a
 * compile-time trip-wire and a source for the runtime coverage test. */
const CONSTITUENT_KEY_COVERAGE = {
  agentConfig: "agentConfig",
  promptVersions: "prompt",
  execSpecId: "execSpec",
  execSpecVersion: "execSpec",
  modelConfigSnapshots: "model",
  toolConfigs: "tools",
  policySnapshot: "policy",
  evalEvidence: "evalEvidence",
} satisfies Record<keyof AgentReleaseConstituents, ReleaseDiffConstituentKind>;

/** Runtime counterpart to the compile-time guard above. Real callers
 * (release-diff-resolver.ts, environment-release-pointer-resolver.ts)
 * pass full `AgentRelease` rows — which structurally extend
 * AgentReleaseConstituents with extra fields like releaseId, orgId,
 * createdAt, etc. — directly into releaseDiff, so this must NOT reject
 * a bundle merely for carrying keys beyond AgentReleaseConstituents.
 * What it guards against is the opposite direction: a bundle that is
 * MISSING a key CONSTITUENT_KEY_COVERAGE expects (i.e. a future field
 * added to AgentReleaseConstituents without a matching diff branch
 * would show up here as an expected key that never appears on any real
 * bundle key set drift check — see the test suite, which iterates
 * Object.keys(bundle) filtered to keys AgentReleaseConstituents is
 * expected to own). Exported so tests can assert coverage directly.
 * Throws rather than silently ignoring, because a gap here means
 * releaseDiff's output would otherwise omit a real change. */
export function assertConstituentKeyCoverage(
  bundle: AgentReleaseConstituents,
): void {
  const expectedKeys = Object.keys(
    CONSTITUENT_KEY_COVERAGE,
  ) as (keyof AgentReleaseConstituents)[];
  const missingKeys = expectedKeys.filter(
    (k) => !Object.prototype.hasOwnProperty.call(bundle, k),
  );
  if (missingKeys.length > 0) {
    throw new Error(
      `release-diff: bundle is missing constituent key(s) required for diffing: ${missingKeys.join(", ")}`,
    );
  }
}

export interface DimensionMovement {
  dimension: DimensionName;
  before: DimensionAggregate | null;
  after: DimensionAggregate | null;
}

/** One line-level diff entry, "context" | "added" | "removed". Used for
 * prompt text and any other line-oriented content. */
export interface LineDiffEntry {
  type: "context" | "added" | "removed";
  /** 1-based line number in the SIDE this entry's type refers to
   * (before-side for "removed"/"context", after-side for "added"). */
  line: number;
  text: string;
}

/** A single changed constituent. `before`/`after` are omitted (left
 * undefined) when the constituent did not exist on that side at all
 * (e.g. a prompt/model-slot/tool added or removed wholesale) — this is
 * distinct from an empty-string value, so callers can tell "absent" from
 * "present but empty". */
export interface ReleaseDiffChange {
  kind: ReleaseDiffConstituentKind;
  /** Stable identifier within `kind` — prompt name, model slot, tool
   * sourceId, or the constituent kind itself for singleton constituents
   * (agentConfig, execSpec, policy, evalEvidence, scoreVector). */
  key: string;
  before?: unknown;
  after?: unknown;
  /** Present only for kind "prompt" — line-level diff of the prompt
   * text. Absent when either side lacks the prompt (added/removed
   * wholesale) or when truncated. */
  lineDiff?: LineDiffEntry[];
  /** Present only for kind "policy" — precise field-level breakdown
   * (field name -> {before, after}) so a consumer never has to re-diff
   * the full before/after PolicySnapshot itself. */
  fieldChanges?: Record<string, { before: unknown; after: unknown }>;
  /** Present only for kind "scoreVector" — the full per-dimension
   * DimensionMovement[] breakdown. */
  movements?: DimensionMovement[];
  /** True when this constituent's before/after (and lineDiff, if any)
   * were large enough to exceed MAX_CONSTITUENT_DIFF_BYTES and were
   * dropped in favor of a lightweight summary. A truncated entry never
   * causes the diff computation itself to fail. */
  truncated?: boolean;
}

export interface ReleaseDiffResult {
  changes: ReleaseDiffChange[];
}

// ---------------------------------------------------------------------
// Line-level text diff (no external dependency — package.json carries
// no `diff`/`diff-match-patch`/etc. library; a short, LCS-based
// line-diff is implemented locally).
// ---------------------------------------------------------------------

/**
 * Classic LCS-based line diff, O(n*m) time/space over line counts. Fine
 * for prompt text (bounded, human-authored) — NOT intended for
 * arbitrarily large inputs, which is exactly what the truncation path
 * above guards against before this function is ever reached.
 */
export function diffLines(before: string, after: string): LineDiffEntry[] {
  const beforeLines = before.split("\n");
  const afterLines = after.split("\n");
  const n = beforeLines.length;
  const m = afterLines.length;

  // lcs[i][j] = length of the LCS of beforeLines[i:] and afterLines[j:]
  const lcs: number[][] = Array.from({ length: n + 1 }, () =>
    new Array<number>(m + 1).fill(0),
  );
  for (let i = n - 1; i >= 0; i--) {
    for (let j = m - 1; j >= 0; j--) {
      lcs[i][j] =
        beforeLines[i] === afterLines[j]
          ? lcs[i + 1][j + 1] + 1
          : Math.max(lcs[i + 1][j], lcs[i][j + 1]);
    }
  }

  const entries: LineDiffEntry[] = [];
  let i = 0;
  let j = 0;
  let beforeLineNo = 1;
  let afterLineNo = 1;
  while (i < n && j < m) {
    if (beforeLines[i] === afterLines[j]) {
      entries.push({
        type: "context",
        line: beforeLineNo,
        text: beforeLines[i],
      });
      i++;
      j++;
      beforeLineNo++;
      afterLineNo++;
    } else if (lcs[i + 1][j] >= lcs[i][j + 1]) {
      entries.push({
        type: "removed",
        line: beforeLineNo,
        text: beforeLines[i],
      });
      i++;
      beforeLineNo++;
    } else {
      entries.push({ type: "added", line: afterLineNo, text: afterLines[j] });
      j++;
      afterLineNo++;
    }
  }
  while (i < n) {
    entries.push({ type: "removed", line: beforeLineNo, text: beforeLines[i] });
    i++;
    beforeLineNo++;
  }
  while (j < m) {
    entries.push({ type: "added", line: afterLineNo, text: afterLines[j] });
    j++;
    afterLineNo++;
  }
  return entries;
}

function byteLength(value: unknown): number {
  return Buffer.byteLength(JSON.stringify(value) ?? "", "utf8");
}

/** Applies the truncation contract to a candidate change: if the
 * before/after (+ lineDiff, when present) payload exceeds
 * MAX_CONSTITUENT_DIFF_BYTES, replace it with a size-only summary and
 * set truncated=true. Never throws — a diff must never fail because a
 * constituent is large (task spec: "approval must never fail because a
 * diff is large"). */
function applyTruncation(change: ReleaseDiffChange): ReleaseDiffChange {
  const payloadBytes = byteLength({
    before: change.before,
    after: change.after,
    lineDiff: change.lineDiff,
  });
  if (payloadBytes <= MAX_CONSTITUENT_DIFF_BYTES) {
    return change;
  }
  const summary = (value: unknown): unknown => {
    if (value === undefined) return undefined;
    return { truncatedSummaryBytes: byteLength(value) };
  };
  return {
    kind: change.kind,
    key: change.key,
    before: summary(change.before),
    after: summary(change.after),
    truncated: true,
  };
}

// ---------------------------------------------------------------------
// Per-constituent diffing
// ---------------------------------------------------------------------

function contentSnapshotEqual(
  a: ContentSnapshot | undefined,
  b: ContentSnapshot | undefined,
): boolean {
  if (a === undefined && b === undefined) return true;
  if (a === undefined || b === undefined) return false;
  return a.digest === b.digest;
}

function diffAgentConfig(
  before: ContentSnapshot,
  after: ContentSnapshot,
): ReleaseDiffChange | null {
  if (contentSnapshotEqual(before, after)) return null;
  return applyTruncation({
    kind: "agentConfig",
    key: "agentConfig",
    before,
    after,
    lineDiff: diffLines(before.content, after.content),
  });
}

function diffPrompts(
  before: Record<string, ContentSnapshot>,
  after: Record<string, ContentSnapshot>,
): ReleaseDiffChange[] {
  const names = new Set<string>([
    ...Object.keys(before ?? {}),
    ...Object.keys(after ?? {}),
  ]);
  const changes: ReleaseDiffChange[] = [];
  for (const name of names) {
    const b = before?.[name];
    const a = after?.[name];
    if (contentSnapshotEqual(b, a)) continue;
    changes.push(
      applyTruncation({
        kind: "prompt",
        key: name,
        before: b,
        after: a,
        // lineDiff only makes sense when both sides exist — a wholesale
        // add/remove has no meaningful before-vs-after text to diff.
        ...(b !== undefined && a !== undefined
          ? { lineDiff: diffLines(b.content, a.content) }
          : {}),
      }),
    );
  }
  return changes.sort((x, y) => x.key.localeCompare(y.key));
}

function diffExecSpec(
  before: AgentReleaseConstituents,
  after: AgentReleaseConstituents,
): ReleaseDiffChange | null {
  if (
    before.execSpecId === after.execSpecId &&
    before.execSpecVersion === after.execSpecVersion
  ) {
    return null;
  }
  return applyTruncation({
    kind: "execSpec",
    key: "execSpec",
    before: {
      execSpecId: before.execSpecId,
      execSpecVersion: before.execSpecVersion,
    },
    after: {
      execSpecId: after.execSpecId,
      execSpecVersion: after.execSpecVersion,
    },
  });
}

function modelSnapshotEqual(
  a: ModelConfigSnapshot | undefined,
  b: ModelConfigSnapshot | undefined,
): boolean {
  if (a === undefined && b === undefined) return true;
  if (a === undefined || b === undefined) return false;
  return a.digest === b.digest;
}

function diffModelConfigs(
  before: ModelConfigSnapshot[],
  after: ModelConfigSnapshot[],
): ReleaseDiffChange[] {
  const beforeBySlot = new Map(before.map((m) => [m.slot, m]));
  const afterBySlot = new Map(after.map((m) => [m.slot, m]));
  const slots = new Set<string>([
    ...beforeBySlot.keys(),
    ...afterBySlot.keys(),
  ]);
  const changes: ReleaseDiffChange[] = [];
  for (const slot of slots) {
    const b = beforeBySlot.get(slot);
    const a = afterBySlot.get(slot);
    if (modelSnapshotEqual(b, a)) continue;
    changes.push(
      applyTruncation({ kind: "model", key: slot, before: b, after: a }),
    );
  }
  return changes.sort((x, y) => x.key.localeCompare(y.key));
}

/** Tool list ± — membership delta keyed by sourceId (a tool's stable
 * identity per ContentSnapshot), plus a content change for a tool whose
 * sourceId is present on both sides but whose digest differs. Emitted as
 * ONE "tools" constituent (task spec: "tool list ±") carrying the full
 * present/changed breakdown, rather than one entry per tool — a
 * single-tool add/remove is still one semantic change to "the tool
 * list".
 *
 * SYMMETRIC SHAPE (required for the diff(a,b)/diff(b,a) swap contract):
 * both `before` and `after` carry the SAME field names —
 * `{ onlyHere: ContentSnapshot[]; changed: {sourceId, snapshot}[] }` —
 * where `onlyHere` is "present on this side, absent on the other" (so
 * before.onlyHere = removed, after.onlyHere = added, and swapping before
 * <-> after in a reversed diff() call correctly swaps "removed" for
 * "added"), and `changed` carries THIS side's snapshot for every
 * sourceId present-but-different on both sides. */
function diffTools(
  before: ContentSnapshot[],
  after: ContentSnapshot[],
): ReleaseDiffChange | null {
  const beforeById = new Map(before.map((t) => [t.sourceId, t]));
  const afterById = new Map(after.map((t) => [t.sourceId, t]));

  const onlyBefore: ContentSnapshot[] = [];
  const onlyAfter: ContentSnapshot[] = [];
  const changedBefore: Array<{ sourceId: string; snapshot: ContentSnapshot }> =
    [];
  const changedAfter: Array<{ sourceId: string; snapshot: ContentSnapshot }> =
    [];

  for (const [id, a] of afterById) {
    const b = beforeById.get(id);
    if (b === undefined) {
      onlyAfter.push(a);
    } else if (!contentSnapshotEqual(b, a)) {
      changedBefore.push({ sourceId: id, snapshot: b });
      changedAfter.push({ sourceId: id, snapshot: a });
    }
  }
  for (const [id, b] of beforeById) {
    if (!afterById.has(id)) {
      onlyBefore.push(b);
    }
  }

  if (
    onlyBefore.length === 0 &&
    onlyAfter.length === 0 &&
    changedBefore.length === 0
  ) {
    return null;
  }

  const sortBySourceId = <T extends { sourceId: string }>(arr: T[]): T[] =>
    [...arr].sort((x, y) => x.sourceId.localeCompare(y.sourceId));

  return applyTruncation({
    kind: "tools",
    key: "tools",
    before: {
      onlyHere: sortBySourceId(onlyBefore),
      changed: sortBySourceId(changedBefore),
    },
    after: {
      onlyHere: sortBySourceId(onlyAfter),
      changed: sortBySourceId(changedAfter),
    },
  });
}

function diffPolicy(
  before: PolicySnapshot,
  after: PolicySnapshot,
): ReleaseDiffChange | null {
  const fieldChanges: Record<string, { before: unknown; after: unknown }> = {};

  if (before.enforcementMode !== after.enforcementMode) {
    fieldChanges.enforcementMode = {
      before: before.enforcementMode,
      after: after.enforcementMode,
    };
  }
  if (before.ruleSetVersion !== after.ruleSetVersion) {
    fieldChanges.ruleSetVersion = {
      before: before.ruleSetVersion,
      after: after.ruleSetVersion,
    };
  }
  const beforeGrants = new Set(before.authorityUnitGrantIds ?? []);
  const afterGrants = new Set(after.authorityUnitGrantIds ?? []);
  const grantsAdded = [...afterGrants]
    .filter((g) => !beforeGrants.has(g))
    .sort();
  const grantsRemoved = [...beforeGrants]
    .filter((g) => !afterGrants.has(g))
    .sort();
  if (grantsAdded.length > 0 || grantsRemoved.length > 0) {
    fieldChanges.authorityUnitGrantIds = {
      before: grantsRemoved,
      after: grantsAdded,
    };
  }

  if (Object.keys(fieldChanges).length === 0) return null;

  return applyTruncation({
    kind: "policy",
    key: "policy",
    before,
    after,
    fieldChanges,
  });
}

function evalEvidenceEqual(
  a: AgentReleaseEvalEvidence,
  b: AgentReleaseEvalEvidence,
): boolean {
  return (
    a.evalRunId === b.evalRunId &&
    a.evalSuiteId === b.evalSuiteId &&
    a.evalSuiteVersion === b.evalSuiteVersion
  );
}

function diffEvalEvidence(
  before: AgentReleaseEvalEvidence,
  after: AgentReleaseEvalEvidence,
): ReleaseDiffChange | null {
  if (evalEvidenceEqual(before, after)) return null;
  return applyTruncation({
    kind: "evalEvidence",
    key: "evalEvidence",
    before,
    after,
  });
}

// ---------------------------------------------------------------------
// Score-vector movement (I/O-free: takes already-resolved
// DimensionAggregate[] for each side — the resolver layer is
// responsible for reading each side's EvalRun.scoreAggregates, since
// AgentReleaseConstituents.evalEvidence is a pointer, not the vector
// itself). DimensionMovement is declared earlier in this file (used by
// ReleaseDiffChange.movements).
// ---------------------------------------------------------------------

/** Per-dimension before->after movement. A dimension present on only
 * one side is reported with the other side null (never fabricated as a
 * zeroed aggregate). Dimensions with byte-identical aggregates on both
 * sides are omitted, matching the "unchanged constituents omitted"
 * doctrine used everywhere else in this module. */
export function diffScoreVectors(
  before: DimensionAggregate[],
  after: DimensionAggregate[],
): DimensionMovement[] {
  const beforeByDim = new Map<DimensionName, DimensionAggregate>(
    before.map((d) => [d.dimension, d]),
  );
  const afterByDim = new Map<DimensionName, DimensionAggregate>(
    after.map((d) => [d.dimension, d]),
  );
  const dims = new Set<DimensionName>([
    ...beforeByDim.keys(),
    ...afterByDim.keys(),
  ]);
  const movements: DimensionMovement[] = [];
  for (const dim of dims) {
    const b = beforeByDim.get(dim) ?? null;
    const a = afterByDim.get(dim) ?? null;
    if (b !== null && a !== null && JSON.stringify(b) === JSON.stringify(a)) {
      continue;
    }
    movements.push({ dimension: dim, before: b, after: a });
  }
  return movements.sort((x, y) => x.dimension.localeCompare(y.dimension));
}

/** Wraps diffScoreVectors's output as a ReleaseDiffChange (kind
 * "scoreVector") for callers that want score-vector movement folded into
 * the same ReleaseDiffChange[] shape as every other constituent — e.g.
 * releaseDiffWithScoreVectors below. Returns null when there is no
 * movement (mirrors every other diff* function's "unchanged -> null"
 * contract). */
export function diffScoreVectorChange(
  before: DimensionAggregate[],
  after: DimensionAggregate[],
): ReleaseDiffChange | null {
  const movements = diffScoreVectors(before, after);
  if (movements.length === 0) return null;
  return applyTruncation({
    kind: "scoreVector",
    key: "scoreVector",
    before: movements.map((m) => m.before),
    after: movements.map((m) => m.after),
    movements,
  });
}

// ---------------------------------------------------------------------
// Public entry points
// ---------------------------------------------------------------------

/**
 * Pure per-constituent semantic diff between two AgentRelease bundles'
 * constituents. Does NOT cover score-vector movement (that requires
 * resolving each side's EvalRun — I/O — see releaseDiffWithScoreVectors
 * below and the resolver layer). Every changed constituent is
 * enumerated with before/after (or a truncated summary); unchanged
 * constituents are omitted entirely.
 *
 * diff(a, a) === { changes: [] } for ANY bundle (reflexivity — every
 * per-constituent comparison above is a content-equality check, so a
 * bundle diffed against itself produces zero changes regardless of
 * ordering/content). diff(a, b) and diff(b, a) enumerate the identical
 * set of (kind, key) pairs with before/after swapped (symmetric-inverse
 * — every diff* helper above is called with (before, after) in the same
 * position for both invocations, and every field emitted is exactly one
 * of {before, after} swapped, or a set-symmetric-difference computation
 * that is itself symmetric under swap, e.g. tools' added<->removed and
 * policy's grantsAdded<->grantsRemoved).
 */
export function releaseDiff(
  a: AgentReleaseConstituents,
  b: AgentReleaseConstituents,
): ReleaseDiffResult {
  assertConstituentKeyCoverage(a);
  assertConstituentKeyCoverage(b);

  const changes: ReleaseDiffChange[] = [];

  const agentConfigChange = diffAgentConfig(a.agentConfig, b.agentConfig);
  if (agentConfigChange) changes.push(agentConfigChange);

  changes.push(...diffPrompts(a.promptVersions, b.promptVersions));

  const execSpecChange = diffExecSpec(a, b);
  if (execSpecChange) changes.push(execSpecChange);

  changes.push(
    ...diffModelConfigs(a.modelConfigSnapshots, b.modelConfigSnapshots),
  );

  const toolsChange = diffTools(a.toolConfigs, b.toolConfigs);
  if (toolsChange) changes.push(toolsChange);

  const policyChange = diffPolicy(a.policySnapshot, b.policySnapshot);
  if (policyChange) changes.push(policyChange);

  const evalEvidenceChange = diffEvalEvidence(a.evalEvidence, b.evalEvidence);
  if (evalEvidenceChange) changes.push(evalEvidenceChange);

  return { changes };
}

/** releaseDiff plus score-vector movement folded in as one additional
 * "scoreVector" constituent — still pure (score vectors are passed in
 * pre-resolved), for callers (the resolver, the approval-payload
 * embedder) that want the complete change set in one array. */
export function releaseDiffWithScoreVectors(
  a: AgentReleaseConstituents,
  b: AgentReleaseConstituents,
  scoreVectorA: DimensionAggregate[],
  scoreVectorB: DimensionAggregate[],
): ReleaseDiffResult {
  const base = releaseDiff(a, b);
  const scoreVectorChange = diffScoreVectorChange(scoreVectorA, scoreVectorB);
  return {
    changes: scoreVectorChange
      ? [...base.changes, scoreVectorChange]
      : base.changes,
  };
}
