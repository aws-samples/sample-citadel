/**
 * Public API for the client-side governance engine.
 *
 * TypeScript port of `arbiter/governance/engine.py:evaluate()`.
 * Used for in-browser counterfactual evaluation. Pure
 * functions, no I/O.
 */

export {
  // Class + free-function entry points
  GovernanceEngine,
  evaluate,
  selectTightestScope,
  type GovernanceEngineOptions,
} from './engine';

export {
  collaborativeComposition,
  deferredAuthority,
  rivalrousClaim,
  unilateralSovereignty,
  type PatternDeps,
  type PatternInputs,
} from './patterns';

export { scopeCovers, scopeSpecificity } from './scope';

export {
  // Enums
  ArbitrationDecision,
  ConflictResolution,
  ScopeReductionReason,
  // Models
  type AuthorityScope,
  type AuthorityUnit,
  type CaseLawEntry,
  type CompositionContract,
  type ConstitutionalLayer,
  type ConstitutionalRule,
  type CreateFindingOptions,
  type DispatchRequest,
  type GovernanceFinding,
  type GovernanceState,
  // Helpers
  createFinding,
  defaultClock,
  defaultUuidFactory,
  isAuthorityUnitValid,
} from './models';
