/**
 * Unit tests for RegistryService.resolveRecordId LRU caching:
 * - 12-char recordId fast path bypasses cache (no registry call)
 * - Registry ARN fast path bypasses cache (no registry call)
 * - Name lookup populates cache; second call avoids re-enumeration
 * - TTL expiry forces a re-enumeration
 * - LRU eviction at capacity (oldest insertion drops first)
 * - Manual clearRecordIdCache() empties the cache
 *
 * The cache is per-instance and bounded by size + TTL. These tests stub the
 * SDK client's `send` directly. Most cases here (ListRegistryRecordsCommand
 * only) confirm the bounded enumeration fallback issues no GetRegistryRecord
 * calls when a name has a single exact match — the "keeps separate cache
 * entries per resource type" case below is the one exception: it exercises
 * resolveRecordId's per-collision disambiguation (finding 8304fa1b, decision
 * 84ee7227), which DOES issue a bounded GetRegistryRecord per colliding
 * candidate, so that test also stubs GetRegistryRecordCommand.
 */

import { RegistryService } from "../registry-service";

const sendMock = jest.fn();

jest.mock("@aws-sdk/client-bedrock-agentcore-control", () => ({
  BedrockAgentCoreControlClient: jest.fn().mockImplementation(() => ({
    send: sendMock,
  })),
  CreateRegistryRecordCommand: jest.fn(),
  GetRegistryRecordCommand: jest.fn((input) => ({ __type: "Get", input })),
  UpdateRegistryRecordCommand: jest.fn(),
  UpdateRegistryRecordStatusCommand: jest.fn(),
  DeleteRegistryRecordCommand: jest.fn(),
  ListRegistryRecordsCommand: jest.fn((input) => ({ __type: "List", input })),
  SubmitRegistryRecordForApprovalCommand: jest.fn(),
  DescriptorType: { CUSTOM: "CUSTOM" },
  RegistryRecordStatus: {},
}));

function makeSummary(name: string, recordId: string) {
  return { recordId, name, status: "APPROVED" };
}

/** Resolves ListRegistryRecordsCommand calls with a single page of summaries. */
function mockSinglePage(summaries: ReturnType<typeof makeSummary>[]): void {
  sendMock.mockImplementation(async () => ({ registryRecords: summaries }));
}

describe("RegistryService.resolveRecordId — LRU cache", () => {
  let service: RegistryService;

  beforeEach(() => {
    service = new RegistryService({
      registryId: "test-registry",
      region: "us-east-1",
    });
    sendMock.mockReset();
    jest.spyOn(console, "warn").mockImplementation(() => {});
  });

  afterEach(() => {
    jest.useRealTimers();
    jest.restoreAllMocks();
  });

  it("returns 12-char recordIds directly without calling the registry", async () => {
    const result = await service.resolveRecordId("agent", "agt000000001");

    expect(result).toBe("agt000000001");
    expect(sendMock).not.toHaveBeenCalled();
  });

  it("extracts the recordId from a Registry ARN without calling the registry", async () => {
    const result = await service.resolveRecordId(
      "agent",
      "arn:aws:bedrock-agentcore:us-east-1:123:registry/test-registry/record/agt000000001",
    );

    expect(result).toBe("agt000000001");
    expect(sendMock).not.toHaveBeenCalled();
  });

  it("populates cache on name lookup; second call does not re-enumerate", async () => {
    mockSinglePage([makeSummary("email_validator_agent", "agt000000001")]);

    const first = await service.resolveRecordId(
      "agent",
      "email_validator_agent",
    );
    expect(first).toBe("agt000000001");
    expect(sendMock).toHaveBeenCalledTimes(1);

    const second = await service.resolveRecordId(
      "agent",
      "email_validator_agent",
    );
    expect(second).toBe("agt000000001");
    // Cache hit — no additional registry call.
    expect(sendMock).toHaveBeenCalledTimes(1);
  });

  it("keeps separate cache entries per resource type, resolving each to its own matching record (finding 8304fa1b, decision 84ee7227)", async () => {
    sendMock.mockImplementation(async (command: { input?: unknown }) => {
      const input = (command?.input ?? {}) as {
        recordId?: string;
        nextToken?: string;
      };
      if (input.recordId === "agt000000001") {
        return {
          recordId: "agt000000001",
          name: "shared_name",
          status: "APPROVED",
          descriptors: {
            custom: { inlineContent: JSON.stringify({ manifest: {} }) },
          },
        };
      }
      if (input.recordId === "tol000000001") {
        return {
          recordId: "tol000000001",
          name: "shared_name",
          status: "APPROVED",
          descriptors: { custom: { inlineContent: JSON.stringify({}) } },
        };
      }
      return {
        registryRecords: [
          makeSummary("shared_name", "agt000000001"),
          makeSummary("shared_name", "tol000000001"),
        ],
      };
    });

    const agentId = await service.resolveRecordId("agent", "shared_name");
    const toolId = await service.resolveRecordId("tool", "shared_name");
    // Each type now resolves to its OWN matching record — summaries carry
    // no type discriminator, so resolveRecordId disambiguates a same-name
    // collision with a bounded GetRegistryRecord per candidate rather than
    // returning the first summary hit for both types.
    expect(agentId).toBe("agt000000001");
    expect(toolId).toBe("tol000000001");
    // Two distinct cache keys (agent:shared_name, tool:shared_name). The
    // agent lookup matches on its first candidate check (1 List + 1 Get);
    // the tool lookup must reject the agent candidate before matching the
    // tool candidate (1 List + 2 Get) — 5 calls total, bounded by the
    // collision count, not unbounded.
    expect(sendMock).toHaveBeenCalledTimes(5);

    // Repeats served from cache — zero additional registry calls.
    await service.resolveRecordId("agent", "shared_name");
    await service.resolveRecordId("tool", "shared_name");
    expect(sendMock).toHaveBeenCalledTimes(5);
  });

  it("re-lists after the TTL expires", async () => {
    jest.useFakeTimers();
    jest.setSystemTime(new Date("2026-01-01T00:00:00Z"));

    mockSinglePage([makeSummary("email_validator_agent", "agt000000001")]);

    await service.resolveRecordId("agent", "email_validator_agent");
    expect(sendMock).toHaveBeenCalledTimes(1);

    // Advance past the 60s TTL.
    jest.setSystemTime(new Date("2026-01-01T00:01:01Z"));

    await service.resolveRecordId("agent", "email_validator_agent");
    expect(sendMock).toHaveBeenCalledTimes(2);
  });

  it("evicts the oldest entry when capacity is exceeded", async () => {
    // Default cache max is 500. Seed 501 distinct names; the first one
    // inserted ("agent_0") must fall out when entry 500 ("agent_500") goes in.
    const summaries = Array.from({ length: 501 }, (_, i) =>
      makeSummary(`agent_${i}`, `rec${String(i).padStart(9, "0")}`),
    );

    mockSinglePage(summaries);

    for (let i = 0; i < 501; i++) {
      await service.resolveRecordId("agent", `agent_${i}`);
    }
    const callsAfterSeed = sendMock.mock.calls.length;
    expect(callsAfterSeed).toBe(501);

    // `agent_1` was inserted second and should still be cached → no new call.
    await service.resolveRecordId("agent", "agent_1");
    expect(sendMock).toHaveBeenCalledTimes(callsAfterSeed);

    // `agent_0` was the oldest insertion and must have been evicted →
    // a fresh lookup is required.
    await service.resolveRecordId("agent", "agent_0");
    expect(sendMock).toHaveBeenCalledTimes(callsAfterSeed + 1);
  });

  it("clearRecordIdCache() forces a re-lookup on the next call", async () => {
    mockSinglePage([makeSummary("email_validator_agent", "agt000000001")]);

    await service.resolveRecordId("agent", "email_validator_agent");
    expect(sendMock).toHaveBeenCalledTimes(1);

    service.clearRecordIdCache();

    await service.resolveRecordId("agent", "email_validator_agent");
    expect(sendMock).toHaveBeenCalledTimes(2);
  });

  it("does not cache misses — a missing name re-lists on retry", async () => {
    mockSinglePage([]);

    await expect(
      service.resolveRecordId("agent", "missing_agent"),
    ).rejects.toThrow("Registry record not found for agent: missing_agent");
    await expect(
      service.resolveRecordId("agent", "missing_agent"),
    ).rejects.toThrow("Registry record not found for agent: missing_agent");

    // No cache entry was written, so both calls hit the registry.
    expect(sendMock).toHaveBeenCalledTimes(2);
  });
});
