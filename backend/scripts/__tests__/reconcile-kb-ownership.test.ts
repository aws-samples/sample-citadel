/**
 * Citadel PR-1 — migration script tests: reconcile-kb-ownership.ts.
 *
 * Mirrors resync-datastore-tags.test.ts's stateful-fake-client pattern.
 * Covers the tag-backfill decision function for both the IAM service role
 * and the AOSS collection: untagged -> tagged (apply only), already correct
 * -> already_present, different org/dataStoreId -> conflict (never
 * overwrite), dry-run writes nothing, idempotent on repeat calls.
 */
import {
  reconcileRoleTags,
  reconcileCollectionTags,
  parseArgs,
} from "../reconcile-kb-ownership";

// ---------------------------------------------------------------------------
// Stateful fake IAM client (role tags)
// ---------------------------------------------------------------------------

interface FakeRoleState {
  tags: Array<{ Key: string; Value: string }>;
}

function createFakeIam(initial: Record<string, FakeRoleState>) {
  const state = new Map(Object.entries(initial));
  const send = async (command: {
    constructor: { name: string };
    input?: Record<string, unknown>;
  }): Promise<unknown> => {
    const name = command.constructor.name;
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
      state.set(roleName, { tags: merged });
      return {};
    }
    throw new Error(`Unexpected IAM command: ${name}`);
  };
  return { send, getState: () => state };
}

// ---------------------------------------------------------------------------
// Stateful fake OSS client (collection tags)
// ---------------------------------------------------------------------------

interface FakeCollectionState {
  tags: Array<{ key: string; value: string }>;
}

function createFakeOss(initial: Record<string, FakeCollectionState>) {
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
        ...existing.filter((t) => !newTags.some((nt) => nt.key === t.key)),
        ...newTags,
      ];
      state.set(arn, { tags: merged });
      return {};
    }
    throw new Error(`Unexpected OSS command: ${name}`);
  };
  return { send, getState: () => state };
}

describe("parseArgs", () => {
  it("dry-run is the default (no --apply)", () => {
    const { table, apply } = parseArgs(["--table", "ds-table"]);
    expect(table).toBe("ds-table");
    expect(apply).toBe(false);
  });

  it("--apply sets apply=true", () => {
    const { apply } = parseArgs(["--table", "ds-table", "--apply"]);
    expect(apply).toBe(true);
  });
});

describe("reconcileRoleTags", () => {
  const DS_ID = "ds-001";
  const ORG_ID = "org-acme";
  const ROLE = "citadel-ds-kb-svc-ds-001";

  it("dry-run: reports 'tagged' for an untagged role but writes nothing", async () => {
    const iam = createFakeIam({ [ROLE]: { tags: [] } });
    const result = await reconcileRoleTags(
      iam as never,
      ROLE,
      DS_ID,
      ORG_ID,
      false,
    );
    expect(result.action).toBe("tagged");
    expect(iam.getState().get(ROLE)!.tags).toEqual([]);
  });

  it("apply: tags an untagged role with citadel:orgId + citadel:dataStoreId", async () => {
    const iam = createFakeIam({ [ROLE]: { tags: [] } });
    const result = await reconcileRoleTags(
      iam as never,
      ROLE,
      DS_ID,
      ORG_ID,
      true,
    );
    expect(result.action).toBe("tagged");
    const tags = iam.getState().get(ROLE)!.tags;
    expect(tags).toEqual(
      expect.arrayContaining([
        { Key: "citadel:orgId", Value: ORG_ID },
        { Key: "citadel:dataStoreId", Value: DS_ID },
      ]),
    );
  });

  it("already correctly tagged -> already_present, no write", async () => {
    const iam = createFakeIam({
      [ROLE]: {
        tags: [
          { Key: "citadel:orgId", Value: ORG_ID },
          { Key: "citadel:dataStoreId", Value: DS_ID },
        ],
      },
    });
    const result = await reconcileRoleTags(
      iam as never,
      ROLE,
      DS_ID,
      ORG_ID,
      true,
    );
    expect(result.action).toBe("already_present");
  });

  it("different dataStoreId -> conflict, never overwrites", async () => {
    const original = [
      { Key: "citadel:orgId", Value: ORG_ID },
      { Key: "citadel:dataStoreId", Value: "ds-OTHER" },
    ];
    const iam = createFakeIam({ [ROLE]: { tags: [...original] } });
    const result = await reconcileRoleTags(
      iam as never,
      ROLE,
      DS_ID,
      ORG_ID,
      true,
    );
    expect(result.action).toBe("conflict");
    expect(iam.getState().get(ROLE)!.tags).toEqual(original);
  });

  it("different orgId -> conflict, never overwrites", async () => {
    const original = [
      { Key: "citadel:orgId", Value: "org-DIFFERENT" },
      { Key: "citadel:dataStoreId", Value: DS_ID },
    ];
    const iam = createFakeIam({ [ROLE]: { tags: [...original] } });
    const result = await reconcileRoleTags(
      iam as never,
      ROLE,
      DS_ID,
      ORG_ID,
      true,
    );
    expect(result.action).toBe("conflict");
    expect(iam.getState().get(ROLE)!.tags).toEqual(original);
  });

  it("role not found -> skipped, no error thrown", async () => {
    const iam = createFakeIam({});
    const result = await reconcileRoleTags(
      iam as never,
      "citadel-ds-kb-svc-missing",
      DS_ID,
      ORG_ID,
      true,
    );
    expect(result.action).toBe("skipped");
  });

  it("idempotent: calling twice produces the same final state", async () => {
    const iam = createFakeIam({ [ROLE]: { tags: [] } });
    await reconcileRoleTags(iam as never, ROLE, DS_ID, ORG_ID, true);
    const afterFirst = [...iam.getState().get(ROLE)!.tags];
    await reconcileRoleTags(iam as never, ROLE, DS_ID, ORG_ID, true);
    const afterSecond = iam.getState().get(ROLE)!.tags;
    expect(afterSecond).toEqual(afterFirst);
  });
});

describe("reconcileCollectionTags", () => {
  const DS_ID = "ds-001";
  const ORG_ID = "org-acme";
  const COLL_ARN = "arn:aws:aoss:us-east-1:123456789012:collection/col-1";

  it("dry-run: reports 'tagged' but writes nothing", async () => {
    const oss = createFakeOss({});
    const result = await reconcileCollectionTags(
      oss as never,
      COLL_ARN,
      DS_ID,
      ORG_ID,
      false,
    );
    expect(result.action).toBe("tagged");
    expect(oss.getState().has(COLL_ARN)).toBe(false);
  });

  it("apply: tags an untagged collection", async () => {
    const oss = createFakeOss({ [COLL_ARN]: { tags: [] } });
    const result = await reconcileCollectionTags(
      oss as never,
      COLL_ARN,
      DS_ID,
      ORG_ID,
      true,
    );
    expect(result.action).toBe("tagged");
    const tags = oss.getState().get(COLL_ARN)!.tags;
    expect(tags).toEqual(
      expect.arrayContaining([
        { key: "citadel:orgId", value: ORG_ID },
        { key: "citadel:dataStoreId", value: DS_ID },
      ]),
    );
  });

  it("already correctly tagged -> already_present", async () => {
    const oss = createFakeOss({
      [COLL_ARN]: {
        tags: [
          { key: "citadel:orgId", value: ORG_ID },
          { key: "citadel:dataStoreId", value: DS_ID },
        ],
      },
    });
    const result = await reconcileCollectionTags(
      oss as never,
      COLL_ARN,
      DS_ID,
      ORG_ID,
      true,
    );
    expect(result.action).toBe("already_present");
  });

  it("different orgId -> conflict, never overwrites", async () => {
    const original = [
      { key: "citadel:orgId", value: "org-DIFFERENT" },
      { key: "citadel:dataStoreId", value: DS_ID },
    ];
    const oss = createFakeOss({ [COLL_ARN]: { tags: [...original] } });
    const result = await reconcileCollectionTags(
      oss as never,
      COLL_ARN,
      DS_ID,
      ORG_ID,
      true,
    );
    expect(result.action).toBe("conflict");
    expect(oss.getState().get(COLL_ARN)!.tags).toEqual(original);
  });

  it("idempotent: calling twice produces the same final state", async () => {
    const oss = createFakeOss({ [COLL_ARN]: { tags: [] } });
    await reconcileCollectionTags(oss as never, COLL_ARN, DS_ID, ORG_ID, true);
    const afterFirst = [...oss.getState().get(COLL_ARN)!.tags];
    await reconcileCollectionTags(oss as never, COLL_ARN, DS_ID, ORG_ID, true);
    const afterSecond = oss.getState().get(COLL_ARN)!.tags;
    expect(afterSecond).toEqual(afterFirst);
  });
});
