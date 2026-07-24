/**
 * Tests for the listResources N+1 fix (live incident: 340 records ×
 * sequential GetRegistryRecord, each carrying SDK retries, blew the 30s
 * resolver budget).
 *
 * Contract:
 *  - Full-record fetches are REQUIRED for every summary (the projection
 *    evidence: mapToAgentConfig/mapToToolConfig read orgId — the tenant
 *    filter — from inlineContent, and the agent/tool classification is the
 *    inlineContent `manifest` discriminator), so the fix is PARALLEL
 *    detail fetches with bounded concurrency (10), not a summary-only path.
 *  - A caller-supplied remaining-time budget (Lambda
 *    context.getRemainingTimeInMillis) short-circuits the fetch: when the
 *    budget drops below the floor, listResources stops issuing GETs and
 *    returns the records completed so far instead of timing out.
 *  - Per-record GET failures still fall back to the summary shape
 *    (pre-existing behavior, preserved under the parallel path).
 */
import {
  BedrockAgentCoreControlClient,
  GetRegistryRecordCommand,
  ListRegistryRecordsCommand,
} from "@aws-sdk/client-bedrock-agentcore-control";
import { mockClient } from "aws-sdk-client-mock";
import { RegistryService } from "../registry-service";

const sdkMock = mockClient(BedrockAgentCoreControlClient);

const RECORD_COUNT = 340;

function summaries(count: number) {
  return Array.from({ length: count }, (_, i) => ({
    recordId: `rec-${String(i).padStart(4, "0")}`,
    name: `agent-${i}`,
    status: "APPROVED",
    description: `Agent ${i}`,
  }));
}

function agentDetail(recordId: string, name: string) {
  return {
    recordId,
    name,
    status: "APPROVED",
    description: `desc ${name}`,
    descriptors: {
      custom: {
        inlineContent: JSON.stringify({ manifest: { name }, orgId: "org-1" }),
      },
    },
  };
}

const sleep = (ms: number) => new Promise((resolve) => setTimeout(resolve, ms));

describe("RegistryService.listResources — bounded parallel detail fetch", () => {
  let service: RegistryService;

  beforeEach(() => {
    sdkMock.reset();
    service = new RegistryService({
      registryId: "test-registry",
      region: "us-east-1",
    });
    jest.spyOn(console, "warn").mockImplementation(() => {});
  });

  afterEach(() => {
    jest.restoreAllMocks();
  });

  it("fetches 340 details in parallel with concurrency bounded at 10", async () => {
    sdkMock.on(ListRegistryRecordsCommand).resolves({
      registryRecords: summaries(RECORD_COUNT),
      nextToken: undefined,
    });

    let inFlight = 0;
    let maxInFlight = 0;
    sdkMock
      .on(GetRegistryRecordCommand)
      .callsFake(async (input: { recordId: string }) => {
        inFlight += 1;
        maxInFlight = Math.max(maxInFlight, inFlight);
        await sleep(5);
        inFlight -= 1;
        const idx = Number(input.recordId.slice(4));
        return agentDetail(input.recordId, `agent-${idx}`);
      });

    const started = Date.now();
    const results = await service.listResources("agent");
    const elapsed = Date.now() - started;

    expect(results).toHaveLength(RECORD_COUNT);
    // Bounded AND actually parallel.
    expect(maxInFlight).toBeLessThanOrEqual(10);
    expect(maxInFlight).toBeGreaterThan(1);
    // Sequential at 5ms/GET would be >= 1700ms; parallel-10 is ~170ms.
    // Generous ceiling to stay deterministic on slow CI machines.
    expect(elapsed).toBeLessThan(1200);
  });

  it("preserves summary order in the returned records", async () => {
    sdkMock.on(ListRegistryRecordsCommand).resolves({
      registryRecords: summaries(25),
      nextToken: undefined,
    });
    sdkMock
      .on(GetRegistryRecordCommand)
      .callsFake(async (input: { recordId: string }) => {
        // Random completion order to prove output order is summary order.
        await sleep(Math.floor(Math.random() * 10));
        const idx = Number(input.recordId.slice(4));
        return agentDetail(input.recordId, `agent-${idx}`);
      });

    const results = await service.listResources("agent");

    expect(results.map((r) => r.recordId)).toEqual(
      summaries(25).map((s) => s.recordId),
    );
  });

  it("short-circuits on a low remaining-time budget and returns a partial list instead of timing out", async () => {
    sdkMock.on(ListRegistryRecordsCommand).resolves({
      registryRecords: summaries(RECORD_COUNT),
      nextToken: undefined,
    });
    sdkMock
      .on(GetRegistryRecordCommand)
      .callsFake(async (input: { recordId: string }) => {
        await sleep(1);
        const idx = Number(input.recordId.slice(4));
        return agentDetail(input.recordId, `agent-${idx}`);
      });

    // Budget starts healthy, then collapses after ~60 checks.
    let checks = 0;
    const getRemainingTimeMs = () => {
      checks += 1;
      return checks > 60 ? 1000 : 30000;
    };

    const results = await service.listResources("agent", {
      getRemainingTimeMs,
      minRemainingTimeMs: 5000,
    });

    expect(results.length).toBeGreaterThan(0);
    expect(results.length).toBeLessThan(RECORD_COUNT);
    const getCalls = sdkMock.commandCalls(GetRegistryRecordCommand);
    expect(getCalls.length).toBeLessThan(RECORD_COUNT);
  });

  it("stops paginating when the budget is exhausted between pages", async () => {
    sdkMock
      .on(ListRegistryRecordsCommand)
      .resolvesOnce({ registryRecords: summaries(10), nextToken: "page-2" })
      .resolvesOnce({ registryRecords: summaries(10), nextToken: undefined });
    sdkMock
      .on(GetRegistryRecordCommand)
      .callsFake(async (input: { recordId: string }) => {
        const idx = Number(input.recordId.slice(4));
        return agentDetail(input.recordId, `agent-${idx}`);
      });

    // Healthy through page 1's fetches, exhausted before page 2.
    let calls = 0;
    const getRemainingTimeMs = () => {
      calls += 1;
      return calls > 11 ? 100 : 30000;
    };

    await service.listResources("agent", {
      getRemainingTimeMs,
      minRemainingTimeMs: 5000,
    });

    expect(sdkMock.commandCalls(ListRegistryRecordsCommand)).toHaveLength(1);
  });

  it("falls back to the summary shape when a single GET fails (parallel path preserves the old contract)", async () => {
    sdkMock.on(ListRegistryRecordsCommand).resolves({
      registryRecords: summaries(3),
      nextToken: undefined,
    });
    sdkMock
      .on(GetRegistryRecordCommand)
      .callsFake(async (input: { recordId: string }) => {
        if (input.recordId === "rec-0001") {
          throw Object.assign(new Error("boom"), {
            name: "ValidationException",
          });
        }
        const idx = Number(input.recordId.slice(4));
        return agentDetail(input.recordId, `agent-${idx}`);
      });

    const results = await service.listResources("agent");

    expect(results).toHaveLength(3);
    const fallback = results.find((r) => r.recordId === "rec-0001");
    expect(fallback).toBeDefined();
    expect(fallback?.customDescriptorContent).toBeUndefined();
  });

  it("runs without a budget callback exactly as before (no guard)", async () => {
    sdkMock.on(ListRegistryRecordsCommand).resolves({
      registryRecords: summaries(5),
      nextToken: undefined,
    });
    sdkMock
      .on(GetRegistryRecordCommand)
      .callsFake(async (input: { recordId: string }) => {
        const idx = Number(input.recordId.slice(4));
        return agentDetail(input.recordId, `agent-${idx}`);
      });

    const results = await service.listResources("agent");
    expect(results).toHaveLength(5);
  });
});
