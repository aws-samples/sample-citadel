/**
 * Unified Lifecycle Manager
 *
 * Parameterized state machine for both datastore and integration status transitions.
 */

export interface TransitionMap {
  transitions: Record<string, string[]>;
  actions: Record<string, string[]>;
}

export const INTEGRATION_TRANSITIONS: TransitionMap = {
  transitions: {
    CREATED: ['CONFIGURED', 'CONFIGURING'],
    CONFIGURING: ['CONFIGURED', 'CREATED'],
    CONFIGURED: ['TESTED', 'CONNECTING', 'CONFIGURED'],
    TESTED: ['CONNECTING', 'CONFIGURED', 'TESTED'],
    CONNECTING: ['CONNECTED', 'CONNECTION_FAILED'],
    CONNECTED: ['DISCONNECTED', 'CONFIGURED'],
    DISCONNECTED: ['CONFIGURED', 'CONNECTING'],
    CONNECTION_FAILED: ['CONFIGURED', 'CONNECTING', 'TESTED'],
  },
  actions: {
    test: ['CONFIGURED', 'TESTED', 'CONNECTED', 'DISCONNECTED', 'CONNECTION_FAILED'],
    connect: ['TESTED', 'CONFIGURED', 'DISCONNECTED', 'CONNECTION_FAILED'],
    disconnect: ['CONNECTED'],
  },
};

export const DATASTORE_TRANSITIONS: TransitionMap = {
  transitions: {
    CREATED: ['CONNECTING', 'PROVISIONING', 'ERROR'],
    PROVISIONING: ['PROVISIONED', 'CONNECTED', 'ERROR'],
    PROVISIONED: ['CONNECTING', 'ERROR'],
    CONNECTING: ['CONNECTED', 'ERROR'],
    CONNECTED: ['DISCONNECTED', 'ERROR'],
    DISCONNECTED: ['CONNECTING', 'ERROR', 'DELETING'],
    ERROR: ['CONNECTING', 'DELETING', 'CREATED'],
    DELETING: [],
  },
  actions: {
    test: ['CREATED', 'CONNECTED', 'DISCONNECTED', 'ERROR'],
    connect: ['CREATED', 'DISCONNECTED', 'ERROR', 'PROVISIONED'],
    disconnect: ['CONNECTED'],
    provision: ['CREATED'],
  },
};

/**
 * Project phase transitions.
 *
 * Matrix locked by QT3-1 §9. Owned by LifecycleManager per QT2A-5.
 * Every status change on ProjectsTable MUST route through
 * LifecycleManager.validateTransition(current, next) before the
 * DynamoDB write.
 *
 * Transitions:
 *   CREATED              -> IN_PROGRESS | ERROR
 *   IN_PROGRESS          -> ASSESSMENT_COMPLETE | ERROR
 *   ASSESSMENT_COMPLETE  -> DESIGN_COMPLETE | ERROR
 *   DESIGN_COMPLETE      -> PLANNING_COMPLETE | ERROR
 *   PLANNING_COMPLETE    -> IMPLEMENTATION_READY | ERROR
 *   IMPLEMENTATION_READY -> COMPLETED | ERROR
 *   COMPLETED            -> (terminal)
 *   ERROR                -> IN_PROGRESS | COMPLETED  (recover or abandon)
 *
 * Idempotent same-state transitions are permitted (handled by LifecycleManager).
 */
export const PROJECT_TRANSITIONS: TransitionMap = {
  transitions: {
    CREATED: ['IN_PROGRESS', 'ERROR'],
    IN_PROGRESS: ['ASSESSMENT_COMPLETE', 'ERROR'],
    ASSESSMENT_COMPLETE: ['DESIGN_COMPLETE', 'ERROR'],
    DESIGN_COMPLETE: ['PLANNING_COMPLETE', 'ERROR'],
    PLANNING_COMPLETE: ['IMPLEMENTATION_READY', 'ERROR'],
    IMPLEMENTATION_READY: ['COMPLETED', 'ERROR'],
    COMPLETED: [],
    ERROR: ['IN_PROGRESS', 'COMPLETED'],
  },
  actions: {
    advance: [
      'CREATED',
      'IN_PROGRESS',
      'ASSESSMENT_COMPLETE',
      'DESIGN_COMPLETE',
      'PLANNING_COMPLETE',
      'IMPLEMENTATION_READY',
    ],
    fail: [
      'CREATED',
      'IN_PROGRESS',
      'ASSESSMENT_COMPLETE',
      'DESIGN_COMPLETE',
      'PLANNING_COMPLETE',
      'IMPLEMENTATION_READY',
    ],
    recover: ['ERROR'],
    abandon: ['ERROR'],
  },
};

/**
 * ADR status transitions.
 *
 * Matrix locked by QT3-5 in.kiro/planning/PLAN_GOV_DIFF.md §9. Supports the
 * C7 + C14 capabilities: an ADR is drafted (PROPOSED), decided (LOCKED), and
 * can later be SUPERSEDED (a successor ADR replaces it) or REOPENED (formal
 * revisit with audit-before-auth). A REOPENED ADR can be re-locked after 
 * revision.
 *
 * Transitions:
 *   PROPOSED   -> LOCKED | SUPERSEDED
 *   LOCKED     -> SUPERSEDED | REOPENED
 *   REOPENED   -> LOCKED
 *   SUPERSEDED -> (terminal)
 *
 * Idempotent same-state transitions are permitted by LifecycleManager.
 */
export const ADR_TRANSITIONS: TransitionMap = {
  transitions: {
    PROPOSED: ['LOCKED', 'SUPERSEDED'],
    LOCKED: ['SUPERSEDED', 'REOPENED'],
    REOPENED: ['LOCKED'],
    SUPERSEDED: [],
  },
  actions: {
    lock: ['PROPOSED', 'REOPENED'],
    supersede: ['PROPOSED', 'LOCKED'],
    reopen: ['LOCKED'],
  },
};

// EXECSPEC_TRANSITIONS
/**
 * ExecutionSpecification status transitions.
 *
 * Matrix locked by QT3-5 / Task 2A §3.1 for the C10 human-validation gate.
 * Transitions:
 *   DRAFT          -> PENDING_REVIEW | REJECTED  (architect submits or rejects own draft)
 *   PENDING_REVIEW -> APPROVED | REJECTED
 *   APPROVED       -> (terminal — immutable, new specs must be revised then re-approved)
 *   REJECTED       -> DRAFT                       (revise into a fresh draft)
 *
 * Idempotent same-state transitions are permitted.
 */
export const EXECSPEC_TRANSITIONS: TransitionMap = {
  transitions: {
    DRAFT: ['PENDING_REVIEW', 'REJECTED'],
    PENDING_REVIEW: ['APPROVED', 'REJECTED'],
    APPROVED: [],
    REJECTED: ['DRAFT'],
  },
  actions: {
    submit: ['DRAFT'],
    approve: ['PENDING_REVIEW', 'DRAFT'],
    reject: ['DRAFT', 'PENDING_REVIEW'],
    revise: ['REJECTED'],
  },
};

// ROUND_TRANSITIONS
/**
 * InterrogationRound status transitions.
 *
 * Matrix locked by Task 2A §3.1 for the C6 advisory interrogation loop.
 * Transitions:
 *   IN_PROGRESS          -> AWAITING_CONSTRAINTS | STABILISED
 *   AWAITING_CONSTRAINTS -> REVISED
 *   REVISED              -> STABILISED | AWAITING_CONSTRAINTS
 *   STABILISED           -> (terminal)
 *
 * Idempotent same-state transitions permitted.
 */
export const ROUND_TRANSITIONS: TransitionMap = {
  transitions: {
    IN_PROGRESS: ['AWAITING_CONSTRAINTS', 'STABILISED'],
    AWAITING_CONSTRAINTS: ['REVISED'],
    REVISED: ['STABILISED', 'AWAITING_CONSTRAINTS'],
    STABILISED: [],
  },
  actions: {
    injectConstraints: ['IN_PROGRESS', 'REVISED'],
    stabilise: ['IN_PROGRESS', 'REVISED'],
  },
};

// Decision #3 (AgentCore Registry governance retrofit): status domain and
// allowed transitions for a RegistryAgentRecord. Status values sourced from
// RegistryRecordStatusValues in backend/src/services/registry-service.ts.
// Not wired into any resolver in PR 1 — PR 3 wires agent-config-resolver's
// UpdateRegistryRecordStatus calls through LifecycleManager.validateTransition.
export const REGISTRY_TRANSITIONS: TransitionMap = {
  transitions: {
    DRAFT: ['PENDING_APPROVAL', 'DEPRECATED'],
    PENDING_APPROVAL: ['APPROVED', 'REJECTED'],
    REJECTED: ['DRAFT', 'DEPRECATED'],      // resubmit or abandon
    APPROVED: ['DEPRECATED'],
    DEPRECATED: [],                           // terminal
  },
  actions: {
    submit: ['DRAFT'],
    approve: ['PENDING_APPROVAL'],
    reject: ['PENDING_APPROVAL'],
    resubmit: ['REJECTED'],
    deprecate: ['DRAFT', 'REJECTED', 'APPROVED'],
  },
};

export class LifecycleManager {
  constructor(private readonly map: TransitionMap) {}

  isValidTransition(current: string, next: string): boolean {
    if (current === next) return true;
    const valid = this.map.transitions[current];
    if (!valid) return false;
    return valid.includes(next);
  }

  validateTransition(current: string, next: string): void {
    if (!this.isValidTransition(current, next)) {
      const valid = this.map.transitions[current] || [];
      throw new Error(
        `Invalid status transition: ${current} → ${next}. ` +
        `Valid transitions from ${current}: ${valid.join(', ') || 'none'}`
      );
    }
  }

  canPerform(action: string, currentStatus: string): boolean {
    const allowed = this.map.actions[action];
    if (!allowed) return false;
    return allowed.includes(currentStatus);
  }

  getValidNextStatuses(current: string): string[] {
    return this.map.transitions[current] || [];
  }

  /**
   * Validate a transition and then run an async pre-transition hook.
   *
   * Used by phase-transition guards in project-resolver to
   * enforce governance gates (C3/C7/C10). Single hook per entity type
   * per QT4-6 YAGNI (no hook pipeline).
   *
   * Order:
   *   1. validateTransition(current, next) throws on invalid transition
   *   2. await hook(current, next, context) throws ValidationError to block
   */
  async validateTransitionWithHook(
    current: string,
    next: string,
    hook: PreTransitionHook,
    context: PreTransitionContext,
  ): Promise<void> {
    this.validateTransition(current, next);
    await hook(current, next, context);
  }
}

/**
 * Context passed to a PreTransitionHook. Keep minimal — the hook fetches
 * whatever domain data it needs via its own imports.
 */
export interface PreTransitionContext {
  projectId: string;
  actorUserId: string;
  entityId?: string;
}

/**
 * Hook signature for pre-transition governance checks.
 * Throw to block; resolve to allow. Throwing should use ValidationError
 * shape so resolvers surface a user-actionable message.
 */
export type PreTransitionHook = (
  current: string,
  next: string,
  context: PreTransitionContext,
) => Promise<void>;
