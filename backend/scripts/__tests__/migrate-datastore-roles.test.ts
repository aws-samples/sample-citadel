/**
 * Tests for migrate-datastore-roles.ts — C3 migration script that
 * re-issues citadel-ds-<id> inline policies as connect-only (concrete ARNs)
 * and backfills Citadel ownership tags on DynamoDB tables, RDS instances,
 * and AOSS collections.
 *
 * Mirrors resync-datastore-tags.test.ts's stateful-fake-client pattern.
 * Covers: wildcard policy replaced, already-connect-only no-op, untagged
 * resource tagged, tagged-matching no-op, tagged-conflicting skip+report,
 * canary filter, dry-run writes nothing, idempotent (second run no change).
 */
import {
  runMigration,
  reconcileResourceTags,
  parseArgs,
  type MigrationDeps,
} from "../migrate-datastore-roles";

// ---------------------------------------------------------------------------
// Fake DynamoDB Document Client (scan results)
// ---------------------------------------------------------------------------

function createFakeDdb(rows: Record<string, unknown>[]) {
  let callCount = 0;
  const send = async (command: {
    constructor: { name: string };
    input?: Record<string, unknown>;
  }) => {
    if (command.constructor.name === "ScanCommand") {
      if (callCount++ === 0) {
        return { Items: rows, LastEvaluatedKey: undefined };
      }
      return { Items: [], LastEvaluatedKey: undefined };
    }
    throw new Error(`Unexpected DDB command: ${command.constructor.name}`);
  };
  return { send };
}

// ---------------------------------------------------------------------------
// Fake IAM Client (role policies + tags)
// ---------------------------------------------------------------------------

interface FakeRoleState {
  policyDocument: {
    Statement: Array<{ Action: string[]; Resource: string[] }>;
  };
  tags: Array<{ Key: string; Value: string }>;
}

function createFakeIam(initial: Record<string, FakeRoleState>) {
  const state = new Map(Object.entries(initial));
  const ensureRoleCalls: Array<{
    resourceId: string;
    policies: unknown[];
    scope: string;
  }> = [];

  const send = async (command: {
    constructor: { name: string };
    input?: Record<string, unknown>;
  }): Promise<unknown> => {
    const name = command.constructor.name;

    if (name === "GetRolePolicyCommand") {
      const roleName = command.input!.RoleName as string;
      const entry = state.get(roleName);
      if (!entry) {
        const err = new Error("NoSuchEntity") as Error & { name: string };
        err.name = "NoSuchEntityException";
        throw err;
      }
      return {
        PolicyDocument: encodeURIComponent(
          JSON.stringify(entry.policyDocument),
        ),
      };
    }

    if (name === "GetRoleCommand") {
      const roleName = command.input!.RoleName as string;
      if (!state.has(roleName)) {
        const err = new Error("NoSuchEntity") as Error & { name: string };
        err.name = "NoSuchEntityException";
        throw err;
      }
      return { Role: { RoleName: roleName } };
    }

    if (name === "ListRoleTagsCommand") {
      const roleName = command.input!.RoleName as string;
      const entry = state.get(roleName);
      if (!entry) {
        const err = new Error("NoSuchEntity") as Error & { name: string };
        err.name = "NoSuchEntityException";
        throw err;
      }
      return { Tags: [...entry.tags] };
    }

    if (name === "TagRoleCommand") {
      const roleName = command.input!.RoleName as string;
      const newTags = command.input!.Tags as Array<{
        Key: string;
        Value: string;
      }>;
      const existing = state.get(roleName)?.tags ?? [];
      const merged = [
        ...existing.filter((t) => !newTags.some((nt) => nt.Key === t.Key)),
        ...newTags,
      ];
      state.set(roleName, { ...state.get(roleName)!, tags: merged });
      return {};
    }

    throw new Error(`Unexpected IAM command: ${name}`);
  };

  return { send, getState: () => state, ensureRoleCalls };
}

// ---------------------------------------------------------------------------
// Fake DynamoDB Resource Client (table tags)
// ---------------------------------------------------------------------------

interface FakeTableTagState {
  tags: Array<{ Key: string; Value: string }> | "NoTags";
}

function createFakeDynamoDBResource(
  initial: Record<string, FakeTableTagState>,
) {
  const state = new Map(Object.entries(initial));

  const send = async (command: {
    constructor: { name: string };
    input?: Record<string, unknown>;
  }): Promise<unknown> => {
    const name = command.constructor.name;

    if (name === "ListTagsOfResourceCommand") {
      const arn = command.input!.ResourceArn as string;
      const entry = state.get(arn);
      if (!entry || entry.tags === "NoTags") {
        return { Tags: [] };
      }
      return { Tags: [...entry.tags] };
    }

    if (name === "TagResourceCommand") {
      const arn = command.input!.ResourceArn as string;
      const newTags = command.input!.Tags as Array<{
        Key: string;
        Value: string;
      }>;
      const existing =
        state.get(arn)?.tags === "NoTags" ? [] : (state.get(arn)?.tags ?? []);
      const merged = [
        ...existing.filter(
          (t: { Key: string }) => !newTags.some((nt) => nt.Key === t.Key),
        ),
        ...newTags,
      ];
      state.set(arn, { tags: merged });
      return {};
    }

    throw new Error(`Unexpected DynamoDB resource command: ${name}`);
  };

  return { send, getState: () => state };
}

// ---------------------------------------------------------------------------
// Fake RDS Client (instance tags)
// ---------------------------------------------------------------------------

interface FakeRdsTagState {
  tags: Array<{ Key: string; Value: string }>;
}

function createFakeRds(initial: Record<string, FakeRdsTagState>) {
  const state = new Map(Object.entries(initial));

  const send = async (command: {
    constructor: { name: string };
    input?: Record<string, unknown>;
  }): Promise<unknown> => {
    const name = command.constructor.name;

    if (name === "ListTagsForResourceCommand") {
      const arn = command.input!.ResourceName as string;
      const entry = state.get(arn);
      return { TagList: entry ? [...entry.tags] : [] };
    }

    if (name === "AddTagsToResourceCommand") {
      const arn = command.input!.ResourceName as string;
      const newTags = command.input!.Tags as Array<{
        Key: string;
        Value: string;
      }>;
      const existing = state.get(arn)?.tags ?? [];
      const merged = [
        ...existing.filter(
          (t: { Key: string }) => !newTags.some((nt) => nt.Key === t.Key),
        ),
        ...newTags,
      ];
      state.set(arn, { tags: merged });
      return {};
    }

    throw new Error(`Unexpected RDS command: ${name}`);
  };

  return { send, getState: () => state };
}

// ---------------------------------------------------------------------------
// Fake AOSS Client (collection tags)
// ---------------------------------------------------------------------------

interface FakeOssTagState {
  tags: Array<{ key: string; value: string }>;
}

function createFakeOss(initial: Record<string, FakeOssTagState>) {
  const state = new Map(Object.entries(initial));

  const send = async (command: {
    constructor: { name: string };
    input?: Record<string, unknown>;
  }): Promise<unknown> => {
    const name = command.constructor.name;

    if (name === "ListTagsForResourceCommand") {
      const arn = command.input!.resourceArn as string;
      const entry = state.get(arn);
      return { tags: entry ? [...entry.tags] : [] };
    }

    if (name === "TagResourceCommand") {
      const arn = command.input!.resourceArn as string;
      const newTags = command.input!.tags as Array<{
        key: string;
        value: string;
      }>;
      const existing = state.get(arn)?.tags ?? [];
      const merged = [
        ...existing.filter(
          (t: { key: string }) => !newTags.some((nt) => nt.key === t.key),
        ),
        ...newTags,
      ];
      state.set(arn, { tags: merged });
      return {};
    }

    throw new Error(`Unexpected OSS command: ${name}`);
  };

  return { send, getState: () => state };
}

// ---------------------------------------------------------------------------
// Fake PolicyManager
// ---------------------------------------------------------------------------

function createFakePm() {
  const calls: Array<{
    resourceId: string;
    policies: unknown[];
    accountId: string;
    scope: string;
  }> = [];

  return {
    ensureRole: jest.fn(
      async (
        resourceId: string,
        policies: unknown[],
        accountId: string,
        scope: string,
      ) => {
        calls.push({ resourceId, policies, accountId, scope });
      },
    ),
    getAccountContext: jest.fn(async () => ({
      accountId: "123456789012",
      region: "us-east-1",
    })),
    calls,
  };
}

// ---------------------------------------------------------------------------
// Test constants
// ---------------------------------------------------------------------------

const ACCOUNT = "123456789012";
const REGION = "us-east-1";

function makeDeps(overrides: Partial<MigrationDeps> = {}): MigrationDeps {
  return {
    ddb: createFakeDdb([]) as never,
    iam: createFakeIam({}) as never,
    dynamodbResource: createFakeDynamoDBResource({}) as never,
    rds: createFakeRds({}) as never,
    oss: createFakeOss({}) as never,
    pm: createFakePm() as never,
    accountId: ACCOUNT,
    region: REGION,
    ...overrides,
  };
}

// ---------------------------------------------------------------------------
// parseArgs
// ---------------------------------------------------------------------------

describe("parseArgs", () => {
  it("parses --table and --apply", () => {
    const result = parseArgs(["--table", "my-table", "--apply"]);
    expect(result).toEqual({
      table: "my-table",
      apply: true,
      dataStoreId: undefined,
    });
  });

  it("defaults to dry-run", () => {
    const result = parseArgs(["--table", "my-table"]);
    expect(result.apply).toBe(false);
  });

  it("parses --data-store-id canary filter", () => {
    const result = parseArgs([
      "--table",
      "my-table",
      "--data-store-id",
      "ds-canary",
    ]);
    expect(result.dataStoreId).toBe("ds-canary");
  });
});

// ---------------------------------------------------------------------------
// DYNAMODB: wildcard policy replaced with connect-only
// ---------------------------------------------------------------------------

describe("DYNAMODB migration", () => {
  const DS_ID = "ds-ddb-001";
  const TABLE_NAME = "my-table";
  const TABLE_ARN = `arn:aws:dynamodb:${REGION}:${ACCOUNT}:table/${TABLE_NAME}`;
  const ROLE_NAME = `citadel-ds-${DS_ID}`;

  function ddbRow(overrides: Record<string, unknown> = {}) {
    return {
      dataStoreId: DS_ID,
      type: "DYNAMODB",
      status: "CONNECTED",
      orgId: "org-acme",
      config: JSON.stringify({ tableName: TABLE_NAME, dataStoreId: DS_ID }),
      ...overrides,
    };
  }

  it("replaces wildcard policy with connect-only on --apply", async () => {
    const pm = createFakePm();
    const iam = createFakeIam({
      [ROLE_NAME]: {
        policyDocument: {
          Statement: [
            {
              Action: [
                "dynamodb:CreateTable",
                "dynamodb:DeleteTable",
                "dynamodb:DescribeTable",
              ],
              Resource: ["*"],
            },
          ],
        },
        tags: [
          { Key: "citadel:dataStoreId", Value: DS_ID },
          { Key: "citadel:orgId", Value: "org-acme" },
        ],
      },
    });
    const dynamodbResource = createFakeDynamoDBResource({
      [TABLE_ARN]: {
        tags: [
          { Key: "citadel:dataStoreId", Value: DS_ID },
          { Key: "citadel:orgId", Value: "org-acme" },
        ],
      },
    });
    const ddb = createFakeDdb([ddbRow()]);

    const summary = await runMigration("test-table", true, undefined, {
      ...makeDeps(),
      ddb: ddb as never,
      iam: iam as never,
      dynamodbResource: dynamodbResource as never,
      pm: pm as never,
    });

    expect(summary.policyChanged).toBe(1);
    expect(pm.ensureRole).toHaveBeenCalledWith(
      DS_ID,
      expect.arrayContaining([
        expect.objectContaining({
          actions: expect.arrayContaining(["dynamodb:DescribeTable"]),
          resources: expect.arrayContaining([TABLE_ARN]),
        }),
      ]),
      ACCOUNT,
      "datastore",
    );

    // Verify no Delete*/Create* in the ensured policies
    const ensuredPolicies = pm.ensureRole.mock.calls[0][1] as Array<{
      actions: string[];
    }>;
    for (const p of ensuredPolicies) {
      for (const action of p.actions) {
        expect(action).not.toMatch(/Delete|Create/i);
      }
    }
  });

  it("dry-run does not call ensureRole or tag APIs", async () => {
    const pm = createFakePm();
    const iam = createFakeIam({
      [ROLE_NAME]: {
        policyDocument: {
          Statement: [
            {
              Action: ["dynamodb:DeleteTable"],
              Resource: ["*"],
            },
          ],
        },
        tags: [],
      },
    });
    const dynamodbResource = createFakeDynamoDBResource({
      [TABLE_ARN]: { tags: "NoTags" },
    });
    const ddb = createFakeDdb([ddbRow()]);

    const summary = await runMigration("test-table", false, undefined, {
      ...makeDeps(),
      ddb: ddb as never,
      iam: iam as never,
      dynamodbResource: dynamodbResource as never,
      pm: pm as never,
    });

    expect(summary.policyChanged).toBe(1);
    // pm.ensureRole should NOT be called in dry-run
    expect(pm.ensureRole).not.toHaveBeenCalled();
  });

  it("already-connect-only policy: no-op", async () => {
    const pm = createFakePm();
    const iam = createFakeIam({
      [ROLE_NAME]: {
        policyDocument: {
          Statement: [
            {
              Action: [
                "dynamodb:DescribeTable",
                "dynamodb:GetItem",
                "dynamodb:PutItem",
                "dynamodb:Query",
                "dynamodb:Scan",
              ],
              Resource: [TABLE_ARN, `${TABLE_ARN}/index/*`],
            },
          ],
        },
        tags: [
          { Key: "citadel:dataStoreId", Value: DS_ID },
          { Key: "citadel:orgId", Value: "org-acme" },
        ],
      },
    });
    const dynamodbResource = createFakeDynamoDBResource({
      [TABLE_ARN]: {
        tags: [
          { Key: "citadel:dataStoreId", Value: DS_ID },
          { Key: "citadel:orgId", Value: "org-acme" },
        ],
      },
    });
    const ddb = createFakeDdb([ddbRow()]);

    const summary = await runMigration("test-table", true, undefined, {
      ...makeDeps(),
      ddb: ddb as never,
      iam: iam as never,
      dynamodbResource: dynamodbResource as never,
      pm: pm as never,
    });

    expect(summary.policyAlreadyClean).toBe(1);
    expect(summary.policyChanged).toBe(0);
    expect(pm.ensureRole).not.toHaveBeenCalled();
  });

  it("tags untagged DynamoDB table", async () => {
    const pm = createFakePm();
    const iam = createFakeIam({
      [ROLE_NAME]: {
        policyDocument: {
          Statement: [
            {
              Action: ["dynamodb:DescribeTable", "dynamodb:GetItem"],
              Resource: [TABLE_ARN],
            },
          ],
        },
        tags: [],
      },
    });
    const dynamodbResource = createFakeDynamoDBResource({
      [TABLE_ARN]: { tags: "NoTags" },
    });
    const ddb = createFakeDdb([ddbRow()]);

    const summary = await runMigration("test-table", true, undefined, {
      ...makeDeps(),
      ddb: ddb as never,
      iam: iam as never,
      dynamodbResource: dynamodbResource as never,
      pm: pm as never,
    });

    expect(summary.resourceTagged).toBeGreaterThanOrEqual(1);
    // Check tags were applied
    const tags = dynamodbResource.getState().get(TABLE_ARN)!.tags;
    expect(tags).not.toBe("NoTags");
    expect(tags).toEqual(
      expect.arrayContaining([
        expect.objectContaining({ Key: "citadel:dataStoreId", Value: DS_ID }),
        expect.objectContaining({ Key: "citadel:orgId", Value: "org-acme" }),
      ]),
    );
  });

  it("reports conflict on mismatched resource tag", async () => {
    const pm = createFakePm();
    const iam = createFakeIam({
      [ROLE_NAME]: {
        policyDocument: {
          Statement: [
            {
              Action: ["dynamodb:DescribeTable"],
              Resource: [TABLE_ARN],
            },
          ],
        },
        tags: [],
      },
    });
    const dynamodbResource = createFakeDynamoDBResource({
      [TABLE_ARN]: {
        tags: [{ Key: "citadel:dataStoreId", Value: "ds-OTHER" }],
      },
    });
    const ddb = createFakeDdb([ddbRow()]);

    const summary = await runMigration("test-table", true, undefined, {
      ...makeDeps(),
      ddb: ddb as never,
      iam: iam as never,
      dynamodbResource: dynamodbResource as never,
      pm: pm as never,
    });

    expect(summary.tagConflict).toBe(1);
    // Tags not overwritten
    const tags = dynamodbResource.getState().get(TABLE_ARN)!
      .tags as FakeTableTagState["tags"];
    expect(tags).toEqual(
      expect.not.arrayContaining([
        expect.objectContaining({ Key: "citadel:dataStoreId", Value: DS_ID }),
      ]),
    );
  });
});

// ---------------------------------------------------------------------------
// RDS: wildcard policy replaced
// ---------------------------------------------------------------------------

describe("RDS migration", () => {
  const DS_ID = "ds-rds-001";
  const DB_ID = "citadel-postgres-12345";
  const DB_ARN = `arn:aws:rds:${REGION}:${ACCOUNT}:db:${DB_ID}`;
  const ROLE_NAME = `citadel-ds-${DS_ID}`;

  function rdsRow(overrides: Record<string, unknown> = {}) {
    return {
      dataStoreId: DS_ID,
      type: "RDS_POSTGRESQL",
      status: "CONNECTED",
      orgId: "org-acme",
      config: JSON.stringify({
        dbInstanceIdentifier: DB_ID,
        dataStoreId: DS_ID,
      }),
      ...overrides,
    };
  }

  it("replaces wildcard policy with connect-only", async () => {
    const pm = createFakePm();
    const iam = createFakeIam({
      [ROLE_NAME]: {
        policyDocument: {
          Statement: [
            {
              Action: [
                "rds:CreateDBInstance",
                "rds:DeleteDBInstance",
                "rds:DescribeDBInstances",
              ],
              Resource: ["*"],
            },
          ],
        },
        tags: [
          { Key: "citadel:dataStoreId", Value: DS_ID },
          { Key: "citadel:orgId", Value: "org-acme" },
        ],
      },
    });
    const rds = createFakeRds({
      [DB_ARN]: {
        tags: [
          { Key: "citadel:dataStoreId", Value: DS_ID },
          { Key: "citadel:orgId", Value: "org-acme" },
        ],
      },
    });
    const ddb = createFakeDdb([rdsRow()]);

    const summary = await runMigration("test-table", true, undefined, {
      ...makeDeps(),
      ddb: ddb as never,
      iam: iam as never,
      rds: rds as never,
      pm: pm as never,
    });

    expect(summary.policyChanged).toBe(1);
    expect(pm.ensureRole).toHaveBeenCalledWith(
      DS_ID,
      expect.arrayContaining([
        expect.objectContaining({
          actions: expect.arrayContaining(["rds:DescribeDBInstances"]),
          resources: expect.arrayContaining([DB_ARN]),
        }),
      ]),
      ACCOUNT,
      "datastore",
    );

    // No Delete*/Create* in ensured policies
    const ensuredPolicies = pm.ensureRole.mock.calls[0][1] as Array<{
      actions: string[];
    }>;
    for (const p of ensuredPolicies) {
      for (const action of p.actions) {
        expect(action).not.toMatch(/Delete|Create/i);
      }
    }
  });
});

// ---------------------------------------------------------------------------
// KNOWLEDGE_BASE: connect-only policy (no wildcard)
// ---------------------------------------------------------------------------

describe("KNOWLEDGE_BASE migration", () => {
  const DS_ID = "ds-kb-001";
  const KB_ID = "KBTEST123";
  const COLL_ID = "colltest456";
  const COLL_ARN = `arn:aws:aoss:${REGION}:${ACCOUNT}:collection/${COLL_ID}`;
  const ROLE_NAME = `citadel-ds-${DS_ID}`;

  function kbRow(overrides: Record<string, unknown> = {}) {
    return {
      dataStoreId: DS_ID,
      type: "KNOWLEDGE_BASE",
      status: "CONNECTED",
      orgId: "org-acme",
      config: JSON.stringify({
        knowledgeBaseId: KB_ID,
        collectionId: COLL_ID,
        dataStoreId: DS_ID,
      }),
      ...overrides,
    };
  }

  it("replaces wildcard policy with connect-only", async () => {
    const pm = createFakePm();
    const iam = createFakeIam({
      [ROLE_NAME]: {
        policyDocument: {
          Statement: [
            {
              Action: ["bedrock:CreateKnowledgeBase", "aoss:APIAccessAll"],
              Resource: ["*"],
            },
          ],
        },
        tags: [
          { Key: "citadel:dataStoreId", Value: DS_ID },
          { Key: "citadel:orgId", Value: "org-acme" },
        ],
      },
    });
    const oss = createFakeOss({
      [COLL_ARN]: {
        tags: [
          { key: "citadel:dataStoreId", value: DS_ID },
          { key: "citadel:orgId", value: "org-acme" },
        ],
      },
    });
    const ddb = createFakeDdb([kbRow()]);

    const summary = await runMigration("test-table", true, undefined, {
      ...makeDeps(),
      ddb: ddb as never,
      iam: iam as never,
      oss: oss as never,
      pm: pm as never,
    });

    expect(summary.policyChanged).toBe(1);
    // Verify connect-only policies: bedrock:GetKnowledgeBase, bedrock:Retrieve, aoss:APIAccessAll on concrete ARN
    const ensuredPolicies = pm.ensureRole.mock.calls[0][1] as Array<{
      actions: string[];
      resources: string[];
    }>;
    for (const p of ensuredPolicies) {
      for (const action of p.actions) {
        expect(action).not.toMatch(/CreateKnowledgeBase/);
      }
      for (const r of p.resources) {
        expect(r).not.toBe("*");
      }
    }
  });

  it("skips KB row with no knowledgeBaseId/collectionId", async () => {
    const pm = createFakePm();
    const ddb = createFakeDdb([
      kbRow({ config: JSON.stringify({ dataStoreId: DS_ID }) }),
    ]);

    const summary = await runMigration("test-table", true, undefined, {
      ...makeDeps(),
      ddb: ddb as never,
      pm: pm as never,
    });

    expect(summary.skipped).toBe(1);
    expect(pm.ensureRole).not.toHaveBeenCalled();
  });
});

// ---------------------------------------------------------------------------
// Canary filter: --data-store-id
// ---------------------------------------------------------------------------

describe("canary filter", () => {
  it("processes only the specified data store", async () => {
    const pm = createFakePm();
    const row1 = {
      dataStoreId: "ds-target",
      type: "DYNAMODB",
      status: "CONNECTED",
      orgId: "org-acme",
      config: JSON.stringify({ tableName: "tbl-1", dataStoreId: "ds-target" }),
    };
    const row2 = {
      dataStoreId: "ds-other",
      type: "DYNAMODB",
      status: "CONNECTED",
      orgId: "org-acme",
      config: JSON.stringify({ tableName: "tbl-2", dataStoreId: "ds-other" }),
    };
    const ddb = createFakeDdb([row1, row2]);
    const iam = createFakeIam({
      "citadel-ds-ds-target": {
        policyDocument: {
          Statement: [{ Action: ["dynamodb:DeleteTable"], Resource: ["*"] }],
        },
        tags: [
          { Key: "citadel:dataStoreId", Value: "ds-target" },
          { Key: "citadel:orgId", Value: "org-acme" },
        ],
      },
      "citadel-ds-ds-other": {
        policyDocument: {
          Statement: [{ Action: ["dynamodb:DeleteTable"], Resource: ["*"] }],
        },
        tags: [
          { Key: "citadel:dataStoreId", Value: "ds-other" },
          { Key: "citadel:orgId", Value: "org-acme" },
        ],
      },
    });
    const tableArn1 = `arn:aws:dynamodb:${REGION}:${ACCOUNT}:table/tbl-1`;
    const dynamodbResource = createFakeDynamoDBResource({
      [tableArn1]: {
        tags: [
          { Key: "citadel:dataStoreId", Value: "ds-target" },
          { Key: "citadel:orgId", Value: "org-acme" },
        ],
      },
    });

    const summary = await runMigration("test-table", true, "ds-target", {
      ...makeDeps(),
      ddb: ddb as never,
      iam: iam as never,
      dynamodbResource: dynamodbResource as never,
      pm: pm as never,
    });

    // Only 1 processed, 1 filtered
    expect(summary.total).toBe(1);
    expect(summary.filtered).toBe(1);
  });
});

// ---------------------------------------------------------------------------
// Idempotency: second run finds nothing to change
// ---------------------------------------------------------------------------

describe("idempotency", () => {
  it("second run on already-migrated DynamoDB row reports no changes", async () => {
    const DS_ID = "ds-idem";
    const TABLE_NAME = "idem-table";
    const TABLE_ARN = `arn:aws:dynamodb:${REGION}:${ACCOUNT}:table/${TABLE_NAME}`;
    const ROLE_NAME = `citadel-ds-${DS_ID}`;

    const row = {
      dataStoreId: DS_ID,
      type: "DYNAMODB",
      status: "CONNECTED",
      orgId: "org-acme",
      config: JSON.stringify({ tableName: TABLE_NAME, dataStoreId: DS_ID }),
    };

    // State: already has connect-only policy and correct tags everywhere
    const pm = createFakePm();
    const iam = createFakeIam({
      [ROLE_NAME]: {
        policyDocument: {
          Statement: [
            {
              Action: [
                "dynamodb:DescribeTable",
                "dynamodb:GetItem",
                "dynamodb:PutItem",
                "dynamodb:Query",
                "dynamodb:Scan",
              ],
              Resource: [TABLE_ARN, `${TABLE_ARN}/index/*`],
            },
          ],
        },
        tags: [
          { Key: "citadel:dataStoreId", Value: DS_ID },
          { Key: "citadel:orgId", Value: "org-acme" },
        ],
      },
    });
    const dynamodbResource = createFakeDynamoDBResource({
      [TABLE_ARN]: {
        tags: [
          { Key: "citadel:dataStoreId", Value: DS_ID },
          { Key: "citadel:orgId", Value: "org-acme" },
        ],
      },
    });
    const ddb = createFakeDdb([row]);

    const summary = await runMigration("test-table", true, undefined, {
      ...makeDeps(),
      ddb: ddb as never,
      iam: iam as never,
      dynamodbResource: dynamodbResource as never,
      pm: pm as never,
    });

    expect(summary.policyChanged).toBe(0);
    expect(summary.policyAlreadyClean).toBe(1);
    expect(summary.resourceTagged).toBe(0);
    expect(summary.tagAlreadyPresent).toBeGreaterThanOrEqual(1);
    expect(pm.ensureRole).not.toHaveBeenCalled();
  });
});

// ---------------------------------------------------------------------------
// reconcileResourceTags (unit)
// ---------------------------------------------------------------------------

describe("reconcileResourceTags", () => {
  it("tags untagged DynamoDB table (apply)", async () => {
    const tableArn = `arn:aws:dynamodb:us-east-1:${ACCOUNT}:table/test`;
    const dynamodbResource = createFakeDynamoDBResource({
      [tableArn]: { tags: "NoTags" },
    });

    const result = await reconcileResourceTags(
      "DYNAMODB",
      tableArn,
      "ds-001",
      "org-acme",
      true,
      { dynamodbResource: dynamodbResource as never } as never,
    );

    expect(result.action).toBe("tagged");
    const tags = dynamodbResource.getState().get(tableArn)!.tags;
    expect(tags).toEqual(
      expect.arrayContaining([
        expect.objectContaining({
          Key: "citadel:dataStoreId",
          Value: "ds-001",
        }),
      ]),
    );
  });

  it("returns conflict on mismatched orgId for RDS", async () => {
    const dbArn = `arn:aws:rds:us-east-1:${ACCOUNT}:db:mydb`;
    const rds = createFakeRds({
      [dbArn]: { tags: [{ Key: "citadel:orgId", Value: "org-WRONG" }] },
    });

    const result = await reconcileResourceTags(
      "RDS",
      dbArn,
      "ds-001",
      "org-acme",
      true,
      { rds: rds as never } as never,
    );

    expect(result.action).toBe("conflict");
    expect(result.reason).toContain("org-WRONG");
  });

  it("returns already_present for correctly tagged AOSS collection", async () => {
    const collArn = `arn:aws:aoss:us-east-1:${ACCOUNT}:collection/abc`;
    const oss = createFakeOss({
      [collArn]: {
        tags: [
          { key: "citadel:dataStoreId", value: "ds-001" },
          { key: "citadel:orgId", value: "org-acme" },
        ],
      },
    });

    const result = await reconcileResourceTags(
      "AOSS",
      collArn,
      "ds-001",
      "org-acme",
      true,
      { oss: oss as never } as never,
    );

    expect(result.action).toBe("already_present");
  });
});

// ---------------------------------------------------------------------------
// Non-CONNECTED status: skipped
// ---------------------------------------------------------------------------

describe("non-CONNECTED rows", () => {
  it("skips PROVISIONING rows", async () => {
    const row = {
      dataStoreId: "ds-prov",
      type: "DYNAMODB",
      status: "PROVISIONING",
      orgId: "org-acme",
      config: JSON.stringify({
        tableName: "t",
        dataStoreId: "ds-prov",
      }),
    };
    const ddb = createFakeDdb([row]);
    const pm = createFakePm();

    const summary = await runMigration("test-table", true, undefined, {
      ...makeDeps(),
      ddb: ddb as never,
      pm: pm as never,
    });

    // The scan filter should exclude non-CONNECTED, so total=0
    expect(summary.total).toBe(0);
  });
});
