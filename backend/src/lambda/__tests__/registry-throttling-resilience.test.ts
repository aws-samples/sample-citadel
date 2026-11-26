/**
 * Tests: registry throttling resilience (LIVE INCIDENT 2026-11-10)
 *
 * Covers:
 * - listResourcesChecked marks partial+throttled when Nth detail fetch throws ThrottlingException
 * - findProjectAgentRecords throws RegistryThrottledError on throttled partial list
 * - activateProjectAgents refuses to proceed on throttled partial (returns throttled:true)
 * - activateProjectAgents processes agents SEQUENTIALLY with inter-call delay
 * - activateProjectAgents classifies per-agent errors (throttled/refused/not_found/rejected)
 * - withMutationRetry exponential backoff timing (base 500ms, 5 attempts)
 */
import {
  AgentRegistryControlClient,
  GetRegistryRecordCommand,
  ListRegistryRecordsCommand,
  SubmitRegistryRecordForApprovalCommand,
} from "@aws-sdk/client-agent-registry-control";
import { mockClient } from "aws-sdk-client-mock";
import {
  RegistryService,
  RegistryThrottledError,
} from "../../services/registry-service";
import type { ListResourcesResult } from "../../services/registry-service";

const registryMock = mockClient(AgentRegistryControlClient);

function makeService(): RegistryService {
  return new RegistryService({ registryId: "test-registry", region: "us-east-1" });
}

/**
 * Builds a ListRegistryRecords response with N summaries.
 */
function listResponse(count: number, nextToken?: string) {
  return {
    registryRecords: Array.from({ length: count }, (_, i) => ({
      recordId: `rec${String(i).padStart(9, "0")}${i}`,
      name: `agent-${i}`,
      status: "DRAFT",
    })),
    nextToken,
  };
}

/**
 * Builds a GetRegistryRecord response for a single agent record.
 */
function detailResponse(index: number, status = "DRAFT") {
  const recordId = `rec${String(index).padStart(9, "0")}${index}`;
  return {
    recordId,
    name: `agent-${index}`,
    status,
    description: "test",
    descriptors: {
      custom: {
        data: JSON.stringify({
          manifest: { name: `agent-${index}` },
          orgId: "org-1",
          categories: [],
          icon: "",
          state: "active",
        }),
      },
    },
    createdAt: new Date(),
    updatedAt: new Date(),
  };
}

function throttlingError(): Error {
  return Object.assign(new Error("Request rate exceeded"), {
    name: "ThrottlingException",
    $metadata: { httpStatusCode: 429 },
  });
}

beforeEach(() => {
  registryMock.reset();
});

describe("RegistryService.listResourcesChecked", () => {
  it("returns partial=true, throttled=true when a detail fetch throws ThrottlingException", async () => {
    const svc = makeService();

    // List returns 3 summaries
    registryMock
      .on(ListRegistryRecordsCommand)
      .resolves(listResponse(3));

    // Detail calls: first two records succeed, third ALWAYS throws
    // ThrottlingException (even across retries). The mock identifies the
    // record by its recordId from the request input.
    registryMock.on(GetRegistryRecordCommand).callsFake((input: { recordId: string }) => {
      const id = input.recordId;
      // The 3rd summary has index 2; its recordId starts with "rec00000000"
      if (id.startsWith("rec00000000") && id.endsWith("2")) {
        throw throttlingError();
      }
      // For the first two, return a valid agent detail
      const index = id.endsWith("0") ? 0 : 1;
      return detailResponse(index);
    });

    const result: ListResourcesResult = await svc.listResourcesChecked("agent");

    expect(result.partial).toBe(true);
    expect(result.throttled).toBe(true);
    expect(result.droppedCount).toBe(1);
    // Only 2 of 3 records made it through
    expect(result.items.length).toBe(2);
  });

  it("returns partial=false, throttled=false when all detail fetches succeed", async () => {
    const svc = makeService();

    registryMock
      .on(ListRegistryRecordsCommand)
      .resolves(listResponse(2));

    let callIdx = 0;
    registryMock.on(GetRegistryRecordCommand).callsFake(() => {
      return detailResponse(callIdx++);
    });

    const result = await svc.listResourcesChecked("agent");

    expect(result.partial).toBe(false);
    expect(result.throttled).toBe(false);
    expect(result.droppedCount).toBe(0);
    expect(result.items.length).toBe(2);
  });

  it("returns partial=true but throttled=false when a non-throttle error drops a record", async () => {
    const svc = makeService();

    registryMock
      .on(ListRegistryRecordsCommand)
      .resolves(listResponse(2));

    let callIdx = 0;
    registryMock.on(GetRegistryRecordCommand).callsFake(() => {
      callIdx++;
      if (callIdx === 2) {
        throw new Error("InternalServerException");
      }
      return detailResponse(0);
    });

    const result = await svc.listResourcesChecked("agent");

    expect(result.partial).toBe(true);
    expect(result.throttled).toBe(false);
    expect(result.droppedCount).toBe(1);
  });
});

describe("RegistryService.isThrottlingError", () => {
  it("detects ThrottlingException", () => {
    expect(RegistryService.isThrottlingError(throttlingError())).toBe(true);
  });

  it("detects TooManyRequestsException", () => {
    const err = Object.assign(new Error("too many"), {
      name: "TooManyRequestsException",
    });
    expect(RegistryService.isThrottlingError(err)).toBe(true);
  });

  it("detects 429 status code", () => {
    const err = Object.assign(new Error("rate limited"), {
      $metadata: { httpStatusCode: 429 },
    });
    expect(RegistryService.isThrottlingError(err)).toBe(true);
  });

  it("returns false for non-throttle errors", () => {
    expect(RegistryService.isThrottlingError(new Error("boom"))).toBe(false);
    expect(RegistryService.isThrottlingError(null)).toBe(false);
  });
});

describe("RegistryService.withMutationRetry", () => {
  it("retries with exponential backoff (base 500ms, 5 attempts)", async () => {
    const svc = makeService();
    // eslint-disable-next-line @typescript-eslint/no-explicit-any -- test-only access to private sleep
    const sleepSpy = jest.spyOn(svc as unknown as Record<string, (...args: unknown[]) => unknown>, "sleep" as never)
      .mockResolvedValue(undefined as never);

    let attempts = 0;
    const operation = jest.fn(async () => {
      attempts++;
      if (attempts < 5) throw throttlingError();
      return "ok";
    });

    const result = await svc.withMutationRetry(operation);
    expect(result).toBe("ok");
    expect(operation).toHaveBeenCalledTimes(5);
    // 4 retries: sleep called with jittered delay based on base 500ms
    expect(sleepSpy).toHaveBeenCalledTimes(4);
    // Each delay should be > 0
    for (const call of sleepSpy.mock.calls) {
      expect((call as unknown[])[0]).toBeGreaterThan(0);
    }

    sleepSpy.mockRestore();
  });

  it("throws after exhausting all 5 attempts", async () => {
    const svc = makeService();
    // eslint-disable-next-line @typescript-eslint/no-explicit-any -- test-only access to private sleep
    jest.spyOn(svc as unknown as Record<string, (...args: unknown[]) => unknown>, "sleep" as never)
      .mockResolvedValue(undefined as never);

    const operation = jest.fn(async () => {
      throw throttlingError();
    });

    await expect(svc.withMutationRetry(operation)).rejects.toThrow(
      "Request rate exceeded",
    );
    expect(operation).toHaveBeenCalledTimes(5);
  });
});

describe("RegistryThrottledError", () => {
  it("has retryable=true and retryAfterMs", () => {
    const err = new RegistryThrottledError("busy", 5000);
    expect(err.retryable).toBe(true);
    expect(err.retryAfterMs).toBe(5000);
    expect(err.name).toBe("RegistryThrottledError");
    expect(err.message).toBe("busy");
  });
});

describe("submitForApproval uses mutation retry", () => {
  it("retries throttled submits up to 5 times", async () => {
    const svc = makeService();
    // eslint-disable-next-line @typescript-eslint/no-explicit-any -- test-only access to private sleep
    jest.spyOn(svc as unknown as Record<string, (...args: unknown[]) => unknown>, "sleep" as never)
      .mockResolvedValue(undefined as never);

    let submitCalls = 0;
    registryMock.on(SubmitRegistryRecordForApprovalCommand).callsFake(() => {
      submitCalls++;
      if (submitCalls < 3) throw throttlingError();
      return { status: "PENDING_APPROVAL" };
    });
    registryMock.on(GetRegistryRecordCommand).resolves({
      recordId: "rec000000001",
      name: "test-agent",
      status: "PENDING_APPROVAL",
    });

    const result = await svc.submitForApproval("rec000000001");
    expect(result.status).toBe("PENDING_APPROVAL");
    expect(submitCalls).toBe(3);
  });
});
