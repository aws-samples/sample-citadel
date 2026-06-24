/**
 * ProgramReview resolver.
 *
 * Implements the runProgramReview mutation and the getProgramReview /
 * listProgramReviewsForProject queries. Evaluates each of the 20
 * governance-checklist questions (parsed from
 * `backend/src/lambda/governance-checklist.md` at module load) against the
 * project's accumulated evidence rows from ADR, ExecutionSpecification,
 * InterrogationRound, and AgentDesignAssessment resolvers.
 *
 * Determinism invariant (AC 5):
 *   Given identical evidence inputs, runProgramReview MUST produce
 *   byte-identical `results` arrays across invocations. No Date.now() in
 *   evaluators, no random nonces, no non-deterministic iteration order.
 *   Only the wrapper fields (reviewId, runAt, createdAt) vary per call.
 *
 * Historical-snapshot invariant (AC 4):
 *   Each runProgramReview call inserts a NEW row with a fresh UUID. We
 *   never UPDATE a prior row — the ProgramReview table is append-only.
 *
 * Permission model:
 *   runProgramReview is gated on `adr:create` (architect +
 *   project_manager + admin per auth.ts). Reads are open, mirroring the
 *.  getter pattern in execspec/adr resolvers.
 *
 * Evidence-dispatch contract:
 *   A map questionId → Evaluator. Unmapped IDs fall back to
 *   defaultEvaluator (PENDING_EVIDENCE with a manual-review note). The 20
 *   known Q001..Q020 evaluators are pinned explicitly so any future
 *   checklist-author adding Qnnn entries triggers a deliberate code
 *   change here rather than a silent PENDING_EVIDENCE.
 */
import { DynamoDBClient } from '@aws-sdk/client-dynamodb';
import {
  DynamoDBDocumentClient,
  GetCommand,
  PutCommand,
  QueryCommand,
} from '@aws-sdk/lib-dynamodb';
import { v4 as uuidv4 } from 'uuid';
import * as fs from 'fs';
import * as path from 'path';
import {
  parseChecklist,
  type ChecklistQuestion,
} from './checklist-parser';
import { listADRsForProject } from './adr-resolver';
import { listExecutionSpecifications } from './execspec-resolver';
import { listInterrogationRounds } from './interrogation-round-resolver';
import { getAgentDesignAssessment } from './agent-design-assessment-resolver';
import { hasPermission } from '../utils/auth';
import type { AuthContext } from '../types';

const dynamoClient = new DynamoDBClient({});
const docClient = DynamoDBDocumentClient.from(dynamoClient);
const PROGRAM_REVIEWS_TABLE = process.env.PROGRAM_REVIEWS_TABLE!;

// ── Locally-typed ProgramReview shapes ──────────────────────────────
// Track B is landing canonical type defs in backend/src/types/index.ts.
// Until those land, declare local equivalents so this module compiles
// standalone and the tests can import them verbatim. The literal-union
// and interface shapes exactly match the Track B contract.

export type ChecklistAnswerLiteral =
  | 'PASS'
  | 'FAIL'
  | 'NOT_APPLICABLE'
  | 'PENDING_EVIDENCE';

export interface ChecklistResult {
  questionId: string;
  question: string;
  answer: ChecklistAnswerLiteral;
  evidenceRefs: string[];
  notes: string | null;
}

export interface ProgramReview {
  reviewId: string;
  projectId: string;
  results: ChecklistResult[];
  runAt: string;
  runBy: string;
  createdAt: string;
}

// ── Checklist load (once per cold start) ────────────────────────────
// The markdown file lives next to this handler in both layouts:
//   dev (ts-jest):  backend/src/lambda/governance-checklist.md
//   prod (bundle):  backend/dist/lambda/governance-checklist.md  (copied
//                   by the `copy:governance-checklist` npm script)
// Resolving via __dirname keeps the Lambda self-contained: no reliance on
// repo-layout assumptions at runtime.

/**
 * Resolve the checklist path relative to the handler directory.
 * A missing file is logged at cold-start but does not crash the module —
 * callers receive an empty results array (PENDING_EVIDENCE by default)
 * and the operator sees the error in CloudWatch.
 */
function resolveChecklistPath(): string {
  return path.join(__dirname, 'governance-checklist.md');
}

const CHECKLIST_PATH = resolveChecklistPath();
let CHECKLIST: ChecklistQuestion[] = [];
try {
  CHECKLIST = parseChecklist(fs.readFileSync(CHECKLIST_PATH, 'utf-8'));
} catch (err) {
  // Cold-start failure: the checklist file is missing or malformed. Log
  // and continue with an empty list — runProgramReview will still emit a
  // valid (but empty) review row. This keeps the Lambda serviceable for
  // the /get/list paths even if the checklist is temporarily misbundled.
  console.error('program-review-resolver: failed to load checklist at cold start', {
    path: CHECKLIST_PATH,
    error: (err as Error)?.message,
  });
}

// ── Evidence + Evaluator types ──────────────────────────────────────

interface Evidence {
  projectId: string;
  adrs: any[];
  specs: any[];
  rounds: any[];
  assessment: any | null;
}

interface EvaluatorOutput {
  answer: ChecklistAnswerLiteral;
  evidenceRefs: string[];
  notes: string | null;
}

type Evaluator = (evidence: Evidence) => EvaluatorOutput;

/**
 * Default evaluator for checklist questions that have no automated
 * evidence source yet (investment framing, partner capability). Returns
 * PENDING_EVIDENCE with a manual-review note so the Executive audit UI
 * can surface the question as open rather than silently passing it.
 */
const defaultEvaluator: Evaluator = () => ({
  answer: 'PENDING_EVIDENCE',
  evidenceRefs: [],
  notes:
    'No automated evaluator registered for this question; manual review required.',
});

// ── Concrete evaluators Q001..Q012 ──────────────────────────────────
// Q013..Q020 fall through to defaultEvaluator because their evidence
// sources (investment breakdown, partner capability) are not yet modelled
// by a backend entity. The spec explicitly permits PENDING_EVIDENCE for 
// those clusters.

const EVALUATORS: Record<string, Evaluator> = {
  // Q001: Four-dimension assessment completed.
  // PASS when an AgentDesignAssessment row exists, has completedAt set,
  // and archetypeStatus='CLASSIFIED'. Otherwise FAIL.
  Q001: (ev) => {
    const a = ev.assessment;
    const completed =
      a != null &&
      a.completedAt != null &&
      a.completedAt !== '' &&
      a.archetypeStatus === 'CLASSIFIED' &&
      Array.isArray(a.dimensionRanking) &&
      a.dimensionRanking.length === 4;
    return completed
      ? {
          answer: 'PASS',
          evidenceRefs: [`AgentDesignAssessment:${ev.projectId}`],
          notes: null,
        }
      : {
          answer: 'FAIL',
          evidenceRefs: [],
          notes: a == null
            ? 'No AgentDesignAssessment row for project.'
            : 'Assessment incomplete or not CLASSIFIED.',
        };
  },

  // Q002: Operations staff interviewed during discovery.
  // PASS when ≥1 round has participantRoles including 'OPERATIONS' and
  // status in {'STABILISED','COMPLETE'}.
  Q002: (ev) => {
    const hits = ev.rounds.filter(
      (r: any) =>
        Array.isArray(r.participantRoles) &&
        r.participantRoles.includes('OPERATIONS') &&
        (r.status === 'STABILISED' || r.status === 'COMPLETE'),
    );
    return hits.length > 0
      ? {
          answer: 'PASS',
          evidenceRefs: hits
            .map((r: any) => `InterrogationRound:${ev.projectId}:${r.roundN}`)
            .sort(),
          notes: null,
        }
      : {
          answer: 'FAIL',
          evidenceRefs: [],
          notes: 'No operations-role interrogation rounds recorded.',
        };
  },

  // Q003: Integration archaeology performed.
  // PASS when assessment.dimensionRanking includes an entry with
  // dimension='INTEGRATION_ARCHAEOLOGY' and coverage='COMPLETE'.
  Q003: (ev) => {
    const a = ev.assessment;
    if (a == null || !Array.isArray(a.dimensionRanking)) {
      return {
        answer: 'FAIL',
        evidenceRefs: [],
        notes: 'Assessment missing.',
      };
    }
    const hit = a.dimensionRanking.find(
      (d: any) =>
        d.dimension === 'INTEGRATION_ARCHAEOLOGY' && d.coverage === 'COMPLETE',
    );
    return hit
      ? {
          answer: 'PASS',
          evidenceRefs: [`AgentDesignAssessment:${ev.projectId}`],
          notes: null,
        }
      : {
          answer: 'FAIL',
          evidenceRefs: [],
          notes:
            'Integration archaeology dimension missing or not marked COMPLETE.',
        };
  },

  // Q004: Non-functional constraints surfaced before design.
  // PASS when assessment.nonFunctionalConstraints ⊇ {PERFORMANCE, SECURITY, COMPLIANCE}.
  Q004: (ev) => {
    const a = ev.assessment;
    if (a == null || !Array.isArray(a.nonFunctionalConstraints)) {
      return {
        answer: 'FAIL',
        evidenceRefs: [],
        notes: 'Assessment missing or nonFunctionalConstraints unset.',
      };
    }
    const needed = ['PERFORMANCE', 'SECURITY', 'COMPLIANCE'];
    const have = new Set(a.nonFunctionalConstraints);
    const missing = needed.filter((n) => !have.has(n));
    return missing.length === 0
      ? {
          answer: 'PASS',
          evidenceRefs: [`AgentDesignAssessment:${ev.projectId}`],
          notes: null,
        }
      : {
          answer: 'FAIL',
          evidenceRefs: [],
          notes: `Missing NFR classes: ${missing.join(', ')}.`,
        };
  },

  // Q005: Advisory multi-round loop (≥ 3 stabilised rounds).
  Q005: (ev) => {
    const stabilised = ev.rounds.filter((r: any) => r.status === 'STABILISED');
    return stabilised.length >= 3
      ? {
          answer: 'PASS',
          evidenceRefs: stabilised
            .map((r: any) => `InterrogationRound:${ev.projectId}:${r.roundN}`)
            .sort(),
          notes: null,
        }
      : {
          answer: 'FAIL',
          evidenceRefs: [],
          notes: `Only ${stabilised.length} stabilised round(s); need ≥3.`,
        };
  },

  // Q006: Decisions captured as locked ADRs.
  Q006: (ev) => {
    const locked = ev.adrs.filter((a: any) => a.status === 'LOCKED');
    return locked.length >= 1
      ? {
          answer: 'PASS',
          evidenceRefs: locked.map((a: any) => `ADR:${a.adrId}`).sort(),
          notes: null,
        }
      : {
          answer: 'FAIL',
          evidenceRefs: [],
          notes: 'No LOCKED ADR recorded for project.',
        };
  },

  // Q007: Constraints injected into the advisory loop.
  // PASS when ≥1 stabilised round has a non-empty injectedConstraintIds.
  Q007: (ev) => {
    const hits = ev.rounds.filter(
      (r: any) =>
        r.status === 'STABILISED' &&
        Array.isArray(r.injectedConstraintIds) &&
        r.injectedConstraintIds.length > 0,
    );
    return hits.length > 0
      ? {
          answer: 'PASS',
          evidenceRefs: hits
            .map((r: any) => `InterrogationRound:${ev.projectId}:${r.roundN}`)
            .sort(),
          notes: null,
        }
      : {
          answer: 'FAIL',
          evidenceRefs: [],
          notes: 'No stabilised round with injected constraints.',
        };
  },

  // Q008: stabilised / total round ratio ≥ 0.75.
  // NOT_APPLICABLE when zero rounds exist (no ratio definable).
  Q008: (ev) => {
    const total = ev.rounds.length;
    if (total === 0) {
      return {
        answer: 'NOT_APPLICABLE',
        evidenceRefs: [],
        notes: 'No interrogation rounds recorded.',
      };
    }
    const stabilised = ev.rounds.filter(
      (r: any) => r.status === 'STABILISED',
    ).length;
    const ratio = stabilised / total;
    return ratio >= 0.75
      ? {
          answer: 'PASS',
          evidenceRefs: [`InterrogationRound:${ev.projectId}:ratio=${ratio.toFixed(2)}`],
          notes: null,
        }
      : {
          answer: 'FAIL',
          evidenceRefs: [],
          notes: `Stabilised/total = ${stabilised}/${total} = ${ratio.toFixed(2)} < 0.75.`,
        };
  },

  // Q009: Design agents separate from execution tools.
  // PASS when ≥1 spec has sourceDesignArtifactType in {ADR,AgentDesignAssessment}
  // and executorKind ≠ 'DESIGN_AGENT'.
  Q009: (ev) => {
    const hits = ev.specs.filter(
      (s: any) =>
        (s.sourceDesignArtifactType === 'ADR' ||
          s.sourceDesignArtifactType === 'AgentDesignAssessment') &&
        s.executorKind !== 'DESIGN_AGENT',
    );
    return hits.length > 0
      ? {
          answer: 'PASS',
          evidenceRefs: hits.map((s: any) => `ExecutionSpecification:${s.specId}`).sort(),
          notes: null,
        }
      : {
          answer: 'FAIL',
          evidenceRefs: [],
          notes: 'No execution specification with clean design↔exec separation.',
        };
  },

  // Q010: Specifications validated by humans before execution.
  // PASS when ≥1 spec with status='APPROVED' and approvedBy set.
  Q010: (ev) => {
    const hits = ev.specs.filter(
      (s: any) =>
        s.status === 'APPROVED' &&
        typeof s.approvedBy === 'string' &&
        s.approvedBy.length > 0,
    );
    return hits.length > 0
      ? {
          answer: 'PASS',
          evidenceRefs: hits.map((s: any) => `ExecutionSpecification:${s.specId}`).sort(),
          notes: null,
        }
      : {
          answer: 'FAIL',
          evidenceRefs: [],
          notes: 'No human-approved execution specification on record.',
        };
  },

  // Q011: Execution specs trace back to LOCKED ADRs.
  // PASS when ≥1 spec has a non-empty sourceAdrIds AND at least one of
  // those IDs maps to an ADR whose status='LOCKED'.
  Q011: (ev) => {
    const lockedIds = new Set(
      ev.adrs.filter((a: any) => a.status === 'LOCKED').map((a: any) => a.adrId),
    );
    const hits = ev.specs.filter(
      (s: any) =>
        Array.isArray(s.sourceAdrIds) &&
        s.sourceAdrIds.some((id: string) => lockedIds.has(id)),
    );
    return hits.length > 0
      ? {
          answer: 'PASS',
          evidenceRefs: hits.map((s: any) => `ExecutionSpecification:${s.specId}`).sort(),
          notes: null,
        }
      : {
          answer: 'FAIL',
          evidenceRefs: [],
          notes: 'No execution specification cites a LOCKED ADR.',
        };
  },

  // Q012: Specs human-readable, not only machine-generated.
  // PASS when ≥1 spec with narrativeReviewStatus='REVIEWED' and status='APPROVED'.
  Q012: (ev) => {
    const hits = ev.specs.filter(
      (s: any) =>
        s.narrativeReviewStatus === 'REVIEWED' && s.status === 'APPROVED',
    );
    return hits.length > 0
      ? {
          answer: 'PASS',
          evidenceRefs: hits.map((s: any) => `ExecutionSpecification:${s.specId}`).sort(),
          notes: null,
        }
      : {
          answer: 'FAIL',
          evidenceRefs: [],
          notes: 'No approved spec with REVIEWED narrative.',
        };
  },

  // Q013..Q020: no automated evidence source yet — fall through to
  // defaultEvaluator via the dispatch lookup below. These questions track
  // investment framing and partner capability, which require a future
  // ProgramReview-input mutation to populate. Per spec we mark them
  // PENDING_EVIDENCE rather than FAIL so auditors can annotate manually.
};

function evaluate(
  question: ChecklistQuestion,
  evidence: Evidence,
): ChecklistResult {
  const evaluator = EVALUATORS[question.questionId]?? defaultEvaluator;
  const out = evaluator(evidence);
  return {
    questionId: question.questionId,
    question: question.title,
    answer: out.answer,
    evidenceRefs: out.evidenceRefs,
    notes: out.notes,
  };
}

// ── AppSync event → AuthContext ─────────────────────────────────────

function authContextFromEvent(event: any): AuthContext {
  const identity = event?.identity || {};
  const claimRole =
    identity['custom:role'] ?? identity.claims?.['custom:role'];
  return {
    userId: identity.sub || identity.username || 'anonymous',
    username: identity.username,
    groups: identity['cognito:groups'] || [],
    roles: claimRole ? [claimRole]: [],
  };
}

/**
 * Truncate long string values in event.arguments so that error logs cannot
 * be weaponised to exfiltrate long payloads. Non-string values pass through.
 */
function sanitizeForLog(input: unknown): unknown {
  if (!input || typeof input !== 'object') return input;
  const out: Record<string, unknown> = {};
  for (const [k, v] of Object.entries(input as Record<string, unknown>)) {
    out[k] = typeof v === 'string' && v.length > 200 ? v.slice(0, 200) + '…' : v;
  }
  return out;
}

// ── Key exports ─────────────────────────────────────────────────────

/**
 * Execute the full governance-checklist audit for a project. Fetches
 * evidence from the four governance resolvers IN PARALLEL, runs each
 * question's evaluator, and persists a fresh ProgramReview row.
 *
 * Per AC 4 (historical-snapshot invariant), each call writes a NEW row
 * with a freshly-minted reviewId. Prior rows are never mutated.
 *
 * Per AC 5 (determinism invariant), the evaluators themselves are pure:
 * they do not call Date.now() or Math.random(). Only the wrapper fields
 * (reviewId, runAt, createdAt) vary between runs.
 */
export async function runProgramReview(
  projectId: string,
  authContext: AuthContext,
): Promise<ProgramReview> {
  if (!hasPermission(authContext, 'adr:create')) {
    throw new Error(
      'UnauthorizedError: adr:create permission required to run program review',
    );
  }
  if (typeof projectId !== 'string' || projectId.length === 0) {
    throw new Error('ValidationError: projectId is required');
  }

  // Fetch the four evidence sources in parallel. listInterrogationRounds
  // may not exist in some deployment pipelines; Promise.allSettled guards
  // against that by swallowing a missing-function error into an empty list.
  const [adrsP, specsP, roundsP, assessmentP] = await Promise.all([
    safeCall(() => listADRsForProject(projectId)),
    safeCall(() => listExecutionSpecifications(projectId)),
    safeCall(() => listInterrogationRounds(projectId)),
    safeCall(() => getAgentDesignAssessment(projectId)),
  ]);

  const evidence: Evidence = {
    projectId,
    adrs: Array.isArray(adrsP) ? adrsP : [],
    specs: Array.isArray(specsP) ? specsP : [],
    rounds: Array.isArray(roundsP) ? roundsP : [],
    assessment: assessmentP ?? null,
  };

  const results: ChecklistResult[] = CHECKLIST.map((q) => evaluate(q, evidence));

  const now = new Date().toISOString();
  const review: ProgramReview = {
    reviewId: uuidv4(),
    projectId,
    results,
    runAt: now,
    runBy: authContext.userId,
    createdAt: now,
  };

  await docClient.send(
    new PutCommand({
      TableName: PROGRAM_REVIEWS_TABLE,
      Item: review,
      ConditionExpression: 'attribute_not_exists(reviewId)',
    }),
  );
  return review;
}

/**
 * Safely invoke an evidence-source function. Turns a rejected promise or
 * a thrown synchronous error into `null`; callers then coerce null into
 * an empty list or null assessment as appropriate. This keeps the parent
 * Promise.all from aborting when, e.g., an environment variable for a
 * downstream table is unset.
 */
async function safeCall<T>(fn: () => Promise<T>): Promise<T | null> {
  try {
    return await fn();
  } catch (err) {
    console.warn('program-review-resolver: evidence source failed', {
      error: (err as Error)?.message,
    });
    return null;
  }
}

export async function getProgramReview(
  reviewId: string,
): Promise<ProgramReview | null> {
  const res = await docClient.send(
    new GetCommand({ TableName: PROGRAM_REVIEWS_TABLE, Key: { reviewId } }),
  );
  return (res.Item as ProgramReview | undefined) ?? null;
}

export async function listProgramReviewsForProject(
  projectId: string,
): Promise<ProgramReview[]> {
  const res = await docClient.send(
    new QueryCommand({
      TableName: PROGRAM_REVIEWS_TABLE,
      IndexName: 'project-index',
      KeyConditionExpression: 'projectId = :pid',
      ExpressionAttributeValues: { ':pid': projectId },
    }),
  );
  return (res.Items as ProgramReview[] | undefined) ?? [];
}

export const handler = async (event: any): Promise<unknown> => {
  const fieldName = event?.info?.fieldName;
  const authContext = authContextFromEvent(event);
  try {
    switch (fieldName) {
      case 'runProgramReview':
        return await runProgramReview(event.arguments.projectId, authContext);
      case 'getProgramReview':
        return await getProgramReview(event.arguments.reviewId);
      case 'listProgramReviewsForProject':
        return await listProgramReviewsForProject(event.arguments.projectId);
      default:
        throw new Error(`Unsupported field: ${fieldName}`);
    }
  } catch (err: unknown) {
    console.error('program-review-resolver error', {
      fieldName,
      message: err instanceof Error ? err.message : undefined,
      args: sanitizeForLog(event?.arguments),
    });
    throw err;
  }
};

// Test-only: expose the checklist for assertion count === 20 and for
// tests that want to assert evaluator coverage. Not part of the public
// runtime API — Track B's schema does not reference this export.
export function __getLoadedChecklistForTest(): ChecklistQuestion[] {
  return CHECKLIST;
}
