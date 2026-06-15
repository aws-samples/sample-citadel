/**
 * Tracer decomposition helper
 *
 * Pure helper that mirrors the backend `getDecisionTrace` resolver
 * (backend/src/lambda/governance-ui-resolver.ts → buildSteps) so the
 * counterfactual evaluator can render an alternative
 * pipeline canvas using the same node + edge components as the
 * baseline canvas.
 *
 * TODO(wave-5.b.3): add a contract test asserting both implementations
 * produce identical traces for a fixed set of findings. The duplication
 * is owned by THIS slice and the backend resolver; any reason-format
 * change must land in both places in the same commit.
 *
 * Reason format owned by the engine (`arbiter/governance/engine.py`):
 *   - `case_law:<id>`                              → step 1 matched, terminal=1
 *   - `residual_authority_denial:*`                → step 4 denied, terminal=4
 *   - `scope_match:<unit>`                         → step 7 permitted, terminal=7
 *   - `deferred_authority:*` / `unilateral_sovereignty:*`
 *     / `rivalrous_claim:*` / `collaborative_composition:*`
 *                                                  → step 6 matched, terminal=6
 *   - `constitutional_review:<layer>:invariant_violated:<field>`
 *                                                  → step 8 overridden, terminal=8
 *   - `:unconfirmed_state` suffix                  → scopeReduction = 'unconfirmed_state'
 *   - `:attenuation` suffix                        → scopeReduction = 'attenuation'
 *   - `domain_boundary` token (forward-compat)     → scopeReduction = 'domain_boundary'
 *
 * Engine → service shape conversion: the engine's `GovernanceFinding`
 * uses `ArbitrationDecision` (string enum) for `decision` and a non-
 * nullable `boolean` for `residualAuthorityDenial`; the service shape
 * widens these to `string` and `boolean | null` respectively. The
 * decomposer projects from the engine shape into the service shape so
 * the tracer renderer (which consumes the service `DecisionTrace`)
 * can swap baseline ↔ alternative without code changes.
 */

import type { GovernanceFinding as EngineGovernanceFinding } from '@/lib/governance-engine/models';
import type {
  DecisionTrace,
  DecisionTraceStep,
  GovernanceFinding as ServiceGovernanceFinding,
} from '@/services/governanceService';

export const PIPELINE_STEPS: ReadonlyArray<{
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

const ARBITRATION_PATTERN_PREFIXES: ReadonlySet<string> = new Set([
  'deferred_authority',
  'unilateral_sovereignty',
  'rivalrous_claim',
  'collaborative_composition',
]);

type StepStatus = DecisionTraceStep['status'];

function parseReasonTokens(reason: string): string[] {
  if (!reason) return [];
  return reason.split(':');
}

function detectScopeReduction(tokens: string[]): string | null {
  // Suffix-keyed reductions land at the end of the reason string per
  // engine.py — e.g. `rivalrous_claim:winner=X:loser=Y:attenuation`.
  for (const token of tokens) {
    if (token === 'unconfirmed_state') return 'unconfirmed_state';
    if (token === 'attenuation') return 'attenuation';
    if (token === 'domain_boundary') return 'domain_boundary';
  }
  return null;
}

function detectArbitrationPattern(tokens: string[]): string | null {
  if (tokens.length === 0) return null;
  const head = tokens[0];
  return ARBITRATION_PATTERN_PREFIXES.has(head) ? head : null;
}

function buildBaseInputs(
  finding: ServiceGovernanceFinding,
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
  status: StepStatus,
  inputs: Record<string, unknown>,
  outputs: Record<string, unknown> | null,
  detailOverride?: string,
): DecisionTraceStep {
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

function mapDecisionToStatus(
  decision: string,
  permitStatus: StepStatus,
): StepStatus {
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

/**
 * Project either shape of governance finding (engine enum-typed or
 * service-string-typed) into the canonical service shape used inside
 * the decomposer + by the tracer renderer. `String(finding.decision)`
 * collapses the enum/string distinction; `residualAuthorityDenial`
 * widens transparently from `boolean` → `boolean | null`.
 */
function projectFindingToServiceShape(
  finding: EngineGovernanceFinding | ServiceGovernanceFinding,
): ServiceGovernanceFinding {
  return {
    findingId: finding.findingId,
    workflowId: finding.workflowId,
    decision: String(finding.decision),
    reason: finding.reason,
    requestingAgent: finding.requestingAgent,
    targetAgent: finding.targetAgent,
    scopeEvaluated: finding.scopeEvaluated,
    contractEvaluated: finding.contractEvaluated,
    escalationTarget: finding.escalationTarget,
    residualAuthorityDenial: finding.residualAuthorityDenial,
    timestamp: finding.timestamp,
  };
}

/**
 * Decompose a governance finding (from the engine OR from the service
 * wire shape) into the 8-step `DecisionTrace` shape consumed by the
 * tracer renderer. Mirrors the backend `getDecisionTrace` resolver
 * verbatim — see file header for the duplication contract.
 *
 * Accepts either:
 *   * `EngineGovernanceFinding` — produced by the in-process governance
 *     engine (`@/lib/governance-engine/models`); has `decision`
 *     typed as the `ArbitrationDecision` string enum and a non-nullable
 *     `residualAuthorityDenial: boolean`.
 *   * `ServiceGovernanceFinding` — projected over the wire by the
 *     backend resolver; has `decision: string` and
 *     `residualAuthorityDenial: boolean | null`.
 *
 * Both shapes share field names — the union is purely a type widening
 * so the cross-package contract test (which loads JSON fixtures typed
 * as the service shape) and the in-process counterfactual evaluator
 * (which holds engine findings) call the same helper.
 */
export function decomposeFinding(
  finding: EngineGovernanceFinding | ServiceGovernanceFinding,
): DecisionTrace {
  const projected = projectFindingToServiceShape(finding);
  const tokens = parseReasonTokens(projected.reason);
  const arbitrationPattern = detectArbitrationPattern(tokens);
  const scopeReduction = detectScopeReduction(tokens);
  const baseInputs = buildBaseInputs(projected);
  const decision = projected.decision;
  const head = tokens[0] ?? '';

  const constitutionalOverride = head === 'constitutional_review';
  const overrideLayerId = constitutionalOverride ? (tokens[1] ?? null) : null;
  const overrideField = constitutionalOverride ? (tokens[3] ?? null) : null;

  const caseLawHit = head === 'case_law';
  const caseLawId = caseLawHit ? (tokens[1] ?? null) : null;

  const residualDenial =
    head === 'residual_authority_denial' ||
    projected.residualAuthorityDenial === true;

  const scopeMatch = head === 'scope_match';
  const scopeMatchUnitId = scopeMatch ? (tokens[1] ?? null) : null;
  const composition = arbitrationPattern !== null;
  const compositionContractId = composition
    ? projected.contractEvaluated
    : null;

  // Default: every step skipped (step 2 is always pass-through scaffold).
  let s1: StepStatus = 'skipped';
  const s2: StepStatus = 'pass-through';
  let s3: StepStatus = 'skipped';
  let s4: StepStatus = 'skipped';
  let s5: StepStatus = 'skipped';
  let s6: StepStatus = 'skipped';
  let s7: StepStatus = 'skipped';
  let s8: StepStatus = 'skipped';
  let terminalStepNumber = 8;

  if (constitutionalOverride) {
    // Step 8 always fires here; the underlying step that produced the
    // permit is hard to recover from the reason alone (engine rewrites
    // the reason on override). Light up steps 1/3/4/5/6/7 as
    // pass-through so the operator sees the override clearly without
    // false claims about the upstream path.
    s1 = 'pass-through';
    s3 = 'pass-through';
    s4 = 'pass-through';
    s5 = 'pass-through';
    s6 = 'pass-through';
    s7 = 'pass-through';
    s8 = 'overridden';
    terminalStepNumber = 8;
  } else if (caseLawHit) {
    // Case-law match short-circuits steps 3..7. Step 8 may still fire
    // on PERMITs, but if the reason head is case_law (not
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
    // Unrecognised reason — degrade to pass-through. The frontend has no
    // CloudWatch sink, so the warning is intentionally suppressed here;
    // the backend resolver remains the authoritative drift detector.
    s1 = 'pass-through';
    s3 = 'pass-through';
    s4 = 'pass-through';
    s5 = 'pass-through';
    s6 = 'pass-through';
    s7 = 'pass-through';
    terminalStepNumber = decision === 'halt' ? 8 : 7;
  }

  const steps: DecisionTraceStep[] = [
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
      {
        ...baseInputs,
        residualAuthorityDenial: projected.residualAuthorityDenial ?? false,
      },
      residualDenial ? { decision: 'deny' } : null,
    ),
    makeStep(
      5,
      s5,
      { ...baseInputs },
      projected.scopeEvaluated
        ? { scope_evaluated: projected.scopeEvaluated }
        : null,
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
        ? {
            decision,
            scope_evaluated: scopeMatchUnitId ?? projected.scopeEvaluated ?? null,
          }
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

  return {
    findingId: projected.findingId,
    finding: projected,
    steps,
    terminalDecision: decision,
    terminalStepNumber,
    reasonTokens: tokens,
    constitutionalOverride,
    arbitrationPattern,
    scopeReduction,
  };
}
