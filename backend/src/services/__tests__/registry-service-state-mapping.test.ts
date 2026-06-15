/**
 * Unit tests for RegistryService state mapping methods:
 * - toRegistryStatus: internal state → Registry status
 * - toInternalState: Registry status → internal state
 *
 * Validates: Requirements 12.1, 12.2, 12.3, 12.4, 12.5, 12.6
 */

import {
  RegistryService,
  RegistryRecordStatusValues,
} from '../registry-service';

// Mock the SDK client so we don't need real AWS credentials
jest.mock('@aws-sdk/client-bedrock-agentcore-control', () => ({
  BedrockAgentCoreControlClient: jest.fn().mockImplementation(() => ({})),
  CreateRegistryRecordCommand: jest.fn(),
  GetRegistryRecordCommand: jest.fn(),
  UpdateRegistryRecordCommand: jest.fn(),
  UpdateRegistryRecordStatusCommand: jest.fn(),
  DeleteRegistryRecordCommand: jest.fn(),
  ListRegistryRecordsCommand: jest.fn(),
}));

describe('RegistryService state mapping', () => {
  let service: RegistryService;

  beforeEach(() => {
    service = new RegistryService({
      registryId: 'test-registry',
      region: 'us-east-1',
    });
    jest.spyOn(console, 'warn').mockImplementation(() => {});
  });

  afterEach(() => {
    jest.restoreAllMocks();
  });

  // -- toRegistryStatus ----------------------------------------------------

  describe('toRegistryStatus', () => {
    it('maps "active" to APPROVED', () => {
      expect(service.toRegistryStatus('active')).toBe(
        RegistryRecordStatusValues.APPROVED,
      );
    });

    it('maps "inactive" to DEPRECATED', () => {
      expect(service.toRegistryStatus('inactive')).toBe(
        RegistryRecordStatusValues.DEPRECATED,
      );
    });

    it('maps "maintenance" to DRAFT', () => {
      expect(service.toRegistryStatus('maintenance')).toBe(
        RegistryRecordStatusValues.DRAFT,
      );
    });

    it('maps unknown state to DEPRECATED with warning', () => {
      expect(service.toRegistryStatus('bogus')).toBe(
        RegistryRecordStatusValues.DEPRECATED,
      );
      expect(console.warn).toHaveBeenCalledWith(
        expect.stringContaining('bogus'),
      );
    });

    it('maps empty string to DEPRECATED with warning', () => {
      expect(service.toRegistryStatus('')).toBe(
        RegistryRecordStatusValues.DEPRECATED,
      );
      expect(console.warn).toHaveBeenCalled();
    });
  });

  // -- toInternalState -----------------------------------------------------

  describe('toInternalState', () => {
    it('maps APPROVED to "active"', () => {
      expect(service.toInternalState('APPROVED')).toBe('active');
    });

    it('maps UPDATING to "active"', () => {
      expect(service.toInternalState('UPDATING')).toBe('active');
    });

    it('maps PENDING_APPROVAL to "active"', () => {
      expect(service.toInternalState('PENDING_APPROVAL')).toBe('active');
    });

    it('maps DRAFT to "maintenance"', () => {
      expect(service.toInternalState('DRAFT')).toBe('maintenance');
    });

    it('maps CREATING to "maintenance"', () => {
      expect(service.toInternalState('CREATING')).toBe('maintenance');
    });

    it('maps DEPRECATED to "inactive"', () => {
      expect(service.toInternalState('DEPRECATED')).toBe('inactive');
    });

    it('maps REJECTED to "inactive"', () => {
      expect(service.toInternalState('REJECTED')).toBe('inactive');
    });

    it('maps CREATE_FAILED to "inactive"', () => {
      expect(service.toInternalState('CREATE_FAILED')).toBe('inactive');
    });

    it('maps UPDATE_FAILED to "inactive"', () => {
      expect(service.toInternalState('UPDATE_FAILED')).toBe('inactive');
    });

    it('maps unknown status to "inactive" with warning', () => {
      expect(service.toInternalState('SomethingNew')).toBe('inactive');
      expect(console.warn).toHaveBeenCalledWith(
        expect.stringContaining('SomethingNew'),
      );
    });

    it('maps empty string to "inactive" with warning', () => {
      expect(service.toInternalState('')).toBe('inactive');
      expect(console.warn).toHaveBeenCalled();
    });

    it('maps undefined to "inactive" with warning', () => {
      expect(service.toInternalState(undefined)).toBe('inactive');
      expect(console.warn).toHaveBeenCalled();
    });
  });
});
