/**
 * Unit tests for the pure-logic helpers in backfill-shared-org-marker.ts
 * (PR-3, Continuum CRITICAL: blank orgId as cross-tenant wildcard).
 *
 * Only the classifier/decision helpers and summary accumulation are tested
 * here — the AWS-client call sites (Registry update, DDB UpdateCommand) are
 * integration-level and exercised separately in the orchestration test.
 */
import {
  classifyRecord,
  emptySummary,
  addSummary,
  SEED_ALLOWLIST_NAMES,
  SEED_ALLOWLIST_CREATED_BY,
  main,
  type RecordShape,
} from "../backfill-shared-org-marker";

describe("classifyRecord", () => {
  it("classifies a record already stamped ALL_ORGS as already-shared (no-op, idempotent)", () => {
    const rec: RecordShape = {
      id: "r1",
      name: "demo-echo-agent",
      orgId: "All Organizations",
      createdBy: "seedConfig",
    };
    expect(classifyRecord(rec)).toEqual({
      outcome: "already-shared",
      targetOrgId: "All Organizations",
    });
  });

  it("classifies a record already flagged orgUnknown as already-unknown (no-op, idempotent)", () => {
    const rec: RecordShape = {
      id: "r2",
      name: "some-random-agent",
      orgId: undefined,
      orgUnknown: true,
      createdBy: "user-abc",
    };
    expect(classifyRecord(rec)).toEqual({ outcome: "already-unknown" });
  });

  it("classifies a blank-orgId record whose name is in the seed allowlist as shared", () => {
    const rec: RecordShape = {
      id: "r3",
      name: "demo-echo-agent",
      orgId: "",
      createdBy: "someone",
    };
    expect(classifyRecord(rec)).toEqual({
      outcome: "mark-shared",
      targetOrgId: "All Organizations",
      reason: "name-allowlist",
    });
  });

  it("classifies an absent-orgId record whose createdBy is a platform seed principal as shared", () => {
    const rec: RecordShape = {
      id: "r4",
      name: "custom-fabricated-thing",
      orgId: undefined,
      createdBy: "seedConfig",
    };
    expect(classifyRecord(rec)).toEqual({
      outcome: "mark-shared",
      targetOrgId: "All Organizations",
      reason: "createdBy-allowlist",
    });
  });

  it("classifies a blank-orgId record with no createdBy and not in the allowlist as unknown (never auto-assigned)", () => {
    const rec: RecordShape = {
      id: "r5",
      name: "mystery-agent",
      orgId: "",
      createdBy: undefined,
    };
    expect(classifyRecord(rec)).toEqual({ outcome: "mark-unknown" });
  });

  it("classifies a blank-orgId record whose createdBy resolves to exactly one tenant org as ambiguous — reported, never auto-assigned", () => {
    const rec: RecordShape = {
      id: "r6",
      name: "orphan-agent",
      orgId: "",
      createdBy: "user-with-known-org",
    };
    const resolveCreatedByOrg = (createdBy: string) =>
      createdBy === "user-with-known-org" ? "org-x" : undefined;
    expect(classifyRecord(rec, resolveCreatedByOrg)).toEqual({
      outcome: "ambiguous",
      resolvedOrgId: "org-x",
    });
  });

  it("classifies a blank-orgId record whose createdBy does not resolve to any org as unknown", () => {
    const rec: RecordShape = {
      id: "r7",
      name: "orphan-agent-2",
      orgId: "",
      createdBy: "user-with-no-org",
    };
    const resolveCreatedByOrg = () => undefined;
    expect(classifyRecord(rec, resolveCreatedByOrg)).toEqual({
      outcome: "mark-unknown",
    });
  });

  it("never reclassifies a record with a real, non-ALL_ORGS orgId already stamped (not in scope — untouched)", () => {
    const rec: RecordShape = {
      id: "r8",
      name: "tenant-agent",
      orgId: "org-a",
      createdBy: "user-1",
    };
    expect(classifyRecord(rec)).toEqual({ outcome: "already-tenant-owned" });
  });

  it("SEED_ALLOWLIST_NAMES and SEED_ALLOWLIST_CREATED_BY are non-empty and contain the known seed identifiers", () => {
    expect(SEED_ALLOWLIST_NAMES).toContain("demo-echo-agent");
    expect(SEED_ALLOWLIST_NAMES).toContain("fabricator");
    expect(SEED_ALLOWLIST_CREATED_BY).toContain("seedConfig");
  });
});

describe("summary accumulation", () => {
  it("emptySummary starts every counter at zero", () => {
    expect(emptySummary()).toEqual({
      scanned: 0,
      markedShared: 0,
      markedTenant: 0,
      markedUnknown: 0,
      markedFallback: 0,
      alreadyShared: 0,
      alreadyUnknown: 0,
      ambiguousReported: 0,
      errors: 0,
    });
  });

  it("addSummary accumulates every field across two partial summaries", () => {
    const a = {
      scanned: 5,
      markedShared: 1,
      markedTenant: 0,
      markedUnknown: 2,
      markedFallback: 0,
      alreadyShared: 1,
      alreadyUnknown: 0,
      ambiguousReported: 1,
      errors: 0,
    };
    const b = {
      scanned: 3,
      markedShared: 0,
      markedTenant: 0,
      markedUnknown: 1,
      markedFallback: 0,
      alreadyShared: 0,
      alreadyUnknown: 1,
      ambiguousReported: 0,
      errors: 1,
    };
    const dst = emptySummary();
    addSummary(dst, a);
    addSummary(dst, b);
    expect(dst).toEqual({
      scanned: 8,
      markedShared: 1,
      markedTenant: 0,
      markedUnknown: 3,
      markedFallback: 0,
      alreadyShared: 1,
      alreadyUnknown: 1,
      ambiguousReported: 1,
      errors: 1,
    });
  });
});

describe("idempotency property", () => {
  it("classifying an already-shared record twice in a row yields the same no-op outcome both times", () => {
    const rec: RecordShape = {
      id: "r9",
      name: "demo-echo-agent",
      orgId: "All Organizations",
      createdBy: "seedConfig",
    };
    const first = classifyRecord(rec);
    const second = classifyRecord(rec);
    expect(first).toEqual(second);
    expect(first.outcome).toBe("already-shared");
  });

  it("classifying an already-unknown record twice in a row yields the same no-op outcome both times", () => {
    const rec: RecordShape = {
      id: "r10",
      name: "mystery-agent-2",
      orgId: undefined,
      orgUnknown: true,
      createdBy: undefined,
    };
    const first = classifyRecord(rec);
    const second = classifyRecord(rec);
    expect(first).toEqual(second);
    expect(first.outcome).toBe("already-unknown");
  });
});

describe("main() env guards", () => {
  const originalEnv = process.env;

  beforeEach(() => {
    process.env = { ...originalEnv };
  });

  afterAll(() => {
    process.env = originalEnv;
  });

  it("rejects when REGISTRY_ID is unset", async () => {
    delete process.env.REGISTRY_ID;
    process.env.AGENT_CONFIG_TABLE = "t-agents";
    process.env.TOOL_CONFIG_TABLE = "t-tools";
    await expect(main()).rejects.toThrow("REGISTRY_ID env var required");
  });

  it("rejects when AGENT_CONFIG_TABLE is unset", async () => {
    process.env.REGISTRY_ID = "reg-1";
    delete process.env.AGENT_CONFIG_TABLE;
    process.env.TOOL_CONFIG_TABLE = "t-tools";
    await expect(main()).rejects.toThrow("AGENT_CONFIG_TABLE env var required");
  });

  it("rejects when TOOL_CONFIG_TABLE is unset", async () => {
    process.env.REGISTRY_ID = "reg-1";
    process.env.AGENT_CONFIG_TABLE = "t-agents";
    delete process.env.TOOL_CONFIG_TABLE;
    await expect(main()).rejects.toThrow("TOOL_CONFIG_TABLE env var required");
  });
});
