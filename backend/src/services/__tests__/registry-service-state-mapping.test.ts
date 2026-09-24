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
} from "../registry-service";

// Mock the SDK client so we don't need real AWS credentials
jest.mock("@aws-sdk/client-agent-registry-control", () => ({
  AgentRegistryControlClient: jest.fn().mockImplementation(() => ({})),
  CreateRegistryRecordCommand: jest.fn(),
  GetRegistryRecordCommand: jest.fn(),
  UpdateRegistryRecordCommand: jest.fn(),
  UpdateRegistryRecordStatusCommand: jest.fn(),
  DeleteRegistryRecordCommand: jest.fn(),
  ListRegistryRecordsCommand: jest.fn(),
}));

import { RegistryLifecycleError } from "../registry-service";

describe("RegistryService state mapping", () => {
  let service: RegistryService;

  beforeEach(() => {
    service = new RegistryService({
      registryId: "test-registry",
      region: "us-east-1",
    });
    jest.spyOn(console, "warn").mockImplementation(() => {});
  });

  afterEach(() => {
    jest.restoreAllMocks();
  });

  // -- toRegistryStatus ----------------------------------------------------

  describe("toRegistryStatus", () => {
    it('maps "active" to APPROVED', () => {
      expect(service.toRegistryStatus("active")).toBe(
        RegistryRecordStatusValues.APPROVED,
      );
    });

    it('maps "maintenance" to DEPRECATED (deprecate intent, decision 3d5843e9/finding 462c17ad)', () => {
      expect(service.toRegistryStatus("maintenance")).toBe(
        RegistryRecordStatusValues.DEPRECATED,
      );
    });

    it('throws a structured RegistryLifecycleError for "inactive" (decision 3d5843e9 supersedes a3fb5542; finding 462c17ad: the registry rejects DRAFT as an UpdateRegistryRecordStatus target)', () => {
      expect(() => service.toRegistryStatus("inactive")).toThrow(
        RegistryLifecycleError,
      );
      expect(() => service.toRegistryStatus("inactive")).toThrow(
        "inactive is not a registry-backed transition; use deprecate",
      );
    });

    it("throws a structured RegistryLifecycleError for an unknown state", () => {
      expect(() => service.toRegistryStatus("bogus")).toThrow(
        RegistryLifecycleError,
      );
      expect(() => service.toRegistryStatus("bogus")).toThrow(/bogus/);
    });

    it("throws a structured RegistryLifecycleError for an empty string", () => {
      expect(() => service.toRegistryStatus("")).toThrow(
        RegistryLifecycleError,
      );
    });
  });

  // -- toInternalState -----------------------------------------------------

  describe("toInternalState", () => {
    it('maps APPROVED to "active"', () => {
      expect(service.toInternalState("APPROVED")).toBe("active");
    });

    it('maps UPDATING to "active"', () => {
      expect(service.toInternalState("UPDATING")).toBe("active");
    });

    it('maps PENDING_APPROVAL to "active"', () => {
      expect(service.toInternalState("PENDING_APPROVAL")).toBe("active");
    });

    it('maps DRAFT to "maintenance"', () => {
      expect(service.toInternalState("DRAFT")).toBe("maintenance");
    });

    it('maps CREATING to "maintenance"', () => {
      expect(service.toInternalState("CREATING")).toBe("maintenance");
    });

    it('maps DEPRECATED to "inactive"', () => {
      expect(service.toInternalState("DEPRECATED")).toBe("inactive");
    });

    it('maps REJECTED to "inactive"', () => {
      expect(service.toInternalState("REJECTED")).toBe("inactive");
    });

    it('maps CREATE_FAILED to "inactive"', () => {
      expect(service.toInternalState("CREATE_FAILED")).toBe("inactive");
    });

    it('maps UPDATE_FAILED to "inactive"', () => {
      expect(service.toInternalState("UPDATE_FAILED")).toBe("inactive");
    });

    it('maps unknown status to "inactive" with warning', () => {
      expect(service.toInternalState("SomethingNew")).toBe("inactive");
      expect(console.warn).toHaveBeenCalledWith(
        expect.stringContaining("SomethingNew"),
      );
    });

    it('maps empty string to "inactive" with warning', () => {
      expect(service.toInternalState("")).toBe("inactive");
      expect(console.warn).toHaveBeenCalled();
    });

    it('maps undefined to "inactive" with warning', () => {
      expect(service.toInternalState(undefined)).toBe("inactive");
      expect(console.warn).toHaveBeenCalled();
    });
  });
});
