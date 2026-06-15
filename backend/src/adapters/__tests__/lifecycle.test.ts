/**
 * TDD Tests for Unified Lifecycle Manager
 *
 * Handles status transitions for both datastores and integrations
 * using a parameterized state machine.
 */

import {
  LifecycleManager,
  DATASTORE_TRANSITIONS,
  INTEGRATION_TRANSITIONS,
  PROJECT_TRANSITIONS,
  REGISTRY_TRANSITIONS,
  PreTransitionContext,
} from '../lifecycle';

describe('LifecycleManager', () => {
  describe('Integration lifecycle', () => {
    const lifecycle = new LifecycleManager(INTEGRATION_TRANSITIONS);

    test('CREATED -> CONFIGURED is valid', () => {
      expect(lifecycle.isValidTransition('CREATED', 'CONFIGURED')).toBe(true);
    });

    test('CONFIGURED -> TESTED is valid', () => {
      expect(lifecycle.isValidTransition('CONFIGURED', 'TESTED')).toBe(true);
    });

    test('TESTED -> CONNECTING is valid', () => {
      expect(lifecycle.isValidTransition('TESTED', 'CONNECTING')).toBe(true);
    });

    test('CONNECTING -> CONNECTED is valid', () => {
      expect(lifecycle.isValidTransition('CONNECTING', 'CONNECTED')).toBe(true);
    });

    test('CONNECTING -> CONNECTION_FAILED is valid', () => {
      expect(lifecycle.isValidTransition('CONNECTING', 'CONNECTION_FAILED')).toBe(true);
    });

    test('CONNECTED -> DISCONNECTED is valid', () => {
      expect(lifecycle.isValidTransition('CONNECTED', 'DISCONNECTED')).toBe(true);
    });

    test('CREATED -> CONNECTED is invalid', () => {
      expect(lifecycle.isValidTransition('CREATED', 'CONNECTED')).toBe(false);
    });

    test('validateTransition throws on invalid transition', () => {
      expect(() => lifecycle.validateTransition('CREATED', 'CONNECTED')).toThrow(
        'Invalid status transition'
      );
    });

    test('same status is always valid (idempotent)', () => {
      expect(lifecycle.isValidTransition('CONFIGURED', 'CONFIGURED')).toBe(true);
    });

    test('canTest returns true for testable statuses', () => {
      expect(lifecycle.canPerform('test', 'CONFIGURED')).toBe(true);
      expect(lifecycle.canPerform('test', 'TESTED')).toBe(true);
      expect(lifecycle.canPerform('test', 'CONNECTED')).toBe(true);
      expect(lifecycle.canPerform('test', 'CREATED')).toBe(false);
    });

    test('canConnect returns true for connectable statuses', () => {
      expect(lifecycle.canPerform('connect', 'TESTED')).toBe(true);
      expect(lifecycle.canPerform('connect', 'CONFIGURED')).toBe(true);
      expect(lifecycle.canPerform('connect', 'DISCONNECTED')).toBe(true);
      expect(lifecycle.canPerform('connect', 'CREATED')).toBe(false);
    });

    test('canDisconnect returns true only for CONNECTED', () => {
      expect(lifecycle.canPerform('disconnect', 'CONNECTED')).toBe(true);
      expect(lifecycle.canPerform('disconnect', 'CONFIGURED')).toBe(false);
    });

    test('getValidNextStatuses returns correct transitions', () => {
      const next = lifecycle.getValidNextStatuses('CONFIGURED');
      expect(next).toContain('TESTED');
      expect(next).toContain('CONNECTING');
    });
  });

  describe('DataStore lifecycle', () => {
    const lifecycle = new LifecycleManager(DATASTORE_TRANSITIONS);

    test('CREATED -> CONNECTING is valid', () => {
      expect(lifecycle.isValidTransition('CREATED', 'CONNECTING')).toBe(true);
    });

    test('CREATED -> PROVISIONING is valid', () => {
      expect(lifecycle.isValidTransition('CREATED', 'PROVISIONING')).toBe(true);
    });

    test('CONNECTING -> CONNECTED is valid', () => {
      expect(lifecycle.isValidTransition('CONNECTING', 'CONNECTED')).toBe(true);
    });

    test('CONNECTED -> DISCONNECTED is valid', () => {
      expect(lifecycle.isValidTransition('CONNECTED', 'DISCONNECTED')).toBe(true);
    });

    test('CONNECTED -> ERROR is valid', () => {
      expect(lifecycle.isValidTransition('CONNECTED', 'ERROR')).toBe(true);
    });

    test('CREATED -> CONNECTED is invalid (must go through CONNECTING)', () => {
      expect(lifecycle.isValidTransition('CREATED', 'CONNECTED')).toBe(false);
    });

    test('canConnect returns true for connectable statuses', () => {
      expect(lifecycle.canPerform('connect', 'CREATED')).toBe(true);
      expect(lifecycle.canPerform('connect', 'DISCONNECTED')).toBe(true);
      expect(lifecycle.canPerform('connect', 'ERROR')).toBe(true);
    });

    test('canDisconnect returns true for CONNECTED', () => {
      expect(lifecycle.canPerform('disconnect', 'CONNECTED')).toBe(true);
      expect(lifecycle.canPerform('disconnect', 'CREATED')).toBe(false);
    });
  });
});

describe('validateTransitionWithHook', () => {
  const lifecycle = new LifecycleManager(PROJECT_TRANSITIONS);
  const context: PreTransitionContext = {
    projectId: 'proj-123',
    actorUserId: 'user-456',
  };

  test('valid transition + hook resolves -> resolves', async () => {
    const hook = jest.fn().mockResolvedValue(undefined);
    await expect(
      lifecycle.validateTransitionWithHook('CREATED', 'IN_PROGRESS', hook, context)
    ).resolves.toBeUndefined();
    expect(hook).toHaveBeenCalledTimes(1);
  });

  test('valid transition + hook throws -> propagates thrown error', async () => {
    const hookError = new Error('governance gate blocked');
    const hook = jest.fn().mockRejectedValue(hookError);
    await expect(
      lifecycle.validateTransitionWithHook('CREATED', 'IN_PROGRESS', hook, context)
    ).rejects.toThrow('governance gate blocked');
    expect(hook).toHaveBeenCalledTimes(1);
  });

  test('invalid transition -> throws WITHOUT calling the hook', async () => {
    const hook = jest.fn().mockResolvedValue(undefined);
    await expect(
      lifecycle.validateTransitionWithHook('CREATED', 'COMPLETED', hook, context)
    ).rejects.toThrow('Invalid status transition');
    expect(hook).not.toHaveBeenCalled();
  });

  test('same-status transition + hook resolves -> resolves (idempotent)', async () => {
    const hook = jest.fn().mockResolvedValue(undefined);
    await expect(
      lifecycle.validateTransitionWithHook('CREATED', 'CREATED', hook, context)
    ).resolves.toBeUndefined();
    expect(hook).toHaveBeenCalledTimes(1);
  });

  test('hook receives correct (current, next, context) arguments', async () => {
    const hook = jest.fn().mockResolvedValue(undefined);
    await lifecycle.validateTransitionWithHook(
      'IN_PROGRESS',
      'ASSESSMENT_COMPLETE',
      hook,
      context
    );
    expect(hook).toHaveBeenCalledWith('IN_PROGRESS', 'ASSESSMENT_COMPLETE', context);
  });
});

describe('REGISTRY_TRANSITIONS', () => {
  const lifecycle = new LifecycleManager(REGISTRY_TRANSITIONS);

  describe('valid transitions', () => {
    const validCases: [string, string][] = [
      ['DRAFT', 'PENDING_APPROVAL'],
      ['DRAFT', 'DEPRECATED'],
      ['PENDING_APPROVAL', 'APPROVED'],
      ['PENDING_APPROVAL', 'REJECTED'],
      ['REJECTED', 'DRAFT'],
      ['REJECTED', 'DEPRECATED'],
      ['APPROVED', 'DEPRECATED'],
    ];

    test.each(validCases)('%s → %s does not throw', (from, to) => {
      expect(() => lifecycle.validateTransition(from, to)).not.toThrow();
    });
  });

  describe('invalid transitions', () => {
    const invalidCases: [string, string][] = [
      ['DRAFT', 'APPROVED'],
      ['APPROVED', 'DRAFT'],
      ['DEPRECATED', 'DRAFT'],
      ['DEPRECATED', 'APPROVED'],
      ['REJECTED', 'APPROVED'],
    ];

    test.each(invalidCases)('%s → %s throws', (from, to) => {
      expect(() => lifecycle.validateTransition(from, to)).toThrow('Invalid status transition');
    });
  });

  test('terminal: DEPRECATED has no valid next statuses', () => {
    expect(lifecycle.getValidNextStatuses('DEPRECATED')).toEqual([]);
  });

  describe('idempotence: same-state transitions are valid', () => {
    const statuses = ['DRAFT', 'PENDING_APPROVAL', 'REJECTED', 'APPROVED', 'DEPRECATED'];

    test.each(statuses)('%s → %s is valid', (status) => {
      expect(lifecycle.isValidTransition(status, status)).toBe(true);
    });
  });

  describe('property: isValidTransition(a,b) === true implies validateTransition(a,b) does not throw', () => {
    const statuses = ['DRAFT', 'PENDING_APPROVAL', 'REJECTED', 'APPROVED', 'DEPRECATED'];
    const pairs: [string, string][] = [];
    for (const from of statuses) {
      for (const to of statuses) {
        pairs.push([from, to]);
      }
    }

    test.each(pairs)('(%s, %s) consistency', (from, to) => {
      if (lifecycle.isValidTransition(from, to)) {
        expect(() => lifecycle.validateTransition(from, to)).not.toThrow();
      }
    });
  });
});
