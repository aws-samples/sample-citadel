/**
 * Unit tests for audit-cognito-custom-attributes.ts (CIT-210).
 *
 * The classification and remediation planning are pure functions and are
 * tested without any AWS mocks. The orchestration (`runAudit`) is exercised
 * against aws-sdk-client-mock'd Cognito + DynamoDB Document clients so we
 * can assert on the EXACT set of write commands issued (and, in dry-run,
 * that there are none).
 */
import {
  AdminAddUserToGroupCommand,
  AdminDeleteUserAttributesCommand,
  AdminListGroupsForUserCommand,
  AdminRemoveUserFromGroupCommand,
  AdminUpdateUserAttributesCommand,
  AdminUserGlobalSignOutCommand,
  CognitoIdentityProviderClient,
  ListUsersCommand,
} from "@aws-sdk/client-cognito-identity-provider";
import { DynamoDBClient } from "@aws-sdk/client-dynamodb";
import { DynamoDBDocumentClient, ScanCommand } from "@aws-sdk/lib-dynamodb";
import { mockClient } from "aws-sdk-client-mock";

import {
  classifyUser,
  planRemediation,
  runAudit,
  type AuditUser,
  type Finding,
} from "../audit-cognito-custom-attributes";

const cognitoMock = mockClient(CognitoIdentityProviderClient);
const ddbMock = mockClient(DynamoDBDocumentClient);

const VALID_ORGS = new Set(["Acme", "Globex"]);

function user(partial: Partial<AuditUser> & { username: string }): AuditUser {
  return {
    sub: `sub-${partial.username}`,
    groups: [],
    role: null,
    organization: null,
    ...partial,
  };
}

function kinds(findings: Finding[]): string[] {
  return findings.map((f) => f.kind).sort();
}

// ---------------------------------------------------------------------------
// classifyUser — pure
// ---------------------------------------------------------------------------

describe("classifyUser", () => {
  it("returns no findings for a consistent org member (role matches group, org valid)", () => {
    const u = user({
      username: "alice",
      groups: ["architect"],
      role: "architect",
      organization: "Acme",
    });
    expect(classifyUser(u, VALID_ORGS)).toEqual([]);
  });

  it("does NOT flag an admin-group member whose custom:role is 'admin'", () => {
    const u = user({
      username: "root",
      groups: ["admin"],
      role: "admin",
      organization: "Acme",
    });
    expect(classifyUser(u, VALID_ORGS)).toEqual([]);
  });

  it("returns no findings for a user with no groups and no custom attributes", () => {
    const u = user({ username: "ghost" });
    expect(classifyUser(u, VALID_ORGS)).toEqual([]);
  });

  it("flags ROLE_MISMATCH when custom:role names a group the user is not in", () => {
    const u = user({
      username: "bob",
      groups: ["developer"],
      role: "architect",
      organization: "Acme",
    });
    const findings = classifyUser(u, VALID_ORGS);
    expect(kinds(findings)).toEqual(["ROLE_MISMATCH"]);
    expect(findings[0].username).toBe("bob");
    expect(findings[0].sub).toBe("sub-bob");
  });

  it("flags ROLE_MISMATCH when custom:role=admin but the user is not in the admin group", () => {
    const u = user({
      username: "mallory",
      groups: ["developer"],
      role: "admin",
      organization: "Acme",
    });
    expect(kinds(classifyUser(u, VALID_ORGS))).toEqual(["ROLE_MISMATCH"]);
  });

  it("flags ROLE_MISMATCH when custom:role is set but the user has no groups at all", () => {
    const u = user({
      username: "carol",
      role: "developer",
      organization: "Acme",
    });
    expect(kinds(classifyUser(u, VALID_ORGS))).toEqual(["ROLE_MISMATCH"]);
  });

  it("flags ORG_UNKNOWN when custom:organization is not a valid org name", () => {
    const u = user({
      username: "dave",
      groups: ["developer"],
      role: "developer",
      organization: "Initech",
    });
    expect(kinds(classifyUser(u, VALID_ORGS))).toEqual(["ORG_UNKNOWN"]);
  });

  it("compares org names exactly (no trim / case-fold), per decision 228b3cc8", () => {
    const u = user({
      username: "erin",
      groups: ["developer"],
      role: "developer",
      organization: "acme",
    });
    expect(kinds(classifyUser(u, VALID_ORGS))).toEqual(["ORG_UNKNOWN"]);
  });

  it("flags ORG_MISSING when the user is in a group but has no custom:organization", () => {
    const u = user({
      username: "frank",
      groups: ["developer"],
      role: "developer",
    });
    expect(kinds(classifyUser(u, VALID_ORGS))).toEqual(["ORG_MISSING"]);
  });

  it("treats an empty-string custom:organization as missing", () => {
    const u = user({
      username: "grace",
      groups: ["developer"],
      role: "developer",
      organization: "",
    });
    expect(kinds(classifyUser(u, VALID_ORGS))).toEqual(["ORG_MISSING"]);
  });

  it("can report multiple finding classes for one user", () => {
    const u = user({ username: "heidi", groups: ["developer"], role: "admin" });
    expect(kinds(classifyUser(u, VALID_ORGS))).toEqual([
      "ORG_MISSING",
      "ROLE_MISMATCH",
    ]);
  });

  it("records the stored values on every finding as a rollback snapshot", () => {
    const u = user({
      username: "dave",
      groups: ["developer"],
      role: "developer",
      organization: "Initech",
    });
    const [f] = classifyUser(u, VALID_ORGS);
    expect(f.previous).toEqual({
      role: "developer",
      organization: "Initech",
      groups: ["developer"],
    });
  });
});

// ---------------------------------------------------------------------------
// planRemediation — pure
// ---------------------------------------------------------------------------

describe("planRemediation", () => {
  it("plans nothing for a user with no findings", () => {
    const u = user({
      username: "alice",
      groups: ["architect"],
      role: "architect",
      organization: "Acme",
    });
    const plan = planRemediation(u, classifyUser(u, VALID_ORGS));
    expect(plan.actions).toEqual([]);
    expect(plan.manual).toEqual([]);
  });

  it("ROLE_MISMATCH with a single group → set custom:role to that group, then global sign-out", () => {
    const u = user({
      username: "bob",
      groups: ["developer"],
      role: "architect",
      organization: "Acme",
    });
    const plan = planRemediation(u, classifyUser(u, VALID_ORGS));
    expect(plan.actions).toEqual([
      { type: "SET_ROLE", username: "bob", value: "developer" },
      { type: "GLOBAL_SIGN_OUT", username: "bob" },
    ]);
  });

  it("ROLE_MISMATCH with no groups → delete custom:role, then global sign-out", () => {
    const u = user({
      username: "carol",
      role: "developer",
      organization: "Acme",
    });
    const plan = planRemediation(u, classifyUser(u, VALID_ORGS));
    expect(plan.actions).toEqual([
      { type: "DELETE_ATTRIBUTE", username: "carol", attribute: "custom:role" },
      { type: "GLOBAL_SIGN_OUT", username: "carol" },
    ]);
  });

  it("ROLE_MISMATCH with multiple groups → no write; routed to manual review", () => {
    const u = user({
      username: "ivan",
      groups: ["developer", "architect"],
      role: "admin",
      organization: "Acme",
    });
    const plan = planRemediation(u, classifyUser(u, VALID_ORGS));
    expect(plan.actions).toEqual([]);
    expect(plan.manual).toHaveLength(1);
    expect(plan.manual[0].username).toBe("ivan");
    expect(plan.manual[0].kind).toBe("ROLE_MISMATCH");
  });

  it("ORG_UNKNOWN → delete custom:organization, then global sign-out", () => {
    const u = user({
      username: "dave",
      groups: ["developer"],
      role: "developer",
      organization: "Initech",
    });
    const plan = planRemediation(u, classifyUser(u, VALID_ORGS));
    expect(plan.actions).toEqual([
      {
        type: "DELETE_ATTRIBUTE",
        username: "dave",
        attribute: "custom:organization",
      },
      { type: "GLOBAL_SIGN_OUT", username: "dave" },
    ]);
  });

  it("ORG_MISSING → no write (the correct org is unknowable); routed to manual review", () => {
    const u = user({
      username: "frank",
      groups: ["developer"],
      role: "developer",
    });
    const plan = planRemediation(u, classifyUser(u, VALID_ORGS));
    expect(plan.actions).toEqual([]);
    expect(plan.manual.map((m) => m.kind)).toEqual(["ORG_MISSING"]);
  });

  it("issues exactly one GLOBAL_SIGN_OUT per modified user even with two fixable findings", () => {
    const u = user({
      username: "judy",
      groups: ["developer"],
      role: "admin",
      organization: "Initech",
    });
    const plan = planRemediation(u, classifyUser(u, VALID_ORGS));
    const signOuts = plan.actions.filter((a) => a.type === "GLOBAL_SIGN_OUT");
    expect(signOuts).toHaveLength(1);
    // Sign-out is always the LAST action for the user (mirrors assignUserRole).
    expect(plan.actions[plan.actions.length - 1].type).toBe("GLOBAL_SIGN_OUT");
  });

  it("never plans a group add/remove", () => {
    const u = user({
      username: "mallory",
      groups: ["developer"],
      role: "admin",
      organization: "Initech",
    });
    const plan = planRemediation(u, classifyUser(u, VALID_ORGS));
    for (const a of plan.actions) {
      expect(["SET_ROLE", "DELETE_ATTRIBUTE", "GLOBAL_SIGN_OUT"]).toContain(
        a.type,
      );
    }
  });
});

// ---------------------------------------------------------------------------
// runAudit — orchestration against mocked clients
// ---------------------------------------------------------------------------

function attrs(o: Record<string, string | undefined>) {
  return Object.entries(o)
    .filter(([, v]) => v !== undefined)
    .map(([Name, Value]) => ({ Name, Value }));
}

describe("runAudit", () => {
  let logs: string[];
  let logSpy: jest.SpyInstance;

  beforeEach(() => {
    cognitoMock.reset();
    ddbMock.reset();
    logs = [];
    logSpy = jest.spyOn(console, "log").mockImplementation((...args) => {
      logs.push(args.map(String).join(" "));
    });
    jest.spyOn(console, "error").mockImplementation(() => undefined);

    // Org table: two real org rows plus a NAME# reservation row (has itemType)
    // that must NOT count as a valid name.
    ddbMock.on(ScanCommand).resolves({
      Items: [
        { orgId: "org-1", name: "Acme" },
        { orgId: "org-2", name: "Globex" },
        { orgId: "NAME#Initech", name: "Initech", itemType: "name_tombstone" },
      ],
    });
  });

  afterEach(() => {
    logSpy.mockRestore();
    (console.error as jest.Mock).mockRestore?.();
  });

  function clients() {
    const cognito = new CognitoIdentityProviderClient({ region: "us-west-2" });
    const doc = DynamoDBDocumentClient.from(
      new DynamoDBClient({ region: "us-west-2" }),
    );
    return { cognito, doc };
  }

  function writeCommandCount(): number {
    return (
      cognitoMock.commandCalls(AdminUpdateUserAttributesCommand).length +
      cognitoMock.commandCalls(AdminDeleteUserAttributesCommand).length +
      cognitoMock.commandCalls(AdminUserGlobalSignOutCommand).length +
      cognitoMock.commandCalls(AdminAddUserToGroupCommand).length +
      cognitoMock.commandCalls(AdminRemoveUserFromGroupCommand).length
    );
  }

  it("paginates ListUsers, classifies every user, and exits 0 when there are no findings", async () => {
    cognitoMock
      .on(ListUsersCommand)
      .resolvesOnce({
        Users: [
          {
            Username: "alice",
            Attributes: attrs({
              sub: "s1",
              "custom:role": "architect",
              "custom:organization": "Acme",
            }),
          },
        ],
        PaginationToken: "page2",
      })
      .resolvesOnce({
        Users: [
          {
            Username: "root",
            Attributes: attrs({
              sub: "s2",
              "custom:role": "admin",
              "custom:organization": "Globex",
            }),
          },
        ],
      });
    cognitoMock
      .on(AdminListGroupsForUserCommand, { Username: "alice" })
      .resolves({ Groups: [{ GroupName: "architect" }] })
      .on(AdminListGroupsForUserCommand, { Username: "root" })
      .resolves({ Groups: [{ GroupName: "admin" }] });

    const { cognito, doc } = clients();
    const result = await runAudit({
      cognito,
      doc,
      userPoolId: "pool",
      organisationTable: "orgs",
      apply: false,
      sleepMs: 0,
    });

    expect(result.exitCode).toBe(0);
    expect(result.summary.scanned).toBe(2);
    expect(result.summary.findings).toEqual({
      ROLE_MISMATCH: 0,
      ORG_UNKNOWN: 0,
      ORG_MISSING: 0,
    });
    expect(cognitoMock.commandCalls(ListUsersCommand)).toHaveLength(2);
    expect(
      cognitoMock.commandCalls(AdminListGroupsForUserCommand),
    ).toHaveLength(2);
    expect(writeCommandCount()).toBe(0);
  });

  it("requests only sub + the two custom attributes from ListUsers (never email)", async () => {
    cognitoMock.on(ListUsersCommand).resolves({ Users: [] });
    const { cognito, doc } = clients();
    await runAudit({
      cognito,
      doc,
      userPoolId: "pool",
      organisationTable: "orgs",
      apply: false,
      sleepMs: 0,
    });
    const call = cognitoMock.commandCalls(ListUsersCommand)[0];
    expect(call.args[0].input.AttributesToGet).toEqual(
      expect.arrayContaining(["sub", "custom:role", "custom:organization"]),
    );
    expect(call.args[0].input.AttributesToGet).not.toContain("email");
  });

  it("dry-run: reports findings, exits 3, and issues ZERO write commands", async () => {
    cognitoMock.on(ListUsersCommand).resolves({
      Users: [
        {
          Username: "mallory",
          Attributes: attrs({
            sub: "s1",
            "custom:role": "admin",
            "custom:organization": "Acme",
          }),
        },
        {
          Username: "dave",
          Attributes: attrs({
            sub: "s2",
            "custom:role": "developer",
            "custom:organization": "Initech",
          }),
        },
        {
          Username: "frank",
          Attributes: attrs({ sub: "s3", "custom:role": "developer" }),
        },
      ],
    });
    cognitoMock
      .on(AdminListGroupsForUserCommand)
      .resolves({ Groups: [{ GroupName: "developer" }] });

    const { cognito, doc } = clients();
    const result = await runAudit({
      cognito,
      doc,
      userPoolId: "pool",
      organisationTable: "orgs",
      apply: false,
      sleepMs: 0,
    });

    expect(result.exitCode).toBe(3);
    expect(result.summary.findings).toEqual({
      ROLE_MISMATCH: 1,
      ORG_UNKNOWN: 1,
      ORG_MISSING: 1,
    });
    expect(writeCommandCount()).toBe(0);
    // Table + JSON summary printed.
    const out = logs.join("\n");
    expect(out).toContain("ROLE_MISMATCH");
    expect(out).toContain("mallory");
    expect(out).toMatch(/"findings"\s*:/);
  });

  it("apply: sets/deletes attributes per plan, signs out each modified user once, never touches groups", async () => {
    cognitoMock.on(ListUsersCommand).resolves({
      Users: [
        {
          Username: "mallory",
          Attributes: attrs({
            sub: "s1",
            "custom:role": "admin",
            "custom:organization": "Initech",
          }),
        },
        {
          Username: "carol",
          Attributes: attrs({
            sub: "s2",
            "custom:role": "developer",
            "custom:organization": "Acme",
          }),
        },
        {
          Username: "frank",
          Attributes: attrs({ sub: "s3", "custom:role": "developer" }),
        },
      ],
    });
    cognitoMock
      .on(AdminListGroupsForUserCommand, { Username: "mallory" })
      .resolves({ Groups: [{ GroupName: "developer" }] })
      .on(AdminListGroupsForUserCommand, { Username: "carol" })
      .resolves({ Groups: [] })
      .on(AdminListGroupsForUserCommand, { Username: "frank" })
      .resolves({ Groups: [{ GroupName: "developer" }] });
    cognitoMock.on(AdminUpdateUserAttributesCommand).resolves({});
    cognitoMock.on(AdminDeleteUserAttributesCommand).resolves({});
    cognitoMock.on(AdminUserGlobalSignOutCommand).resolves({});

    const { cognito, doc } = clients();
    const result = await runAudit({
      cognito,
      doc,
      userPoolId: "pool",
      organisationTable: "orgs",
      apply: true,
      sleepMs: 0,
    });

    // mallory: ROLE_MISMATCH (single group) → SET custom:role=developer; ORG_UNKNOWN → DELETE custom:organization.
    const updates = cognitoMock.commandCalls(AdminUpdateUserAttributesCommand);
    expect(updates).toHaveLength(1);
    expect(updates[0].args[0].input).toEqual({
      UserPoolId: "pool",
      Username: "mallory",
      UserAttributes: [{ Name: "custom:role", Value: "developer" }],
    });

    const deletes = cognitoMock
      .commandCalls(AdminDeleteUserAttributesCommand)
      .map((c) => c.args[0].input);
    expect(deletes).toEqual(
      expect.arrayContaining([
        {
          UserPoolId: "pool",
          Username: "mallory",
          UserAttributeNames: ["custom:organization"],
        },
        // carol: ROLE_MISMATCH with no groups → delete custom:role.
        {
          UserPoolId: "pool",
          Username: "carol",
          UserAttributeNames: ["custom:role"],
        },
      ]),
    );
    expect(deletes).toHaveLength(2);

    const signOuts = cognitoMock
      .commandCalls(AdminUserGlobalSignOutCommand)
      .map((c) => c.args[0].input.Username);
    expect(signOuts.sort()).toEqual(["carol", "mallory"]);

    // frank (ORG_MISSING) is manual-only: no writes and no sign-out.
    expect(signOuts).not.toContain("frank");

    expect(cognitoMock.commandCalls(AdminAddUserToGroupCommand)).toHaveLength(
      0,
    );
    expect(
      cognitoMock.commandCalls(AdminRemoveUserFromGroupCommand),
    ).toHaveLength(0);

    expect(result.summary.modifiedUsers).toBe(2);
    expect(result.summary.errors).toBe(0);
    // Unremediable (manual) findings remain → still exit 3.
    expect(result.exitCode).toBe(3);
  });

  it("apply: exits 0 when every finding was remediated without error", async () => {
    cognitoMock.on(ListUsersCommand).resolves({
      Users: [
        {
          Username: "dave",
          Attributes: attrs({
            sub: "s2",
            "custom:role": "developer",
            "custom:organization": "Initech",
          }),
        },
      ],
    });
    cognitoMock
      .on(AdminListGroupsForUserCommand)
      .resolves({ Groups: [{ GroupName: "developer" }] });
    cognitoMock.on(AdminDeleteUserAttributesCommand).resolves({});
    cognitoMock.on(AdminUserGlobalSignOutCommand).resolves({});

    const { cognito, doc } = clients();
    const result = await runAudit({
      cognito,
      doc,
      userPoolId: "pool",
      organisationTable: "orgs",
      apply: true,
      sleepMs: 0,
    });

    expect(result.exitCode).toBe(0);
    expect(result.summary.modifiedUsers).toBe(1);
  });

  it("apply: a failing write is counted as an error, skips that user's sign-out, and exits 1", async () => {
    cognitoMock.on(ListUsersCommand).resolves({
      Users: [
        {
          Username: "dave",
          Attributes: attrs({
            sub: "s2",
            "custom:role": "developer",
            "custom:organization": "Initech",
          }),
        },
      ],
    });
    cognitoMock
      .on(AdminListGroupsForUserCommand)
      .resolves({ Groups: [{ GroupName: "developer" }] });
    cognitoMock.on(AdminDeleteUserAttributesCommand).rejects(new Error("boom"));
    cognitoMock.on(AdminUserGlobalSignOutCommand).resolves({});

    const { cognito, doc } = clients();
    const result = await runAudit({
      cognito,
      doc,
      userPoolId: "pool",
      organisationTable: "orgs",
      apply: true,
      sleepMs: 0,
    });

    expect(result.summary.errors).toBe(1);
    expect(
      cognitoMock.commandCalls(AdminUserGlobalSignOutCommand),
    ).toHaveLength(0);
    expect(result.exitCode).toBe(1);
  });

  it("--json mode prints only the JSON document to stdout", async () => {
    cognitoMock.on(ListUsersCommand).resolves({
      Users: [
        {
          Username: "frank",
          Attributes: attrs({ sub: "s3", "custom:role": "developer" }),
        },
      ],
    });
    cognitoMock
      .on(AdminListGroupsForUserCommand)
      .resolves({ Groups: [{ GroupName: "developer" }] });

    const { cognito, doc } = clients();
    await runAudit({
      cognito,
      doc,
      userPoolId: "pool",
      organisationTable: "orgs",
      apply: false,
      json: true,
      sleepMs: 0,
    });

    expect(logs).toHaveLength(1);
    const parsed = JSON.parse(logs[0]);
    expect(parsed.summary.findings.ORG_MISSING).toBe(1);
    expect(parsed.findings[0]).toMatchObject({
      username: "frank",
      sub: "s3",
      kind: "ORG_MISSING",
    });
  });
});
