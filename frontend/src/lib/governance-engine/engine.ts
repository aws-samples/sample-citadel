/**
 * GovernanceEngine — TypeScript port of `arbiter/governance/engine.py`.
 *
 * 8-step pure-function pipeline. No I/O. No mutation of inputs. Every
 * decision returns a `GovernanceFinding`.
 *
 * Pipeline (matches `engine.py:evaluate` line-by-line):
 *
 *   1. case-law lookup (first match by pre-sorted precedence)
 *   2. composition arbitration scaffold (no behaviour)
 *   3. covering-unit discovery
 *   4. residual-authority deny if no covering units
 *   5. tightest-scope selection with deterministic tie-break
 *   6. composition evaluation (4 arbitration patterns)
 *   7. single-domain permit when no contract matched
 *   8. constitutional review (override permits to DENY on invariant violation)
 */

import {
  ArbitrationDecision,
  ConflictResolution,
  createFinding,
  defaultClock,
  defaultUuidFactory,
  isAuthorityUnitValid,
  type AuthorityUnit,
  type CaseLawEntry,
  type CompositionContract,
  type ConstitutionalLayer,
  type DispatchRequest,
  type GovernanceFinding,
  type GovernanceState,
} from './models';
import { scopeCovers, scopeSpecificity } from './scope';
import {
  collaborativeComposition,
  deferredAuthority,
  rivalrousClaim,
  unilateralSovereignty,
  type PatternDeps,
  type PatternInputs,
} from './patterns';

const UNCONFIRMED_PREFIX = 'unconfirmed_';
const KNOWN_OPERATORS = new Set(['eq', 'neq', 'exists', 'not_exists', 'gt', 'lt']);

export interface GovernanceEngineOptions {
  clock?: () => number;
  uuidFactory?: () => string;
  /**
   * Optional callback invoked when a constitutional rule references an
   * unknown operator. Default = no-op. Mirrors Python's `logger.warning`
   * behaviour: the rule is treated as a non-violation regardless.
   */
  unknownOperatorWarn?: (message: string) => void;
}

/**
 * Pure, deterministic governance engine.
 *
 * Constructor pre-indexes the four config collections; `evaluate()` is the
 * only public method and is side-effect-free.
 */
export class GovernanceEngine {
  private readonly authorityUnits: Map<string, AuthorityUnit>;
  private readonly agentUnits: Map<string, AuthorityUnit[]>;
  private readonly contracts: Map<string, CompositionContract>;
  private readonly caseLaw: CaseLawEntry[];
  private readonly constitutionalLayers: ConstitutionalLayer[];
  private readonly clock: () => number;
  private readonly uuidFactory: () => string;
  private readonly unknownOperatorWarn: (message: string) => void;

  constructor(state: GovernanceState, options?: GovernanceEngineOptions) {
    this.clock = options?.clock ?? defaultClock;
    this.uuidFactory = options?.uuidFactory ?? defaultUuidFactory;
    this.unknownOperatorWarn = options?.unknownOperatorWarn ?? (() => {});

    // Unit-id index — preserves insertion order via Map semantics.
    this.authorityUnits = new Map<string, AuthorityUnit>();
    for (const u of state.authorityUnits) {
      this.authorityUnits.set(u.unitId, u);
    }

    // Agent-id index — preserves insertion order. '*' is the platform-wide
    // wildcard bucket.
    this.agentUnits = new Map<string, AuthorityUnit[]>();
    for (const u of state.authorityUnits) {
      const bucket = this.agentUnits.get(u.agentId);
      if (bucket === undefined) {
        this.agentUnits.set(u.agentId, [u]);
      } else {
        bucket.push(u);
      }
    }

    // Contracts indexed by both party orderings — symmetric lookup matches
    // Python's `self.contracts[(a, b)] = c; self.contracts[(b, a)] = c`.
    this.contracts = new Map<string, CompositionContract>();
    for (const c of state.compositionContracts) {
      this.contracts.set(contractKey(c.partyA, c.partyB), c);
      this.contracts.set(contractKey(c.partyB, c.partyA), c);
    }

    // Stable sort by precedence descending — equal precedence preserves
    // insertion order.
    this.caseLaw = [...state.caseLaw].sort((a, b) => b.precedence - a.precedence);

    this.constitutionalLayers = [...state.constitutionalLayers];
  }

  // ------------------------------------------------------------------
  // Public entry point
  // ------------------------------------------------------------------

  evaluate(request: DispatchRequest): GovernanceFinding {
    // --- Step 1: Case law -------------------------------------------------
    const caseMatch = this.checkCaseLaw(request);
    if (caseMatch !== null) {
      const finding = createFinding({
        workflowId: request.workflowId,
        decision: caseMatch.resolution,
        requestingAgent: request.requestingAgentId,
        targetAgent: request.targetAgentId,
        reason: `case_law:${caseMatch.caseId}`,
        uuidFactory: this.uuidFactory,
        clock: this.clock,
      });
      if (finding.decision === ArbitrationDecision.PERMIT) {
        const override = this.constitutionalReview(request, finding);
        if (override !== null) {
          return override;
        }
      }
      return finding;
    }

    // --- Step 3: Covering units ------------------------------------------
    const covering = this.findCoveringUnits(request);

    // --- Step 4: Residual-authority deny ---------------------------------
    if (covering.length === 0) {
      return createFinding({
        workflowId: request.workflowId,
        decision: ArbitrationDecision.DENY,
        requestingAgent: request.requestingAgentId,
        targetAgent: request.targetAgentId,
        reason: 'residual_authority_denial:no_scope_covers_action',
        residualAuthorityDenial: true,
        uuidFactory: this.uuidFactory,
        clock: this.clock,
      });
    }

    // --- Step 5: Tightest-scope selection --------------------------------
    const best = selectTightestScope(covering);

    // --- Step 6: Composition evaluation ----------------------------------
    const contractResult = this.evaluateComposition(request, best);
    if (contractResult !== null) {
      if (contractResult.decision === ArbitrationDecision.PERMIT) {
        const override = this.constitutionalReview(request, contractResult);
        if (override !== null) {
          return override;
        }
      }
      return contractResult;
    }

    // --- Step 7: Single-domain permit ------------------------------------
    const permit = createFinding({
      workflowId: request.workflowId,
      decision: ArbitrationDecision.PERMIT,
      requestingAgent: request.requestingAgentId,
      targetAgent: request.targetAgentId,
      reason: `scope_match:${best.unitId}`,
      scopeEvaluated: best.unitId,
      uuidFactory: this.uuidFactory,
      clock: this.clock,
    });

    // --- Step 8: Constitutional review -----------------------------------
    const override = this.constitutionalReview(request, permit);
    return override !== null ? override : permit;
  }

  // ------------------------------------------------------------------
  // Step 3: covering-unit discovery
  // ------------------------------------------------------------------

  private findCoveringUnits(request: DispatchRequest): AuthorityUnit[] {
    const requesterBucket = this.agentUnits.get(request.requestingAgentId) ?? [];
    const wildcardBucket = this.agentUnits.get('*') ?? [];
    const candidates = [...requesterBucket, ...wildcardBucket];
    const now = this.clock();
    return candidates.filter(
      (u) => isAuthorityUnitValid(u, now) && scopeCovers(u.scope, request),
    );
  }

  // ------------------------------------------------------------------
  // Step 6: composition evaluation
  // ------------------------------------------------------------------

  private findContract(request: DispatchRequest): CompositionContract | null {
    const direct = this.contracts.get(
      contractKey(request.requestingAgentId, request.targetAgentId),
    );
    if (direct !== undefined) {
      return direct;
    }

    const requesterDomain = this.getAgentDomain(request.requestingAgentId, request);
    const targetDomain = this.getAgentDomain(request.targetAgentId, request);
    if (
      requesterDomain !== null &&
      targetDomain !== null &&
      requesterDomain !== targetDomain
    ) {
      return this.contracts.get(contractKey(requesterDomain, targetDomain)) ?? null;
    }
    return null;
  }

  private getAgentDomain(
    agentId: string,
    request: DispatchRequest,
  ): string | null {
    const units = this.agentUnits.get(agentId) ?? [];
    const now = this.clock();
    const valid = units.filter(
      (u) =>
        isAuthorityUnitValid(u, now) &&
        u.scope.domain !== '*' &&
        scopeCovers(u.scope, request),
    );
    if (valid.length === 0) {
      return null;
    }
    return selectTightestScope(valid).scope.domain;
  }

  private evaluateComposition(
    request: DispatchRequest,
    bestUnit: AuthorityUnit,
  ): GovernanceFinding | null {
    const contract = this.findContract(request);
    if (contract === null) {
      return null;
    }

    const targetCandidates = this.agentUnits.get(request.targetAgentId) ?? [];
    const now = this.clock();
    const targetUnits = targetCandidates.filter(
      (u) => isAuthorityUnitValid(u, now) && scopeCovers(u.scope, request),
    );
    const requesterPermits = this.findCoveringUnits(request).length > 0;
    const targetPermits = targetUnits.length > 0;
    const stateConfirmed = this.isStateConfirmed(request, bestUnit, contract);

    const inputs: PatternInputs = {
      request,
      contract,
      bestUnit,
      targetUnits,
      requesterPermits,
      targetPermits,
      stateConfirmed,
    };
    const deps: PatternDeps = {
      uuidFactory: this.uuidFactory,
      clock: this.clock,
    };

    if (contract.conflictResolution === ConflictResolution.HALT_AND_ESCALATE) {
      return deferredAuthority(inputs, deps);
    }
    if (contract.conflictResolution === ConflictResolution.DEFAULT_DENY) {
      return unilateralSovereignty(inputs, deps);
    }
    if (contract.conflictResolution === ConflictResolution.PRECEDENCE_RESOLUTION) {
      return rivalrousClaim(inputs, deps);
    }
    return collaborativeComposition(inputs, deps);
  }

  private isStateConfirmed(
    request: DispatchRequest,
    authorityUnit: AuthorityUnit | null,
    contract: CompositionContract | null,
  ): boolean {
    const unconfirmedKeys: string[] = [];
    for (const key of Object.keys(request.context)) {
      if (key.startsWith(UNCONFIRMED_PREFIX)) {
        unconfirmedKeys.push(key);
      }
    }
    if (unconfirmedKeys.length === 0) {
      return true;
    }

    const relevant = new Set<string>();
    if (authorityUnit !== null) {
      for (const k of Object.keys(authorityUnit.scope.conditions)) {
        relevant.add(k);
      }
      for (const k of Object.keys(authorityUnit.scope.limits)) {
        relevant.add(k);
      }
    }
    if (contract !== null) {
      for (const k of Object.keys(contract.scope.conditions)) {
        relevant.add(k);
      }
      for (const k of Object.keys(contract.scope.limits)) {
        relevant.add(k);
      }
    }

    for (const key of unconfirmedKeys) {
      const stripped = key.slice(UNCONFIRMED_PREFIX.length);
      if (relevant.has(stripped)) {
        return false;
      }
    }
    return true;
  }

  // ------------------------------------------------------------------
  // Step 1: case-law lookup
  // ------------------------------------------------------------------

  private checkCaseLaw(request: DispatchRequest): CaseLawEntry | null {
    for (const entry of this.caseLaw) {
      if (matchesPattern(request, entry.pattern)) {
        return entry;
      }
    }
    return null;
  }

  // ------------------------------------------------------------------
  // Step 8: constitutional review
  // ------------------------------------------------------------------

  private constitutionalReview(
    request: DispatchRequest,
    permit: GovernanceFinding,
  ): GovernanceFinding | null {
    if (this.constitutionalLayers.length === 0) {
      return null;
    }

    for (const layer of this.constitutionalLayers) {
      for (const rule of layer.rules) {
        const field = rule.field;
        const operator = rule.operator;
        const expected = rule.value;
        const rawActual = request.context[field];
        const actual = rawActual === undefined ? null : rawActual;

        let violated = false;
        if (operator === 'eq') {
          violated = actual !== expected;
        } else if (operator === 'neq') {
          violated = actual === expected;
        } else if (operator === 'exists') {
          violated = actual === null;
        } else if (operator === 'not_exists') {
          violated = actual !== null;
        } else if (operator === 'gt') {
          violated = actual === null || isLte(actual, expected);
        } else if (operator === 'lt') {
          violated = actual === null || isGte(actual, expected);
        } else if (!KNOWN_OPERATORS.has(operator)) {
          violated = false;
          this.unknownOperatorWarn(
            `Unknown constitutional operator '${operator}' in layer ` +
              `${layer.layerId} rule for field '${field}'; treating as ` +
              `non-violation. Tighten the layer spec to avoid silent ` +
              `pass-through.`,
          );
        }

        if (violated) {
          return createFinding({
            workflowId: request.workflowId,
            decision: ArbitrationDecision.DENY,
            requestingAgent: request.requestingAgentId,
            targetAgent: request.targetAgentId,
            reason:
              `constitutional_review:${layer.layerId}:` +
              `invariant_violated:${field}`,
            scopeEvaluated: permit.scopeEvaluated,
            contractEvaluated: permit.contractEvaluated,
            uuidFactory: this.uuidFactory,
            clock: this.clock,
          });
        }
      }
    }
    return null;
  }
}

// ---------------------------------------------------------------------------
// Module-level helpers
// ---------------------------------------------------------------------------

/**
 * Tightest-scope selection. Mirrors Python's `min()` with composite key
 * `(-specificity, unitId)`: higher specificity wins; tie-break on
 * lexicographically-smaller `unitId`.
 *
 * Implemented as a left-fold so the choice is deterministic and matches
 * Python's `min` semantics even when array ordering varies.
 */
export function selectTightestScope(units: AuthorityUnit[]): AuthorityUnit {
  if (units.length === 0) {
    throw new Error('selectTightestScope called with empty array');
  }
  let best = units[0];
  let bestSpec = scopeSpecificity(best.scope);
  for (let i = 1; i < units.length; i += 1) {
    const candidate = units[i];
    const candidateSpec = scopeSpecificity(candidate.scope);
    if (candidateSpec > bestSpec) {
      best = candidate;
      bestSpec = candidateSpec;
    } else if (candidateSpec === bestSpec) {
      // Lex-order on unitId — strict byte/codepoint comparison, matches
      // Python's default string comparison (NOT locale-aware).
      if (candidate.unitId < best.unitId) {
        best = candidate;
      }
    }
  }
  return best;
}

/**
 * Conjunctive case-law pattern match. Mirrors `_matches_pattern` in
 * `engine.py`. Each pattern key maps to either a direct attribute on the
 * request (camelCase TS field) or, if not present as own property, a
 * value in `request.context`.
 *
 * Note: pattern keys for the TS port use the camelCase field names of
 * `DispatchRequest`. Cross-language fidelity is preserved by behaviour,
 * not by field-name identity. Test fixtures and case-law authoring in
 * the TS counterfactual evaluator must use the camelCase keys.
 */
function matchesPattern(
  request: DispatchRequest,
  pattern: Record<string, unknown>,
): boolean {
  const reqRecord = request as unknown as Record<string, unknown>;
  for (const [key, expected] of Object.entries(pattern)) {
    const fromRequest = Object.prototype.hasOwnProperty.call(reqRecord, key)
      ? reqRecord[key]
      : undefined;
    const actual =
      fromRequest === undefined ? request.context[key] ?? null : fromRequest;
    if (actual !== expected) {
      return false;
    }
  }
  return true;
}

function contractKey(a: string, b: string): string {
  return `${a}|${b}`;
}

/**
 * Type-narrowed `<=` for `unknown`. Returns true only when both sides are
 * the same comparable primitive type (number, string, or bigint) and
 * `a <= b` holds. Mismatched types are treated as a non-comparison (false)
 * — Python would raise TypeError; we conservatively report no violation.
 */
function isLte(a: unknown, b: unknown): boolean {
  if (typeof a === 'number' && typeof b === 'number') {
    return a <= b;
  }
  if (typeof a === 'string' && typeof b === 'string') {
    return a <= b;
  }
  if (typeof a === 'bigint' && typeof b === 'bigint') {
    return a <= b;
  }
  return false;
}

function isGte(a: unknown, b: unknown): boolean {
  if (typeof a === 'number' && typeof b === 'number') {
    return a >= b;
  }
  if (typeof a === 'string' && typeof b === 'string') {
    return a >= b;
  }
  if (typeof a === 'bigint' && typeof b === 'bigint') {
    return a >= b;
  }
  return false;
}

/**
 * Free-function entry point — convenience wrapper around
 * `new GovernanceEngine(state, options).evaluate(request)`. Kept for the
 * public API in `index.ts` so callers that only need a single evaluation
 * don't have to construct an engine instance explicitly.
 */
export function evaluate(
  state: GovernanceState,
  request: DispatchRequest,
  options?: GovernanceEngineOptions,
): GovernanceFinding {
  return new GovernanceEngine(state, options).evaluate(request);
}
