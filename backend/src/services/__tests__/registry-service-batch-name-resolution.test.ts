/**
 * Unit tests for RegistryService's batch name-resolution surface:
 *  - listResourceSummaries: a single-pass ListRegistryRecords list with NO
 *    per-record detail GET (unlike listResources, which fetches full detail
 *    for every summary to apply its type filter).
 *  - getResourcesByRefs: resolves a batch of agent references (12-char
 *    recordIds OR legacy human-readable names) to their full records, keyed
 *    by the original ref string, deduplicating both the summary-list call
 *    and the per-record detail GETs.
 *
 * These back the registry-agent-record-resolver's agentBindings[].name
 * enrichment (the N+1 fix).
 */
import {
  BedrockAgentCoreControlClient,
  GetRegistryRecordCommand,
  ListRegistryRecordsCommand,
  DescriptorType,
} from "@aws-sdk/client-bedrock-agentcore-control";
import { mockClient } from "aws-sdk-client-mock";
import { RegistryService } from "../registry-service";

const sdkMock = mockClient(BedrockAgentCoreControlClient);

describe("RegistryService — listResourceSummaries", () => {
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

  it("returns summaries WITHOUT issuing a GetRegistryRecord per record", async () => {
    sdkMock.on(ListRegistryRecordsCommand).resolves({
      registryRecords: [
        {
          registryArn: "arn:1",
          recordArn: "arn:1/r1",
          recordId: "recordidone1",
          name: "Agent One",
          descriptorType: DescriptorType.CUSTOM,
          recordVersion: "1",
          status: "APPROVED",
          createdAt: new Date(),
          updatedAt: new Date(),
        },
        {
          registryArn: "arn:1",
          recordArn: "arn:1/r2",
          recordId: "recordidtwo2",
          name: "Agent Two",
          descriptorType: DescriptorType.CUSTOM,
          recordVersion: "1",
          status: "APPROVED",
          createdAt: new Date(),
          updatedAt: new Date(),
        },
      ],
      nextToken: undefined,
    });

    const summaries = await service.listResourceSummaries();

    expect(summaries).toHaveLength(2);
    expect(summaries.map((s) => s.recordId)).toEqual([
      "recordidone1",
      "recordidtwo2",
    ]);
    expect(sdkMock.commandCalls(GetRegistryRecordCommand)).toHaveLength(0);
  });

  it("pages through nextToken, issuing exactly one ListRegistryRecords call per page", async () => {
    sdkMock
      .on(ListRegistryRecordsCommand)
      .resolvesOnce({
        registryRecords: [
          {
            registryArn: "arn:1",
            recordArn: "arn:1/r1",
            recordId: "recordidone1",
            name: "Agent One",
            descriptorType: DescriptorType.CUSTOM,
            recordVersion: "1",
            status: "APPROVED",
            createdAt: new Date(),
            updatedAt: new Date(),
          },
        ],
        nextToken: "page2",
      })
      .resolvesOnce({
        registryRecords: [
          {
            registryArn: "arn:1",
            recordArn: "arn:1/r2",
            recordId: "recordidtwo2",
            name: "Agent Two",
            descriptorType: DescriptorType.CUSTOM,
            recordVersion: "1",
            status: "APPROVED",
            createdAt: new Date(),
            updatedAt: new Date(),
          },
        ],
        nextToken: undefined,
      });

    const summaries = await service.listResourceSummaries();

    expect(summaries).toHaveLength(2);
    expect(sdkMock.commandCalls(ListRegistryRecordsCommand)).toHaveLength(2);
  });
});

describe("RegistryService — getResourcesByRefs", () => {
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

  it("returns an empty map for an empty refs array without calling the SDK", async () => {
    const result = await service.getResourcesByRefs("agent", []);
    expect(result.size).toBe(0);
    expect(sdkMock.commandCalls(ListRegistryRecordsCommand)).toHaveLength(0);
    expect(sdkMock.commandCalls(GetRegistryRecordCommand)).toHaveLength(0);
  });

  it("resolves a 12-char recordId ref directly with a single GetRegistryRecord and no ListRegistryRecords call", async () => {
    sdkMock.on(GetRegistryRecordCommand).resolves({
      recordId: "recordidone1",
      name: "Agent One",
      status: "APPROVED",
      descriptors: { custom: { inlineContent: '{"manifest":{}}' } },
      createdAt: new Date(),
      updatedAt: new Date(),
    });

    const result = await service.getResourcesByRefs("agent", ["recordidone1"]);

    expect(result.get("recordidone1")?.name).toBe("Agent One");
    expect(sdkMock.commandCalls(ListRegistryRecordsCommand)).toHaveLength(0);
    expect(sdkMock.commandCalls(GetRegistryRecordCommand)).toHaveLength(1);
  });

  it("resolves a legacy human-readable name via exactly one ListRegistryRecords pass, then one GetRegistryRecord", async () => {
    sdkMock.on(ListRegistryRecordsCommand).resolves({
      registryRecords: [
        {
          registryArn: "arn:1",
          recordArn: "arn:1/r1",
          recordId: "recordidone1",
          name: "LegacyAgentName",
          descriptorType: DescriptorType.CUSTOM,
          recordVersion: "1",
          status: "APPROVED",
          createdAt: new Date(),
          updatedAt: new Date(),
        },
      ],
      nextToken: undefined,
    });
    sdkMock.on(GetRegistryRecordCommand).resolves({
      recordId: "recordidone1",
      name: "LegacyAgentName",
      status: "APPROVED",
      descriptors: { custom: { inlineContent: '{"manifest":{}}' } },
      createdAt: new Date(),
      updatedAt: new Date(),
    });

    const result = await service.getResourcesByRefs("agent", [
      "LegacyAgentName",
    ]);

    expect(result.get("LegacyAgentName")?.recordId).toBe("recordidone1");
    expect(sdkMock.commandCalls(ListRegistryRecordsCommand)).toHaveLength(1);
    expect(sdkMock.commandCalls(GetRegistryRecordCommand)).toHaveLength(1);
  });

  it("deduplicates repeated refs to the same recordId into exactly one GetRegistryRecord call", async () => {
    sdkMock.on(GetRegistryRecordCommand).resolves({
      recordId: "recordidone1",
      name: "Agent One",
      status: "APPROVED",
      descriptors: { custom: { inlineContent: '{"manifest":{}}' } },
      createdAt: new Date(),
      updatedAt: new Date(),
    });

    const result = await service.getResourcesByRefs("agent", [
      "recordidone1",
      "recordidone1",
      "recordidone1",
    ]);

    expect(result.get("recordidone1")?.name).toBe("Agent One");
    expect(sdkMock.commandCalls(GetRegistryRecordCommand)).toHaveLength(1);
  });

  it("does NOT issue a ListRegistryRecords call when every ref is already a 12-char recordId", async () => {
    sdkMock
      .on(GetRegistryRecordCommand)
      .callsFake(async (input: { recordId: string }) => ({
        recordId: input.recordId,
        name: `Name-${input.recordId}`,
        status: "APPROVED",
        descriptors: { custom: { inlineContent: '{"manifest":{}}' } },
        createdAt: new Date(),
        updatedAt: new Date(),
      }));

    const result = await service.getResourcesByRefs("agent", [
      "recordidone1",
      "recordidtwo2",
    ]);

    expect(result.size).toBe(2);
    expect(sdkMock.commandCalls(ListRegistryRecordsCommand)).toHaveLength(0);
  });

  it("drops (does not throw for) a ref whose GetRegistryRecord call rejects, leaving other refs intact", async () => {
    sdkMock
      .on(GetRegistryRecordCommand)
      .callsFake(async (input: { recordId: string }) => {
        if (input.recordId === "recordidbad1") {
          throw new Error("Registry transient error");
        }
        return {
          recordId: input.recordId,
          name: "Good Agent",
          status: "APPROVED",
          descriptors: { custom: { inlineContent: '{"manifest":{}}' } },
          createdAt: new Date(),
          updatedAt: new Date(),
        };
      });

    const result = await service.getResourcesByRefs("agent", [
      "recordidbad1",
      "recordidok01",
    ]);

    expect(result.has("recordidbad1")).toBe(false);
    expect(result.get("recordidok01")?.name).toBe("Good Agent");
  });

  it("drops a ref whose legacy name has no match in the summary list", async () => {
    sdkMock
      .on(ListRegistryRecordsCommand)
      .resolves({ registryRecords: [], nextToken: undefined });

    const result = await service.getResourcesByRefs("agent", [
      "NoSuchAgentName",
    ]);

    expect(result.size).toBe(0);
    expect(sdkMock.commandCalls(GetRegistryRecordCommand)).toHaveLength(0);
  });

  it("resolves a mixed batch of recordId and legacy-name refs with one summary pass and one GET per unique record", async () => {
    sdkMock.on(ListRegistryRecordsCommand).resolves({
      registryRecords: [
        {
          registryArn: "arn:1",
          recordArn: "arn:1/r2",
          recordId: "recordidtwo2",
          name: "LegacyAgentName",
          descriptorType: DescriptorType.CUSTOM,
          recordVersion: "1",
          status: "APPROVED",
          createdAt: new Date(),
          updatedAt: new Date(),
        },
      ],
      nextToken: undefined,
    });
    sdkMock
      .on(GetRegistryRecordCommand)
      .callsFake(async (input: { recordId: string }) => {
        const names: Record<string, string> = {
          recordidone1: "Direct Agent",
          recordidtwo2: "LegacyAgentName",
        };
        return {
          recordId: input.recordId,
          name: names[input.recordId] ?? "Unknown",
          status: "APPROVED",
          descriptors: { custom: { inlineContent: '{"manifest":{}}' } },
          createdAt: new Date(),
          updatedAt: new Date(),
        };
      });

    const result = await service.getResourcesByRefs("agent", [
      "recordidone1",
      "LegacyAgentName",
    ]);

    expect(result.get("recordidone1")?.name).toBe("Direct Agent");
    expect(result.get("LegacyAgentName")?.name).toBe("LegacyAgentName");
    expect(sdkMock.commandCalls(ListRegistryRecordsCommand)).toHaveLength(1);
    expect(sdkMock.commandCalls(GetRegistryRecordCommand)).toHaveLength(2);
  });
});
