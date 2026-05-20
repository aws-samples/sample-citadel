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
