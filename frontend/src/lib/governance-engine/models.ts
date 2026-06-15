/**
 * Governance engine models — TypeScript port of `arbiter/governance/models.py`.
 *
 * Pure data types + a handful of pure helpers (`createFinding`,
 * `isAuthorityUnitValid`). No I/O. No async. No mutation of inputs.
 *
 * The shape of every interface mirrors the Python `@dataclass` of the same
 * name, with snake_case field names rewritten as camelCase per TypeScript
 * convention. Cross-language fidelity is established by behaviour, not by
 * field-name identity — see the `__tests__/fixtures.ts` JSDoc references
 * to the Python equivalents for each scenario.
 */

// ---------------------------------------------------------------------------
// Enums
// ---------------------------------------------------------------------------

export enum ConflictResolution {
  HALT_AND_ESCALATE = 'halt_and_escalate',
  DEFAULT_DENY = 'default_deny',
  PRECEDENCE_RESOLUTION = 'precedence_resolution',
}

export enum ArbitrationDecision {
  PERMIT = 'permit',
  DENY = 'deny',
  ESCALATE = 'escalate',
  HALT = 'halt',
}

export enum ScopeReductionReason {
  UNCONFIRMED_STATE = 'unconfirmed_state',
  DOMAIN_BOUNDARY = 'domain_boundary',
  ATTENUATION = 'attenuation',
}

// ---------------------------------------------------------------------------
// Authority model
// ---------------------------------------------------------------------------

/**
 * Four-dimensional authority predicate (mirrors `AuthorityScope` in
 * `models.py`). `decisionType` and `domain` accept `'*'` as a wildcard.
 * `conditions` are equality predicates; `limits` are numeric upper bounds.
 */
export interface AuthorityScope {
  decisionType: string;
  domain: string;
  conditions: Record<string, unknown>;
  limits: Record<string, number>;
}

/**
 * A single node in the authority graph (mirrors `AuthorityUnit` in
 * `models.py`). Validity is derived via `isAuthorityUnitValid` so the
 * data type stays a plain interface (no methods).
 */
export interface AuthorityUnit {
  unitId: string;
  agentId: string;
  scope: AuthorityScope;
  delegationSource: string | null;
  canRedelegate: boolean;
  expiryTimestamp: number | null;
  revoked: boolean;
  riskRating: 'low' | 'medium' | 'high';
  registryId: string | null;
}

/**
 * Returns `true` iff the unit is in force at `now` (unix seconds). Mirrors
 * `AuthorityUnit.is_valid()` from `models.py`. Revocation and expiry are
 * independent invalidation sources.
 */
export function isAuthorityUnitValid(
  unit: AuthorityUnit,
  now: number = defaultClock(),
): boolean {
  if (unit.revoked) {
    return false;
  }
  if (unit.expiryTimestamp !== null && now > unit.expiryTimestamp) {
    return false;
  }
  return true;
}

// ---------------------------------------------------------------------------
// Composition + constitution
// ---------------------------------------------------------------------------

export interface CompositionContract {
  contractId: string;
  partyA: string;
  partyB: string;
  authorityPrecedence: string;
  invariants: unknown[];
  conflictResolution: ConflictResolution;
  stopRights: string[];
  scope: AuthorityScope;
  escalationPath: string | null;
}

export interface ConstitutionalRule {
  field: string;
  operator: 'eq' | 'neq' | 'exists' | 'not_exists' | 'gt' | 'lt' | string;
  value: unknown;
}

export interface ConstitutionalLayer {
  layerId: string;
  layerType: 'global' | 'domain' | 'pairwise';
  appliesTo: string[];
  rules: ConstitutionalRule[];
  parentLayerId: string | null;
}

// ---------------------------------------------------------------------------
// Case law
// ---------------------------------------------------------------------------

export interface CaseLawEntry {
  caseId: string;
  pattern: Record<string, unknown>;
  resolution: ArbitrationDecision;
  encodedAt: string | number;
  encodedBy: string;
  scopeOfApplicability: Record<string, unknown>;
  precedence: number;
  revoked: boolean;
}

// ---------------------------------------------------------------------------
// Dispatch + finding
// ---------------------------------------------------------------------------

export interface DispatchRequest {
  requestingAgentId: string;
  targetAgentId: string;
  actionType: string;
  domain: string;
  workflowId: string;
  agentUseId: string;
  context: Record<string, unknown>;
  agentInput: Record<string, unknown>;
}

export interface GovernanceFinding {
  findingId: string;
  workflowId: string;
  decision: ArbitrationDecision;
  requestingAgent: string;
  targetAgent: string;
  reason: string;
  timestamp: number;
  scopeEvaluated: string | null;
  contractEvaluated: string | null;
  escalationTarget: string | null;
  residualAuthorityDenial: boolean;
}

export interface GovernanceState {
  authorityUnits: AuthorityUnit[];
  compositionContracts: CompositionContract[];
  caseLaw: CaseLawEntry[];
  constitutionalLayers: ConstitutionalLayer[];
}

// ---------------------------------------------------------------------------
// Clock + UUID injection
// ---------------------------------------------------------------------------

/** Default clock — unix seconds, matches Python's `time.time()`. */
export function defaultClock(): number {
  return Date.now() / 1000;
}

/**
 * Default UUID factory. Uses Web Crypto's `randomUUID` (available in Node
 * 14.17+ and all modern browsers / jsdom). Falls back to a v4-ish format
 * built from `Math.random` only if `crypto.randomUUID` is unavailable —
 * which should never happen in the supported runtimes but is included as
 * a safety net so this module has zero hard dependencies.
 */
export function defaultUuidFactory(): string {
  const cryptoRef: { randomUUID?: () => string } | undefined =
    (globalThis as { crypto?: { randomUUID?: () => string } }).crypto;
  if (cryptoRef && typeof cryptoRef.randomUUID === 'function') {
    return cryptoRef.randomUUID();
  }
  // Fallback — RFC4122-ish v4 from Math.random.
  const hex = (n: number): string => n.toString(16).padStart(2, '0');
  const bytes = new Array<number>(16);
  for (let i = 0; i < 16; i += 1) {
    bytes[i] = Math.floor(Math.random() * 256);
  }
  bytes[6] = (bytes[6] & 0x0f) | 0x40;
  bytes[8] = (bytes[8] & 0x3f) | 0x80;
  const b = bytes.map(hex).join('');
  return (
    `${b.slice(0, 8)}-${b.slice(8, 12)}-${b.slice(12, 16)}-` +
    `${b.slice(16, 20)}-${b.slice(20, 32)}`
  );
}

// ---------------------------------------------------------------------------
// Finding factory
// ---------------------------------------------------------------------------

export interface CreateFindingOptions {
  workflowId: string;
  decision: ArbitrationDecision;
  requestingAgent: string;
  targetAgent: string;
  reason: string;
  scopeEvaluated?: string | null;
  contractEvaluated?: string | null;
  escalationTarget?: string | null;
  residualAuthorityDenial?: boolean;
  uuidFactory?: () => string;
  clock?: () => number;
}

/**
 * Pure factory for `GovernanceFinding`. Stamps a fresh UUID + epoch-seconds
 * timestamp. Mirrors `GovernanceFinding.create` in `models.py`.
 */
export function createFinding(opts: CreateFindingOptions): GovernanceFinding {
  const uuidFactory = opts.uuidFactory ?? defaultUuidFactory;
  const clock = opts.clock ?? defaultClock;
  return {
    findingId: uuidFactory(),
    workflowId: opts.workflowId,
    decision: opts.decision,
    requestingAgent: opts.requestingAgent,
    targetAgent: opts.targetAgent,
    reason: opts.reason,
    timestamp: clock(),
    scopeEvaluated: opts.scopeEvaluated ?? null,
    contractEvaluated: opts.contractEvaluated ?? null,
    escalationTarget: opts.escalationTarget ?? null,
    residualAuthorityDenial: opts.residualAuthorityDenial ?? false,
  };
}
