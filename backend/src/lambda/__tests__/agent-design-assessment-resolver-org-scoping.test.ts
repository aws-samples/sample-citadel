/**
 * Org-scoping tests for agent-design-assessment-resolver (finding 2c262386,
 * module 2/4).
 *
 * DEFECT: startAgentDesignAssessment / submitAgentDesignAssessment /
 * getAgentDesignAssessment gated only on hasPermission('assessment:submit')
 * (mutations) and trusted the client-supplied projectId with NO project-to-
 * organization reconciliation. submitAgentDesignAssessment is the sharpest:
 * it performs a TransactWriteCommand that mutates BOTH the assessments row
 * AND another organization's citadel-projects row (archetype/
 * archetypeConfidence/archetypeStatus) — a cross-org write into a foreign
 * PROJECTS record via the same transaction that touches the assessments
 * table.
 *
 * FIX: assertProjectOrgAccess(projectId, event) — the SAME shared helper
 * from PR 142 / finding 677c1a6c — is threaded through every exported
 * function as an ADDITIONAL, optional `event` parameter. Critically for
 * submitAgentDesignAssessment, the gate is placed BEFORE the
 * TransactWriteCommand is constructed at all — it must precede the WHOLE
 * transaction, not one leg of it, so a cross-org caller triggers zero
 * transaction commits (not even a partial/rolled-back one).
 *
 * Acceptance:
 *  - cross-org caller refused on start/submit/get; zero writes, zero
 *    transaction commits, zero foreign reads
 *  - same-org caller WITH assessment:submit succeeds
 *  - same-org caller WITHOUT assessment:submit is still refused (additive)
 */
import {
  DynamoDBDocumentClient,
  GetCommand,
  PutCommand,
  TransactWriteCommand,
} from "@aws-sdk/lib-dynamodb";
import {
  EventBridgeClient,
  PutEventsCommand,
} from "@aws-sdk/client-eventbridge";
import { mockClient } from "aws-sdk-client-mock";
import type { AuthContext } from "../../types";
import { ProjectArchetypeStatus } from "../../types";

const ddbMock = mockClient(DynamoDBDocumentClient);
const ebMock = mockClient(EventBridgeClient);

process.env.AGENT_DESIGN_ASSESSMENTS_TABLE =
  "citadel-agent-design-assessments-test";
process.env.PROJECTS_TABLE = "citadel-projects-test";
process.env.EVENT_BUS_NAME = "citadel-agents-test";

import {
  startAgentDesignAssessment,
  getAgentDesignAssessment,
  submitAgentDesignAssessment,
  handler,
} from "../agent-design-assessment-resolver";
import { __resetGovernanceNotifierForTest } from "../../utils/notifier-base";
import { ProjectOrgAccessError } from "../../utils/project-org-access";

function mockAuthContextFor(role: "architect" | "developer"): AuthContext {
  return { userId: `user-${role}`, username: role, groups: [], roles: [role] };
}

function crossOrgEvent(
  fieldName: string,
  args: Record<string, unknown>,
  role: "architect" | "developer" = "architect",
) {
  return {
    info: { fieldName },
    arguments: args,
    identity: {
      sub: `user-${role}-org-b`,
      username: role,
      "custom:role": role,
      "custom:organization": "org-b",
    },
  };
}

function sameOrgEvent(
  fieldName: string,
  args: Record<string, unknown>,
  role: "architect" | "developer" = "architect",
) {
  return {
    info: { fieldName },
    arguments: args,
    identity: {
      sub: `user-${role}-org-a`,
      username: role,
      "custom:role": role,
      "custom:organization": "org-a",
    },
  };
}

function validSubmitInput(overrides: Record<string, unknown> = {}) {
  return {
    projectId: "proj-1",
    archetype: "AGENTIC_WORKFLOW",
    archetypeConfidence: 0.9,
    dimensionRanking: [
      { dimension: "CODE", rank: 1, rationale: "r1" },
      { dimension: "DATA", rank: 2, rationale: "r2" },
      { dimension: "INTEGRATION", rank: 3, rationale: "r3" },
      { dimension: "INFRASTRUCTURE", rank: 4, rationale: "r4" },
    ],
    accessibleDataSources: ["s3"],
    primaryRiskAreas: ["security"],
    ...overrides,
  };
}

const existingRow = {
  projectId: "proj-1",
  archetype: null,
  archetypeConfidence: null,
  archetypeStatus: ProjectArchetypeStatus.PENDING,
  dimensionRanking: [],
  accessibleDataSources: [],
  primaryRiskAreas: [],
  completedAt: null,
  completedBy: null,
  createdAt: "2024-01-01T00:00:00.000Z",
  updatedAt: "2024-01-01T00:00:00.000Z",
};

describe("agent-design-assessment-resolver — project-org scoping (finding 2c262386)", () => {
  beforeEach(() => {
    ddbMock.reset();
    ebMock.reset();
    ebMock
      .on(PutEventsCommand)
      .resolves({ FailedEntryCount: 0, Entries: [{ EventId: "evt-1" }] });
    __resetGovernanceNotifierForTest();
  });

  function stubProject(organization = "org-a", owner = "someone-else") {
    ddbMock
      .on(GetCommand, {
        TableName: "citadel-projects-test",
        Key: { id: "proj-1" },
      })
      .resolves({ Item: { id: "proj-1", owner, organization } });
  }

  function stubAssessment(overrides: Record<string, unknown> = {}) {
    ddbMock
      .on(GetCommand, {
        TableName: "citadel-agent-design-assessments-test",
        Key: { projectId: "proj-1" },
      })
      .resolves({ Item: { ...existingRow, ...overrides } });
  }

  // ── startAgentDesignAssessment ───────────────────────────────────────

  describe("startAgentDesignAssessment", () => {
    test("cross-org caller refused; zero PutCommand to assessments table", async () => {
      stubProject("org-a");
      const auth = mockAuthContextFor("architect");
      const event = crossOrgEvent("startAgentDesignAssessment", {
        projectId: "proj-1",
      });

      await expect(
        startAgentDesignAssessment("proj-1", auth, event),
      ).rejects.toBeInstanceOf(ProjectOrgAccessError);

      const puts = ddbMock
        .commandCalls(PutCommand)
        .filter(
          (c) =>
            c.args[0].input.TableName ===
            "citadel-agent-design-assessments-test",
        );
      expect(puts).toHaveLength(0);
    });

    test("same-org caller with assessment:submit succeeds", async () => {
      stubProject("org-a");
      ddbMock.on(PutCommand).resolves({});
      const auth = mockAuthContextFor("architect");
      const event = sameOrgEvent("startAgentDesignAssessment", {
        projectId: "proj-1",
      });

      const row = await startAgentDesignAssessment("proj-1", auth, event);
      expect(row.archetypeStatus).toBe(ProjectArchetypeStatus.PENDING);
    });

    test("same-org caller WITHOUT assessment:submit is still refused (additive)", async () => {
      stubProject("org-a");
      const auth = mockAuthContextFor("developer");
      const event = sameOrgEvent(
        "startAgentDesignAssessment",
        { projectId: "proj-1" },
        "developer",
      );

      await expect(
        startAgentDesignAssessment("proj-1", auth, event),
      ).rejects.toThrow(/UnauthorizedError/);
      const puts = ddbMock
        .commandCalls(PutCommand)
        .filter(
          (c) =>
            c.args[0].input.TableName ===
            "citadel-agent-design-assessments-test",
        );
      expect(puts).toHaveLength(0);
    });
  });

  // ── getAgentDesignAssessment (fetch-then-verify read) ────────────────

  describe("getAgentDesignAssessment", () => {
    test("cross-org caller refused; row never returned", async () => {
      stubAssessment();
      stubProject("org-a");
      const event = crossOrgEvent("getAgentDesignAssessment", {
        projectId: "proj-1",
      });

      await expect(
        getAgentDesignAssessment("proj-1", event),
      ).rejects.toBeInstanceOf(ProjectOrgAccessError);
    });

    test("same-org caller can read", async () => {
      stubAssessment();
      stubProject("org-a");
      const event = sameOrgEvent("getAgentDesignAssessment", {
        projectId: "proj-1",
      });

      const row = await getAgentDesignAssessment("proj-1", event);
      expect(row?.projectId).toBe("proj-1");
    });

    test("nonexistent row still returns null (fetch first, no crash)", async () => {
      ddbMock.on(GetCommand).resolves({});
      const event = sameOrgEvent("getAgentDesignAssessment", {
        projectId: "missing",
      });
      const row = await getAgentDesignAssessment("missing", event);
      expect(row).toBeNull();
    });
  });

  // ── submitAgentDesignAssessment (TransactWrite — sharpest op) ────────

  describe("submitAgentDesignAssessment", () => {
    test("cross-org caller refused; ZERO TransactWriteCommand issued at all (gate precedes the whole transaction, not one leg)", async () => {
      stubAssessment();
      stubProject("org-a");
      const auth = mockAuthContextFor("architect");
      const event = crossOrgEvent("submitAgentDesignAssessment", {});

      await expect(
        submitAgentDesignAssessment(validSubmitInput() as never, auth, event),
      ).rejects.toBeInstanceOf(ProjectOrgAccessError);

      expect(ddbMock.commandCalls(TransactWriteCommand)).toHaveLength(0);
      expect(ebMock.commandCalls(PutEventsCommand)).toHaveLength(0);
    });

    test("cross-org caller refused; the foreign PROJECTS row is never mutated", async () => {
      stubAssessment();
      stubProject("org-a");
      const auth = mockAuthContextFor("architect");
      const event = crossOrgEvent("submitAgentDesignAssessment", {});

      await expect(
        submitAgentDesignAssessment(validSubmitInput() as never, auth, event),
      ).rejects.toBeInstanceOf(ProjectOrgAccessError);

      // No transaction means no leg of it touched PROJECTS_TABLE either.
      const transactCalls = ddbMock.commandCalls(TransactWriteCommand);
      const projectsLegs = transactCalls.flatMap((c) =>
        (c.args[0].input.TransactItems ?? []).filter(
          (item) => item.Update?.TableName === "citadel-projects-test",
        ),
      );
      expect(projectsLegs).toHaveLength(0);
    });

    test("same-org caller with assessment:submit succeeds; transaction commits", async () => {
      stubAssessment();
      stubProject("org-a");
      ddbMock.on(TransactWriteCommand).resolves({});
      // getAgentDesignAssessment is called again after commit (Step 6) —
      // stub returns a completed row on the second call.
      ddbMock
        .on(GetCommand, {
          TableName: "citadel-agent-design-assessments-test",
          Key: { projectId: "proj-1" },
        })
        .resolvesOnce({ Item: existingRow })
        .resolves({
          Item: {
            ...existingRow,
            archetype: "AGENTIC_WORKFLOW",
            archetypeStatus: ProjectArchetypeStatus.CLASSIFIED,
            completedAt: "2024-06-01T00:00:00.000Z",
          },
        });
      const auth = mockAuthContextFor("architect");
      const event = sameOrgEvent("submitAgentDesignAssessment", {});

      const result = await submitAgentDesignAssessment(
        validSubmitInput() as never,
        auth,
        event,
      );
      expect(result.archetypeStatus).toBe(ProjectArchetypeStatus.CLASSIFIED);
      expect(ddbMock.commandCalls(TransactWriteCommand)).toHaveLength(1);
    });

    test("same-org caller WITHOUT assessment:submit is still refused (additive, zero transaction)", async () => {
      stubAssessment();
      stubProject("org-a");
      const auth = mockAuthContextFor("developer");
      const event = sameOrgEvent(
        "submitAgentDesignAssessment",
        {},
        "developer",
      );

      await expect(
        submitAgentDesignAssessment(validSubmitInput() as never, auth, event),
      ).rejects.toThrow(/UnauthorizedError/);
      expect(ddbMock.commandCalls(TransactWriteCommand)).toHaveLength(0);
    });

    test("fetch-then-verify ordering: org check runs after fetching the existing row but before the transaction", async () => {
      stubAssessment();
      stubProject("org-b"); // caller is org-a -> cross-org
      const auth = mockAuthContextFor("architect");
      const event = sameOrgEvent("submitAgentDesignAssessment", {});

      await expect(
        submitAgentDesignAssessment(validSubmitInput() as never, auth, event),
      ).rejects.toBeInstanceOf(ProjectOrgAccessError);
      expect(ddbMock.commandCalls(TransactWriteCommand)).toHaveLength(0);
    });
  });

  // ── handler dispatch always threads event ───────────────────────────

  describe("handler dispatch threads event into the org gate", () => {
    test("submitAgentDesignAssessment via handler: cross-org caller refused, zero transaction", async () => {
      stubAssessment();
      stubProject("org-a");
      await expect(
        handler(
          crossOrgEvent("submitAgentDesignAssessment", validSubmitInput()),
        ),
      ).rejects.toThrow(/Access denied/);
      expect(ddbMock.commandCalls(TransactWriteCommand)).toHaveLength(0);
    });

    test("startAgentDesignAssessment via handler: cross-org caller refused", async () => {
      stubProject("org-a");
      await expect(
        handler(
          crossOrgEvent("startAgentDesignAssessment", { projectId: "proj-1" }),
        ),
      ).rejects.toThrow(/Access denied/);
    });

    test("submitAgentDesignAssessment via handler: same-org caller with permission succeeds", async () => {
      stubAssessment();
      stubProject("org-a");
      ddbMock.on(TransactWriteCommand).resolves({});
      ddbMock
        .on(GetCommand, {
          TableName: "citadel-agent-design-assessments-test",
          Key: { projectId: "proj-1" },
        })
        .resolvesOnce({ Item: existingRow })
        .resolves({
          Item: {
            ...existingRow,
            archetype: "AGENTIC_WORKFLOW",
            archetypeStatus: ProjectArchetypeStatus.CLASSIFIED,
            completedAt: "2024-06-01T00:00:00.000Z",
          },
        });
      const result = (await handler(
        sameOrgEvent("submitAgentDesignAssessment", validSubmitInput()),
      )) as { archetypeStatus: string };
      expect(result.archetypeStatus).toBe(ProjectArchetypeStatus.CLASSIFIED);
    });

    test("submitAgentDesignAssessment via handler: same-org caller without permission refused", async () => {
      stubAssessment();
      stubProject("org-a");
      await expect(
        handler(
          sameOrgEvent(
            "submitAgentDesignAssessment",
            validSubmitInput(),
            "developer",
          ),
        ),
      ).rejects.toThrow(/UnauthorizedError/);
    });
  });
});
