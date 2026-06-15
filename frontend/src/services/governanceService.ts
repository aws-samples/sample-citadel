/**
 * Governance UI service
 *
 * Source of truth: .kiro/specs/governance-ui/graphql-contract.md
 *
 * Field names and TypeScript shapes mirror that contract verbatim.
 * Drift between this file and the contract is a bug.
 */

import serverService from './server';

// -- Types from the contract (graphql-contract.md → "TypeScript types (frontend)") --

export interface GovernanceMode {
  enforce: 'permissive' | 'shadow' | 'strict' | string;
  effectiveAt: string | null;
  env: string;
}

export interface GovernanceFinding {
  findingId: string;
  workflowId: string;
  decision: 'permit' | 'deny' | 'escalate' | 'halt' | string;
  reason: string;
  requestingAgent: string;
  targetAgent: string;
  scopeEvaluated: string | null;
  contractEvaluated: string | null;
  escalationTarget: string | null;
  residualAuthorityDenial: boolean | null;
  timestamp: number;
}

export interface GovernanceFindingConnection {
  items: GovernanceFinding[];
  nextCursor: string | null;
}

export interface ReconcilerClassification {
  inSync: number;
  missing: number;
  stale: number;
  orphan: number;
}

export interface ReconcilerStatus {
  lastRunAt: string | null;
  lastRunMode: 'dry-run' | 'apply' | null | string;
  classifications: ReconcilerClassification;
  totalRecords: number;
}

export interface ListFindingsArgs {
  limit?: number;
  cursor?: string | null;
  decision?: string | null;
  workflowId?: string | null;
  sinceTs?: number | null;
}

// -- rollout readiness types --

export type ReadinessCheckStatus = 'PASS' | 'FAIL' | 'WARN' | 'UNKNOWN' | 'STUB';

export interface ReadinessCheck {
  id: string;
  label: string;
  status: ReadinessCheckStatus;
  detail: string | null;
  evidence: string | null;
  category: string;
}

export interface RolloutReadinessReport {
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

// -- mismatch heatmap types --

export interface MismatchBucket {
  bucketStart: number;
  count: number;
  decision: string;
  topReason: string | null;
}

export interface ModeWindow {
  startTs: number;
  endTs: number | null;
  mode: string;
}

export interface MismatchHeatmapReport {
  generatedAt: number;
  sinceTs: number;
  untilTs: number;
  bucketSeconds: number;
  totalDenials: number;
  totalEscalations: number;
  modeWindows: ModeWindow[];
  buckets: MismatchBucket[];
}

export interface MismatchHeatmapArgs {
  sinceTs?: number | null;
  untilTs?: number | null;
  bucketSeconds?: number | null;
}

// -- escalation metric series types --

export interface MetricDatapoint {
  timestamp: number;
  value: number;
}

export interface MetricSeries {
  namespace: string;
  metric: string;
  statistic: string;
  periodSeconds: number;
  sinceTs: number;
  untilTs: number;
  datapoints: MetricDatapoint[];
  total: number;
}

export interface EscalationMetricArgs {
  sinceTs?: number | null;
  untilTs?: number | null;
  periodSeconds?: number | null;
}

// -- setGovernanceMode mutation types --

export interface SetGovernanceModeInput {
  targetMode: 'permissive' | 'shadow' | 'strict';
  acknowledgement: string;
  reason?: string | null;
}

export interface SetGovernanceModeResult {
  ok: boolean;
  previousMode: string;
  newMode: string;
  effectiveAt: string | null;
  noop: boolean;
  emittedEventDetailType: string | null;
}

// -- mark-verified mutation types --

export interface MarkReadinessCheckVerifiedInput {
  checkId: string;
  expiresInDays?: number | null;
  note?: string | null;
}

export interface MarkReadinessCheckVerifiedResult {
  ok: boolean;
  checkId: string;
  verifiedAt: string;
  expiresAt: string;
  verifiedBy: string;
}

// -- decision flow tracer types --

export interface DecisionTraceStep {
  stepNumber: number;
  name: string;
  status:
    | 'matched'
    | 'skipped'
    | 'pass-through'
    | 'denied'
    | 'permitted'
    | 'escalated'
    | 'overridden'
    | string;
  inputs: string;
  outputs: string | null;
  detail: string;
}

export interface DecisionTrace {
  findingId: string;
  finding: GovernanceFinding;
  steps: DecisionTraceStep[];
  terminalDecision: string;
  terminalStepNumber: number;
  reasonTokens: string[];
  constitutionalOverride: boolean;
  arbitrationPattern: string | null;
  scopeReduction: string | null;
}

// -- authority graph projections --

export interface AuthorityScope {
  decisionType: string;
  domain: string;
  /** JSON-encoded map. Frontend parses on render. */
  conditions: string;
  /** JSON-encoded map. Frontend parses on render. */
  limits: string;
  specificity: number;
}

export interface AuthorityUnit {
  unitId: string;
  agentId: string;
  scope: AuthorityScope;
  delegationSource: string | null;
  canRedelegate: boolean;
  expiryTimestamp: number | null;
  revoked: boolean;
  riskRating: 'low' | 'medium' | 'high' | string;
  registryId: string | null;
  isValid: boolean;
}

export interface CompositionContract {
  contractId: string;
  partyA: string;
  partyB: string;
  authorityPrecedence: string;
  conflictResolution:
    | 'halt_and_escalate'
    | 'default_deny'
    | 'precedence_resolution'
    | string;
  invariants: string[];
  stopRights: string[];
  scope: AuthorityScope;
  escalationPath: string | null;
}

export interface ListAuthorityUnitsArgs {
  registryId?: string | null;
  includeRevoked?: boolean | null;
}

// -- blast-radius (revoke-impact) types --

export interface RevokeImpactWorkflow {
  workflowId: string;
  permitCount: number;
  lastTimestamp: number;
}

export interface RevokeImpactAgentPair {
  requestingAgent: string;
  targetAgent: string;
  permitCount: number;
}

export interface RevokeImpactReport {
  unitId: string;
  sinceTs: number;
  untilTs: number;
  totalPermits: number;
  distinctWorkflows: number;
  distinctAgentPairs: number;
  workflows: RevokeImpactWorkflow[];
  agentPairs: RevokeImpactAgentPair[];
  truncated: boolean;
}

export interface GetRevokeImpactArgs {
  unitId: string;
  sinceTs?: number | null;
  untilTs?: number | null;
}

// -- constitutional rule tree --

export interface ConstitutionalRule {
  field: string;
  operator: 'eq' | 'neq' | 'exists' | 'not_exists' | 'gt' | 'lt' | string;
  /** JSON-encoded value (frontend parses on render). null when operator is exists/not_exists. */
  value: string | null;
}

export interface ConstitutionalLayer {
  layerId: string;
  layerType: 'global' | 'domain' | 'pairwise' | string;
  appliesTo: string[];
  rules: ConstitutionalRule[];
  parentLayerId: string | null;
}

export interface ConstitutionalRuleOverrideStat {
  layerId: string;
  field: string;
  count7d: number;
  lastFiredAt: number | null;
  firstFiredAt: number | null;
  topAffectedAgents: string[];
}

export interface ConstitutionRuleStatsReport {
  generatedAt: number;
  sinceTs: number;
  untilTs: number;
  totalOverrides: number;
  stats: ConstitutionalRuleOverrideStat[];
  truncated: boolean;
}

export interface GetConstitutionalRuleStatsArgs {
  sinceTs?: number | null;
  untilTs?: number | null;
}

// -- case-law timeline --

/**
 * Encoded resolution of a prior human-adjudicated escalation.
 *
 * Field names mirror the resolver's projection of the
 * `citadel-case-law-{env}` DDB table (see backend resolver
 * `projectCaseLawEntry`). `pattern` and `scopeOfApplicability` are
 * JSON-encoded maps for transport — frontend parses on render.
 * `encodedAt` is normalised to ISO-8601 at the resolver: legacy float
 * (epoch seconds) rows are coerced via `new Date(value * 1000).toISOString()`.
 *
 * `resolution` is one of `permit | deny | escalate | halt`. The
 * resolver coerces unknown values to `'unknown'` (with a warning log)
 * so the frontend can render a degraded badge for writer drift.
 */
export interface CaseLawEntry {
  caseId: string;
  pattern: string;
  resolution: 'permit' | 'deny' | 'escalate' | 'halt' | 'unknown' | string;
  encodedAt: string;
  encodedBy: string;
  scopeOfApplicability: string;
  precedence: number;
  revoked: boolean;
}

export interface ListCaseLawArgs {
  includeRevoked?: boolean | null;
}

/**
 * Acknowledgement text gating the setGovernanceMode mutation. MUST match
 * the backend resolver's MODE_FLIP_ACKNOWLEDGEMENT_TEXT constant verbatim
 * — both the modal and the service call submit this string. Any drift is
 * a contract bug and the resolver will reject the mutation.
 */
export const MODE_FLIP_ACKNOWLEDGEMENT_TEXT =
  'I understand this affects production governance enforcement';

/**
 * Acknowledgement text gating the constitutional rule editor mutations.
 * MUST match the backend resolver's
 * CONSTITUTIONAL_RULE_ACKNOWLEDGEMENT_TEXT constant verbatim — the
 * `contract-constitutional-ack-text.test.ts` drift test enforces this on
 * every CI run. Any change here MUST land in the resolver in the same
 * commit.
 */
export const CONSTITUTIONAL_RULE_ACKNOWLEDGEMENT_TEXT =
  'I understand this changes the constitutional layer used at engine step 8';

/**
 * Acknowledgement text gating the case-law admin mutations
 * (revoke / unrevoke / update-precedence). MUST match the
 * backend resolver's CASELAW_ACKNOWLEDGEMENT_TEXT constant verbatim —
 * the `contract-caselaw-ack-text.test.ts` drift test enforces this on
 * every CI run. Any change here MUST land in the resolver in the same
 * commit.
 */
export const CASELAW_ACKNOWLEDGEMENT_TEXT =
  'I understand this changes the case-law precedent used at engine step 1';

// -- constitutional rule editor types --

export type ConstitutionalOperator =
  | 'eq'
  | 'neq'
  | 'exists'
  | 'not_exists'
  | 'gt'
  | 'lt';

export interface ConstitutionalRuleInput {
  field: string;
  operator: ConstitutionalOperator;
  /** JSON-encoded value (string), or null when operator is exists / not_exists. */
  value: string | null;
}

export interface ConstitutionalRuleMutationResult {
  ok: boolean;
  layerId: string;
  action: 'add' | 'update' | 'delete' | string;
  layer: ConstitutionalLayer;
  emittedEventDetailType: string | null;
}

// -- case-law admin action types --

export type CaseLawMutationAction =
  | 'revoke'
  | 'unrevoke'
  | 'update-precedence';

export interface CaseLawMutationResult {
  ok: boolean;
  caseId: string;
  action: CaseLawMutationAction | string;
  entry: CaseLawEntry;
  emittedEventDetailType: string | null;
}

// -- authority graph history settings --

/**
 * Acknowledgement text gating the authority graph history settings
 * mutation (`updateAuthorityGraphHistorySettings`). MUST
 * match the backend resolver's `AUTHORITY_GRAPH_HISTORY_ACKNOWLEDGEMENT_TEXT`
 * constant verbatim — the `contract-graph-history-ack-text.test.ts`
 * drift test enforces this on every CI run. Any change here MUST land
 * in the resolver in the same commit.
 */
export const AUTHORITY_GRAPH_HISTORY_ACKNOWLEDGEMENT_TEXT =
  'I understand this changes governance history retention and storage costs';

export interface AuthorityGraphHistorySettings {
  enabled: boolean;
  retentionDays: number;
  /**
   * only supports `'daily'`. `'on-change'` and `'both'`
   * are reserved (DDB streams on the source tables)
   * and the resolver rejects them with a forward-compat error.
   */
  captureMode: 'daily' | 'on-change' | 'both' | string;
  lastSnapshotAt: string | null;
  snapshotCountInWindow: number;
  storageEstimate: string;
}

export interface UpdateAuthorityGraphHistorySettingsInput {
  enabled: boolean;
  retentionDays: number;
  captureMode: 'daily' | 'on-change' | 'both';
  reason?: string | null;
}

export interface AuthorityGraphHistorySettingsResult {
  ok: boolean;
  settings: AuthorityGraphHistorySettings;
  emittedEventDetailType: string | null;
}

// -- authority graph history scrubber --

/**
 * Compact summary of a single captured snapshot. Returned by
 * `listAuthorityGraphSnapshots`; the embedded array fields are NOT
 * included in this shape — only their lengths — so the timeline
 * scrubber can render a 365-day index without loading the heavy
 * per-snapshot payload.
 */
export interface AuthorityGraphSnapshotSummary {
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

/**
 * Full per-snapshot projection used by the time scrubber. Contains
 * authorityUnits + compositionContracts ONLY — constitutional layers
 * and case law are intentionally omitted server-side because the graph
 * page does not render them.
 */
export interface AuthorityGraphSnapshot {
  snapshotId: string;
  timestamp: number;
  expiresAt: number;
  kind: string;
  partial: boolean;
  authorityUnits: AuthorityUnit[];
  compositionContracts: CompositionContract[];
}

export interface ListAuthorityGraphSnapshotsArgs {
  sinceTs?: number | null;
  untilTs?: number | null;
}

// -- D4 defense-in-depth retrospective --

/**
 * Counts portion of the D4 retrospective report. `preFilterTotal` /
 * `toolHandlerTotal` are RAW finding counts at each engine scope (one
 * row per matching ledger entry); `distinctPreFilter` /
 * `distinctToolHandler` are the cardinalities of the
 * `(workflow_id, reason)` dedup-key sets; `overlap` is the cardinality
 * of the intersection.
 */
export interface D4RetrospectiveCounts {
  preFilterTotal: number;
  toolHandlerTotal: number;
  distinctPreFilter: number;
  distinctToolHandler: number;
  overlap: number;
}

/**
 * D4 defense-in-depth retrospective report (admin-only).
 *
 * Mirrors `arbiter/governance/d4_retrospective.py` verbatim: the four
 * thresholds (>0.9 → re-debate, <0.2 → keep-both-strong-evidence,
 * `toolHandlerTotal < 1` → deferred-90d, else → keep-both) MUST stay in
 * lock-step with the Python script.
 *
 * `recommendation` is typed loosely as a string union with a fallback
 * `string` so forward-compat additions on the resolver don't break
 * client compilation.
 */
export interface D4RetrospectiveReport {
  generatedAt: number;
  windowStart: number;
  windowEnd: number;
  windowDays: number;
  insufficientEvidence: boolean;
  counts: D4RetrospectiveCounts;
  overlapRatio: number;
  recommendation:
    | 'keep-both'
    | 'keep-both-strong-evidence'
    | 're-debate'
    | 'deferred-90d'
    | string;
  truncated: boolean;
}

// -- IAM trust path types --

/**
 * IAM trust path inline policy statement (admin only).
 *
 * `effect` is loosely typed with a `string` fallback so forward-compat
 * additions don't break client compilation. `conditionsJson` is a
 * stringified JSON blob preserving the original `Condition` shape from
 * the inline policy document; the page pretty-prints it on demand.
 */
export interface TrustPathPolicyStatement {
  effect: 'Allow' | 'Deny' | string;
  actions: string[];
  resources: string[];
  conditionsJson: string | null;
}

/**
 * One hop in the IAM assume chain. `scope` is one of:
 *   - `'lambda'`         — the assumer Lambda execution role
 *   - `'cross-account'`  — optional cross-account role (when the resource
 *                          declares `crossAccountRoleArn`)
 *   - `'datastore' | 'integration' | 'agent'` — the scoped resource role
 *                          (`citadel-{ds,int,agent}-${resourceId}`)
 *
 * `inlinePolicy` is empty + `inlinePolicyName` is null when the role
 * has no inline policy named `DataStoreAccess` (or the call failed).
 * `totalActions` / `totalResources` are convenience aggregates.
 */
export interface TrustPathRole {
  arn: string;
  name: string;
  scope: 'lambda' | 'cross-account' | 'datastore' | 'integration' | 'agent' | string;
  trustPolicyPrincipals: string[];
  inlinePolicy: TrustPathPolicyStatement[];
  inlinePolicyName: string | null;
  totalActions: number;
  totalResources: number;
}

/**
 * IAM trust path report (admin only).
 *
 * `hops` is ordered Lambda → optional cross-account → scoped resource
 * role. Length is 1 (Lambda only) when the resource is missing,
 * 2 (no cross-account), or 3 (with cross-account).
 *
 * `notes` aggregates operational notes — missing resource, unresolved
 * Lambda exec role, missing IAM role, missing inline policy. The page
 * surfaces them in a banner above the canvas.
 */
export interface TrustPathReport {
  resourceType: 'agent' | 'datastore' | 'integration' | string;
  resourceId: string;
  generatedAt: number;
  hops: TrustPathRole[];
  notes: string[];
}

// -- IAM drift report types --

export interface IamDriftActionGroup {
  resourceArnPattern: string;
  declaredActions: string[];
  effectiveActions: string[];
  excessActions: string[];
  missingActions: string[];
}

export interface IamDriftReport {
  resourceType: 'agent' | 'datastore' | 'integration' | string;
  resourceId: string;
  scopedRoleArn: string;
  generatedAt: number;
  hasDrift: boolean;
  totalExcess: number;
  totalMissing: number;
  groups: IamDriftActionGroup[];
  notes: string[];
}

// -- GraphQL query strings (verbatim field names from the contract schema) --

const getGovernanceModeQuery = `
  query GetGovernanceMode {
    getGovernanceMode {
      enforce
      effectiveAt
      env
    }
  }
`;

const listGovernanceFindingsQuery = `
  query ListGovernanceFindings(
    $limit: Int
    $cursor: String
    $decision: String
    $workflowId: String
    $sinceTs: Float
  ) {
    listGovernanceFindings(
      limit: $limit
      cursor: $cursor
      decision: $decision
      workflowId: $workflowId
      sinceTs: $sinceTs
    ) {
      items {
        findingId
        workflowId
        decision
        reason
        requestingAgent
        targetAgent
        scopeEvaluated
        contractEvaluated
        escalationTarget
        residualAuthorityDenial
        timestamp
      }
      nextCursor
    }
  }
`;

const getGovernanceFindingQuery = `
  query GetGovernanceFinding($findingId: String!) {
    getGovernanceFinding(findingId: $findingId) {
      findingId
      workflowId
      decision
      reason
      requestingAgent
      targetAgent
      scopeEvaluated
      contractEvaluated
      escalationTarget
      residualAuthorityDenial
      timestamp
    }
  }
`;

const getReconcilerStatusQuery = `
  query GetReconcilerStatus {
    getReconcilerStatus {
      lastRunAt
      lastRunMode
      classifications {
        inSync
        missing
        stale
        orphan
      }
      totalRecords
    }
  }
`;

const getRolloutReadinessQuery = `
  query GetRolloutReadiness {
    getRolloutReadiness {
      generatedAt
      currentMode
      effectiveAt
      env
      shadowSoakStartedAt
      checks {
        id
        label
        status
        detail
        evidence
        category
      }
      passCount
      failCount
      warnCount
      stubCount
    }
  }
`;

const getMismatchHeatmapQuery = `
  query GetMismatchHeatmap($sinceTs: Float, $untilTs: Float, $bucketSeconds: Int) {
    getMismatchHeatmap(sinceTs: $sinceTs, untilTs: $untilTs, bucketSeconds: $bucketSeconds) {
      generatedAt
      sinceTs
      untilTs
      bucketSeconds
      totalDenials
      totalEscalations
      modeWindows {
        startTs
        endTs
        mode
      }
      buckets {
        bucketStart
        count
        decision
        topReason
      }
    }
  }
`;

const getEscalationMetricSeriesQuery = `
  query GetEscalationMetricSeries($sinceTs: Float, $untilTs: Float, $periodSeconds: Int) {
    getEscalationMetricSeries(sinceTs: $sinceTs, untilTs: $untilTs, periodSeconds: $periodSeconds) {
      namespace
      metric
      statistic
      periodSeconds
      sinceTs
      untilTs
      datapoints {
        timestamp
        value
      }
      total
    }
  }
`;

const setGovernanceModeMutation = `
  mutation SetGovernanceMode($input: SetGovernanceModeInput!) {
    setGovernanceMode(input: $input) {
      ok
      previousMode
      newMode
      effectiveAt
      noop
      emittedEventDetailType
    }
  }
`;

const markReadinessCheckVerifiedMutation = `
  mutation MarkReadinessCheckVerified($input: MarkReadinessCheckVerifiedInput!) {
    markReadinessCheckVerified(input: $input) {
      ok
      checkId
      verifiedAt
      expiresAt
      verifiedBy
    }
  }
`;

const getDecisionTraceQuery = `
  query GetDecisionTrace($findingId: String!) {
    getDecisionTrace(findingId: $findingId) {
      findingId
      finding {
        findingId
        workflowId
        decision
        reason
        requestingAgent
        targetAgent
        scopeEvaluated
        contractEvaluated
        escalationTarget
        residualAuthorityDenial
        timestamp
      }
      steps {
        stepNumber
        name
        status
        inputs
        outputs
        detail
      }
      terminalDecision
      terminalStepNumber
      reasonTokens
      constitutionalOverride
      arbitrationPattern
      scopeReduction
    }
  }
`;

const listAuthorityUnitsQuery = `
  query ListAuthorityUnits($registryId: String, $includeRevoked: Boolean) {
    listAuthorityUnits(registryId: $registryId, includeRevoked: $includeRevoked) {
      unitId
      agentId
      scope {
        decisionType
        domain
        conditions
        limits
        specificity
      }
      delegationSource
      canRedelegate
      expiryTimestamp
      revoked
      riskRating
      registryId
      isValid
    }
  }
`;

const listCompositionContractsQuery = `
  query ListCompositionContracts {
    listCompositionContracts {
      contractId
      partyA
      partyB
      authorityPrecedence
      conflictResolution
      invariants
      stopRights
      scope {
        decisionType
        domain
        conditions
        limits
        specificity
      }
      escalationPath
    }
  }
`;

const getRevokeImpactQuery = `
  query GetRevokeImpact($unitId: String!, $sinceTs: Float, $untilTs: Float) {
    getRevokeImpact(unitId: $unitId, sinceTs: $sinceTs, untilTs: $untilTs) {
      unitId
      sinceTs
      untilTs
      totalPermits
      distinctWorkflows
      distinctAgentPairs
      workflows {
        workflowId
        permitCount
        lastTimestamp
      }
      agentPairs {
        requestingAgent
        targetAgent
        permitCount
      }
      truncated
    }
  }
`;

const listConstitutionalLayersQuery = `
  query ListConstitutionalLayers {
    listConstitutionalLayers {
      layerId
      layerType
      appliesTo
      rules {
        field
        operator
        value
      }
      parentLayerId
    }
  }
`;

const getConstitutionalRuleStatsQuery = `
  query GetConstitutionalRuleStats($sinceTs: Float, $untilTs: Float) {
    getConstitutionalRuleStats(sinceTs: $sinceTs, untilTs: $untilTs) {
      generatedAt
      sinceTs
      untilTs
      totalOverrides
      stats {
        layerId
        field
        count7d
        lastFiredAt
        firstFiredAt
        topAffectedAgents
      }
      truncated
    }
  }
`;

const listCaseLawQuery = `
  query ListCaseLaw($includeRevoked: Boolean) {
    listCaseLaw(includeRevoked: $includeRevoked) {
      caseId
      pattern
      resolution
      encodedAt
      encodedBy
      scopeOfApplicability
      precedence
      revoked
    }
  }
`;

// shared mutation result projection used by add / update /
// delete. The `layer` selection mirrors `listConstitutionalLayersQuery`
// so the page can splice the result directly into its local cache.
const constitutionalRuleMutationFragment = `
  ok
  layerId
  action
  layer {
    layerId
    layerType
    appliesTo
    rules {
      field
      operator
      value
    }
    parentLayerId
  }
  emittedEventDetailType
`;

const addConstitutionalRuleMutation = `
  mutation AddConstitutionalRule($input: AddConstitutionalRuleInput!) {
    addConstitutionalRule(input: $input) {
      ${constitutionalRuleMutationFragment}
    }
  }
`;

const updateConstitutionalRuleMutation = `
  mutation UpdateConstitutionalRule($input: UpdateConstitutionalRuleInput!) {
    updateConstitutionalRule(input: $input) {
      ${constitutionalRuleMutationFragment}
    }
  }
`;

const deleteConstitutionalRuleMutation = `
  mutation DeleteConstitutionalRule($input: DeleteConstitutionalRuleInput!) {
    deleteConstitutionalRule(input: $input) {
      ${constitutionalRuleMutationFragment}
    }
  }
`;

// shared mutation result projection used by revoke /
// unrevoke / updateCaseLawPrecedence. The `entry` selection mirrors
// `listCaseLawQuery` so the page can splice the result directly into
// its local cache.
const caseLawMutationFragment = `
  ok
  caseId
  action
  entry {
    caseId
    pattern
    resolution
    encodedAt
    encodedBy
    scopeOfApplicability
    precedence
    revoked
  }
  emittedEventDetailType
`;

const revokeCaseLawMutation = `
  mutation RevokeCaseLaw($input: RevokeCaseLawInput!) {
    revokeCaseLaw(input: $input) {
      ${caseLawMutationFragment}
    }
  }
`;

const unrevokeCaseLawMutation = `
  mutation UnrevokeCaseLaw($input: UnrevokeCaseLawInput!) {
    unrevokeCaseLaw(input: $input) {
      ${caseLawMutationFragment}
    }
  }
`;

const updateCaseLawPrecedenceMutation = `
  mutation UpdateCaseLawPrecedence($input: UpdateCaseLawPrecedenceInput!) {
    updateCaseLawPrecedence(input: $input) {
      ${caseLawMutationFragment}
    }
  }
`;

// -- authority graph history GraphQL strings --

const authorityGraphHistorySettingsFragment = `
  enabled
  retentionDays
  captureMode
  lastSnapshotAt
  snapshotCountInWindow
  storageEstimate
`;

const getAuthorityGraphHistorySettingsQuery = `
  query GetAuthorityGraphHistorySettings {
    getAuthorityGraphHistorySettings {
      ${authorityGraphHistorySettingsFragment}
    }
  }
`;

const updateAuthorityGraphHistorySettingsMutation = `
  mutation UpdateAuthorityGraphHistorySettings($input: UpdateAuthorityGraphHistorySettingsInput!) {
    updateAuthorityGraphHistorySettings(input: $input) {
      ok
      settings {
        ${authorityGraphHistorySettingsFragment}
      }
      emittedEventDetailType
    }
  }
`;

// -- authority graph history scrubber GraphQL strings --

const listAuthorityGraphSnapshotsQuery = `
  query ListAuthorityGraphSnapshots($sinceTs: Float, $untilTs: Float) {
    listAuthorityGraphSnapshots(sinceTs: $sinceTs, untilTs: $untilTs) {
      snapshotId
      timestamp
      expiresAt
      kind
      partial
      authorityUnitsCount
      compositionContractsCount
      constitutionalLayersCount
      caseLawCount
    }
  }
`;

const getAuthorityGraphSnapshotQuery = `
  query GetAuthorityGraphSnapshot($snapshotId: String!) {
    getAuthorityGraphSnapshot(snapshotId: $snapshotId) {
      snapshotId
      timestamp
      expiresAt
      kind
      partial
      authorityUnits {
        unitId
        agentId
        scope {
          decisionType
          domain
          conditions
          limits
          specificity
        }
        delegationSource
        canRedelegate
        expiryTimestamp
        revoked
        riskRating
        registryId
        isValid
      }
      compositionContracts {
        contractId
        partyA
        partyB
        authorityPrecedence
        conflictResolution
        invariants
        stopRights
        scope {
          decisionType
          domain
          conditions
          limits
          specificity
        }
        escalationPath
      }
    }
  }
`;

// -- D4 retrospective GraphQL strings --

const getD4RetrospectiveReportQuery = `
  query GetD4RetrospectiveReport($windowDays: Int) {
    getD4RetrospectiveReport(windowDays: $windowDays) {
      generatedAt
      windowStart
      windowEnd
      windowDays
      insufficientEvidence
      counts {
        preFilterTotal
        toolHandlerTotal
        distinctPreFilter
        distinctToolHandler
        overlap
      }
      overlapRatio
      recommendation
      truncated
    }
  }
`;

// -- IAM trust path GraphQL string --

const getTrustPathQuery = `
  query GetTrustPath($resourceType: String!, $resourceId: String!) {
    getTrustPath(resourceType: $resourceType, resourceId: $resourceId) {
      resourceType
      resourceId
      generatedAt
      hops {
        arn
        name
        scope
        trustPolicyPrincipals
        inlinePolicy {
          effect
          actions
          resources
          conditionsJson
        }
        inlinePolicyName
        totalActions
        totalResources
      }
      notes
    }
  }
`;

// -- IAM drift report GraphQL string --

const getResourceIamDriftQuery = `
  query GetResourceIamDrift($resourceType: String!, $resourceId: String!) {
    getResourceIamDrift(resourceType: $resourceType, resourceId: $resourceId) {
      resourceType
      resourceId
      scopedRoleArn
      generatedAt
      hasDrift
      totalExcess
      totalMissing
      groups {
        resourceArnPattern
        declaredActions
        effectiveActions
        excessActions
        missingActions
      }
      notes
    }
  }
`;

// -- Service functions --

/**
 * Read the current governance enforcement mode.
 *
 * Per contract (Error handling → Resolver-level errors → exception):
 *   "On any error, return { enforce: 'permissive', effectiveAt: null, env: <env> }
 *    rather than throwing — the badge must never break a page."
 *
 * The resolver enforces this server-side; the service layer also swallows any
 * transport-level error (network, auth, etc.) and falls back so the ModeBadge
 * never crashes the AppHeader.
 */
async function getGovernanceMode(): Promise<GovernanceMode> {
  try {
    const response = await serverService.query<{ getGovernanceMode: GovernanceMode }>(
      getGovernanceModeQuery
    );
    return (
      response.getGovernanceMode || {
        enforce: 'permissive',
        effectiveAt: null,
        env: 'unknown',
      }
    );
  } catch (error) {
    console.warn('getGovernanceMode failed, falling back to permissive:', error);
    return { enforce: 'permissive', effectiveAt: null, env: 'unknown' };
  }
}

/**
 * Paginated list of governance findings.
 *
 * GraphQL errors propagate — the page-level component decides whether to
 * render a fallback (per contract: "Frontend service maps GraphQL errors to
 * thrown Error objects").
 */
async function listGovernanceFindings(
  args: ListFindingsArgs = {}
): Promise<GovernanceFindingConnection> {
  const variables = {
    limit: args.limit ?? null,
    cursor: args.cursor ?? null,
    decision: args.decision ?? null,
    workflowId: args.workflowId ?? null,
    sinceTs: args.sinceTs ?? null,
  };
  const response = await serverService.query<{
    listGovernanceFindings: GovernanceFindingConnection;
  }>(listGovernanceFindingsQuery, variables);
  const conn = response.listGovernanceFindings;
  return {
    items: conn?.items ?? [],
    nextCursor: conn?.nextCursor ?? null,
  };
}

/**
 * Look up a single finding by id. Returns null if not found (per contract:
 * "Returns the finding or null if not found. Does NOT throw on missing.").
 *
 * Other GraphQL errors propagate.
 */
async function getGovernanceFinding(findingId: string): Promise<GovernanceFinding | null> {
  const response = await serverService.query<{
    getGovernanceFinding: GovernanceFinding | null;
  }>(getGovernanceFindingQuery, { findingId });
  return response.getGovernanceFinding ?? null;
}

/**
 * Reconciler status (admin only — auth enforced server-side).
 *
 * GraphQL errors propagate. The page-level component renders the admin gate
 * before invoking this so unauthenticated reads do not even reach the wire.
 */
async function getReconcilerStatus(): Promise<ReconcilerStatus> {
  const response = await serverService.query<{ getReconcilerStatus: ReconcilerStatus }>(
    getReconcilerStatusQuery
  );
  const status = response.getReconcilerStatus;
  // Contract: an empty SSM blob returns the zero-defaults shape; we preserve
  // that here in case the resolver ever returns null for the same reason.
  return (
    status || {
      lastRunAt: null,
      lastRunMode: null,
      classifications: { inSync: 0, missing: 0, stale: 0, orphan: 0 },
      totalRecords: 0,
    }
  );
}

/**
 * Rollout readiness report (admin only — auth enforced server-side).
 *
 * GraphQL errors propagate so the page-level component can render an error
 * card with a retry button. The page renders the admin gate before invoking
 * this so unauthenticated reads do not even reach the wire.
 */
async function getRolloutReadiness(): Promise<RolloutReadinessReport> {
  const response = await serverService.query<{
    getRolloutReadiness: RolloutReadinessReport;
  }>(getRolloutReadinessQuery);
  return response.getRolloutReadiness;
}

/**
 * Mismatch heatmap report (admin only — auth enforced server-side).
 *
 * Used by the heatmap page to surface deny/escalate density
 * during the shadow soak window. GraphQL errors propagate. The page
 * renders the admin gate before invoking this so unauthenticated reads
 * never reach the wire.
 */
async function getMismatchHeatmap(
  args: MismatchHeatmapArgs = {},
): Promise<MismatchHeatmapReport> {
  const variables = {
    sinceTs: args.sinceTs ?? null,
    untilTs: args.untilTs ?? null,
    bucketSeconds: args.bucketSeconds ?? null,
  };
  const response = await serverService.query<{
    getMismatchHeatmap: MismatchHeatmapReport;
  }>(getMismatchHeatmapQuery, variables);
  return response.getMismatchHeatmap;
}

/**
 * Escalation metric series (admin only — auth enforced server-side).
 *
 * Returns the CitadelGovernance/OffFrontierEscalations metric over the
 * requested window so the escalation drill-down can render its
 * trend sparkline. GraphQL errors propagate so the page can surface a
 * clear failure mode rather than rendering a phantom-empty trend.
 */
async function getEscalationMetricSeries(
  args: EscalationMetricArgs = {},
): Promise<MetricSeries> {
  const variables = {
    sinceTs: args.sinceTs ?? null,
    untilTs: args.untilTs ?? null,
    periodSeconds: args.periodSeconds ?? null,
  };
  const response = await serverService.query<{
    getEscalationMetricSeries: MetricSeries;
  }>(getEscalationMetricSeriesQuery, variables);
  return response.getEscalationMetricSeries;
}

/**
 * Mutate the governance enforcement mode (admin-only — auth enforced
 * server-side; the resolver re-checks the admin claim).
 *
 * PRODUCTION-AFFECTING. The acknowledgement string MUST equal
 * MODE_FLIP_ACKNOWLEDGEMENT_TEXT — both the modal and this service submit
 * the same constant; the backend resolver rejects mutations that do not
 * carry the exact verbatim text.
 *
 * Errors propagate as thrown Errors with the original message preserved.
 * Callers (the modal) render the error inline and keep the dialog open so
 * the operator can retry without losing the typed gates.
 */
async function setGovernanceMode(
  input: SetGovernanceModeInput,
): Promise<SetGovernanceModeResult> {
  const variables = {
    input: {
      targetMode: input.targetMode,
      acknowledgement: input.acknowledgement,
      reason: input.reason ?? null,
    },
  };
  const response = await serverService.mutate<{
    setGovernanceMode: SetGovernanceModeResult;
  }>(setGovernanceModeMutation, variables);
  return response.setGovernanceMode;
}

/**
 * Mark a manual readiness check as operator-verified (admin-only — auth
 * enforced server-side; the resolver re-checks the admin claim).
 *
 * Only the 6 manual stub IDs (`tel-1`, `tel-2`, `rb-2`, `own-1`, `own-2`,
 * `own-3`) are accepted; other IDs (including the 5 real checks) throw
 * server-side with a clear allowlist-rejection message.
 *
 * `expiresInDays` is constrained to 1, 3, 7, or 30. Default is 7 when
 * omitted. Errors propagate as thrown Errors so the dialog can render the
 * message inline and keep the form open for retry.
 */
async function markReadinessCheckVerified(
  input: MarkReadinessCheckVerifiedInput,
): Promise<MarkReadinessCheckVerifiedResult> {
  const variables = {
    input: {
      checkId: input.checkId,
      expiresInDays: input.expiresInDays ?? null,
      note: input.note ?? null,
    },
  };
  const response = await serverService.mutate<{
    markReadinessCheckVerified: MarkReadinessCheckVerifiedResult;
  }>(markReadinessCheckVerifiedMutation, variables);
  return response.markReadinessCheckVerified;
}

/**
 * Look up the decision trace for a finding. Returns null when
 * the finding is missing — mirrors getGovernanceFinding's contract: callers
 * render an empty state on null rather than catching an error. Other
 * GraphQL errors propagate so the page can surface a clear failure mode.
 */
async function getDecisionTrace(
  findingId: string,
): Promise<DecisionTrace | null> {
  const response = await serverService.query<{
    getDecisionTrace: DecisionTrace | null;
  }>(getDecisionTraceQuery, { findingId });
  return response.getDecisionTrace ?? null;
}

/**
 * List authority units for the authority graph (admin only).
 *
 * `registryId` filters to units bound to that app or to `'*GLOBAL*'`
 * platform-wide units. Omit to load all units across registries.
 * `includeRevoked` defaults to false; pass true to surface revoked units
 * with their `isValid: false` flag for forensic views.
 *
 * Errors propagate so the page-level component can render an inline
 * error card with retry. The page is admin-gated so unauthenticated reads
 * never reach the wire.
 */
async function listAuthorityUnits(
  args: ListAuthorityUnitsArgs = {},
): Promise<AuthorityUnit[]> {
  const variables = {
    registryId: args.registryId ?? null,
    includeRevoked: args.includeRevoked ?? null,
  };
  const response = await serverService.query<{
    listAuthorityUnits: AuthorityUnit[];
  }>(listAuthorityUnitsQuery, variables);
  return response.listAuthorityUnits ?? [];
}

/**
 * List composition contracts for the authority graph (admin only).
 *
 * No filter args — admin sees every contract across the system. The
 * resolver caches results for 60s, so repeat page loads collapse to a
 * single DDB scan within the window.
 */
async function listCompositionContracts(): Promise<CompositionContract[]> {
  const response = await serverService.query<{
    listCompositionContracts: CompositionContract[];
  }>(listCompositionContractsQuery);
  return response.listCompositionContracts ?? [];
}

/**
 * Get the blast-radius approximation for revoking a specific authority
 * unit (admin only).
 *
 * Returns the count + workflows + agent pairs of permit findings where
 * `scopeEvaluated == unitId` over the requested time window. This is an
 * APPROXIMATION — a true blast radius would require re-running the engine
 * across pending traffic. The side panel surfaces a tooltip explaining
 * the approximation; see `.kiro/specs/governance-ui/waves-2-5-roadmap.md`
 * §4.2 for details.
 *
 * Errors propagate so the page-level component can render an inline
 * error card. The page is admin-gated so unauthenticated reads never
 * reach the wire. Window defaults to the last 1h server-side and is
 * capped at 24h.
 */
async function getRevokeImpact(
  args: GetRevokeImpactArgs,
): Promise<RevokeImpactReport> {
  const variables = {
    unitId: args.unitId,
    sinceTs: args.sinceTs ?? null,
    untilTs: args.untilTs ?? null,
  };
  const response = await serverService.query<{
    getRevokeImpact: RevokeImpactReport;
  }>(getRevokeImpactQuery, variables);
  return response.getRevokeImpact;
}

/**
 * List the constitutional rule layers (admin only).
 *
 * Returns layers sorted pairwise > domain > global with alphabetical
 * tie-break by `layerId` within each type. Each rule's `value` is a
 * JSON-encoded string for transport — callers parse on render. When the
 * operator is `exists` or `not_exists`, `value` is null.
 *
 * Errors propagate so the page-level component can render an inline
 * error card. The page is admin-gated so unauthenticated reads never
 * reach the wire.
 */
async function listConstitutionalLayers(): Promise<ConstitutionalLayer[]> {
  const response = await serverService.query<{
    listConstitutionalLayers: ConstitutionalLayer[];
  }>(listConstitutionalLayersQuery);
  return response.listConstitutionalLayers ?? [];
}

/**
 * Per-rule constitutional override statistics (admin only).
 *
 * Aggregates governance ledger findings whose reason matches
 * `constitutional_review:<layerId>:invariant_violated:<field>` into
 * per-`(layerId, field)` counts + first/last fired timestamps + top-5
 * affected agents. Window defaults to the last 7 days server-side and
 * is capped at 30 days.
 *
 * Errors propagate so the page-level component can render an inline
 * error card.
 */
async function getConstitutionalRuleStats(
  args: GetConstitutionalRuleStatsArgs = {},
): Promise<ConstitutionRuleStatsReport> {
  const variables = {
    sinceTs: args.sinceTs ?? null,
    untilTs: args.untilTs ?? null,
  };
  const response = await serverService.query<{
    getConstitutionalRuleStats: ConstitutionRuleStatsReport;
  }>(getConstitutionalRuleStatsQuery, variables);
  return response.getConstitutionalRuleStats;
}

/**
 * List the case-law timeline (admin only).
 *
 * Returns entries sorted by precedence DESC, with `encodedAt` DESC as
 * a tie-breaker. `pattern` and `scopeOfApplicability` are JSON-encoded
 * for transport — callers parse on render. Revoked rows are filtered
 * out by default; pass `{ includeRevoked: true }` to surface them
 * with `revoked: true` for audit visibility.
 *
 * Encode/revoke admin actions ship; this is a read-only
 * page. Errors propagate so the page-level component can render an
 * inline error card. The page is admin-gated so unauthenticated reads
 * never reach the wire.
 */
async function listCaseLaw(
  args: ListCaseLawArgs = {},
): Promise<CaseLawEntry[]> {
  const variables = {
    includeRevoked: args.includeRevoked ?? null,
  };
  const response = await serverService.query<{
    listCaseLaw: CaseLawEntry[];
  }>(listCaseLawQuery, variables);
  return response.listCaseLaw ?? [];
}

// -- constitutional rule editor mutations --

/**
 * Append a new rule to the named constitutional layer (admin-only).
 *
 * The acknowledgement constant is auto-injected from
 * `CONSTITUTIONAL_RULE_ACKNOWLEDGEMENT_TEXT` so callers cannot bypass
 * the gate by submitting a different string. Errors propagate so the
 * dialog can render an inline error and keep the form open for retry.
 *
 * `rule.value` MUST be a JSON-encoded string for non-exists operators
 * (the resolver re-parses it before storing). For `exists` /
 * `not_exists`, pass `value: null`.
 */
async function addConstitutionalRule(
  layerId: string,
  rule: ConstitutionalRuleInput,
): Promise<ConstitutionalRuleMutationResult> {
  const variables = {
    input: {
      layerId,
      rule,
      acknowledgement: CONSTITUTIONAL_RULE_ACKNOWLEDGEMENT_TEXT,
    },
  };
  const response = await serverService.mutate<{
    addConstitutionalRule: ConstitutionalRuleMutationResult;
  }>(addConstitutionalRuleMutation, variables);
  return response.addConstitutionalRule;
}

/**
 * Replace an existing rule in the named constitutional layer (admin-only).
 *
 * `ruleIndex` is the 0-based index of the rule in the layer's rules
 * array as projected by `listConstitutionalLayers`. Out-of-range
 * indices throw with a clear error so the dialog can surface the
 * cause inline.
 */
async function updateConstitutionalRule(
  layerId: string,
  ruleIndex: number,
  newRule: ConstitutionalRuleInput,
): Promise<ConstitutionalRuleMutationResult> {
  const variables = {
    input: {
      layerId,
      ruleIndex,
      newRule,
      acknowledgement: CONSTITUTIONAL_RULE_ACKNOWLEDGEMENT_TEXT,
    },
  };
  const response = await serverService.mutate<{
    updateConstitutionalRule: ConstitutionalRuleMutationResult;
  }>(updateConstitutionalRuleMutation, variables);
  return response.updateConstitutionalRule;
}

/**
 * Remove an existing rule from the named constitutional layer (admin-only).
 *
 * `ruleIndex` is the 0-based index of the rule in the layer's rules
 * array as projected by `listConstitutionalLayers`. The dialog gates
 * this behind a typed-match `DELETE` confirmation; the resolver
 * additionally re-checks the acknowledgement string.
 */
async function deleteConstitutionalRule(
  layerId: string,
  ruleIndex: number,
): Promise<ConstitutionalRuleMutationResult> {
  const variables = {
    input: {
      layerId,
      ruleIndex,
      acknowledgement: CONSTITUTIONAL_RULE_ACKNOWLEDGEMENT_TEXT,
    },
  };
  const response = await serverService.mutate<{
    deleteConstitutionalRule: ConstitutionalRuleMutationResult;
  }>(deleteConstitutionalRuleMutation, variables);
  return response.deleteConstitutionalRule;
}

// -- case-law admin actions --

/**
 * Revoke a case-law entry (admin-only — auth enforced server-side; the
 * resolver re-checks the admin claim).
 *
 * Soft-delete via `revoked: true` mirrors `case_law_admin.py` semantics
 * — the row stays for audit visibility but the engine filters it out
 * at load time. The mutation is idempotent: calling on an already-
 * revoked row no-ops with `emittedEventDetailType: null`.
 *
 * The acknowledgement constant is auto-injected from
 * `CASELAW_ACKNOWLEDGEMENT_TEXT` so callers cannot bypass the gate by
 * submitting a different string. Errors propagate so the dialog can
 * render an inline error and keep the form open for retry.
 */
async function revokeCaseLaw(
  caseId: string,
  reason?: string | null,
): Promise<CaseLawMutationResult> {
  const variables = {
    input: {
      caseId,
      acknowledgement: CASELAW_ACKNOWLEDGEMENT_TEXT,
      reason: reason ?? null,
    },
  };
  const response = await serverService.mutate<{
    revokeCaseLaw: CaseLawMutationResult;
  }>(revokeCaseLawMutation, variables);
  return response.revokeCaseLaw;
}

/**
 * Restore a previously-revoked case-law entry (admin-only). Symmetric
 * to `revokeCaseLaw` — calling on a not-revoked row no-ops with
 * `emittedEventDetailType: null`. Errors propagate.
 */
async function unrevokeCaseLaw(
  caseId: string,
  reason?: string | null,
): Promise<CaseLawMutationResult> {
  const variables = {
    input: {
      caseId,
      acknowledgement: CASELAW_ACKNOWLEDGEMENT_TEXT,
      reason: reason ?? null,
    },
  };
  const response = await serverService.mutate<{
    unrevokeCaseLaw: CaseLawMutationResult;
  }>(unrevokeCaseLawMutation, variables);
  return response.unrevokeCaseLaw;
}

/**
 * Change the precedence of a case-law entry (admin-only). `newPrecedence`
 * MUST be a finite integer in the range [-1000, 1000]; the resolver
 * rejects out-of-range values before any DDB write. Same-value writes
 * no-op with `emittedEventDetailType: null`. Errors propagate.
 */
async function updateCaseLawPrecedence(
  caseId: string,
  newPrecedence: number,
  reason?: string | null,
): Promise<CaseLawMutationResult> {
  const variables = {
    input: {
      caseId,
      newPrecedence,
      acknowledgement: CASELAW_ACKNOWLEDGEMENT_TEXT,
      reason: reason ?? null,
    },
  };
  const response = await serverService.mutate<{
    updateCaseLawPrecedence: CaseLawMutationResult;
  }>(updateCaseLawPrecedenceMutation, variables);
  return response.updateCaseLawPrecedence;
}

// -- authority graph history settings --

/**
 * Read the authority graph history settings (admin only).
 *
 * Returns the SSM-backed config + a snapshot count + last-snapshot ISO
 * timestamp + a human-readable storage estimate. The resolver returns
 * safe defaults (`enabled: false`, `retentionDays: 30`,
 * `captureMode: 'daily'`) on first read before the SSM parameter is
 * provisioned, so callers can render the settings card without a
 * fallback path.
 *
 * Errors propagate so the page-level component can render an inline
 * error card. The page is admin-gated so unauthenticated reads never
 * reach the wire.
 */
async function getAuthorityGraphHistorySettings(): Promise<AuthorityGraphHistorySettings> {
  const response = await serverService.query<{
    getAuthorityGraphHistorySettings: AuthorityGraphHistorySettings;
  }>(getAuthorityGraphHistorySettingsQuery);
  return response.getAuthorityGraphHistorySettings;
}

/**
 * Update the authority graph history settings (admin only).
 *
 * The acknowledgement constant is auto-injected from
 * `AUTHORITY_GRAPH_HISTORY_ACKNOWLEDGEMENT_TEXT` so callers cannot
 * bypass the gate by submitting a different string. Errors propagate
 * so the dialog can render an inline error and keep the form open for
 * retry.
 *
 * captureMode supports 'daily', 'on-change', and 'both'. The two
 * snapshot Lambdas gate themselves on the value: scheduled runs on
 * {daily, both}, stream-driven runs on {on-change, both}.
 */
async function updateAuthorityGraphHistorySettings(
  input: UpdateAuthorityGraphHistorySettingsInput,
): Promise<AuthorityGraphHistorySettingsResult> {
  const variables = {
    input: {
      enabled: input.enabled,
      retentionDays: input.retentionDays,
      captureMode: input.captureMode,
      acknowledgement: AUTHORITY_GRAPH_HISTORY_ACKNOWLEDGEMENT_TEXT,
      reason: input.reason ?? null,
    },
  };
  const response = await serverService.mutate<{
    updateAuthorityGraphHistorySettings: AuthorityGraphHistorySettingsResult;
  }>(updateAuthorityGraphHistorySettingsMutation, variables);
  return response.updateAuthorityGraphHistorySettings;
}

// -- authority graph history scrubber --

/**
 * List authority graph snapshot summaries for the time scrubber
 * (admin only).
 *
 * Returns lightweight summaries (counts, no embedded arrays) sorted
 * ascending by timestamp. Window defaults to the last 365 days
 * server-side and is capped at 365 days. Result is capped at 500
 * entries; one year of daily snapshots is 365, so the cap is a
 * safety margin rather than a real ceiling.
 *
 * Errors propagate so the page-level component can render an inline
 * error card. The page is admin-gated so unauthenticated reads never
 * reach the wire.
 */
async function listAuthorityGraphSnapshots(
  args: ListAuthorityGraphSnapshotsArgs = {},
): Promise<AuthorityGraphSnapshotSummary[]> {
  const variables = {
    sinceTs: args.sinceTs ?? null,
    untilTs: args.untilTs ?? null,
  };
  const response = await serverService.query<{
    listAuthorityGraphSnapshots: AuthorityGraphSnapshotSummary[];
  }>(listAuthorityGraphSnapshotsQuery, variables);
  return response.listAuthorityGraphSnapshots ?? [];
}

/**
 * Fetch a single authority graph snapshot by id (—
 * admin only). Returns null when the snapshot is missing — mirrors
 * `getGovernanceFinding`'s contract: callers render an empty state
 * on null rather than catching an error.
 *
 * The response includes `authorityUnits` + `compositionContracts`
 * only; constitutional layers + case law are intentionally omitted
 * server-side because the graph page does not render them. The
 * snapshot's `isValid` for each unit is computed against the
 * SNAPSHOT's `timestamp`, not `Date.now()`, so historical replay
 * surfaces units that were valid at capture time even if they
 * expired afterwards.
 */
async function getAuthorityGraphSnapshot(
  snapshotId: string,
): Promise<AuthorityGraphSnapshot | null> {
  const response = await serverService.query<{
    getAuthorityGraphSnapshot: AuthorityGraphSnapshot | null;
  }>(getAuthorityGraphSnapshotQuery, { snapshotId });
  return response.getAuthorityGraphSnapshot ?? null;
}

// -- D4 defense-in-depth retrospective --

/**
 * Fetch the D4 retrospective report (admin only).
 *
 * `windowDays` is one of {7, 14, 30, 60, 90}; passing any other value
 * causes the resolver to throw. Defaults to 30 server-side when
 * omitted. Errors propagate so the page can render an inline error
 * card; the resolver enforces the admin gate, so non-admin callers
 * receive a `Forbidden: admin required` error which the page surfaces
 * verbatim.
 *
 * The resolver caches successful reports for 5 minutes keyed on
 * `windowDays`, so a UI-level "refresh" button that doesn't advance
 * the window will see the cached value within that TTL — this is
 * intentional: the underlying ledger scan is expensive and the
 * retrospective is by design a slow-moving signal.
 */
async function getD4RetrospectiveReport(
  windowDays?: number | null,
): Promise<D4RetrospectiveReport> {
  const variables = {
    windowDays: windowDays ?? null,
  };
  const response = await serverService.query<{
    getD4RetrospectiveReport: D4RetrospectiveReport;
  }>(getD4RetrospectiveReportQuery, variables);
  return response.getD4RetrospectiveReport;
}

// -- IAM trust path --

/**
 * Fetch the IAM trust path report for a target resource (—
 * admin only).
 *
 * `resourceType` must be one of `'agent' | 'datastore' | 'integration'`;
 * other values cause the resolver to throw. `resourceId` is non-empty
 * and length-capped at 256 chars server-side. Errors propagate so the
 * page renders an inline error card; the resolver enforces the admin
 * gate, so non-admin callers receive a `Forbidden: admin required`
 * error which the page surfaces verbatim.
 *
 * The resolver caches successful reports for 5 minutes keyed on the
 * `(resourceType, resourceId, accountId)` tuple — repeated page
 * navigations within that window avoid hammering IAM.
 */
async function getTrustPath(
  resourceType: string,
  resourceId: string,
): Promise<TrustPathReport> {
  const variables = { resourceType, resourceId };
  const response = await serverService.query<{
    getTrustPath: TrustPathReport;
  }>(getTrustPathQuery, variables);
  return response.getTrustPath;
}

// -- IAM drift report --

/**
 * Fetch the IAM drift report for a target resource (admin
 * only).
 *
 * `resourceType` must be one of `'agent' | 'datastore' | 'integration'`;
 * other values cause the resolver to throw. `resourceId` is non-empty
 * and length-capped at 256 chars server-side. Errors propagate so the
 * page renders an inline error card; the resolver enforces the admin
 * gate, so non-admin callers receive a `Forbidden: admin required`
 * error which the page surfaces verbatim.
 *
 * The resolver caches successful reports for 5 minutes keyed on the
 * `(resourceType, resourceId, accountId)` tuple — repeated page
 * navigations within that window avoid hammering IAM.
 */
async function getResourceIamDrift(
  resourceType: string,
  resourceId: string,
): Promise<IamDriftReport> {
  const variables = { resourceType, resourceId };
  const response = await serverService.query<{
    getResourceIamDrift: IamDriftReport;
  }>(getResourceIamDriftQuery, variables);
  return response.getResourceIamDrift;
}

// -- live tail subscription --

/**
 * Optional client-side filter for the live tail subscription.
 *
 * `decision` matches the `onGovernanceFinding(decision: String)` argument on
 * the GraphQL subscription. AppSync filters server-side when the argument is
 * provided, reducing payload volume to admins watching a specific decision
 * stream (e.g. only `deny` or `escalate`).
 */
export interface GovernanceFindingSubscriptionFilter {
  decision?: string | null;
}

const onGovernanceFindingSubscription = `
  subscription OnGovernanceFinding($decision: String) {
    onGovernanceFinding(decision: $decision) {
      findingId
      workflowId
      decision
      reason
      requestingAgent
      targetAgent
      scopeEvaluated
      contractEvaluated
      escalationTarget
      residualAuthorityDenial
      timestamp
    }
  }
`;

/**
 * Subscribe to the live governance-finding stream.
 *
 * Returns an unsubscribe function. The callback receives one
 * `GovernanceFinding` per published mutation; AppSync drops the connection
 * for non-admin Cognito tokens at CONNECT time (the directive on the
 * subscription field requires the `admin` group).
 *
 * Mirrors the pattern used by `useExecutionSubscription`: a thin wrapper
 * around `serverService.subscribe(query, variables, callback)` that closes
 * over the parsed payload shape so callers don't deal with the GraphQL
 * envelope. Errors are forwarded through `onError` (when supplied) so the
 * page-level hook can render a banner and decide whether to retry.
 */
export function subscribeGovernanceFindings(
  onFinding: (finding: GovernanceFinding) => void,
  filter?: GovernanceFindingSubscriptionFilter,
  onError?: (err: unknown) => void,
): () => void {
  const variables = { decision: filter?.decision ?? null };
  const unsubscribe = serverService.subscribe(
    onGovernanceFindingSubscription,
    variables,
    (data: unknown) => {
      try {
        const payload = (data as { onGovernanceFinding?: GovernanceFinding } | null)
          ?.onGovernanceFinding;
        if (payload) onFinding(payload);
      } catch (err) {
        onError?.(err);
      }
    },
  );
  return unsubscribe;
}

export const governanceService = {
  getGovernanceMode,
  listGovernanceFindings,
  getGovernanceFinding,
  getReconcilerStatus,
  getRolloutReadiness,
  getMismatchHeatmap,
  getEscalationMetricSeries,
  setGovernanceMode,
  markReadinessCheckVerified,
  getDecisionTrace,
  subscribeGovernanceFindings,
  listAuthorityUnits,
  listCompositionContracts,
  getRevokeImpact,
  listConstitutionalLayers,
  getConstitutionalRuleStats,
  listCaseLaw,
  addConstitutionalRule,
  updateConstitutionalRule,
  deleteConstitutionalRule,
  revokeCaseLaw,
  unrevokeCaseLaw,
  updateCaseLawPrecedence,
  getAuthorityGraphHistorySettings,
  updateAuthorityGraphHistorySettings,
  listAuthorityGraphSnapshots,
  getAuthorityGraphSnapshot,
  getD4RetrospectiveReport,
  getTrustPath,
  getResourceIamDrift,
};

export default governanceService;
