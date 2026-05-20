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
}
