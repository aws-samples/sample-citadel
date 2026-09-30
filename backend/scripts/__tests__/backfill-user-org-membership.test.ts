/**
 * Unit tests for backfill-user-org-membership.ts (decision 00d40a31 —
 * server-derived `custom:organization` claim).
 *
 * `classifyUser` is a pure function and is tested without AWS mocks. The
 * orchestration (`runBackfill`) is exercised against aws-sdk-client-mock'd
 * Cognito + DynamoDB Document clients so we can assert on the EXACT set of
 * PutCommands issued (and, in dry-run, that there are none).
 */
import {
  CognitoIdentityProviderClient,
  ListUsersCommand,
} from "@aws-sdk/client-cognito-identity-provider";
import { DynamoDBClient } from "@aws-sdk/client-dynamodb";
import {
  DynamoDBDocumentClient,
  GetCommand,
  PutCommand,
  ScanCommand,
} from "@aws-sdk/lib-dynamodb";
import { mockClient } from "aws-sdk-client-mock";

import {
  classifyUser,
  main,
  parseFlags,
  runBackfill,
  type PoolUser,
} from "../backfill-user-org-membership";

const cognitoMock = mockClient(CognitoIdentityProviderClient);
const ddbMock = mockClient(DynamoDBDocumentClient);

const VALID_ORGS = new Set(["Acme", "Globex"]);

function attrs(o: Record<string, string | undefined>) {
  return Object.entries(o)
    .filter(([, v]) => v !== undefined)
    .map(([Name, Value]) => ({ Name, Value }));
}

// ---------------------------------------------------------------------------
// classifyUser — pure
// ---------------------------------------------------------------------------

describe("classifyUser", () => {
  const alice: PoolUser = {
    username: "alice",
    sub: "s1",
    organization: "Acme",
  };

  it("returns WRITE for a live org name with no existing membership row", () => {
    expect(classifyUser(alice, VALID_ORGS, null)).toBe("WRITE");
  });

  it("returns ALREADY_PRESENT when a row exists with the same orgName (idempotent re-run)", () => {
    expect(
      classifyUser(alice, VALID_ORGS, { sub: "s1", orgName: "Acme" }),
    ).toBe("ALREADY_PRESENT");
  });

  it("returns SKIPPED_ROW_MISMATCH (never overwrites) when a row exists with a DIFFERENT orgName — the table is authoritative, the attribute is display-only", () => {
    expect(
      classifyUser(alice, VALID_ORGS, { sub: "s1", orgName: "Globex" }),
    ).toBe("SKIPPED_ROW_MISMATCH");
  });

  it("returns SKIPPED_UNKNOWN_ORG when custom:organization is not a live org name", () => {
    expect(
      classifyUser({ ...alice, organization: "Initech" }, VALID_ORGS, null),
    ).toBe("SKIPPED_UNKNOWN_ORG");
  });

  it("compares org names exactly (no trim / case-fold), per decision 228b3cc8", () => {
    expect(
      classifyUser({ ...alice, organization: "acme" }, VALID_ORGS, null),
    ).toBe("SKIPPED_UNKNOWN_ORG");
  });

  it("returns NO_ORG_ATTRIBUTE when the user has no custom:organization (nothing to backfill)", () => {
    expect(
      classifyUser({ ...alice, organization: null }, VALID_ORGS, null),
    ).toBe("NO_ORG_ATTRIBUTE");
    expect(classifyUser({ ...alice, organization: "" }, VALID_ORGS, null)).toBe(
      "NO_ORG_ATTRIBUTE",
    );
  });

  it("returns NO_SUB when the user record carries no sub (the table's partition key)", () => {
    expect(classifyUser({ ...alice, sub: undefined }, VALID_ORGS, null)).toBe(
      "NO_SUB",
    );
  });
});

// ---------------------------------------------------------------------------
// parseFlags
// ---------------------------------------------------------------------------

describe("parseFlags", () => {
  it("defaults to dry-run", () => {
    expect(parseFlags([])).toEqual({ apply: false });
  });

  it("accepts --dry-run as an explicit alias for the default", () => {
    expect(parseFlags(["--dry-run"])).toEqual({ apply: false });
  });

  it("--apply flips to write mode", () => {
    expect(parseFlags(["--apply"])).toEqual({ apply: true });
  });

  it("rejects --dry-run combined with --apply", () => {
    expect(() => parseFlags(["--dry-run", "--apply"])).toThrow(
      /--dry-run.*--apply|--apply.*--dry-run/,
    );
  });
});

// ---------------------------------------------------------------------------
// runBackfill — orchestration against mocked clients
// ---------------------------------------------------------------------------

describe("runBackfill", () => {
  let logSpy: jest.SpyInstance;
  let errSpy: jest.SpyInstance;

  beforeEach(() => {
    cognitoMock.reset();
    ddbMock.reset();
    logSpy = jest.spyOn(console, "log").mockImplementation(() => undefined);
    errSpy = jest.spyOn(console, "error").mockImplementation(() => undefined);

    // Org table: two live org rows plus a NAME# tombstone row (has itemType)
    // that must NOT count as a live name.
    ddbMock.on(ScanCommand).resolves({
      Items: [
        { orgId: "org-1", name: "Acme" },
        { orgId: "org-2", name: "Globex" },
        { orgId: "NAME#Initech", name: "Initech", itemType: "name_tombstone" },
      ],
    });
    // Default: no membership rows exist.
    ddbMock.on(GetCommand).resolves({ Item: undefined });
    ddbMock.on(PutCommand).resolves({});
  });

  afterEach(() => {
    logSpy.mockRestore();
    errSpy.mockRestore();
  });

  function clients() {
    const cognito = new CognitoIdentityProviderClient({ region: "us-west-2" });
    const doc = DynamoDBDocumentClient.from(
      new DynamoDBClient({ region: "us-west-2" }),
    );
    return { cognito, doc };
  }

  function run(apply: boolean) {
    const { cognito, doc } = clients();
    return runBackfill({
      cognito,
      doc,
      userPoolId: "pool",
      organisationTable: "orgs",
      membershipTable: "membership",
      apply,
      sleepMs: 0,
    });
  }

  it("never passes a custom: attribute name in ListUsers AttributesToGet (Cognito rejects it; finding c8ccaea5)", async () => {
    cognitoMock.on(ListUsersCommand).resolves({ Users: [] });
    await run(false);
    const call = cognitoMock.commandCalls(ListUsersCommand)[0];
    for (const name of call.args[0].input.AttributesToGet ?? []) {
      expect(name).not.toMatch(/^custom:/);
    }
  });

  it("paginates ListUsers and exits 0 when every user already has a matching row", async () => {
    cognitoMock
      .on(ListUsersCommand)
      .resolvesOnce({
        Users: [
          {
            Username: "alice",
            Attributes: attrs({ sub: "s1", "custom:organization": "Acme" }),
          },
        ],
        PaginationToken: "page2",
      })
      .resolvesOnce({
        Users: [
          {
            Username: "bob",
            Attributes: attrs({
              sub: "s2",
              email: "bob@example.com",
              "custom:organization": "Globex",
            }),
          },
        ],
      });
    ddbMock
      .on(GetCommand, { TableName: "membership", Key: { sub: "s1" } })
      .resolves({ Item: { sub: "s1", orgName: "Acme" } })
      .on(GetCommand, { TableName: "membership", Key: { sub: "s2" } })
      .resolves({ Item: { sub: "s2", orgName: "Globex" } });

    const result = await run(false);

    expect(result.exitCode).toBe(0);
    expect(result.summary.scanned).toBe(2);
    expect(result.summary.alreadyPresent).toBe(2);
    expect(result.summary.plannedWrites).toBe(0);
    expect(cognitoMock.commandCalls(ListUsersCommand)).toHaveLength(2);
    expect(ddbMock.commandCalls(PutCommand)).toHaveLength(0);
  });

  it("dry-run: plans a write for a live-org user with no row, issues NO PutCommand, and exits 3 (work remains)", async () => {
    cognitoMock.on(ListUsersCommand).resolves({
      Users: [
        {
          Username: "alice",
          Attributes: attrs({ sub: "s1", "custom:organization": "Acme" }),
        },
      ],
    });

    const result = await run(false);

    expect(result.exitCode).toBe(3);
    expect(result.summary.mode).toBe("dry-run");
    expect(result.summary.plannedWrites).toBe(1);
    expect(result.summary.written).toBe(0);
    expect(ddbMock.commandCalls(PutCommand)).toHaveLength(0);
  });

  it("apply: PutItem {sub, orgName, updatedAt, updatedBy:'backfill'} for a live-org user with no row, exits 0", async () => {
    cognitoMock.on(ListUsersCommand).resolves({
      Users: [
        {
          Username: "alice",
          Attributes: attrs({ sub: "s1", "custom:organization": "Acme" }),
        },
      ],
    });

    const result = await run(true);

    expect(result.exitCode).toBe(0);
    expect(result.summary.mode).toBe("apply");
    expect(result.summary.written).toBe(1);
    const puts = ddbMock.commandCalls(PutCommand);
    expect(puts).toHaveLength(1);
    const input = puts[0].args[0].input;
    expect(input.TableName).toBe("membership");
    expect(input.Item).toEqual({
      sub: "s1",
      orgName: "Acme",
      updatedAt: expect.stringMatching(/^\d{4}-\d{2}-\d{2}T/),
      updatedBy: "backfill",
    });
  });

  it("apply: writes with a condition so it never clobbers a row written concurrently by assignUserRole", async () => {
    cognitoMock.on(ListUsersCommand).resolves({
      Users: [
        {
          Username: "alice",
          Attributes: attrs({ sub: "s1", "custom:organization": "Acme" }),
        },
      ],
    });

    await run(true);

    const input = ddbMock.commandCalls(PutCommand)[0].args[0].input;
    expect(input.ConditionExpression).toMatch(
      /attribute_not_exists\(\s*#?sub\s*\)/,
    );
  });

  it("apply: a row that appears between GetItem and PutItem (ConditionalCheckFailed) is counted as alreadyPresent, not an error", async () => {
    cognitoMock.on(ListUsersCommand).resolves({
      Users: [
        {
          Username: "alice",
          Attributes: attrs({ sub: "s1", "custom:organization": "Acme" }),
        },
      ],
    });
    const err = new Error("The conditional request failed");
    err.name = "ConditionalCheckFailedException";
    ddbMock.on(PutCommand).rejects(err);

    const result = await run(true);

    expect(result.exitCode).toBe(0);
    expect(result.summary.errors).toBe(0);
    expect(result.summary.written).toBe(0);
    expect(result.summary.alreadyPresent).toBe(1);
  });

  it("reports SKIPPED_UNKNOWN_ORG for an attribute that is not a live org name (tombstones do not count), writes nothing, exits 3", async () => {
    cognitoMock.on(ListUsersCommand).resolves({
      Users: [
        {
          Username: "dave",
          Attributes: attrs({ sub: "s4", "custom:organization": "Initech" }),
        },
      ],
    });

    const result = await run(true);

    expect(result.exitCode).toBe(3);
    expect(result.summary.skippedUnknownOrg).toBe(1);
    expect(result.findings).toEqual([
      expect.objectContaining({
        username: "dave",
        sub: "s4",
        kind: "SKIPPED_UNKNOWN_ORG",
      }),
    ]);
    expect(ddbMock.commandCalls(PutCommand)).toHaveLength(0);
  });

  it("reports SKIPPED_ROW_MISMATCH and does NOT overwrite a row whose orgName differs from the attribute", async () => {
    cognitoMock.on(ListUsersCommand).resolves({
      Users: [
        {
          Username: "alice",
          Attributes: attrs({ sub: "s1", "custom:organization": "Acme" }),
        },
      ],
    });
    ddbMock.on(GetCommand).resolves({ Item: { sub: "s1", orgName: "Globex" } });

    const result = await run(true);

    expect(result.exitCode).toBe(3);
    expect(result.summary.rowMismatch).toBe(1);
    expect(result.findings.map((f) => f.kind)).toEqual([
      "SKIPPED_ROW_MISMATCH",
    ]);
    expect(ddbMock.commandCalls(PutCommand)).toHaveLength(0);
  });

  it("skips users with no custom:organization without a GetItem and without a finding", async () => {
    cognitoMock.on(ListUsersCommand).resolves({
      Users: [{ Username: "ghost", Attributes: attrs({ sub: "s9" }) }],
    });

    const result = await run(true);

    expect(result.exitCode).toBe(0);
    expect(result.summary.noOrgAttribute).toBe(1);
    expect(result.findings).toEqual([]);
    expect(ddbMock.commandCalls(GetCommand)).toHaveLength(0);
    expect(ddbMock.commandCalls(PutCommand)).toHaveLength(0);
  });

  it("reports NO_SUB for a user without a sub attribute and writes nothing", async () => {
    cognitoMock.on(ListUsersCommand).resolves({
      Users: [
        {
          Username: "nosub",
          Attributes: attrs({ "custom:organization": "Acme" }),
        },
      ],
    });

    const result = await run(true);

    expect(result.exitCode).toBe(3);
    expect(result.findings.map((f) => f.kind)).toEqual(["NO_SUB"]);
    expect(ddbMock.commandCalls(PutCommand)).toHaveLength(0);
  });

  it("a failed PutItem is counted as an error, the loop continues, and the run exits 1", async () => {
    cognitoMock.on(ListUsersCommand).resolves({
      Users: [
        {
          Username: "alice",
          Attributes: attrs({ sub: "s1", "custom:organization": "Acme" }),
        },
        {
          Username: "bob",
          Attributes: attrs({ sub: "s2", "custom:organization": "Globex" }),
        },
      ],
    });
    ddbMock.on(PutCommand).callsFake((input: { Item: { sub: string } }) => {
      if (input.Item.sub === "s1") {
        throw new Error("ProvisionedThroughputExceededException");
      }
      return {};
    });

    const result = await run(true);

    expect(result.exitCode).toBe(1);
    expect(result.summary.errors).toBe(1);
    expect(result.summary.written).toBe(1);
    expect(ddbMock.commandCalls(PutCommand)).toHaveLength(2);
  });

  it("never logs or exports email or other attributes — only username and sub", async () => {
    cognitoMock.on(ListUsersCommand).resolves({
      Users: [
        {
          Username: "dave",
          Attributes: attrs({
            sub: "s4",
            email: "dave@example.com",
            "custom:organization": "Initech",
          }),
        },
      ],
    });

    const result = await run(false);

    const everything =
      logSpy.mock.calls.map((c) => c.join(" ")).join("\n") +
      JSON.stringify(result);
    expect(everything).not.toContain("dave@example.com");
    expect(everything).toContain("dave");
  });
});

// ---------------------------------------------------------------------------
// main — env handling
// ---------------------------------------------------------------------------

describe("main", () => {
  const env = { ...process.env };

  beforeEach(() => {
    cognitoMock.reset();
    ddbMock.reset();
    jest.spyOn(console, "log").mockImplementation(() => undefined);
    jest.spyOn(console, "error").mockImplementation(() => undefined);
    process.env.USER_POOL_ID = "pool";
    process.env.ORGANISATION_TABLE = "orgs";
    process.env.USER_ORG_MEMBERSHIP_TABLE = "membership";
    ddbMock.on(ScanCommand).resolves({ Items: [] });
    cognitoMock.on(ListUsersCommand).resolves({ Users: [] });
  });

  afterEach(() => {
    (console.log as jest.Mock).mockRestore?.();
    (console.error as jest.Mock).mockRestore?.();
    process.env = { ...env };
  });

  it("runs a dry-run by default and returns 0 for an empty pool", async () => {
    expect(await main([])).toBe(0);
    expect(cognitoMock.commandCalls(ListUsersCommand)).toHaveLength(1);
    expect(ddbMock.commandCalls(PutCommand)).toHaveLength(0);
  });

  it.each(["USER_POOL_ID", "ORGANISATION_TABLE", "USER_ORG_MEMBERSHIP_TABLE"])(
    "fails fast with a clean error when %s is unset",
    async (name) => {
      delete process.env[name];
      await expect(main([])).rejects.toThrow(`${name} env var required`);
      expect(cognitoMock.commandCalls(ListUsersCommand)).toHaveLength(0);
    },
  );
});
