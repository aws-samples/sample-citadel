/**
 * Governance UI resolver — Wave 1 + Wave 2.A + Wave 2.B.
 *
 * AppSync resolver backing the five queries defined in
 * .kiro/specs/governance-ui/graphql-contract.md:
 *   - getGovernanceMode      (any authenticated user; fail-open per contract)
 *   - listGovernanceFindings (any authenticated user; GSI Query when workflowId is set, else Scan)
 *   - getGovernanceFinding   (any authenticated user; returns null on miss)
 *   - getReconcilerStatus    (admin only; returns zero defaults when SSM blob is absent or unparseable)
 *   - getRolloutReadiness    (admin only; 11-check readiness report)
 *
 * The ledger DynamoDB table is owned by ArbiterStack (`citadel-governance-ledger-{env}`),
 * which is also where this Lambda is wired so cross-stack cycles with BackendStack
 * are avoided. See backend/lib/arbiter-stack.ts for the L1 CfnDataSource pattern.
 *
 * Wave 2.B: data-2, data-3, tel-1, tel-2, tel-3, rb-1 are real checks; the
 * remaining four (rb-2, own-1, own-2, own-3) stay as STUB and require a
 * human "mark verified" action that ships in Wave 2.B.2.
 */
import { AppSyncResolverEvent } from 'aws-lambda';
import { DynamoDBClient } from '@aws-sdk/client-dynamodb';
import {
  DynamoDBDocumentClient,
  GetCommand,
  PutCommand,
  QueryCommand,
  ScanCommand,
  UpdateCommand,
} from '@aws-sdk/lib-dynamodb';
import {
  SSMClient,
  GetParameterCommand,
  GetParameterHistoryCommand,
  PutParameterCommand,
} from '@aws-sdk/client-ssm';
import {
  CloudWatchClient,
  GetMetricStatisticsCommand,
} from '@aws-sdk/client-cloudwatch';
import {
  IAMClient,
  GetRolePolicyCommand,
} from '@aws-sdk/client-iam';
import {
  STSClient,
  GetCallerIdentityCommand,
} from '@aws-sdk/client-sts';

import {
  getGovernanceEnforce,
  getGovernanceEffectiveAt,
} from '../utils/governance-flag';
import { isAdminFromEvent } from '../utils/auth-event';
import {
  emitGovernanceEvent,
} from '../utils/notifier-base';
import {
  RegistryService,
  TypeMismatchError,
  type AgentCustomMetadata,
  type ToolCustomMetadata,
  type RegistryRecord,
} from '../services/registry-service';
import { PolicyManager, type PolicyScope } from '../utils/policy-manager';
import { getUnifiedRegistry } from '../adapters/registry';
import {
  fetchTrustPathHop,
  parseTrustPolicyPrincipals,
  projectInlinePolicyDocument,
  extractCrossAccountRoleArn,
} from '../utils/trust-path';
// Re-export the pure trust-path helpers from their original module path so
// existing importers (governance-ui-resolver.test.ts) keep working unchanged.
// The IAM-fetch + hop projection now lives in ../utils/trust-path; getTrustPath
// delegates its per-hop work there (behaviour-preserving — Wave 5.C.1).
export {
  parseTrustPolicyPrincipals,
  projectInlinePolicyDocument,
  extractCrossAccountRoleArn,
};

// --- Clients ---

const dynamodb = DynamoDBDocumentClient.from(new DynamoDBClient({}));
const ssm = new SSMClient({});
const cloudwatch = new CloudWatchClient({});
const iam = new IAMClient({});
const sts = new STSClient({});

// --- Constants ---

const DEFAULT_LIMIT = 50;
const MAX_LIMIT = 200;

// data-2 sample size — see runDataIntegrityChecks. The runbook (item 2 of
// the readiness checklist) recommends ≥50 random units; we cap at exactly 50
// so that a worst-case 50 × GetRegistryRecord round-trips fit inside the
// AppSync resolver timeout.
const DATA_TWO_SAMPLE_SIZE = 50;

// Allowlist for rb-1 — mirrors backend/src/utils/governance-flag.ts.
const VALID_ENFORCE_VALUES: ReadonlySet<string> = new Set([
  'permissive',
  'shadow',
  'strict',
]);

// ---------------------------------------------------------------------------
// Wave 3.B — decision flow tracer pipeline metadata
// ---------------------------------------------------------------------------
//
// The 8-step pipeline mirrors arbiter/governance/engine.py:evaluate(). Step 2
// is reserved (a US-ARB-005 scaffold replaced by step 6 in US-ARB-006) and
// always renders pass-through. Default detail strings are concise one-line
// descriptions matching the engine.py module docstring; per-step status and
// per-step inputs/outputs are derived per request inside getDecisionTrace.
const PIPELINE_STEPS: ReadonlyArray<{
  stepNumber: number;
  name: string;
  defaultDetail: string;
}> = [
  {
    stepNumber: 1,
    name: 'Case-law lookup',
    defaultDetail:
      'First match in precedence-sorted case law; on PERMIT, step 8 may still override.',
  },
  {
    stepNumber: 2,
    name: 'Composition arbitration scaffold',
    defaultDetail: 'Scaffolded; replaced by step 6 in US-ARB-006',
  },
  {
    stepNumber: 3,
    name: 'Covering-unit discovery',
    defaultDetail:
      'Discover authority units bound to the requesting agent (or platform-wide) that cover the request.',
  },
  {
    stepNumber: 4,
    name: 'Residual-authority denial check',
    defaultDetail:
      'No covering unit means no residual authority — deny by default.',
  },
  {
    stepNumber: 5,
    name: 'Tightest-scope selection',
    defaultDetail:
      'Pick the highest-specificity covering unit, breaking ties by lexicographic unit_id.',
  },
  {
    stepNumber: 6,
    name: 'Composition evaluation',
    defaultDetail:
      'Apply the four arbitration patterns (deferred/unilateral/rivalrous/collaborative).',
  },
  {
    stepNumber: 7,
    name: 'Single-domain permit',
    defaultDetail:
      'No contract governs the request — permit on the tightest matching scope.',
  },
  {
    stepNumber: 8,
    name: 'Constitutional review',
    defaultDetail:
      'Override a permit to deny when any constitutional invariant is violated.',
  },
] as const;

type DecisionTraceStepStatus =
  | 'matched'
  | 'skipped'
  | 'pass-through'
  | 'denied'
  | 'permitted'
  | 'escalated'
  | 'overridden';

interface DecisionTraceStepProjected {
  stepNumber: number;
  name: string;
  status: DecisionTraceStepStatus | string;
  inputs: string;
  outputs: string | null;
  detail: string;
}

interface DecisionTraceProjected {
  findingId: string;
  finding: GovernanceFindingProjected;
  steps: DecisionTraceStepProjected[];
  terminalDecision: string;
  terminalStepNumber: number;
  reasonTokens: string[];
  constitutionalOverride: boolean;
  arbitrationPattern: string | null;
  scopeReduction: string | null;
}

const ARBITRATION_PATTERN_PREFIXES: ReadonlySet<string> = new Set([
  'deferred_authority',
  'unilateral_sovereignty',
  'rivalrous_claim',
  'collaborative_composition',
]);

// --- Types ---

interface ListFindingsArgs {
  limit?: number | null;
  cursor?: string | null;
  decision?: string | null;
  workflowId?: string | null;
  sinceTs?: number | null;
}

interface GetFindingArgs {
  findingId: string;
}

interface GovernanceFindingProjected {
  findingId: string;
  workflowId: string;
  decision: string;
  reason: string;
  requestingAgent: string;
  targetAgent: string;
  scopeEvaluated: string | null;
  contractEvaluated: string | null;
  escalationTarget: string | null;
  residualAuthorityDenial: boolean | null;
  timestamp: number;
}

interface ReconcilerClassification {
  inSync: number;
  missing: number;
  stale: number;
  orphan: number;
}

interface ReconcilerStatus {
  lastRunAt: string | null;
  lastRunMode: string | null;
  classifications: ReconcilerClassification;
  totalRecords: number;
}

// --- Wave 2.A: rollout readiness types ---

type ReadinessCheckStatus = 'PASS' | 'FAIL' | 'WARN' | 'UNKNOWN' | 'STUB';

interface ReadinessCheck {
  id: string;
  label: string;
  status: ReadinessCheckStatus;
  detail: string | null;
  evidence: string | null;
  category: string;
}

interface RolloutReadinessReport {
  generatedAt: number;
  currentMode: string;
  effectiveAt: string | null;
  env: string;
  shadowSoakStartedAt: string | null;
  checks: ReadinessCheck[];
  passCount: number;
  failCount: number;
  warnCount: number;
  stubCount: number;
}

// DDB rows are written in snake_case by the Python ledger writer; declared as
// Record<string, unknown> rather than `any` so the projection step is the only
// place that does the snake → camel translation.
type DdbRow = Record<string, unknown>;

// --- Helpers ---

function zeroReconcilerStatus(): ReconcilerStatus {
  return {
    lastRunAt: null,
    lastRunMode: null,
    classifications: { inSync: 0, missing: 0, stale: 0, orphan: 0 },
    totalRecords: 0,
  };
}

function isReconcilerStatusShape(value: unknown): value is ReconcilerStatus {
  if (!value || typeof value !== 'object') return false;
  const v = value as Record<string, unknown>;
  const c = v.classifications as Record<string, unknown> | undefined;
  if (!c || typeof c !== 'object') return false;
  return (
    typeof c.inSync === 'number' &&
    typeof c.missing === 'number' &&
    typeof c.stale === 'number' &&
    typeof c.orphan === 'number' &&
    typeof v.totalRecords === 'number'
  );
}

function asStringOrNull(v: unknown): string | null {
  return typeof v === 'string' && v.length > 0 ? v : null;
}

function asBoolOrNull(v: unknown): boolean | null {
  return typeof v === 'boolean' ? v : null;
}

/**
 * Maps a DDB ledger row (snake_case attributes) to the GraphQL
 * `GovernanceFinding` shape (camelCase fields). Missing string fields
 * become empty strings for required scalars; missing nullable fields
 * become null; the timestamp coerces to Number (DDB stores it as N).
 */
export function projectFinding(row: DdbRow): GovernanceFindingProjected {
  const tsRaw = row.timestamp;
  const timestamp =
    typeof tsRaw === 'number'
      ? tsRaw
      : typeof tsRaw === 'string'
        ? Number(tsRaw)
        : 0;

  return {
    findingId: typeof row.findingId === 'string' ? row.findingId : '',
    workflowId: typeof row.workflowId === 'string' ? row.workflowId : '',
    decision: typeof row.decision === 'string' ? row.decision : '',
    reason: typeof row.reason === 'string' ? row.reason : '',
    requestingAgent:
      typeof row.requesting_agent === 'string' ? row.requesting_agent : '',
    targetAgent:
      typeof row.target_agent === 'string' ? row.target_agent : '',
    scopeEvaluated: asStringOrNull(row.scope_evaluated),
    contractEvaluated: asStringOrNull(row.contract_evaluated),
    escalationTarget: asStringOrNull(row.escalation_target),
    residualAuthorityDenial: asBoolOrNull(row.residual_authority_denial),
    timestamp,
  };
}

function decodeCursor(cursor: string | null | undefined): Record<string, unknown> | undefined {
  if (!cursor) return undefined;
  try {
    const decoded = Buffer.from(cursor, 'base64').toString('utf8');
    const parsed = JSON.parse(decoded);
    // Validate shape: must be a non-null object with a string `findingId`
    // (the ledger table's primary key, used as DDB ExclusiveStartKey).
    // A malformed cursor falls through to the first page rather than
    // throwing an opaque DDB error downstream.
    if (
      parsed === null ||
      typeof parsed !== 'object' ||
      Array.isArray(parsed) ||
      typeof (parsed as Record<string, unknown>).findingId !== 'string'
    ) {
      console.warn('decodeCursor: malformed cursor, ignoring');
      return undefined;
    }
    return parsed as Record<string, unknown>;
  } catch {
    return undefined;
  }
}

function encodeCursor(key: Record<string, unknown> | undefined): string | null {
  if (!key) return null;
  return Buffer.from(JSON.stringify(key), 'utf8').toString('base64');
}

function clampLimit(raw: number | null | undefined): number {
  if (typeof raw !== 'number' || !Number.isFinite(raw) || raw <= 0) {
    return DEFAULT_LIMIT;
  }
  return Math.min(Math.floor(raw), MAX_LIMIT);
}

// --- Query handlers ---

async function getGovernanceMode(): Promise<{
  enforce: string;
  effectiveAt: string | null;
  env: string;
}> {
  const env = process.env.ENVIRONMENT || 'unknown';
  try {
    const [enforce, effectiveAt] = await Promise.all([
      getGovernanceEnforce(env),
      getGovernanceEffectiveAt(env),
    ]);
    return { enforce, effectiveAt, env };
  } catch (err) {
    console.error('getGovernanceMode: fail-open', err);
    return { enforce: 'permissive', effectiveAt: null, env };
  }
}

async function listGovernanceFindings(args: ListFindingsArgs): Promise<{
  items: GovernanceFindingProjected[];
  nextCursor: string | null;
}> {
  const tableName = process.env.GOVERNANCE_LEDGER_TABLE;
  if (!tableName) {
    throw new Error('GOVERNANCE_LEDGER_TABLE env var is not set');
  }

  const limit = clampLimit(args.limit);
  const exclusiveStartKey = decodeCursor(args.cursor);

  let result: { Items?: DdbRow[]; LastEvaluatedKey?: Record<string, unknown> };

  if (args.workflowId) {
    // GSI Query path — significantly cheaper than a Scan.
    const expressionAttributeValues: Record<string, unknown> = {
      ':wid': args.workflowId,
    };
    let keyConditionExpression = 'workflowId = :wid';
    const expressionAttributeNames: Record<string, string> = {};

    if (typeof args.sinceTs === 'number') {
      keyConditionExpression += ' AND #ts >= :since';
      expressionAttributeNames['#ts'] = 'timestamp';
      expressionAttributeValues[':since'] = args.sinceTs;
    }

    let filterExpression: string | undefined;
    if (args.decision) {
      filterExpression = '#decision = :decision';
      expressionAttributeNames['#decision'] = 'decision';
      expressionAttributeValues[':decision'] = args.decision;
    }

    const cmd = new QueryCommand({
      TableName: tableName,
      IndexName: 'workflow-index',
      KeyConditionExpression: keyConditionExpression,
      ExpressionAttributeValues: expressionAttributeValues,
      ...(Object.keys(expressionAttributeNames).length > 0
        ? { ExpressionAttributeNames: expressionAttributeNames }
        : {}),
      ...(filterExpression ? { FilterExpression: filterExpression } : {}),
      Limit: limit,
      ...(exclusiveStartKey ? { ExclusiveStartKey: exclusiveStartKey } : {}),
    });

    result = await dynamodb.send(cmd);
  } else {
    // Scan path with optional decision and sinceTs filters.
    const filterClauses: string[] = [];
    const expressionAttributeNames: Record<string, string> = {};
    const expressionAttributeValues: Record<string, unknown> = {};

    if (args.decision) {
      filterClauses.push('#decision = :decision');
      expressionAttributeNames['#decision'] = 'decision';
      expressionAttributeValues[':decision'] = args.decision;
    }
    if (typeof args.sinceTs === 'number') {
      filterClauses.push('#ts >= :since');
      expressionAttributeNames['#ts'] = 'timestamp';
      expressionAttributeValues[':since'] = args.sinceTs;
    }

    const cmd = new ScanCommand({
      TableName: tableName,
      Limit: limit,
      ...(filterClauses.length > 0
        ? {
            FilterExpression: filterClauses.join(' AND '),
            ExpressionAttributeNames: expressionAttributeNames,
            ExpressionAttributeValues: expressionAttributeValues,
          }
        : {}),
      ...(exclusiveStartKey ? { ExclusiveStartKey: exclusiveStartKey } : {}),
    });

    result = await dynamodb.send(cmd);
  }

  const items = (result.Items ?? []).map(projectFinding);
  return { items, nextCursor: encodeCursor(result.LastEvaluatedKey) };
}

async function getGovernanceFinding(
  args: GetFindingArgs,
): Promise<GovernanceFindingProjected | null> {
  return loadFinding(args.findingId);
}

/**
 * Shared helper: fetch a finding from the ledger and project it to the
 * GraphQL shape. Returns null when the row is missing. Centralised so
 * both `getGovernanceFinding` and `getDecisionTrace` use the same code
 * path — identical projection behaviour, identical missing-row policy.
 */
async function loadFinding(
  findingId: string,
): Promise<GovernanceFindingProjected | null> {
  const tableName = process.env.GOVERNANCE_LEDGER_TABLE;
  if (!tableName) {
    throw new Error('GOVERNANCE_LEDGER_TABLE env var is not set');
  }

  const cmd = new GetCommand({
    TableName: tableName,
    Key: { findingId },
  });

  const result = await dynamodb.send(cmd);
  if (!result.Item) return null;
  return projectFinding(result.Item as DdbRow);
}

// ---------------------------------------------------------------------------
// Wave 3.B — getDecisionTrace
// ---------------------------------------------------------------------------
//
// Reconstructs the engine's 8-step pipeline state from a single finding's
// reason / scope / contract fields. Pure parsing — no extra DDB or registry
// reads beyond loading the finding itself. Mirrors getGovernanceFinding's
// auth posture (any authenticated user; admin gating not required because
// the engine semantics are public to admins via the ledger anyway).
//
// Reason format is owned by the backend (arbiter/governance/engine.py). When
// an unrecognised prefix arrives, the resolver degrades gracefully: every
// step renders pass-through, arbitrationPattern is null, terminalStepNumber
// follows the finding decision (8 for HALT, 7 for PERMIT, 4 for DENY,
// 6/8 for ESCALATE) and scopeReduction is parsed from the suffix tokens.

interface GetDecisionTraceArgs {
  findingId: string;
}

export function parseReasonTokens(reason: string): string[] {
  if (!reason) return [];
  return reason.split(':');
}

export function detectScopeReduction(tokens: string[]): string | null {
  // Suffix-keyed reductions land at the end of the reason string per
  // engine.py — e.g. `rivalrous_claim:winner=X:loser=Y:attenuation`. The
  // engine emits `unconfirmed_state` and `attenuation` today;
  // `domain_boundary` is reserved in models.ScopeReductionReason for
  // future use and recognised here so the frontend can render it.
  for (const token of tokens) {
    if (token === 'unconfirmed_state') return 'unconfirmed_state';
    if (token === 'attenuation') return 'attenuation';
    if (token === 'domain_boundary') return 'domain_boundary';
  }
  return null;
}

export function detectArbitrationPattern(tokens: string[]): string | null {
  if (tokens.length === 0) return null;
  const head = tokens[0];
  return ARBITRATION_PATTERN_PREFIXES.has(head) ? head : null;
}

function buildBaseInputs(
  finding: GovernanceFindingProjected,
): Record<string, unknown> {
  return {
    findingId: finding.findingId,
    workflowId: finding.workflowId,
    requestingAgent: finding.requestingAgent,
    targetAgent: finding.targetAgent,
  };
}

function makeStep(
  stepNumber: number,
  status: DecisionTraceStepStatus | string,
  inputs: Record<string, unknown>,
  outputs: Record<string, unknown> | null,
  detailOverride?: string,
): DecisionTraceStepProjected {
  const def = PIPELINE_STEPS[stepNumber - 1];
  return {
    stepNumber,
    name: def.name,
    status,
    inputs: JSON.stringify(inputs),
    outputs: outputs === null ? null : JSON.stringify(outputs),
    detail: detailOverride ?? def.defaultDetail,
  };
}

export function buildSteps(
  finding: GovernanceFindingProjected,
  tokens: string[],
  arbitrationPattern: string | null,
  scopeReduction: string | null,
): { steps: DecisionTraceStepProjected[]; terminalStepNumber: number; constitutionalOverride: boolean } {
  const baseInputs = buildBaseInputs(finding);
  const decision = finding.decision;
  const head = tokens[0] ?? '';

  // Constitutional review (step 8 override) is detected by the literal
  // `constitutional_review` reason head OR by the explicit
  // `constitutional_review:<layerId>:invariant_violated:<field>` shape.
  const constitutionalOverride = head === 'constitutional_review';
  const overrideLayerId = constitutionalOverride ? tokens[1] ?? null : null;
  const overrideField = constitutionalOverride ? tokens[3] ?? null : null;

  // ----- Step 1: Case-law lookup -----
  const caseLawHit = head === 'case_law';
  const caseLawId = caseLawHit ? tokens[1] ?? null : null;

  // ----- Step 4: Residual-authority denial -----
  const residualDenial =
    head === 'residual_authority_denial' || finding.residualAuthorityDenial === true;

  // ----- Step 5/6/7: scope match vs composition vs single-domain permit -----
  const scopeMatch = head === 'scope_match';
  const scopeMatchUnitId = scopeMatch ? tokens[1] ?? null : null;
  const composition = arbitrationPattern !== null;

  // ----- Step 6 outputs (composition) -----
  const compositionContractId = composition ? finding.contractEvaluated : null;

  // Default: all steps skipped.
  let s1: DecisionTraceStepStatus = 'skipped';
  const s2: DecisionTraceStepStatus = 'pass-through';
  let s3: DecisionTraceStepStatus = 'skipped';
  let s4: DecisionTraceStepStatus = 'skipped';
  let s5: DecisionTraceStepStatus = 'skipped';
  let s6: DecisionTraceStepStatus = 'skipped';
  let s7: DecisionTraceStepStatus = 'skipped';
  let s8: DecisionTraceStepStatus = 'skipped';
  let terminalStepNumber = 8;

  if (constitutionalOverride) {
    // Step 8 always fires here; the underlying step that produced the
    // permit is hard to recover from the reason alone (engine.py rewrites
    // the reason on override). We light up steps 1/3/4/5 as pass-through
    // so the operator sees the override clearly without false claims
    // about the upstream path.
    s1 = 'pass-through';
    s3 = 'pass-through';
    s4 = 'pass-through';
    s5 = 'pass-through';
    s6 = 'pass-through';
    s7 = 'pass-through';
    s8 = 'overridden';
    terminalStepNumber = 8;
  } else if (caseLawHit) {
    // Case-law match short-circuits steps 3..7. Step 8 may still fire on
    // PERMITs, but if the reason head is case_law (not
    // constitutional_review) the constitutional override did not trigger.
    s1 = 'matched';
    terminalStepNumber = 1;
  } else if (residualDenial) {
    // Steps 1/3/4 with denial at step 4 (no covering units).
    s1 = 'pass-through';
    s3 = 'matched';
    s4 = 'denied';
    terminalStepNumber = 4;
  } else if (scopeMatch) {
    // Single-domain permit — steps 1..7, decision lit at step 7.
    s1 = 'pass-through';
    s3 = 'matched';
    s4 = 'pass-through';
    s5 = 'matched';
    s6 = 'pass-through';
    s7 = mapDecisionToStatus(decision, 'permitted');
    terminalStepNumber = 7;
  } else if (composition) {
    // Composition decision lit at step 6 with the arbitration pattern.
    s1 = 'pass-through';
    s3 = 'matched';
    s4 = 'pass-through';
    s5 = 'matched';
    s6 = mapDecisionToStatus(decision, 'matched');
    s7 = 'skipped';
    terminalStepNumber = 6;
  } else {
    // Unrecognised reason — degrade to pass-through. Log to CloudWatch
    // so engine reason format drift is visible without crashing the
    // tracer (per the spec's contract test on reason format).
    console.warn(
      `getDecisionTrace: unrecognised reason format ${JSON.stringify(reasonForLog(tokens))} ` +
        `on finding ${finding.findingId}; degrading to pass-through.`,
    );
    s1 = 'pass-through';
    s3 = 'pass-through';
    s4 = 'pass-through';
    s5 = 'pass-through';
    s6 = 'pass-through';
    s7 = 'pass-through';
    // Final decision still anchors the terminal step; default to 8 so
    // operators see the override slot when present, else 7.
    terminalStepNumber = decision === 'halt' ? 8 : 7;
  }

  const steps: DecisionTraceStepProjected[] = [
    makeStep(
      1,
      s1,
      { ...baseInputs },
      caseLawHit && caseLawId ? { case_id: caseLawId } : null,
    ),
    makeStep(2, s2, { ...baseInputs }, null),
    makeStep(3, s3, { ...baseInputs }, null),
    makeStep(
      4,
      s4,
      { ...baseInputs, residualAuthorityDenial: finding.residualAuthorityDenial ?? false },
      residualDenial ? { decision: 'deny' } : null,
    ),
    makeStep(
      5,
      s5,
      { ...baseInputs },
      finding.scopeEvaluated ? { scope_evaluated: finding.scopeEvaluated } : null,
    ),
    makeStep(
      6,
      s6,
      {
        ...baseInputs,
        arbitrationPattern: arbitrationPattern ?? null,
        scopeReduction: scopeReduction ?? null,
      },
      composition && compositionContractId
        ? {
            contract_evaluated: compositionContractId,
            arbitrationPattern,
            scopeReduction,
          }
        : null,
    ),
    makeStep(
      7,
      s7,
      { ...baseInputs },
      scopeMatch
        ? { decision, scope_evaluated: scopeMatchUnitId ?? finding.scopeEvaluated ?? null }
        : null,
    ),
    makeStep(
      8,
      s8,
      { ...baseInputs },
      constitutionalOverride
        ? {
            override_layer: overrideLayerId,
            override_field: overrideField,
            decision: 'deny',
          }
        : null,
    ),
  ];

  return { steps, terminalStepNumber, constitutionalOverride };
}

function reasonForLog(tokens: string[]): string {
  return tokens.join(':');
}

export function mapDecisionToStatus(
  decision: string,
  permitStatus: DecisionTraceStepStatus,
): DecisionTraceStepStatus {
  switch (decision) {
    case 'permit':
      return permitStatus;
    case 'deny':
      return 'denied';
    case 'escalate':
      return 'escalated';
    case 'halt':
      return 'denied';
    default:
      return 'pass-through';
  }
}

async function getDecisionTrace(
  args: GetDecisionTraceArgs,
): Promise<DecisionTraceProjected | null> {
  const finding = await loadFinding(args.findingId);
  if (!finding) return null;

  const tokens = parseReasonTokens(finding.reason);
  const arbitrationPattern = detectArbitrationPattern(tokens);
  const scopeReduction = detectScopeReduction(tokens);
  const { steps, terminalStepNumber, constitutionalOverride } = buildSteps(
    finding,
    tokens,
    arbitrationPattern,
    scopeReduction,
  );

  return {
    findingId: finding.findingId,
    finding,
    steps,
    terminalDecision: finding.decision,
    terminalStepNumber,
    reasonTokens: tokens,
    constitutionalOverride,
    arbitrationPattern,
    scopeReduction,
  };
}

async function getReconcilerStatus(
  event: AppSyncResolverEvent<unknown>,
): Promise<ReconcilerStatus> {
  if (!isAdminFromEvent(event)) {
    throw new Error('Forbidden: admin required');
  }

  const env = process.env.ENVIRONMENT || 'unknown';
  const parameterName = `/citadel/governance/reconciler/last_status/${env}`;

  let raw: string | undefined;
  try {
    const resp = await ssm.send(new GetParameterCommand({ Name: parameterName }));
    raw = resp.Parameter?.Value;
  } catch (err) {
    // ParameterNotFound is the expected steady-state when the scheduled
    // reconciler has not yet written its first status blob (Wave 1 follow-up).
    // Any other error also falls through to the zero-defaults response so the
    // page never breaks on transient SSM issues.
    console.warn('getReconcilerStatus: SSM read failed, returning zero defaults', err);
    return zeroReconcilerStatus();
  }

  if (!raw) return zeroReconcilerStatus();

  try {
    const parsed = JSON.parse(raw);
    if (!isReconcilerStatusShape(parsed)) {
      console.warn('getReconcilerStatus: shape mismatch, returning zero defaults');
      return zeroReconcilerStatus();
    }
    return parsed;
  } catch (err) {
    console.warn('getReconcilerStatus: JSON parse failed, returning zero defaults', err);
    return zeroReconcilerStatus();
  }
}

// --- Wave 2.A + 2.B: rollout readiness ---

// 11 readiness checks aligned with docs/GOVERNANCE_ROLLOUT_RUNBOOK.md.
// Real (Wave 2.B): data-1, data-2, data-3, tel-1, tel-2, tel-3, rb-1.
// Manual / STUB: rb-2, own-1, own-2, own-3.
const READINESS_CHECK_DEFINITIONS: Array<{
  id: string;
  label: string;
  category: string;
  /**
   * Operator-facing instruction shown when the check is a manual
   * STUB. Each instruction tells the operator what to verify, where
   * to verify it, and the explicit Mark-verified action. Real checks
   * (those backed by a runFooCheck helper) ignore this field; they
   * supply their own dynamic detail string.
   */
  stubInstruction?: string;
}> = [
  {
    id: 'data-1',
    label: 'Every active AuthorityUnit has a non-null registryId',
    category: 'data-integrity',
  },
  {
    id: 'data-2',
    label: 'Every registryId points to a live registry record',
    category: 'data-integrity',
  },
  {
    id: 'data-3',
    label:
      'Every governance-aware agent and tool has a workload-identity attribute',
    category: 'data-integrity',
  },
  {
    id: 'tel-1',
    label:
      'governance-gate-decisions dashboard shows ≥7 days of shadow traffic',
    category: 'telemetry',
    stubInstruction:
      'Confirm the governance-gate-decisions CloudWatch dashboard shows at least 7 days of decision data from shadow mode. Open CloudWatch Console → Dashboards → governance-gate-decisions, then click Mark verified.',
  },
  {
    id: 'tel-2',
    label: 'workload-identity-mismatch-rate < 0.5% over 24h',
    category: 'telemetry',
    stubInstruction:
      'Confirm the rolling 24-hour workload-identity-mismatch rate is below 0.5%. Check the Mismatch heatmap (/governance/mismatches) or the CloudWatch metric, then click Mark verified.',
  },
  {
    id: 'tel-3',
    label: 'registry-sync-failures DLQ empty for ≥48h',
    category: 'telemetry',
  },
  {
    id: 'rb-1',
    label: 'GOVERNANCE_MODE controllable via CFN parameter',
    category: 'rollback',
  },
  {
    id: 'rb-2',
    label: 'Permissive fallback exercised in non-prod within 7 days',
    category: 'rollback',
    stubInstruction:
      'Confirm a flip back to permissive mode was exercised in a non-prod environment within the last 7 days. Review the deployment audit log or CloudTrail SSM parameter-history events for /citadel/governance/enforce/<env>, then click Mark verified.',
  },
  {
    id: 'own-1',
    label: 'On-call runbook entry updated and PagerDuty escalation verified',
    category: 'ownership',
    stubInstruction:
      'Confirm the on-call runbook entry for governance is current and the PagerDuty service has an active escalation policy that pages someone on call. Verify in your PagerDuty console, then click Mark verified.',
  },
  {
    id: 'own-2',
    label: 'Flip announced to stakeholders ≥48h in advance',
    category: 'ownership',
    stubInstruction:
      'Confirm an announcement of the planned governance mode flip has been sent to stakeholders at least 48 hours in advance, per docs/GOVERNANCE_ROLLOUT_RUNBOOK.md. Then click Mark verified.',
  },
  {
    id: 'own-3',
    label: 'Change ticket lists rollback criteria',
    category: 'ownership',
    stubInstruction:
      'Confirm the change ticket explicitly documents (1) trigger conditions for rollback to permissive, (2) the on-call owner during the soak window, and (3) the communication plan for stakeholders. Then click Mark verified.',
  },
];

// IDs of checks that remain stubs in Wave 2.B (ship in Wave 2.B.2).
const STUB_CHECK_IDS: ReadonlySet<string> = new Set([
  'own-1',
  'own-2',
  'own-3',
]);

// --- Wave 2.B.2: manual-check verification (mark-verified UI) ---
//
// Operators attest to a manual check by writing a small JSON blob to SSM
// at `/citadel/governance/readiness/manual/${env}/${checkId}`. The
// readiness page reads each of the 4 manual stubs on every render, so
// the per-call SSM cost is bounded with a 30s in-process cache keyed by
// env. Cache invalidation is triggered after a successful PutParameter
// from `markReadinessCheckVerified` so the freshly-marked check appears
// as PASS on the next `getRolloutReadiness` call without waiting out the
// TTL.

interface ManualVerificationRecord {
  verifiedAt: string;
  verifiedBy: string;
  expiresAt: string;
  note: string | null;
}

interface ManualVerificationCacheEntry {
  // checkId → record (or null when SSM had no/invalid blob for that check).
  results: Map<string, ManualVerificationRecord | null>;
  expiresAt: number;
}

const MANUAL_VERIFICATION_CACHE_TTL_MS = 30_000;
const manualVerificationCache = new Map<string, ManualVerificationCacheEntry>();

/** Test-only helper: clear the manual verification cache. */
export function __resetManualVerificationCacheForTest(): void {
  manualVerificationCache.clear();
}

function manualVerificationParamName(env: string, checkId: string): string {
  return `/citadel/governance/readiness/manual/${env}/${checkId}`;
}

function parseManualVerification(raw: string): ManualVerificationRecord | null {
  try {
    const parsed = JSON.parse(raw);
    if (
      parsed === null ||
      typeof parsed !== 'object' ||
      Array.isArray(parsed)
    ) {
      return null;
    }
    const obj = parsed as Record<string, unknown>;
    if (
      typeof obj.verifiedAt !== 'string' ||
      typeof obj.verifiedBy !== 'string' ||
      typeof obj.expiresAt !== 'string'
    ) {
      return null;
    }
    return {
      verifiedAt: obj.verifiedAt,
      verifiedBy: obj.verifiedBy,
      expiresAt: obj.expiresAt,
      note: typeof obj.note === 'string' ? obj.note : null,
    };
  } catch {
    return null;
  }
}

/**
 * Fetch verification records for every manual stub check in parallel.
 * A failure on a single SSM read (ParameterNotFound or otherwise) does
 * NOT crater the report — that check simply maps to null and the
 * caller renders STUB unchanged.
 */
async function fetchManualVerifications(
  env: string,
): Promise<Map<string, ManualVerificationRecord | null>> {
  const cached = manualVerificationCache.get(env);
  if (cached && Date.now() < cached.expiresAt) {
    return cached.results;
  }

  const checkIds = Array.from(STUB_CHECK_IDS);
  const results = new Map<string, ManualVerificationRecord | null>();

  await Promise.allSettled(
    checkIds.map(async (checkId) => {
      try {
        const resp = await ssm.send(
          new GetParameterCommand({
            Name: manualVerificationParamName(env, checkId),
          }),
        );
        const raw = resp.Parameter?.Value;
        if (!raw) {
          results.set(checkId, null);
          return;
        }
        results.set(checkId, parseManualVerification(raw));
      } catch {
        // ParameterNotFound and any other read error surface as "no
        // verification on file" — the check stays STUB and the rest of
        // the report renders normally.
        results.set(checkId, null);
      }
    }),
  );

  // Backfill any missing keys (Promise.allSettled covers all callbacks
  // but defensive: ensure every manual ID has a slot).
  for (const id of checkIds) {
    if (!results.has(id)) results.set(id, null);
  }

  manualVerificationCache.set(env, {
    results,
    expiresAt: Date.now() + MANUAL_VERIFICATION_CACHE_TTL_MS,
  });
  return results;
}

function applyVerificationToStub(
  def: {
    id: string;
    label: string;
    category: string;
    stubInstruction?: string;
  },
  verification: ManualVerificationRecord | null,
): ReadinessCheck {
  if (!verification) {
    return makeStubCheck(def);
  }
  const expiresAtMs = Date.parse(verification.expiresAt);
  if (Number.isNaN(expiresAtMs)) {
    return makeStubCheck(def);
  }
  if (Date.now() < expiresAtMs) {
    return {
      id: def.id,
      label: def.label,
      status: 'PASS',
      detail: `Verified by ${verification.verifiedBy} at ${verification.verifiedAt}, expires ${verification.expiresAt}`,
      evidence: null,
      category: def.category,
    };
  }
  return {
    id: def.id,
    label: def.label,
    status: 'STUB',
    detail: `Verification expired ${verification.expiresAt} — re-mark required`,
    evidence: null,
    category: def.category,
  };
}

/**
 * Translate a raw JavaScript runtime error into operator-friendly
 * evidence text. Raw stack-trace fragments like 'Cannot read properties
 * of undefined (reading X)' or 'TypeError: ...' help engineers but
 * confuse operators. This helper detects common runtime-error
 * signatures and substitutes a clearer message; legitimate domain
 * errors (e.g. 'AccessDenied: ...', 'ResourceNotFoundException: ...')
 * pass through verbatim.
 */
function friendlyEvidence(
  err: unknown,
  context: 'registry' | 'ssm' | 'cloudwatch' | 'dynamodb' = 'registry',
): string {
  const msg = err instanceof Error ? err.message : String(err);
  // Detect JS runtime errors that indicate a coding/bundling issue.
  const isRuntimeError =
    /Cannot read propert(y|ies) of (undefined|null)/.test(msg) ||
    /^TypeError:/.test(msg) ||
    /is not a function/.test(msg) ||
    /^ReferenceError:/.test(msg);
  if (isRuntimeError) {
    const contextHint: Record<typeof context, string> = {
      registry:
        'The AgentCore Registry SDK could not be initialised in this environment. Check that the resolver Lambda has REGISTRY_ID set and that the registry is reachable.',
      ssm:
        'The SSM Parameter Store SDK could not be initialised. Check the resolver Lambda IAM role and SSM service availability.',
      cloudwatch:
        'The CloudWatch SDK could not be initialised. Check the resolver Lambda IAM role and CloudWatch service availability.',
      dynamodb:
        'The DynamoDB SDK could not be initialised. Check the resolver Lambda IAM role and table existence.',
    };
    return contextHint[context];
  }
  return msg;
}

function defForId(id: string): { id: string; label: string; category: string } {
  const def = READINESS_CHECK_DEFINITIONS.find((d) => d.id === id);
  if (!def) {
    // Defensive — should not happen because all IDs come from the
    // definition list above.
    return { id, label: id, category: 'unknown' };
  }
  return def;
}

function makeStubCheck(def: {
  id: string;
  label: string;
  category: string;
  stubInstruction?: string;
}): ReadinessCheck {
  return {
    id: def.id,
    label: def.label,
    status: 'STUB',
    detail: def.stubInstruction ?? 'Manual operator verification required.',
    evidence: null,
    category: def.category,
  };
}

// --- data-1 + data-2 (shared scan) ---

interface AuthorityUnitRow {
  unitId: string;
  registryId: string | null;
}

/**
 * Runs the shared AuthorityUnits scan that backs both data-1 (count of
 * units missing registryId) and data-2 (sample of units with registryId,
 * verified against the registry).
 *
 * Implementation note: the runbook prescribes a Select:'COUNT' filtered
 * scan for data-1 (just the M-of-N detail line). Wave 2.B adds data-2,
 * which needs the row IDs of units WITH registryId. Rather than running
 * two scans (one COUNT-only filtered for missing, one rows-with-IDs
 * filtered for live) we run a single projected scan returning the
 * minimum attributes needed and partition the result client-side. This
 * preserves data-1's external behaviour (PASS/FAIL/UNKNOWN with the
 * same detail strings) while giving data-2 its sample source for free.
 */
async function runDataIntegrityChecks(
  registryService: RegistryService | null,
): Promise<{ dataOne: ReadinessCheck; dataTwo: ReadinessCheck }> {
  const tableName = process.env.AUTHORITY_UNITS_TABLE;
  const dataOneDef = defForId('data-1');
  const dataTwoDef = defForId('data-2');

  if (!tableName) {
    return {
      dataOne: {
        id: dataOneDef.id,
        label: dataOneDef.label,
        status: 'UNKNOWN',
        detail: 'Authority units table unreachable',
        evidence: 'AUTHORITY_UNITS_TABLE env var is not set',
        category: dataOneDef.category,
      },
      dataTwo: {
        id: dataTwoDef.id,
        label: dataTwoDef.label,
        status: 'UNKNOWN',
        detail: 'Authority units table unreachable',
        evidence: 'AUTHORITY_UNITS_TABLE env var is not set',
        category: dataTwoDef.category,
      },
    };
  }

  let items: AuthorityUnitRow[];
  let scannedCount: number;
  try {
    const scan = await dynamodb.send(
      new ScanCommand({
        TableName: tableName,
        ProjectionExpression: '#uid, #rid',
        ExpressionAttributeNames: {
          '#uid': 'unitId',
          '#rid': 'registryId',
        },
      }),
    );
    items = (scan.Items ?? []).map((it) => ({
      unitId: typeof it.unitId === 'string' ? it.unitId : '',
      registryId:
        typeof it.registryId === 'string' && it.registryId.length > 0
          ? it.registryId
          : null,
    }));
    scannedCount = scan.ScannedCount ?? items.length;
  } catch (err) {
    const msg = err instanceof Error ? err.message : String(err);
    return {
      dataOne: {
        id: dataOneDef.id,
        label: dataOneDef.label,
        status: 'UNKNOWN',
        detail: 'Authority units table unreachable',
        evidence: msg,
        category: dataOneDef.category,
      },
      dataTwo: {
        id: dataTwoDef.id,
        label: dataTwoDef.label,
        status: 'UNKNOWN',
        detail: 'Authority units table unreachable',
        evidence: msg,
        category: dataTwoDef.category,
      },
    };
  }

  // --- data-1: missing/null registryId ---
  const missingItems = items.filter((it) => it.registryId === null);
  const missing = missingItems.length;
  const dataOne: ReadinessCheck =
    missing === 0
      ? {
          id: dataOneDef.id,
          label: dataOneDef.label,
          status: 'PASS',
          detail: `All ${scannedCount} authority units have registryId`,
          evidence: null,
          category: dataOneDef.category,
        }
      : {
          id: dataOneDef.id,
          label: dataOneDef.label,
          status: 'FAIL',
          detail: `${missing} of ${scannedCount} units missing registryId`,
          evidence: null,
          category: dataOneDef.category,
        };

  // --- data-2: sample units with registryId, check registry ---
  const dataTwo = await runDataTwoCheck(items, dataTwoDef, registryService);

  return { dataOne, dataTwo };
}

async function runDataTwoCheck(
  items: AuthorityUnitRow[],
  def: { id: string; label: string; category: string },
  registryService: RegistryService | null,
): Promise<ReadinessCheck> {
  if (!registryService) {
    return {
      id: def.id,
      label: def.label,
      status: 'UNKNOWN',
      detail: 'Registry unreachable',
      evidence: 'REGISTRY_ID env var is not set',
      category: def.category,
    };
  }

  const candidates = items.filter(
    (it): it is AuthorityUnitRow & { registryId: string } =>
      it.registryId !== null,
  );

  // Sample up to DATA_TWO_SAMPLE_SIZE — order is whatever the scan returned,
  // which is good enough for a smoke check (the runbook's "≥50 random units"
  // is an operator-side recommendation, not a strict requirement).
  const sample = candidates.slice(0, DATA_TWO_SAMPLE_SIZE);

  if (sample.length === 0) {
    return {
      id: def.id,
      label: def.label,
      status: 'WARN',
      detail: 'No units to sample (see data-1)',
      evidence: null,
      category: def.category,
    };
  }

  const failed: string[] = [];
  try {
    await Promise.all(
      sample.map(async (unit) => {
        const recordId = unit.registryId;
        let record: RegistryRecord | null;
        try {
          record = await registryService.getResource('agent', recordId);
        } catch (err) {
          if (err instanceof TypeMismatchError) {
            // Authority units may bind to either agents or tools; if the
            // record exists but isn't an agent, fall back to the tool path
            // before declaring it missing.
            record = await registryService.getResource('tool', recordId);
          } else {
            throw err;
          }
        }
        if (!record) {
          failed.push(recordId);
          return;
        }
        if (record.status === 'DEPRECATED') {
          failed.push(recordId);
        }
      }),
    );
  } catch (err) {
    return {
      id: def.id,
      label: def.label,
      status: 'UNKNOWN',
      detail: 'Registry unreachable',
      evidence: friendlyEvidence(err, 'registry'),
      category: def.category,
    };
  }

  if (failed.length === 0) {
    return {
      id: def.id,
      label: def.label,
      status: 'PASS',
      detail: `Sampled ${sample.length} units, all live and non-deprecated`,
      evidence: null,
      category: def.category,
    };
  }

  return {
    id: def.id,
    label: def.label,
    status: 'FAIL',
    detail: `${failed.length} of ${sample.length} sampled units missing or deprecated`,
    evidence: failed.slice(0, 5).join(', '),
    category: def.category,
  };
}

// --- data-3 ---

// Defaults used when deserializeCustomMetadata gets a null/empty payload.
// The shapes match RegistryService's internal defaults; we keep them local
// so the resolver does not depend on RegistryService private fields.
const AGENT_META_DEFAULTS_FOR_CHECK: AgentCustomMetadata & {
  registryId?: string;
} = {
  categories: [],
  icon: '',
  state: 'active',
};
const TOOL_META_DEFAULTS_FOR_CHECK: ToolCustomMetadata & {
  registryId?: string;
} = {
  categories: [],
  icon: '',
  state: 'active',
};

function recordHasWorkloadIdentity(
  record: RegistryRecord,
  registryService: RegistryService,
  defaults: AgentCustomMetadata | ToolCustomMetadata,
): boolean {
  // Per Decision #9, the workload-identity is stored on the record's
  // customDescriptorContent under a distinct `registryId` field — distinct
  // from the AgentCore registry recordId. We treat any non-empty string as
  // valid; missing or blank fails.
  const meta = registryService.deserializeCustomMetadata<
    Record<string, unknown>
  >(record.customDescriptorContent ?? null, {
    ...defaults,
  } as unknown as Record<string, unknown>);
  const v = meta.registryId;
  return typeof v === 'string' && v.length > 0;
}

async function runDataThreeCheck(
  registryService: RegistryService | null,
): Promise<ReadinessCheck> {
  const def = defForId('data-3');

  if (!registryService) {
    return {
      id: def.id,
      label: def.label,
      status: 'UNKNOWN',
      detail: 'Registry unreachable',
      evidence: 'REGISTRY_ID env var is not set',
      category: def.category,
    };
  }

  let agents: RegistryRecord[];
  let tools: RegistryRecord[];
  try {
    [agents, tools] = await Promise.all([
      registryService.listResources('agent'),
      registryService.listResources('tool'),
    ]);
  } catch (err) {
    return {
      id: def.id,
      label: def.label,
      status: 'UNKNOWN',
      detail: 'Registry unreachable',
      evidence: friendlyEvidence(err, 'registry'),
      category: def.category,
    };
  }

  const missingAgents = agents.filter(
    (r) =>
      !recordHasWorkloadIdentity(
        r,
        registryService,
        AGENT_META_DEFAULTS_FOR_CHECK,
      ),
  );
  const missingTools = tools.filter(
    (r) =>
      !recordHasWorkloadIdentity(
        r,
        registryService,
        TOOL_META_DEFAULTS_FOR_CHECK,
      ),
  );

  if (missingAgents.length === 0 && missingTools.length === 0) {
    return {
      id: def.id,
      label: def.label,
      status: 'PASS',
      detail: `All ${agents.length} agents and ${tools.length} tools have workload-identity attribute`,
      evidence: null,
      category: def.category,
    };
  }

  const evidenceIds = [...missingAgents, ...missingTools]
    .map((r) => r.recordId)
    .slice(0, 5)
    .join(', ');

  return {
    id: def.id,
    label: def.label,
    status: 'FAIL',
    detail: `${missingAgents.length} of ${agents.length} agents and ${missingTools.length} of ${tools.length} tools missing workload-identity`,
    evidence: evidenceIds,
    category: def.category,
  };
}

// --- tel-1 ---
//
// Shadow-traffic age — the governance-gate-decisions dashboard needs ≥7
// days of decision data before a strict flip is safe. We approximate
// "shadow traffic" by the same warn-decision rows used by getMismatchHeatmap
// (decision IN deny / escalate); this matches the runbook's data source
// (the Mismatch heatmap is what operators inspect). A 30-day scan window
// is wide enough to find a ≥7-day-old row whenever the soak has actually
// run that long, and bounds the per-call cost via scanMismatchItems'
// MISMATCH_ITEM_HARD_CAP.
const TEL_ONE_LOOKBACK_SECONDS = 30 * 86400;
const TEL_ONE_THRESHOLD_DAYS = 7;

async function runTelOneCheck(): Promise<ReadinessCheck> {
  const def = defForId('tel-1');
  const tableName = process.env.GOVERNANCE_LEDGER_TABLE;
  if (!tableName) {
    return {
      id: def.id,
      label: def.label,
      status: 'UNKNOWN',
      detail: 'Governance ledger table unreachable',
      evidence: 'GOVERNANCE_LEDGER_TABLE env var is not set',
      category: def.category,
    };
  }

  const nowSec = Math.floor(Date.now() / 1000);
  const sinceTs = nowSec - TEL_ONE_LOOKBACK_SECONDS;

  let items: DdbRow[];
  try {
    const scan = await scanMismatchItems(tableName, sinceTs, nowSec);
    items = scan.items;
  } catch (err) {
    return {
      id: def.id,
      label: def.label,
      status: 'UNKNOWN',
      detail: 'Governance ledger unreachable',
      evidence: friendlyEvidence(err, 'dynamodb'),
      category: def.category,
    };
  }

  let oldestTs: number | null = null;
  for (const row of items) {
    const tsRaw = row.timestamp;
    const ts =
      typeof tsRaw === 'number'
        ? tsRaw
        : typeof tsRaw === 'string'
          ? Number(tsRaw)
          : NaN;
    if (!Number.isFinite(ts)) continue;
    if (oldestTs === null || ts < oldestTs) oldestTs = ts;
  }

  if (oldestTs === null) {
    return {
      id: def.id,
      label: def.label,
      status: 'FAIL',
      detail:
        'No shadow traffic recorded yet. Switch to shadow mode (/governance/rollout) and let it run for ≥7 days.',
      evidence: null,
      category: def.category,
    };
  }

  const ageDays = Math.floor((nowSec - oldestTs) / 86400);
  const oldestIso = new Date(oldestTs * 1000).toISOString();

  if (ageDays >= TEL_ONE_THRESHOLD_DAYS) {
    return {
      id: def.id,
      label: def.label,
      status: 'PASS',
      detail: `Shadow traffic spans ${ageDays} days (oldest: ${oldestIso})`,
      evidence: null,
      category: def.category,
    };
  }

  const remainingDays = TEL_ONE_THRESHOLD_DAYS - ageDays;
  return {
    id: def.id,
    label: def.label,
    status: 'FAIL',
    detail: `Shadow traffic spans only ${ageDays} days; need ≥7 days. Continue running shadow mode for another ${remainingDays} days.`,
    evidence: null,
    category: def.category,
  };
}

// --- tel-2 ---
//
// 24-hour workload-identity-mismatch rate. We need both the total
// finding count and the mismatch (deny/escalate) count over the same
// 24h window. Two parallel Select:'COUNT' scans avoid materialising
// items at all — the unfiltered scan can otherwise be enormous on a
// busy ledger. scanMismatchItems is items-based and capped, so we
// can't reuse it for the mismatch count without risking under-count
// at the cap; we run a count-only scan for that path too.
const TEL_TWO_WINDOW_SECONDS = 86400;
const TEL_TWO_MIN_FINDINGS = 100;
const TEL_TWO_RATE_THRESHOLD = 0.005;

async function countLedgerRows(
  tableName: string,
  sinceTs: number,
  untilTs: number,
  decisionFilter: 'all' | 'mismatch',
): Promise<number> {
  let count = 0;
  let lastEvaluatedKey: Record<string, unknown> | undefined;

  const filterExpression =
    decisionFilter === 'mismatch'
      ? 'decision IN (:deny, :escalate) AND #ts BETWEEN :since AND :until'
      : '#ts BETWEEN :since AND :until';
  const expressionAttributeValues: Record<string, unknown> =
    decisionFilter === 'mismatch'
      ? {
          ':deny': 'deny',
          ':escalate': 'escalate',
          ':since': sinceTs,
          ':until': untilTs,
        }
      : { ':since': sinceTs, ':until': untilTs };

  do {
    const cmd = new ScanCommand({
      TableName: tableName,
      Select: 'COUNT',
      FilterExpression: filterExpression,
      ExpressionAttributeNames: { '#ts': 'timestamp' },
      ExpressionAttributeValues: expressionAttributeValues,
      ...(lastEvaluatedKey ? { ExclusiveStartKey: lastEvaluatedKey } : {}),
    });
    const result = await dynamodb.send(cmd);
    count += result.Count ?? 0;
    lastEvaluatedKey = result.LastEvaluatedKey as
      | Record<string, unknown>
      | undefined;
  } while (lastEvaluatedKey);

  return count;
}

async function runTelTwoCheck(): Promise<ReadinessCheck> {
  const def = defForId('tel-2');
  const tableName = process.env.GOVERNANCE_LEDGER_TABLE;
  if (!tableName) {
    return {
      id: def.id,
      label: def.label,
      status: 'UNKNOWN',
      detail: 'Governance ledger table unreachable',
      evidence: 'GOVERNANCE_LEDGER_TABLE env var is not set',
      category: def.category,
    };
  }

  const nowSec = Math.floor(Date.now() / 1000);
  const sinceTs = nowSec - TEL_TWO_WINDOW_SECONDS;

  let total: number;
  let mismatches: number;
  try {
    [total, mismatches] = await Promise.all([
      countLedgerRows(tableName, sinceTs, nowSec, 'all'),
      countLedgerRows(tableName, sinceTs, nowSec, 'mismatch'),
    ]);
  } catch (err) {
    return {
      id: def.id,
      label: def.label,
      status: 'UNKNOWN',
      detail: 'Governance ledger unreachable',
      evidence: friendlyEvidence(err, 'dynamodb'),
      category: def.category,
    };
  }

  if (total < TEL_TWO_MIN_FINDINGS) {
    return {
      id: def.id,
      label: def.label,
      status: 'WARN',
      detail: `Insufficient data: only ${total} findings in last 24h. Need >=100 for confident rate calculation.`,
      evidence: null,
      category: def.category,
    };
  }

  const rate = mismatches / total;
  const ratePct = (rate * 100).toFixed(2);

  if (rate < TEL_TWO_RATE_THRESHOLD) {
    return {
      id: def.id,
      label: def.label,
      status: 'PASS',
      detail: `Mismatch rate ${ratePct}% over 24h (${mismatches} mismatches in ${total} total findings)`,
      evidence: null,
      category: def.category,
    };
  }

  return {
    id: def.id,
    label: def.label,
    status: 'FAIL',
    detail: `Mismatch rate ${ratePct}% over 24h exceeds 0.5% threshold (${mismatches} mismatches in ${total} total findings). Investigate the Mismatch heatmap (/governance/mismatches) before flipping to strict.`,
    evidence: null,
    category: def.category,
  };
}

// --- tel-3 ---

async function runTelThreeCheck(): Promise<ReadinessCheck> {
  const def = defForId('tel-3');
  const now = new Date();
  const start = new Date(now.getTime() - 48 * 60 * 60 * 1000);

  try {
    const resp = await cloudwatch.send(
      new GetMetricStatisticsCommand({
        Namespace: 'RegistrySync',
        MetricName: 'SyncFailure',
        StartTime: start,
        EndTime: now,
        Period: 3600,
        Statistics: ['Sum'],
      }),
    );
    const points = resp.Datapoints ?? [];
    let total = 0;
    let peak = 0;
    let peakAt: Date | null = null;
    for (const p of points) {
      const v = typeof p.Sum === 'number' ? p.Sum : 0;
      total += v;
      if (v > peak) {
        peak = v;
        peakAt = p.Timestamp ?? null;
      }
    }

    if (total === 0) {
      return {
        id: def.id,
        label: def.label,
        status: 'PASS',
        detail: 'Zero sync failures in last 48h',
        evidence: null,
        category: def.category,
      };
    }

    const peakIso = peakAt ? peakAt.toISOString() : 'unknown';
    return {
      id: def.id,
      label: def.label,
      status: 'FAIL',
      detail: `${total} sync failures in last 48h (peak ${peak}/h at ${peakIso})`,
      evidence: null,
      category: def.category,
    };
  } catch (err) {
    return {
      id: def.id,
      label: def.label,
      status: 'UNKNOWN',
      detail: 'CloudWatch unreachable',
      evidence: friendlyEvidence(err, 'cloudwatch'),
      category: def.category,
    };
  }
}

// --- rb-1 ---

async function runRbOneCheck(env: string): Promise<ReadinessCheck> {
  const def = defForId('rb-1');
  const parameterName = `/citadel/governance/enforce/${env}`;

  // Direct GetParameter — bypass the cached helper so the readiness page
  // observes the live SSM state, not a stale cache entry.
  try {
    const resp = await ssm.send(
      new GetParameterCommand({ Name: parameterName }),
    );
    const value = resp.Parameter?.Value ?? '';
    if (VALID_ENFORCE_VALUES.has(value)) {
      return {
        id: def.id,
        label: def.label,
        status: 'PASS',
        detail: `Mode parameter present, value: ${value}`,
        evidence: null,
        category: def.category,
      };
    }
    return {
      id: def.id,
      label: def.label,
      status: 'FAIL',
      detail: `Mode parameter has invalid value: ${value}`,
      evidence: null,
      category: def.category,
    };
  } catch (err) {
    return {
      id: def.id,
      label: def.label,
      status: 'UNKNOWN',
      detail: 'Mode parameter unreachable',
      evidence: friendlyEvidence(err, 'ssm'),
      category: def.category,
    };
  }
}

async function runRb2Check(env: string): Promise<ReadinessCheck> {
  const def = defForId('rb-2');
  const paramName = `/citadel/governance/enforce/${env}`;
  const sevenDaysAgo = Date.now() - 7 * 24 * 60 * 60 * 1000;

  try {
    // GetParameterHistory returns up to 50 entries by default in ascending
    // version order. Within a single env's 7-day window, mode flips are rare,
    // so the default page size is comfortably sufficient. We do not paginate;
    // if the parameter has more than 50 history entries within 7 days, the
    // operator has bigger problems than this readiness check.
    const resp = await ssm.send(
      new GetParameterHistoryCommand({
        Name: paramName,
        WithDecryption: false,
      }),
    );
    const history = resp.Parameters ?? [];

    if (history.length === 0) {
      return {
        id: def.id,
        label: def.label,
        status: 'FAIL',
        detail:
          'No SSM parameter history for the governance enforce mode. The rollback path has never been exercised. Flip to shadow then back to permissive in this environment, then re-check.',
        evidence: null,
        category: def.category,
      };
    }

    if (history.length === 1) {
      const only = history[0];
      const value = String(only.Value ?? 'unknown');
      return {
        id: def.id,
        label: def.label,
        status: 'FAIL',
        detail: `The governance enforce parameter has only ever held one value (${value}). Exercise the rollback by flipping to shadow then back to permissive in this environment, then re-check.`,
        evidence: null,
        category: def.category,
      };
    }

    // Walk history pairwise, looking for transitions to 'permissive' that
    // happened within the last 7 days. Most-recent qualifying transition wins.
    let lastTransition: {
      from: string;
      to: string;
      at: Date;
    } | null = null;
    for (let i = 1; i < history.length; i++) {
      const prev = history[i - 1];
      const curr = history[i];
      const prevValue = String(prev.Value ?? '');
      const currValue = String(curr.Value ?? '');
      const currDate = curr.LastModifiedDate;
      if (
        currValue === 'permissive' &&
        prevValue !== 'permissive' &&
        currDate &&
        currDate.getTime() >= sevenDaysAgo
      ) {
        if (!lastTransition || currDate.getTime() > lastTransition.at.getTime()) {
          lastTransition = {
            from: prevValue || 'unknown',
            to: 'permissive',
            at: currDate,
          };
        }
      }
    }

    if (lastTransition) {
      return {
        id: def.id,
        label: def.label,
        status: 'PASS',
        detail: `Permissive fallback exercised on ${lastTransition.at.toISOString()} (transition: ${lastTransition.from} → permissive)`,
        evidence: null,
        category: def.category,
      };
    }

    return {
      id: def.id,
      label: def.label,
      status: 'FAIL',
      detail:
        'No transition to permissive in the last 7 days. Exercise the rollback path by flipping to shadow then back to permissive in this environment, then re-check.',
      evidence: null,
      category: def.category,
    };
  } catch (err) {
    return {
      id: def.id,
      label: def.label,
      status: 'UNKNOWN',
      detail: 'SSM parameter history unreachable',
      evidence: friendlyEvidence(err, 'ssm'),
      category: def.category,
    };
  }
}

// --- data-2 / data-3 result cache (60s TTL) ---
//
// data-2 samples up to 50 registry records per page load and data-3 lists
// every agent + tool plus their custom metadata; both are expensive enough
// that an admin spamming F5 on the rollout page would generate hundreds of
// AgentCore Registry calls per minute. A small per-Lambda-container cache
// (keyed on REGISTRY_ID, 60s TTL) collapses repeat page loads to a single
// upstream call within the window. data-1, tel-3, and rb-1 are cheap and
// not cached.
interface RegistryCheckCacheEntry {
  dataTwo: ReadinessCheck;
  dataThree: ReadinessCheck;
  expiresAt: number;
}
const REGISTRY_CHECK_CACHE_TTL_MS = 60_000;
const registryCheckCache = new Map<string, RegistryCheckCacheEntry>();

/** Test-only helper: clear the data-2/data-3 cache. */
export function __resetReadinessCacheForTest(): void {
  registryCheckCache.clear();
  _registryService = null;
}

// Lazy-construct the RegistryService so REGISTRY_ID changes between Lambda
// invocations (e.g. across env/test runs) are respected.
let _registryService: RegistryService | null = null;
function getRegistryServiceForChecks(): RegistryService | null {
  const id = process.env.REGISTRY_ID;
  if (!id) return null;
  if (!_registryService || _registryService.getRegistryId() !== id) {
    _registryService = new RegistryService({
      registryId: id,
      region: process.env.AWS_REGION ?? 'us-east-1',
    });
  }
  return _registryService;
}

/**
 * Top-level orchestration of the 11 readiness checks.
 *
 * The four real checks (data-1+data-2, data-3, tel-3, rb-1) run in
 * parallel via Promise.allSettled so a single upstream failure is
 * contained to the affected check rather than cratering the whole
 * report. Stubs are produced inline.
 */
async function runReadinessChecks(env: string): Promise<{
  checks: ReadinessCheck[];
  currentMode: string;
  effectiveAt: string | null;
}> {
  // Mode + effectiveAt come from the same helpers as getGovernanceMode.
  // On read failure, fall back to permissive / null so the page still
  // renders rather than throwing — admins still need to see the
  // checklist even when SSM is briefly unreachable.
  let currentMode = 'permissive';
  let effectiveAt: string | null = null;
  try {
    const [mode, eff] = await Promise.all([
      getGovernanceEnforce(env),
      getGovernanceEffectiveAt(env),
    ]);
    currentMode = mode;
    effectiveAt = eff;
  } catch (err) {
    console.error('runReadinessChecks: governance-flag read failed', err);
  }

  const registryService = getRegistryServiceForChecks();
  const cacheKey = registryService?.getRegistryId() ?? '<no-registry>';
  const cached = registryCheckCache.get(cacheKey);
  const cacheValid = cached && Date.now() < cached.expiresAt;

  // Always run data-1 (cheap) and tel-3 / rb-1 fresh. data-2 + data-3 use the
  // cached entry if available; otherwise we recompute and cache.
  const integrityPromise = runDataIntegrityChecks(registryService);
  const dataThreePromise = cacheValid
    ? Promise.resolve(cached!.dataThree)
    : runDataThreeCheck(registryService);
  const telOnePromise = runTelOneCheck();
  const telTwoPromise = runTelTwoCheck();
  const telThreePromise = runTelThreeCheck();
  const rbOnePromise = runRbOneCheck(env);
  const rbTwoPromise = runRb2Check(env);

  const [
    integrityResult,
    dataThreeResult,
    telOneResult,
    telTwoResult,
    telThreeResult,
    rbOneResult,
    rbTwoResult,
  ] = await Promise.allSettled([
    integrityPromise,
    dataThreePromise,
    telOnePromise,
    telTwoPromise,
    telThreePromise,
    rbOnePromise,
    rbTwoPromise,
  ]);

  const dataOne =
    integrityResult.status === 'fulfilled'
      ? integrityResult.value.dataOne
      : unknownCheck('data-1', integrityResult.reason);
  const dataTwoFresh =
    integrityResult.status === 'fulfilled'
      ? integrityResult.value.dataTwo
      : unknownCheck('data-2', integrityResult.reason);
  const dataTwo = cacheValid ? cached!.dataTwo : dataTwoFresh;
  const dataThree =
    dataThreeResult.status === 'fulfilled'
      ? dataThreeResult.value
      : unknownCheck('data-3', dataThreeResult.reason);
  const telOne =
    telOneResult.status === 'fulfilled'
      ? telOneResult.value
      : unknownCheck('tel-1', telOneResult.reason);
  const telTwo =
    telTwoResult.status === 'fulfilled'
      ? telTwoResult.value
      : unknownCheck('tel-2', telTwoResult.reason);
  const telThree =
    telThreeResult.status === 'fulfilled'
      ? telThreeResult.value
      : unknownCheck('tel-3', telThreeResult.reason);
  const rbOne =
    rbOneResult.status === 'fulfilled'
      ? rbOneResult.value
      : unknownCheck('rb-1', rbOneResult.reason);
  const rbTwo =
    rbTwoResult.status === 'fulfilled'
      ? rbTwoResult.value
      : unknownCheck('rb-2', rbTwoResult.reason);

  // Refresh the cache when we computed a fresh data-2/data-3 pair.
  if (!cacheValid) {
    registryCheckCache.set(cacheKey, {
      dataTwo: dataTwoFresh,
      dataThree,
      expiresAt: Date.now() + REGISTRY_CHECK_CACHE_TTL_MS,
    });
  }

  // Assemble in canonical order — match READINESS_CHECK_DEFINITIONS.
  const realById: Record<string, ReadinessCheck> = {
    'data-1': dataOne,
    'data-2': dataTwo,
    'data-3': dataThree,
    'tel-1': telOne,
    'tel-2': telTwo,
    'tel-3': telThree,
    'rb-1': rbOne,
    'rb-2': rbTwo,
  };

  // Wave 2.B.2: each manual stub may now be promoted to PASS when an
  // operator has marked it verified within the last expiresInDays window.
  // The verification map is fetched lazily (cached for 30s per env) to
  // collapse repeat page loads to a single SSM read per manual check.
  const verifications = await fetchManualVerifications(env);

  const checks = READINESS_CHECK_DEFINITIONS.map((def) => {
    if (STUB_CHECK_IDS.has(def.id)) {
      return applyVerificationToStub(def, verifications.get(def.id) ?? null);
    }
    return realById[def.id] ?? makeStubCheck(def);
  });

  return { checks, currentMode, effectiveAt };
}

function unknownCheck(id: string, reason: unknown): ReadinessCheck {
  const def = defForId(id);
  return {
    id: def.id,
    label: def.label,
    status: 'UNKNOWN',
    detail: 'Check failed unexpectedly',
    evidence: friendlyEvidence(reason, 'registry'),
    category: def.category,
  };
}

async function getRolloutReadiness(
  event: AppSyncResolverEvent<unknown>,
): Promise<RolloutReadinessReport> {
  if (!isAdminFromEvent(event)) {
    throw new Error('Forbidden: admin required');
  }

  const env = process.env.ENVIRONMENT || 'unknown';
  const { checks, currentMode, effectiveAt } = await runReadinessChecks(env);

  const shadowSoakStartedAt =
    currentMode === 'shadow' && effectiveAt ? effectiveAt : null;

  let passCount = 0;
  let failCount = 0;
  let warnCount = 0;
  let stubCount = 0;
  for (const c of checks) {
    if (c.status === 'PASS') passCount++;
    else if (c.status === 'FAIL') failCount++;
    else if (c.status === 'WARN') warnCount++;
    else if (c.status === 'STUB') stubCount++;
  }

  return {
    generatedAt: Date.now(),
    currentMode,
    effectiveAt,
    env,
    shadowSoakStartedAt,
    checks,
    passCount,
    failCount,
    warnCount,
    stubCount,
  };
}

// ---------------------------------------------------------------------------
// Wave 2.C: mismatch heatmap
// ---------------------------------------------------------------------------

interface MismatchHeatmapArgs {
  sinceTs?: number | null;
  untilTs?: number | null;
  bucketSeconds?: number | null;
}

interface MismatchBucket {
  bucketStart: number;
  count: number;
  decision: string;
  topReason: string | null;
}

interface ModeWindow {
  startTs: number;
  endTs: number | null;
  mode: string;
}

interface MismatchHeatmapReport {
  generatedAt: number;
  sinceTs: number;
  untilTs: number;
  bucketSeconds: number;
  totalDenials: number;
  totalEscalations: number;
  modeWindows: ModeWindow[];
  buckets: MismatchBucket[];
}

// Allowlist of bucket sizes — keeps the response stable across UI variants
// and prevents arbitrary high-cardinality buckets that would blow the
// payload up. 15min / 1h / 1d are the only widths the frontend renders.
const ALLOWED_BUCKET_SECONDS: ReadonlySet<number> = new Set([900, 3600, 86400]);
const DEFAULT_BUCKET_SECONDS = 3600;
const MISMATCH_WINDOW_DEFAULT_SECONDS = 7 * 86400;
const MISMATCH_WINDOW_MAX_SECONDS = 30 * 86400;
// Hard cap on items returned from the ledger scan. Keeps the per-page
// cost bounded; if a 7-day window has > 10k denials/escalations, the
// operator sees a truncation warning in CloudWatch and the heatmap
// reports the partial dataset.
const MISMATCH_ITEM_HARD_CAP = 10000;
// 30s cache — cheap enough for the heatmap to feel snappy on
// back-to-back navigations and short enough that the 1-minute pulse
// during a soak window is still visible.
const MISMATCH_CACHE_TTL_MS = 30_000;

interface MismatchHeatmapCacheEntry {
  report: MismatchHeatmapReport;
  expiresAt: number;
}
const mismatchHeatmapCache = new Map<string, MismatchHeatmapCacheEntry>();

/** Test-only helper: clear the heatmap cache. */
export function __resetMismatchHeatmapCacheForTest(): void {
  mismatchHeatmapCache.clear();
}

function extractTopReason(reasons: string[]): string | null {
  if (reasons.length === 0) return null;
  const counts = new Map<string, number>();
  for (const r of reasons) {
    const idx = r.indexOf(':');
    const prefix = idx >= 0 ? r.slice(0, idx) : r;
    counts.set(prefix, (counts.get(prefix) ?? 0) + 1);
  }
  let bestKey: string | null = null;
  let bestCount = -1;
  for (const [key, count] of counts) {
    if (count > bestCount) {
      bestCount = count;
      bestKey = key;
    }
  }
  return bestKey;
}

async function scanMismatchItems(
  tableName: string,
  sinceTs: number,
  untilTs: number,
): Promise<{ items: DdbRow[]; truncated: boolean }> {
  const items: DdbRow[] = [];
  let lastEvaluatedKey: Record<string, unknown> | undefined;
  let truncated = false;

  do {
    const cmd = new ScanCommand({
      TableName: tableName,
      FilterExpression:
        'decision IN (:deny, :escalate) AND #ts BETWEEN :since AND :until',
      ExpressionAttributeNames: { '#ts': 'timestamp' },
      ExpressionAttributeValues: {
        ':deny': 'deny',
        ':escalate': 'escalate',
        ':since': sinceTs,
        ':until': untilTs,
      },
      ...(lastEvaluatedKey ? { ExclusiveStartKey: lastEvaluatedKey } : {}),
    });
    const result = await dynamodb.send(cmd);
    const page = (result.Items ?? []) as DdbRow[];
    for (const row of page) {
      if (items.length >= MISMATCH_ITEM_HARD_CAP) {
        truncated = true;
        break;
      }
      items.push(row);
    }
    if (truncated) break;
    lastEvaluatedKey = result.LastEvaluatedKey as
      | Record<string, unknown>
      | undefined;
  } while (lastEvaluatedKey);

  return { items, truncated };
}

async function getMismatchHeatmap(
  event: AppSyncResolverEvent<MismatchHeatmapArgs>,
): Promise<MismatchHeatmapReport> {
  if (!isAdminFromEvent(event)) {
    throw new Error('Forbidden: admin required');
  }

  const tableName = process.env.GOVERNANCE_LEDGER_TABLE;
  if (!tableName) {
    throw new Error('GOVERNANCE_LEDGER_TABLE env var is not set');
  }

  const args = (event.arguments ?? {}) as MismatchHeatmapArgs;

  // bucketSeconds: default 3600, allowlist enforced.
  const requestedBucket =
    typeof args.bucketSeconds === 'number'
      ? args.bucketSeconds
      : DEFAULT_BUCKET_SECONDS;
  if (!ALLOWED_BUCKET_SECONDS.has(requestedBucket)) {
    throw new Error(
      `Invalid bucketSeconds: ${requestedBucket}. Allowed: 900, 3600, 86400`,
    );
  }
  const bucketSeconds = requestedBucket;

  // Resolve time window. Both ends accept seconds-since-epoch (Float in
  // GraphQL, number here). Defaults: now − 7d to now. Window cap: 30d.
  const nowSec = Math.floor(Date.now() / 1000);
  const untilTs =
    typeof args.untilTs === 'number' && args.untilTs > 0 ? args.untilTs : nowSec;
  let sinceTs =
    typeof args.sinceTs === 'number' && args.sinceTs > 0
      ? args.sinceTs
      : untilTs - MISMATCH_WINDOW_DEFAULT_SECONDS;
  if (sinceTs > untilTs) {
    sinceTs = untilTs - MISMATCH_WINDOW_DEFAULT_SECONDS;
  }
  if (untilTs - sinceTs > MISMATCH_WINDOW_MAX_SECONDS) {
    sinceTs = untilTs - MISMATCH_WINDOW_MAX_SECONDS;
  }

  const cacheKey = `${sinceTs}|${untilTs}|${bucketSeconds}`;
  const cached = mismatchHeatmapCache.get(cacheKey);
  if (cached && Date.now() < cached.expiresAt) {
    return cached.report;
  }

  // Mode window — Wave 2.C uses a single window covering the entire query
  // range with the CURRENT mode (historical mode transitions ship later).
  const env = process.env.ENVIRONMENT || 'unknown';
  let currentMode = 'permissive';
  try {
    currentMode = await getGovernanceEnforce(env);
  } catch (err) {
    console.warn('getMismatchHeatmap: governance-flag read failed', err);
  }

  let items: DdbRow[];
  let truncated: boolean;
  try {
    const scan = await scanMismatchItems(tableName, sinceTs, untilTs);
    items = scan.items;
    truncated = scan.truncated;
  } catch (err) {
    console.error('getMismatchHeatmap: ledger scan failed', err);
    throw err;
  }

  if (truncated) {
    console.warn(
      `getMismatchHeatmap: item count exceeded ${MISMATCH_ITEM_HARD_CAP}, ` +
        `truncating to ${items.length} items in window ${sinceTs}..${untilTs}`,
    );
  }

  // Bucket items by (bucketStart, decision); track reason prefixes per bucket.
  type BucketAcc = {
    bucketStart: number;
    decision: string;
    count: number;
    reasons: string[];
  };
  const acc = new Map<string, BucketAcc>();
  let totalDenials = 0;
  let totalEscalations = 0;

  for (const row of items) {
    const tsRaw = row.timestamp;
    const ts =
      typeof tsRaw === 'number'
        ? tsRaw
        : typeof tsRaw === 'string'
          ? Number(tsRaw)
          : NaN;
    if (!Number.isFinite(ts)) continue;
    const decision =
      typeof row.decision === 'string' ? row.decision : '';
    if (decision !== 'deny' && decision !== 'escalate') continue;
    if (decision === 'deny') totalDenials++;
    else totalEscalations++;
    const bucketStart = Math.floor(ts / bucketSeconds) * bucketSeconds;
    const key = `${bucketStart}|${decision}`;
    let entry = acc.get(key);
    if (!entry) {
      entry = { bucketStart, decision, count: 0, reasons: [] };
      acc.set(key, entry);
    }
    entry.count++;
    const reason = typeof row.reason === 'string' ? row.reason : '';
    if (reason.length > 0) entry.reasons.push(reason);
  }

  const buckets: MismatchBucket[] = [];
  for (const entry of acc.values()) {
    buckets.push({
      bucketStart: entry.bucketStart,
      count: entry.count,
      decision: entry.decision,
      topReason: extractTopReason(entry.reasons),
    });
  }
  buckets.sort((a, b) => {
    if (a.bucketStart !== b.bucketStart) return a.bucketStart - b.bucketStart;
    // Stable secondary order on decision so callers see a deterministic shape.
    return a.decision.localeCompare(b.decision);
  });

  const modeWindows: ModeWindow[] = [
    { startTs: sinceTs, endTs: untilTs, mode: currentMode },
  ];

  const report: MismatchHeatmapReport = {
    generatedAt: Date.now() / 1000,
    sinceTs,
    untilTs,
    bucketSeconds,
    totalDenials,
    totalEscalations,
    modeWindows,
    buckets,
  };

  mismatchHeatmapCache.set(cacheKey, {
    report,
    expiresAt: Date.now() + MISMATCH_CACHE_TTL_MS,
  });
  return report;
}

// ---------------------------------------------------------------------------
// Wave 2.D: escalation metric series (drill-down trend sparkline)
// ---------------------------------------------------------------------------

interface EscalationMetricArgs {
  sinceTs?: number | null;
  untilTs?: number | null;
  periodSeconds?: number | null;
}

interface MetricDatapoint {
  timestamp: number;
  value: number;
}

interface MetricSeries {
  namespace: string;
  metric: string;
  statistic: string;
  periodSeconds: number;
  sinceTs: number;
  untilTs: number;
  datapoints: MetricDatapoint[];
  total: number;
}

// Allowlist of CloudWatch GetMetricStatistics period values the page exposes.
// 60 / 300 / 3600 / 86400 cover 1m, 5m, 1h, 1d aggregations; anything else is
// rejected so callers can't run unbounded high-resolution queries.
const ALLOWED_ESCALATION_PERIODS: ReadonlySet<number> = new Set([
  60, 300, 3600, 86400,
]);
const DEFAULT_ESCALATION_PERIOD_SECONDS = 3600;
const ESCALATION_WINDOW_DEFAULT_SECONDS = 7 * 86400;
const ESCALATION_WINDOW_MAX_SECONDS = 30 * 86400;
const ESCALATION_NAMESPACE = 'CitadelGovernance';
const ESCALATION_METRIC = 'OffFrontierEscalations';
const ESCALATION_STATISTIC = 'Sum';
// 60s in-memory cache to absorb repeat page loads. CloudWatch GetMetricStatistics
// cost is per-call; an admin spamming F5 on the page should not amplify into
// rate-limiting on the operator dashboards.
const ESCALATION_CACHE_TTL_MS = 60_000;

interface EscalationMetricCacheEntry {
  series: MetricSeries;
  expiresAt: number;
}
const escalationMetricCache = new Map<string, EscalationMetricCacheEntry>();

/** Test-only helper: clear the escalation metric cache. */
export function __resetEscalationMetricCacheForTest(): void {
  escalationMetricCache.clear();
}

async function getEscalationMetricSeries(
  event: AppSyncResolverEvent<EscalationMetricArgs>,
): Promise<MetricSeries> {
  if (!isAdminFromEvent(event)) {
    throw new Error('Forbidden: admin required');
  }

  const args = (event.arguments ?? {}) as EscalationMetricArgs;

  const requestedPeriod =
    typeof args.periodSeconds === 'number'
      ? args.periodSeconds
      : DEFAULT_ESCALATION_PERIOD_SECONDS;
  if (!ALLOWED_ESCALATION_PERIODS.has(requestedPeriod)) {
    throw new Error(
      `Invalid periodSeconds: ${requestedPeriod}. Allowed: 60, 300, 3600, 86400`,
    );
  }
  const periodSeconds = requestedPeriod;

  const nowSec = Math.floor(Date.now() / 1000);
  const untilTs =
    typeof args.untilTs === 'number' && args.untilTs > 0
      ? args.untilTs
      : nowSec;
  let sinceTs =
    typeof args.sinceTs === 'number' && args.sinceTs > 0
      ? args.sinceTs
      : untilTs - ESCALATION_WINDOW_DEFAULT_SECONDS;
  if (sinceTs > untilTs) {
    sinceTs = untilTs - ESCALATION_WINDOW_DEFAULT_SECONDS;
  }
  if (untilTs - sinceTs > ESCALATION_WINDOW_MAX_SECONDS) {
    sinceTs = untilTs - ESCALATION_WINDOW_MAX_SECONDS;
  }

  const cacheKey = `${sinceTs}|${untilTs}|${periodSeconds}`;
  const cached = escalationMetricCache.get(cacheKey);
  if (cached && Date.now() < cached.expiresAt) {
    return cached.series;
  }

  // Surface CloudWatch errors to the page (admin-only — operators need to see
  // why the trend is blank rather than silently rendering 0).
  const resp = await cloudwatch.send(
    new GetMetricStatisticsCommand({
      Namespace: ESCALATION_NAMESPACE,
      MetricName: ESCALATION_METRIC,
      StartTime: new Date(sinceTs * 1000),
      EndTime: new Date(untilTs * 1000),
      Period: periodSeconds,
      Statistics: [ESCALATION_STATISTIC],
    }),
  );

  const datapoints: MetricDatapoint[] = (resp.Datapoints ?? [])
    .map((p) => ({
      timestamp: p.Timestamp ? Math.floor(p.Timestamp.getTime() / 1000) : 0,
      value: typeof p.Sum === 'number' ? p.Sum : 0,
    }))
    .sort((a, b) => a.timestamp - b.timestamp);

  const total = datapoints.reduce((sum, d) => sum + d.value, 0);

  const series: MetricSeries = {
    namespace: ESCALATION_NAMESPACE,
    metric: ESCALATION_METRIC,
    statistic: ESCALATION_STATISTIC,
    periodSeconds,
    sinceTs,
    untilTs,
    datapoints,
    total,
  };

  escalationMetricCache.set(cacheKey, {
    series,
    expiresAt: Date.now() + ESCALATION_CACHE_TTL_MS,
  });
  return series;
}

// ---------------------------------------------------------------------------
// Wave 2.E: setGovernanceMode mutation
// ---------------------------------------------------------------------------
//
// PRODUCTION-AFFECTING. The transition matrix below is the authoritative
// source for permitted mode flips; any divergence from
// docs/GOVERNANCE_ROLLOUT_RUNBOOK.md (Decision #6 / #8) is a contract bug.
//
// Validation order is fixed: admin → acknowledgement → target mode allowlist
// → current mode (read SSM directly to bypass the 60-min cache) → transition
// rule → SSM enforce write → effective_at write (best-effort) → audit event
// (best-effort). Once the SSM enforce write succeeds the resolver reports
// success even if the audit-trail writes fail; the mode flip is the primary
// goal and the operator already sees the new badge within one cache TTL.
//
// Audit event path: the existing emitGovernanceEvent helper (Source =
// 'citadel.backend') is used because GovernancePayloadMap accepts a new
// key without breaking exports. The alternative bypass-helper path
// described in the spec (Source = 'citadel.governance') was therefore not
// needed.

interface SetGovernanceModeInput {
  targetMode: string;
  acknowledgement: string;
  reason?: string | null;
}

interface SetGovernanceModeArgs {
  input: SetGovernanceModeInput;
}

interface SetGovernanceModeResult {
  ok: boolean;
  previousMode: string;
  newMode: string;
  effectiveAt: string | null;
  noop: boolean;
  emittedEventDetailType: string | null;
}

// MUST match the frontend constant in governanceService.ts. Any drift is a
// contract bug — the modal also enforces this string client-side.
const MODE_FLIP_ACKNOWLEDGEMENT_TEXT =
  'I understand this affects production governance enforcement';

type GovernanceMode = 'permissive' | 'shadow' | 'strict';

/**
 * Direct SSM read for the current mode. Bypasses the 60-min cached
 * `getGovernanceEnforce` helper because this resolver makes a state
 * decision based on the read value — a stale cached read could send a
 * `permissive→strict` transition through the `shadow→strict` allowed path
 * if the cache held an earlier `shadow` value after a recent rollback.
 * Falls back to 'permissive' on ParameterNotFound (matches the helper's
 * fail-safe default).
 */
async function readCurrentModeFromSsm(env: string): Promise<GovernanceMode> {
  const parameterName = `/citadel/governance/enforce/${env}`;
  try {
    const resp = await ssm.send(new GetParameterCommand({ Name: parameterName }));
    const value = resp.Parameter?.Value ?? '';
    if (value === 'permissive' || value === 'shadow' || value === 'strict') {
      return value;
    }
    return 'permissive';
  } catch {
    return 'permissive';
  }
}

/**
 * Apply the transition matrix from Decision #6 / #8.
 *
 * Allowed (returns null):
 *   permissive → shadow
 *   permissive → strict   (only when env does NOT start with 'prod')
 *   shadow     → strict
 *   shadow     → permissive (rollback)
 *   strict     → permissive (rollback)
 *
 * Rejected (returns the error message to throw):
 *   permissive → strict   (in production)
 *   strict     → shadow   (rollback to shadow not permitted)
 *
 * Same-mode transitions (X → X) are handled by the caller as a no-op
 * before this function is called.
 */
function validateTransition(
  currentMode: GovernanceMode,
  targetMode: GovernanceMode,
  env: string,
): string | null {
  if (currentMode === 'permissive' && targetMode === 'shadow') return null;
  if (currentMode === 'permissive' && targetMode === 'strict') {
    if (env.startsWith('prod')) {
      return 'Decision #8: production must flip via shadow first; permissive→strict not permitted';
    }
    return null;
  }
  if (currentMode === 'shadow' && targetMode === 'strict') return null;
  if (currentMode === 'shadow' && targetMode === 'permissive') return null;
  if (currentMode === 'strict' && targetMode === 'permissive') return null;
  if (currentMode === 'strict' && targetMode === 'shadow') {
    return 'Strict can only roll back to permissive; rollback to shadow not permitted';
  }
  // Defensive — every (currentMode, targetMode) pair where currentMode !==
  // targetMode is covered above; reject anything else explicitly.
  return `Unsupported transition: ${currentMode}→${targetMode}`;
}

async function setGovernanceMode(
  event: AppSyncResolverEvent<SetGovernanceModeArgs>,
): Promise<SetGovernanceModeResult> {
  // Wave 3.A delivered: EventBridge-triggered governance-mode-refresher Lambda
  // listens for `governance.mode.transition` events and bumps MODE_GENERATION
  // env var on each governance-aware Lambda via UpdateFunctionConfiguration.
  // Container recycling typically completes within 1–3 minutes under traffic;
  // new invocations after UpdateFunctionConfiguration returns use the new value
  // immediately. As more Lambdas adopt governance-flag.ts, add their function
  // names to GOVERNANCE_AWARE_FUNCTIONS in arbiter-stack.ts.
  //
  // FUTURE: see `.kiro/specs/governance-ui/waves-2-5-roadmap.md` §3.5 for
  // further-tightening options (shortened SSM cache TTL).

  // 1. Admin gate — defense in depth (AppSync auth already runs upstream).
  if (!isAdminFromEvent(event)) {
    throw new Error('Forbidden: admin required');
  }

  const args = (event.arguments ?? ({} as SetGovernanceModeArgs)) as SetGovernanceModeArgs;
  const input = args.input ?? ({} as SetGovernanceModeInput);

  // 2. Acknowledgement — exact-string check; matches the frontend modal's
  //    Gate 3 checkbox label so callers cannot bypass via direct API misuse.
  if (input.acknowledgement !== MODE_FLIP_ACKNOWLEDGEMENT_TEXT) {
    throw new Error('Acknowledgement string mismatch');
  }

  // 3. Target mode allowlist.
  if (
    input.targetMode !== 'permissive' &&
    input.targetMode !== 'shadow' &&
    input.targetMode !== 'strict'
  ) {
    throw new Error(`Invalid target mode: ${input.targetMode}`);
  }
  const targetMode = input.targetMode as GovernanceMode;

  const env = process.env.ENVIRONMENT || 'unknown';

  // 4. Read current mode directly from SSM (bypass 60-min cache).
  const previousMode = await readCurrentModeFromSsm(env);

  // 5a. No-op when same mode — skip writes and audit event entirely.
  if (previousMode === targetMode) {
    const existingEffectiveAt = await getEffectiveAtRaw(env);
    return {
      ok: true,
      previousMode,
      newMode: targetMode,
      effectiveAt:
        existingEffectiveAt && existingEffectiveAt !== '__EMPTY__'
          ? existingEffectiveAt
          : null,
      noop: true,
      emittedEventDetailType: null,
    };
  }

  // 5b. Transition validation (Decision #6 / #8).
  const transitionError = validateTransition(previousMode, targetMode, env);
  if (transitionError) {
    throw new Error(transitionError);
  }

  // 6. SSM enforce write — primary goal. Failure propagates so the operator
  //    sees an error toast and the badge stays on the previous mode.
  const enforceParameterName = `/citadel/governance/enforce/${env}`;
  await ssm.send(
    new PutParameterCommand({
      Name: enforceParameterName,
      Value: targetMode,
      Type: 'String',
      Overwrite: true,
    }),
  );

  // 7. effective_at update — best-effort. Logged on failure but does NOT
  //    roll back the enforce write (the mode flip already succeeded).
  let effectiveAtUpdated = false;
  let effectiveAtValue: string | null = null;
  try {
    const existingEffectiveAt = await getEffectiveAtRaw(env);
    if (
      existingEffectiveAt === '__EMPTY__' &&
      (targetMode === 'shadow' || targetMode === 'strict')
    ) {
      const nowIso = new Date().toISOString();
      const effectiveAtParameterName = `/citadel/governance/effective_at/${env}`;
      await ssm.send(
        new PutParameterCommand({
          Name: effectiveAtParameterName,
          Value: nowIso,
          Type: 'String',
          Overwrite: true,
        }),
      );
      effectiveAtUpdated = true;
      effectiveAtValue = nowIso;
    } else if (existingEffectiveAt && existingEffectiveAt !== '__EMPTY__') {
      // Existing audit-trail value is preserved; rollback flips to
      // permissive leave the original flip timestamp in place.
      effectiveAtValue = existingEffectiveAt;
    }
  } catch (err) {
    console.error('setGovernanceMode: effective_at write/read failed', err);
  }

  // 8. Audit event — best-effort. Logged on failure but does NOT roll back
  //    the enforce write.
  let emittedEventDetailType: string | null = null;
  try {
    const actorSub = readActorSub(event);
    await emitGovernanceEvent('governance.mode.transition', {
      previousMode,
      newMode: targetMode,
      env,
      reason: input.reason ?? null,
      actorSub,
      timestamp: new Date().toISOString(),
      effectiveAtUpdated,
    });
    emittedEventDetailType = 'governance.mode.transition';
  } catch (err) {
    console.error('setGovernanceMode: audit event emit failed', err);
  }

  return {
    ok: true,
    previousMode,
    newMode: targetMode,
    effectiveAt: effectiveAtValue,
    noop: false,
    emittedEventDetailType,
  };
}

/**
 * Read the raw effective_at SSM value (preserving the '__EMPTY__' sentinel
 * so the caller can distinguish "never set" from "set to a real ISO").
 * Returns null on read failure so the mode-flip path can continue without
 * rolling back the enforce write.
 */
async function getEffectiveAtRaw(env: string): Promise<string | null> {
  const parameterName = `/citadel/governance/effective_at/${env}`;
  try {
    const resp = await ssm.send(new GetParameterCommand({ Name: parameterName }));
    return resp.Parameter?.Value ?? null;
  } catch {
    return null;
  }
}

/**
 * Best-effort actor extraction from the AppSync identity envelope. We use
 * `sub` first, then `username`, then fall back to a marker so the audit
 * event always has a non-empty value (the consumer can disambiguate by
 * inspecting the marker).
 */
function readActorSub(event: AppSyncResolverEvent<unknown>): string {
  const identity = (event.identity ?? {}) as Record<string, unknown>;
  const sub = identity.sub;
  if (typeof sub === 'string' && sub.length > 0) return sub;
  const username = identity.username;
  if (typeof username === 'string' && username.length > 0) return username;
  return '<unknown>';
}

// ---------------------------------------------------------------------------
// Wave 2.B.2: markReadinessCheckVerified mutation
// ---------------------------------------------------------------------------
//
// Admin-only attestation that an operator has performed a manual readiness
// check (e.g. PagerDuty drill, runbook annotation). The mutation writes a
// small JSON envelope to SSM at
// `/citadel/governance/readiness/manual/${env}/${checkId}` and the
// readiness page promotes the matching stub to PASS until the
// `expiresAt` timestamp lapses. Allowlists guard both the checkId
// (the 4 manual-only stubs) and the expiresInDays window (1, 3, 7, 30)
// so the SSM write surface is bounded.

interface MarkReadinessCheckVerifiedInput {
  checkId: string;
  expiresInDays?: number | null;
  note?: string | null;
}

interface MarkReadinessCheckVerifiedArgs {
  input: MarkReadinessCheckVerifiedInput;
}

interface MarkReadinessCheckVerifiedResult {
  ok: boolean;
  checkId: string;
  verifiedAt: string;
  expiresAt: string;
  verifiedBy: string;
}

const MANUAL_VERIFICATION_ALLOWLIST: ReadonlySet<string> = new Set([
  'own-1',
  'own-2',
  'own-3',
]);

const VALID_EXPIRES_IN_DAYS: ReadonlySet<number> = new Set([1, 3, 7, 30]);
const DEFAULT_EXPIRES_IN_DAYS = 7;

/**
 * Best-effort actor extraction tailored to the verification mutation —
 * differs from `readActorSub` in that the documented fallback marker is
 * the literal `'unknown'` (no angle brackets). Operators see this string
 * verbatim on the readiness detail line, so we keep it human-friendly.
 */
function readVerifierFromEvent(event: AppSyncResolverEvent<unknown>): string {
  const identity = (event.identity ?? {}) as Record<string, unknown>;
  const sub = identity.sub;
  if (typeof sub === 'string' && sub.length > 0) return sub;
  const username = identity.username;
  if (typeof username === 'string' && username.length > 0) return username;
  return 'unknown';
}

async function markReadinessCheckVerified(
  event: AppSyncResolverEvent<MarkReadinessCheckVerifiedArgs>,
): Promise<MarkReadinessCheckVerifiedResult> {
  // 1. Admin gate — defense in depth (AppSync auth runs upstream).
  if (!isAdminFromEvent(event)) {
    throw new Error('Forbidden: admin required');
  }

  const args = (event.arguments ?? ({} as MarkReadinessCheckVerifiedArgs)) as MarkReadinessCheckVerifiedArgs;
  const input = args.input ?? ({} as MarkReadinessCheckVerifiedInput);
  const checkId = typeof input.checkId === 'string' ? input.checkId : '';

  // 2. checkId must be one of the 4 manual-only stub IDs. The 7 real
  //    checks (data-1, data-2, data-3, tel-1, tel-2, tel-3, rb-1) are
  //    computed server-side and cannot be marked verified by an
  //    operator.
  if (!MANUAL_VERIFICATION_ALLOWLIST.has(checkId)) {
    throw new Error(
      `Check ID not in manual-verification allowlist: ${checkId}`,
    );
  }

  // 3. expiresInDays allowlist — keeps the verification window short
  //    (the longest is 30d, matching the runbook's "short-term
  //    verification" guidance).
  const requestedDays =
    typeof input.expiresInDays === 'number' && Number.isFinite(input.expiresInDays)
      ? input.expiresInDays
      : DEFAULT_EXPIRES_IN_DAYS;
  if (!VALID_EXPIRES_IN_DAYS.has(requestedDays)) {
    throw new Error(
      `Invalid expiresInDays: ${requestedDays}. Allowed: 1, 3, 7, 30`,
    );
  }

  const verifiedBy = readVerifierFromEvent(event);
  const verifiedAtMs = Date.now();
  const verifiedAt = new Date(verifiedAtMs).toISOString();
  const expiresAt = new Date(
    verifiedAtMs + requestedDays * 86_400_000,
  ).toISOString();

  const env = process.env.ENVIRONMENT || 'unknown';
  const paramName = manualVerificationParamName(env, checkId);
  const noteValue =
    typeof input.note === 'string' && input.note.length > 0 ? input.note : null;
  const payload = JSON.stringify({
    verifiedAt,
    verifiedBy,
    expiresAt,
    note: noteValue,
  });

  // SSM write failure propagates — the caller surfaces the error in the
  // dialog and the operator can retry.
  await ssm.send(
    new PutParameterCommand({
      Name: paramName,
      Value: payload,
      Type: 'String',
      Overwrite: true,
    }),
  );

  // Invalidate the per-env verification cache so the next
  // getRolloutReadiness call observes the freshly-written record
  // immediately rather than waiting out the 30s TTL.
  manualVerificationCache.delete(env);

  return {
    ok: true,
    checkId,
    verifiedAt,
    expiresAt,
    verifiedBy,
  };
}

// ---------------------------------------------------------------------------
// Wave 3.C — publishGovernanceFinding (fanout-only mutation)
// ---------------------------------------------------------------------------
//
// The mutation is declared `@aws_iam` ONLY in schema.graphql so AppSync
// rejects user-pool callers at the directive layer. This handler adds a
// defence-in-depth check on the resolver event identity: an IAM-authed
// AppSync invocation surfaces an `AppSyncIdentityIAM` shape (has
// `accountId` and lacks the Cognito `sub`/`claims` shape). Any other
// shape — Cognito user pool, OIDC, API key, anonymous — is rejected so
// even a misconfigured directive change cannot leak the mutation to
// non-IAM callers.
//
// The handler returns the input unchanged. The fanout Lambda has already
// projected the ledger row into the camelCase mutation input shape, and
// the AppSync subscription receives whatever the resolver returns. No
// DDB write is performed here — the Python ledger writer has already
// recorded the finding before the DDB stream fired.

interface PublishGovernanceFindingArgs {
  input: {
    findingId: string;
    workflowId: string;
    decision: string;
    reason: string;
    requestingAgent: string;
    targetAgent: string;
    scopeEvaluated: string | null;
    contractEvaluated: string | null;
    escalationTarget: string | null;
    residualAuthorityDenial: boolean | null;
    timestamp: number;
  };
}

/**
 * Returns true when the event identity looks like an IAM-authed call.
 *
 * AppSync's `AppSyncIdentityIAM` shape has `accountId` (and `userArn`,
 * `cognitoIdentityPoolId`, etc.) but NO `claims` / `sub` (those belong
 * to user-pool / OIDC identities). API-key callers have `null` identity,
 * anonymous callers also `null`.
 */
export function isIamIdentity(identity: unknown): boolean {
  if (!identity || typeof identity !== 'object') return false;
  const id = identity as Record<string, unknown>;
  // Reject anything that smells like a user-pool / OIDC token. Both
  // `claims` (Cognito) and `sub` (Cognito + OIDC) are absent for IAM
  // calls.
  if (id.claims !== undefined) return false;
  if (typeof id.sub === 'string') return false;
  // Require the IAM-distinct field. AppSync surfaces `accountId` for
  // every IAM-authed invocation.
  if (typeof id.accountId !== 'string' || id.accountId.length === 0) {
    return false;
  }
  return true;
}

export function publishGovernanceFinding(
  event: AppSyncResolverEvent<PublishGovernanceFindingArgs>,
): PublishGovernanceFindingArgs['input'] {
  if (!isIamIdentity(event.identity)) {
    throw new Error('Forbidden: publishGovernanceFinding is IAM-only');
  }
  const input = event.arguments?.input;
  if (!input) {
    throw new Error('publishGovernanceFinding: missing input');
  }
  // Pass-through. The fanout Lambda already projected snake_case ledger
  // fields into the camelCase mutation input; the AppSync subscription
  // receives this object as-is.
  return input;
}

// ---------------------------------------------------------------------------
// Wave 4.A — authority graph projections
// ---------------------------------------------------------------------------
//
// Read-only projections of the per-app authority topology. Both queries are
// admin-only and project the four governance DDB tables' rows into the
// GraphQL shapes documented in schema.graphql §Wave 4.A.
//
// Caching: each query keeps a 60s in-process cache because the authority
// graph page calls these on every render and on every filter change. The
// 5000-row scan cap matches the hierarchy.py loader; truncation logs a
// CloudWatch warning so operators see when the live topology has outgrown
// the cap.

const WAVE4_GLOBAL_REGISTRY_ID = '*GLOBAL*';
const WAVE4_SCAN_CAP = 5000;
const WAVE4_CACHE_TTL_MS = 60_000;

interface AuthorityScopeProjected {
  decisionType: string;
  domain: string;
  conditions: string; // JSON string of map
  limits: string; // JSON string of map
  specificity: number;
}

interface AuthorityUnitProjected {
  unitId: string;
  agentId: string;
  scope: AuthorityScopeProjected;
  delegationSource: string | null;
  canRedelegate: boolean;
  expiryTimestamp: number | null;
  revoked: boolean;
  riskRating: string;
  registryId: string | null;
  isValid: boolean;
}

interface CompositionContractProjected {
  contractId: string;
  partyA: string;
  partyB: string;
  authorityPrecedence: string;
  conflictResolution: string;
  invariants: string[];
  stopRights: string[];
  scope: AuthorityScopeProjected;
  escalationPath: string | null;
}

interface ListAuthorityUnitsArgs {
  registryId?: string | null;
  includeRevoked?: boolean | null;
}

// Per-key cache buckets so different filter combinations don't evict each
// other. Cache key: `${registryId ?? '__ALL__'}|${includeRevoked}`.
interface AuthorityUnitsCacheEntry {
  units: AuthorityUnitProjected[];
  expiresAt: number;
}
const authorityUnitsCache = new Map<string, AuthorityUnitsCacheEntry>();

interface CompositionContractsCacheEntry {
  contracts: CompositionContractProjected[];
  expiresAt: number;
}
let compositionContractsCache: CompositionContractsCacheEntry | null = null;

/** Test-only helper: clear the Wave 4.A authority-units cache. */
export function __resetAuthorityUnitsCacheForTest(): void {
  authorityUnitsCache.clear();
}

/** Test-only helper: clear the Wave 4.A composition-contracts cache. */
export function __resetCompositionContractsCacheForTest(): void {
  compositionContractsCache = null;
}

/**
 * Parse a value that may be a DDB-deserialised object/list or a JSON-string
 * encoding of one. Returns the supplied default when the value is missing
 * or cannot be parsed. Mirrors hierarchy.py's `_maybe_json` helper so the
 * frontend sees the same forward-compatible behaviour as the engine.
 */
function maybeJson<T>(value: unknown, defaultValue: T): T {
  if (value === undefined || value === null) return defaultValue;
  if (typeof value === 'string') {
    if (value.length === 0) return defaultValue;
    try {
      const parsed = JSON.parse(value);
      return parsed as T;
    } catch {
      return defaultValue;
    }
  }
  return value as T;
}

/**
 * Project the `scope` attribute (stored as either a JSON string or a
 * deserialised object on DDB) into the GraphQL `AuthorityScope` shape.
 * `conditions` and `limits` are stringified back to JSON for transport;
 * the frontend parses them on render.
 *
 * `specificity` mirrors the `AuthorityScope.specificity` property in
 * arbiter/governance/models.py — the count of conditions + limits keys.
 */
function projectAuthorityScope(rawScope: unknown): AuthorityScopeProjected {
  const scope = maybeJson<Record<string, unknown>>(rawScope, {});
  const decisionType =
    typeof scope.decision_type === 'string'
      ? scope.decision_type
      : typeof scope.decisionType === 'string'
        ? scope.decisionType
        : '*';
  const domain = typeof scope.domain === 'string' ? scope.domain : '*';
  const conditionsObj =
    scope.conditions && typeof scope.conditions === 'object' && !Array.isArray(scope.conditions)
      ? (scope.conditions as Record<string, unknown>)
      : {};
  const limitsObj =
    scope.limits && typeof scope.limits === 'object' && !Array.isArray(scope.limits)
      ? (scope.limits as Record<string, unknown>)
      : {};
  const specificity =
    Object.keys(conditionsObj).length + Object.keys(limitsObj).length;
  return {
    decisionType,
    domain,
    conditions: JSON.stringify(conditionsObj),
    limits: JSON.stringify(limitsObj),
    specificity,
  };
}

function projectAuthorityUnit(row: DdbRow): AuthorityUnitProjected | null {
  const unitId = typeof row.unitId === 'string' ? row.unitId : '';
  const agentId = typeof row.agentId === 'string' ? row.agentId : '';
  if (unitId.length === 0 || agentId.length === 0) {
    // Skip malformed rows rather than returning a partial — mirrors the
    // hierarchy.py loader which logs and drops these.
    console.warn(
      'projectAuthorityUnit: skipping malformed row',
      JSON.stringify({ keys: Object.keys(row) }),
    );
    return null;
  }
  const expiryRaw = row.expiryTimestamp;
  const expiryTimestamp =
    typeof expiryRaw === 'number'
      ? expiryRaw
      : typeof expiryRaw === 'string' && expiryRaw.length > 0
        ? Number(expiryRaw)
        : null;
  const revoked = row.revoked === true;
  const isValid =
    !revoked &&
    (expiryTimestamp === null ||
      Number.isNaN(expiryTimestamp) ||
      expiryTimestamp * 1000 > Date.now());
  return {
    unitId,
    agentId,
    scope: projectAuthorityScope(row.scope),
    delegationSource:
      typeof row.delegationSource === 'string' ? row.delegationSource : null,
    canRedelegate: row.canRedelegate === true,
    expiryTimestamp:
      expiryTimestamp !== null && !Number.isNaN(expiryTimestamp)
        ? expiryTimestamp
        : null,
    revoked,
    riskRating:
      typeof row.riskRating === 'string' && row.riskRating.length > 0
        ? row.riskRating
        : 'low',
    registryId:
      typeof row.registryId === 'string' && row.registryId.length > 0
        ? row.registryId
        : null,
    isValid,
  };
}

/**
 * Coerce a stop_rights / invariants attribute to `string[]`. Tolerates
 * three storage shapes:
 *   * native DDB list of strings (already an array of strings)
 *   * JSON-string encoding of an array
 *   * single string (wrapped in a one-element array)
 * Anything else maps to an empty array.
 */
function coerceStringList(value: unknown): string[] {
  if (Array.isArray(value)) {
    return value
      .filter((v): v is string => typeof v === 'string' && v.length > 0);
  }
  if (typeof value === 'string') {
    if (value.length === 0) return [];
    try {
      const parsed = JSON.parse(value);
      if (Array.isArray(parsed)) {
        return parsed.filter(
          (v): v is string => typeof v === 'string' && v.length > 0,
        );
      }
      return [value];
    } catch {
      return [value];
    }
  }
  return [];
}

function projectCompositionContract(
  row: DdbRow,
): CompositionContractProjected | null {
  const contractId = typeof row.contractId === 'string' ? row.contractId : '';
  const partyA = typeof row.partyA === 'string' ? row.partyA : '';
  const partyB = typeof row.partyB === 'string' ? row.partyB : '';
  if (contractId.length === 0 || partyA.length === 0 || partyB.length === 0) {
    console.warn(
      'projectCompositionContract: skipping malformed row',
      JSON.stringify({ keys: Object.keys(row) }),
    );
    return null;
  }
  return {
    contractId,
    partyA,
    partyB,
    authorityPrecedence:
      typeof row.authorityPrecedence === 'string'
        ? row.authorityPrecedence
        : 'none',
    conflictResolution:
      typeof row.conflictResolution === 'string'
        ? row.conflictResolution
        : 'default_deny',
    invariants: coerceStringList(row.invariants),
    stopRights: coerceStringList(row.stopRights),
    scope: projectAuthorityScope(row.scope),
    escalationPath:
      typeof row.escalationPath === 'string' ? row.escalationPath : null,
  };
}

async function listAuthorityUnits(
  event: AppSyncResolverEvent<ListAuthorityUnitsArgs>,
): Promise<AuthorityUnitProjected[]> {
  if (!isAdminFromEvent(event)) {
    throw new Error('Forbidden: admin required');
  }

  const tableName = process.env.AUTHORITY_UNITS_TABLE;
  if (!tableName) {
    throw new Error('AUTHORITY_UNITS_TABLE env var is not set');
  }

  const args = (event.arguments ?? {}) as ListAuthorityUnitsArgs;
  const registryId =
    typeof args.registryId === 'string' && args.registryId.length > 0
      ? args.registryId
      : null;
  const includeRevoked = args.includeRevoked === true;

  const cacheKey = `${registryId ?? '__ALL__'}|${includeRevoked}`;
  const cached = authorityUnitsCache.get(cacheKey);
  if (cached && Date.now() < cached.expiresAt) {
    return cached.units;
  }

  // Build the scan command. Filtering is pushed to DDB where possible:
  //   * registryId filter uses `IN (:rid, :global)` when supplied
  //   * revoked filter excludes revoked rows by default
  // Both can be combined; the combined filter expression is built below.
  const filterClauses: string[] = [];
  const expressionAttributeNames: Record<string, string> = {};
  const expressionAttributeValues: Record<string, unknown> = {};

  if (registryId !== null) {
    filterClauses.push('#rid IN (:rid, :global)');
    expressionAttributeNames['#rid'] = 'registryId';
    expressionAttributeValues[':rid'] = registryId;
    expressionAttributeValues[':global'] = WAVE4_GLOBAL_REGISTRY_ID;
  }
  if (!includeRevoked) {
    filterClauses.push('attribute_not_exists(#revoked) OR #revoked = :false');
    expressionAttributeNames['#revoked'] = 'revoked';
    expressionAttributeValues[':false'] = false;
  }

  const items: DdbRow[] = [];
  let lastEvaluatedKey: Record<string, unknown> | undefined;
  let truncated = false;

  do {
    const cmd = new ScanCommand({
      TableName: tableName,
      ...(filterClauses.length > 0
        ? {
            FilterExpression: filterClauses.join(' AND '),
            ExpressionAttributeNames: expressionAttributeNames,
            ExpressionAttributeValues: expressionAttributeValues,
          }
        : {}),
      ...(lastEvaluatedKey ? { ExclusiveStartKey: lastEvaluatedKey } : {}),
    });
    const result = await dynamodb.send(cmd);
    const page = (result.Items ?? []) as DdbRow[];
    for (const row of page) {
      if (items.length >= WAVE4_SCAN_CAP) {
        truncated = true;
        break;
      }
      items.push(row);
    }
    if (truncated) break;
    lastEvaluatedKey = result.LastEvaluatedKey as
      | Record<string, unknown>
      | undefined;
  } while (lastEvaluatedKey);

  if (truncated) {
    console.warn(
      `listAuthorityUnits: truncated at ${WAVE4_SCAN_CAP} rows ` +
        `(registryId=${registryId ?? '__ALL__'}, includeRevoked=${includeRevoked}). ` +
        'Tighten filters or extend the scan cap.',
    );
  }

  const units: AuthorityUnitProjected[] = [];
  for (const row of items) {
    const projected = projectAuthorityUnit(row);
    if (projected !== null) units.push(projected);
  }

  authorityUnitsCache.set(cacheKey, {
    units,
    expiresAt: Date.now() + WAVE4_CACHE_TTL_MS,
  });
  return units;
}

async function listCompositionContracts(
  event: AppSyncResolverEvent<unknown>,
): Promise<CompositionContractProjected[]> {
  if (!isAdminFromEvent(event)) {
    throw new Error('Forbidden: admin required');
  }

  const tableName = process.env.COMPOSITION_CONTRACTS_TABLE;
  if (!tableName) {
    throw new Error('COMPOSITION_CONTRACTS_TABLE env var is not set');
  }

  if (
    compositionContractsCache !== null &&
    Date.now() < compositionContractsCache.expiresAt
  ) {
    return compositionContractsCache.contracts;
  }

  const items: DdbRow[] = [];
  let lastEvaluatedKey: Record<string, unknown> | undefined;
  let truncated = false;

  do {
    const cmd = new ScanCommand({
      TableName: tableName,
      ...(lastEvaluatedKey ? { ExclusiveStartKey: lastEvaluatedKey } : {}),
    });
    const result = await dynamodb.send(cmd);
    const page = (result.Items ?? []) as DdbRow[];
    for (const row of page) {
      if (items.length >= WAVE4_SCAN_CAP) {
        truncated = true;
        break;
      }
      items.push(row);
    }
    if (truncated) break;
    lastEvaluatedKey = result.LastEvaluatedKey as
      | Record<string, unknown>
      | undefined;
  } while (lastEvaluatedKey);

  if (truncated) {
    console.warn(
      `listCompositionContracts: truncated at ${WAVE4_SCAN_CAP} rows. ` +
        'Tighten filters or extend the scan cap.',
    );
  }

  const contracts: CompositionContractProjected[] = [];
  for (const row of items) {
    const projected = projectCompositionContract(row);
    if (projected !== null) contracts.push(projected);
  }

  compositionContractsCache = {
    contracts,
    expiresAt: Date.now() + WAVE4_CACHE_TTL_MS,
  };
  return contracts;
}

// ---------------------------------------------------------------------------
// Wave 4.B — getRevokeImpact (blast-radius approximation)
// ---------------------------------------------------------------------------
//
// Approximates the blast radius of revoking a specific authority unit by
// scanning the governance ledger for permit findings where the unit was
// the matched scope (`scope_evaluated == unitId`) within the requested
// time window. A "true" blast radius requires re-running the engine
// against pending traffic; this proxy is what the spec
// (.kiro/specs/governance-ui/waves-2-5-roadmap.md §4.2) calls for.
//
// Admin-only. Window defaults to the last 1h and is capped at 24h.
// Cached for 30s keyed on `${unitId}|${sinceTs}|${untilTs}` so repeat
// page loads collapse to a single DDB scan within the window.

interface GetRevokeImpactArgs {
  unitId: string;
  sinceTs?: number | null;
  untilTs?: number | null;
}

interface RevokeImpactWorkflowProjected {
  workflowId: string;
  permitCount: number;
  lastTimestamp: number;
}

interface RevokeImpactAgentPairProjected {
  requestingAgent: string;
  targetAgent: string;
  permitCount: number;
}

interface RevokeImpactReportProjected {
  unitId: string;
  sinceTs: number;
  untilTs: number;
  totalPermits: number;
  distinctWorkflows: number;
  distinctAgentPairs: number;
  workflows: RevokeImpactWorkflowProjected[];
  agentPairs: RevokeImpactAgentPairProjected[];
  truncated: boolean;
}

const REVOKE_IMPACT_WINDOW_DEFAULT_SECONDS = 3600; // 1h
const REVOKE_IMPACT_WINDOW_MAX_SECONDS = 24 * 3600; // 24h cap
const REVOKE_IMPACT_SCAN_CAP = 5000;
const REVOKE_IMPACT_RESULT_CAP = 50;
const REVOKE_IMPACT_CACHE_TTL_MS = 30_000;

interface RevokeImpactCacheEntry {
  report: RevokeImpactReportProjected;
  expiresAt: number;
}

const revokeImpactCache = new Map<string, RevokeImpactCacheEntry>();

/** Test-only helper: clear the Wave 4.B revoke-impact cache. */
export function __resetRevokeImpactCacheForTest(): void {
  revokeImpactCache.clear();
}

async function scanRevokeImpactItems(
  tableName: string,
  unitId: string,
  sinceTs: number,
  untilTs: number,
): Promise<{ items: DdbRow[]; truncated: boolean }> {
  const items: DdbRow[] = [];
  let lastEvaluatedKey: Record<string, unknown> | undefined;
  let truncated = false;

  do {
    const cmd = new ScanCommand({
      TableName: tableName,
      FilterExpression:
        'scope_evaluated = :uid AND decision = :permit AND #ts BETWEEN :since AND :until',
      ExpressionAttributeNames: { '#ts': 'timestamp' },
      ExpressionAttributeValues: {
        ':uid': unitId,
        ':permit': 'permit',
        ':since': sinceTs,
        ':until': untilTs,
      },
      ...(lastEvaluatedKey ? { ExclusiveStartKey: lastEvaluatedKey } : {}),
    });
    const result = await dynamodb.send(cmd);
    const page = (result.Items ?? []) as DdbRow[];
    for (const row of page) {
      if (items.length >= REVOKE_IMPACT_SCAN_CAP) {
        truncated = true;
        break;
      }
      items.push(row);
    }
    if (truncated) break;
    lastEvaluatedKey = result.LastEvaluatedKey as
      | Record<string, unknown>
      | undefined;
  } while (lastEvaluatedKey);

  return { items, truncated };
}

async function getRevokeImpact(
  event: AppSyncResolverEvent<GetRevokeImpactArgs>,
): Promise<RevokeImpactReportProjected> {
  if (!isAdminFromEvent(event)) {
    throw new Error('Forbidden: admin required');
  }

  const tableName = process.env.GOVERNANCE_LEDGER_TABLE;
  if (!tableName) {
    throw new Error('GOVERNANCE_LEDGER_TABLE env var is not set');
  }

  const args = (event.arguments ?? {}) as GetRevokeImpactArgs;
  const unitId = typeof args.unitId === 'string' ? args.unitId : '';
  if (unitId.length === 0) {
    throw new Error('unitId is required');
  }

  // Resolve time window. Defaults: now − 1h to now. Window cap: 24h.
  const nowSec = Math.floor(Date.now() / 1000);
  const untilTs =
    typeof args.untilTs === 'number' && args.untilTs > 0 ? args.untilTs : nowSec;
  let sinceTs =
    typeof args.sinceTs === 'number' && args.sinceTs > 0
      ? args.sinceTs
      : untilTs - REVOKE_IMPACT_WINDOW_DEFAULT_SECONDS;
  if (sinceTs > untilTs) {
    sinceTs = untilTs - REVOKE_IMPACT_WINDOW_DEFAULT_SECONDS;
  }
  if (untilTs - sinceTs > REVOKE_IMPACT_WINDOW_MAX_SECONDS) {
    sinceTs = untilTs - REVOKE_IMPACT_WINDOW_MAX_SECONDS;
  }

  const cacheKey = `${unitId}|${sinceTs}|${untilTs}`;
  const cached = revokeImpactCache.get(cacheKey);
  if (cached && Date.now() < cached.expiresAt) {
    return cached.report;
  }

  const { items, truncated } = await scanRevokeImpactItems(
    tableName,
    unitId,
    sinceTs,
    untilTs,
  );

  if (truncated) {
    console.warn(
      `getRevokeImpact: scan truncated at ${REVOKE_IMPACT_SCAN_CAP} rows ` +
        `(unitId=${unitId}, window=${sinceTs}..${untilTs}).`,
    );
  }

  // Group by workflowId — count + max(timestamp).
  type WorkflowAcc = {
    workflowId: string;
    permitCount: number;
    lastTimestamp: number;
  };
  const workflowAcc = new Map<string, WorkflowAcc>();

  // Group by (requestingAgent, targetAgent) — count.
  type PairAcc = {
    requestingAgent: string;
    targetAgent: string;
    permitCount: number;
  };
  const pairAcc = new Map<string, PairAcc>();

  let totalPermits = 0;

  for (const row of items) {
    const decision =
      typeof row.decision === 'string' ? row.decision : '';
    const scopeEvaluated =
      typeof row.scope_evaluated === 'string' ? row.scope_evaluated : '';
    // Defence in depth: even though the FilterExpression already filters
    // these, an out-of-band write could slip through, so re-validate.
    if (decision !== 'permit' || scopeEvaluated !== unitId) continue;
    totalPermits++;

    const workflowId =
      typeof row.workflowId === 'string' ? row.workflowId : '';
    const tsRaw = row.timestamp;
    const ts =
      typeof tsRaw === 'number'
        ? tsRaw
        : typeof tsRaw === 'string'
          ? Number(tsRaw)
          : 0;
    if (workflowId.length > 0) {
      const existing = workflowAcc.get(workflowId);
      if (existing) {
        existing.permitCount++;
        if (Number.isFinite(ts) && ts > existing.lastTimestamp) {
          existing.lastTimestamp = ts;
        }
      } else {
        workflowAcc.set(workflowId, {
          workflowId,
          permitCount: 1,
          lastTimestamp: Number.isFinite(ts) ? ts : 0,
        });
      }
    }

    const requestingAgent =
      typeof row.requesting_agent === 'string' ? row.requesting_agent : '';
    const targetAgent =
      typeof row.target_agent === 'string' ? row.target_agent : '';
    if (requestingAgent.length > 0 && targetAgent.length > 0) {
      const pairKey = `${requestingAgent}|${targetAgent}`;
      const existing = pairAcc.get(pairKey);
      if (existing) {
        existing.permitCount++;
      } else {
        pairAcc.set(pairKey, {
          requestingAgent,
          targetAgent,
          permitCount: 1,
        });
      }
    }
  }

  // Pre-cap distinct counts (full unique sets) — REPORT-level metrics.
  const distinctWorkflows = workflowAcc.size;
  const distinctAgentPairs = pairAcc.size;

  // Sort + cap result lists. Sort key: permitCount descending; secondary
  // tiebreaker on the identifier so the order is deterministic.
  const workflows: RevokeImpactWorkflowProjected[] = Array.from(
    workflowAcc.values(),
  )
    .sort((a, b) => {
      if (a.permitCount !== b.permitCount) return b.permitCount - a.permitCount;
      return a.workflowId.localeCompare(b.workflowId);
    })
    .slice(0, REVOKE_IMPACT_RESULT_CAP);

  const agentPairs: RevokeImpactAgentPairProjected[] = Array.from(
    pairAcc.values(),
  )
    .sort((a, b) => {
      if (a.permitCount !== b.permitCount) return b.permitCount - a.permitCount;
      const aKey = `${a.requestingAgent}|${a.targetAgent}`;
      const bKey = `${b.requestingAgent}|${b.targetAgent}`;
      return aKey.localeCompare(bKey);
    })
    .slice(0, REVOKE_IMPACT_RESULT_CAP);

  const report: RevokeImpactReportProjected = {
    unitId,
    sinceTs,
    untilTs,
    totalPermits,
    distinctWorkflows,
    distinctAgentPairs,
    workflows,
    agentPairs,
    truncated,
  };

  revokeImpactCache.set(cacheKey, {
    report,
    expiresAt: Date.now() + REVOKE_IMPACT_CACHE_TTL_MS,
  });
  return report;
}

// ---------------------------------------------------------------------------
// Wave 4.C — constitutional rule tree
// ---------------------------------------------------------------------------
//
// Read-only projections of the constitutional layers + override statistics
// derived from the governance ledger. Both queries are admin-only.
//
// `listConstitutionalLayers` projects the per-layer rule sets (sorted
// pairwise > domain > global; tie-broken alphabetical by layerId). Rule
// values are stringified to JSON for transport; the frontend parses them
// on render. `exists` / `not_exists` rules surface a null value.
//
// `getConstitutionalRuleStats` aggregates ledger findings whose reason
// has the `constitutional_review:<layerId>:invariant_violated:<field>`
// shape (matching arbiter/governance/engine.py line 750-770) into per
// `(layerId, field)` overrides counts + last/first-fired timestamps +
// the top-5 affected agents.

const WAVE4C_LAYER_TYPE_ORDER: Record<string, number> = {
  pairwise: 0,
  domain: 1,
  global: 2,
};

const WAVE4C_LAYERS_CACHE_TTL_MS = 60_000;
const WAVE4C_STATS_CACHE_TTL_MS = 30_000;
const WAVE4C_STATS_WINDOW_DEFAULT_SECONDS = 7 * 86400;
const WAVE4C_STATS_WINDOW_MAX_SECONDS = 30 * 86400;
const WAVE4C_STATS_SCAN_CAP = 5000;
const WAVE4C_STATS_RESULT_CAP = 200;
const WAVE4C_STATS_TOP_AGENTS = 5;
const WAVE4C_LAYERS_SCAN_CAP = 5000;

interface ConstitutionalRuleProjected {
  field: string;
  operator: string;
  value: string | null;
}

interface ConstitutionalLayerProjected {
  layerId: string;
  layerType: string;
  appliesTo: string[];
  rules: ConstitutionalRuleProjected[];
  parentLayerId: string | null;
}

interface ConstitutionalRuleOverrideStatProjected {
  layerId: string;
  field: string;
  count7d: number;
  lastFiredAt: number | null;
  firstFiredAt: number | null;
  topAffectedAgents: string[];
}

interface ConstitutionRuleStatsReportProjected {
  generatedAt: number;
  sinceTs: number;
  untilTs: number;
  totalOverrides: number;
  stats: ConstitutionalRuleOverrideStatProjected[];
  truncated: boolean;
}

interface ConstitutionalLayersCacheEntry {
  layers: ConstitutionalLayerProjected[];
  expiresAt: number;
}

let constitutionalLayersCache: ConstitutionalLayersCacheEntry | null = null;

interface ConstitutionalRuleStatsCacheEntry {
  report: ConstitutionRuleStatsReportProjected;
  expiresAt: number;
}

const constitutionalRuleStatsCache = new Map<
  string,
  ConstitutionalRuleStatsCacheEntry
>();

/** Test-only helper: clear the Wave 4.C constitutional-layers cache. */
export function __resetConstitutionalLayersCacheForTest(): void {
  constitutionalLayersCache = null;
}

/** Test-only helper: clear the Wave 4.C rule-stats cache. */
export function __resetConstitutionalRuleStatsCacheForTest(): void {
  constitutionalRuleStatsCache.clear();
}

function projectAppliesTo(value: unknown): string[] {
  return coerceStringList(value);
}

function projectRule(raw: unknown): ConstitutionalRuleProjected | null {
  if (raw === null || raw === undefined) return null;
  const rule =
    typeof raw === 'string'
      ? maybeJson<Record<string, unknown>>(raw, {})
      : (raw as Record<string, unknown>);
  if (!rule || typeof rule !== 'object' || Array.isArray(rule)) return null;
  const field = typeof rule.field === 'string' ? rule.field : '';
  const operator = typeof rule.operator === 'string' ? rule.operator : 'eq';
  if (field.length === 0) return null;
  // exists / not_exists carry no value payload — surface null so the
  // frontend can render the rule without an empty `=== null` chip.
  let value: string | null;
  if (operator === 'exists' || operator === 'not_exists') {
    value = null;
  } else if (rule.value === undefined) {
    value = null;
  } else {
    try {
      value = JSON.stringify(rule.value);
    } catch {
      value = null;
    }
  }
  return { field, operator, value };
}

function projectConstitutionalLayer(
  row: DdbRow,
): ConstitutionalLayerProjected | null {
  const layerId = typeof row.layerId === 'string' ? row.layerId : '';
  if (layerId.length === 0) {
    console.warn(
      'projectConstitutionalLayer: skipping malformed row',
      JSON.stringify({ keys: Object.keys(row) }),
    );
    return null;
  }
  const layerType =
    typeof row.layerType === 'string' && row.layerType.length > 0
      ? row.layerType
      : 'global';
  const appliesTo = projectAppliesTo(row.appliesTo);
  const rawRules = maybeJson<unknown[]>(row.rules, []);
  const rules: ConstitutionalRuleProjected[] = [];
  if (Array.isArray(rawRules)) {
    for (const r of rawRules) {
      const projected = projectRule(r);
      if (projected !== null) rules.push(projected);
    }
  }
  return {
    layerId,
    layerType,
    appliesTo,
    rules,
    parentLayerId:
      typeof row.parentLayerId === 'string' ? row.parentLayerId : null,
  };
}

function compareLayers(
  a: ConstitutionalLayerProjected,
  b: ConstitutionalLayerProjected,
): number {
  const aOrder = WAVE4C_LAYER_TYPE_ORDER[a.layerType] ?? 99;
  const bOrder = WAVE4C_LAYER_TYPE_ORDER[b.layerType] ?? 99;
  if (aOrder !== bOrder) return aOrder - bOrder;
  return a.layerId.localeCompare(b.layerId);
}

async function listConstitutionalLayers(
  event: AppSyncResolverEvent<unknown>,
): Promise<ConstitutionalLayerProjected[]> {
  if (!isAdminFromEvent(event)) {
    throw new Error('Forbidden: admin required');
  }

  const tableName = process.env.CONSTITUTIONAL_LAYERS_TABLE;
  if (!tableName) {
    throw new Error('CONSTITUTIONAL_LAYERS_TABLE env var is not set');
  }

  if (
    constitutionalLayersCache !== null &&
    Date.now() < constitutionalLayersCache.expiresAt
  ) {
    return constitutionalLayersCache.layers;
  }

  const items: DdbRow[] = [];
  let lastEvaluatedKey: Record<string, unknown> | undefined;
  let truncated = false;

  do {
    const cmd = new ScanCommand({
      TableName: tableName,
      ...(lastEvaluatedKey ? { ExclusiveStartKey: lastEvaluatedKey } : {}),
    });
    const result = await dynamodb.send(cmd);
    const page = (result.Items ?? []) as DdbRow[];
    for (const row of page) {
      if (items.length >= WAVE4C_LAYERS_SCAN_CAP) {
        truncated = true;
        break;
      }
      items.push(row);
    }
    if (truncated) break;
    lastEvaluatedKey = result.LastEvaluatedKey as
      | Record<string, unknown>
      | undefined;
  } while (lastEvaluatedKey);

  if (truncated) {
    console.warn(
      `listConstitutionalLayers: truncated at ${WAVE4C_LAYERS_SCAN_CAP} rows. ` +
        'Tighten filters or extend the scan cap.',
    );
  }

  const layers: ConstitutionalLayerProjected[] = [];
  for (const row of items) {
    const projected = projectConstitutionalLayer(row);
    if (projected !== null) layers.push(projected);
  }
  layers.sort(compareLayers);

  constitutionalLayersCache = {
    layers,
    expiresAt: Date.now() + WAVE4C_LAYERS_CACHE_TTL_MS,
  };
  return layers;
}

interface GetConstitutionalRuleStatsArgs {
  sinceTs?: number | null;
  untilTs?: number | null;
}

/**
 * Parse an engine reason of the shape
 * `constitutional_review:<layerId>:invariant_violated:<field>` into
 * `{ layerId, field }`. Returns null for any reason that does not match
 * — silently skipped at the call site so malformed rows do not crater
 * the report.
 */
function parseConstitutionalReviewReason(
  reason: string,
): { layerId: string; field: string } | null {
  if (!reason.startsWith('constitutional_review:')) return null;
  const tokens = reason.split(':');
  // Expected: ['constitutional_review', layerId, 'invariant_violated', field]
  if (tokens.length < 4) return null;
  const layerId = tokens[1];
  if (tokens[2] !== 'invariant_violated') return null;
  // The field may itself contain ':' separators in pathological cases —
  // re-join the tail so a `field=foo:bar` style lands as one logical key.
  const field = tokens.slice(3).join(':');
  if (!layerId || !field) return null;
  return { layerId, field };
}

async function scanConstitutionalReviewItems(
  tableName: string,
  sinceTs: number,
  untilTs: number,
): Promise<{ items: DdbRow[]; truncated: boolean }> {
  const items: DdbRow[] = [];
  let lastEvaluatedKey: Record<string, unknown> | undefined;
  let truncated = false;

  do {
    const cmd = new ScanCommand({
      TableName: tableName,
      FilterExpression:
        'decision = :deny AND begins_with(reason, :prefix) AND #ts BETWEEN :since AND :until',
      ExpressionAttributeNames: { '#ts': 'timestamp' },
      ExpressionAttributeValues: {
        ':deny': 'deny',
        ':prefix': 'constitutional_review:',
        ':since': sinceTs,
        ':until': untilTs,
      },
      ...(lastEvaluatedKey ? { ExclusiveStartKey: lastEvaluatedKey } : {}),
    });
    const result = await dynamodb.send(cmd);
    const page = (result.Items ?? []) as DdbRow[];
    for (const row of page) {
      if (items.length >= WAVE4C_STATS_SCAN_CAP) {
        truncated = true;
        break;
      }
      items.push(row);
    }
    if (truncated) break;
    lastEvaluatedKey = result.LastEvaluatedKey as
      | Record<string, unknown>
      | undefined;
  } while (lastEvaluatedKey);

  return { items, truncated };
}

async function getConstitutionalRuleStats(
  event: AppSyncResolverEvent<GetConstitutionalRuleStatsArgs>,
): Promise<ConstitutionRuleStatsReportProjected> {
  if (!isAdminFromEvent(event)) {
    throw new Error('Forbidden: admin required');
  }

  const tableName = process.env.GOVERNANCE_LEDGER_TABLE;
  if (!tableName) {
    throw new Error('GOVERNANCE_LEDGER_TABLE env var is not set');
  }

  const args = (event.arguments ?? {}) as GetConstitutionalRuleStatsArgs;
  const nowSec = Math.floor(Date.now() / 1000);
  const untilTs =
    typeof args.untilTs === 'number' && args.untilTs > 0
      ? args.untilTs
      : nowSec;
  let sinceTs =
    typeof args.sinceTs === 'number' && args.sinceTs > 0
      ? args.sinceTs
      : untilTs - WAVE4C_STATS_WINDOW_DEFAULT_SECONDS;
  if (sinceTs > untilTs) {
    sinceTs = untilTs - WAVE4C_STATS_WINDOW_DEFAULT_SECONDS;
  }
  if (untilTs - sinceTs > WAVE4C_STATS_WINDOW_MAX_SECONDS) {
    sinceTs = untilTs - WAVE4C_STATS_WINDOW_MAX_SECONDS;
  }

  const cacheKey = `${sinceTs}|${untilTs}`;
  const cached = constitutionalRuleStatsCache.get(cacheKey);
  if (cached && Date.now() < cached.expiresAt) {
    return cached.report;
  }

  const { items, truncated } = await scanConstitutionalReviewItems(
    tableName,
    sinceTs,
    untilTs,
  );

  if (truncated) {
    console.warn(
      `getConstitutionalRuleStats: scan truncated at ${WAVE4C_STATS_SCAN_CAP} rows ` +
        `(window=${sinceTs}..${untilTs}).`,
    );
  }

  // Group findings by `(layerId, field)`. Track count, min/max timestamp,
  // and per-agent counts so the top-5 agents can be derived after the
  // pass without a second iteration.
  type StatAcc = {
    layerId: string;
    field: string;
    count: number;
    firstFiredAt: number;
    lastFiredAt: number;
    agentCounts: Map<string, number>;
  };
  const acc = new Map<string, StatAcc>();
  let totalOverrides = 0;

  for (const row of items) {
    const reason = typeof row.reason === 'string' ? row.reason : '';
    const parsed = parseConstitutionalReviewReason(reason);
    if (!parsed) continue;
    totalOverrides++;
    const tsRaw = row.timestamp;
    const ts =
      typeof tsRaw === 'number'
        ? tsRaw
        : typeof tsRaw === 'string'
          ? Number(tsRaw)
          : NaN;
    const requestingAgent =
      typeof row.requesting_agent === 'string' ? row.requesting_agent : '';
    const key = `${parsed.layerId}|${parsed.field}`;
    let entry = acc.get(key);
    if (!entry) {
      entry = {
        layerId: parsed.layerId,
        field: parsed.field,
        count: 0,
        firstFiredAt: Number.isFinite(ts) ? ts : Number.POSITIVE_INFINITY,
        lastFiredAt: Number.isFinite(ts) ? ts : Number.NEGATIVE_INFINITY,
        agentCounts: new Map<string, number>(),
      };
      acc.set(key, entry);
    }
    entry.count++;
    if (Number.isFinite(ts)) {
      if (ts < entry.firstFiredAt) entry.firstFiredAt = ts;
      if (ts > entry.lastFiredAt) entry.lastFiredAt = ts;
    }
    if (requestingAgent.length > 0) {
      entry.agentCounts.set(
        requestingAgent,
        (entry.agentCounts.get(requestingAgent) ?? 0) + 1,
      );
    }
  }

  const stats: ConstitutionalRuleOverrideStatProjected[] = [];
  for (const entry of acc.values()) {
    const sortedAgents = Array.from(entry.agentCounts.entries())
      .sort((a, b) => {
        if (a[1] !== b[1]) return b[1] - a[1];
        return a[0].localeCompare(b[0]);
      })
      .slice(0, WAVE4C_STATS_TOP_AGENTS)
      .map((pair) => pair[0]);
    stats.push({
      layerId: entry.layerId,
      field: entry.field,
      count7d: entry.count,
      lastFiredAt: Number.isFinite(entry.lastFiredAt)
        ? entry.lastFiredAt
        : null,
      firstFiredAt: Number.isFinite(entry.firstFiredAt)
        ? entry.firstFiredAt
        : null,
      topAffectedAgents: sortedAgents,
    });
  }

  stats.sort((a, b) => {
    if (a.count7d !== b.count7d) return b.count7d - a.count7d;
    if (a.layerId !== b.layerId) return a.layerId.localeCompare(b.layerId);
    return a.field.localeCompare(b.field);
  });
  const cappedStats = stats.slice(0, WAVE4C_STATS_RESULT_CAP);

  const report: ConstitutionRuleStatsReportProjected = {
    generatedAt: Date.now() / 1000,
    sinceTs,
    untilTs,
    totalOverrides,
    stats: cappedStats,
    truncated,
  };

  constitutionalRuleStatsCache.set(cacheKey, {
    report,
    expiresAt: Date.now() + WAVE4C_STATS_CACHE_TTL_MS,
  });
  return report;
}

// ---------------------------------------------------------------------------
// Wave 4.D — case-law timeline
// ---------------------------------------------------------------------------
//
// Read-only projection of the case-law DDB table. Admin-only — the
// resolver rejects non-admin callers at the dispatch layer. Encode /
// revoke admin actions ship in Wave 4.D.2; this wave is read-only.
//
// Schema reconciliation (CDK ``CaseLawTable`` ←→ engine row shape):
//   entryId               (PK, string)            -> caseId
//   pattern               (map | JSON string)     -> pattern (JSON string)
//   resolution            (string)                -> resolution (allowlist
//                                                     guard; unknown values
//                                                     coerce to 'unknown')
//   createdAt             (ISO-8601 OR legacy
//                          epoch float)           -> encodedAt (ISO-8601)
//   createdBy             (string)                -> encodedBy
//   scopeOfApplicability  (map | JSON string)     -> scopeOfApplicability
//                                                     (JSON string)
//   precedence            (number)                -> precedence (Number())
//   revoked               (bool)                  -> revoked
//
// `arbiter/governance/hierarchy.py` already filters revoked rows at
// engine load time so the engine never sees them. The UI surfaces them
// by opt-in (`includeRevoked: true`) for audit visibility — operators
// need to see the revocation history without re-querying DDB through
// the admin CLI.
//
// Cached for 60s keyed on the `includeRevoked` flag because the page
// renders a single scan per filter combination and admins frequently
// toggle the switch back and forth while reading the timeline.

const WAVE4D_CASE_LAW_CACHE_TTL_MS = 60_000;
const WAVE4D_CASE_LAW_SCAN_CAP = 5000;

interface CaseLawEntryProjected {
  caseId: string;
  pattern: string;
  resolution: string;
  encodedAt: string;
  encodedBy: string;
  scopeOfApplicability: string;
  precedence: number;
  revoked: boolean;
}

interface ListCaseLawArgs {
  includeRevoked?: boolean | null;
}

interface CaseLawCacheEntry {
  entries: CaseLawEntryProjected[];
  expiresAt: number;
}

// Cache keyed on the `includeRevoked` flag. Two slots: 'with' (revoked
// included) and 'without' (revoked excluded). Two scans is the worst
// case and within a 60s window the second is served from cache.
const caseLawCache = new Map<string, CaseLawCacheEntry>();

const VALID_CASE_LAW_RESOLUTIONS: ReadonlySet<string> = new Set([
  'permit',
  'deny',
  'escalate',
  'halt',
]);

/** Test-only helper: clear the Wave 4.D case-law cache. */
export function __resetCaseLawCacheForTest(): void {
  caseLawCache.clear();
}

/**
 * Normalise the `createdAt` attribute to an ISO-8601 string.
 *
 * Accepts:
 *   * ISO-8601 string (modern rows written by `case_law_admin.py`) —
 *     pass-through.
 *   * Numeric value (legacy epoch-seconds float) — convert via
 *     `new Date(value * 1000).toISOString()`.
 *   * String that parses cleanly as a finite number — treated as
 *     legacy float and converted (defensive: some DDB items
 *     deserialise numbers as strings depending on the writer).
 *   * Anything else — coerced to its string form so the wire shape
 *     remains a non-null string.
 */
function normaliseEncodedAt(value: unknown): string {
  if (typeof value === 'number' && Number.isFinite(value)) {
    return new Date(value * 1000).toISOString();
  }
  if (typeof value === 'string' && value.length > 0) {
    // Defensive: a writer may have stored the legacy float as a string.
    // ISO strings start with a digit too (year), so disambiguate by
    // checking parseFloat of the entire string and the absence of a
    // calendar separator. ISO 8601 always contains '-' (date separator)
    // or 'T'; bare numeric strings do not.
    const looksLikeIso = value.includes('-') || value.includes('T');
    if (!looksLikeIso) {
      const asNum = Number(value);
      if (Number.isFinite(asNum)) {
        return new Date(asNum * 1000).toISOString();
      }
    }
    return value;
  }
  if (value === null || value === undefined) return '';
  return String(value);
}

function projectCaseLawEntry(row: DdbRow): CaseLawEntryProjected | null {
  const caseId =
    typeof row.entryId === 'string' && row.entryId.length > 0
      ? row.entryId
      : '';
  if (caseId.length === 0) {
    console.warn(
      'projectCaseLawEntry: skipping malformed row',
      JSON.stringify({ keys: Object.keys(row) }),
    );
    return null;
  }

  // Allowlist guard on resolution. Unknown values coerce to 'unknown'
  // with a warning so operators can spot writer drift in CloudWatch.
  const rawResolution =
    typeof row.resolution === 'string' ? row.resolution : '';
  let resolution: string;
  if (VALID_CASE_LAW_RESOLUTIONS.has(rawResolution)) {
    resolution = rawResolution;
  } else {
    console.warn(
      `projectCaseLawEntry: unknown resolution ${JSON.stringify(rawResolution)} ` +
        `on case ${caseId}; coercing to 'unknown'.`,
    );
    resolution = 'unknown';
  }

  // pattern + scopeOfApplicability — parse on the row, then
  // JSON.stringify back to normalise the shape for transport.
  const patternObj = maybeJson<Record<string, unknown>>(row.pattern, {});
  const scopeObj = maybeJson<Record<string, unknown>>(
    row.scopeOfApplicability,
    {},
  );
  const pattern = JSON.stringify(patternObj ?? {});
  const scopeOfApplicability = JSON.stringify(scopeObj ?? {});

  const encodedAt = normaliseEncodedAt(row.createdAt);
  const encodedByRaw = row.createdBy;
  const encodedBy =
    typeof encodedByRaw === 'string' && encodedByRaw.length > 0
      ? encodedByRaw
      : 'unknown';

  // precedence: coerce via Number() per spec; default 0 on missing /
  // non-finite. Using Number() rather than parseInt preserves the
  // numeric DDB shape directly.
  const precRaw = row.precedence;
  let precedence = 0;
  if (precRaw !== undefined && precRaw !== null) {
    const n = Number(precRaw);
    precedence = Number.isFinite(n) ? Math.trunc(n) : 0;
  }

  const revoked = row.revoked === true;

  return {
    caseId,
    pattern,
    resolution,
    encodedAt,
    encodedBy,
    scopeOfApplicability,
    precedence,
    revoked,
  };
}

async function listCaseLaw(
  event: AppSyncResolverEvent<ListCaseLawArgs>,
): Promise<CaseLawEntryProjected[]> {
  if (!isAdminFromEvent(event)) {
    throw new Error('Forbidden: admin required');
  }

  const tableName = process.env.CASE_LAW_TABLE;
  if (!tableName) {
    throw new Error('CASE_LAW_TABLE env var is not set');
  }

  const args = (event.arguments ?? {}) as ListCaseLawArgs;
  const includeRevoked = args.includeRevoked === true;
  const cacheKey = includeRevoked ? 'with' : 'without';
  const cached = caseLawCache.get(cacheKey);
  if (cached && Date.now() < cached.expiresAt) {
    return cached.entries;
  }

  const items: DdbRow[] = [];
  let lastEvaluatedKey: Record<string, unknown> | undefined;
  let truncated = false;

  do {
    const cmd = new ScanCommand({
      TableName: tableName,
      ...(lastEvaluatedKey ? { ExclusiveStartKey: lastEvaluatedKey } : {}),
    });
    const result = await dynamodb.send(cmd);
    const page = (result.Items ?? []) as DdbRow[];
    for (const row of page) {
      if (items.length >= WAVE4D_CASE_LAW_SCAN_CAP) {
        truncated = true;
        break;
      }
      items.push(row);
    }
    if (truncated) break;
    lastEvaluatedKey = result.LastEvaluatedKey as
      | Record<string, unknown>
      | undefined;
  } while (lastEvaluatedKey);

  if (truncated) {
    console.warn(
      `listCaseLaw: truncated at ${WAVE4D_CASE_LAW_SCAN_CAP} rows. ` +
        'Tighten filters or extend the scan cap.',
    );
  }

  const projected: CaseLawEntryProjected[] = [];
  for (const row of items) {
    const entry = projectCaseLawEntry(row);
    if (entry !== null) projected.push(entry);
  }

  // Filter revoked rows when not opted in.
  const filtered = includeRevoked
    ? projected
    : projected.filter((e) => !e.revoked);

  // Sort: precedence DESC, then encodedAt DESC as tie-breaker. The
  // tie-breaker keeps the most-recently-encoded entry on top within a
  // precedence band so operators see new adjudications first.
  filtered.sort((a, b) => {
    if (a.precedence !== b.precedence) return b.precedence - a.precedence;
    if (a.encodedAt === b.encodedAt) return 0;
    return a.encodedAt < b.encodedAt ? 1 : -1;
  });

  caseLawCache.set(cacheKey, {
    entries: filtered,
    expiresAt: Date.now() + WAVE4D_CASE_LAW_CACHE_TTL_MS,
  });
  return filtered;
}

// ---------------------------------------------------------------------------
// Wave 4.C.2 — constitutional rule editor mutations
// ---------------------------------------------------------------------------
//
// PRODUCTION-AFFECTING. Each mutation re-writes the `rules` JSON list on a
// single layer row in the constitutional layers DDB table. The new shape
// is read by the engine at step 8 (see
// arbiter/governance/engine.py:_constitutional_review) on the next refresh
// of the in-process layers cache.
//
// Validation order is fixed: admin → acknowledgement → operator allowlist →
// per-operator value rule → field length → DDB GetItem (layer must exist) →
// rules array bounds (update/delete) → DDB PutItem → audit event.
//
// Audit event emission is best-effort: a failure leaves the rule write in
// place and surfaces null `emittedEventDetailType` to the caller so the
// page-level toast can still report success without re-rolling.
//
// TODO: Wave 4.C.2 has no optimistic concurrency control. Two admins
// editing the same layer concurrently can race — the second writer's
// PutItem overwrites the first writer's rules list with the version that
// the second editor read before the first writer's commit. For high-
// frequency edit scenarios, switch to a conditional UpdateItem keyed on
// a `version` attribute incremented per write.

export const CONSTITUTIONAL_RULE_ACKNOWLEDGEMENT_TEXT =
  'I understand this changes the constitutional layer used at engine step 8';

const CONSTITUTIONAL_OPERATOR_ALLOWLIST: ReadonlySet<string> = new Set([
  'eq',
  'neq',
  'exists',
  'not_exists',
  'gt',
  'lt',
]);

const CONSTITUTIONAL_FIELD_MAX_LENGTH = 256;

interface ConstitutionalRuleInputShape {
  field: string;
  operator: string;
  value: string | null;
}

interface AddConstitutionalRuleInput {
  layerId: string;
  rule: ConstitutionalRuleInputShape;
  acknowledgement: string;
}

interface UpdateConstitutionalRuleInput {
  layerId: string;
  ruleIndex: number;
  newRule: ConstitutionalRuleInputShape;
  acknowledgement: string;
}

interface DeleteConstitutionalRuleInput {
  layerId: string;
  ruleIndex: number;
  acknowledgement: string;
}

interface ConstitutionalRuleMutationResult {
  ok: boolean;
  layerId: string;
  action: 'add' | 'update' | 'delete';
  layer: ConstitutionalLayerProjected;
  emittedEventDetailType: string | null;
}

// Stored rule shape (post-decode from DDB JSON list). Rules are
// stored with the engine's native field names and a JSON-decoded `value`
// so the engine can compare it to the request context without a second
// JSON.parse. Editing surfaces JSON-encoded values for transport (which
// the resolver re-parses here) so the wire format matches the read path.
interface StoredConstitutionalRule {
  field: string;
  operator: string;
  value?: unknown;
}

/**
 * Validate a ConstitutionalRuleInput from a mutation argument and convert
 * the JSON-encoded `value` string back to a typed value the engine can
 * compare. The engine's `_constitutional_review` operates on parsed
 * Python primitives — JSON.parse here makes the wire format symmetric
 * with the read path's `JSON.stringify(rule.value)` projection.
 *
 * Throws on the first validation failure with a precise message so the
 * dialog can surface the cause inline.
 */
function validateAndDecodeRule(
  rule: ConstitutionalRuleInputShape | null | undefined,
): StoredConstitutionalRule {
  if (!rule || typeof rule !== 'object') {
    throw new Error('Rule input is required');
  }
  const field = typeof rule.field === 'string' ? rule.field : '';
  if (field.length === 0) {
    throw new Error('Rule field must be non-empty');
  }
  if (field.length > CONSTITUTIONAL_FIELD_MAX_LENGTH) {
    throw new Error(
      `Rule field exceeds ${CONSTITUTIONAL_FIELD_MAX_LENGTH} characters`,
    );
  }
  const operator = typeof rule.operator === 'string' ? rule.operator : '';
  if (!CONSTITUTIONAL_OPERATOR_ALLOWLIST.has(operator)) {
    throw new Error(
      `Invalid operator: ${operator}. Allowed: eq, neq, exists, not_exists, gt, lt`,
    );
  }
  const valueIsExistsOp = operator === 'exists' || operator === 'not_exists';
  const rawValue = rule.value;
  if (valueIsExistsOp) {
    if (rawValue !== null && rawValue !== undefined) {
      throw new Error(
        `Operator ${operator} must have null value (received non-null)`,
      );
    }
    return { field, operator };
  }
  if (rawValue === null || rawValue === undefined) {
    throw new Error(`Operator ${operator} requires a non-null value`);
  }
  if (typeof rawValue !== 'string') {
    throw new Error(`Operator ${operator} requires a JSON-encoded string value`);
  }
  let parsed: unknown;
  try {
    parsed = JSON.parse(rawValue);
  } catch {
    throw new Error(
      `Operator ${operator} value is not parseable JSON: ${rawValue}`,
    );
  }
  return { field, operator, value: parsed };
}

function assertAcknowledgement(value: unknown): void {
  if (value !== CONSTITUTIONAL_RULE_ACKNOWLEDGEMENT_TEXT) {
    throw new Error('Acknowledgement string mismatch');
  }
}

function assertAdmin(event: AppSyncResolverEvent<unknown>): void {
  if (!isAdminFromEvent(event)) {
    throw new Error('Forbidden: admin required');
  }
}

async function getConstitutionalLayerRow(
  tableName: string,
  layerId: string,
): Promise<DdbRow> {
  const resp = await dynamodb.send(
    new GetCommand({ TableName: tableName, Key: { layerId } }),
  );
  const item = resp.Item as DdbRow | undefined;
  if (!item) {
    throw new Error(`Layer not found: ${layerId}`);
  }
  return item;
}

function parseStoredRules(row: DdbRow): StoredConstitutionalRule[] {
  const raw = maybeJson<unknown[]>(row.rules, []);
  if (!Array.isArray(raw)) return [];
  const out: StoredConstitutionalRule[] = [];
  for (const r of raw) {
    if (r === null || typeof r !== 'object' || Array.isArray(r)) continue;
    const item = r as Record<string, unknown>;
    const field = typeof item.field === 'string' ? item.field : '';
    const operator = typeof item.operator === 'string' ? item.operator : '';
    if (!field || !operator) continue;
    const stored: StoredConstitutionalRule = { field, operator };
    if (
      operator !== 'exists' &&
      operator !== 'not_exists' &&
      item.value !== undefined
    ) {
      stored.value = item.value;
    }
    out.push(stored);
  }
  return out;
}

/**
 * Stored rule → API projection (engine's native value → JSON string).
 * Mirrors `projectRule` for the read path — when the operator is exists
 * or not_exists, the value is null; otherwise it is `JSON.stringify` of
 * the engine-side parsed primitive.
 */
function projectStoredRule(
  rule: StoredConstitutionalRule,
): ConstitutionalRuleProjected {
  if (rule.operator === 'exists' || rule.operator === 'not_exists') {
    return { field: rule.field, operator: rule.operator, value: null };
  }
  let valueStr: string | null;
  try {
    valueStr =
      rule.value === undefined ? null : JSON.stringify(rule.value);
    if (valueStr === undefined) valueStr = null;
  } catch {
    valueStr = null;
  }
  return { field: rule.field, operator: rule.operator, value: valueStr };
}

async function writeLayerRules(
  tableName: string,
  row: DdbRow,
  rules: StoredConstitutionalRule[],
): Promise<DdbRow> {
  // Preserve every existing attribute on the row and only swap the
  // `rules` JSON encoding. PutItem on the full row keeps schema
  // forward-compatibility (any new attribute introduced by the engine
  // survives a Wave 4.C.2 edit).
  const updated: DdbRow = { ...row, rules: JSON.stringify(rules) };
  await dynamodb.send(
    new PutCommand({ TableName: tableName, Item: updated }),
  );
  return updated;
}

function buildLayerProjection(
  row: DdbRow,
  rules: StoredConstitutionalRule[],
): ConstitutionalLayerProjected {
  const layerId = typeof row.layerId === 'string' ? row.layerId : '';
  const layerType =
    typeof row.layerType === 'string' && row.layerType.length > 0
      ? row.layerType
      : 'global';
  const appliesTo = projectAppliesTo(row.appliesTo);
  return {
    layerId,
    layerType,
    appliesTo,
    rules: rules.map(projectStoredRule),
    parentLayerId:
      typeof row.parentLayerId === 'string' ? row.parentLayerId : null,
  };
}

async function emitConstitutionalRuleAuditEvent(
  layerId: string,
  action: 'add' | 'update' | 'delete',
  ruleIndex: number,
  oldRule: StoredConstitutionalRule | null,
  newRule: StoredConstitutionalRule | null,
  event: AppSyncResolverEvent<unknown>,
): Promise<string | null> {
  try {
    const actorSub = readActorSub(event);
    await emitGovernanceEvent('governance.constitutional.rule.changed', {
      layerId,
      action,
      ruleIndex,
      oldRule: oldRule ? projectStoredRule(oldRule) : null,
      newRule: newRule ? projectStoredRule(newRule) : null,
      actorSub,
      timestamp: new Date().toISOString(),
    });
    return 'governance.constitutional.rule.changed';
  } catch (err) {
    console.error(
      'constitutionalRule mutation: audit event emit failed',
      err,
    );
    return null;
  }
}

async function addConstitutionalRule(
  event: AppSyncResolverEvent<{ input: AddConstitutionalRuleInput }>,
): Promise<ConstitutionalRuleMutationResult> {
  assertAdmin(event);
  const tableName = process.env.CONSTITUTIONAL_LAYERS_TABLE;
  if (!tableName) {
    throw new Error('CONSTITUTIONAL_LAYERS_TABLE env var is not set');
  }
  const input = (event.arguments?.input ?? {}) as AddConstitutionalRuleInput;
  assertAcknowledgement(input.acknowledgement);
  const layerId =
    typeof input.layerId === 'string' ? input.layerId : '';
  if (layerId.length === 0) {
    throw new Error('layerId must be non-empty');
  }
  const newRule = validateAndDecodeRule(input.rule);

  const row = await getConstitutionalLayerRow(tableName, layerId);
  const rules = parseStoredRules(row);
  const insertIndex = rules.length;
  const updatedRules = [...rules, newRule];
  const updatedRow = await writeLayerRules(tableName, row, updatedRules);
  // Invalidate the read-path cache so the next listConstitutionalLayers
  // call observes the freshly-written rule immediately.
  constitutionalLayersCache = null;

  const emittedEventDetailType = await emitConstitutionalRuleAuditEvent(
    layerId,
    'add',
    insertIndex,
    null,
    newRule,
    event,
  );

  return {
    ok: true,
    layerId,
    action: 'add',
    layer: buildLayerProjection(updatedRow, updatedRules),
    emittedEventDetailType,
  };
}

async function updateConstitutionalRule(
  event: AppSyncResolverEvent<{ input: UpdateConstitutionalRuleInput }>,
): Promise<ConstitutionalRuleMutationResult> {
  assertAdmin(event);
  const tableName = process.env.CONSTITUTIONAL_LAYERS_TABLE;
  if (!tableName) {
    throw new Error('CONSTITUTIONAL_LAYERS_TABLE env var is not set');
  }
  const input = (event.arguments?.input ?? {}) as UpdateConstitutionalRuleInput;
  assertAcknowledgement(input.acknowledgement);
  const layerId =
    typeof input.layerId === 'string' ? input.layerId : '';
  if (layerId.length === 0) {
    throw new Error('layerId must be non-empty');
  }
  const ruleIndex = input.ruleIndex;
  if (typeof ruleIndex !== 'number' || !Number.isInteger(ruleIndex)) {
    throw new Error('ruleIndex must be an integer');
  }
  const newRule = validateAndDecodeRule(input.newRule);

  const row = await getConstitutionalLayerRow(tableName, layerId);
  const rules = parseStoredRules(row);
  if (ruleIndex < 0 || ruleIndex >= rules.length) {
    throw new Error(
      `Rule index out of range: ${ruleIndex} (layer has ${rules.length} rules)`,
    );
  }
  const oldRule = rules[ruleIndex];
  const updatedRules = rules.slice();
  updatedRules[ruleIndex] = newRule;
  const updatedRow = await writeLayerRules(tableName, row, updatedRules);
  constitutionalLayersCache = null;

  const emittedEventDetailType = await emitConstitutionalRuleAuditEvent(
    layerId,
    'update',
    ruleIndex,
    oldRule,
    newRule,
    event,
  );

  return {
    ok: true,
    layerId,
    action: 'update',
    layer: buildLayerProjection(updatedRow, updatedRules),
    emittedEventDetailType,
  };
}

async function deleteConstitutionalRule(
  event: AppSyncResolverEvent<{ input: DeleteConstitutionalRuleInput }>,
): Promise<ConstitutionalRuleMutationResult> {
  assertAdmin(event);
  const tableName = process.env.CONSTITUTIONAL_LAYERS_TABLE;
  if (!tableName) {
    throw new Error('CONSTITUTIONAL_LAYERS_TABLE env var is not set');
  }
  const input = (event.arguments?.input ?? {}) as DeleteConstitutionalRuleInput;
  assertAcknowledgement(input.acknowledgement);
  const layerId =
    typeof input.layerId === 'string' ? input.layerId : '';
  if (layerId.length === 0) {
    throw new Error('layerId must be non-empty');
  }
  const ruleIndex = input.ruleIndex;
  if (typeof ruleIndex !== 'number' || !Number.isInteger(ruleIndex)) {
    throw new Error('ruleIndex must be an integer');
  }

  const row = await getConstitutionalLayerRow(tableName, layerId);
  const rules = parseStoredRules(row);
  if (ruleIndex < 0 || ruleIndex >= rules.length) {
    throw new Error(
      `Rule index out of range: ${ruleIndex} (layer has ${rules.length} rules)`,
    );
  }
  const oldRule = rules[ruleIndex];
  const updatedRules = rules.slice();
  updatedRules.splice(ruleIndex, 1);
  const updatedRow = await writeLayerRules(tableName, row, updatedRules);
  constitutionalLayersCache = null;

  const emittedEventDetailType = await emitConstitutionalRuleAuditEvent(
    layerId,
    'delete',
    ruleIndex,
    oldRule,
    null,
    event,
  );

  return {
    ok: true,
    layerId,
    action: 'delete',
    layer: buildLayerProjection(updatedRow, updatedRules),
    emittedEventDetailType,
  };
}

// ---------------------------------------------------------------------------
// Wave 4.D.2 — case-law admin actions (revoke / unrevoke / update-precedence)
// ---------------------------------------------------------------------------
//
// PRODUCTION-AFFECTING. Mutations on the `citadel-case-law-{env}` DDB table
// that the engine reads at step 1 (case-law lookup). Soft-delete via
// `revoked: true` mirrors `case_law_admin.py` semantics — the row stays
// behind for audit visibility; `arbiter/governance/hierarchy.py` filters
// revoked rows at engine load time so they never surface in evaluation.
//
// Validation order is fixed: admin → acknowledgement → caseId length →
// (for update-precedence) newPrecedence range → DDB GetItem (entry must
// exist) → idempotent no-op check → DDB UpdateItem → re-fetch → audit
// event.
//
// Audit event emission is best-effort: a failure leaves the primary
// write in place and surfaces null `emittedEventDetailType` to the
// caller so the page-level toast still reports success without a
// roll-back.
//
// Cache invalidation: the Wave 4.D listCaseLaw cache is cleared on
// every successful primary write so the next admin read observes the
// freshly-written row immediately.

export const CASELAW_ACKNOWLEDGEMENT_TEXT =
  'I understand this changes the case-law precedent used at engine step 1';

const CASELAW_CASE_ID_MAX_LENGTH = 256;
const CASELAW_PRECEDENCE_MIN = -1000;
const CASELAW_PRECEDENCE_MAX = 1000;
const CASELAW_REASON_MAX_LENGTH = 200;

interface RevokeCaseLawInput {
  caseId: string;
  acknowledgement: string;
  reason?: string | null;
}

interface UnrevokeCaseLawInput {
  caseId: string;
  acknowledgement: string;
  reason?: string | null;
}

interface UpdateCaseLawPrecedenceInput {
  caseId: string;
  newPrecedence: number;
  acknowledgement: string;
  reason?: string | null;
}

interface CaseLawMutationResult {
  ok: boolean;
  caseId: string;
  action: 'revoke' | 'unrevoke' | 'update-precedence';
  entry: CaseLawEntryProjected;
  emittedEventDetailType: string | null;
}

function assertCaselawAcknowledgement(value: unknown): void {
  if (value !== CASELAW_ACKNOWLEDGEMENT_TEXT) {
    throw new Error('Acknowledgement string mismatch');
  }
}

function assertCaseId(value: unknown): string {
  if (typeof value !== 'string' || value.length === 0) {
    throw new Error('caseId must be non-empty');
  }
  if (value.length > CASELAW_CASE_ID_MAX_LENGTH) {
    throw new Error(
      `caseId exceeds ${CASELAW_CASE_ID_MAX_LENGTH} characters`,
    );
  }
  return value;
}

function assertNewPrecedence(value: unknown): number {
  if (
    typeof value !== 'number' ||
    !Number.isFinite(value) ||
    !Number.isInteger(value)
  ) {
    throw new Error('newPrecedence must be a finite integer');
  }
  if (value < CASELAW_PRECEDENCE_MIN || value > CASELAW_PRECEDENCE_MAX) {
    throw new Error(
      `newPrecedence ${value} is out of range [${CASELAW_PRECEDENCE_MIN}, ${CASELAW_PRECEDENCE_MAX}]`,
    );
  }
  return value;
}

function normaliseReason(value: unknown): string | null {
  if (typeof value !== 'string' || value.length === 0) return null;
  // Defensive cap to keep audit payloads bounded; the dialog already
  // applies a 200-char ceiling but a server-side guard means a rogue
  // direct caller can't grow the audit event arbitrarily.
  if (value.length > CASELAW_REASON_MAX_LENGTH) {
    return value.slice(0, CASELAW_REASON_MAX_LENGTH);
  }
  return value;
}

async function getCaseLawRow(
  tableName: string,
  caseId: string,
): Promise<DdbRow> {
  const resp = await dynamodb.send(
    new GetCommand({ TableName: tableName, Key: { entryId: caseId } }),
  );
  const item = resp.Item as DdbRow | undefined;
  if (!item) {
    throw new Error(`Case-law entry not found: ${caseId}`);
  }
  return item;
}

async function emitCaseLawAuditEvent(
  caseId: string,
  action: 'revoke' | 'unrevoke' | 'update-precedence',
  previousValue: Record<string, unknown>,
  newValue: Record<string, unknown>,
  reason: string | null,
  event: AppSyncResolverEvent<unknown>,
): Promise<string | null> {
  try {
    const actorSub = readActorSub(event);
    await emitGovernanceEvent('governance.caselaw.changed', {
      caseId,
      action,
      previousValue,
      newValue,
      reason,
      actorSub,
      timestamp: new Date().toISOString(),
    });
    return 'governance.caselaw.changed';
  } catch (err) {
    console.error('caseLaw mutation: audit event emit failed', err);
    return null;
  }
}

/**
 * Re-project the case-law row after a mutation. Throws when the
 * post-write GetItem returns nothing (race against a concurrent
 * delete) or when the projection helper rejects the row as malformed
 * — both are exceptional enough to surface as errors rather than
 * silently degrade.
 */
async function reprojectCaseLawRow(
  tableName: string,
  caseId: string,
): Promise<CaseLawEntryProjected> {
  const row = await getCaseLawRow(tableName, caseId);
  const projected = projectCaseLawEntry(row);
  if (projected === null) {
    throw new Error(
      `Case-law entry malformed after write: ${caseId}`,
    );
  }
  return projected;
}

async function revokeCaseLaw(
  event: AppSyncResolverEvent<{ input: RevokeCaseLawInput }>,
): Promise<CaseLawMutationResult> {
  assertAdmin(event);
  const tableName = process.env.CASE_LAW_TABLE;
  if (!tableName) {
    throw new Error('CASE_LAW_TABLE env var is not set');
  }
  const input = (event.arguments?.input ?? {}) as RevokeCaseLawInput;
  assertCaselawAcknowledgement(input.acknowledgement);
  const caseId = assertCaseId(input.caseId);
  const reason = normaliseReason(input.reason);

  const row = await getCaseLawRow(tableName, caseId);
  const wasRevoked = row.revoked === true;

  if (wasRevoked) {
    // Idempotent no-op: skip the UpdateItem and audit event entirely.
    const projected = projectCaseLawEntry(row);
    if (projected === null) {
      throw new Error(`Case-law entry malformed: ${caseId}`);
    }
    return {
      ok: true,
      caseId,
      action: 'revoke',
      entry: projected,
      emittedEventDetailType: null,
    };
  }

  await dynamodb.send(
    new UpdateCommand({
      TableName: tableName,
      Key: { entryId: caseId },
      UpdateExpression: 'SET #revoked = :true',
      ExpressionAttributeNames: { '#revoked': 'revoked' },
      ExpressionAttributeValues: { ':true': true },
    }),
  );
  caseLawCache.clear();

  const entry = await reprojectCaseLawRow(tableName, caseId);
  const emittedEventDetailType = await emitCaseLawAuditEvent(
    caseId,
    'revoke',
    { revoked: false },
    { revoked: true },
    reason,
    event,
  );

  return {
    ok: true,
    caseId,
    action: 'revoke',
    entry,
    emittedEventDetailType,
  };
}

async function unrevokeCaseLaw(
  event: AppSyncResolverEvent<{ input: UnrevokeCaseLawInput }>,
): Promise<CaseLawMutationResult> {
  assertAdmin(event);
  const tableName = process.env.CASE_LAW_TABLE;
  if (!tableName) {
    throw new Error('CASE_LAW_TABLE env var is not set');
  }
  const input = (event.arguments?.input ?? {}) as UnrevokeCaseLawInput;
  assertCaselawAcknowledgement(input.acknowledgement);
  const caseId = assertCaseId(input.caseId);
  const reason = normaliseReason(input.reason);

  const row = await getCaseLawRow(tableName, caseId);
  const wasRevoked = row.revoked === true;

  if (!wasRevoked) {
    // Idempotent no-op: skip the UpdateItem and audit event entirely.
    const projected = projectCaseLawEntry(row);
    if (projected === null) {
      throw new Error(`Case-law entry malformed: ${caseId}`);
    }
    return {
      ok: true,
      caseId,
      action: 'unrevoke',
      entry: projected,
      emittedEventDetailType: null,
    };
  }

  await dynamodb.send(
    new UpdateCommand({
      TableName: tableName,
      Key: { entryId: caseId },
      UpdateExpression: 'SET #revoked = :false',
      ExpressionAttributeNames: { '#revoked': 'revoked' },
      ExpressionAttributeValues: { ':false': false },
    }),
  );
  caseLawCache.clear();

  const entry = await reprojectCaseLawRow(tableName, caseId);
  const emittedEventDetailType = await emitCaseLawAuditEvent(
    caseId,
    'unrevoke',
    { revoked: true },
    { revoked: false },
    reason,
    event,
  );

  return {
    ok: true,
    caseId,
    action: 'unrevoke',
    entry,
    emittedEventDetailType,
  };
}

async function updateCaseLawPrecedence(
  event: AppSyncResolverEvent<{ input: UpdateCaseLawPrecedenceInput }>,
): Promise<CaseLawMutationResult> {
  assertAdmin(event);
  const tableName = process.env.CASE_LAW_TABLE;
  if (!tableName) {
    throw new Error('CASE_LAW_TABLE env var is not set');
  }
  const input = (event.arguments?.input ?? {}) as UpdateCaseLawPrecedenceInput;
  assertCaselawAcknowledgement(input.acknowledgement);
  const caseId = assertCaseId(input.caseId);
  const newPrecedence = assertNewPrecedence(input.newPrecedence);
  const reason = normaliseReason(input.reason);

  const row = await getCaseLawRow(tableName, caseId);
  const existingPrecedence = (() => {
    const raw = row.precedence;
    if (raw === undefined || raw === null) return 0;
    const n = Number(raw);
    return Number.isFinite(n) ? Math.trunc(n) : 0;
  })();

  if (existingPrecedence === newPrecedence) {
    // Idempotent no-op when the value is unchanged.
    const projected = projectCaseLawEntry(row);
    if (projected === null) {
      throw new Error(`Case-law entry malformed: ${caseId}`);
    }
    return {
      ok: true,
      caseId,
      action: 'update-precedence',
      entry: projected,
      emittedEventDetailType: null,
    };
  }

  await dynamodb.send(
    new UpdateCommand({
      TableName: tableName,
      Key: { entryId: caseId },
      UpdateExpression: 'SET #precedence = :p',
      ExpressionAttributeNames: { '#precedence': 'precedence' },
      ExpressionAttributeValues: { ':p': newPrecedence },
    }),
  );
  caseLawCache.clear();

  const entry = await reprojectCaseLawRow(tableName, caseId);
  const emittedEventDetailType = await emitCaseLawAuditEvent(
    caseId,
    'update-precedence',
    { precedence: existingPrecedence },
    { precedence: newPrecedence },
    reason,
    event,
  );

  return {
    ok: true,
    caseId,
    action: 'update-precedence',
    entry,
    emittedEventDetailType,
  };
}

// ---------------------------------------------------------------------------
// Wave 4.E.A — authority graph history settings (configurable, default OFF)
// ---------------------------------------------------------------------------
//
// Operators opt in to enable daily snapshots of the four authority
// graph source tables; the settings JSON lives at the SSM parameter
// `/citadel/governance/authority-graph-history/{env}` and is read by
// both this resolver (read + mutate) and the scheduled
// `governance-graph-snapshot` Lambda (read-only at 03:00 UTC).
//
// Validation order for the mutation is fixed: admin → acknowledgement
// → captureMode allowlist (daily, on-change, both) →
// retentionDays allowlist (7 / 30 / 90 / 365) → enabled boolean type
// check → read-current-from-SSM → same-config no-op → SSM write →
// audit event (best-effort).
//
// Snapshot counting reads the new `governanceGraphSnapshotsTable`
// (created in arbiter-stack.ts) with a Scan filtered to the retention
// window. The 5000-item cap mirrors the scheduled Lambda's per-table
// cap so the resolver stays bounded even if a future operator pushes
// retention to 365 days.
//
// 30s in-process cache for the read path mirrors the rollout-readiness
// cache strategy: short enough that the operator-facing settings card
// reflects fresh writes within seconds without hammering SSM + DDB on
// each page render.

interface AuthorityGraphHistorySettingsRaw {
  enabled: boolean;
  retentionDays: number;
  captureMode: string;
}

interface AuthorityGraphHistorySettingsProjected
  extends AuthorityGraphHistorySettingsRaw {
  lastSnapshotAt: string | null;
  snapshotCountInWindow: number;
  storageEstimate: string;
}

interface UpdateAuthorityGraphHistorySettingsInput {
  enabled: boolean;
  retentionDays: number;
  captureMode: string;
  acknowledgement: string;
  reason?: string | null;
}

interface UpdateAuthorityGraphHistorySettingsResult {
  ok: boolean;
  settings: AuthorityGraphHistorySettingsProjected;
  emittedEventDetailType: string | null;
}

// MUST match the frontend constant in governanceService.ts. The contract
// drift test (`backend/test/contract-graph-history-ack-text.test.ts`)
// enforces verbatim equality on every CI run.
export const AUTHORITY_GRAPH_HISTORY_ACKNOWLEDGEMENT_TEXT =
  'I understand this changes governance history retention and storage costs';

const AUTHORITY_GRAPH_HISTORY_DEFAULTS: AuthorityGraphHistorySettingsRaw = {
  enabled: false,
  retentionDays: 30,
  captureMode: 'daily',
};

const AUTHORITY_GRAPH_HISTORY_RETENTION_ALLOWLIST: ReadonlySet<number> =
  new Set([7, 30, 90, 365]);

// Capture mode allowlist — Wave 4.E.A.2 enables 'on-change' and 'both'
// alongside the original 'daily'. The two snapshot handlers gate
// themselves on the value: scheduled runs on {daily, both}, stream-
// driven runs on {on-change, both}.
const AUTHORITY_GRAPH_HISTORY_CAPTURE_MODE_ALLOWLIST: ReadonlySet<string> =
  new Set(['daily', 'on-change', 'both']);

// Soft cap on the snapshot count scan — matches the scheduled Lambda's
// per-table cap. Beyond 5000 snapshots in the retention window the
// estimate switches to a "5000+" sentinel rather than scanning forever.
const AUTHORITY_GRAPH_HISTORY_SCAN_CAP = 5000;

// Average snapshot size in KB — placeholder until empirical data lands.
const AUTHORITY_GRAPH_HISTORY_AVG_KB = 8;

const AUTHORITY_GRAPH_HISTORY_CACHE_TTL_MS = 30 * 1000;

interface AuthorityGraphHistoryCacheEntry {
  loadedAt: number;
  projected: AuthorityGraphHistorySettingsProjected;
}

let authorityGraphHistoryCache: AuthorityGraphHistoryCacheEntry | null = null;

/** Test-only: reset the in-process cache. Do not call from production code. */
export function __resetAuthorityGraphHistoryCacheForTest(): void {
  authorityGraphHistoryCache = null;
}

function authorityGraphHistoryParameterName(env: string): string {
  return `/citadel/governance/authority-graph-history/${env}`;
}

function isValidRawShape(
  candidate: unknown,
): candidate is AuthorityGraphHistorySettingsRaw {
  if (!candidate || typeof candidate !== 'object' || Array.isArray(candidate)) {
    return false;
  }
  const c = candidate as Record<string, unknown>;
  if (typeof c.enabled !== 'boolean') return false;
  if (typeof c.retentionDays !== 'number' || !Number.isFinite(c.retentionDays)) {
    return false;
  }
  if (typeof c.captureMode !== 'string' || c.captureMode.length === 0) {
    return false;
  }
  return true;
}

async function readAuthorityGraphHistorySettingsRaw(
  env: string,
): Promise<AuthorityGraphHistorySettingsRaw> {
  const parameterName = authorityGraphHistoryParameterName(env);
  try {
    const resp = await ssm.send(
      new GetParameterCommand({ Name: parameterName }),
    );
    const value = resp.Parameter?.Value ?? '';
    if (value.length === 0) {
      return { ...AUTHORITY_GRAPH_HISTORY_DEFAULTS };
    }
    let parsed: unknown;
    try {
      parsed = JSON.parse(value);
    } catch {
      return { ...AUTHORITY_GRAPH_HISTORY_DEFAULTS };
    }
    if (!isValidRawShape(parsed)) {
      return { ...AUTHORITY_GRAPH_HISTORY_DEFAULTS };
    }
    return {
      enabled: parsed.enabled,
      retentionDays: parsed.retentionDays,
      captureMode: parsed.captureMode,
    };
  } catch {
    return { ...AUTHORITY_GRAPH_HISTORY_DEFAULTS };
  }
}

async function countSnapshotsInWindow(
  retentionDays: number,
): Promise<{ count: number; lastSnapshotAt: string | null }> {
  const tableName = process.env.GRAPH_SNAPSHOTS_TABLE;
  if (!tableName) {
    return { count: 0, lastSnapshotAt: null };
  }
  // Bound retention to a non-negative integer — even though the
  // allowlist already restricts callers, this read path is also used
  // when the SSM blob has been hand-edited to a non-allowlist value;
  // returning the safe default JSON shape keeps the read tolerant.
  const sinceSec =
    Math.floor(Date.now() / 1000) -
    Math.max(0, Math.trunc(retentionDays)) * 86400;
  try {
    const resp = await dynamodb.send(
      new ScanCommand({
        TableName: tableName,
        FilterExpression: '#ts >= :since',
        ExpressionAttributeNames: { '#ts': 'timestamp' },
        ExpressionAttributeValues: { ':since': sinceSec },
        Limit: AUTHORITY_GRAPH_HISTORY_SCAN_CAP,
      }),
    );
    const items = (resp.Items as Array<Record<string, unknown>> | undefined) ?? [];
    let maxTs = -Infinity;
    for (const item of items) {
      const raw = item.timestamp;
      const n = typeof raw === 'number' ? raw : Number(raw);
      if (Number.isFinite(n) && n > maxTs) {
        maxTs = n;
      }
    }
    const lastSnapshotAt =
      maxTs === -Infinity ? null : new Date(maxTs * 1000).toISOString();
    return { count: items.length, lastSnapshotAt };
  } catch (err) {
    console.error('countSnapshotsInWindow: scan failed', err);
    return { count: 0, lastSnapshotAt: null };
  }
}

function formatStorageEstimate(count: number): string {
  if (count <= 0) return '—';
  return `~${count * AUTHORITY_GRAPH_HISTORY_AVG_KB}KB`;
}

async function projectAuthorityGraphHistorySettings(
  env: string,
): Promise<AuthorityGraphHistorySettingsProjected> {
  const raw = await readAuthorityGraphHistorySettingsRaw(env);
  const { count, lastSnapshotAt } = await countSnapshotsInWindow(
    raw.retentionDays,
  );
  return {
    enabled: raw.enabled,
    retentionDays: raw.retentionDays,
    captureMode: raw.captureMode,
    lastSnapshotAt,
    snapshotCountInWindow: count,
    storageEstimate: formatStorageEstimate(count),
  };
}

async function getAuthorityGraphHistorySettings(
  event: AppSyncResolverEvent<unknown>,
): Promise<AuthorityGraphHistorySettingsProjected> {
  assertAdmin(event);
  const cached = authorityGraphHistoryCache;
  if (
    cached &&
    Date.now() - cached.loadedAt < AUTHORITY_GRAPH_HISTORY_CACHE_TTL_MS
  ) {
    return cached.projected;
  }
  const env = process.env.ENVIRONMENT || 'unknown';
  const projected = await projectAuthorityGraphHistorySettings(env);
  authorityGraphHistoryCache = { loadedAt: Date.now(), projected };
  return projected;
}

function assertAuthorityGraphHistoryAcknowledgement(value: unknown): void {
  if (value !== AUTHORITY_GRAPH_HISTORY_ACKNOWLEDGEMENT_TEXT) {
    throw new Error('Acknowledgement string mismatch');
  }
}

function assertAuthorityGraphHistoryRetention(value: unknown): number {
  if (typeof value !== 'number' || !Number.isFinite(value)) {
    throw new Error('retentionDays must be a finite number');
  }
  if (!AUTHORITY_GRAPH_HISTORY_RETENTION_ALLOWLIST.has(value)) {
    throw new Error(
      `retentionDays ${value} not in allowlist [7, 30, 90, 365]`,
    );
  }
  return value;
}

function assertAuthorityGraphHistoryCaptureMode(value: unknown): string {
  if (typeof value !== 'string' || value.length === 0) {
    throw new Error('captureMode must be a non-empty string');
  }
  if (!AUTHORITY_GRAPH_HISTORY_CAPTURE_MODE_ALLOWLIST.has(value)) {
    throw new Error(
      `captureMode ${value} not in allowlist [daily, on-change, both]`,
    );
  }
  return value;
}

function assertAuthorityGraphHistoryEnabled(value: unknown): boolean {
  if (typeof value !== 'boolean') {
    throw new Error('enabled must be a boolean');
  }
  return value;
}

function normaliseAuthorityGraphHistoryReason(value: unknown): string | null {
  if (typeof value !== 'string' || value.length === 0) return null;
  // Defensive cap to bound audit payload size.
  if (value.length > 500) return value.slice(0, 500);
  return value;
}

async function emitAuthorityGraphHistoryAuditEvent(
  previousValue: AuthorityGraphHistorySettingsRaw,
  newValue: AuthorityGraphHistorySettingsRaw,
  reason: string | null,
  event: AppSyncResolverEvent<unknown>,
): Promise<string | null> {
  try {
    const actorSub = readActorSub(event);
    // Cast through `unknown` because GovernancePayloadMap does not yet
    // include this detail-type at compile time. The contract for the
    // payload is documented above; the bus still accepts the shape.
    await emitGovernanceEvent(
      'governance.authority-graph-history.config.changed' as never,
      {
        previousValue,
        newValue,
        reason,
        actorSub,
        timestamp: new Date().toISOString(),
      } as never,
    );
    return 'governance.authority-graph-history.config.changed';
  } catch (err) {
    console.error(
      'updateAuthorityGraphHistorySettings: audit event emit failed',
      err,
    );
    return null;
  }
}

async function updateAuthorityGraphHistorySettings(
  event: AppSyncResolverEvent<{
    input: UpdateAuthorityGraphHistorySettingsInput;
  }>,
): Promise<UpdateAuthorityGraphHistorySettingsResult> {
  assertAdmin(event);

  const input = (event.arguments?.input ??
    ({} as UpdateAuthorityGraphHistorySettingsInput)) as UpdateAuthorityGraphHistorySettingsInput;

  // Validation order: ack → captureMode → retentionDays → enabled.
  // captureMode goes BEFORE retentionDays so allowlist-failure messages
  // surface clearly even when retention is also out of allowlist.
  assertAuthorityGraphHistoryAcknowledgement(input.acknowledgement);
  const captureMode = assertAuthorityGraphHistoryCaptureMode(input.captureMode);
  const retentionDays = assertAuthorityGraphHistoryRetention(input.retentionDays);
  const enabled = assertAuthorityGraphHistoryEnabled(input.enabled);
  const reason = normaliseAuthorityGraphHistoryReason(input.reason);

  const env = process.env.ENVIRONMENT || 'unknown';
  const previousValue = await readAuthorityGraphHistorySettingsRaw(env);
  const newValue: AuthorityGraphHistorySettingsRaw = {
    enabled,
    retentionDays,
    captureMode,
  };

  // Same-config no-op: skip writes + audit event entirely.
  if (
    previousValue.enabled === newValue.enabled &&
    previousValue.retentionDays === newValue.retentionDays &&
    previousValue.captureMode === newValue.captureMode
  ) {
    // Re-project (bypass cache) so the response reflects the current
    // snapshot count even when the config did not change.
    authorityGraphHistoryCache = null;
    const projected = await projectAuthorityGraphHistorySettings(env);
    authorityGraphHistoryCache = { loadedAt: Date.now(), projected };
    return {
      ok: true,
      settings: projected,
      emittedEventDetailType: null,
    };
  }

  // SSM write — primary goal. Failure propagates so the operator sees an
  // error toast and the settings card stays on the previous values.
  const parameterName = authorityGraphHistoryParameterName(env);
  await ssm.send(
    new PutParameterCommand({
      Name: parameterName,
      Value: JSON.stringify(newValue),
      Type: 'String',
      Overwrite: true,
    }),
  );

  // Audit event — best-effort (NON-blocking on the SSM write).
  const emittedEventDetailType = await emitAuthorityGraphHistoryAuditEvent(
    previousValue,
    newValue,
    reason,
    event,
  );

  // Re-fetch (bypass cache) so the response reflects the freshly
  // written value AND the up-to-date snapshot count.
  authorityGraphHistoryCache = null;
  const projected = await projectAuthorityGraphHistorySettings(env);
  authorityGraphHistoryCache = { loadedAt: Date.now(), projected };

  return {
    ok: true,
    settings: projected,
    emittedEventDetailType,
  };
}

// ---------------------------------------------------------------------------
// Wave 4.E.B — authority graph history scrubber (replay)
// ---------------------------------------------------------------------------
//
// Read-only projections that back the time scrubber on the governance
// Graph page. Two queries:
//
//   * `listAuthorityGraphSnapshots` — index of summaries (counts only,
//     no embedded arrays) so the scrubber can render the snapshot
//     timeline without loading the heavy per-snapshot payload.
//   * `getAuthorityGraphSnapshot` — full per-snapshot projection of
//     authorityUnits + compositionContracts (constitutional layers and
//     case law are intentionally omitted; the graph page does not
//     render them).
//
// Both are admin-only via the resolver dispatch. Caches are
// short-lived (60s for the index, 30s per snapshot) because the
// underlying snapshot rows are immutable post-write and admins
// frequently scrub back and forth across the same window.
//
// IMPORTANT: when computing `isValid` on a historical snapshot, use the
// SNAPSHOT's `timestamp` as the reference, NOT `Date.now()`. A unit
// that was valid at the snapshot time is valid in the historical view,
// even if it expired afterwards.

const WAVE4EB_LIST_DEFAULT_WINDOW_SECONDS = 365 * 86400;
const WAVE4EB_LIST_MAX_WINDOW_SECONDS = 365 * 86400;
const WAVE4EB_LIST_RESULT_CAP = 500;
const WAVE4EB_LIST_CACHE_TTL_MS = 60_000;
const WAVE4EB_GET_CACHE_TTL_MS = 30_000;

interface AuthorityGraphSnapshotSummaryProjected {
  snapshotId: string;
  timestamp: number;
  expiresAt: number;
  kind: string;
  partial: boolean;
  authorityUnitsCount: number;
  compositionContractsCount: number;
  constitutionalLayersCount: number;
  caseLawCount: number;
}

interface AuthorityGraphSnapshotProjected {
  snapshotId: string;
  timestamp: number;
  expiresAt: number;
  kind: string;
  partial: boolean;
  authorityUnits: AuthorityUnitProjected[];
  compositionContracts: CompositionContractProjected[];
}

interface ListAuthorityGraphSnapshotsArgs {
  sinceTs?: number | null;
  untilTs?: number | null;
}

interface GetAuthorityGraphSnapshotArgs {
  snapshotId: string;
}

interface ListAuthorityGraphSnapshotsCacheEntry {
  summaries: AuthorityGraphSnapshotSummaryProjected[];
  expiresAt: number;
}

const listAuthorityGraphSnapshotsCache = new Map<
  string,
  ListAuthorityGraphSnapshotsCacheEntry
>();

interface GetAuthorityGraphSnapshotCacheEntry {
  snapshot: AuthorityGraphSnapshotProjected | null;
  expiresAt: number;
}

const getAuthorityGraphSnapshotCache = new Map<
  string,
  GetAuthorityGraphSnapshotCacheEntry
>();

/** Test-only helper: clear the Wave 4.E.B list-snapshots cache. */
export function __resetListAuthorityGraphSnapshotsCacheForTest(): void {
  listAuthorityGraphSnapshotsCache.clear();
}

/** Test-only helper: clear the Wave 4.E.B get-snapshot cache. */
export function __resetGetAuthorityGraphSnapshotCacheForTest(): void {
  getAuthorityGraphSnapshotCache.clear();
}

/**
 * Coerce a stored array attribute (`authorityUnits`, `compositionContracts`,
 * `constitutionalLayers`, `caseLaw`) to a JS array. The snapshot writer
 * stores these as native DDB lists, but the resolver tolerates a
 * JSON-string fallback for forward-compat (mirrors the `_maybe_json`
 * helper used by Wave 4.A's projections).
 */
function coerceSnapshotArray(value: unknown): Array<Record<string, unknown>> {
  if (Array.isArray(value)) {
    return value.filter(
      (v): v is Record<string, unknown> =>
        v !== null && typeof v === 'object' && !Array.isArray(v),
    );
  }
  if (typeof value === 'string' && value.length > 0) {
    try {
      const parsed = JSON.parse(value);
      if (Array.isArray(parsed)) {
        return parsed.filter(
          (v): v is Record<string, unknown> =>
            v !== null && typeof v === 'object' && !Array.isArray(v),
        );
      }
    } catch {
      /* fall through */
    }
  }
  return [];
}

/**
 * Project a single authority-unit row inside a snapshot. Mirrors the
 * Wave 4.A `projectAuthorityUnit` shape but computes `isValid` against
 * the supplied reference timestamp (the SNAPSHOT's `timestamp`, in
 * epoch seconds) rather than `Date.now()`.
 */
function projectAuthorityUnitForSnapshot(
  row: Record<string, unknown>,
  snapshotTimestampSec: number,
): AuthorityUnitProjected | null {
  const unitId = typeof row.unitId === 'string' ? row.unitId : '';
  const agentId = typeof row.agentId === 'string' ? row.agentId : '';
  if (unitId.length === 0 || agentId.length === 0) {
    console.warn(
      'projectAuthorityUnitForSnapshot: skipping malformed row',
      JSON.stringify({ keys: Object.keys(row) }),
    );
    return null;
  }
  const expiryRaw = row.expiryTimestamp;
  const expiryTimestamp =
    typeof expiryRaw === 'number'
      ? expiryRaw
      : typeof expiryRaw === 'string' && expiryRaw.length > 0
        ? Number(expiryRaw)
        : null;
  const revoked = row.revoked === true;
  // Reference time is the snapshot's timestamp (epoch seconds) — NOT
  // Date.now(). A unit that was valid at the snapshot time is valid
  // in the historical view even if it expired afterwards.
  const isValid =
    !revoked &&
    (expiryTimestamp === null ||
      Number.isNaN(expiryTimestamp) ||
      expiryTimestamp > snapshotTimestampSec);
  return {
    unitId,
    agentId,
    scope: projectAuthorityScope(row.scope),
    delegationSource:
      typeof row.delegationSource === 'string' ? row.delegationSource : null,
    canRedelegate: row.canRedelegate === true,
    expiryTimestamp:
      expiryTimestamp !== null && !Number.isNaN(expiryTimestamp)
        ? expiryTimestamp
        : null,
    revoked,
    riskRating:
      typeof row.riskRating === 'string' && row.riskRating.length > 0
        ? row.riskRating
        : 'low',
    registryId:
      typeof row.registryId === 'string' && row.registryId.length > 0
        ? row.registryId
        : null,
    isValid,
  };
}

async function listAuthorityGraphSnapshots(
  event: AppSyncResolverEvent<ListAuthorityGraphSnapshotsArgs>,
): Promise<AuthorityGraphSnapshotSummaryProjected[]> {
  if (!isAdminFromEvent(event)) {
    throw new Error('Forbidden: admin required');
  }

  const tableName = process.env.GRAPH_SNAPSHOTS_TABLE;
  if (!tableName) {
    throw new Error('GRAPH_SNAPSHOTS_TABLE env var is not set');
  }

  const args = (event.arguments ?? {}) as ListAuthorityGraphSnapshotsArgs;
  const nowSec = Math.floor(Date.now() / 1000);
  const untilTs =
    typeof args.untilTs === 'number' && args.untilTs > 0 ? args.untilTs : nowSec;
  let sinceTs =
    typeof args.sinceTs === 'number' && args.sinceTs > 0
      ? args.sinceTs
      : untilTs - WAVE4EB_LIST_DEFAULT_WINDOW_SECONDS;
  if (sinceTs > untilTs) {
    sinceTs = untilTs - WAVE4EB_LIST_DEFAULT_WINDOW_SECONDS;
  }
  // Cap the window at 365 days (matches the max retentionDays
  // allowlist). Anything wider would scan beyond the data the Wave
  // 4.E.A writer ever produced.
  if (untilTs - sinceTs > WAVE4EB_LIST_MAX_WINDOW_SECONDS) {
    sinceTs = untilTs - WAVE4EB_LIST_MAX_WINDOW_SECONDS;
  }

  const cacheKey = `${sinceTs}|${untilTs}`;
  const cached = listAuthorityGraphSnapshotsCache.get(cacheKey);
  if (cached && Date.now() < cached.expiresAt) {
    return cached.summaries;
  }

  // Query the kind-timestamp-index GSI for kind='full' rows in the
  // window. The Wave 4.E.A writer only emits `kind: 'full'`; the GSI
  // partition key isolates them so a future delta variant does not
  // pollute the index.
  const items: DdbRow[] = [];
  let lastEvaluatedKey: Record<string, unknown> | undefined;
  let truncated = false;

  do {
    const cmd = new QueryCommand({
      TableName: tableName,
      IndexName: 'kind-timestamp-index',
      KeyConditionExpression: 'kind = :full AND #ts BETWEEN :since AND :until',
      ExpressionAttributeNames: { '#ts': 'timestamp' },
      ExpressionAttributeValues: {
        ':full': 'full',
        ':since': sinceTs,
        ':until': untilTs,
      },
      ...(lastEvaluatedKey ? { ExclusiveStartKey: lastEvaluatedKey } : {}),
    });
    const result = await dynamodb.send(cmd);
    const page = (result.Items ?? []) as DdbRow[];
    for (const row of page) {
      if (items.length >= WAVE4EB_LIST_RESULT_CAP) {
        truncated = true;
        break;
      }
      items.push(row);
    }
    if (truncated) break;
    lastEvaluatedKey = result.LastEvaluatedKey as
      | Record<string, unknown>
      | undefined;
  } while (lastEvaluatedKey);

  if (truncated) {
    console.warn(
      `listAuthorityGraphSnapshots: result cap ${WAVE4EB_LIST_RESULT_CAP} ` +
        `reached for window ${sinceTs}..${untilTs}.`,
    );
  }

  const summaries: AuthorityGraphSnapshotSummaryProjected[] = [];
  for (const row of items) {
    const snapshotId =
      typeof row.snapshotId === 'string' ? row.snapshotId : '';
    if (snapshotId.length === 0) continue;
    const tsRaw = row.timestamp;
    const timestamp =
      typeof tsRaw === 'number'
        ? tsRaw
        : typeof tsRaw === 'string'
          ? Number(tsRaw)
          : 0;
    const expRaw = row.expiresAt;
    const expiresAt =
      typeof expRaw === 'number'
        ? expRaw
        : typeof expRaw === 'string'
          ? Number(expRaw)
          : 0;
    const kind = typeof row.kind === 'string' ? row.kind : 'full';
    const partial = row.partial === true;
    summaries.push({
      snapshotId,
      timestamp: Number.isFinite(timestamp) ? timestamp : 0,
      expiresAt: Number.isFinite(expiresAt) ? expiresAt : 0,
      kind,
      partial,
      authorityUnitsCount: coerceSnapshotArray(row.authorityUnits).length,
      compositionContractsCount: coerceSnapshotArray(row.compositionContracts)
        .length,
      constitutionalLayersCount: coerceSnapshotArray(row.constitutionalLayers)
        .length,
      caseLawCount: coerceSnapshotArray(row.caseLaw).length,
    });
  }

  // Sort ascending by timestamp so the scrubber renders left → right
  // in chronological order.
  summaries.sort((a, b) => a.timestamp - b.timestamp);

  listAuthorityGraphSnapshotsCache.set(cacheKey, {
    summaries,
    expiresAt: Date.now() + WAVE4EB_LIST_CACHE_TTL_MS,
  });
  return summaries;
}

async function getAuthorityGraphSnapshot(
  event: AppSyncResolverEvent<GetAuthorityGraphSnapshotArgs>,
): Promise<AuthorityGraphSnapshotProjected | null> {
  if (!isAdminFromEvent(event)) {
    throw new Error('Forbidden: admin required');
  }

  const tableName = process.env.GRAPH_SNAPSHOTS_TABLE;
  if (!tableName) {
    throw new Error('GRAPH_SNAPSHOTS_TABLE env var is not set');
  }

  const args = (event.arguments ?? {}) as GetAuthorityGraphSnapshotArgs;
  const snapshotId =
    typeof args.snapshotId === 'string' ? args.snapshotId : '';
  if (snapshotId.length === 0) {
    throw new Error('snapshotId is required');
  }

  const cached = getAuthorityGraphSnapshotCache.get(snapshotId);
  if (cached && Date.now() < cached.expiresAt) {
    return cached.snapshot;
  }

  // The snapshots table key is composite (snapshotId + timestamp), so
  // a GetItem requires both keys; we don't know the timestamp at this
  // point. Use a Query keyed on the partition key only and take the
  // first item — the snapshotId is a UUID so collisions across rows
  // are vanishingly unlikely. Limit=1 keeps the scan bounded.
  const result = await dynamodb.send(
    new QueryCommand({
      TableName: tableName,
      KeyConditionExpression: 'snapshotId = :id',
      ExpressionAttributeValues: { ':id': snapshotId },
      Limit: 1,
    }),
  );
  const item = (result.Items ?? [])[0] as DdbRow | undefined;
  if (!item) {
    getAuthorityGraphSnapshotCache.set(snapshotId, {
      snapshot: null,
      expiresAt: Date.now() + WAVE4EB_GET_CACHE_TTL_MS,
    });
    return null;
  }

  const tsRaw = item.timestamp;
  const timestamp =
    typeof tsRaw === 'number'
      ? tsRaw
      : typeof tsRaw === 'string'
        ? Number(tsRaw)
        : 0;
  const expRaw = item.expiresAt;
  const expiresAt =
    typeof expRaw === 'number'
      ? expRaw
      : typeof expRaw === 'string'
        ? Number(expRaw)
        : 0;
  const kind = typeof item.kind === 'string' ? item.kind : 'full';
  const partial = item.partial === true;

  const unitsRaw = coerceSnapshotArray(item.authorityUnits);
  const contractsRaw = coerceSnapshotArray(item.compositionContracts);

  const referenceTs = Number.isFinite(timestamp) ? timestamp : 0;

  const authorityUnits: AuthorityUnitProjected[] = [];
  for (const row of unitsRaw) {
    const projected = projectAuthorityUnitForSnapshot(row, referenceTs);
    if (projected !== null) authorityUnits.push(projected);
  }

  const compositionContracts: CompositionContractProjected[] = [];
  for (const row of contractsRaw) {
    const projected = projectCompositionContract(row);
    if (projected !== null) compositionContracts.push(projected);
  }

  const snapshot: AuthorityGraphSnapshotProjected = {
    snapshotId,
    timestamp: referenceTs,
    expiresAt: Number.isFinite(expiresAt) ? expiresAt : 0,
    kind,
    partial,
    authorityUnits,
    compositionContracts,
  };

  getAuthorityGraphSnapshotCache.set(snapshotId, {
    snapshot,
    expiresAt: Date.now() + WAVE4EB_GET_CACHE_TTL_MS,
  });
  return snapshot;
}

// ---------------------------------------------------------------------------
// Wave 5.A — D4 defense-in-depth retrospective
// ---------------------------------------------------------------------------
//
// Admin-only port of `arbiter/governance/d4_retrospective.py`. Scans the
// governance ledger for `decision = 'deny'` findings whose
// `scope_evaluated` is one of the two worker scopes
// (`worker-pre-filter`, `worker-tool-handler`) within the requested
// window (allowlist: 7, 14, 30, 60, 90 days; default 30). For each
// finding the dedup key is `${workflow_id}|${reason}`; the overlap
// between the two dedup-key sets and the resulting overlap-ratio drive
// the recommendation.
//
// Thresholds MUST match the Python script verbatim — they are the
// source of truth. `insufficientEvidence` short-circuits the
// recommendation to `deferred-90d` when fewer than 1 worker-tool-handler
// finding is observed in the window (raw count, not distinct).
//
// 5-minute in-process cache keyed on `${windowDays}` so back-to-back
// fetches (e.g. on operator-toggled "refresh" UI) don't repeatedly scan
// the ledger. Page result is hard-capped at 5000 items; truncated:true
// signals the operator to tighten the window.

const WAVE5A_WINDOW_ALLOWLIST: ReadonlySet<number> = new Set([7, 14, 30, 60, 90]);
const WAVE5A_DEFAULT_WINDOW_DAYS = 30;
const WAVE5A_SCAN_HARD_CAP = 5000;
const WAVE5A_CACHE_TTL_MS = 5 * 60_000;
const WAVE5A_SCOPE_PRE_FILTER = 'worker-pre-filter';
const WAVE5A_SCOPE_TOOL_HANDLER = 'worker-tool-handler';
const WAVE5A_RECOMMENDATION_THRESHOLD_HIGH = 0.9;
const WAVE5A_RECOMMENDATION_THRESHOLD_LOW = 0.2;

interface D4RetrospectiveCounts {
  preFilterTotal: number;
  toolHandlerTotal: number;
  distinctPreFilter: number;
  distinctToolHandler: number;
  overlap: number;
}

interface D4RetrospectiveReport {
  generatedAt: number;
  windowStart: number;
  windowEnd: number;
  windowDays: number;
  insufficientEvidence: boolean;
  counts: D4RetrospectiveCounts;
  overlapRatio: number;
  recommendation: string;
  truncated: boolean;
}

interface D4RetrospectiveArgs {
  windowDays?: number | null;
}

interface D4RetrospectiveCacheEntry {
  report: D4RetrospectiveReport;
  expiresAt: number;
}

const d4RetrospectiveCache = new Map<string, D4RetrospectiveCacheEntry>();

/** Test-only helper: clear the Wave 5.A retrospective cache. */
export function __resetD4RetrospectiveCacheForTest(): void {
  d4RetrospectiveCache.clear();
}

/**
 * Pure helper: derive the recommendation from the counts +
 * insufficient-evidence flag. Extracted so the four branches are
 * unit-testable without setting up a DDB mock.
 *
 * Branches mirror `build_recommendation()` in
 * `arbiter/governance/d4_retrospective.py` verbatim:
 *   1. `insufficientEvidence` → `'deferred-90d'`
 *   2. `overlapRatio > 0.90`  → `'re-debate'`
 *   3. `overlapRatio < 0.20`  → `'keep-both-strong-evidence'`
 *   4. else                    → `'keep-both'`
 */
export function computeD4Recommendation(
  counts: D4RetrospectiveCounts,
  insufficientEvidence: boolean,
): string {
  if (insufficientEvidence) return 'deferred-90d';
  const denom = Math.max(
    counts.distinctPreFilter,
    counts.distinctToolHandler,
    1,
  );
  const overlapRatio = counts.overlap / denom;
  if (overlapRatio > WAVE5A_RECOMMENDATION_THRESHOLD_HIGH) return 're-debate';
  if (overlapRatio < WAVE5A_RECOMMENDATION_THRESHOLD_LOW) {
    return 'keep-both-strong-evidence';
  }
  return 'keep-both';
}

async function getD4RetrospectiveReport(
  event: AppSyncResolverEvent<D4RetrospectiveArgs>,
): Promise<D4RetrospectiveReport> {
  if (!isAdminFromEvent(event)) {
    throw new Error('Forbidden: admin required');
  }

  const tableName = process.env.GOVERNANCE_LEDGER_TABLE;
  if (!tableName) {
    throw new Error('GOVERNANCE_LEDGER_TABLE env var is not set');
  }

  const args = (event.arguments ?? {}) as D4RetrospectiveArgs;
  const requestedWindow =
    typeof args.windowDays === 'number' && Number.isFinite(args.windowDays)
      ? args.windowDays
      : WAVE5A_DEFAULT_WINDOW_DAYS;
  if (!WAVE5A_WINDOW_ALLOWLIST.has(requestedWindow)) {
    throw new Error(
      `Invalid windowDays: ${requestedWindow}. Allowed: 7, 14, 30, 60, 90`,
    );
  }
  const windowDays = requestedWindow;

  const cacheKey = String(windowDays);
  const cached = d4RetrospectiveCache.get(cacheKey);
  if (cached && Date.now() < cached.expiresAt) {
    return cached.report;
  }

  const nowSec = Math.floor(Date.now() / 1000);
  const untilTs = nowSec;
  const sinceTs = nowSec - windowDays * 86400;

  // Scope-typed dedup keys. The dedup key matches the Python script
  // (`f"{workflow_id}|{reason}"`); raw totals count every matching row,
  // distinct totals are the set cardinalities.
  const preFilter = new Set<string>();
  const toolHandler = new Set<string>();
  let preFilterTotal = 0;
  let toolHandlerTotal = 0;
  let truncated = false;
  let scanned = 0;

  let lastEvaluatedKey: Record<string, unknown> | undefined;
  do {
    const cmd = new ScanCommand({
      TableName: tableName,
      FilterExpression:
        'decision = :deny AND scope_evaluated IN (:preFilter, :toolHandler) ' +
        'AND #ts BETWEEN :since AND :until',
      ExpressionAttributeNames: { '#ts': 'timestamp' },
      ExpressionAttributeValues: {
        ':deny': 'deny',
        ':preFilter': WAVE5A_SCOPE_PRE_FILTER,
        ':toolHandler': WAVE5A_SCOPE_TOOL_HANDLER,
        ':since': sinceTs,
        ':until': untilTs,
      },
      ...(lastEvaluatedKey ? { ExclusiveStartKey: lastEvaluatedKey } : {}),
    });
    const result = await dynamodb.send(cmd);
    const page = (result.Items ?? []) as DdbRow[];
    for (const row of page) {
      if (scanned >= WAVE5A_SCAN_HARD_CAP) {
        truncated = true;
        break;
      }
      scanned++;
      const workflowId =
        typeof row.workflow_id === 'string' ? row.workflow_id : '';
      const reason = typeof row.reason === 'string' ? row.reason : '';
      const key = `${workflowId}|${reason}`;
      const scope =
        typeof row.scope_evaluated === 'string' ? row.scope_evaluated : '';
      if (scope === WAVE5A_SCOPE_PRE_FILTER) {
        preFilter.add(key);
        preFilterTotal++;
      } else if (scope === WAVE5A_SCOPE_TOOL_HANDLER) {
        toolHandler.add(key);
        toolHandlerTotal++;
      }
    }
    if (truncated) break;
    lastEvaluatedKey = result.LastEvaluatedKey as
      | Record<string, unknown>
      | undefined;
  } while (lastEvaluatedKey);

  if (truncated) {
    console.warn(
      `getD4RetrospectiveReport: truncated at ${WAVE5A_SCAN_HARD_CAP} rows ` +
        'for windowDays=' +
        windowDays +
        '. Tighten the window for a complete view.',
    );
  }

  // Set intersection. We iterate the smaller set for a cheap O(min(a, b)).
  const [smaller, larger] =
    preFilter.size <= toolHandler.size
      ? [preFilter, toolHandler]
      : [toolHandler, preFilter];
  let overlapCount = 0;
  for (const key of smaller) {
    if (larger.has(key)) overlapCount++;
  }

  const counts: D4RetrospectiveCounts = {
    preFilterTotal,
    toolHandlerTotal,
    distinctPreFilter: preFilter.size,
    distinctToolHandler: toolHandler.size,
    overlap: overlapCount,
  };
  const denom = Math.max(
    counts.distinctPreFilter,
    counts.distinctToolHandler,
    1,
  );
  const overlapRatio = counts.overlap / denom;
  // Python script: `tool_handler_count < 1` — raw count, not distinct.
  const insufficientEvidence = counts.toolHandlerTotal < 1;
  const recommendation = computeD4Recommendation(counts, insufficientEvidence);

  const report: D4RetrospectiveReport = {
    generatedAt: nowSec,
    windowStart: sinceTs,
    windowEnd: untilTs,
    windowDays,
    insufficientEvidence,
    counts,
    overlapRatio,
    recommendation,
    truncated,
  };

  d4RetrospectiveCache.set(cacheKey, {
    report,
    expiresAt: Date.now() + WAVE5A_CACHE_TTL_MS,
  });
  return report;
}

// ---------------------------------------------------------------------------
// Wave 5.C.1 — getTrustPath (IAM trust path visualization)
// ---------------------------------------------------------------------------
//
// Admin-only audit of the IAM assume chain that an admin Lambda follows
// to reach a target resource (datastore / integration / agent). Wave 5.C.1
// computes the chain AS IF the governance-ui-resolver Lambda were the
// assumer — real call sites (datastore / integration / agent resolvers)
// follow the same pattern but the operator-pickable assumer ships in a
// future slice. Drift detection + simulate-principal-policy
// effective-permissions overlay are reserved for Wave 5.C.2.
//
// Per-hop behaviour: every IAM Get* call is wrapped in its own try/catch
// so a single missing role or absent inline policy emits a hop with
// empty fields + a contextual note rather than crashing the report.

const WAVE5C1_RESOURCE_TYPE_ALLOWLIST: ReadonlySet<string> = new Set([
  'agent',
  'datastore',
  'integration',
]);
const WAVE5C1_RESOURCE_ID_MAX_LENGTH = 256;
const WAVE5C1_CACHE_TTL_MS = 5 * 60_000;

interface GetTrustPathArgs {
  resourceType: string;
  resourceId: string;
}

interface TrustPathPolicyStatementProjected {
  effect: string;
  actions: string[];
  resources: string[];
  conditionsJson: string | null;
}

interface TrustPathRoleProjected {
  arn: string;
  name: string;
  scope: string;
  trustPolicyPrincipals: string[];
  inlinePolicy: TrustPathPolicyStatementProjected[];
  inlinePolicyName: string | null;
  totalActions: number;
  totalResources: number;
}

interface TrustPathReportProjected {
  resourceType: string;
  resourceId: string;
  generatedAt: number;
  hops: TrustPathRoleProjected[];
  notes: string[];
}

interface TrustPathCacheEntry {
  report: TrustPathReportProjected;
  expiresAt: number;
}

const trustPathCache = new Map<string, TrustPathCacheEntry>();

/** Test-only helper: clear the Wave 5.C.1 trust path cache. */
export function __resetTrustPathCacheForTest(): void {
  trustPathCache.clear();
}

const SCOPE_ROLE_PREFIX: Record<string, string> = {
  datastore: 'citadel-ds-',
  integration: 'citadel-int-',
  agent: 'citadel-agent-',
};

/**
 * Resolve the Lambda execution role ARN that drives the trust chain.
 * Preferred source is the `LAMBDA_EXEC_ROLE_ARN` env var (set on the
 * resolver Lambda by ArbiterStack). Falls back to deriving from
 * `AWS_LAMBDA_FUNCTION_NAME` via the function's role lookup; that
 * fallback is best-effort because Lambda doesn't expose the role ARN
 * in any env var natively. When both fail, the caller gets a single
 * UNKNOWN hop with the documented note string.
 */
function resolveLambdaExecRoleArn(): { arn: string | null; note: string | null } {
  const direct = process.env.LAMBDA_EXEC_ROLE_ARN;
  if (typeof direct === 'string' && direct.length > 0) {
    return { arn: direct, note: null };
  }
  // No reliable env-var fallback in vanilla Lambda; return UNKNOWN.
  return {
    arn: null,
    note: 'Lambda execution role unresolvable in this environment',
  };
}

/**
 * Fetch a hop's role + inline policy by delegating to the shared trust-path
 * core (`fetchTrustPathHop` in ../utils/trust-path). Behaviour-preserving: the
 * same IAM calls (via the module `iam` client), the same per-hop projection,
 * and the same contextual notes appended to the shared `notes` array in order
 * as the pre-refactor inline implementation.
 */
async function buildHop(
  arn: string,
  scope: string,
  notes: string[],
): Promise<TrustPathRoleProjected> {
  const result = await fetchTrustPathHop(iam, arn, scope);
  for (const note of result.notes) notes.push(note);
  return result.hop;
}

/**
 * Read a single resource by id and return its raw config. Mirrors the
 * read paths in datastore-resolver.ts / integration-resolver.ts /
 * agent-config-resolver.ts. Returns `null` when the resource is
 * missing — the caller emits a contextual note rather than throwing.
 */
async function loadTrustPathResource(
  resourceType: string,
  resourceId: string,
): Promise<Record<string, unknown> | null> {
  if (resourceType === 'datastore') {
    const tableName = process.env.DATASTORES_TABLE;
    if (!tableName) return null;
    try {
      const result = await dynamodb.send(
        new GetCommand({
          TableName: tableName,
          Key: { dataStoreId: resourceId },
        }),
      );
      return (result.Item as Record<string, unknown> | undefined) ?? null;
    } catch (err) {
      console.warn('getTrustPath: datastore lookup failed', err);
      return null;
    }
  }
  if (resourceType === 'integration') {
    const tableName = process.env.INTEGRATIONS_TABLE;
    if (!tableName) return null;
    try {
      const result = await dynamodb.send(
        new QueryCommand({
          TableName: tableName,
          IndexName: 'IntegrationIdIndex',
          KeyConditionExpression: 'integrationId = :id',
          ExpressionAttributeValues: { ':id': resourceId },
        }),
      );
      const items = (result.Items as Array<Record<string, unknown>> | undefined) ?? [];
      return items.length > 0 ? items[0] : null;
    } catch (err) {
      console.warn('getTrustPath: integration lookup failed', err);
      return null;
    }
  }
  if (resourceType === 'agent') {
    const registryService = getRegistryServiceForChecks();
    if (!registryService) return null;
    try {
      const record = await registryService.getResource('agent', resourceId);
      if (!record) return null;
      return record as unknown as Record<string, unknown>;
    } catch (err) {
      console.warn('getTrustPath: agent lookup failed', err);
      return null;
    }
  }
  return null;
}

async function getTrustPath(
  event: AppSyncResolverEvent<GetTrustPathArgs>,
): Promise<TrustPathReportProjected> {
  if (!isAdminFromEvent(event)) {
    throw new Error('Forbidden: admin required');
  }

  const args = (event.arguments ?? {}) as GetTrustPathArgs;
  const resourceType =
    typeof args.resourceType === 'string' ? args.resourceType : '';
  const resourceId =
    typeof args.resourceId === 'string' ? args.resourceId : '';

  if (!WAVE5C1_RESOURCE_TYPE_ALLOWLIST.has(resourceType)) {
    throw new Error(
      `Invalid resourceType: ${resourceType}. Expected one of: agent, datastore, integration`,
    );
  }
  if (resourceId.length === 0) {
    throw new Error('Invalid resourceId: must be a non-empty string');
  }
  if (resourceId.length > WAVE5C1_RESOURCE_ID_MAX_LENGTH) {
    throw new Error(
      `Invalid resourceId: length must be <= ${WAVE5C1_RESOURCE_ID_MAX_LENGTH}`,
    );
  }

  // Resolve the account id once (used both in the cache key and in the
  // scoped role ARN construction). A failure here is fatal — without
  // an account id we can't produce a meaningful chain.
  let accountId = '';
  try {
    const ident = await sts.send(new GetCallerIdentityCommand({}));
    accountId = typeof ident.Account === 'string' ? ident.Account : '';
  } catch (err) {
    console.error('getTrustPath: GetCallerIdentity failed', err);
    throw new Error('Unable to resolve account identity for trust path');
  }

  const cacheKey = `${resourceType}|${resourceId}|${accountId}`;
  const cached = trustPathCache.get(cacheKey);
  if (cached && Date.now() < cached.expiresAt) {
    return cached.report;
  }

  const notes: string[] = [];
  const hops: TrustPathRoleProjected[] = [];

  // --- Hop 1: Lambda execution role -----------------------------------
  const { arn: lambdaArn, note: lambdaNote } = resolveLambdaExecRoleArn();
  if (lambdaNote) notes.push(lambdaNote);
  if (lambdaArn) {
    const hop = await buildHop(lambdaArn, 'lambda', notes);
    hops.push(hop);
  } else {
    // Emit a synthetic UNKNOWN hop so the chain has at least one
    // entry — the frontend renders a hop card with the note text.
    hops.push({
      arn: 'unknown',
      name: 'unknown',
      scope: 'lambda',
      trustPolicyPrincipals: [],
      inlinePolicy: [],
      inlinePolicyName: null,
      totalActions: 0,
      totalResources: 0,
    });
  }

  // --- Resource lookup ------------------------------------------------
  const record = await loadTrustPathResource(resourceType, resourceId);
  if (!record) {
    notes.push(`Resource not found: ${resourceType}/${resourceId}`);
    const report: TrustPathReportProjected = {
      resourceType,
      resourceId,
      generatedAt: Date.now(),
      hops,
      notes,
    };
    trustPathCache.set(cacheKey, {
      report,
      expiresAt: Date.now() + WAVE5C1_CACHE_TTL_MS,
    });
    return report;
  }

  // --- Optional Hop 2: cross-account role -----------------------------
  const crossAccountRoleArn = extractCrossAccountRoleArn(record);
  if (crossAccountRoleArn) {
    const hop = await buildHop(crossAccountRoleArn, 'cross-account', notes);
    hops.push(hop);
  }

  // --- Final hop: scoped resource role --------------------------------
  const prefix = SCOPE_ROLE_PREFIX[resourceType];
  if (prefix) {
    const scopedRoleName = `${prefix}${resourceId}`;
    const scopedRoleArn = `arn:aws:iam::${accountId}:role/${scopedRoleName}`;
    const hop = await buildHop(scopedRoleArn, resourceType, notes);
    hops.push(hop);
  }

  const report: TrustPathReportProjected = {
    resourceType,
    resourceId,
    generatedAt: Date.now(),
    hops,
    notes,
  };
  trustPathCache.set(cacheKey, {
    report,
    expiresAt: Date.now() + WAVE5C1_CACHE_TTL_MS,
  });
  return report;
}

// ---------------------------------------------------------------------------
// Wave 5.C — getResourceIamDrift (IAM drift detection)
// ---------------------------------------------------------------------------
//
// Admin-only comparison of the live inline policy on the scoped resource
// role (`citadel-{ds|int|agent}-{resourceId}` / inline policy
// `DataStoreAccess`) against the policies the unified registry adapter
// declares for the same resource via `requiredPolicies(...).connect`.
// Surfaces excess permissions (granted but not declared) and missing
// permissions (declared but not granted) per resource ARN pattern so an
// operator can spot drift without leaving the governance UI.
//
// Per-failure behaviour: a missing inline policy or unregistered adapter
// emits a contextual note + a degraded report rather than throwing, so
// the page can render even when the role is half-provisioned.

interface IamDriftActionGroupProjected {
  resourceArnPattern: string;
  declaredActions: string[];
  effectiveActions: string[];
  excessActions: string[];
  missingActions: string[];
}

interface IamDriftReportProjected {
  resourceType: string;
  resourceId: string;
  scopedRoleArn: string;
  generatedAt: number;
  hasDrift: boolean;
  totalExcess: number;
  totalMissing: number;
  groups: IamDriftActionGroupProjected[];
  notes: string[];
}

interface GetResourceIamDriftArgs {
  resourceType?: string;
  resourceId?: string;
}

async function getResourceIamDrift(
  event: AppSyncResolverEvent<unknown>,
  args: GetResourceIamDriftArgs,
): Promise<IamDriftReportProjected> {
  assertAdmin(event);

  // Validate resourceType against the same allowlist the trust-path
  // resolver uses; PolicyScope is a strict subset so the cast below is
  // safe.
  const resourceType =
    typeof args.resourceType === 'string' ? args.resourceType : '';
  if (
    resourceType !== 'agent' &&
    resourceType !== 'datastore' &&
    resourceType !== 'integration'
  ) {
    throw new Error(`Invalid resourceType: ${resourceType}`);
  }

  const resourceId =
    typeof args.resourceId === 'string' ? args.resourceId : '';
  if (resourceId.length === 0) {
    throw new Error('Invalid resourceId: must be a non-empty string');
  }
  if (resourceId.length > 256) {
    throw new Error('Invalid resourceId: length must be <= 256');
  }

  const notes: string[] = [];

  // Resource lookup — REUSE the trust-path helper. Returns null when
  // the resource is missing; we degrade to an empty report rather than
  // throwing so the page still renders something useful.
  const resource = await loadTrustPathResource(resourceType, resourceId);
  if (!resource) {
    return {
      resourceType,
      resourceId,
      scopedRoleArn: '',
      generatedAt: Math.floor(Date.now() / 1000),
      hasDrift: false,
      totalExcess: 0,
      totalMissing: 0,
      groups: [],
      notes: [`Resource not found: ${resourceType}/${resourceId}`],
    };
  }

  // Account context (mirrors getTrustPath). A failure here is fatal
  // because we cannot construct a meaningful scoped role ARN without
  // the account id.
  let accountId = '';
  try {
    const ident = await sts.send(new GetCallerIdentityCommand({}));
    accountId = typeof ident.Account === 'string' ? ident.Account : '';
  } catch (err) {
    console.error('getResourceIamDrift: GetCallerIdentity failed', err);
    throw new Error('Unable to resolve account identity for IAM drift report');
  }
  const region = process.env.AWS_REGION ?? 'us-east-1';

  const scope: PolicyScope =
    resourceType === 'agent'
      ? 'agent'
      : resourceType === 'datastore'
        ? 'datastore'
        : 'integration';
  const roleName = PolicyManager.getRoleName(resourceId, scope);
  const scopedRoleArn = `arn:aws:iam::${accountId}:role/${roleName}`;

  // --- Effective inline policy from IAM ------------------------------
  const effectiveByResource = new Map<string, Set<string>>();
  let effectiveAvailable = false;
  try {
    const policyOut = await iam.send(
      new GetRolePolicyCommand({
        RoleName: roleName,
        PolicyName: 'DataStoreAccess',
      }),
    );
    const documentEncoded = policyOut.PolicyDocument;
    if (typeof documentEncoded === 'string' && documentEncoded.length > 0) {
      // IAM may URL-encode the document — decode unless it already
      // looks like raw JSON.
      const documentJson = documentEncoded.trim().startsWith('{')
        ? documentEncoded
        : decodeURIComponent(documentEncoded);
      try {
        const doc = JSON.parse(documentJson);
        const stmts = Array.isArray(doc?.Statement)
          ? doc.Statement
          : doc?.Statement
            ? [doc.Statement]
            : [];
        for (const stmt of stmts) {
          const actionsRaw = stmt?.Action;
          const resourcesRaw = stmt?.Resource;
          const actions =
            typeof actionsRaw === 'string'
              ? [actionsRaw]
              : Array.isArray(actionsRaw)
                ? actionsRaw.filter(
                    (a: unknown): a is string => typeof a === 'string',
                  )
                : [];
          const resources =
            typeof resourcesRaw === 'string'
              ? [resourcesRaw]
              : Array.isArray(resourcesRaw)
                ? resourcesRaw.filter(
                    (r: unknown): r is string => typeof r === 'string',
                  )
                : [];
          for (const r of resources) {
            let set = effectiveByResource.get(r);
            if (!set) {
              set = new Set<string>();
              effectiveByResource.set(r, set);
            }
            for (const a of actions) {
              set.add(a);
            }
          }
        }
        effectiveAvailable = true;
      } catch {
        notes.push(
          `Inline policy DataStoreAccess on ${scopedRoleArn} did not parse as JSON`,
        );
      }
    } else {
      notes.push(
        `Inline policy DataStoreAccess not present on ${scopedRoleArn}`,
      );
    }
  } catch (err) {
    // NoSuchEntity, AccessDenied, etc. all collapse to the same
    // operator-facing note. The detail is logged for postmortem.
    console.warn('getResourceIamDrift: GetRolePolicy failed', {
      roleName,
      error: (err as Error)?.message,
    });
    notes.push(
      `Inline policy DataStoreAccess not present on ${scopedRoleArn}`,
    );
  }

  if (!effectiveAvailable) {
    return {
      resourceType,
      resourceId,
      scopedRoleArn,
      generatedAt: Math.floor(Date.now() / 1000),
      hasDrift: false,
      totalExcess: 0,
      totalMissing: 0,
      groups: [],
      notes,
    };
  }

  // --- Declared policies via the unified registry --------------------
  const declaredByResource = new Map<string, Set<string>>();
  const recordRecord = resource as Record<string, unknown>;
  const resourceTypeKey =
    typeof recordRecord.type === 'string' ? recordRecord.type : '';
  const resourceConfig =
    (recordRecord.config as Record<string, unknown> | undefined) ?? {};
  try {
    const adapter = getUnifiedRegistry().getAdapter(resourceTypeKey);
    const required = adapter.requiredPolicies(
      resourceConfig,
      accountId,
      region,
    );
    const declared = required.connect ?? [];
    for (const stmt of declared) {
      const actions = stmt.actions ?? [];
      const resources = stmt.resources ?? [];
      for (const r of resources) {
        let set = declaredByResource.get(r);
        if (!set) {
          set = new Set<string>();
          declaredByResource.set(r, set);
        }
        for (const a of actions) {
          set.add(a);
        }
      }
    }
  } catch (err) {
    const msg = err instanceof Error ? err.message : String(err);
    notes.push(
      `Adapter not registered for type ${resourceTypeKey}; cannot compute drift (${msg})`,
    );
    return {
      resourceType,
      resourceId,
      scopedRoleArn,
      generatedAt: Math.floor(Date.now() / 1000),
      hasDrift: false,
      totalExcess: 0,
      totalMissing: 0,
      groups: [],
      notes,
    };
  }

  // --- Compute groups -----------------------------------------------
  const allKeys = new Set<string>([
    ...effectiveByResource.keys(),
    ...declaredByResource.keys(),
  ]);
  const groups: IamDriftActionGroupProjected[] = [];
  let totalExcess = 0;
  let totalMissing = 0;

  for (const key of allKeys) {
    const effective = effectiveByResource.get(key) ?? new Set<string>();
    const declared = declaredByResource.get(key) ?? new Set<string>();
    const excess: string[] = [];
    for (const a of effective) {
      if (!declared.has(a)) excess.push(a);
    }
    const missing: string[] = [];
    for (const a of declared) {
      if (!effective.has(a)) missing.push(a);
    }
    excess.sort();
    missing.sort();
    const effectiveActions = Array.from(effective).sort();
    const declaredActions = Array.from(declared).sort();
    totalExcess += excess.length;
    totalMissing += missing.length;
    groups.push({
      resourceArnPattern: key,
      declaredActions,
      effectiveActions,
      excessActions: excess,
      missingActions: missing,
    });
  }

  groups.sort((a, b) =>
    a.resourceArnPattern.localeCompare(b.resourceArnPattern),
  );

  return {
    resourceType,
    resourceId,
    scopedRoleArn,
    generatedAt: Math.floor(Date.now() / 1000),
    hasDrift: totalExcess > 0 || totalMissing > 0,
    totalExcess,
    totalMissing,
    groups,
    notes,
  };
}

// --- Handler ---

export async function handler(
  event: AppSyncResolverEvent<Record<string, unknown>>,
): Promise<unknown> {
  const fieldName = event.info?.fieldName;

  switch (fieldName) {
    case 'getGovernanceMode':
      return getGovernanceMode();
    case 'listGovernanceFindings':
      return listGovernanceFindings(
        (event.arguments as ListFindingsArgs | undefined) ?? {},
      );
    case 'getGovernanceFinding':
      return getGovernanceFinding(event.arguments as unknown as GetFindingArgs);
    case 'getDecisionTrace':
      return getDecisionTrace(
        event.arguments as unknown as GetDecisionTraceArgs,
      );
    case 'getReconcilerStatus':
      return getReconcilerStatus(event);
    case 'getRolloutReadiness': {
      const report = await getRolloutReadiness(event);
      return { ...report, generatedAt: Number(report.generatedAt) };
    }
    case 'getMismatchHeatmap':
      return getMismatchHeatmap(
        event as unknown as AppSyncResolverEvent<MismatchHeatmapArgs>,
      );
    case 'getEscalationMetricSeries':
      return getEscalationMetricSeries(
        event as unknown as AppSyncResolverEvent<EscalationMetricArgs>,
      );
    case 'setGovernanceMode':
      return setGovernanceMode(
        event as unknown as AppSyncResolverEvent<SetGovernanceModeArgs>,
      );
    case 'markReadinessCheckVerified':
      return markReadinessCheckVerified(
        event as unknown as AppSyncResolverEvent<MarkReadinessCheckVerifiedArgs>,
      );
    case 'publishGovernanceFinding':
      return publishGovernanceFinding(
        event as unknown as AppSyncResolverEvent<PublishGovernanceFindingArgs>,
      );
    case 'listAuthorityUnits':
      return listAuthorityUnits(
        event as unknown as AppSyncResolverEvent<ListAuthorityUnitsArgs>,
      );
    case 'listCompositionContracts':
      return listCompositionContracts(event);
    case 'getRevokeImpact':
      return getRevokeImpact(
        event as unknown as AppSyncResolverEvent<GetRevokeImpactArgs>,
      );
    case 'listConstitutionalLayers':
      return listConstitutionalLayers(event);
    case 'getConstitutionalRuleStats':
      return getConstitutionalRuleStats(
        event as unknown as AppSyncResolverEvent<GetConstitutionalRuleStatsArgs>,
      );
    case 'listCaseLaw':
      return listCaseLaw(
        event as unknown as AppSyncResolverEvent<ListCaseLawArgs>,
      );
    case 'addConstitutionalRule':
      return addConstitutionalRule(
        event as unknown as AppSyncResolverEvent<{
          input: AddConstitutionalRuleInput;
        }>,
      );
    case 'updateConstitutionalRule':
      return updateConstitutionalRule(
        event as unknown as AppSyncResolverEvent<{
          input: UpdateConstitutionalRuleInput;
        }>,
      );
    case 'deleteConstitutionalRule':
      return deleteConstitutionalRule(
        event as unknown as AppSyncResolverEvent<{
          input: DeleteConstitutionalRuleInput;
        }>,
      );
    case 'revokeCaseLaw':
      return revokeCaseLaw(
        event as unknown as AppSyncResolverEvent<{
          input: RevokeCaseLawInput;
        }>,
      );
    case 'unrevokeCaseLaw':
      return unrevokeCaseLaw(
        event as unknown as AppSyncResolverEvent<{
          input: UnrevokeCaseLawInput;
        }>,
      );
    case 'updateCaseLawPrecedence':
      return updateCaseLawPrecedence(
        event as unknown as AppSyncResolverEvent<{
          input: UpdateCaseLawPrecedenceInput;
        }>,
      );
    case 'getAuthorityGraphHistorySettings':
      return getAuthorityGraphHistorySettings(event);
    case 'updateAuthorityGraphHistorySettings':
      return updateAuthorityGraphHistorySettings(
        event as unknown as AppSyncResolverEvent<{
          input: UpdateAuthorityGraphHistorySettingsInput;
        }>,
      );
    case 'listAuthorityGraphSnapshots':
      return listAuthorityGraphSnapshots(
        event as unknown as AppSyncResolverEvent<ListAuthorityGraphSnapshotsArgs>,
      );
    case 'getAuthorityGraphSnapshot':
      return getAuthorityGraphSnapshot(
        event as unknown as AppSyncResolverEvent<GetAuthorityGraphSnapshotArgs>,
      );
    case 'getD4RetrospectiveReport':
      return getD4RetrospectiveReport(
        event as unknown as AppSyncResolverEvent<D4RetrospectiveArgs>,
      );
    case 'getTrustPath':
      return getTrustPath(
        event as unknown as AppSyncResolverEvent<GetTrustPathArgs>,
      );
    case 'getResourceIamDrift':
      return getResourceIamDrift(
        event,
        event.arguments as unknown as GetResourceIamDriftArgs,
      );
    default:
      throw new Error(`Unknown field: ${fieldName}`);
  }
}
