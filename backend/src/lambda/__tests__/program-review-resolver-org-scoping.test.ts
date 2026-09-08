/**
 * Org-scoping tests for program-review-resolver (finding 2c262386, module
 * 4/4).
 *
 * DEFECT: runProgramReview gated only on hasPermission('adr:create') and
 * trusted the client-supplied projectId with NO project-to-organization
 * reconciliation. It reads another organization's ACCUMULATED GOVERNANCE
 * EVIDENCE (ADRs, execution specs, interrogation rounds, agent design
 * assessment — fetched via the sibling resolvers' internal, event-less
 * calls) and writes an append-only ProgramReview row against their
 * projectId.
 *
 * FIX: assertProjectOrgAccess(projectId, event) — the SAME shared helper
 * from PR 142 / finding 677c1a6c — is threaded through every exported
 * function as an ADDITIONAL, optional `event` parameter. For
 * runProgramReview, the gate runs BEFORE the parallel evidence-fetch
 * Promise.all (so zero foreign evidence reads happen for a cross-org
 * caller) and BEFORE the PutCommand that persists the review row.
 *
 * Acceptance:
 *  - cross-org caller refused on runProgramReview/get/list; zero evidence
 *    reads (adrs/specs/rounds/assessment), zero review writes
 *  - same-org caller WITH adr:create succeeds
 *  - same-org caller WITHOUT adr:create is still refused (additive)
 */
import {
  DynamoDBDocumentClient,
  GetCommand,
  PutCommand,
  QueryCommand,
} from "@aws-sdk/lib-dynamodb";
import { mockClient } from "aws-sdk-client-mock";
import type { AuthContext } from "../../types";

const ddbMock = mockClient(DynamoDBDocumentClient);

process.env.PROGRAM_REVIEWS_TABLE = "citadel-program-reviews-test";
process.env.ADRS_TABLE = "citadel-adrs-test";
process.env.EXECUTION_SPECS_TABLE = "citadel-execution-specifications-test";
process.env.INTERROGATION_ROUNDS_TABLE = "citadel-interrogation-rounds-test";
process.env.AGENT_DESIGN_ASSESSMENTS_TABLE =
  "citadel-agent-design-assessments-test";
process.env.PROJECTS_TABLE = "citadel-projects-test";
process.env.ENVIRONMENT = "test";

import {
  runProgramReview,
  getProgramReview,
  listProgramReviewsForProject,
  handler,
} from "../program-review-resolver";
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

const existingReview = {
  reviewId: "review-1",
  projectId: "proj-1",
  results: [],
  runAt: "2024-01-01T00:00:00.000Z",
  runBy: "someone",
  createdAt: "2024-01-01T00:00:00.000Z",
};

describe("program-review-resolver — project-org scoping (finding 2c262386)", () => {
  beforeEach(() => {
    ddbMock.reset();
  });

  function stubProject(organization = "org-a", owner = "someone-else") {
    ddbMock
      .on(GetCommand, {
        TableName: "citadel-projects-test",
        Key: { id: "proj-1" },
      })
      .resolves({ Item: { id: "proj-1", owner, organization } });
  }

  // ── runProgramReview (sharpest op: reads all evidence + writes review) ──

  describe("runProgramReview", () => {
    test("cross-org caller refused; ZERO evidence reads (adrs/specs/rounds/assessment) attempted", async () => {
      stubProject("org-a");
      const auth = mockAuthContextFor("architect");
      const event = crossOrgEvent("runProgramReview", { projectId: "proj-1" });

      await expect(
        runProgramReview("proj-1", auth, event),
      ).rejects.toBeInstanceOf(ProjectOrgAccessError);

      const adrQueries = ddbMock
        .commandCalls(QueryCommand)
        .filter((c) => c.args[0].input.TableName === "citadel-adrs-test");
      const specQueries = ddbMock
        .commandCalls(QueryCommand)
        .filter(
          (c) =>
            c.args[0].input.TableName ===
            "citadel-execution-specifications-test",
        );
      const roundQueries = ddbMock
        .commandCalls(QueryCommand)
        .filter(
          (c) =>
            c.args[0].input.TableName === "citadel-interrogation-rounds-test",
        );
      const assessmentGets = ddbMock
        .commandCalls(GetCommand)
        .filter(
          (c) =>
            c.args[0].input.TableName ===
            "citadel-agent-design-assessments-test",
        );
      expect(adrQueries).toHaveLength(0);
      expect(specQueries).toHaveLength(0);
      expect(roundQueries).toHaveLength(0);
      expect(assessmentGets).toHaveLength(0);
    });

    test("cross-org caller refused; zero PutCommand to PROGRAM_REVIEWS_TABLE (no review persisted)", async () => {
      stubProject("org-a");
      const auth = mockAuthContextFor("architect");
      const event = crossOrgEvent("runProgramReview", { projectId: "proj-1" });

      await expect(
        runProgramReview("proj-1", auth, event),
      ).rejects.toBeInstanceOf(ProjectOrgAccessError);

      const puts = ddbMock
        .commandCalls(PutCommand)
        .filter(
          (c) => c.args[0].input.TableName === "citadel-program-reviews-test",
        );
      expect(puts).toHaveLength(0);
    });

    test("same-org caller with adr:create succeeds", async () => {
      stubProject("org-a");
      ddbMock.on(QueryCommand).resolves({ Items: [] });
      ddbMock
        .on(GetCommand, {
          TableName: "citadel-agent-design-assessments-test",
          Key: { projectId: "proj-1" },
        })
        .resolves({});
      ddbMock.on(PutCommand).resolves({});
      const auth = mockAuthContextFor("architect");
      const event = sameOrgEvent("runProgramReview", { projectId: "proj-1" });

      const review = await runProgramReview("proj-1", auth, event);
      expect(review.projectId).toBe("proj-1");
    });

    test("same-org caller WITHOUT adr:create is still refused (additive, zero writes)", async () => {
      stubProject("org-a");
      const auth = mockAuthContextFor("developer");
      const event = sameOrgEvent(
        "runProgramReview",
        { projectId: "proj-1" },
        "developer",
      );

      await expect(runProgramReview("proj-1", auth, event)).rejects.toThrow(
        /UnauthorizedError/,
      );
      const puts = ddbMock
        .commandCalls(PutCommand)
        .filter(
          (c) => c.args[0].input.TableName === "citadel-program-reviews-test",
        );
      expect(puts).toHaveLength(0);
    });

    test("fetch-then-verify not needed here (projectId is a direct argument) — org check runs before any evidence fetch, not after", async () => {
      stubProject("org-b"); // caller is org-a -> cross-org
      const auth = mockAuthContextFor("architect");
      const event = sameOrgEvent("runProgramReview", { projectId: "proj-1" });

      await expect(
        runProgramReview("proj-1", auth, event),
      ).rejects.toBeInstanceOf(ProjectOrgAccessError);
      expect(ddbMock.commandCalls(QueryCommand)).toHaveLength(0);
      expect(
        ddbMock
          .commandCalls(GetCommand)
          .filter((c) => c.args[0].input.TableName !== "citadel-projects-test"),
      ).toHaveLength(0);
    });
  });

  // ── getProgramReview (fetch-then-verify read) ────────────────────────

  describe("getProgramReview", () => {
    function stubReview() {
      ddbMock
        .on(GetCommand, {
          TableName: "citadel-program-reviews-test",
          Key: { reviewId: "review-1" },
        })
        .resolves({ Item: existingReview });
    }

    test("cross-org caller refused; review never returned", async () => {
      stubReview();
      stubProject("org-a");
      const event = crossOrgEvent("getProgramReview", {
        reviewId: "review-1",
      });

      await expect(getProgramReview("review-1", event)).rejects.toBeInstanceOf(
        ProjectOrgAccessError,
      );
    });

    test("same-org caller can read", async () => {
      stubReview();
      stubProject("org-a");
      const event = sameOrgEvent("getProgramReview", {
        reviewId: "review-1",
      });

      const review = await getProgramReview("review-1", event);
      expect(review?.reviewId).toBe("review-1");
    });

    test("nonexistent review still returns null (fetch first, no crash)", async () => {
      ddbMock.on(GetCommand).resolves({});
      const event = sameOrgEvent("getProgramReview", { reviewId: "missing" });
      const review = await getProgramReview("missing", event);
      expect(review).toBeNull();
    });
  });

  // ── listProgramReviewsForProject ─────────────────────────────────────

  describe("listProgramReviewsForProject", () => {
    test("cross-org caller refused; zero QueryCommand against PROGRAM_REVIEWS_TABLE", async () => {
      stubProject("org-a");
      const event = crossOrgEvent("listProgramReviewsForProject", {
        projectId: "proj-1",
      });

      await expect(
        listProgramReviewsForProject("proj-1", event),
      ).rejects.toBeInstanceOf(ProjectOrgAccessError);
      const queries = ddbMock
        .commandCalls(QueryCommand)
        .filter(
          (c) => c.args[0].input.TableName === "citadel-program-reviews-test",
        );
      expect(queries).toHaveLength(0);
    });

    test("same-org caller can list", async () => {
      stubProject("org-a");
      ddbMock
        .on(QueryCommand, { TableName: "citadel-program-reviews-test" })
        .resolves({ Items: [] });
      const event = sameOrgEvent("listProgramReviewsForProject", {
        projectId: "proj-1",
      });

      const reviews = await listProgramReviewsForProject("proj-1", event);
      expect(reviews).toEqual([]);
    });
  });

  // ── handler dispatch always threads event ───────────────────────────

  describe("handler dispatch threads event into the org gate", () => {
    test("runProgramReview via handler: cross-org caller refused, zero evidence reads, zero writes", async () => {
      stubProject("org-a");
      await expect(
        handler(crossOrgEvent("runProgramReview", { projectId: "proj-1" })),
      ).rejects.toThrow(/Access denied/);
      expect(ddbMock.commandCalls(QueryCommand)).toHaveLength(0);
      expect(
        ddbMock
          .commandCalls(PutCommand)
          .filter(
            (c) => c.args[0].input.TableName === "citadel-program-reviews-test",
          ),
      ).toHaveLength(0);
    });

    test("runProgramReview via handler: same-org caller with permission succeeds", async () => {
      stubProject("org-a");
      ddbMock.on(QueryCommand).resolves({ Items: [] });
      ddbMock
        .on(GetCommand, { TableName: "citadel-agent-design-assessments-test" })
        .resolves({});
      ddbMock.on(PutCommand).resolves({});
      const result = (await handler(
        sameOrgEvent("runProgramReview", { projectId: "proj-1" }),
      )) as { projectId: string };
      expect(result.projectId).toBe("proj-1");
    });

    test("runProgramReview via handler: same-org caller without permission refused", async () => {
      stubProject("org-a");
      await expect(
        handler(
          sameOrgEvent(
            "runProgramReview",
            { projectId: "proj-1" },
            "developer",
          ),
        ),
      ).rejects.toThrow(/UnauthorizedError/);
    });
  });
});
