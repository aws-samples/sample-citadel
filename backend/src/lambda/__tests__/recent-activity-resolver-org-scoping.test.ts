/**
 * Org-scoping regression test for getRecentActivity (finding 615aa5bb).
 *
 * Before the fix: getRecentActivity(orgId, ...) accepted orgId but
 * fetchRecent()'s ScanCommand had no FilterExpression at all — it scanned
 * the full projects/agent-config/workflows/integrations tables and
 * returned activity from every organization.
 *
 * After the fix: projects are scoped via ProjectsTable.OrganizationIndex,
 * workflows via WorkflowsTable.OrgStatusIndex, and integrations via a
 * direct Query on PK=ORG#{orgId} (same key shape as listIntegrations in
 * integration-resolver.ts) — no ScanCommand remains for any of them.
 * agent-config has no org attribute/GSI on its legacy table (confirmed:
 * backend/lib/backend-stack.ts's AgentConfigTable declares no GSI and no
 * orgId partition/sort key), so it is deliberately excluded from the
 * result (fail closed) rather than left as an unscoped, cross-tenant scan.
 *
 * NOTE (per finding 615aa5bb wiring instructions): getRecentActivity has
 * no deployed Lambda / AppSync resolver — this fix is code-level only and
 * is NOT wired by this change.
 */
import type { DynamoDBDocumentClient } from "@aws-sdk/lib-dynamodb";
import { QueryCommand, ScanCommand } from "@aws-sdk/lib-dynamodb";
import {
  getRecentActivity,
  type RecentActivityDeps,
} from "../recent-activity-resolver";

const mockSend = jest.fn();
const mockDeps: RecentActivityDeps = {
  docClient: { send: mockSend } as unknown as DynamoDBDocumentClient,
  projectsTable: "projects",
  agentConfigTable: "agents",
  workflowsTable: "workflows",
  integrationsTable: "integrations",
};

beforeEach(() => mockSend.mockReset());

describe("getRecentActivity — org scoping (finding 615aa5bb)", () => {
  it("scopes projects via OrganizationIndex and workflows via OrgStatusIndex, never a table scan", async () => {
    mockSend.mockImplementation(async (command) => {
      if (command instanceof QueryCommand) {
        const input = command.input as {
          IndexName?: string;
          TableName?: string;
        };
        if (input.IndexName === "OrganizationIndex") {
          return {
            Items: [
              {
                id: "p1",
                name: "Org A Project",
                status: "IN_PROGRESS",
                organization: "org-a",
                updatedAt: "2026-04-13T10:00:00Z",
              },
            ],
          };
        }
        if (input.IndexName === "OrgStatusIndex") {
          return {
            Items: [
              {
                workflowId: "w1",
                name: "Org A Workflow",
                status: "ACTIVE",
                orgId: "org-a",
                updatedAt: "2026-04-13T11:00:00Z",
              },
            ],
          };
        }
        if (input.TableName === "integrations") {
          return {
            Items: [
              {
                integrationId: "i1",
                name: "Org A Integration",
                status: "CONNECTED",
                updatedAt: "2026-04-13T09:00:00Z",
              },
            ],
          };
        }
      }
      return { Items: [] };
    });

    const result = await getRecentActivity("org-a", 10, mockDeps);

    expect(result.items.map((i) => i.entityType).sort()).toEqual([
      "integration",
      "project",
      "workflow",
    ]);
    // No unscoped ScanCommand against any tenant table remains.
    expect(
      mockSend.mock.calls.every(([cmd]) => !(cmd instanceof ScanCommand)),
    ).toBe(true);
  });

  it("never returns another org's project or workflow rows", async () => {
    mockSend.mockImplementation(async (command) => {
      const input = (
        command as {
          input?: {
            IndexName?: string;
            ExpressionAttributeValues?: Record<string, string>;
          };
        }
      ).input;
      if (input?.IndexName === "OrganizationIndex") {
        expect(input.ExpressionAttributeValues?.[":org"]).toBe("org-a");
        return {
          Items: [
            {
              id: "p1",
              name: "P1",
              status: "OK",
              organization: "org-a",
              updatedAt: "2026-04-13T10:00:00Z",
            },
          ],
        };
      }
      if (input?.IndexName === "OrgStatusIndex") {
        expect(input.ExpressionAttributeValues?.[":orgId"]).toBe("org-a");
        return { Items: [] };
      }
      return { Items: [] };
    });

    const result = await getRecentActivity("org-a", 10, mockDeps);
    expect(result.items).toHaveLength(1);
    expect(result.items[0].entityId).toBe("p1");
  });

  it("excludes agent-config entries rather than performing an unscoped scan (no org attribute available)", async () => {
    mockSend.mockResolvedValue({
      Items: [
        { agentId: "a1", state: "active", updatedAt: "2026-04-13T12:00:00Z" },
      ],
    });

    const result = await getRecentActivity("org-a", 10, mockDeps);

    // agentConfigTable is never queried/scanned at all.
    expect(result.items.some((i) => i.entityType === "agent")).toBe(false);
  });
});
