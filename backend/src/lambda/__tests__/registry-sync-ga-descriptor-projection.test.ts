/**
 * Tests for GA upsert sourceProjectId + config projection from
 * customDescriptorContent (fabricated-agent Citadel metadata shape).
 *
 * Bug: buildGaMergeFields deliberately skipped sourceProjectId and config
 * even when the descriptor carried them (the fabricator writes them into
 * customDescriptorContent). The first UpdateCommand wrote config = {} via
 * if_not_exists, and sourceProjectId was never SET — so the GSI was empty
 * and activation found nothing.
 */

process.env.AGENT_CONFIG_TABLE = "test-agents-table";
process.env.TOOLS_CONFIG_TABLE = "test-tools-table";
process.env.REGISTRY_ID = "test-registry-id";
process.env.DLQ_URL = "https://sqs.us-east-1.amazonaws.com/123456789/test-dlq";

import { mockClient } from "aws-sdk-client-mock";
import {
  DynamoDBDocumentClient,
  UpdateCommand,
  GetCommand,
} from "@aws-sdk/lib-dynamodb";
import { SQSClient, SendMessageCommand } from "@aws-sdk/client-sqs";
import {
  CloudWatchClient,
  PutMetricDataCommand,
} from "@aws-sdk/client-cloudwatch";
import type { RegistryRecord } from "../../services/registry-service";

const mockGetResource = jest.fn();
jest.mock("../../services/registry-service", () => {
  const actual = jest.requireActual("../../services/registry-service");
  return {
    ...actual,
    RegistryService: jest.fn().mockImplementation(() => ({
      getResource: mockGetResource,
    })),
  };
});

import { handler, buildGaMergeFields } from "../registry-sync";
import type { RegistryEvent, ResourceType } from "../registry-sync";

const ddbMock = mockClient(DynamoDBDocumentClient);
const sqsMock = mockClient(SQSClient);
const cwMock = mockClient(CloudWatchClient);

beforeEach(() => {
  ddbMock.reset();
  sqsMock.reset();
  cwMock.reset();
  mockGetResource.mockReset();
  sqsMock.on(SendMessageCommand).resolves({});
  cwMock.on(PutMetricDataCommand).resolves({});
  jest.spyOn(console, "log").mockImplementation();
  jest.spyOn(console, "warn").mockImplementation();
  jest.spyOn(console, "error").mockImplementation();
});

afterEach(() => {
  jest.restoreAllMocks();
});

// ---------------------------------------------------------------------------
// Fixtures — fabricator-style descriptor with config + sourceProjectId
// ---------------------------------------------------------------------------

const FABRICATOR_CONFIG = {
  name: "energy_settlements_router",
  filename: "energy_settlements_router.py",
  schema: {
    type: "object",
    properties: { ticketId: { type: "string" } },
    required: ["ticketId"],
  },
  version: 1,
  description: "Route energy settlement tickets (Project: proj-es-001)",
  action: {
    type: "sqs",
    target: "https://sqs.us-east-1.amazonaws.com/123/worker",
  },
};

const fabricatorRecord: RegistryRecord = {
  recordId: "RecFab00001",
  name: "energy_settlements_router",
  description: "Route energy settlement tickets (Project: proj-es-001)",
  status: "DRAFT",
  customDescriptorContent: JSON.stringify({
    categories: ["worker"],
    icon: "",
    state: "inactive",
    manifest: {
      name: "energy_settlements_router",
      description: "Route energy settlement tickets (Project: proj-es-001)",
      version: 1,
      tools: [],
    },
    config: FABRICATOR_CONFIG,
    createdBy: "fabricator-user",
    orgId: "org-energy",
    sourceProjectId: "proj-es-001",
  }),
  createdAt: new Date("2026-11-01T00:00:00.000Z"),
  updatedAt: new Date("2026-11-01T00:00:01.000Z"),
};

/** A non-Citadel descriptor: no config, no sourceProjectId. */
const plainRecord: RegistryRecord = {
  recordId: "RecPlain00001",
  name: "plain_agent",
  description: "A plain agent without fabricator metadata",
  status: "APPROVED",
  customDescriptorContent: JSON.stringify({
    categories: ["built-in"],
    icon: "icon.png",
    state: "active",
    orgId: "org-default",
    manifest: { name: "plain_agent", version: 1, tools: [] },
  }),
  createdAt: new Date("2026-10-01T00:00:00.000Z"),
  updatedAt: new Date("2026-10-01T00:00:01.000Z"),
};

function makeGaFabricatorEvent(): unknown {
  return {
    version: "0",
    id: "fab-event-001",
    "detail-type": "Registry Record State changed to Draft",
    source: "aws.agent-registry",
    account: "123456789012",
    time: "2026-11-01T00:00:02Z",
    region: "us-west-2",
    resources: [
      "arn:aws:agent-registry:us-west-2:123456789012:registry/RegTest000001/record/RecFab00001",
    ],
    detail: {
      registryRecordId: "RecFab00001",
      registryId: "RegTest000001",
    },
  };
}

// ---------------------------------------------------------------------------
// buildGaMergeFields — unit tests
// ---------------------------------------------------------------------------

describe("buildGaMergeFields — fabricator descriptor projection", () => {
  test("extracts sourceProjectId from Citadel descriptor when present", () => {
    const fields = buildGaMergeFields(
      "agent" as ResourceType,
      fabricatorRecord,
    );
    expect(fields.sourceProjectId).toBe("proj-es-001");
  });

  test("extracts config from Citadel descriptor when present", () => {
    const fields = buildGaMergeFields(
      "agent" as ResourceType,
      fabricatorRecord,
    );
    expect(fields.config).toEqual(FABRICATOR_CONFIG);
  });

  test("does NOT set sourceProjectId for a non-Citadel descriptor", () => {
    const fields = buildGaMergeFields("agent" as ResourceType, plainRecord);
    expect(fields.sourceProjectId).toBeUndefined();
  });

  test("does NOT set config for a non-Citadel descriptor (no config in metadata)", () => {
    const fields = buildGaMergeFields("agent" as ResourceType, plainRecord);
    expect(fields.config).toBeUndefined();
  });
});

// ---------------------------------------------------------------------------
// handleGaUpsert — integration tests via handler()
// ---------------------------------------------------------------------------

describe("handleGaUpsert — fabricator descriptor projection", () => {
  test("GA upsert for fabricator record writes sourceProjectId in merge UpdateCommand", async () => {
    mockGetResource.mockResolvedValueOnce(fabricatorRecord);
    ddbMock.on(GetCommand).resolves({ Item: undefined }); // no existing row
    ddbMock.on(UpdateCommand).resolves({});

    await handler(makeGaFabricatorEvent() as RegistryEvent);

    // The first UpdateCommand is the merge upsert
    const input = ddbMock.commandCalls(UpdateCommand)[0].args[0].input;
    expect(input.UpdateExpression).toContain("sourceProjectId");
    expect(input.ExpressionAttributeValues![":sourceProjectId"]).toBe(
      "proj-es-001",
    );
  });

  test("GA upsert for fabricator record writes config (not just if_not_exists empty)", async () => {
    mockGetResource.mockResolvedValueOnce(fabricatorRecord);
    ddbMock.on(GetCommand).resolves({ Item: undefined });
    ddbMock.on(UpdateCommand).resolves({});

    await handler(makeGaFabricatorEvent() as RegistryEvent);

    const input = ddbMock.commandCalls(UpdateCommand)[0].args[0].input;
    // Config should appear as a direct SET, not only inside if_not_exists
    expect(input.UpdateExpression).toContain("#config = :config");
    expect(input.ExpressionAttributeValues![":config"]).toEqual(
      FABRICATOR_CONFIG,
    );
  });

  test("GA upsert for non-Citadel record still uses if_not_exists for config (no overwrite)", async () => {
    mockGetResource.mockResolvedValueOnce(plainRecord);
    ddbMock.on(GetCommand).resolves({ Item: undefined });
    ddbMock.on(UpdateCommand).resolves({});

    const approvedEvent = {
      version: "0",
      id: "plain-event-001",
      "detail-type": "Registry Record State changed to Approved",
      source: "aws.agent-registry",
      account: "123456789012",
      time: "2026-10-01T00:00:02Z",
      region: "us-west-2",
      resources: [
        "arn:aws:agent-registry:us-west-2:123456789012:registry/RegTest000001/record/RecPlain00001",
      ],
      detail: {
        registryRecordId: "RecPlain00001",
        registryId: "RegTest000001",
      },
    };

    await handler(approvedEvent as RegistryEvent);

    const input = ddbMock.commandCalls(UpdateCommand)[0].args[0].input;
    // config should only appear inside if_not_exists, not as a direct SET
    expect(input.UpdateExpression).not.toContain("#config = :config");
    expect(input.UpdateExpression).toContain("if_not_exists(#config,");
    // sourceProjectId should NOT appear
    expect(
      input.ExpressionAttributeValues![":sourceProjectId"],
    ).toBeUndefined();
  });

  test("existing different sourceProjectId is preserved (not overwritten), and a warning is logged", async () => {
    // Fabricator record wants to set sourceProjectId = "proj-es-001"
    // but the existing row already has sourceProjectId = "proj-old-999"
    const existingRecord = {
      ...fabricatorRecord,
      customDescriptorContent: JSON.stringify({
        categories: ["worker"],
        icon: "",
        state: "inactive",
        manifest: { name: "energy_settlements_router", version: 1, tools: [] },
        config: FABRICATOR_CONFIG,
        createdBy: "fabricator-user",
        orgId: "org-energy",
        sourceProjectId: "proj-es-001",
      }),
    };

    mockGetResource.mockResolvedValueOnce(existingRecord);
    // Simulate existing row with a DIFFERENT sourceProjectId
    ddbMock.on(GetCommand).resolves({
      Item: {
        agentId: "RecFab00001",
        sourceProjectId: "proj-old-999",
      },
    });
    ddbMock.on(UpdateCommand).resolves({});

    await handler(makeGaFabricatorEvent() as RegistryEvent);

    // The merge should use if_not_exists for sourceProjectId so the
    // existing value is preserved by DynamoDB
    const input = ddbMock.commandCalls(UpdateCommand)[0].args[0].input;
    expect(input.UpdateExpression).toContain("if_not_exists(#sourceProjectId");
    // A warning should be logged about the divergence
    expect(console.warn).toHaveBeenCalledWith(
      expect.stringContaining("sourceProjectId divergence"),
    );
  });
});
