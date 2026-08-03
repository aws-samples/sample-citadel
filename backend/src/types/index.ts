export interface Project {
  id: string;
  name: string;
  status: ProjectStatus;
  currentModule: Module;
  progress: ProjectProgress;
  createdAt: string;
  updatedAt: string;
  owner: string;
  description?: string;
  requirements?: string;
  agents?: AgentStatus[];
  // governance archetype classification.
  // archetypeStatus defaults to PENDING when absent; the resolver normalises
  // missing values on read so grandfathered DDB rows appear consistent.
  archetype?: GovernanceArchetype;
  archetypeConfidence?: number;
  archetypeStatus?: ProjectArchetypeStatus;
}

export interface Module {
  id: string;
  name: string;
  description: string;
  status: ModuleStatus;
  agentId: string;
}

export interface ProjectProgress {
  overall: number;
  assessment: number;
  design: number;
  planning: number;
  implementation: number;
  currentPhase: string;
  estimatedCompletion?: string;
}

export interface AgentStatus {
  agentId: string;
  projectId: string;
  status: AgentStatusEnum;
  currentTask?: string;
  progress?: number;
  lastUpdate: string;
  metadata?: Record<string, unknown>;
  errorMessage?: string;
}

export interface ConversationMessage {
  id: string;
  projectId: string;
  agentId: string;
  message: string;
  messageType: MessageType;
  timestamp: string;
  metadata?: Record<string, unknown>;
  correlationId?: string;
}

export interface DocumentUploadResult {
  success: boolean;
  documentId?: string;
  url?: string;
  message: string;
}

export interface ProjectConnection {
  items: Project[];
  nextToken?: string;
}

export interface ProjectFilter {
  status?: ProjectStatus;
  owner?: string;
  createdAfter?: string;
  createdBefore?: string;
}

export interface CreateProjectInput {
  name: string;
  description?: string;
  requirements?: string;
}

export interface UpdateProjectInput {
  name?: string;
  description?: string;
  requirements?: string;
  status?: ProjectStatus;
  // governance archetype fields — all nullable for partial updates.
  archetype?: GovernanceArchetype;
  archetypeConfidence?: number;
  archetypeStatus?: ProjectArchetypeStatus;
}

export interface AgentStatusInput {
  status: AgentStatusEnum;
  currentTask?: string;
  progress?: number;
  metadata?: Record<string, unknown>;
  errorMessage?: string;
}

export interface ProjectProgressInput {
  overall?: number;
  assessment?: number;
  design?: number;
  planning?: number;
  implementation?: number;
  currentPhase?: string;
  estimatedCompletion?: string;
}

export interface ConversationMessageInput {
  agentId: string;
  message: string;
  messageType: MessageType;
  metadata?: Record<string, unknown>;
  correlationId?: string;
}

export interface S3Object {
  bucket: string;
  key: string;
  region: string;
}

export enum ProjectStatus {
  CREATED = "CREATED",
  IN_PROGRESS = "IN_PROGRESS",
  ASSESSMENT_COMPLETE = "ASSESSMENT_COMPLETE",
  DESIGN_COMPLETE = "DESIGN_COMPLETE",
  PLANNING_COMPLETE = "PLANNING_COMPLETE",
  IMPLEMENTATION_READY = "IMPLEMENTATION_READY",
  COMPLETED = "COMPLETED",
  ERROR = "ERROR",
}

// governance archetype classification — frozen at three values
// per QT2A-8 (no OTHER escape hatch; ambiguous projects use archetypeStatus
// PENDING_ESCALATION instead).
export enum GovernanceArchetype {
  MONOLITHIC_DB = "MONOLITHIC_DB",
  ENTERPRISE_APP_SPRAWL = "ENTERPRISE_APP_SPRAWL",
  HYBRID_IT_OT = "HYBRID_IT_OT",
}

export enum ProjectArchetypeStatus {
  PENDING = "PENDING",
  CLASSIFIED = "CLASSIFIED",
  PENDING_ESCALATION = "PENDING_ESCALATION",
}

// AgentDesignAssessment entity — four-dimension complexity
// ranking per PLAN_GOV_FUTURE_STATE.md §3.1. dimensionRanking is always 4
// entries with ranks forming exactly the set {1,2,3,4} (validated at the
// resolver). FourDimension values frozen at four per QT2A-8 sibling rule.
export type FourDimensionLiteral =
  "CODE" | "DATA" | "INTEGRATION" | "INFRASTRUCTURE";

export enum FourDimension {
  CODE = "CODE",
  DATA = "DATA",
  INTEGRATION = "INTEGRATION",
  INFRASTRUCTURE = "INFRASTRUCTURE",
}

export interface DimensionComplexity {
  dimension: FourDimensionLiteral;
  rank: number;
  rationale: string;
}

export interface DimensionComplexityInput {
  dimension: FourDimensionLiteral;
  rank: number;
  rationale: string;
}

export interface AgentDesignAssessment {
  projectId: string;
  archetype: GovernanceArchetype | null;
  archetypeConfidence: number | null;
  archetypeStatus: ProjectArchetypeStatus;
  dimensionRanking: DimensionComplexity[];
  accessibleDataSources: string[];
  primaryRiskAreas: string[];
  completedAt: string | null;
  completedBy: string | null;
  createdAt: string;
  updatedAt: string;
}

export interface SubmitAgentDesignAssessmentInput {
  projectId: string;
  archetype: GovernanceArchetype;
  archetypeConfidence?: number;
  dimensionRanking: DimensionComplexityInput[];
  accessibleDataSources: string[];
  primaryRiskAreas: string[];
}

// ADR (Architecture Decision Record) governance entity.
// Matrix locked by QT3-5 in.kiro/planning/PLAN_GOV_DIFF.md §9.
export enum ADRStatus {
  PROPOSED = "PROPOSED",
  LOCKED = "LOCKED",
  SUPERSEDED = "SUPERSEDED",
  REOPENED = "REOPENED",
}

export enum ADRSeverity {
  LOW = "LOW",
  MEDIUM = "MEDIUM",
  HIGH = "HIGH",
  CRITICAL = "CRITICAL",
}

export interface ADR {
  adrId: string;
  projectId: string;
  title: string;
  decision: string;
  reasoning: string;
  constraints: string[];
  alternativesConsidered: string[];
  revisitConditions: string[];
  status: ADRStatus;
  severity?: ADRSeverity;
  affectsModules?: string[];
  reviewers?: string[];
  version: number;
  createdAt: string;
  createdBy: string;
  lockedAt?: string;
  supersededBy?: string;
  sourceRoundIds: string[];
}

export interface ADRInput {
  projectId: string;
  title: string;
  decision: string;
  reasoning: string;
  constraints: string[];
  alternativesConsidered: string[];
  revisitConditions: string[];
  severity?: ADRSeverity;
  affectsModules?: string[];
  reviewers?: string[];
  sourceRoundIds: string[];
}

// ADR re-open audit trail (QT2A-7 + QT3-3).
// The authResult lifecycle is PENDING (row inserted before the Cognito
// permission check) → ALLOWED | DENIED (after the check). transitionError
// is populated only when authResult=ALLOWED but LifecycleManager rejected
// the LOCKED→REOPENED transition; on DENIED and on success it stays unset.
export type AuthResultLiteral = "PENDING" | "ALLOWED" | "DENIED";

export interface ADRReopenAttempt {
  attemptId: string;
  adrId: string;
  projectId: string;
  attemptedBy: string;
  attemptedAt: string;
  proposedChange: string;
  revisitConditionMatched: boolean;
  reason: string;
  authResult: AuthResultLiteral;
  // Populated when auth was ALLOWED but the lifecycle transition then failed.
  // Empty on success and on DENIED.
  transitionError?: string;
}

export enum ModuleStatus {
  PENDING = "PENDING",
  IN_PROGRESS = "IN_PROGRESS",
  COMPLETED = "COMPLETED",
  ERROR = "ERROR",
}

export enum AgentStatusEnum {
  IDLE = "IDLE",
  PROCESSING = "PROCESSING",
  WAITING_FOR_INPUT = "WAITING_FOR_INPUT",
  COMPLETED = "COMPLETED",
  ERROR = "ERROR",
}

export enum MessageType {
  USER_INPUT = "USER_INPUT",
  AGENT_RESPONSE = "AGENT_RESPONSE",
  SYSTEM_NOTIFICATION = "SYSTEM_NOTIFICATION",
  PROGRESS_UPDATE = "PROGRESS_UPDATE",
}

// Event types for EventBridge integration
export interface AgentEvent {
  eventType: string;
  projectId: string;
  agentId?: string;
  payload: unknown;
  timestamp: string;
  correlationId?: string;
}

// Authorization context
export interface AuthContext {
  userId: string;
  username?: string;
  groups?: string[];
  roles?: string[];
}

// Identity payload shape observed by the governance resolvers. Depending on
// the AppSync auth mode, the role/group claims appear either at the top
// level or nested under `claims`, so both locations are modelled.
export interface GovernanceEventIdentity {
  sub?: string;
  username?: string;
  "custom:role"?: string;
  "cognito:groups"?: string[];
  claims?: { "custom:role"?: string; [claim: string]: unknown };
}

// Minimal AppSync event shape shared by the governance resolvers (ADR,
// ExecutionSpecification, InterrogationRound, AgentDesignAssessment,
// ProgramReview). TArgs is the resolver-specific merged arguments view.
export interface GovernanceResolverEvent<TArgs = Record<string, unknown>> {
  info?: { fieldName?: string };
  identity?: GovernanceEventIdentity;
  arguments: TArgs;
}

// Service layer integration types
export interface ServiceLayerRequest {
  agentId: string;
  projectId: string;
  action: string;
  payload: unknown;
  correlationId: string;
}

export interface ServiceLayerResponse {
  success: boolean;
  data?: unknown;
  error?: string;
  correlationId: string;
}

// ExecutionSpecification
export type SpecStatusLiteral =
  "DRAFT" | "PENDING_REVIEW" | "APPROVED" | "REJECTED";

export interface ExecutionSpecification {
  specId: string;
  projectId: string;
  sourceAdrIds: string[];
  structuredPayload: string; // AWSJSON — string-encoded
  narrativeS3Uri: string;
  status: SpecStatusLiteral;
  version: number;
  createdAt: string;
  createdBy: string;
  submittedAt?: string;
  approvedAt?: string;
  approvedBy?: string;
  rejectedAt?: string;
  rejectedBy?: string;
  rejectionReason?: string;
}

export interface ExecutionSpecificationInput {
  projectId: string;
  sourceAdrIds: string[];
  structuredPayload: string;
  narrativeS3Uri: string;
}

export interface ReviseExecutionSpecificationInput {
  structuredPayload: string;
  narrativeS3Uri: string;
}

// EvalSuite / EvalCase (CIT-101 — Evaluation Domain Model + Versioned Suites)
//
// Eval suites are release evidence, governed exactly like
// ExecutionSpecifications: RETAIN + deletionProtection tables, lifecycle-
// gated, optimistically locked. See backend/src/adapters/lifecycle.ts
// EVALSUITE_TRANSITIONS and backend/src/lambda/eval-resolver.ts.
export type EvalSuiteStatusLiteral = "DRAFT" | "FROZEN" | "ARCHIVED";

export interface EvalSuite {
  suiteId: string;
  orgId: string;
  agentTargetId: string;
  name: string;
  description: string;
  semver: string;
  status: EvalSuiteStatusLiteral;
  version: number;
  references: string[];
  parentSuiteId?: string | null;
  frozenAt?: string;
  frozenBy?: string;
  approvedAt?: string;
  approvedBy?: string;
  createdAt: string;
  createdBy: string;
  updatedAt: string;
}

export interface EvalSuiteInput {
  orgId: string;
  agentTargetId: string;
  name: string;
  description: string;
  semver: string;
}

export type EvalCaseKindLiteral = "CONVERSATION" | "EXECUTION";

export interface EvalCaseInputPayload {
  prompt?: string | null;
  transcript?: TranscriptMessage[] | null;
  structuredInput?: string | null; // AWSJSON — string-encoded; null when unavailable (execution-kind honest limitation)
}

export type MatchSpecMode = "EXACT" | "CONTAINS" | "REGEX" | "JSON_SUBSET";

export interface MatchSpec {
  mode: MatchSpecMode;
  target: string; // AWSJSON — string-encoded when target is structured
  path?: string;
}

export type PolicyDecisionLiteral = "PERMIT" | "DENY" | "ESCALATE";

export interface ExpectedPolicyOutcome {
  decision: PolicyDecisionLiteral;
  findingTypes: string[];
  minSeverity?: string;
}

export interface GroundingRequirement {
  sourceUri?: string;
  mustCiteAnyOf: string[];
  mustNotHallucinate: boolean;
}

export type EvalCaseProvenanceSourceLiteral =
  "AUTHORED" | "IMPORTED_FROM_REPLAY";

export interface EvalCaseProvenance {
  source: EvalCaseProvenanceSourceLiteral;
  packageHash?: string;
  producerCommit: string | null;
  correlationId?: string;
  importedAt?: string;
  /** Set true when the source replay package's toolResults.partial === true. */
  toolResultsPartial?: boolean;
  /** Honest v1 limitation note — set for execution-kind imports (nodes[].inputs unavailable). */
  note?: string;
}

export interface EvalCase {
  suiteId: string;
  caseId: string;
  name: string;
  description: string;
  kind: EvalCaseKindLiteral;
  input: EvalCaseInputPayload;
  expectedOutcome: MatchSpec;
  requiredTools: string[];
  forbiddenTools: string[];
  expectedPolicyOutcome?: ExpectedPolicyOutcome;
  groundingRequirements?: GroundingRequirement[];
  maxLatencyMs?: number;
  maxCostUsd?: number;
  provenance: EvalCaseProvenance;
  version: number;
  createdAt: string;
  createdBy: string;
  updatedAt: string;
}

export interface EvalCaseInput {
  name: string;
  description: string;
  kind: EvalCaseKindLiteral;
  input: EvalCaseInputPayload;
  expectedOutcome: MatchSpec;
  requiredTools?: string[];
  forbiddenTools?: string[];
  expectedPolicyOutcome?: ExpectedPolicyOutcome;
  groundingRequirements?: GroundingRequirement[];
  maxLatencyMs?: number;
  maxCostUsd?: number;
}

// EvalRun / EvalRunCaseResult (CIT-102 — Eval Runner)
//
// FROZEN CROSS-LANGUAGE CONTRACT (Pass A -> Pass B), verbatim per architect
// design §9: execution/dispatch detail additive keys `evalRunId: string`,
// `evalContext: true`, `forbiddenTools: string[]`; governance finding field
// `eval_run_id` (Python dataclass) <-> `evalRunId` (DDB/event alias).
export type EvalRunStatusLiteral =
  "PENDING" | "RUNNING" | "COMPLETED" | "FAILED" | "CANCELLED";

export type EvalRunCaseStatusLiteral =
  "PENDING" | "DISPATCHED" | "RUNNING" | "COMPLETED" | "FAILED" | "TIMEOUT";

export interface EvalRun {
  evalRunId: string;
  orgId: string;
  suiteId: string;
  suiteVersion: number;
  agentTargetId: string;
  agentTargetVersion: string;
  status: EvalRunStatusLiteral;
  caseCount: number;
  pendingCases: number;
  startedAt: string;
  startedBy: string;
  completedAt?: string;
  durationMs?: number;
  idempotencyKey: string;
  evalScopedRoleArn?: string;
  error?: string;
}

export interface StartEvalRunInput {
  suiteId: string;
  agentTargetId: string;
  agentTargetVersion: string;
  idempotencyKey: string;
}

export interface EvalRunCaseResult {
  evalRunId: string;
  caseId: string;
  orgId: string;
  caseKind: EvalCaseKindLiteral;
  targetAdapter: "execution" | "conversation";
  status: EvalRunCaseStatusLiteral;
  executionId?: string;
  conversationId?: string;
  /** Per-case minted correlation id (mintRunId()) — distinct from evalRunId. */
  runId?: string;
  dispatchedAt?: string;
  startedAt?: string;
  completedAt?: string;
  deadlineAt?: string;
  latencyMs?: number;
  artifactKind?: "execution" | "conversation";
  artifactRef?: string;
  error?: string;
  timedOut?: boolean;
  /** Guards the atomic pendingCases decrement against duplicate completion events. */
  completionRecorded?: boolean;
}

// InterrogationRound
export type RoundStatusLiteral =
  "IN_PROGRESS" | "AWAITING_CONSTRAINTS" | "REVISED" | "STABILISED";

export interface TranscriptMessage {
  role: string;
  content: string;
}

export interface InterrogationRound {
  projectId: string;
  roundN: number;
  transcriptS3Uri: string;
  status: RoundStatusLiteral;
  humanConstraints?: string[];
  revisedRecommendation?: string;
  startedAt: string;
  completedAt?: string;
  transcriptSizeBytes?: number;
}

// ProgramReview — executive governance-checklist audit (Req 10).
// Contract shared with backend/src/lambda/program-review-resolver.ts (Track A).
// Question catalogue is parsed at Lambda cold-start from
// backend/src/lambda/governance-checklist.md bundled next to the handler. Each
// ChecklistResult.answer is one of ChecklistAnswer and represents the
// evidence-based evaluation of one of the 20 checklist questions.
export type ChecklistAnswerLiteral =
  "PASS" | "FAIL" | "NOT_APPLICABLE" | "PENDING_EVIDENCE";

export enum ChecklistAnswer {
  PASS = "PASS",
  FAIL = "FAIL",
  NOT_APPLICABLE = "NOT_APPLICABLE",
  PENDING_EVIDENCE = "PENDING_EVIDENCE",
}

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
