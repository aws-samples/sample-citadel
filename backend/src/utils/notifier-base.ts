/**
 * Governance event emitter (QB-005-1 resolution Option iii).
 *
 * Standalone helper for emitting governance.* EventBridge events with:
 * - A discriminated-union payload map across 17 detail-types (compile-time type safety per type).
 * - Fail-closed sanitisation: <script>, <iframe>, <object> tags are stripped from
 * string-valued payload fields before JSON-serialisation. Callers cannot bypass this.
 * - ISO-8601 timestamp + optional correlationId stamped into every Detail.
 *
 * Per QB-005-1 this module does NOT import from backend/src/utils/events.ts; the existing
 * publishEvent helper remains untouched (dead-code retirement is a future cleanup story).
 *
 * Per NOTIFIER_USE_SHARED=false (AC #3), other existing notifier Lambdas
 * (design-progress-notifier, assessment-completion-notifier) do NOT delegate to this
 * helper in Phase 1. Those files remain unchanged.
 */

import {
  EventBridgeClient,
  PutEventsCommand,
} from "@aws-sdk/client-eventbridge";

// Keep this list in lock-step with the docs/EVENTBRIDGE_CATALOG.md #Governance Events
// section (added by commit 12844ba) and with the discriminated union below.
export const GOVERNANCE_DETAIL_TYPES = [
  "governance.adr.locked",
  "governance.adr.reopen.attempted",
  "governance.specification.created",
  "governance.specification.approved",
  "governance.specification.rejected",
  "governance.round.started",
  "governance.round.completed",
  "governance.round.transcript.overflow",
  "governance.archetype.classified",
  "governance.offfrontier.escalated",
  "governance.grandfathered.bypass",
  // Wave 2.E: emitted by setGovernanceMode resolver on a successful mode flip.
  "governance.mode.transition",
  // Wave 4.C.2: emitted by addConstitutionalRule / updateConstitutionalRule
  // / deleteConstitutionalRule on a successful rules write. Best-effort —
  // failure does not roll back the rule write.
  "governance.constitutional.rule.changed",
  // Wave 4.D.2: emitted by revokeCaseLaw / unrevokeCaseLaw /
  // updateCaseLawPrecedence on a successful case-law row write.
  // Best-effort — failure does not roll back the primary write.
  "governance.caselaw.changed",
  // CIT-101: emitted by freezeEvalSuite on a successful freeze — the eval
  // resolver's parity with governance.specification.approved.
  "governance.eval.suite.frozen",
  // CIT-102: emitted by the eval-runner driver on run start/completion.
  // Execution-outcome counts only — no scores (CIT-103 owns verdicts).
  // No consumers yet (CIT-105/111 wire consumers later); registered now
  // to freeze the contract.
  "governance.eval.run.started",
  "governance.eval.run.completed",
  // CIT-103 Pass A: emitted by recordCaseCompletion (eval-run-completion.ts)
  // AFTER artifact materialization, inside the exactly-once
  // completionRecorded guard region. Additive — computes NO scores itself
  // (the completion-rollup's "no scores" contract is preserved); consumed
  // by eval-case-scorer.ts.
  "governance.eval.case.completed",
  // CIT-103 Pass A -> Pass B: emitted by eval-case-scorer.ts when a case
  // opts into one or more judge-basis dimensions (task_success.judge or
  // groundingRequirements[].mustNotHallucinate). Consumed by the arbiter
  // Python judge handler (Pass B) — TS never invokes bedrock-runtime
  // itself (design §1).
  "governance.eval.case.judge.requested",
  // Pass B -> Pass A: emitted by the arbiter judge handler after a judge
  // invocation completes. Consumed by the TS single-writer consumer in
  // eval-case-scorer.ts, which validates the required reproducibility
  // stamp fields (judgeModelId/judgeModelVersion/judgePromptHash) before
  // patching the case's PENDING dimension to SCORED/UNKNOWN. TS is the
  // ONLY writer of eval tables — the judge handler never writes them
  // directly (single-writer invariant, design §7).
  "governance.eval.case.judged",
  // Phase 2 (production sampling, design §2.3): emitted by
  // eval-sampling-selector.ts after a sanitized prod-sample artifact has
  // been materialized (reusing assembleReplayPackage verbatim) and
  // written to `prod-samples/{orgId}/{runId}.json`. Never emitted when
  // the fail-closed sanitisation gate throws — the sample is dropped
  // instead (design invariant: no un-redacted content path exists).
  // `dimensions` is the Phase 2 allowlist, deliberately EXCLUDING
  // task_success/tool_accuracy (no per-case expectation exists for a
  // production sample). Consumed by eval-sample-scorer.ts.
  "governance.eval.sample.captured",
  // Phase 3 (drift detection, design §3.2/§3.3): emitted by
  // eval-drift-detector.ts (scheduled) when a current-vs-baseline
  // production-sample comparison for one (agentId, dimension) pair
  // breaches its configured threshold (eval-drift.ts::computeDrift).
  // Best-effort — the EMF flush for the cycle has already happened
  // regardless of whether this event is successfully delivered.
  // Consumed by eval-drift-finding-writer.ts, which writes a
  // GovernanceFinding row into GOVERNANCE_LEDGER_TABLE.
  "governance.eval.drift.detected",
  // CIT-105: emitted by designateEvalBaseline on a successful baseline
  // designation/re-designation. Audit trail + lets a future auto-
  // comparison consumer react to a new baseline (design §9).
  "governance.eval.baseline.designated",
  // CIT-105: emitted by computeEvalComparison AFTER the verdict row is
  // durably written. This is the machine-readable hand-off the future
  // promotion gate subscribes to — carries only per-dimension-derived
  // booleans/arrays/enum, no dimension-collapsing number (design §9).
  "governance.eval.comparison.completed",
  // Emitted by the seed-eval-suites custom-resource Lambda when a
  // seed-version bump's conditional heal PutCommand is rejected because
  // the row is FROZEN or referenced (not merely already-current). At
  // most one per blocked suite per invocation — never emitted for the
  // ordinary already-current skip case.
  "governance.eval.seed.heal.blocked",
  // Auto-rollback (decision D6/§7): emitted best-effort POST-commit by the
  // agent-release-rollback-evaluator after an AUTO_ABORT_CANARY move is
  // durably committed + its finding written. Relayed by governance-notifier
  // to the admin onGovernanceEvent subscription. Best-effort — the ledger
  // finding is the durable record; a delivery failure never rolls back the
  // committed move.
  "governance.release.auto_rollback",
] as const;

export type GovernanceDetailType = (typeof GOVERNANCE_DETAIL_TYPES)[number];

// Finding e396a7ee (PART B) / secondary finding 163d4776: the CRITICAL
// subset that MUST reach a durable, confirmed-subscriber channel (the
// plaintext alarmTopic SNS backstop) in addition to the ephemeral WS
// fanout, because a zero-subscriber WS fanout for these types is
// unacceptable to miss silently. All routed types still attempt WS +
// still get a durable outcome row (see governance-notifier.ts); only
// this subset additionally triggers an SNS publish.
//
// Deliberately does NOT include a breaker/circuit-breaker detail-type:
// per-target breaker state changes have no governance.* EventBridge
// detail-type today (confirmed by inspection — breaker state is
// ledger-only, emitted as a GovernanceFinding row, never as a
// governance.* event). Inventing one here would fabricate a contract
// this notifier cannot actually observe. If breaker events later gain a
// governance.* detail-type, add it to both this list AND
// GOVERNANCE_DETAIL_TYPES/the EventBridge rule in the same change (see
// the lock-step test in notifier-base.test.ts and
// governance-notifier-durable-destination.test.ts).
export const CRITICAL_GOVERNANCE_DETAIL_TYPES = [
  "governance.offfrontier.escalated",
  "governance.release.auto_rollback",
] as const satisfies readonly GovernanceDetailType[];

export type CriticalGovernanceDetailType =
  (typeof CRITICAL_GOVERNANCE_DETAIL_TYPES)[number];

const CRITICAL_GOVERNANCE_DETAIL_TYPE_SET: ReadonlySet<string> =
  new Set<string>(CRITICAL_GOVERNANCE_DETAIL_TYPES);

/** True iff `detailType` is in the CRITICAL subset that must SNS-publish. */
export function isCriticalGovernanceDetailType(detailType: string): boolean {
  return CRITICAL_GOVERNANCE_DETAIL_TYPE_SET.has(detailType);
}

// Per-detail-type typed payload map.
export interface GovernancePayloadMap {
  "governance.adr.locked": {
    projectId: string;
    adrId: string;
    title: string;
    sourceRoundIds: string[];
  };
  "governance.adr.reopen.attempted": {
    projectId: string;
    adrId: string;
    revisitConditionMatched: boolean;
    attemptedBy: string;
    authResult: "ALLOWED" | "DENIED";
  };
  "governance.specification.created": {
    projectId: string;
    specId: string;
    version: number;
  };
  "governance.specification.approved": {
    projectId: string;
    specId: string;
    approvedBy: string;
    version: number;
  };
  "governance.specification.rejected": {
    projectId: string;
    specId: string;
    reason: string;
    rejectedBy: string;
  };
  "governance.round.started": { projectId: string; roundN: number };
  "governance.round.completed": { projectId: string; roundN: number };
  "governance.round.transcript.overflow": {
    projectId: string;
    roundN: number;
    sizeBytes: number;
  };
  "governance.archetype.classified": {
    projectId: string;
    archetype: string;
    confidence: number;
  };
  "governance.offfrontier.escalated": {
    projectId: string;
    agentId: string;
    reason: string;
  };
  "governance.grandfathered.bypass": {
    projectId: string;
    bypassedGate: string;
    projectCreatedAt: string;
    effectiveAt: string;
  };
  // Wave 2.E: payload for governance.mode.transition. Emitted by the
  // setGovernanceMode resolver after a successful SSM write. previousMode
  // is the value read before the flip; newMode is the targetMode just
  // written. effectiveAtUpdated is true when the resolver also wrote the
  // companion effective_at parameter (first permissive→shadow/strict flip).
  "governance.mode.transition": {
    previousMode: string;
    newMode: string;
    env: string;
    reason: string | null;
    actorSub: string;
    timestamp: string;
    effectiveAtUpdated: boolean;
  };
  // Wave 4.C.2: payload for governance.constitutional.rule.changed.
  // Emitted by the rule-editor mutation handlers after a successful
  // rules write. `oldRule` is null for `add`; `newRule` is null for
  // `delete`. `ruleIndex` is the post-insert index for `add`, or the
  // affected index for `update` / `delete`. `oldRule` and `newRule`
  // surface the projected wire shape (JSON-encoded value, or null for
  // exists/not_exists) so downstream consumers see the same shape the
  // frontend renders.
  "governance.constitutional.rule.changed": {
    layerId: string;
    action: "add" | "update" | "delete";
    ruleIndex: number;
    oldRule: { field: string; operator: string; value: string | null } | null;
    newRule: { field: string; operator: string; value: string | null } | null;
    actorSub: string;
    timestamp: string;
  };
  // Wave 4.D.2: payload for governance.caselaw.changed. Emitted by the
  // case-law admin mutations (revoke / unrevoke / update-precedence).
  // `previousValue` and `newValue` capture the field-level delta so
  // downstream consumers can reconstruct the change without an extra
  // DDB read. For revoke / unrevoke, both are {revoked: boolean}; for
  // update-precedence, both are {precedence: number}.
  "governance.caselaw.changed": {
    caseId: string;
    action: "revoke" | "unrevoke" | "update-precedence";
    previousValue: Record<string, unknown>;
    newValue: Record<string, unknown>;
    reason: string | null;
    actorSub: string;
    timestamp: string;
  };
  // CIT-101: payload for governance.eval.suite.frozen. Emitted by
  // freezeEvalSuite after a successful DDB status write.
  "governance.eval.suite.frozen": {
    orgId: string;
    suiteId: string;
    frozenBy: string;
    version: number;
  };
  // CIT-102: payload for governance.eval.run.started. Emitted by the
  // eval-runner driver after the run row + per-case-result rows are
  // durably written and fan-out has begun.
  "governance.eval.run.started": {
    evalRunId: string;
    suiteId: string;
    suiteVersion: string;
    agentTargetId: string;
    agentTargetVersion: string;
    orgId: string;
    caseCount: number;
    startedAt: string;
    startedBy: string;
  };
  // CIT-102: payload for governance.eval.run.completed. Emitted when the
  // atomic pendingCases counter reaches zero. No scores — CIT-103 owns
  // verdicts; this is execution-outcome counts only.
  "governance.eval.run.completed": {
    evalRunId: string;
    suiteId: string;
    orgId: string;
    caseCounts: {
      total: number;
      completed: number;
      failed: number;
      timeout: number;
    };
    completedAt: string;
    durationMs: number;
  };
  // CIT-103 Pass A: payload for governance.eval.case.completed. Emitted
  // from recordCaseCompletion AFTER materializeArtifactIfCompleted, so
  // artifactRef (when materialization succeeded) is already stamped on
  // the case row by the time this fires. artifactRef is OPTIONAL here —
  // materialization degrades gracefully (never throws) and can leave it
  // unset; eval-case-scorer.ts must tolerate a missing artifactRef.
  "governance.eval.case.completed": {
    evalRunId: string;
    caseId: string;
    orgId: string;
    caseKind: "CONVERSATION" | "EXECUTION";
    artifactRef?: string;
  };
  // CIT-103 Pass A -> Pass B (FROZEN for Pass B, verbatim — see level-2
  // report). Emitted by eval-case-scorer.ts when a case opts into a
  // judge-basis dimension. judgeDimensions carries one entry per
  // judge-basis dimension the case requested (task_success and/or
  // groundedness_faithfulness in v1); rubric is a short deterministic
  // string describing what the judge must evaluate for that dimension
  // (NOT free-form user text — derived from the case's own expectedOutcome
  // target / groundingRequirements, so it is reproducible from the case
  // definition alone).
  "governance.eval.case.judge.requested": {
    evalRunId: string;
    caseId: string;
    orgId: string;
    artifactRef?: string;
    judgeDimensions: Array<{
      dimension: "task_success" | "groundedness_faithfulness";
      rubric: string;
    }>;
    judgeSlot: "judge";
  };
  // CIT-103 Pass B -> Pass A (FROZEN for Pass B, verbatim — see level-2
  // report). Emitted by the arbiter judge handler after invoking the
  // resolved "judge" slot model. status is SCORED when the judge returned
  // a usable verdict, UNKNOWN when the judge invocation itself failed /
  // returned unusable output (never fabricated as a failing score).
  // judgeModelId/judgeModelVersion/judgePromptHash are REQUIRED on every
  // event of this type (the reproducibility stamp, design §1) — the TS
  // consumer (eval-case-scorer.ts) validates their presence before
  // applying the patch and rejects (logs + drops) an event missing any of
  // the three. verdict is present iff status==='SCORED'.
  "governance.eval.case.judged": {
    evalRunId: string;
    caseId: string;
    orgId: string;
    dimension: "task_success" | "groundedness_faithfulness";
    status: "SCORED" | "UNKNOWN";
    verdict?: { kind: "score"; score: number };
    judgeModelId: string;
    judgeModelVersion: string;
    judgePromptHash: string;
  };
  // Phase 2 (production sampling): payload for governance.eval.sample.captured.
  // Emitted by eval-sampling-selector.ts once the sanitized artifact is
  // durably written. `dimensions` is the fixed allowlist this event
  // always carries (PROD_DIMENSION_ORDER in eval-prod-scoring.ts) —
  // deliberately excludes task_success/tool_accuracy.
  "governance.eval.sample.captured": {
    sampleId: string;
    orgId: string;
    agentId: string;
    runId: string;
    kind: "execution" | "conversation";
    artifactRef: string;
    dimensions: string[];
  };
  // Phase 3 (drift detection): payload for governance.eval.drift.detected.
  // Emitted by eval-drift-detector.ts on a threshold breach for one
  // (agentId, dimension) pair. `baseline`/`current` are the DimStat
  // shapes from eval-drift.ts (passRate XOR meanScore + sampleCount);
  // `delta` mirrors computeDrift's own DriftResult.delta (null when the
  // two windows were not comparable — never fabricated). `window` is
  // the CURRENT window's [from, to) hour-bucket bounds, used by
  // eval-drift-finding-writer.ts as part of its idempotency key.
  "governance.eval.drift.detected": {
    agentId: string;
    dimension: string;
    baseline: { passRate?: number; meanScore?: number; sampleCount: number };
    current: { passRate?: number; meanScore?: number; sampleCount: number };
    delta: number | null;
    window: { from: string; to: string };
  };
  // CIT-105: payload for governance.eval.baseline.designated.
  "governance.eval.baseline.designated": {
    orgId: string;
    agentTargetId: string;
    suiteId: string;
    baselineEvalRunId: string;
    previousBaselineEvalRunId?: string;
    designatedBy: string;
    at: string;
  };
  // CIT-105: payload for governance.eval.comparison.completed — the
  // machine-readable hand-off the future promotion gate subscribes to.
  // Carries only per-dimension-derived booleans/arrays/enum, no
  // dimension-collapsing number (design §9).
  "governance.eval.comparison.completed": {
    orgId: string;
    suiteId: string;
    comparisonId: string;
    baselineEvalRunId: string;
    candidateEvalRunIds: string[];
    anyMaterialRegression: boolean;
    materiallyRegressedDimensions: string[];
    unstableDimensions: string[];
    verdictStatus: string;
    at: string;
  };
  // Payload for governance.eval.seed.heal.blocked. `reason` distinguishes
  // the two conditions that can keep a stale seed row from healing.
  // "referenced" covers a DRAFT row with references.length > 0.
  // "not_draft" covers any non-DRAFT status blocking the heal
  // (FROZEN and ARCHIVED alike — both are terminal-mutability statuses
  // under assertSuiteMutable's DRAFT-only heal contract).
  "governance.eval.seed.heal.blocked": {
    suiteId: string;
    suiteName: string;
    status: string;
    referenceCount: number;
    reason: "not_draft" | "referenced" | "not_draft_and_referenced";
    seedVersion: number;
    attemptedSeedVersion: number;
  };
  // Auto-rollback (D6/§7): payload for governance.release.auto_rollback.
  // Carries the same machine-readable rollback evidence the ledger finding
  // records, so a subscriber sees metric/arm/observed-vs-threshold without
  // a ledger read.
  "governance.release.auto_rollback": {
    orgId: string;
    agentTargetId: string;
    environment: string;
    action: string;
    metric: string;
    observedValue: number;
    threshold: number;
    sampleCount: number;
    fromReleaseId: string;
    toReleaseId: string;
    candidateReleaseId: string;
    fromVersion: number;
  };
}

export type DetailPayloadOf<D extends GovernanceDetailType> =
  GovernancePayloadMap[D];

// Fail-closed sanitiser — strips tags (and their content) for the three most
// dangerous HTML embed vectors. Applied recursively across string fields only.
//
// This is plain-text stripping for a JSON-serialised event payload, NOT HTML
// rendering: the contract is "remove <script>/<iframe>/<object> markup, leave
// every other character (including bare `<`, `>`, `&`) byte-for-byte intact and
// be idempotent". A general HTML sanitiser (sanitize-html / DOMPurify) is
// deliberately NOT used here because it entity-encodes text (`<` -> `&lt;`,
// `&` -> `&amp;`), which would both mutate benign payload fields and break the
// idempotency contract that the unit + property tests enforce.
//
// Robustness fixes for CodeQL js/incomplete-multi-character-sanitization and
// js/bad-tag-filter:
//   * Each pass runs to a fixed point (loop until the string stops changing)
//     so a replacement cannot re-introduce a stripped construct via nesting or
//     overlap (e.g. "<scr<script>ipt>").
//   * Opening tags tolerate leading whitespace (`<  script`); closing tags
//     tolerate arbitrary junk before `>` (`</script foo>`), and stray /
//     unterminated openers are removed, so a malformed tag cannot bypass the
//     filter.
//   * `[\s\S]` is used for tag bodies/content so newlines cannot hide a tag.
const DANGEROUS_TAGS = "script|iframe|object";
// Balanced <tag …> … </tag …> block (content included). Backreference keeps
// the open/close tag names matched.
const PAIRED_TAG_RE = new RegExp(
  `<\\s*(${DANGEROUS_TAGS})\\b[^>]*>[\\s\\S]*?<\\s*\\/\\s*\\1\\b[^>]*>`,
  "gi",
);
// Any leftover opening or closing tag for the dangerous set, including an
// unterminated opener at end-of-input (trailing `>` optional).
const STRAY_TAG_RE = new RegExp(
  `<\\s*\\/?\\s*(?:${DANGEROUS_TAGS})\\b[^>]*>?`,
  "gi",
);

function sanitizeString(s: string): string {
  let out = s;
  let previous: string;
  do {
    previous = out;
    out = out.replace(PAIRED_TAG_RE, "").replace(STRAY_TAG_RE, "");
  } while (out !== previous);
  return out;
}

function sanitizeDeep<T>(value: T): T {
  if (typeof value === "string") return sanitizeString(value) as unknown as T;
  if (Array.isArray(value))
    return value.map((v) => sanitizeDeep(v)) as unknown as T;
  if (value && typeof value === "object") {
    const out: Record<string, unknown> = {};
    for (const [k, v] of Object.entries(value as Record<string, unknown>)) {
      out[k] = sanitizeDeep(v);
    }
    return out as unknown as T;
  }
  return value;
}

let _client: EventBridgeClient | null = null;
function ebClient(): EventBridgeClient {
  if (!_client) _client = new EventBridgeClient({});
  return _client;
}

// ---------------------------------------------------------------------------
// SNS notification projection (finding e396a7ee, design §2).
//
// Pure, unit-testable in isolation from any AWS SDK client. Builds a
// WHITELIST-projected Subject/Message pair for the CRITICAL subset of
// governance events — NEVER serialises the raw event.detail. Only the
// scalar fields explicitly listed per detail-type below are surfaced;
// any future/unexpected field on the payload (e.g. an accidentally
// added secret) is structurally excluded, not merely omitted by
// convention.
// ---------------------------------------------------------------------------

const SNS_SUBJECT_MAX = 100;
const SUMMARY_FIELD_MAX = 280;

export interface BuildNotificationMeta {
  env: string;
  eventId: string;
  eventTime: string;
  correlationId?: string;
  runId?: string;
  org?: string;
  governanceUiBaseUrl?: string;
}

/** Per-detail-type whitelist of scalar fields safe to surface in an SNS body. */
const SUMMARY_WHITELIST: Partial<
  Record<GovernanceDetailType, readonly string[]>
> = {
  "governance.offfrontier.escalated": ["projectId", "agentId", "reason"],
  "governance.release.auto_rollback": [
    "orgId",
    "agentTargetId",
    "environment",
    "action",
    "metric",
    "observedValue",
    "threshold",
    "sampleCount",
    "fromReleaseId",
    "toReleaseId",
    "candidateReleaseId",
    "fromVersion",
  ],
};

/** Per-detail-type deep-link route suffix (appended to governanceUiBaseUrl). */
const DEEP_LINK_ROUTE: Partial<Record<GovernanceDetailType, string>> = {
  "governance.offfrontier.escalated": "/governance/escalations",
  "governance.release.auto_rollback": "/governance/findings",
};

function truncate(s: string, max: number): string {
  return s.length > max ? s.slice(0, max) : s;
}

/**
 * Project only the whitelisted scalar fields for `detailType` out of an
 * arbitrary detail object, sanitised via the same fail-closed tag-stripper
 * used for EventBridge payloads. Any field NOT in the whitelist (including
 * one injected by a bug or an attacker) is structurally excluded — this is
 * a whitelist, not a blacklist.
 */
function projectSummaryFields(
  detailType: GovernanceDetailType,
  detail: Record<string, unknown>,
): string {
  const fields = SUMMARY_WHITELIST[detailType] ?? [];
  const parts: string[] = [];
  for (const field of fields) {
    const raw = detail[field];
    if (raw === undefined || raw === null) continue;
    const value =
      typeof raw === "string"
        ? truncate(sanitizeString(raw), SUMMARY_FIELD_MAX)
        : String(raw);
    parts.push(`${field}=${value}`);
  }
  return parts.join(", ");
}

/**
 * Build the SNS Subject + Message for a CRITICAL governance event.
 * Pure function — no AWS SDK calls, no I/O — so it is directly
 * unit-testable (see notifier-base.test.ts R8).
 *
 * NEVER serialises the raw `detail` object into the message; only the
 * per-detail-type whitelisted scalar fields (plus the always-safe
 * envelope metadata: detailType/env/org/correlationId/runId/eventId/
 * eventTime/deep-link) are included.
 */
export function buildGovernanceNotification(
  detailType: GovernanceDetailType,
  detail: Record<string, unknown>,
  meta: BuildNotificationMeta,
): { subject: string; body: string } {
  const org =
    meta.org ??
    (typeof detail.orgId === "string" ? detail.orgId : undefined) ??
    (typeof detail.org === "string" ? detail.org : undefined);

  const shortLabel = detailType.replace(/^governance\./, "");
  const subjectRaw = org
    ? `[Citadel ${meta.env}] ${shortLabel} — ${org}`
    : `[Citadel ${meta.env}] ${shortLabel}`;
  const subject = truncate(subjectRaw, SNS_SUBJECT_MAX);

  const route = DEEP_LINK_ROUTE[detailType];
  const deepLink = meta.governanceUiBaseUrl
    ? `${meta.governanceUiBaseUrl}${route ?? ""}`
    : "(governance UI URL not configured)";

  const summary = projectSummaryFields(detailType, detail);

  const lines = [
    `Governance event: ${detailType}`,
    `Environment: ${meta.env}`,
    `Organization: ${org ?? "n/a"}`,
    `Correlation/runId: ${meta.correlationId ?? meta.runId ?? "n/a"}`,
    `Time: ${meta.eventTime}`,
    `Summary: ${summary || "n/a"}`,
    `Details: ${deepLink}`,
    `EventId: ${meta.eventId}`,
  ];

  return { subject, body: lines.join("\n") };
}

/** Test-only: reset the cached EventBridge client. Do not call from production code. */
export function __resetGovernanceNotifierForTest(): void {
  _client = null;
}

export async function emitGovernanceEvent<D extends GovernanceDetailType>(
  detailType: D,
  detail: DetailPayloadOf<D>,
  correlationId?: string,
): Promise<void> {
  const sanitisedDetail = sanitizeDeep(detail);
  const envelope: Record<string, unknown> = {
    ...(sanitisedDetail as Record<string, unknown>),
    timestamp: new Date().toISOString(),
  };
  if (correlationId !== undefined) envelope.correlationId = correlationId;

  const command = new PutEventsCommand({
    Entries: [
      {
        Source: "citadel.backend",
        DetailType: detailType,
        Detail: JSON.stringify(envelope),
        EventBusName: process.env.EVENT_BUS_NAME || "default",
      },
    ],
  });
  await ebClient().send(command);
}
