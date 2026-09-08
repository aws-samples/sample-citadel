/**
 * Org-scoping tests for adr-resolver (finding 677c1a6c).
 *
 * DEFECT: createADR/getADR/listADRsForProject (and the other adr-resolver
 * mutations) gated only on hasPermission('adr:create'/'adr:reopen') and
 * trusted the client-supplied projectId with no project-to-organization
 * reconciliation — a permitted user of one org could create/read/list ADRs
 * against another org's project.
 *
 * FIX: assertProjectOrgAccess(projectId, event) is threaded through every
 * op as an ADDITIONAL, optional-event gate (hasPermission stays). The
 * dispatch handler always supplies `event`; internal/system callers
 * (project-resolver's phase guard, program-review-resolver,
 * agent-import-resolver's SYSTEM_IMPORT_ADR_AUTHOR path) call the exported
 * functions directly with no event and are therefore unaffected — they
 * already operate on a projectId they resolved through their own path.
 *
 * Acceptance (from the task):
 *  - cross-org caller refused on create, read, and list; zero writes and
 *    zero reads of foreign data recorded by the mocks
 *  - same-org caller WITH adr:create succeeds
 *  - same-org caller WITHOUT adr:create is still refused on create (the org
 *    check is additive, not a replacement for hasPermission)
 */
import {
  DynamoDBDocumentClient,
  GetCommand,
  PutCommand,
  QueryCommand,
} from "@aws-sdk/lib-dynamodb";
import {
  EventBridgeClient,
  PutEventsCommand,
} from "@aws-sdk/client-eventbridge";
import { mockClient } from "aws-sdk-client-mock";
import type { AuthContext } from "../../types";

const ddbMock = mockClient(DynamoDBDocumentClient);
const ebMock = mockClient(EventBridgeClient);

process.env.ADRS_TABLE = "citadel-adrs-test";
process.env.ADR_REOPEN_ATTEMPTS_TABLE = "citadel-adr-reopen-attempts-test";
process.env.EVENT_BUS_NAME = "citadel-agents-test";
process.env.PROJECTS_TABLE = "citadel-projects-test";

import {
  createADR,
  getADR,
  listADRsForProject,
  handler,
  type ADRInput,
} from "../adr-resolver";
import { __resetGovernanceNotifierForTest } from "../../utils/notifier-base";
import { ProjectOrgAccessError } from "../../utils/project-org-access";

function mockAuthContextFor(role: "architect" | "developer"): AuthContext {
  return { userId: `user-${role}`, username: role, groups: [], roles: [role] };
}

function baseInput(overrides: Record<string, unknown> = {}): ADRInput {
  return {
    projectId: "proj-1",
    title: "Use PostgreSQL over MySQL",
    decision: "Adopt PostgreSQL 16 for all services.",
    reasoning: "Stronger type system, JSONB support, mature RLS.",
    constraints: [],
    alternativesConsidered: [],
    revisitConditions: [],
    sourceRoundIds: [],
    ...overrides,
  } as unknown as ADRInput;
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

describe("adr-resolver — project-org scoping (finding 677c1a6c)", () => {
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

  // ── createADR ────────────────────────────────────────────────────────

  describe("createADR", () => {
    test("cross-org caller with adr:create is refused; zero PutCommand to ADRS_TABLE", async () => {
      stubProject("org-a");
      const auth = mockAuthContextFor("architect");
      const event = crossOrgEvent("createADR", {});

      await expect(createADR(baseInput(), auth, event)).rejects.toBeInstanceOf(
        ProjectOrgAccessError,
      );

      const adrPuts = ddbMock
        .commandCalls(PutCommand)
        .filter((c) => c.args[0].input.TableName === "citadel-adrs-test");
      expect(adrPuts).toHaveLength(0);
    });

    test("same-org caller with adr:create succeeds", async () => {
      stubProject("org-a");
      ddbMock.on(PutCommand).resolves({});
      const auth = mockAuthContextFor("architect");
      const event = sameOrgEvent("createADR", {});

      const adr = await createADR(baseInput(), auth, event);
      expect(adr.status).toBe("PROPOSED");

      const adrPuts = ddbMock
        .commandCalls(PutCommand)
        .filter((c) => c.args[0].input.TableName === "citadel-adrs-test");
      expect(adrPuts).toHaveLength(1);
    });

    test("same-org caller WITHOUT adr:create is still refused (permission check not replaced)", async () => {
      stubProject("org-a");
      const auth = mockAuthContextFor("developer");
      const event = sameOrgEvent("createADR", {}, "developer");

      await expect(createADR(baseInput(), auth, event)).rejects.toThrow(
        /UnauthorizedError/,
      );
      const adrPuts = ddbMock
        .commandCalls(PutCommand)
        .filter((c) => c.args[0].input.TableName === "citadel-adrs-test");
      expect(adrPuts).toHaveLength(0);
    });

    test("internal caller with no event (system/legacy call) is unaffected by the org gate", async () => {
      ddbMock.on(PutCommand).resolves({});
      const auth = mockAuthContextFor("architect");
      const adr = await createADR(baseInput(), auth);
      expect(adr.status).toBe("PROPOSED");
      // No project lookup should even be attempted with no event supplied.
      const projectGets = ddbMock
        .commandCalls(GetCommand)
        .filter((c) => c.args[0].input.TableName === "citadel-projects-test");
      expect(projectGets).toHaveLength(0);
    });
  });

  // ── getADR ───────────────────────────────────────────────────────────

  describe("getADR", () => {
    const existing = {
      adrId: "adr-1",
      projectId: "proj-1",
      status: "PROPOSED",
      version: 1,
      title: "t",
      sourceRoundIds: [],
    };

    test("cross-org caller is refused and the ADR is never returned", async () => {
      ddbMock
        .on(GetCommand, {
          TableName: "citadel-adrs-test",
          Key: { adrId: "adr-1" },
        })
        .resolves({ Item: existing });
      stubProject("org-a");
      const event = crossOrgEvent("getADR", { adrId: "adr-1" });

      await expect(getADR("adr-1", event)).rejects.toBeInstanceOf(
        ProjectOrgAccessError,
      );
    });

    test("same-org caller can read the ADR", async () => {
      ddbMock
        .on(GetCommand, {
          TableName: "citadel-adrs-test",
          Key: { adrId: "adr-1" },
        })
        .resolves({ Item: existing });
      stubProject("org-a");
      const event = sameOrgEvent("getADR", { adrId: "adr-1" });

      const adr = await getADR("adr-1", event);
      expect(adr).toEqual(existing);
    });

    test("nonexistent ADR still returns null (ordering: fetch first, no crash on missing row)", async () => {
      ddbMock.on(GetCommand).resolves({});
      const event = sameOrgEvent("getADR", { adrId: "missing" });
      const adr = await getADR("missing", event);
      expect(adr).toBeNull();
    });

    test("internal caller with no event is unaffected", async () => {
      ddbMock
        .on(GetCommand, {
          TableName: "citadel-adrs-test",
          Key: { adrId: "adr-1" },
        })
        .resolves({ Item: existing });
      const adr = await getADR("adr-1");
      expect(adr).toEqual(existing);
      const projectGets = ddbMock
        .commandCalls(GetCommand)
        .filter((c) => c.args[0].input.TableName === "citadel-projects-test");
      expect(projectGets).toHaveLength(0);
    });
  });

  // ── listADRsForProject ───────────────────────────────────────────────

  describe("listADRsForProject", () => {
    test("cross-org caller is refused; zero QueryCommand against ADRS_TABLE (no foreign-data read)", async () => {
      stubProject("org-a");
      const event = crossOrgEvent("listADRsForProject", {
        projectId: "proj-1",
      });

      await expect(listADRsForProject("proj-1", event)).rejects.toBeInstanceOf(
        ProjectOrgAccessError,
      );
      const adrQueries = ddbMock
        .commandCalls(QueryCommand)
        .filter((c) => c.args[0].input.TableName === "citadel-adrs-test");
      expect(adrQueries).toHaveLength(0);
    });

    test("same-org caller can list", async () => {
      stubProject("org-a");
      ddbMock
        .on(QueryCommand, { TableName: "citadel-adrs-test" })
        .resolves({ Items: [] });
      const event = sameOrgEvent("listADRsForProject", { projectId: "proj-1" });

      const adrs = await listADRsForProject("proj-1", event);
      expect(adrs).toEqual([]);
    });

    test("internal caller with no event is unaffected", async () => {
      ddbMock.on(QueryCommand).resolves({ Items: [] });
      const adrs = await listADRsForProject("proj-1");
      expect(adrs).toEqual([]);
      const projectGets = ddbMock
        .commandCalls(GetCommand)
        .filter((c) => c.args[0].input.TableName === "citadel-projects-test");
      expect(projectGets).toHaveLength(0);
    });
  });

  // ── handler dispatch always threads event ───────────────────────────

  describe("handler dispatch threads event into the org gate", () => {
    test("createADR via handler: cross-org caller refused", async () => {
      stubProject("org-a");
      await expect(
        handler(crossOrgEvent("createADR", { input: baseInput() })),
      ).rejects.toThrow(/Access denied/);
    });

    test("getADR via handler: cross-org caller refused", async () => {
      const existing = {
        adrId: "adr-1",
        projectId: "proj-1",
        status: "PROPOSED",
        version: 1,
        title: "t",
        sourceRoundIds: [],
      };
      ddbMock
        .on(GetCommand, {
          TableName: "citadel-adrs-test",
          Key: { adrId: "adr-1" },
        })
        .resolves({ Item: existing });
      stubProject("org-a");
      await expect(
        handler(crossOrgEvent("getADR", { adrId: "adr-1" })),
      ).rejects.toThrow(/Access denied/);
    });

    test("listADRsForProject via handler: cross-org caller refused", async () => {
      stubProject("org-a");
      await expect(
        handler(crossOrgEvent("listADRsForProject", { projectId: "proj-1" })),
      ).rejects.toThrow(/Access denied/);
    });

    test("createADR via handler: same-org caller with permission succeeds", async () => {
      stubProject("org-a");
      ddbMock.on(PutCommand).resolves({});
      const result = (await handler(
        sameOrgEvent("createADR", { input: baseInput() }),
      )) as { status: string };
      expect(result.status).toBe("PROPOSED");
    });

    test("createADR via handler: same-org caller without permission refused", async () => {
      stubProject("org-a");
      await expect(
        handler(sameOrgEvent("createADR", { input: baseInput() }, "developer")),
      ).rejects.toThrow(/UnauthorizedError/);
    });
  });
});
