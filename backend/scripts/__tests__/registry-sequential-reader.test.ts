/**
 * Unit tests for scripts/lib/registry-sequential-reader.ts.
 *
 * Covers:
 *   - backoffDelay schedule (powers of 2)
 *   - isThrottleError recognises 'Request rate exceeded' and 429
 *   - withBackoff retries throttle errors, re-throws non-throttle
 *   - hydrateRecord classifies agent vs tool by manifest presence
 *   - readRegistrySequentially is strictly sequential
 *   - --limit caps the number of records processed
 *   - backoff on throttle during hydration
 */
import {
  backoffDelay,
  isThrottleError,
  withBackoff,
  hydrateRecord,
  readRegistrySequentially,
} from "../lib/registry-sequential-reader";
import { RegistryService } from "../../src/services/registry-service";

// ---------------------------------------------------------------------------
// Instant sleep for tests
// ---------------------------------------------------------------------------
const noopSleep = async (_ms: number): Promise<void> => {};

// ---------------------------------------------------------------------------
// backoffDelay
// ---------------------------------------------------------------------------

describe("backoffDelay", () => {
  it("produces powers-of-2 schedule with base 1000", () => {
    expect(backoffDelay(0, 1000)).toBe(1000);
    expect(backoffDelay(1, 1000)).toBe(2000);
    expect(backoffDelay(2, 1000)).toBe(4000);
    expect(backoffDelay(3, 1000)).toBe(8000);
    expect(backoffDelay(4, 1000)).toBe(16000);
    expect(backoffDelay(5, 1000)).toBe(32000);
  });
});

// ---------------------------------------------------------------------------
// isThrottleError
// ---------------------------------------------------------------------------

describe("isThrottleError", () => {
  it("recognises 'Request rate exceeded'", () => {
    expect(isThrottleError(new Error("Request rate exceeded"))).toBe(true);
  });

  it("recognises ThrottlingException by name", () => {
    const err = new Error("throttled");
    (err as { name: string }).name = "ThrottlingException";
    expect(isThrottleError(err)).toBe(true);
  });

  it("recognises HTTP 429", () => {
    const err = { $metadata: { httpStatusCode: 429 } };
    expect(isThrottleError(err)).toBe(true);
  });

  it("recognises HTTP 500", () => {
    const err = { $metadata: { httpStatusCode: 500 } };
    expect(isThrottleError(err)).toBe(true);
  });

  it("rejects a plain Error", () => {
    expect(isThrottleError(new Error("not found"))).toBe(false);
  });

  it("rejects HTTP 404", () => {
    const err = { $metadata: { httpStatusCode: 404 } };
    expect(isThrottleError(err)).toBe(false);
  });
});

// ---------------------------------------------------------------------------
// withBackoff
// ---------------------------------------------------------------------------

describe("withBackoff", () => {
  it("returns on first success", async () => {
    const fn = jest.fn().mockResolvedValue("ok");
    const result = await withBackoff(fn, 3, 100, noopSleep);
    expect(result).toBe("ok");
    expect(fn).toHaveBeenCalledTimes(1);
  });

  it("retries on throttle error then succeeds", async () => {
    const throttleErr = new Error("Request rate exceeded");
    const fn = jest
      .fn()
      .mockRejectedValueOnce(throttleErr)
      .mockRejectedValueOnce(throttleErr)
      .mockResolvedValue("ok");
    const result = await withBackoff(fn, 6, 100, noopSleep);
    expect(result).toBe("ok");
    expect(fn).toHaveBeenCalledTimes(3);
  });

  it("throws non-throttle errors immediately", async () => {
    const fn = jest.fn().mockRejectedValue(new Error("not found"));
    await expect(withBackoff(fn, 3, 100, noopSleep)).rejects.toThrow(
      "not found",
    );
    expect(fn).toHaveBeenCalledTimes(1);
  });

  it("throws after exhausting all attempts", async () => {
    const throttleErr = new Error("Request rate exceeded");
    const fn = jest.fn().mockRejectedValue(throttleErr);
    await expect(withBackoff(fn, 3, 100, noopSleep)).rejects.toThrow(
      "Request rate exceeded",
    );
    expect(fn).toHaveBeenCalledTimes(3);
  });
});

// ---------------------------------------------------------------------------
// hydrateRecord
// ---------------------------------------------------------------------------

describe("hydrateRecord", () => {
  function fakeRegistry(descriptorData?: string): RegistryService {
    const mockSend = jest.fn().mockResolvedValue({
      recordId: "rec1",
      name: "my-agent",
      status: "DRAFT",
      descriptors:
        descriptorData !== undefined
          ? { custom: { data: descriptorData } }
          : {},
    });
    return {
      getClient: () => ({ send: mockSend }),
      getRegistryId: () => "reg-1",
    } as unknown as RegistryService;
  }

  it("classifies a record with manifest as agent", async () => {
    const registry = fakeRegistry(JSON.stringify({ manifest: {} }));
    const result = await hydrateRecord(registry, "rec1", noopSleep);
    expect(result).not.toBeNull();
    expect(result!.resourceType).toBe("agent");
    expect(result!.record.recordId).toBe("rec1");
    expect(result!.record.customDescriptorContent).toContain("manifest");
  });

  it("classifies a record without manifest as tool", async () => {
    const registry = fakeRegistry(JSON.stringify({ categories: [] }));
    const result = await hydrateRecord(registry, "rec1", noopSleep);
    expect(result!.resourceType).toBe("tool");
  });

  it("defaults to agent on parse failure", async () => {
    const registry = fakeRegistry("{bad json");
    const result = await hydrateRecord(registry, "rec1", noopSleep);
    expect(result!.resourceType).toBe("agent");
  });
});

// ---------------------------------------------------------------------------
// readRegistrySequentially: strict sequential ordering
// ---------------------------------------------------------------------------

describe("readRegistrySequentially — sequential ordering", () => {
  it("fetches records strictly sequentially (call log is ordered)", async () => {
    const callLog: string[] = [];

    const summaries = [
      { recordId: "rec-A", name: "a", status: "DRAFT" },
      { recordId: "rec-B", name: "b", status: "DRAFT" },
      { recordId: "rec-C", name: "c", status: "DRAFT" },
      { recordId: "rec-D", name: "d", status: "DRAFT" },
    ];

    const mockSend = jest.fn().mockImplementation((cmd: unknown) => {
      const recordId = (cmd as { input: { recordId: string } }).input.recordId;
      callLog.push(recordId);
      return Promise.resolve({
        recordId,
        name: recordId,
        status: "DRAFT",
        descriptors: {
          custom: { data: JSON.stringify({ categories: [] }) },
        },
      });
    });

    const registry = {
      listResourceSummaries: jest.fn().mockResolvedValue(summaries),
      getClient: () => ({ send: mockSend }),
      getRegistryId: () => "reg-1",
    } as unknown as RegistryService;

    await readRegistrySequentially(registry, {
      delayMs: 0,
      limit: Infinity,
      sleepFn: noopSleep,
    });

    expect(callLog).toEqual(["rec-A", "rec-B", "rec-C", "rec-D"]);
  });
});

// ---------------------------------------------------------------------------
// readRegistrySequentially: --limit
// ---------------------------------------------------------------------------

describe("readRegistrySequentially — limit", () => {
  it("processes at most --limit records", async () => {
    const summaries = [
      { recordId: "rec-1", name: "a", status: "DRAFT" },
      { recordId: "rec-2", name: "b", status: "DRAFT" },
      { recordId: "rec-3", name: "c", status: "DRAFT" },
      { recordId: "rec-4", name: "d", status: "DRAFT" },
      { recordId: "rec-5", name: "e", status: "DRAFT" },
    ];

    const callLog: string[] = [];

    const mockSend = jest.fn().mockImplementation((cmd: unknown) => {
      const recordId = (cmd as { input: { recordId: string } }).input.recordId;
      callLog.push(recordId);
      return Promise.resolve({
        recordId,
        name: recordId,
        status: "DRAFT",
        descriptors: {
          custom: { data: JSON.stringify({ categories: [] }) },
        },
      });
    });

    const registry = {
      listResourceSummaries: jest.fn().mockResolvedValue(summaries),
      getClient: () => ({ send: mockSend }),
      getRegistryId: () => "reg-1",
    } as unknown as RegistryService;

    const result = await readRegistrySequentially(registry, {
      delayMs: 0,
      limit: 2,
      sleepFn: noopSleep,
    });

    expect(callLog).toHaveLength(2);
    expect(callLog).toEqual(["rec-1", "rec-2"]);
    expect(result.agents.length + result.tools.length).toBeLessThanOrEqual(2);
  });

  it("treats limit=0 as unlimited", async () => {
    const summaries = [
      { recordId: "rec-1", name: "a", status: "DRAFT" },
      { recordId: "rec-2", name: "b", status: "DRAFT" },
    ];

    const callLog: string[] = [];
    const mockSend = jest.fn().mockImplementation((cmd: unknown) => {
      const recordId = (cmd as { input: { recordId: string } }).input.recordId;
      callLog.push(recordId);
      return Promise.resolve({
        recordId,
        name: recordId,
        status: "DRAFT",
        descriptors: {
          custom: { data: JSON.stringify({ categories: [] }) },
        },
      });
    });

    const registry = {
      listResourceSummaries: jest.fn().mockResolvedValue(summaries),
      getClient: () => ({ send: mockSend }),
      getRegistryId: () => "reg-1",
    } as unknown as RegistryService;

    await readRegistrySequentially(registry, {
      delayMs: 0,
      limit: 0,
      sleepFn: noopSleep,
    });

    expect(callLog).toEqual(["rec-1", "rec-2"]);
  });
});

// ---------------------------------------------------------------------------
// readRegistrySequentially: backoff on throttle
// ---------------------------------------------------------------------------

describe("readRegistrySequentially — backoff on throttle", () => {
  it("retries throttled GETs with backoff and eventually succeeds", async () => {
    const summaries = [{ recordId: "rec-1", name: "a", status: "DRAFT" }];

    let attempt = 0;
    const mockSend = jest.fn().mockImplementation(() => {
      attempt++;
      if (attempt <= 2) {
        return Promise.reject(new Error("Request rate exceeded"));
      }
      return Promise.resolve({
        recordId: "rec-1",
        name: "a",
        status: "DRAFT",
        descriptors: {
          custom: { data: JSON.stringify({ categories: [] }) },
        },
      });
    });

    const registry = {
      listResourceSummaries: jest.fn().mockResolvedValue(summaries),
      getClient: () => ({ send: mockSend }),
      getRegistryId: () => "reg-1",
    } as unknown as RegistryService;

    const result = await readRegistrySequentially(registry, {
      delayMs: 0,
      limit: Infinity,
      sleepFn: noopSleep,
    });

    expect(mockSend).toHaveBeenCalledTimes(3);
    expect(result.errors).toBe(0);
    expect(result.agents.length + result.tools.length).toBe(1);
  });
});
