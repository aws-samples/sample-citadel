/**
 * Org-scoping tests for execspec-resolver (finding 2c262386, module 1/4).
 *
 * DEFECT: approveExecutionSpecification / reviseExecutionSpecification (and
 * every other exported op) gated only on hasPermission('spec:approve') and
 * trusted the fetched specId's projectId with NO project-to-organization
 * reconciliation — an architect in org A could approve or rewrite org B's
 * governance execution spec by specId.
 *
 * FIX: assertProjectOrgAccess(projectId, event) — the SAME shared helper
 * from PR 142 / finding 677c1a6c, reused verbatim (no variant) — is
 * threaded through every exported function as an ADDITIONAL, optional
 * `event` parameter. The dispatch handler always supplies `event`.
 * hasPermission('spec:approve') remains in force, unchanged.
 *
 * Acceptance:
 *  - cross-org caller refused on create/submit/approve/reject/revise/get/
 *    list; zero writes to EXECUTION_SPECS_TABLE, zero foreign reads
 *  - same-org caller WITH spec:approve succeeds
 *  - same-org caller WITHOUT spec:approve is still refused (additive, not
 *    a replacement)
 *  - approveExecutionSpecification's own docblock states "Permission check
 *    FIRST — no DDB access, no event, before any state work" — this
 *    ordering (permission, then fetch, then org-check, then write) must be
 *    preserved, not replaced by audit-before-auth (no such ordering exists
 *    in this module — see note in the reject test below).
 */
import {
  DynamoDBDocumentClient,
  GetCommand,
  PutCommand,
  UpdateCommand,
  QueryCommand,
} from "@aws-sdk/lib-dynamodb";
import { EventBridgeClient, PutEventsCommand } from "@aws-sdk/client-eventbridge";
import { mockClient } from "aws-sdk-client-mock";
import type { AuthContext } from "../../types";

const ddbMock = mockClient(DynamoDBDocumentClient);
const ebMock = mockClient(EventBridgeClient);

process.env.EXECUTION_SPECS_TABLE = "citadel-execution-specs-test";
process.env.EVENT_BUS_NAME = "citadel-agents-test";
process.env.PROJECTS_TABLE = "citadel-projects-test";

import {
  createExecutionSpecification,
  submitExecutionSpecification,
  approveExecutionSpecification,
  rejectExecutionSpecification,
  reviseExecutionSpecification,
  getExecutionSpecification,
  listExecutionSpecifications,
  handler,
} from "../execspec-resolver";
import { __resetGovernanceNotifierForTest } from "../../utils/notifier-base";
import { ProjectOrgAccessError } from "../../utils/project-org-access";

function mockAuthContextFor(role: "architect" | "developer"): AuthContext {
  return { userId: `user-${role}`, username: role, groups: [], roles: [role] };
}

const VALID_NARRATIVE =
  "s3://citadel-governance-transcripts-test-123456789012-us-east-1/projects/proj-1/spec.md";

function baseCreateInput(overrides: Record<string, unknown> = {}) {
  return {
    projectId: "proj-1",
    sourceAdrIds: ["adr-1"],
    structuredPayload: "{}",
    narrativeS3Uri: VALID_NARRATIVE,
    ...overrides,
  };
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

const existingSpec = {
  specId: "spec-1",
  projectId: "proj-1",
  sourceAdrIds: ["adr-1"],
  structuredPayload: "{}",
  narrativeS3Uri: VALID_NARRATIVE,
  status: "DRAFT",
  version: 1,
  createdAt: "2024-01-01T00:00:00.000Z",
  createdBy: "someone",
};

describe("execspec-resolver — project-org scoping (finding 2c262386)", () => {
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

  function stubSpec(status = "DRAFT", version = 1) {
    ddbMock
      .on(GetCommand, {
        TableName: "citadel-execution-specs-test",
        Key: { specId: "spec-1" },
      })
      .resolves({ Item: { ...existingSpec, status, version } });
  }

  // ── createExecutionSpecification ────────────────────────────────────

  describe("createExecutionSpecification", () => {
    test("cross-org caller refused; zero PutCommand to EXECUTION_SPECS_TABLE", async () => {
      stubProject("org-a");
      const auth = mockAuthContextFor("architect");
      const event = crossOrgEvent("createExecutionSpecification", {});

      await expect(
        createExecutionSpecification(baseCreateInput(), auth, event),
      ).rejects.toBeInstanceOf(ProjectOrgAccessError);

      const puts = ddbMock
        .commandCalls(PutCommand)
        .filter(
          (c) => c.args[0].input.TableName === "citadel-execution-specs-test",
        );
      expect(puts).toHaveLength(0);
    });

    test("same-org caller with spec:approve succeeds", async () => {
      stubProject("org-a");
      ddbMock.on(PutCommand).resolves({});
      const auth = mockAuthContextFor("architect");
      const event = sameOrgEvent("createExecutionSpecification", {});

      const spec = await createExecutionSpecification(
        baseCreateInput(),
        auth,
        event,
      );
      expect(spec.status).toBe("DRAFT");
    });

    test("same-org caller WITHOUT spec:approve is still refused (additive, not replaced)", async () => {
      stubProject("org-a");
      const auth = mockAuthContextFor("developer");
      const event = sameOrgEvent(
        "createExecutionSpecification",
        {},
        "developer",
      );

      await expect(
        createExecutionSpecification(baseCreateInput(), auth, event),
      ).rejects.toThrow(/UnauthorizedError/);
      const puts = ddbMock
        .commandCalls(PutCommand)
        .filter(
          (c) => c.args[0].input.TableName === "citadel-execution-specs-test",
        );
      expect(puts).toHaveLength(0);
    });
  });

  // ── approveExecutionSpecification (sharpest op) ─────────────────────

  describe("approveExecutionSpecification", () => {
    test("cross-org caller refused; zero UpdateCommand, zero governance event emitted", async () => {
      stubSpec("PENDING_REVIEW");
      stubProject("org-a");
      const auth = mockAuthContextFor("architect");
      const event = crossOrgEvent("approveExecutionSpecification", {
        specId: "spec-1",
      });

      await expect(
        approveExecutionSpecification("spec-1", auth, event),
      ).rejects.toBeInstanceOf(ProjectOrgAccessError);

      expect(ddbMock.commandCalls(UpdateCommand)).toHaveLength(0);
      expect(ebMock.commandCalls(PutEventsCommand)).toHaveLength(0);
    });

    test("same-org caller with spec:approve succeeds and state transitions to APPROVED", async () => {
      stubSpec("PENDING_REVIEW");
      stubProject("org-a");
      ddbMock.on(UpdateCommand).resolves({
        Attributes: { ...existingSpec, status: "APPROVED", version: 2 },
      });
      const auth = mockAuthContextFor("architect");
      const event = sameOrgEvent("approveExecutionSpecification", {
        specId: "spec-1",
      });

      const result = await approveExecutionSpecification("spec-1", auth, event);
      expect(result.status).toBe("APPROVED");
    });

    test("same-org caller WITHOUT spec:approve is still refused", async () => {
      stubSpec("PENDING_REVIEW");
      stubProject("org-a");
      const auth = mockAuthContextFor("developer");
      const event = sameOrgEvent(
        "approveExecutionSpecification",
        { specId: "spec-1" },
        "developer",
      );

      await expect(
        approveExecutionSpecification("spec-1", auth, event),
      ).rejects.toThrow(/UnauthorizedError/);
      expect(ddbMock.commandCalls(UpdateCommand)).toHaveLength(0);
    });

    test("fetch-then-verify ordering: org check runs before the UpdateCommand", async () => {
      // spec is fetched (specId is the only client arg — projectId comes
      // from the fetched record), THEN the org check must run BEFORE any
      // write mutates spec state.
      stubSpec("PENDING_REVIEW");
      stubProject("org-b"); // caller is org-a in sameOrgEvent below -> cross-org
      const auth = mockAuthContextFor("architect");
      const event = sameOrgEvent("approveExecutionSpecification", {
        specId: "spec-1",
      });

      await expect(
        approveExecutionSpecification("spec-1", auth, event),
      ).rejects.toBeInstanceOf(ProjectOrgAccessError);
      expect(ddbMock.commandCalls(UpdateCommand)).toHaveLength(0);
    });
  });

  // ── reviseExecutionSpecification ────────────────────────────────────

  describe("reviseExecutionSpecification", () => {
    test("cross-org caller refused; zero UpdateCommand (rewrite blocked)", async () => {
      stubSpec("REJECTED");
      stubProject("org-a");
      const auth = mockAuthContextFor("architect");
      const event = crossOrgEvent("reviseExecutionSpecification", {
        specId: "spec-1",
        input: { structuredPayload: "{}", narrativeS3Uri: VALID_NARRATIVE },
      });

      await expect(
        reviseExecutionSpecification(
          "spec-1",
          { structuredPayload: "{}", narrativeS3Uri: VALID_NARRATIVE },
          auth,
          event,
        ),
      ).rejects.toBeInstanceOf(ProjectOrgAccessError);
      expect(ddbMock.commandCalls(UpdateCommand)).toHaveLength(0);
    });

    test("same-org caller with spec:approve succeeds", async () => {
      stubSpec("REJECTED");
      stubProject("org-a");
      ddbMock.on(UpdateCommand).resolves({
        Attributes: { ...existingSpec, status: "DRAFT", version: 2 },
      });
      const auth = mockAuthContextFor("architect");
      const event = sameOrgEvent("reviseExecutionSpecification", {
        specId: "spec-1",
      });

      const result = await reviseExecutionSpecification(
        "spec-1",
        { structuredPayload: "{}", narrativeS3Uri: VALID_NARRATIVE },
        auth,
        event,
      );
      expect(result.status).toBe("DRAFT");
    });
  });

  // ── submitExecutionSpecification ────────────────────────────────────

  describe("submitExecutionSpecification", () => {
    test("cross-org caller refused; zero UpdateCommand", async () => {
      stubSpec("DRAFT");
      stubProject("org-a");
      const auth = mockAuthContextFor("architect");
      const event = crossOrgEvent("submitExecutionSpecification", {
        specId: "spec-1",
      });

      await expect(
        submitExecutionSpecification("spec-1", auth, event),
      ).rejects.toBeInstanceOf(ProjectOrgAccessError);
      expect(ddbMock.commandCalls(UpdateCommand)).toHaveLength(0);
    });
  });

  // ── rejectExecutionSpecification ────────────────────────────────────
  // NOTE ON AUDIT ORDERING: this module's own docblock documents an
  // audit-before-auth pattern (structured console.log lines) for
  // rejectExecutionSpecification, matching the "QT3-3" convention used by
  // adr-resolver's reopenADR. Unlike reopenADR, this module does NOT
  // persist the audit line to a dedicated DynamoDB audit table — it is a
  // CloudWatch console.log side-effect, not a write our mocks can observe.
  // The org gate must run AFTER hasPermission (auth) has fired  and
  // must NOT be placed ahead of the existing audit-before-auth console.log
  // lines, since those must fire for every attempt regardless of the org
  // outcome (matching reopenADR's "audit row exists ∀ invocation"
  // invariant intent). The gate is inserted immediately after the spec is
  // fetched and BEFORE the terminal DDB UpdateCommand — i.e. after the
  // existing audit-then-auth-then-emit sequence, preserving that ordering.
  describe("rejectExecutionSpecification", () => {
    test("cross-org caller refused; zero UpdateCommand (terminal REJECTED state never written for foreign spec)", async () => {
      stubSpec("PENDING_REVIEW");
      stubProject("org-a");
      const auth = mockAuthContextFor("architect");
      const event = crossOrgEvent("rejectExecutionSpecification", {
        specId: "spec-1",
        reason: "not viable",
      });

      await expect(
        rejectExecutionSpecification("spec-1", "not viable", auth, event),
      ).rejects.toBeInstanceOf(ProjectOrgAccessError);
      expect(ddbMock.commandCalls(UpdateCommand)).toHaveLength(0);
    });

    test("audit-before-auth ordering preserved: governance.specification.rejected still emits on DENIED same-org attempts", async () => {
      stubSpec("PENDING_REVIEW");
      stubProject("org-a");
      const auth = mockAuthContextFor("developer");
      const event = sameOrgEvent(
        "rejectExecutionSpecification",
        { specId: "spec-1", reason: "x" },
        "developer",
      );

      await expect(
        rejectExecutionSpecification("spec-1", "x", auth, event),
      ).rejects.toThrow(/UnauthorizedError/);
      // The existing audit-before-auth emit must still fire for a
      // same-org DENIED attempt — this fix must not disturb that ordering.
      expect(ebMock.commandCalls(PutEventsCommand).length).toBeGreaterThan(0);
    });

    test("same-org caller with spec:approve succeeds", async () => {
      stubSpec("PENDING_REVIEW");
      stubProject("org-a");
      ddbMock.on(UpdateCommand).resolves({
        Attributes: { ...existingSpec, status: "REJECTED", version: 2 },
      });
      const auth = mockAuthContextFor("architect");
      const event = sameOrgEvent("rejectExecutionSpecification", {
        specId: "spec-1",
        reason: "not viable",
      });

      const result = await rejectExecutionSpecification(
        "spec-1",
        "not viable",
        auth,
        event,
      );
      expect(result.status).toBe("REJECTED");
    });
  });

  // ── getExecutionSpecification (fetch-then-verify read) ──────────────

  describe("getExecutionSpecification", () => {
    test("cross-org caller refused; spec never returned", async () => {
      stubSpec("DRAFT");
      stubProject("org-a");
      const event = crossOrgEvent("getExecutionSpecification", {
        specId: "spec-1",
      });

      await expect(
        getExecutionSpecification("spec-1", event),
      ).rejects.toBeInstanceOf(ProjectOrgAccessError);
    });

    test("same-org caller can read", async () => {
      stubSpec("DRAFT");
      stubProject("org-a");
      const event = sameOrgEvent("getExecutionSpecification", {
        specId: "spec-1",
      });

      const spec = await getExecutionSpecification("spec-1", event);
      expect(spec?.specId).toBe("spec-1");
    });

    test("nonexistent spec still returns null (fetch first, no crash on missing row)", async () => {
      ddbMock.on(GetCommand).resolves({});
      const event = sameOrgEvent("getExecutionSpecification", {
        specId: "missing",
      });
      const spec = await getExecutionSpecification("missing", event);
      expect(spec).toBeNull();
    });
  });

  // ── listExecutionSpecifications ─────────────────────────────────────

  describe("listExecutionSpecifications", () => {
    test("cross-org caller refused; zero QueryCommand against EXECUTION_SPECS_TABLE", async () => {
      stubProject("org-a");
      const event = crossOrgEvent("listExecutionSpecifications", {
        projectId: "proj-1",
      });

      await expect(
        listExecutionSpecifications("proj-1", event),
      ).rejects.toBeInstanceOf(ProjectOrgAccessError);
      const queries = ddbMock
        .commandCalls(QueryCommand)
        .filter(
          (c) => c.args[0].input.TableName === "citadel-execution-specs-test",
        );
      expect(queries).toHaveLength(0);
    });

    test("same-org caller can list", async () => {
      stubProject("org-a");
      ddbMock
        .on(QueryCommand, { TableName: "citadel-execution-specs-test" })
        .resolves({ Items: [] });
      const event = sameOrgEvent("listExecutionSpecifications", {
        projectId: "proj-1",
      });

      const specs = await listExecutionSpecifications("proj-1", event);
      expect(specs).toEqual([]);
    });
  });

  // ── handler dispatch always threads event ───────────────────────────

  describe("handler dispatch threads event into the org gate for every case", () => {
    test("approveExecutionSpecification via handler: cross-org caller refused", async () => {
      stubSpec("PENDING_REVIEW");
      stubProject("org-a");
      await expect(
        handler(
          crossOrgEvent("approveExecutionSpecification", { specId: "spec-1" }),
        ),
      ).rejects.toThrow(/Access denied/);
    });

    test("reviseExecutionSpecification via handler: cross-org caller refused", async () => {
      stubSpec("REJECTED");
      stubProject("org-a");
      await expect(
        handler(
          crossOrgEvent("reviseExecutionSpecification", {
            specId: "spec-1",
            input: { structuredPayload: "{}", narrativeS3Uri: VALID_NARRATIVE },
          }),
        ),
      ).rejects.toThrow(/Access denied/);
    });

    test("approveExecutionSpecification via handler: same-org caller with permission succeeds", async () => {
      stubSpec("PENDING_REVIEW");
      stubProject("org-a");
      ddbMock.on(UpdateCommand).resolves({
        Attributes: { ...existingSpec, status: "APPROVED", version: 2 },
      });
      const result = (await handler(
        sameOrgEvent("approveExecutionSpecification", { specId: "spec-1" }),
      )) as { status: string };
      expect(result.status).toBe("APPROVED");
    });

    test("approveExecutionSpecification via handler: same-org caller without permission refused", async () => {
      stubSpec("PENDING_REVIEW");
      stubProject("org-a");
      await expect(
        handler(
          sameOrgEvent(
            "approveExecutionSpecification",
            { specId: "spec-1" },
            "developer",
          ),
        ),
      ).rejects.toThrow(/UnauthorizedError/);
    });
  });
});
