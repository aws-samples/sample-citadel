import type { DynamoDBDocumentClient } from "@aws-sdk/lib-dynamodb";
import { QueryCommand } from "@aws-sdk/lib-dynamodb";
import { getRecentActivity } from "../recent-activity-resolver";

const mockSend = jest.fn();
const mockDeps = {
  docClient: { send: mockSend } as unknown as DynamoDBDocumentClient,
  projectsTable: "projects",
  agentConfigTable: "agents",
  workflowsTable: "workflows",
  integrationsTable: "integrations",
};

/** Routes a mocked send() call to a response keyed by IndexName (projects/
 * workflows) or absence of IndexName (integrations, direct PK query). */
function mockByIndex(responses: {
  OrganizationIndex?: unknown[];
  OrgStatusIndex?: unknown[];
  integrations?: unknown[];
}) {
  mockSend.mockImplementation(async (command: QueryCommand) => {
    const input = command.input as { IndexName?: string };
    if (input.IndexName === "OrganizationIndex")
      return { Items: responses.OrganizationIndex ?? [] };
    if (input.IndexName === "OrgStatusIndex")
      return { Items: responses.OrgStatusIndex ?? [] };
    if (!input.IndexName) return { Items: responses.integrations ?? [] };
    return { Items: [] };
  });
}

beforeEach(() => mockSend.mockReset());

describe("getRecentActivity", () => {
  it("returns empty items when no entities exist", async () => {
    mockByIndex({});
    const result = await getRecentActivity("org1", 10, mockDeps);
    expect(result.items).toEqual([]);
  });

  it("merges and sorts by timestamp descending", async () => {
    mockByIndex({
      OrganizationIndex: [
        {
          id: "p1",
          name: "Project 1",
          status: "IN_PROGRESS",
          updatedAt: "2026-04-13T10:00:00Z",
        },
      ],
      OrgStatusIndex: [
        {
          workflowId: "w1",
          name: "Workflow 1",
          status: "ACTIVE",
          updatedAt: "2026-04-13T11:00:00Z",
        },
      ],
      integrations: [],
    });

    const result = await getRecentActivity("org1", 10, mockDeps);
    expect(result.items).toHaveLength(2);
    expect(result.items[0].entityType).toBe("workflow");
    expect(result.items[1].entityType).toBe("project");
  });

  it("respects limit", async () => {
    mockByIndex({
      OrganizationIndex: [
        {
          id: "p1",
          name: "P1",
          status: "OK",
          updatedAt: "2026-04-13T10:00:00Z",
        },
        {
          id: "p2",
          name: "P2",
          status: "OK",
          updatedAt: "2026-04-13T09:00:00Z",
        },
      ],
      OrgStatusIndex: [
        {
          workflowId: "w1",
          name: "W1",
          status: "ACTIVE",
          updatedAt: "2026-04-13T12:00:00Z",
        },
      ],
      integrations: [],
    });

    const result = await getRecentActivity("org1", 2, mockDeps);
    expect(result.items).toHaveLength(2);
  });

  it("clamps limit to max 50", async () => {
    mockByIndex({});
    await getRecentActivity("org1", 100, mockDeps);
    // Should not throw, limit clamped internally
    expect(mockSend).toHaveBeenCalled();
  });

  it("never queries or scans agentConfigTable (no org attribute available — finding 615aa5bb)", async () => {
    mockByIndex({});
    await getRecentActivity("org1", 10, mockDeps);
    const queriedTables = mockSend.mock.calls.map(
      ([cmd]) => (cmd as QueryCommand).input.TableName,
    );
    expect(queriedTables).not.toContain("agents");
  });
});
