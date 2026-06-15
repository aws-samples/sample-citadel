import {
  isValidTransition,
  validateTransition,
  getValidNextStatuses,
  getStatusAfterSuccessfulTest,
  getStatusAfterFailedTest,
  getStatusAfterConnection,
  canTest,
  canConnect,
  canDisconnect,
  type IntegrationStatus
} from '../lifecycle-validator';

describe('lifecycle-validator', () => {
  describe('isValidTransition', () => {
    it('should allow CREATED → CONFIGURED', () => {
      expect(isValidTransition('CREATED', 'CONFIGURED')).toBe(true);
    });

    it('should allow CONFIGURED → TESTED', () => {
      expect(isValidTransition('CONFIGURED', 'TESTED')).toBe(true);
    });

    it('should allow TESTED → CONNECTING', () => {
      expect(isValidTransition('TESTED', 'CONNECTING')).toBe(true);
    });

    it('should allow CONNECTING → CONNECTED', () => {
      expect(isValidTransition('CONNECTING', 'CONNECTED')).toBe(true);
    });

    it('should allow CONNECTING → CONNECTION_FAILED', () => {
      expect(isValidTransition('CONNECTING', 'CONNECTION_FAILED')).toBe(true);
    });

    it('should allow CONNECTED → DISCONNECTED', () => {
      expect(isValidTransition('CONNECTED', 'DISCONNECTED')).toBe(true);
    });

    it('should allow DISCONNECTED → CONFIGURED', () => {
      expect(isValidTransition('DISCONNECTED', 'CONFIGURED')).toBe(true);
    });

    it('should allow DISCONNECTED → CONNECTING', () => {
      expect(isValidTransition('DISCONNECTED', 'CONNECTING')).toBe(true);
    });

    it('should allow CONNECTION_FAILED → CONFIGURED', () => {
      expect(isValidTransition('CONNECTION_FAILED', 'CONFIGURED')).toBe(true);
    });

    it('should allow CONNECTION_FAILED → CONNECTING', () => {
      expect(isValidTransition('CONNECTION_FAILED', 'CONNECTING')).toBe(true);
    });

    it('should allow CONNECTION_FAILED → TESTED', () => {
      expect(isValidTransition('CONNECTION_FAILED', 'TESTED')).toBe(true);
    });

    it('should allow same status (idempotent)', () => {
      expect(isValidTransition('CONFIGURED', 'CONFIGURED')).toBe(true);
      expect(isValidTransition('TESTED', 'TESTED')).toBe(true);
      expect(isValidTransition('CONNECTED', 'CONNECTED')).toBe(true);
    });

    it('should reject CREATED → TESTED (skipping CONFIGURED)', () => {
      expect(isValidTransition('CREATED', 'TESTED')).toBe(false);
    });

    it('should reject CREATED → CONNECTED (skipping intermediate states)', () => {
      expect(isValidTransition('CREATED', 'CONNECTED')).toBe(false);
    });

    it('should reject CONFIGURED → CONNECTED (skipping TESTED)', () => {
      expect(isValidTransition('CONFIGURED', 'CONNECTED')).toBe(false);
    });

    it('should reject TESTED → DISCONNECTED (must be CONNECTED first)', () => {
      expect(isValidTransition('TESTED', 'DISCONNECTED')).toBe(false);
    });

    it('should allow re-configuration from any state', () => {
      expect(isValidTransition('TESTED', 'CONFIGURED')).toBe(true);
      expect(isValidTransition('CONNECTED', 'CONFIGURED')).toBe(true);
      expect(isValidTransition('DISCONNECTED', 'CONFIGURED')).toBe(true);
    });
  });

  describe('validateTransition', () => {
    it('should not throw for valid transitions', () => {
      expect(() => validateTransition('CREATED', 'CONFIGURED')).not.toThrow();
      expect(() => validateTransition('CONFIGURED', 'TESTED')).not.toThrow();
      expect(() => validateTransition('TESTED', 'CONNECTING')).not.toThrow();
    });

    it('should throw for invalid transitions', () => {
      expect(() => validateTransition('CREATED', 'TESTED')).toThrow(
        'Invalid status transition: CREATED → TESTED'
      );
      expect(() => validateTransition('CREATED', 'CONNECTED')).toThrow(
        'Invalid status transition: CREATED → CONNECTED'
      );
    });

    it('should include valid transitions in error message', () => {
      try {
        validateTransition('CREATED', 'TESTED');
        fail('Should have thrown');
      } catch (error: any) {
        expect(error.message).toContain('Valid transitions from CREATED');
        expect(error.message).toContain('CONFIGURED');
      }
    });
  });

  describe('getValidNextStatuses', () => {
    it('should return valid next statuses for CREATED', () => {
      const next = getValidNextStatuses('CREATED');
      expect(next).toContain('CONFIGURED');
      expect(next).toContain('CONFIGURING');
    });

    it('should return valid next statuses for CONFIGURED', () => {
      const next = getValidNextStatuses('CONFIGURED');
      expect(next).toContain('TESTED');
      expect(next).toContain('CONNECTING');
      expect(next).toContain('CONFIGURED');
    });

    it('should return valid next statuses for TESTED', () => {
      const next = getValidNextStatuses('TESTED');
      expect(next).toContain('CONNECTING');
      expect(next).toContain('CONFIGURED');
      expect(next).toContain('TESTED');
    });

    it('should return valid next statuses for CONNECTING', () => {
      const next = getValidNextStatuses('CONNECTING');
      expect(next).toContain('CONNECTED');
      expect(next).toContain('CONNECTION_FAILED');
    });

    it('should return valid next statuses for CONNECTED', () => {
      const next = getValidNextStatuses('CONNECTED');
      expect(next).toContain('DISCONNECTED');
      expect(next).toContain('CONFIGURED');
    });
  });

  describe('getStatusAfterSuccessfulTest', () => {
    it('should return TESTED after successful test', () => {
      expect(getStatusAfterSuccessfulTest('CONFIGURED')).toBe('TESTED');
      expect(getStatusAfterSuccessfulTest('TESTED')).toBe('TESTED');
      expect(getStatusAfterSuccessfulTest('DISCONNECTED')).toBe('TESTED');
    });
  });

  describe('getStatusAfterFailedTest', () => {
    it('should keep current status after failed test', () => {
      expect(getStatusAfterFailedTest('CONFIGURED')).toBe('CONFIGURED');
      expect(getStatusAfterFailedTest('TESTED')).toBe('TESTED');
      expect(getStatusAfterFailedTest('DISCONNECTED')).toBe('DISCONNECTED');
    });
  });

  describe('getStatusAfterConnection', () => {
    it('should return CONNECTED after successful connection', () => {
      expect(getStatusAfterConnection(true)).toBe('CONNECTED');
    });

    it('should return CONNECTION_FAILED after failed connection', () => {
      expect(getStatusAfterConnection(false)).toBe('CONNECTION_FAILED');
    });
  });

  describe('canTest', () => {
    it('should allow testing from CONFIGURED', () => {
      expect(canTest('CONFIGURED')).toBe(true);
    });

    it('should allow testing from TESTED', () => {
      expect(canTest('TESTED')).toBe(true);
    });

    it('should allow testing from CONNECTED', () => {
      expect(canTest('CONNECTED')).toBe(true);
    });

    it('should allow testing from DISCONNECTED', () => {
      expect(canTest('DISCONNECTED')).toBe(true);
    });

    it('should allow testing from CONNECTION_FAILED', () => {
      expect(canTest('CONNECTION_FAILED')).toBe(true);
    });

    it('should not allow testing from CREATED', () => {
      expect(canTest('CREATED')).toBe(false);
    });

    it('should not allow testing from CONNECTING', () => {
      expect(canTest('CONNECTING')).toBe(false);
    });
  });

  describe('canConnect', () => {
    it('should allow connecting from TESTED', () => {
      expect(canConnect('TESTED')).toBe(true);
    });

    it('should allow connecting from CONFIGURED', () => {
      expect(canConnect('CONFIGURED')).toBe(true);
    });

    it('should allow connecting from DISCONNECTED', () => {
      expect(canConnect('DISCONNECTED')).toBe(true);
    });

    it('should allow connecting from CONNECTION_FAILED', () => {
      expect(canConnect('CONNECTION_FAILED')).toBe(true);
    });

    it('should not allow connecting from CREATED', () => {
      expect(canConnect('CREATED')).toBe(false);
    });

    it('should not allow connecting from CONNECTING', () => {
      expect(canConnect('CONNECTING')).toBe(false);
    });

    it('should not allow connecting from CONNECTED', () => {
      expect(canConnect('CONNECTED')).toBe(false);
    });
  });

  describe('canDisconnect', () => {
    it('should allow disconnecting from CONNECTED', () => {
      expect(canDisconnect('CONNECTED')).toBe(true);
    });

    it('should not allow disconnecting from other statuses', () => {
      expect(canDisconnect('CREATED')).toBe(false);
      expect(canDisconnect('CONFIGURED')).toBe(false);
      expect(canDisconnect('TESTED')).toBe(false);
      expect(canDisconnect('CONNECTING')).toBe(false);
      expect(canDisconnect('DISCONNECTED')).toBe(false);
      expect(canDisconnect('CONNECTION_FAILED')).toBe(false);
    });
  });

  describe('lifecycle flow', () => {
    it('should support complete happy path: CREATED → CONFIGURED → TESTED → CONNECTING → CONNECTED → DISCONNECTED', () => {
      expect(isValidTransition('CREATED', 'CONFIGURED')).toBe(true);
      expect(isValidTransition('CONFIGURED', 'TESTED')).toBe(true);
      expect(isValidTransition('TESTED', 'CONNECTING')).toBe(true);
      expect(isValidTransition('CONNECTING', 'CONNECTED')).toBe(true);
      expect(isValidTransition('CONNECTED', 'DISCONNECTED')).toBe(true);
    });

    it('should support connection failure path: TESTED → CONNECTING → CONNECTION_FAILED → CONFIGURED', () => {
      expect(isValidTransition('TESTED', 'CONNECTING')).toBe(true);
      expect(isValidTransition('CONNECTING', 'CONNECTION_FAILED')).toBe(true);
      expect(isValidTransition('CONNECTION_FAILED', 'CONFIGURED')).toBe(true);
    });

    it('should support reconnection path: DISCONNECTED → CONNECTING → CONNECTED', () => {
      expect(isValidTransition('DISCONNECTED', 'CONNECTING')).toBe(true);
      expect(isValidTransition('CONNECTING', 'CONNECTED')).toBe(true);
    });

    it('should support reconfiguration from any state', () => {
      const statuses: IntegrationStatus[] = [
        'TESTED', 'CONNECTED', 'DISCONNECTED', 'CONNECTION_FAILED'
      ];
      
      statuses.forEach(status => {
        expect(isValidTransition(status, 'CONFIGURED')).toBe(true);
      });
    });
  });
});
