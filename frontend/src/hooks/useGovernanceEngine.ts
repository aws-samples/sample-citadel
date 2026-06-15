/**
 * useGovernanceEngine — client-side governance state hook.
 *
 * Fetches the four governance collections via the existing service
 * queries (`listAuthorityUnits`, `listCompositionContracts`,
 * `listConstitutionalLayers`, `listCaseLaw`) and constructs an immutable
 * `GovernanceEngine` from the assembled `GovernanceState`. The engine
 * is cached in component state and only rebuilt when `refresh()` is
 * called; per the slice contract, refresh constructs a FRESH engine
 * instead of mutating an existing one (engines are designed as
 * effectively immutable).
 *
 * The four service queries return shapes that differ slightly from the
 * engine's internal types: JSON-encoded maps need to be parsed,
 * `conflictResolution` widens from an enum to a string at the wire
 * layer, etc. The `adaptStateForEngine` helper does the projection in
 * one place — it is exported separately so the helper can be unit-
 * tested without setting up a hook render harness.
 *
 * Errors from any of the four queries surface as `error: <msg>`,
 * `engine: null` so the caller can disable the consumer (the
 * "Edit and re-evaluate" button is disabled while loading or errored).
 */

import { useCallback, useEffect, useMemo, useRef, useState } from 'react';
import {
  GovernanceEngine,
  ConflictResolution,
  type AuthorityScope as EngineAuthorityScope,
  type AuthorityUnit as EngineAuthorityUnit,
  type CaseLawEntry as EngineCaseLawEntry,
  type CompositionContract as EngineCompositionContract,
  type ConstitutionalLayer as EngineConstitutionalLayer,
  type ConstitutionalRule as EngineConstitutionalRule,
  type GovernanceState,
} from '@/lib/governance-engine';
import { ArbitrationDecision } from '@/lib/governance-engine/models';
import {
  governanceService,
  type AuthorityScope as ServiceAuthorityScope,
  type AuthorityUnit as ServiceAuthorityUnit,
  type CaseLawEntry as ServiceCaseLawEntry,
  type CompositionContract as ServiceCompositionContract,
  type ConstitutionalLayer as ServiceConstitutionalLayer,
  type ConstitutionalRule as ServiceConstitutionalRule,
} from '@/services/governanceService';

export interface UseGovernanceEngineResult {
  engine: GovernanceEngine | null;
  loading: boolean;
  error: string | null;
  /** Re-fetch all four collections and rebuild the engine. */
  refresh: () => void;
}

export interface AdapterServiceData {
  authorityUnits: ServiceAuthorityUnit[];
  compositionContracts: ServiceCompositionContract[];
  constitutionalLayers: ServiceConstitutionalLayer[];
  caseLaw: ServiceCaseLawEntry[];
}

// ---------------------------------------------------------------------------
// Adapter helpers (exported for unit tests)
// ---------------------------------------------------------------------------

/**
 * Parse a JSON-encoded string into the supplied default-typed object.
 * Returns the supplied default when parsing fails so the engine never
 * sees an undefined / Array / null where it expects a plain object.
 */
function parseJsonObject<T extends object>(
  raw: string | null | undefined,
  fallback: T,
): T {
  if (!raw) return fallback;
  try {
    const parsed = JSON.parse(raw);
    if (
      parsed === null ||
      typeof parsed !== 'object' ||
      Array.isArray(parsed)
    ) {
      return fallback;
    }
    return parsed as T;
  } catch {
    return fallback;
  }
}

/**
 * Coerce the limits map to the engine's `Record<string, number>` shape.
 * Non-numeric values are dropped — the engine's scope predicate only
 * compares numeric limits and silently ignores non-numeric request
 * context values, so dropping non-numerics here mirrors that semantics
 * without surfacing an error.
 */
function coerceLimits(raw: object): Record<string, number> {
  const out: Record<string, number> = {};
  for (const [k, v] of Object.entries(raw as Record<string, unknown>)) {
    if (typeof v === 'number' && Number.isFinite(v)) {
      out[k] = v;
    }
  }
  return out;
}

function adaptScope(scope: ServiceAuthorityScope): EngineAuthorityScope {
  const conditionsObj = parseJsonObject<Record<string, unknown>>(
    scope.conditions,
    {},
  );
  const limitsObj = parseJsonObject<Record<string, unknown>>(scope.limits, {});
  return {
    decisionType: scope.decisionType,
    domain: scope.domain,
    conditions: conditionsObj,
    limits: coerceLimits(limitsObj),
  };
}

function adaptRiskRating(
  raw: string,
): EngineAuthorityUnit['riskRating'] {
  if (raw === 'low' || raw === 'medium' || raw === 'high') return raw;
  // Defensive: the wire shape allows `string` for forward-compat. Any
  // unrecognised value coerces to the safest bucket so the engine still
  // evaluates instead of silently rejecting the unit.
  return 'low';
}

function adaptUnit(unit: ServiceAuthorityUnit): EngineAuthorityUnit {
  return {
    unitId: unit.unitId,
    agentId: unit.agentId,
    scope: adaptScope(unit.scope),
    delegationSource: unit.delegationSource,
    canRedelegate: unit.canRedelegate,
    expiryTimestamp: unit.expiryTimestamp,
    revoked: unit.revoked,
    riskRating: adaptRiskRating(unit.riskRating),
    registryId: unit.registryId,
  };
}

/**
 * Map the wire-shape `conflictResolution` string to the engine's enum.
 * The engine's `evaluate()` switches on these three values and falls
 * through to collaborative composition for anything else; the cast
 * here mirrors that fall-through semantics for unknown values
 * (returns the literal string cast as the enum, which then matches
 * the default branch in the engine).
 */
function adaptConflictResolution(raw: string): ConflictResolution {
  if (raw === ConflictResolution.HALT_AND_ESCALATE) {
    return ConflictResolution.HALT_AND_ESCALATE;
  }
  if (raw === ConflictResolution.DEFAULT_DENY) {
    return ConflictResolution.DEFAULT_DENY;
  }
  if (raw === ConflictResolution.PRECEDENCE_RESOLUTION) {
    return ConflictResolution.PRECEDENCE_RESOLUTION;
  }
  // Unknown value — pass through as the engine falls back to
  // collaborative composition for any non-matched enum value. The
  // explicit cast preserves the literal so the engine sees the same
  // string the wire delivered.
  return raw as ConflictResolution;
}

function adaptContract(
  contract: ServiceCompositionContract,
): EngineCompositionContract {
  return {
    contractId: contract.contractId,
    partyA: contract.partyA,
    partyB: contract.partyB,
    authorityPrecedence: contract.authorityPrecedence,
    invariants: contract.invariants,
    conflictResolution: adaptConflictResolution(contract.conflictResolution),
    stopRights: contract.stopRights,
    scope: adaptScope(contract.scope),
    escalationPath: contract.escalationPath,
  };
}

function adaptRule(rule: ServiceConstitutionalRule): EngineConstitutionalRule {
  // The engine's `_constitutional_review` step compares the request
  // context value against `rule.value` directly. The wire layer ships
  // a JSON-encoded string for non-exists operators (and `null` for
  // `exists` / `not_exists`). Parse non-null values back into the
  // primitive shape so the engine's `===` comparison works.
  if (rule.value === null) {
    return {
      field: rule.field,
      operator: rule.operator,
      value: null,
    };
  }
  let parsedValue: unknown;
  try {
    parsedValue = JSON.parse(rule.value);
  } catch {
    // Non-JSON wire value — pass through the literal so the engine can
    // still compare it (a string === a string).
    parsedValue = rule.value;
  }
  return {
    field: rule.field,
    operator: rule.operator,
    value: parsedValue,
  };
}

function adaptLayer(
  layer: ServiceConstitutionalLayer,
): EngineConstitutionalLayer {
  return {
    layerId: layer.layerId,
    layerType: layer.layerType as EngineConstitutionalLayer['layerType'],
    appliesTo: layer.appliesTo,
    rules: layer.rules.map(adaptRule),
    parentLayerId: layer.parentLayerId,
  };
}

function adaptResolution(raw: string): ArbitrationDecision {
  switch (raw) {
    case 'permit':
      return ArbitrationDecision.PERMIT;
    case 'deny':
      return ArbitrationDecision.DENY;
    case 'escalate':
      return ArbitrationDecision.ESCALATE;
    case 'halt':
      return ArbitrationDecision.HALT;
    default:
      // Unknown wire value (e.g. 'unknown' coercion from the resolver).
      // Default to DENY so a malformed entry never silently permits.
      return ArbitrationDecision.DENY;
  }
}

function adaptCase(entry: ServiceCaseLawEntry): EngineCaseLawEntry {
  return {
    caseId: entry.caseId,
    pattern: parseJsonObject<Record<string, unknown>>(entry.pattern, {}),
    resolution: adaptResolution(entry.resolution),
    encodedAt: entry.encodedAt,
    encodedBy: entry.encodedBy,
    scopeOfApplicability: parseJsonObject<Record<string, unknown>>(
      entry.scopeOfApplicability,
      {},
    ),
    precedence: entry.precedence,
    revoked: entry.revoked,
  };
}

/**
 * Pure projection from the four service-shape collections to the
 * engine's `GovernanceState`. Exported for direct unit testing.
 */
export function adaptStateForEngine(
  data: AdapterServiceData,
): GovernanceState {
  return {
    authorityUnits: data.authorityUnits.map(adaptUnit),
    compositionContracts: data.compositionContracts.map(adaptContract),
    constitutionalLayers: data.constitutionalLayers.map(adaptLayer),
    caseLaw: data.caseLaw.map(adaptCase),
  };
}

// ---------------------------------------------------------------------------
// Hook
// ---------------------------------------------------------------------------

export function useGovernanceEngine(): UseGovernanceEngineResult {
  const [engine, setEngine] = useState<GovernanceEngine | null>(null);
  const [loading, setLoading] = useState<boolean>(true);
  const [error, setError] = useState<string | null>(null);
  const [refreshTick, setRefreshTick] = useState(0);
  const mountedRef = useRef(true);

  useEffect(() => {
    mountedRef.current = true;
    return () => {
      mountedRef.current = false;
    };
  }, []);

  useEffect(() => {
    let cancelled = false;
    setLoading(true);
    setError(null);
    setEngine(null);

    Promise.all([
      governanceService.listAuthorityUnits({ includeRevoked: false }),
      governanceService.listCompositionContracts(),
      governanceService.listConstitutionalLayers(),
      governanceService.listCaseLaw({ includeRevoked: false }),
    ])
      .then(([authorityUnits, compositionContracts, constitutionalLayers, caseLaw]) => {
        if (cancelled || !mountedRef.current) return;
        try {
          const state = adaptStateForEngine({
            authorityUnits,
            compositionContracts,
            constitutionalLayers,
            caseLaw,
          });
          // Constructing a fresh engine guarantees the hook caller
          // never holds a reference to a mutated instance — the
          // engine is designed to be effectively immutable.
          const next = new GovernanceEngine(state);
          setEngine(next);
        } catch (err: unknown) {
          const msg =
            err instanceof Error
              ? err.message
              : 'Failed to construct governance engine';
          setError(msg);
          setEngine(null);
        }
      })
      .catch((err: unknown) => {
        if (cancelled || !mountedRef.current) return;
        const msg =
          err instanceof Error
            ? err.message
            : 'Failed to load governance state';
        setError(msg);
        setEngine(null);
      })
      .finally(() => {
        if (cancelled || !mountedRef.current) return;
        setLoading(false);
      });

    return () => {
      cancelled = true;
    };
  }, [refreshTick]);

  const refresh = useCallback(() => {
    setRefreshTick((tick) => tick + 1);
  }, []);

  return useMemo(
    () => ({ engine, loading, error, refresh }),
    [engine, loading, error, refresh],
  );
}

export default useGovernanceEngine;
