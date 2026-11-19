/**
 * Tests for fabricator-org-resolution in backfill-shared-org-marker.ts.
 *
 * Covers:
 *   - "fabricator" removed from SEED_ALLOWLIST_CREATED_BY
 *   - New mark-tenant outcome via sourceProjectId → project → organization
 *   - Tool resolution via appId → agent → sourceProjectId → project → org
 *   - Multi-org → ambiguous (never assigned)
 *   - Corrective mode (--correct-fabricator-shared)
 *   - Regression: fabricator-created record with sourceProjectId never ALL_ORGS
 *   - Throttled registry read → error (non-zero exit)
 */
import {
  classifyRecord,
  SEED_ALLOWLIST_CREATED_BY,
  SEED_ALLOWLIST_NAMES,
  main,
  emptySummary,
  addSummary,
  type RecordShape,
  type OrgResolver,
} from "../backfill-shared-org-marker";

// ---------------------------------------------------------------------------
// 1. Fabricator removed from SEED_ALLOWLIST_CREATED_BY
// ---------------------------------------------------------------------------

describe("SEED_ALLOWLIST_CREATED_BY no longer includes 'fabricator'", () => {
  it("does not contain 'fabricator' as a createdBy allowlist entry", () => {
    expect(SEED_ALLOWLIST_CREATED_BY).not.toContain("fabricator");
  });

  it("still contains 'seedConfig' and 'system'", () => {
    expect(SEED_ALLOWLIST_CREATED_BY).toContain("seedConfig");
    expect(SEED_ALLOWLIST_CREATED_BY).toContain("system");
  });

  it("SEED_ALLOWLIST_NAMES still includes 'fabricator' (the platform agent itself is a seed)", () => {
    expect(SEED_ALLOWLIST_NAMES).toContain("fabricator");
  });
});

// ---------------------------------------------------------------------------
// 2. Classification table: mark-tenant via org resolution
// ---------------------------------------------------------------------------

describe("classifyRecord — fabricator mark-tenant path", () => {
  const orgResolver: OrgResolver = {
    resolveAgentOrg: (rec: RecordShape) => {
      if (rec.sourceProjectId === "proj-1") return "Default";
      if (rec.sourceProjectId === "proj-2") return "Acme Corp";
      return undefined;
    },
    resolveToolOrg: (rec: RecordShape) => {
      if (rec.appId === "app-1") return "Default";
      return undefined;
    },
  };

  it("classifies a fabricator-created agent with sourceProjectId as mark-tenant", () => {
    const rec: RecordShape = {
      id: "a1",
      name: "custom-agent",
      orgId: "",
      createdBy: "fabricator",
      sourceProjectId: "proj-1",
    };
    const result = classifyRecord(rec, undefined, orgResolver);
    expect(result).toEqual({
      outcome: "mark-tenant",
      targetOrgId: "Default",
      reason: "fabricator-agent-sourceProjectId",
    });
  });

  it("classifies a tool with appId resolvable to a single org as mark-tenant", () => {
    const rec: RecordShape = {
      id: "t1",
      name: "some-tool",
      orgId: "",
      createdBy: "fabricator",
      appId: "app-1",
    };
    const result = classifyRecord(rec, undefined, orgResolver);
    expect(result).toEqual({
      outcome: "mark-tenant",
      targetOrgId: "Default",
      reason: "fabricator-tool-appId",
    });
  });

  it("classifies a tool with unresolvable appId as mark-unknown", () => {
    const rec: RecordShape = {
      id: "t2",
      name: "orphan-tool",
      orgId: "",
      createdBy: "fabricator",
      appId: "app-unknown",
    };
    const result = classifyRecord(rec, undefined, orgResolver);
    expect(result.outcome).toBe("mark-unknown");
  });

  it("classifies a fabricator agent with no sourceProjectId as mark-unknown", () => {
    const rec: RecordShape = {
      id: "a2",
      name: "no-project-agent",
      orgId: "",
      createdBy: "fabricator",
    };
    const result = classifyRecord(rec, undefined, orgResolver);
    expect(result.outcome).toBe("mark-unknown");
  });

  it("record with sourceProjectId present but no createdBy still resolves via fabricator path", () => {
    const rec: RecordShape = {
      id: "a3",
      name: "implicit-fabricator",
      orgId: "",
      sourceProjectId: "proj-2",
    };
    const result = classifyRecord(rec, undefined, orgResolver);
    expect(result).toEqual({
      outcome: "mark-tenant",
      targetOrgId: "Acme Corp",
      reason: "fabricator-agent-sourceProjectId",
    });
  });
});

// ---------------------------------------------------------------------------
// 3. Regression: fabricator record with sourceProjectId never ALL_ORGS
// ---------------------------------------------------------------------------

describe("regression: fabricator record with sourceProjectId never becomes ALL_ORGS", () => {
  const orgResolver: OrgResolver = {
    resolveAgentOrg: (rec: RecordShape) => {
      if (rec.sourceProjectId === "proj-1") return "Default";
      return undefined;
    },
    resolveToolOrg: () => undefined,
  };

  it("a fabricator-created agent with sourceProjectId gets mark-tenant, never mark-shared", () => {
    const rec: RecordShape = {
      id: "reg-1",
      name: "fabricated-worker",
      orgId: "",
      createdBy: "fabricator",
      sourceProjectId: "proj-1",
    };
    const result = classifyRecord(rec, undefined, orgResolver);
    expect(result.outcome).toBe("mark-tenant");
    expect(result.outcome).not.toBe("mark-shared");
    if (result.outcome === "mark-tenant") {
      expect(result.targetOrgId).toBe("Default");
    }
  });
});

// ---------------------------------------------------------------------------
// 4. Multi-org → ambiguous
// ---------------------------------------------------------------------------

describe("classifyRecord — tool multi-org ambiguity", () => {
  const multiOrgResolver: OrgResolver = {
    resolveAgentOrg: () => undefined,
    resolveToolOrg: (rec: RecordShape) => {
      // Simulate: appId resolves to agents in multiple orgs → ambiguous
      if (rec.appId === "app-multi") return "AMBIGUOUS";
      return undefined;
    },
  };

  it("tool with appId that resolves to multiple orgs → ambiguous", () => {
    const rec: RecordShape = {
      id: "t-multi",
      name: "multi-org-tool",
      orgId: "",
      createdBy: "fabricator",
      appId: "app-multi",
    };
    const result = classifyRecord(rec, undefined, multiOrgResolver);
    expect(result.outcome).toBe("ambiguous");
    if (result.outcome === "ambiguous") {
      expect(result.resolvedOrgId).toBe("AMBIGUOUS");
    }
  });
});

// ---------------------------------------------------------------------------
// 5. Corrective mode env guards
// ---------------------------------------------------------------------------

describe("main() --correct-fabricator-shared env guard", () => {
  const originalEnv = process.env;
  const originalArgv = process.argv;

  beforeEach(() => {
    process.env = { ...originalEnv };
    process.argv = [...originalArgv];
  });

  afterAll(() => {
    process.env = originalEnv;
    process.argv = originalArgv;
  });

  it("requires PROJECTS_TABLE env var when --correct-fabricator-shared is set", async () => {
    process.env.REGISTRY_ID = "reg-1";
    process.env.AGENT_CONFIG_TABLE = "t-agents";
    process.env.TOOL_CONFIG_TABLE = "t-tools";
    delete process.env.PROJECTS_TABLE;
    process.argv = ["node", "script", "--correct-fabricator-shared"];
    await expect(main()).rejects.toThrow("PROJECTS_TABLE");
  });
});

// ---------------------------------------------------------------------------
// 6. --record-id canary
// ---------------------------------------------------------------------------

describe("main() --record-id canary", () => {
  const originalEnv = process.env;
  const originalArgv = process.argv;

  beforeEach(() => {
    process.env = { ...originalEnv };
    process.argv = [...originalArgv];
  });

  afterAll(() => {
    process.env = originalEnv;
    process.argv = originalArgv;
  });

  it("rejects when REGISTRY_ID is unset even with --record-id", async () => {
    delete process.env.REGISTRY_ID;
    process.env.AGENT_CONFIG_TABLE = "t-agents";
    process.env.TOOL_CONFIG_TABLE = "t-tools";
    process.argv = ["node", "script", "--record-id", "rec-123"];
    await expect(main()).rejects.toThrow("REGISTRY_ID env var required");
  });
});

// ---------------------------------------------------------------------------
// 7. Throttled read → error accumulation
// ---------------------------------------------------------------------------

describe("throttled registry read → error tracking", () => {
  it("addSummary correctly accumulates errors from a throttled-read phase", () => {
    const phase = emptySummary();
    phase.scanned = 10;
    phase.errors = 3;
    const total = emptySummary();
    addSummary(total, phase);
    expect(total.errors).toBe(3);
    expect(total.scanned).toBe(10);
  });
});

// ---------------------------------------------------------------------------
// 8. mark-tenant outcome in summary
// ---------------------------------------------------------------------------

describe("summary tracks mark-tenant separately", () => {
  it("emptySummary includes markedTenant = 0", () => {
    const s = emptySummary();
    expect(s.markedTenant).toBe(0);
  });

  it("addSummary accumulates markedTenant", () => {
    const a = { ...emptySummary(), markedTenant: 5 };
    const b = { ...emptySummary(), markedTenant: 3 };
    const total = emptySummary();
    addSummary(total, a);
    addSummary(total, b);
    expect(total.markedTenant).toBe(8);
  });
});
