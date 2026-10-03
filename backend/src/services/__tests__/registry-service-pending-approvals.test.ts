/**
 * Unit tests for RegistryService.listPendingApprovals (CIT-040).
 *
 * Validates:
 * - Both agent and tool records returned with correct recordType discrimination
 * - STATUS filter set to PENDING_APPROVAL in ListRegistryRecordsCommand
 * - Pagination token passthrough (limit + nextToken)
 * - Empty result when no pending records exist
 */
import {
  AgentRegistryControlClient,
  GetRegistryRecordCommand,
  ListRegistryRecordsCommand,
  RegistryRecordFilterName,
  RecordType,
} from "@aws-sdk/client-agent-registry-control";
import { mockClient } from "aws-sdk-client-mock";
import {
  RegistryService,
  RegistryRecordStatusValues,
} from "../registry-service";

const sdkMock = mockClient(AgentRegistryControlClient);

describe("RegistryService.listPendingApprovals", () => {
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

  const agentDescriptor = JSON.stringify({
    manifest: { name: "My Agent" },
    orgId: "org-1",
    createdBy: "user-alice",
    categories: [],
    icon: "",
    state: "active",
  });

  const toolDescriptor = JSON.stringify({
    config: '{"name":"My Tool"}',
    orgId: "org-2",
    createdBy: "user-bob",
    categories: [],
    icon: "",
    state: "active",
  });

  const now = new Date("2026-10-01T12:00:00Z");

  it("returns both agent and tool records with correct recordType", async () => {
    sdkMock.on(ListRegistryRecordsCommand).resolves({
      registryRecords: [
        {
          recordId: "agentRec0001",
          name: "my-agent",
          status: "PENDING_APPROVAL",
        },
        {
          recordId: "toolRec00001",
          name: "my-tool",
          status: "PENDING_APPROVAL",
        },
      ],
      nextToken: undefined,
    });

    sdkMock
      .on(GetRegistryRecordCommand, { recordId: "agentRec0001" })
      .resolves({
        recordId: "agentRec0001",
        name: "my-agent",
        displayName: "My Agent",
        status: "PENDING_APPROVAL",
        descriptors: { custom: { data: agentDescriptor } },
        createdAt: now,
        updatedAt: now,
      });

    sdkMock
      .on(GetRegistryRecordCommand, { recordId: "toolRec00001" })
      .resolves({
        recordId: "toolRec00001",
        name: "my-tool",
        displayName: "My Tool",
        status: "PENDING_APPROVAL",
        descriptors: { custom: { data: toolDescriptor } },
        createdAt: now,
        updatedAt: now,
      });

    const result = await service.listPendingApprovals();

    expect(result.items).toHaveLength(2);

    const agent = result.items.find((i) => i.recordType === "agent")!;
    expect(agent).toBeDefined();
    expect(agent.recordId).toBe("agentRec0001");
    expect(agent.name).toBe("my-agent");
    expect(agent.displayName).toBe("My Agent");
    expect(agent.orgId).toBe("org-1");
    expect(agent.createdBy).toBe("user-alice");
    expect(agent.status).toBe("PENDING_APPROVAL");
    expect(agent.submittedAt).toBe(now.toISOString());

    const tool = result.items.find((i) => i.recordType === "tool")!;
    expect(tool).toBeDefined();
    expect(tool.recordId).toBe("toolRec00001");
    expect(tool.name).toBe("my-tool");
    expect(tool.displayName).toBe("My Tool");
    expect(tool.orgId).toBe("org-2");
    expect(tool.createdBy).toBe("user-bob");
    expect(tool.status).toBe("PENDING_APPROVAL");
  });

  it("sends STATUS=PENDING_APPROVAL and RECORD_TYPE=CUSTOM filters", async () => {
    sdkMock.on(ListRegistryRecordsCommand).resolves({
      registryRecords: [],
      nextToken: undefined,
    });

    await service.listPendingApprovals();

    const listCalls = sdkMock.commandCalls(ListRegistryRecordsCommand);
    expect(listCalls).toHaveLength(1);
    const filters = listCalls[0].args[0].input.filters;
    expect(filters).toEqual(
      expect.arrayContaining([
        {
          name: RegistryRecordFilterName.RECORD_TYPE,
          values: [RecordType.CUSTOM],
        },
        {
          name: RegistryRecordFilterName.STATUS,
          values: [RegistryRecordStatusValues.PENDING_APPROVAL],
        },
      ]),
    );
  });

  it("passes through limit and nextToken for pagination", async () => {
    sdkMock.on(ListRegistryRecordsCommand).resolves({
      registryRecords: [
        {
          recordId: "agentRec0001",
          name: "my-agent",
          status: "PENDING_APPROVAL",
        },
      ],
      nextToken: "page-2-token",
    });

    sdkMock.on(GetRegistryRecordCommand).resolves({
      recordId: "agentRec0001",
      name: "my-agent",
      displayName: "my-agent",
      status: "PENDING_APPROVAL",
      descriptors: { custom: { data: agentDescriptor } },
      createdAt: now,
      updatedAt: now,
    });

    const result = await service.listPendingApprovals({
      limit: 10,
      nextToken: "page-1-token",
    });

    // Assert SDK received limit and nextToken
    const listCalls = sdkMock.commandCalls(ListRegistryRecordsCommand);
    expect(listCalls[0].args[0].input.maxResults).toBe(10);
    expect(listCalls[0].args[0].input.nextToken).toBe("page-1-token");

    // Assert response nextToken is passed through
    expect(result.nextToken).toBe("page-2-token");
    expect(result.items).toHaveLength(1);
  });

  it("returns empty items when no pending records exist", async () => {
    sdkMock.on(ListRegistryRecordsCommand).resolves({
      registryRecords: [],
      nextToken: undefined,
    });

    const result = await service.listPendingApprovals();

    expect(result.items).toEqual([]);
    expect(result.nextToken).toBeUndefined();
    // No detail GETs issued
    expect(sdkMock.commandCalls(GetRegistryRecordCommand)).toHaveLength(0);
  });
});
