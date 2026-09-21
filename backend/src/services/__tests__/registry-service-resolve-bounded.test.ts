/**
 * Unit tests for the bounded enumeration fallback in
 * RegistryService.resolveRecordId (finding ce7daab8):
 *
 *   - A known recordId/ARN resolves with O(1) registry calls (zero
 *     ListRegistryRecords calls, zero GetRegistryRecord calls).
 *   - A name-based lookup that never finds a match stops within the
 *     RESOLVE_FALLBACK_MAX_PAGES page bound and throws the structured
 *     RecordResolutionTimeoutError — not an unbounded loop.
 *   - A name-based lookup that never finds a match stops within the
 *     time budget and throws the same structured error, even when pages
 *     remain available (a "slow but not yet at the page cap" registry).
 *   - The fallback never issues a GetRegistryRecord — only
 *     ListRegistryRecords — matching the incident root cause (per-record
 *     GETs under withRetry caused the 'Request rate exceeded' storm).
 */

import {
  RegistryService,
  RecordResolutionTimeoutError,
} from "../registry-service";

const sendMock = jest.fn();
const getRegistryRecordCtor = jest.fn();
const listRegistryRecordsCtor = jest.fn();

jest.mock("@aws-sdk/client-bedrock-agentcore-control", () => ({
  BedrockAgentCoreControlClient: jest.fn().mockImplementation(() => ({
    send: sendMock,
  })),
  CreateRegistryRecordCommand: jest.fn(),
  GetRegistryRecordCommand: jest.fn().mockImplementation(function (
    this: unknown,
    input: unknown,
  ) {
    getRegistryRecordCtor(input);
    return { input };
  }),
  UpdateRegistryRecordCommand: jest.fn(),
  UpdateRegistryRecordStatusCommand: jest.fn(),
  DeleteRegistryRecordCommand: jest.fn(),
  ListRegistryRecordsCommand: jest.fn().mockImplementation(function (
    this: unknown,
    input: unknown,
  ) {
    listRegistryRecordsCtor(input);
    return { input };
  }),
  SubmitRegistryRecordForApprovalCommand: jest.fn(),
  DescriptorType: { CUSTOM: "CUSTOM" },
  RegistryRecordStatus: {},
}));

function makeSummary(name: string, recordId: string) {
  return { recordId, name, status: "APPROVED" };
}

describe("RegistryService.resolveRecordId — bounded enumeration fallback", () => {
  let service: RegistryService;

  beforeEach(() => {
    service = new RegistryService({
      registryId: "test-registry",
      region: "us-east-1",
    });
    sendMock.mockReset();
    getRegistryRecordCtor.mockClear();
    listRegistryRecordsCtor.mockClear();
    jest.spyOn(console, "warn").mockImplementation(() => {});
  });

  afterEach(() => {
    jest.useRealTimers();
    jest.restoreAllMocks();
  });

  it("resolves a known 12-char recordId with zero registry calls", async () => {
    const result = await service.resolveRecordId("agent", "agt000000001");

    expect(result).toBe("agt000000001");
    expect(sendMock).not.toHaveBeenCalled();
    expect(getRegistryRecordCtor).not.toHaveBeenCalled();
    expect(listRegistryRecordsCtor).not.toHaveBeenCalled();
  });

  it("resolves a known Registry ARN with zero registry calls", async () => {
    const result = await service.resolveRecordId(
      "agent",
      "arn:aws:bedrock-agentcore:us-east-1:123456789012:registry/test-registry/record/agt000000001",
    );

    expect(result).toBe("agt000000001");
    expect(sendMock).not.toHaveBeenCalled();
  });

  it("resolves a cached name with exactly one registry call total across two lookups", async () => {
    sendMock.mockResolvedValue({
      registryRecords: [makeSummary("email_validator_agent", "agt000000001")],
    });

    await service.resolveRecordId("agent", "email_validator_agent");
    await service.resolveRecordId("agent", "email_validator_agent");

    expect(sendMock).toHaveBeenCalledTimes(1);
    expect(getRegistryRecordCtor).not.toHaveBeenCalled();
  });

  it("never issues a GetRegistryRecord call during the fallback (only ListRegistryRecords)", async () => {
    sendMock.mockResolvedValue({
      registryRecords: [makeSummary("email_validator_agent", "agt000000001")],
    });

    await service.resolveRecordId("agent", "email_validator_agent");

    expect(getRegistryRecordCtor).not.toHaveBeenCalled();
    expect(listRegistryRecordsCtor).toHaveBeenCalledTimes(1);
  });

  it("stops at the page cap and throws RecordResolutionTimeoutError when no page ever matches", async () => {
    // Every page returns a non-matching summary plus a nextToken, so the
    // loop would run forever without the page-count bound.
    let page = 0;
    sendMock.mockImplementation(async () => {
      page += 1;
      return {
        registryRecords: [makeSummary(`other_agent_${page}`, `rec${page}`)],
        nextToken: `token-${page}`,
      };
    });

    await expect(
      service.resolveRecordId("agent", "never_matches"),
    ).rejects.toThrow(RecordResolutionTimeoutError);

    // Bounded by RESOLVE_FALLBACK_MAX_PAGES (50) — not unbounded.
    expect(sendMock.mock.calls.length).toBeLessThanOrEqual(50);
    expect(sendMock).toHaveBeenCalled();
    expect(getRegistryRecordCtor).not.toHaveBeenCalled();
  });

  it("stops at the time budget and throws RecordResolutionTimeoutError even with pages remaining", async () => {
    jest.useFakeTimers();
    jest.setSystemTime(new Date("2026-01-01T00:00:00Z"));

    // Each call advances the clock past the 8s budget after the first page,
    // simulating a slow registry — the time bound trips before the page
    // cap would.
    let calls = 0;
    sendMock.mockImplementation(async () => {
      calls += 1;
      jest.setSystemTime(new Date(Date.now() + 9000));
      return {
        registryRecords: [makeSummary(`other_agent_${calls}`, `rec${calls}`)],
        nextToken: `token-${calls}`,
      };
    });

    await expect(
      service.resolveRecordId("agent", "never_matches"),
    ).rejects.toThrow(RecordResolutionTimeoutError);

    // The time budget trips on the SECOND iteration's pre-check (after the
    // first page's clock advance pushes past the 8s deadline).
    expect(calls).toBe(1);
  });

  it("does not throw RecordResolutionTimeoutError for a normal not-found (empty registry)", async () => {
    sendMock.mockResolvedValue({ registryRecords: [] });

    await expect(
      service.resolveRecordId("agent", "missing_agent"),
    ).rejects.toThrow("Registry record not found for agent: missing_agent");
    await expect(
      service.resolveRecordId("agent", "missing_agent"),
    ).rejects.not.toBeInstanceOf(RecordResolutionTimeoutError);
  });

  it("the cache hit path is unaffected by the bounded fallback change", async () => {
    sendMock.mockResolvedValue({
      registryRecords: [makeSummary("email_validator_agent", "agt000000001")],
    });

    const first = await service.resolveRecordId(
      "agent",
      "email_validator_agent",
    );
    expect(first).toBe("agt000000001");
    expect(sendMock).toHaveBeenCalledTimes(1);

    // Multiple subsequent lookups within the TTL all hit the cache.
    for (let i = 0; i < 5; i++) {
      const cached = await service.resolveRecordId(
        "agent",
        "email_validator_agent",
      );
      expect(cached).toBe("agt000000001");
    }
    expect(sendMock).toHaveBeenCalledTimes(1);
  });
});
