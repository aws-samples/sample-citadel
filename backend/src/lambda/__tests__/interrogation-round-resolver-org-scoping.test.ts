/**
 * Org-scoping tests for interrogation-round-resolver (finding 2c262386,
 * module 3/4).
 *
 * DEFECT: startInterrogationRound / injectConstraints / stabiliseRound
 * gated only on hasPermission('adr:create') and trusted the client-
 * supplied projectId with NO project-to-organization reconciliation.
 * stabiliseRound is the sharpest op: it writes a governance transcript to
 * S3 (encrypted because it carries PII, via redactPII + SSE-KMS) and sets
 * TERMINAL state (STABILISED) on a foreign round — a cross-org caller
 * could write a PII-bearing transcript into another org's governance
 * namespace and drive their round to a terminal state.
 *
 * FIX: assertProjectOrgAccess(projectId, event) — the SAME shared helper
 * from PR 142 / finding 677c1a6c — is threaded through every exported
 * function as an ADDITIONAL, optional `event` parameter. For
 * stabiliseRound, the gate runs after the round is fetched (fetch-then-
 * verify — roundN/projectId are the only client args, but the row itself
 * must exist to be gated meaningfully) and BEFORE the idempotent-
 * STABILISED early-return, BEFORE the S3 PutObjectCommand, and BEFORE the
 * terminal UpdateCommand / governance event emission.
 *
 * Acceptance:
 *  - cross-org caller refused on start/inject/stabilise/get/list; zero
 *    writes, zero S3 PutObject (zero transcript writes), zero foreign
 *    reads returned
 *  - same-org caller WITH adr:create succeeds
 *  - same-org caller WITHOUT adr:create is still refused (additive)
 */
import {
  DynamoDBDocumentClient,
  GetCommand,
  PutCommand,
  UpdateCommand,
  QueryCommand,
} from "@aws-sdk/lib-dynamodb";
import { S3Client, PutObjectCommand } from "@aws-sdk/client-s3";
import {
  EventBridgeClient,
  PutEventsCommand,
} from "@aws-sdk/client-eventbridge";
import { mockClient } from "aws-sdk-client-mock";
import type { AuthContext } from "../../types";

const ddbMock = mockClient(DynamoDBDocumentClient);
const s3Mock = mockClient(S3Client);
const ebMock = mockClient(EventBridgeClient);

process.env.INTERROGATION_ROUNDS_TABLE = "citadel-interrogation-rounds-test";
process.env.GOVERNANCE_TRANSCRIPTS_BUCKET =
  "citadel-governance-transcripts-test";
process.env.EVENT_BUS_NAME = "citadel-agents-test";
process.env.PROJECTS_TABLE = "citadel-projects-test";

import {
  startInterrogationRound,
  injectConstraints,
  stabiliseRound,
  getInterrogationRound,
  listInterrogationRounds,
  handler,
} from "../interrogation-round-resolver";
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

const existingRound = {
  projectId: "proj-1",
  roundN: 1,
  transcriptS3Uri:
    "s3://citadel-governance-transcripts-test/projects/proj-1/rounds/1.jsonl",
  status: "IN_PROGRESS",
  startedAt: "2024-01-01T00:00:00.000Z",
};

describe("interrogation-round-resolver — project-org scoping (finding 2c262386)", () => {
  beforeEach(() => {
    ddbMock.reset();
    s3Mock.reset();
    ebMock.reset();
    ebMock
      .on(PutEventsCommand)
      .resolves({ FailedEntryCount: 0, Entries: [{ EventId: "evt-1" }] });
    s3Mock.on(PutObjectCommand).resolves({});
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

  function stubRound(overrides: Record<string, unknown> = {}) {
    ddbMock
      .on(GetCommand, {
        TableName: "citadel-interrogation-rounds-test",
        Key: { projectId: "proj-1", roundN: 1 },
      })
      .resolves({ Item: { ...existingRound, ...overrides } });
  }

  // ── startInterrogationRound ──────────────────────────────────────────

  describe("startInterrogationRound", () => {
    test("cross-org caller refused; zero PutCommand to rounds table", async () => {
      stubProject("org-a");
      const auth = mockAuthContextFor("architect");
      const event = crossOrgEvent("startInterrogationRound", {
        projectId: "proj-1",
        roundN: 1,
      });

      await expect(
        startInterrogationRound("proj-1", 1, auth, event),
      ).rejects.toBeInstanceOf(ProjectOrgAccessError);

      const puts = ddbMock
        .commandCalls(PutCommand)
        .filter(
          (c) =>
            c.args[0].input.TableName === "citadel-interrogation-rounds-test",
        );
      expect(puts).toHaveLength(0);
    });

    test("same-org caller with adr:create succeeds", async () => {
      stubProject("org-a");
      ddbMock.on(PutCommand).resolves({});
      const auth = mockAuthContextFor("architect");
      const event = sameOrgEvent("startInterrogationRound", {
        projectId: "proj-1",
        roundN: 1,
      });

      const round = await startInterrogationRound("proj-1", 1, auth, event);
      expect(round.status).toBe("IN_PROGRESS");
    });

    test("same-org caller WITHOUT adr:create is still refused (additive)", async () => {
      stubProject("org-a");
      const auth = mockAuthContextFor("developer");
      const event = sameOrgEvent(
        "startInterrogationRound",
        { projectId: "proj-1", roundN: 1 },
        "developer",
      );

      await expect(
        startInterrogationRound("proj-1", 1, auth, event),
      ).rejects.toThrow(/UnauthorizedError/);
      const puts = ddbMock
        .commandCalls(PutCommand)
        .filter(
          (c) =>
            c.args[0].input.TableName === "citadel-interrogation-rounds-test",
        );
      expect(puts).toHaveLength(0);
    });
  });

  // ── injectConstraints ─────────────────────────────────────────────────

  describe("injectConstraints", () => {
    test("cross-org caller refused; zero UpdateCommand", async () => {
      stubRound("IN_PROGRESS");
      stubProject("org-a");
      const auth = mockAuthContextFor("architect");
      const event = crossOrgEvent("injectConstraints", {
        projectId: "proj-1",
        roundN: 1,
        constraints: ["c1"],
      });

      await expect(
        injectConstraints("proj-1", 1, ["c1"], auth, event),
      ).rejects.toBeInstanceOf(ProjectOrgAccessError);
      expect(ddbMock.commandCalls(UpdateCommand)).toHaveLength(0);
    });

    test("same-org caller with adr:create succeeds", async () => {
      stubRound("IN_PROGRESS");
      stubProject("org-a");
      ddbMock.on(UpdateCommand).resolves({
        Attributes: { ...existingRound, status: "AWAITING_CONSTRAINTS" },
      });
      const auth = mockAuthContextFor("architect");
      const event = sameOrgEvent("injectConstraints", {
        projectId: "proj-1",
        roundN: 1,
        constraints: ["c1"],
      });

      const round = await injectConstraints("proj-1", 1, ["c1"], auth, event);
      expect(round.status).toBe("AWAITING_CONSTRAINTS");
    });
  });

  // ── stabiliseRound (sharpest op: transcript write + terminal state) ──

  describe("stabiliseRound", () => {
    test("cross-org caller refused; zero S3 PutObject (zero transcript writes)", async () => {
      stubRound("IN_PROGRESS");
      stubProject("org-a");
      const auth = mockAuthContextFor("architect");
      const event = crossOrgEvent("stabiliseRound", {
        projectId: "proj-1",
        roundN: 1,
      });

      await expect(
        stabiliseRound(
          "proj-1",
          1,
          [{ role: "user", content: "hello" }],
          "summary",
          auth,
          event,
        ),
      ).rejects.toBeInstanceOf(ProjectOrgAccessError);

      expect(s3Mock.commandCalls(PutObjectCommand)).toHaveLength(0);
    });

    test("cross-org caller refused; zero UpdateCommand (terminal STABILISED state never set on foreign round)", async () => {
      stubRound("IN_PROGRESS");
      stubProject("org-a");
      const auth = mockAuthContextFor("architect");
      const event = crossOrgEvent("stabiliseRound", {
        projectId: "proj-1",
        roundN: 1,
      });

      await expect(
        stabiliseRound(
          "proj-1",
          1,
          [{ role: "user", content: "hello" }],
          "summary",
          auth,
          event,
        ),
      ).rejects.toBeInstanceOf(ProjectOrgAccessError);

      expect(ddbMock.commandCalls(UpdateCommand)).toHaveLength(0);
      expect(ebMock.commandCalls(PutEventsCommand)).toHaveLength(0);
    });

    test("cross-org caller refused even when the round is already STABILISED (idempotent early-return does not bypass the gate)", async () => {
      stubRound("STABILISED");
      stubProject("org-a");
      const auth = mockAuthContextFor("architect");
      const event = crossOrgEvent("stabiliseRound", {
        projectId: "proj-1",
        roundN: 1,
      });

      await expect(
        stabiliseRound(
          "proj-1",
          1,
          [{ role: "user", content: "hello" }],
          "summary",
          auth,
          event,
        ),
      ).rejects.toBeInstanceOf(ProjectOrgAccessError);
      expect(s3Mock.commandCalls(PutObjectCommand)).toHaveLength(0);
    });

    test("same-org caller with adr:create succeeds; transcript written and round transitions to STABILISED", async () => {
      stubRound("IN_PROGRESS");
      stubProject("org-a");
      ddbMock.on(UpdateCommand).resolves({
        Attributes: { ...existingRound, status: "STABILISED" },
      });
      const auth = mockAuthContextFor("architect");
      const event = sameOrgEvent("stabiliseRound", {
        projectId: "proj-1",
        roundN: 1,
      });

      const round = await stabiliseRound(
        "proj-1",
        1,
        [{ role: "user", content: "hello" }],
        "summary",
        auth,
        event,
      );
      expect(round.status).toBe("STABILISED");
      expect(s3Mock.commandCalls(PutObjectCommand)).toHaveLength(1);
    });

    test("same-org caller WITHOUT adr:create is still refused; zero transcript write", async () => {
      stubRound("IN_PROGRESS");
      stubProject("org-a");
      const auth = mockAuthContextFor("developer");
      const event = sameOrgEvent(
        "stabiliseRound",
        { projectId: "proj-1", roundN: 1 },
        "developer",
      );

      await expect(
        stabiliseRound(
          "proj-1",
          1,
          [{ role: "user", content: "hello" }],
          "summary",
          auth,
          event,
        ),
      ).rejects.toThrow(/UnauthorizedError/);
      expect(s3Mock.commandCalls(PutObjectCommand)).toHaveLength(0);
    });

    test("fetch-then-verify ordering: org check runs after fetching the round but before any write", async () => {
      stubRound("IN_PROGRESS");
      stubProject("org-b"); // caller is org-a -> cross-org
      const auth = mockAuthContextFor("architect");
      const event = sameOrgEvent("stabiliseRound", {
        projectId: "proj-1",
        roundN: 1,
      });

      await expect(
        stabiliseRound(
          "proj-1",
          1,
          [{ role: "user", content: "hello" }],
          "summary",
          auth,
          event,
        ),
      ).rejects.toBeInstanceOf(ProjectOrgAccessError);
      expect(s3Mock.commandCalls(PutObjectCommand)).toHaveLength(0);
      expect(ddbMock.commandCalls(UpdateCommand)).toHaveLength(0);
    });
  });

  // ── getInterrogationRound (fetch-then-verify read) ───────────────────

  describe("getInterrogationRound", () => {
    test("cross-org caller refused; round never returned", async () => {
      stubRound();
      stubProject("org-a");
      const event = crossOrgEvent("getInterrogationRound", {
        projectId: "proj-1",
        roundN: 1,
      });

      await expect(
        getInterrogationRound("proj-1", 1, event),
      ).rejects.toBeInstanceOf(ProjectOrgAccessError);
    });

    test("same-org caller can read", async () => {
      stubRound();
      stubProject("org-a");
      const event = sameOrgEvent("getInterrogationRound", {
        projectId: "proj-1",
        roundN: 1,
      });

      const round = await getInterrogationRound("proj-1", 1, event);
      expect(round?.projectId).toBe("proj-1");
    });

    test("nonexistent round still returns null (fetch first, no crash)", async () => {
      ddbMock.on(GetCommand).resolves({});
      const event = sameOrgEvent("getInterrogationRound", {
        projectId: "missing",
        roundN: 1,
      });
      const round = await getInterrogationRound("missing", 1, event);
      expect(round).toBeNull();
    });
  });

  // ── listInterrogationRounds ───────────────────────────────────────────

  describe("listInterrogationRounds", () => {
    test("cross-org caller refused; zero QueryCommand against rounds table", async () => {
      stubProject("org-a");
      const event = crossOrgEvent("listInterrogationRounds", {
        projectId: "proj-1",
      });

      await expect(
        listInterrogationRounds("proj-1", event),
      ).rejects.toBeInstanceOf(ProjectOrgAccessError);
      const queries = ddbMock
        .commandCalls(QueryCommand)
        .filter(
          (c) =>
            c.args[0].input.TableName === "citadel-interrogation-rounds-test",
        );
      expect(queries).toHaveLength(0);
    });

    test("same-org caller can list", async () => {
      stubProject("org-a");
      ddbMock
        .on(QueryCommand, { TableName: "citadel-interrogation-rounds-test" })
        .resolves({ Items: [] });
      const event = sameOrgEvent("listInterrogationRounds", {
        projectId: "proj-1",
      });

      const rounds = await listInterrogationRounds("proj-1", event);
      expect(rounds).toEqual([]);
    });
  });

  // ── handler dispatch always threads event ───────────────────────────

  describe("handler dispatch threads event into the org gate", () => {
    test("stabiliseRound via handler: cross-org caller refused, zero transcript write", async () => {
      stubRound("IN_PROGRESS");
      stubProject("org-a");
      await expect(
        handler(
          crossOrgEvent("stabiliseRound", {
            projectId: "proj-1",
            roundN: 1,
            transcript: [{ role: "user", content: "hi" }],
            stabilisedSummary: "s",
          }),
        ),
      ).rejects.toThrow(/Access denied/);
      expect(s3Mock.commandCalls(PutObjectCommand)).toHaveLength(0);
    });

    test("stabiliseRound via handler: same-org caller with permission succeeds", async () => {
      stubRound("IN_PROGRESS");
      stubProject("org-a");
      ddbMock.on(UpdateCommand).resolves({
        Attributes: { ...existingRound, status: "STABILISED" },
      });
      const result = (await handler(
        sameOrgEvent("stabiliseRound", {
          projectId: "proj-1",
          roundN: 1,
          transcript: [{ role: "user", content: "hi" }],
          stabilisedSummary: "s",
        }),
      )) as { status: string };
      expect(result.status).toBe("STABILISED");
    });

    test("stabiliseRound via handler: same-org caller without permission refused", async () => {
      stubRound("IN_PROGRESS");
      stubProject("org-a");
      await expect(
        handler(
          sameOrgEvent(
            "stabiliseRound",
            {
              projectId: "proj-1",
              roundN: 1,
              transcript: [{ role: "user", content: "hi" }],
              stabilisedSummary: "s",
            },
            "developer",
          ),
        ),
      ).rejects.toThrow(/UnauthorizedError/);
    });
  });
});
