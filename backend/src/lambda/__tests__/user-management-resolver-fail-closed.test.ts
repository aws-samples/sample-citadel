/**
 * Fail-closed regression tests for user-management-resolver.ts (bite proof
 * gap, finding f21582e6 follow-up).
 *
 * A mutation-testing pass on `requireCallerOrg()` — changing `throw new
 * Error(...)` to `return org || ""` — left ALL existing tests in
 * user-management-resolver-org-scoping.test.ts green. The existing "fails
 * closed" tests happen to exercise the case where `extractOrgFromEvent`
 * itself resolves to `null` (no org claim, no Cognito attribute), which
 * `requireCallerOrg` then rejects — but nothing asserted that
 * `requireCallerOrg`'s OWN throw is what does the rejecting, and nothing
 * asserted that removing it changes behavior. An empty-string org "resolved"
 * by a mutated `requireCallerOrg` would satisfy `if (!org)` inside
 * `extractOrgFromEvent`'s callers identically to `null`, so a pure
 * `.rejects.toThrow()` on that path is not a proof the guard exists — it
 * only proves `extractOrgFromEvent` returned a falsy value, which it does
 * regardless of `requireCallerOrg`.
 *
 * This file closes that gap directly: every test here asserts a REFUSAL
 * (thrown error), never an empty-list return, because an empty result is
 * indistinguishable from a silent unfiltered-but-empty fallback. Two classes
 * of caller are covered for every affected op (listUsers, getUser,
 * listOrganizations, listAvailableRoles):
 *   (a) identity entirely absent (event.identity is undefined/empty)
 *   (b) identity present but the org claim is missing/empty (non-admin,
 *       Cognito custom:organization attribute absent AND JWT claim absent)
 *
 * Also covers the latent risk the probe implied: if a caller's org ever
 * resolved to "" instead of throwing, `organization !== callerOrg` would
 * treat a user record with NO custom:organization attribute (i.e.
 * `organization === undefined`) as same-org, because `undefined !== ""` is
 * true... wait — actually `undefined !== ""` is TRUE, so on its own the
 * loose comparison already excludes it. The real risk is a caller who is
 * non-admin AND has no org (mutated to resolve to "") being compared against
 * an org-less USER record whose `organization` attribute was also read as
 * `undefined` — see the note in the "empty-org safety" section below for
 * the precise mechanics verified against the current source.
 */

import {
  ListUsersCommand,
  AdminGetUserCommand,
  AdminListGroupsForUserCommand,
  ListGroupsCommand,
} from "@aws-sdk/client-cognito-identity-provider";
import { CognitoIdentityProviderClient } from "@aws-sdk/client-cognito-identity-provider";
import { DynamoDBDocumentClient, ScanCommand } from "@aws-sdk/lib-dynamodb";
import { mockClient } from "aws-sdk-client-mock";

const cognitoMock = mockClient(CognitoIdentityProviderClient);
const dynamoMock = mockClient(DynamoDBDocumentClient);

process.env.USER_POOL_ID = "test-pool";
process.env.ORGANISATION_TABLE = "test-orgs";

import { handler } from "../user-management-resolver";

type ResolverEvent = Parameters<typeof handler>[0];

interface UserResult {
  userId: string;
  email: string;
  organization?: string;
}

function buildEvent(
  fieldName: string,
  identity: ResolverEvent["identity"],
  args: Partial<ResolverEvent["arguments"]> = {},
): ResolverEvent {
  return {
    info: { fieldName },
    identity,
    arguments: args as ResolverEvent["arguments"],
  };
}

function cognitoUser(
  username: string,
  org?: string,
  statusEnabled = true,
): {
  Username: string;
  Attributes: { Name: string; Value: string }[];
  UserStatus: string;
  Enabled: boolean;
  UserCreateDate: Date;
} {
  const attrs = [
    { Name: "email", Value: `${username}@example.com` },
    { Name: "given_name", Value: "First" },
    { Name: "family_name", Value: "Last" },
  ];
  if (org !== undefined) {
    attrs.push({ Name: "custom:organization", Value: org });
  }
  return {
    Username: username,
    Attributes: attrs,
    UserStatus: "CONFIRMED",
    Enabled: statusEnabled,
    UserCreateDate: new Date("2024-01-01T00:00:00Z"),
  };
}

/** Stubs a non-admin caller with NO resolvable org: not an admin group
 * member, no `custom:organization` JWT claim on the event, and the
 * AdminGetUser fallback lookup returns no `custom:organization` attribute
 * either. This is case (b) — identity present, org claim missing/empty. */
function stubOrglessNonAdminCaller(username: string) {
  cognitoMock
    .on(AdminListGroupsForUserCommand, { Username: username })
    .resolves({ Groups: [{ GroupName: "developer" }] });
  cognitoMock.on(AdminGetUserCommand, { Username: username }).resolves({
    Username: username,
    UserAttributes: [],
  });
}

beforeEach(() => {
  cognitoMock.reset();
  dynamoMock.reset();
});

// ---------------------------------------------------------------------------
// (a) identity entirely absent — must REFUSE (throw), not return []
// ---------------------------------------------------------------------------

describe("fail-closed: identity entirely absent", () => {
  test("listUsers throws when event.identity is undefined", async () => {
    const event = buildEvent("listUsers", undefined);
    await expect(handler(event)).rejects.toThrow(
      /Unable to determine caller identity/,
    );
  });

  test("listUsers throws when event.identity is an empty object", async () => {
    const event = buildEvent("listUsers", {});
    await expect(handler(event)).rejects.toThrow(
      /Unable to determine caller identity/,
    );
  });

  test("getUser throws when event.identity is undefined", async () => {
    const event = buildEvent("getUser", undefined, { userId: "bob" });
    await expect(handler(event)).rejects.toThrow(
      /Unable to determine caller identity/,
    );
  });

  test("listOrganizations throws when event.identity is undefined", async () => {
    const event = buildEvent("listOrganizations", undefined);
    await expect(handler(event)).rejects.toThrow(
      /Unable to determine caller identity/,
    );
  });

  test("listAvailableRoles throws when event.identity is undefined", async () => {
    const event = buildEvent("listAvailableRoles", undefined);
    await expect(handler(event)).rejects.toThrow(
      /Unable to determine caller identity/,
    );
  });
});

// ---------------------------------------------------------------------------
// (b) identity present but org claim missing/empty — must REFUSE, not
// silently proceed with an empty-string org treated as a valid scope.
// ---------------------------------------------------------------------------

describe("fail-closed: identity present, caller org unresolvable", () => {
  test("listUsers throws naming the org-resolution failure (not admin, no org anywhere)", async () => {
    stubOrglessNonAdminCaller("orgless");
    // If ListUsers were ever reached despite the org guard failing, this
    // stub would make the test pass for the wrong reason (empty list from
    // an unrelated cause) — assert the specific message so a silent
    // fallback-to-[] cannot masquerade as a pass.
    cognitoMock.on(ListUsersCommand).resolves({ Users: [] });

    const event = buildEvent("listUsers", { username: "orgless" });
    await expect(handler(event)).rejects.toThrow(
      /Unable to determine caller's organization/,
    );
  });

  test("getUser throws naming the org-resolution failure when target is not self", async () => {
    stubOrglessNonAdminCaller("orgless");
    cognitoMock.on(AdminGetUserCommand, { Username: "bob" }).resolves({
      Username: "bob",
      UserAttributes: [{ Name: "custom:organization", Value: "org-a" }],
      UserStatus: "CONFIRMED",
      Enabled: true,
      UserCreateDate: new Date("2024-01-01T00:00:00Z"),
    });
    cognitoMock
      .on(AdminListGroupsForUserCommand, { Username: "bob" })
      .resolves({ Groups: [{ GroupName: "developer" }] });

    const event = buildEvent(
      "getUser",
      { username: "orgless" },
      { userId: "bob" },
    );
    await expect(handler(event)).rejects.toThrow(
      /Unable to determine caller's organization/,
    );
  });

  test("listOrganizations throws naming the org-resolution failure", async () => {
    stubOrglessNonAdminCaller("orgless");
    dynamoMock.on(ScanCommand).resolves({ Items: [] });

    const event = buildEvent("listOrganizations", { username: "orgless" });
    await expect(handler(event)).rejects.toThrow(
      /Unable to determine caller's organization/,
    );
  });

  test("listAvailableRoles does not require an org (only identity) — sanity boundary", async () => {
    // listAvailableRoles returns no tenant data and deliberately does not
    // call requireCallerOrg at all — only requireCallerUsername. Included
    // here as a boundary check so a future change that adds an org
    // requirement to this op is deliberate, not accidental.
    cognitoMock.on(ListGroupsCommand).resolves({ Groups: [] });
    const event = buildEvent("listAvailableRoles", { username: "orgless" });
    await expect(handler(event)).resolves.toEqual([]);
  });
});

// ---------------------------------------------------------------------------
// Empty-org safety: a user record with NO custom:organization attribute
// must never be treated as same-org as a caller, even if the caller's org
// resolution were ever weakened to produce "" instead of throwing.
// ---------------------------------------------------------------------------

describe("empty-org safety: org-less user records never match on loose equality", () => {
  test("listUsers never returns an org-less target user to a non-admin caller with a real org", async () => {
    // Caller alice has a real org (org-a). Target user "ghost" has NO
    // custom:organization attribute at all (organization === undefined in
    // the mapped result) — e.g. created before the org attribute was
    // populated, or via adminCreateUser (which never sets it — verified in
    // adminCreateUser's UserAttributes list in user-management-resolver.ts,
    // it only sets email/email_verified/given_name/family_name).
    cognitoMock
      .on(AdminListGroupsForUserCommand, { Username: "alice" })
      .resolves({ Groups: [{ GroupName: "developer" }] });
    cognitoMock.on(AdminGetUserCommand, { Username: "alice" }).resolves({
      Username: "alice",
      UserAttributes: [{ Name: "custom:organization", Value: "org-a" }],
    });
    cognitoMock.on(ListUsersCommand).resolves({
      Users: [cognitoUser("alice", "org-a"), cognitoUser("ghost", undefined)],
    });
    cognitoMock
      .on(AdminListGroupsForUserCommand, { Username: "ghost" })
      .resolves({ Groups: [{ GroupName: "developer" }] });

    const event = buildEvent("listUsers", { username: "alice" });
    const result = (await handler(event)) as UserResult[];

    expect(result.map((u) => u.userId)).toEqual(["alice"]);
  });

  test("getUser refuses an org-less target user for a non-admin caller with a real org", async () => {
    cognitoMock
      .on(AdminListGroupsForUserCommand, { Username: "alice" })
      .resolves({ Groups: [{ GroupName: "developer" }] });
    cognitoMock.on(AdminGetUserCommand, { Username: "alice" }).resolves({
      Username: "alice",
      UserAttributes: [{ Name: "custom:organization", Value: "org-a" }],
    });
    cognitoMock.on(AdminGetUserCommand, { Username: "ghost" }).resolves({
      Username: "ghost",
      UserAttributes: [],
      UserStatus: "CONFIRMED",
      Enabled: true,
      UserCreateDate: new Date("2024-01-01T00:00:00Z"),
    });
    cognitoMock
      .on(AdminListGroupsForUserCommand, { Username: "ghost" })
      .resolves({ Groups: [{ GroupName: "developer" }] });

    const event = buildEvent(
      "getUser",
      { username: "alice" },
      { userId: "ghost" },
    );

    await expect(handler(event)).rejects.toThrow(/User not found/);
  });

  test("an org-less caller (non-admin, org resolves falsy) is refused before reaching any org-equality comparison", async () => {
    // This is the actual latent-risk boundary: if the caller's own org is
    // unresolvable, requireCallerOrg throws BEFORE any `organization !==
    // callerOrg` comparison runs — so a mutated requireCallerOrg returning
    // "" is the only way an org-less caller could ever reach the
    // comparison at all. This test documents and pins that ordering: with
    // the real (unmutated) guard, the throw happens first.
    stubOrglessNonAdminCaller("orgless");
    cognitoMock.on(ListUsersCommand).resolves({
      Users: [cognitoUser("ghost", undefined)],
    });

    const event = buildEvent("listUsers", { username: "orgless" });
    await expect(handler(event)).rejects.toThrow(
      /Unable to determine caller's organization/,
    );
  });
});
