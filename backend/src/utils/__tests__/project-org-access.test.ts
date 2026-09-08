/**
 * Unit tests for assertProjectOrgAccess (finding 677c1a6c).
 *
 * assertProjectOrgAccess is the shared project-to-organization join used by
 * adr-resolver (pilot) and, in follow-on findings, the other governance
 * modules (execspec, program-review, interrogation-round,
 * agent-design-assessment). It reuses project-resolver.getProject's own
 * "may access this project" semantics — project.owner === callerId OR
 * (callerOrg && project.organization === callerOrg) — rather than inventing
 * a second definition, and preserves the admin-bypass convention used by the
 * sibling helpers (assertRowOrg, assertManifestAccess).
 *
 * Fail-closed matrix under test: absent identity, unresolvable caller org,
 * missing project, and a project whose organization cannot be determined
 * (no organization attribute and caller is not the owner) all THROW rather
 * than defaulting to allow.
 */
import { DynamoDBDocumentClient, GetCommand } from "@aws-sdk/lib-dynamodb";
import { mockClient } from "aws-sdk-client-mock";

process.env.PROJECTS_TABLE = "citadel-projects-test";

const ddbMock = mockClient(DynamoDBDocumentClient);

import {
  assertProjectOrgAccess,
  ProjectOrgAccessError,
} from "../project-org-access";

describe("assertProjectOrgAccess", () => {
  beforeEach(() => {
    ddbMock.reset();
  });

  test("resolves when caller org matches project.organization", async () => {
    ddbMock.on(GetCommand).resolves({
      Item: { id: "proj-1", owner: "owner-1", organization: "org-a" },
    });
    const event = { identity: { sub: "u1", "custom:organization": "org-a" } };
    await expect(
      assertProjectOrgAccess("proj-1", event),
    ).resolves.toBeUndefined();
  });

  test("resolves when caller is the project owner, even if org claim differs", async () => {
    ddbMock.on(GetCommand).resolves({
      Item: { id: "proj-1", owner: "u1", organization: "org-a" },
    });
    const event = { identity: { sub: "u1", "custom:organization": "org-b" } };
    await expect(
      assertProjectOrgAccess("proj-1", event),
    ).resolves.toBeUndefined();
  });

  test("throws ProjectOrgAccessError when caller org differs from project org and caller is not owner", async () => {
    ddbMock.on(GetCommand).resolves({
      Item: { id: "proj-1", owner: "owner-1", organization: "org-a" },
    });
    const event = { identity: { sub: "u2", "custom:organization": "org-b" } };
    await expect(
      assertProjectOrgAccess("proj-1", event),
    ).rejects.toBeInstanceOf(ProjectOrgAccessError);
  });

  test("fails closed when identity is absent from the event", async () => {
    ddbMock.on(GetCommand).resolves({
      Item: { id: "proj-1", owner: "owner-1", organization: "org-a" },
    });
    await expect(assertProjectOrgAccess("proj-1", {})).rejects.toBeInstanceOf(
      ProjectOrgAccessError,
    );
    // No accidental fall-through to a bare truthy check — assert no read
    // was ever attempted before we can even resolve identity? Actually a
    // Get IS issued (we need the project to check owner), so instead assert
    // the specific failure mode: rejects, does not resolve.
  });

  test("fails closed when the caller's organization cannot be resolved and caller is not owner", async () => {
    ddbMock.on(GetCommand).resolves({
      Item: { id: "proj-1", owner: "owner-1", organization: "org-a" },
    });
    // No custom:organization claim, no USER_POOL_ID configured -> null org.
    const event = { identity: { sub: "u2" } };
    await expect(
      assertProjectOrgAccess("proj-1", event),
    ).rejects.toBeInstanceOf(ProjectOrgAccessError);
  });

  test("fails closed when the project does not exist", async () => {
    ddbMock.on(GetCommand).resolves({});
    const event = { identity: { sub: "u1", "custom:organization": "org-a" } };
    await expect(
      assertProjectOrgAccess("proj-missing", event),
    ).rejects.toBeInstanceOf(ProjectOrgAccessError);
  });

  test("fails closed when the project has no organization attribute and caller is not the owner", async () => {
    ddbMock.on(GetCommand).resolves({
      Item: { id: "proj-1", owner: "owner-1" }, // no organization field
    });
    const event = { identity: { sub: "u2", "custom:organization": "org-a" } };
    await expect(
      assertProjectOrgAccess("proj-1", event),
    ).rejects.toBeInstanceOf(ProjectOrgAccessError);
  });

  test("admin bypasses the org check entirely, even for a cross-org project", async () => {
    ddbMock.on(GetCommand).resolves({
      Item: { id: "proj-1", owner: "owner-1", organization: "org-a" },
    });
    const event = {
      identity: { sub: "admin-1", "custom:role": "admin" },
    };
    await expect(
      assertProjectOrgAccess("proj-1", event),
    ).resolves.toBeUndefined();
  });

  test("admin bypass does not require a DynamoDB read of the project at all", async () => {
    // Sanity: the admin bypass short-circuits before the fetch, matching
    // assertRowOrg's isAdminFromEvent(event) early-return convention.
    ddbMock.on(GetCommand).rejects(new Error("should not be called"));
    const event = { identity: { sub: "admin-1", "custom:role": "admin" } };
    await expect(
      assertProjectOrgAccess("proj-1", event),
    ).resolves.toBeUndefined();
    expect(ddbMock.commandCalls(GetCommand)).toHaveLength(0);
  });

  test("ProjectOrgAccessError carries an Access denied message", async () => {
    ddbMock.on(GetCommand).resolves({});
    const event = { identity: { sub: "u1", "custom:organization": "org-a" } };
    await expect(assertProjectOrgAccess("proj-x", event)).rejects.toThrow(
      /Access denied/,
    );
  });

  test("fails closed when projectId is empty", async () => {
    const event = { identity: { sub: "u1", "custom:organization": "org-a" } };
    await expect(assertProjectOrgAccess("", event)).rejects.toBeInstanceOf(
      ProjectOrgAccessError,
    );
    expect(ddbMock.commandCalls(GetCommand)).toHaveLength(0);
  });
});
