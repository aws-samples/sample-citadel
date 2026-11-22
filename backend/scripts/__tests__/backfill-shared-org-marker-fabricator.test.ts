/**
 * Tests for fabricator-org-resolution in backfill-shared-org-marker.ts.
 *
 * Covers:
 *   - "fabricator" removed from SEED_ALLOWLIST_CREATED_BY
 *   - New mark-tenant outcome via sourceProjectId → project → organization
 *   - Tool resolution via a NAME-based toolName -> org index (option A;
 *     see "Tool resolution — NAME-based binding" below) replacing the old
 *     appId-based binding
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
  isCorrectiveTarget,
  planCorrectiveEntry,
  buildOrgResolverFromMaps,
  buildOrgResolverFromTablesWithKnownOrgs,
  buildToolNameOrgIndex,
  applyCorrectiveEntry,
  runCorrectiveForRegistryType,
  findDdbOnlyCorrectiveTargets,
  reconcileDroppedRecords,
  runCorrectiveMode,
  resyncProjectionForId,
  resyncProjectionIds,
  waitForProjectionConvergence,
  applyDdbOnlyCorrectiveEntry,
  type RecordShape,
  type OrgResolver,
  type AgentConfigLike,
  type Clock,
} from "../backfill-shared-org-marker";
import type { RegistryService } from "../../src/services/registry-service";
import { ALL_ORGS } from "../../src/utils/org-constants";

/**
 * Synthetic injectable clock for the bounded projection-convergence wait —
 * `now()` returns a counter that advances by `pollIntervalMs` on every
 * `sleep()` call, and `sleep()` resolves immediately (no real timers), so
 * tests never wait out a real wall-clock window.
 */
function fastClock(): Clock {
  let current = 0;
  return {
    now: () => current,
    sleep: async (ms: number) => {
      current += ms;
    },
  };
}

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
      if (rec.name === "sync_widget_catalog") return "Default";
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

  it("classifies a tool whose name resolves to a single org (via the name index) as mark-tenant", () => {
    const rec: RecordShape = {
      id: "t1",
      name: "sync_widget_catalog",
      orgId: "",
      createdBy: "fabricator",
    };
    const result = classifyRecord(rec, undefined, orgResolver);
    expect(result).toEqual({
      outcome: "mark-tenant",
      targetOrgId: "Default",
      reason: "fabricator-tool-name",
    });
  });

  it("classifies a tool whose name does not resolve as mark-unknown", () => {
    const rec: RecordShape = {
      id: "t2",
      name: "orphan_tool",
      orgId: "",
      createdBy: "fabricator",
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
      // Simulate: tool name resolves to agents in multiple orgs → ambiguous
      if (rec.name === "multi_org_tool") return "AMBIGUOUS";
      return undefined;
    },
  };

  it("tool whose name resolves to multiple orgs → ambiguous", () => {
    const rec: RecordShape = {
      id: "t-multi",
      name: "multi_org_tool",
      orgId: "",
      createdBy: "fabricator",
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

// ---------------------------------------------------------------------------
// 9. isCorrectiveTarget — selection predicate
// ---------------------------------------------------------------------------

describe("isCorrectiveTarget", () => {
  it("selects a record that is ALL_ORGS, createdBy fabricator, and not a seed name", () => {
    const rec: RecordShape = {
      id: "a1",
      name: "custom-agent",
      orgId: ALL_ORGS,
      createdBy: "fabricator",
    };
    expect(isCorrectiveTarget(rec)).toBe(true);
  });

  it("excludes a record that is not ALL_ORGS", () => {
    const rec: RecordShape = {
      id: "a2",
      name: "custom-agent",
      orgId: "Default",
      createdBy: "fabricator",
    };
    expect(isCorrectiveTarget(rec)).toBe(false);
  });

  it("excludes a record whose createdBy is not fabricator", () => {
    const rec: RecordShape = {
      id: "a3",
      name: "custom-agent",
      orgId: ALL_ORGS,
      createdBy: "seedConfig",
    };
    expect(isCorrectiveTarget(rec)).toBe(false);
  });

  it("excludes a record whose name is in the seed NAME allowlist (the fabricator agent itself)", () => {
    const rec: RecordShape = {
      id: "a4",
      name: "fabricator",
      orgId: ALL_ORGS,
      createdBy: "fabricator",
    };
    expect(isCorrectiveTarget(rec)).toBe(false);
  });

  it("selects a record with no name at all (name undefined is not a seed name)", () => {
    const rec: RecordShape = {
      id: "a5",
      orgId: ALL_ORGS,
      createdBy: "fabricator",
    };
    expect(isCorrectiveTarget(rec)).toBe(true);
  });
});

// ---------------------------------------------------------------------------
// 10. planCorrectiveEntry — pure planning function
// ---------------------------------------------------------------------------

describe("planCorrectiveEntry", () => {
  const orgResolver: OrgResolver = {
    resolveAgentOrg: (rec: RecordShape) =>
      rec.sourceProjectId === "proj-1" ? "Default" : undefined,
    resolveToolOrg: (rec: RecordShape) => {
      if (rec.name === "sync_widget_catalog") return "Default";
      if (rec.name === "multi_org_tool") return "AMBIGUOUS";
      return undefined;
    },
  };

  it("returns undefined for a record outside corrective scope", () => {
    const rec: RecordShape = {
      id: "a1",
      orgId: "Default",
      createdBy: "fabricator",
    };
    expect(planCorrectiveEntry(rec, "agent", orgResolver)).toBeUndefined();
  });

  it("plans a resolvable agent with previousOrgId = ALL_ORGS and the resolved org", () => {
    const rec: RecordShape = {
      id: "a1",
      name: "fabricated-agent",
      orgId: ALL_ORGS,
      createdBy: "fabricator",
      sourceProjectId: "proj-1",
    };
    const entry = planCorrectiveEntry(rec, "agent", orgResolver);
    expect(entry).toEqual({
      id: "a1",
      name: "fabricated-agent",
      kind: "agent",
      previousOrgId: ALL_ORGS,
      resolvedOrgId: "Default",
      reason: "fabricator-agent-sourceProjectId",
    });
  });

  it("plans a resolvable tool via its name with reason fabricator-tool-name", () => {
    const rec: RecordShape = {
      id: "t1",
      name: "sync_widget_catalog",
      orgId: ALL_ORGS,
      createdBy: "fabricator",
    };
    const entry = planCorrectiveEntry(rec, "tool", orgResolver);
    expect(entry).toEqual({
      id: "t1",
      name: "sync_widget_catalog",
      kind: "tool",
      previousOrgId: ALL_ORGS,
      resolvedOrgId: "Default",
      reason: "fabricator-tool-name",
    });
  });

  it("plans an unresolvable record with resolvedOrgId undefined and reason unresolvable-orgUnknown", () => {
    const rec: RecordShape = {
      id: "t2",
      name: "orphan_tool",
      orgId: ALL_ORGS,
      createdBy: "fabricator",
    };
    const entry = planCorrectiveEntry(rec, "tool", orgResolver);
    expect(entry).toEqual({
      id: "t2",
      name: "orphan_tool",
      kind: "tool",
      previousOrgId: ALL_ORGS,
      resolvedOrgId: undefined,
      reason: "unresolvable-orgUnknown",
    });
  });

  it("plans a multi-org tool with resolvedOrgId undefined and reason ambiguous-multi-org", () => {
    const rec: RecordShape = {
      id: "t3",
      name: "multi_org_tool",
      orgId: ALL_ORGS,
      createdBy: "fabricator",
    };
    const entry = planCorrectiveEntry(rec, "tool", orgResolver);
    expect(entry).toEqual({
      id: "t3",
      name: "multi_org_tool",
      kind: "tool",
      previousOrgId: ALL_ORGS,
      resolvedOrgId: undefined,
      reason: "ambiguous-multi-org",
    });
  });
});

// ---------------------------------------------------------------------------
// 11. buildToolNameOrgIndex + buildOrgResolverFromMaps — NAME-based binding
// ---------------------------------------------------------------------------
//
// Option A: the tool->agent binding is built ONCE per run as an index
// toolName -> set(resolved org), parsed from each agent's config JSON
// string (config.schema.tools[]) plus non-empty manifest.tools[]. A
// fabricated agent resolves via sourceProjectId -> projects table -> org;
// an agent with an explicit tenant orgId contributes that org; ALL_ORGS/
// seed/orgUnknown agents contribute nothing. A tool name with exactly one
// distinct contributing org stamps that org; several -> ambiguous
// (reported only); none -> orgUnknown. Seed-name tools are never targeted.

describe("buildToolNameOrgIndex", () => {
  const resolveAgentOrg = (rec: RecordShape): string | undefined => {
    if (rec.orgId !== undefined && rec.orgId !== "" && rec.orgId !== ALL_ORGS)
      return rec.orgId;
    if (rec.sourceProjectId === "proj-1") return "Default";
    if (rec.sourceProjectId === "proj-2") return "Acme Corp";
    return undefined;
  };

  it("indexes a tool name from config.schema.tools[] on a fabricated agent resolved via sourceProjectId", () => {
    const agents: AgentConfigLike[] = [
      {
        name: "custom-agent",
        createdBy: "fabricator",
        sourceProjectId: "proj-1",
        config: JSON.stringify({ schema: { tools: ["sync_widget_catalog"] } }),
      },
    ];
    const index = buildToolNameOrgIndex(agents, resolveAgentOrg);
    expect(index.get("sync_widget_catalog")).toEqual(new Set(["Default"]));
  });

  it("indexes a tool name from a non-empty manifest.tools[] in addition to config.schema.tools[]", () => {
    const agents: AgentConfigLike[] = [
      {
        name: "custom-agent",
        createdBy: "fabricator",
        sourceProjectId: "proj-1",
        config: JSON.stringify({ schema: { tools: [] } }),
        manifest: { tools: ["send_email_reminder"] },
      },
    ];
    const index = buildToolNameOrgIndex(agents, resolveAgentOrg);
    expect(index.get("send_email_reminder")).toEqual(new Set(["Default"]));
  });

  it("ignores an empty manifest.tools[] (does not contribute an empty-array marker)", () => {
    const agents: AgentConfigLike[] = [
      {
        name: "custom-agent",
        createdBy: "fabricator",
        sourceProjectId: "proj-1",
        config: JSON.stringify({ schema: { tools: ["only_tool"] } }),
        manifest: { tools: [] },
      },
    ];
    const index = buildToolNameOrgIndex(agents, resolveAgentOrg);
    expect(index.size).toBe(1);
    expect(index.has("only_tool")).toBe(true);
  });

  it("an agent with an explicit tenant orgId contributes that org directly (no sourceProjectId needed)", () => {
    const agents: AgentConfigLike[] = [
      {
        name: "tenant-agent",
        orgId: "Acme Corp",
        config: JSON.stringify({ schema: { tools: ["acme_only_tool"] } }),
      },
    ];
    const index = buildToolNameOrgIndex(agents, resolveAgentOrg);
    expect(index.get("acme_only_tool")).toEqual(new Set(["Acme Corp"]));
  });

  it("an ALL_ORGS agent contributes nothing", () => {
    const agents: AgentConfigLike[] = [
      {
        name: "shared-agent",
        orgId: ALL_ORGS,
        config: JSON.stringify({ schema: { tools: ["shared-ish-tool"] } }),
      },
    ];
    const index = buildToolNameOrgIndex(agents, resolveAgentOrg);
    expect(index.has("shared-ish-tool")).toBe(false);
  });

  it("a seed-name agent contributes nothing", () => {
    const agents: AgentConfigLike[] = [
      {
        name: "fabricator",
        createdBy: "fabricator",
        sourceProjectId: "proj-1",
        config: JSON.stringify({ schema: { tools: ["seed_owned_tool"] } }),
      },
    ];
    const index = buildToolNameOrgIndex(agents, resolveAgentOrg);
    expect(index.has("seed_owned_tool")).toBe(false);
  });

  it("an orgUnknown agent contributes nothing", () => {
    const agents: AgentConfigLike[] = [
      {
        name: "legacy-agent",
        orgUnknown: true,
        config: JSON.stringify({ schema: { tools: ["legacy-tool"] } }),
      },
    ];
    const index = buildToolNameOrgIndex(agents, resolveAgentOrg);
    expect(index.has("legacy-tool")).toBe(false);
  });

  it("a tool name referenced by agents in two distinct orgs accumulates both orgs in its set (ambiguous upstream)", () => {
    const agents: AgentConfigLike[] = [
      {
        name: "agent-a",
        createdBy: "fabricator",
        sourceProjectId: "proj-1",
        config: JSON.stringify({ schema: { tools: ["shared_tool_name"] } }),
      },
      {
        name: "agent-b",
        createdBy: "fabricator",
        sourceProjectId: "proj-2",
        config: JSON.stringify({ schema: { tools: ["shared_tool_name"] } }),
      },
    ];
    const index = buildToolNameOrgIndex(agents, resolveAgentOrg);
    expect(index.get("shared_tool_name")).toEqual(
      new Set(["Default", "Acme Corp"]),
    );
  });

  it("an agent with an unparsable config JSON string contributes nothing without throwing", () => {
    const agents: AgentConfigLike[] = [
      {
        name: "broken-agent",
        createdBy: "fabricator",
        sourceProjectId: "proj-1",
        config: "{not valid json",
      },
    ];
    expect(() => buildToolNameOrgIndex(agents, resolveAgentOrg)).not.toThrow();
    const index = buildToolNameOrgIndex(agents, resolveAgentOrg);
    expect(index.size).toBe(0);
  });

  it("an agent with missing config and no manifest.tools contributes nothing", () => {
    const agents: AgentConfigLike[] = [
      {
        name: "bare-agent",
        createdBy: "fabricator",
        sourceProjectId: "proj-1",
      },
    ];
    const index = buildToolNameOrgIndex(agents, resolveAgentOrg);
    expect(index.size).toBe(0);
  });
});

describe("buildOrgResolverFromMaps — NAME-based resolveToolOrg", () => {
  it("resolveAgentOrg returns the mapped org for a known sourceProjectId", () => {
    const resolver = buildOrgResolverFromMaps(
      new Map([["proj-1", "Default"]]),
      new Map(),
    );
    expect(
      resolver.resolveAgentOrg({ id: "a1", sourceProjectId: "proj-1" }),
    ).toBe("Default");
  });

  it("resolveAgentOrg returns undefined when sourceProjectId is absent", () => {
    const resolver = buildOrgResolverFromMaps(new Map(), new Map());
    expect(resolver.resolveAgentOrg({ id: "a1" })).toBeUndefined();
  });

  it("resolveAgentOrg returns undefined when the projectId is not in the map", () => {
    const resolver = buildOrgResolverFromMaps(
      new Map([["proj-1", "Default"]]),
      new Map(),
    );
    expect(
      resolver.resolveAgentOrg({ id: "a1", sourceProjectId: "proj-missing" }),
    ).toBeUndefined();
  });

  it("resolveToolOrg returns the single org when the tool name maps to exactly one org", () => {
    const resolver = buildOrgResolverFromMaps(
      new Map([["proj-1", "Default"]]),
      new Map([["sync_widget_catalog", new Set(["Default"])]]),
    );
    expect(
      resolver.resolveToolOrg({ id: "t1", name: "sync_widget_catalog" }),
    ).toBe("Default");
  });

  it("resolveToolOrg returns AMBIGUOUS when the tool name maps to multiple distinct orgs", () => {
    const resolver = buildOrgResolverFromMaps(
      new Map(),
      new Map([["shared_tool_name", new Set(["Default", "Acme Corp"])]]),
    );
    expect(
      resolver.resolveToolOrg({ id: "t1", name: "shared_tool_name" }),
    ).toBe("AMBIGUOUS");
  });

  it("resolveToolOrg returns undefined when the tool name has no entry in the index (orgUnknown)", () => {
    const resolver = buildOrgResolverFromMaps(new Map(), new Map());
    expect(
      resolver.resolveToolOrg({ id: "t1", name: "unindexed_tool" }),
    ).toBeUndefined();
  });

  it("resolveToolOrg returns undefined when the tool record has no name", () => {
    const resolver = buildOrgResolverFromMaps(new Map(), new Map());
    expect(resolver.resolveToolOrg({ id: "t1" })).toBeUndefined();
  });

  it("resolveToolOrg returns undefined for a seed-name tool even if (hypothetically) present in the index", () => {
    const resolver = buildOrgResolverFromMaps(
      new Map(),
      new Map([["fabricator", new Set(["Default"])]]),
    );
    expect(resolver.resolveToolOrg({ id: "t1", name: "fabricator" })).toBe(
      undefined,
    );
  });
});

// ---------------------------------------------------------------------------
// 12. applyCorrectiveEntry — both-store write with ConditionExpression
// ---------------------------------------------------------------------------

jest.mock("../../src/utils/marker-registry-edit", () => ({
  applyMarkerEdit: jest.fn(),
}));

describe("applyCorrectiveEntry — registry-only write, then wait for projection convergence", () => {
  const { applyMarkerEdit } = jest.requireMock(
    "../../src/utils/marker-registry-edit",
  ) as { applyMarkerEdit: jest.Mock };

  beforeEach(() => {
    applyMarkerEdit.mockReset();
  });

  function fakeRegistry(): RegistryService {
    return {} as unknown as RegistryService;
  }

  function fakeDocClient(sendImpl: jest.Mock) {
    return {
      send: sendImpl,
    } as unknown as import("@aws-sdk/lib-dynamodb").DynamoDBDocumentClient;
  }

  it("writes the resolved org to the registry ONLY (no direct DDB write) and succeeds once the projection converges", async () => {
    applyMarkerEdit.mockResolvedValue({
      recordId: "a1",
      priorStatus: "APPROVED",
    });
    const send = jest.fn().mockResolvedValue({
      Item: { agentId: "a1", orgId: "Default", registryStatus: "APPROVED" },
    });
    const entry = {
      id: "a1",
      name: "fabricated-agent",
      kind: "agent" as const,
      previousOrgId: ALL_ORGS,
      resolvedOrgId: "Default",
      reason: "fabricator-agent-sourceProjectId",
    };

    const result = await applyCorrectiveEntry(
      entry,
      "agent",
      fakeRegistry(),
      "agent-table",
      fakeDocClient(send),
      0,
      undefined,
      60000,
      1000,
      fastClock(),
    );

    expect(result.error).toBeUndefined();
    expect(result.projectionLag).toBeFalsy();
    expect(applyMarkerEdit).toHaveBeenCalledWith(
      expect.objectContaining({
        recordId: "a1",
        type: "agent",
        fieldsToSet: { orgId: "Default" },
      }),
      expect.objectContaining({ dryRun: false }),
    );
    // Every send() call must be a read (GetCommand) — never an UpdateCommand
    // — the registry-backed corrective path writes ONLY the registry.
    for (const [command] of send.mock.calls) {
      expect(command.input.TableName).toBe("agent-table");
      expect(command.input.Key).toEqual({ agentId: "a1" });
      expect(command.input.UpdateExpression).toBeUndefined();
    }
  });

  it("marks orgUnknown=true as the expected convergence state for an unresolvable entry, never writing DDB directly", async () => {
    applyMarkerEdit.mockResolvedValue({
      recordId: "t2",
      priorStatus: "APPROVED",
    });
    const send = jest.fn().mockResolvedValue({
      Item: { toolId: "t2", orgUnknown: true, registryStatus: "APPROVED" },
    });
    const entry = {
      id: "t2",
      name: "orphan-tool",
      kind: "tool" as const,
      previousOrgId: ALL_ORGS,
      resolvedOrgId: undefined,
      reason: "unresolvable-orgUnknown",
    };

    const result = await applyCorrectiveEntry(
      entry,
      "tool",
      fakeRegistry(),
      "tool-table",
      fakeDocClient(send),
      0,
      undefined,
      60000,
      1000,
      fastClock(),
    );

    expect(result.error).toBeUndefined();
    expect(result.projectionLag).toBeFalsy();
    expect(applyMarkerEdit).toHaveBeenCalledWith(
      expect.objectContaining({
        recordId: "t2",
        type: "tool",
        fieldsToSet: { orgUnknown: true },
        fieldsToRemove: ["orgId"],
      }),
      expect.anything(),
    );
    for (const [command] of send.mock.calls) {
      expect(command.input.UpdateExpression).toBeUndefined();
    }
  });

  it("never calls applyMarkerEdit or docClient.send for an ambiguous entry", async () => {
    const send = jest.fn();
    const entry = {
      id: "t3",
      name: "multi-org-tool",
      kind: "tool" as const,
      previousOrgId: ALL_ORGS,
      resolvedOrgId: undefined,
      reason: "ambiguous-multi-org",
    };

    const result = await applyCorrectiveEntry(
      entry,
      "tool",
      fakeRegistry(),
      "tool-table",
      fakeDocClient(send),
    );

    expect(result.error).toBeUndefined();
    expect(applyMarkerEdit).not.toHaveBeenCalled();
    expect(send).not.toHaveBeenCalled();
  });

  it("propagates a registry marker-edit failure as an error and never polls DDB", async () => {
    applyMarkerEdit.mockResolvedValue({
      recordId: "a1",
      error: "updateResource failed: ConditionalCheckFailed",
    });
    const send = jest.fn();
    const entry = {
      id: "a1",
      name: "fabricated-agent",
      kind: "agent" as const,
      previousOrgId: ALL_ORGS,
      resolvedOrgId: "Default",
      reason: "fabricator-agent-sourceProjectId",
    };

    const result = await applyCorrectiveEntry(
      entry,
      "agent",
      fakeRegistry(),
      "agent-table",
      fakeDocClient(send),
    );

    expect(result.error).toBe("updateResource failed: ConditionalCheckFailed");
    expect(send).not.toHaveBeenCalled();
  });

  it("buckets projectionLag=true (never errors) when the projection never converges within the wait window", async () => {
    applyMarkerEdit.mockResolvedValue({
      recordId: "a1",
      priorStatus: "APPROVED",
    });
    // Row never converges — always reports the stale pre-edit value.
    const send = jest.fn().mockResolvedValue({
      Item: { agentId: "a1", orgId: ALL_ORGS, registryStatus: "APPROVED" },
    });
    const entry = {
      id: "a1",
      name: "fabricated-agent",
      kind: "agent" as const,
      previousOrgId: ALL_ORGS,
      resolvedOrgId: "Default",
      reason: "fabricator-agent-sourceProjectId",
    };

    const result = await applyCorrectiveEntry(
      entry,
      "agent",
      fakeRegistry(),
      "agent-table",
      fakeDocClient(send),
      0,
      undefined,
      5000,
      1000,
      fastClock(),
    );

    expect(result.error).toBeUndefined();
    expect(result.projectionLag).toBe(true);
  });
});

// ---------------------------------------------------------------------------
// 12b. waitForProjectionConvergence — bounded poll semantics
// ---------------------------------------------------------------------------

describe("waitForProjectionConvergence", () => {
  function fakeDocClient(sendImpl: jest.Mock) {
    return {
      send: sendImpl,
    } as unknown as import("@aws-sdk/lib-dynamodb").DynamoDBDocumentClient;
  }

  it("returns true as soon as the row matches orgId + registryStatus", async () => {
    const send = jest.fn().mockResolvedValue({
      Item: { agentId: "a1", orgId: "Default", registryStatus: "APPROVED" },
    });
    const converged = await waitForProjectionConvergence(
      fakeDocClient(send),
      "agent-table",
      "agentId",
      "a1",
      { expectedOrgId: "Default", expectedRegistryStatus: "APPROVED" },
      60000,
      1000,
      fastClock(),
    );
    expect(converged).toBe(true);
  });

  it("returns true for the orgUnknown expectation when orgId is absent and orgUnknown is true", async () => {
    const send = jest.fn().mockResolvedValue({
      Item: { toolId: "t1", orgUnknown: true, registryStatus: "APPROVED" },
    });
    const converged = await waitForProjectionConvergence(
      fakeDocClient(send),
      "tool-table",
      "toolId",
      "t1",
      { expectedOrgUnknown: true, expectedRegistryStatus: "APPROVED" },
      60000,
      1000,
      fastClock(),
    );
    expect(converged).toBe(true);
  });

  it("returns false once the deadline elapses without convergence", async () => {
    const send = jest.fn().mockResolvedValue({
      Item: { agentId: "a1", orgId: ALL_ORGS, registryStatus: "APPROVED" },
    });
    const converged = await waitForProjectionConvergence(
      fakeDocClient(send),
      "agent-table",
      "agentId",
      "a1",
      { expectedOrgId: "Default", expectedRegistryStatus: "APPROVED" },
      5000,
      1000,
      fastClock(),
    );
    expect(converged).toBe(false);
  });

  it("treats a transient read failure as not-yet-converged and keeps polling until the deadline", async () => {
    const send = jest
      .fn()
      .mockRejectedValue(new Error("ProvisionedThroughputExceededException"));
    const converged = await waitForProjectionConvergence(
      fakeDocClient(send),
      "agent-table",
      "agentId",
      "a1",
      { expectedOrgId: "Default", expectedRegistryStatus: "APPROVED" },
      3000,
      1000,
      fastClock(),
    );
    expect(converged).toBe(false);
    expect(send.mock.calls.length).toBeGreaterThan(1);
  });
});

// ---------------------------------------------------------------------------
// 13. runCorrectiveForRegistryType — recordId write-scoping (the canary bug)
// ---------------------------------------------------------------------------

describe("runCorrectiveForRegistryType — --record-id scopes WRITES, not just the printed plan", () => {
  const { applyMarkerEdit } = jest.requireMock(
    "../../src/utils/marker-registry-edit",
  ) as { applyMarkerEdit: jest.Mock };

  beforeEach(() => {
    applyMarkerEdit.mockReset();
    applyMarkerEdit.mockResolvedValue({ recordId: "unused" });
  });

  const orgResolver: OrgResolver = {
    resolveAgentOrg: (rec: RecordShape) =>
      rec.sourceProjectId === "proj-1" ? "Default" : undefined,
    resolveToolOrg: () => undefined,
  };

  function makeListedRegistry(
    items: Array<{
      recordId: string;
      name: string;
      orgId: string;
      createdBy: string;
      sourceProjectId?: string;
    }>,
  ): RegistryService {
    const listResourcesChecked = jest.fn().mockResolvedValue({
      items: items.map((i) => ({
        recordId: i.recordId,
        name: i.name,
        status: "APPROVED",
        customDescriptorContent: JSON.stringify({
          orgId: i.orgId,
          createdBy: i.createdBy,
          sourceProjectId: i.sourceProjectId,
        }),
      })),
      partial: false,
      droppedCount: 0,
      throttled: false,
    });
    return { listResourcesChecked } as unknown as RegistryService;
  }

  it("plans BOTH matching records but writes ONLY the one matching --record-id", async () => {
    const registry = makeListedRegistry([
      {
        recordId: "rec-1",
        name: "fab-agent-1",
        orgId: ALL_ORGS,
        createdBy: "fabricator",
        sourceProjectId: "proj-1",
      },
      {
        recordId: "rec-2",
        name: "fab-agent-2",
        orgId: ALL_ORGS,
        createdBy: "fabricator",
        sourceProjectId: "proj-1",
      },
    ]);
    const send = jest.fn().mockResolvedValue({
      Item: { agentId: "rec-1", orgId: "Default", registryStatus: undefined },
    });
    const docClient = {
      send,
    } as unknown as import("@aws-sdk/lib-dynamodb").DynamoDBDocumentClient;
    const summary = emptySummary();

    const plan = await runCorrectiveForRegistryType(
      "agent",
      registry,
      orgResolver,
      /* apply */ true,
      /* limit */ undefined,
      summary,
      "agent-table",
      docClient,
      /* recordId canary */ "rec-1",
      1000,
      undefined,
      undefined,
      0,
      undefined,
      [],
      [],
      60000,
      1000,
      fastClock(),
    );

    // Both records are planned (printed) ...
    expect(plan.map((e) => e.id).sort()).toEqual(["rec-1", "rec-2"]);
    // ... but only rec-1 was actually written (registry-only — no direct
    // DDB write; `send` calls below are the convergence poll reads).
    expect(applyMarkerEdit).toHaveBeenCalledTimes(1);
    expect(applyMarkerEdit).toHaveBeenCalledWith(
      expect.objectContaining({ recordId: "rec-1" }),
      expect.anything(),
    );
    expect(send).toHaveBeenCalled();
    expect(send.mock.calls[0][0].input.Key).toEqual({ agentId: "rec-1" });
    expect(send.mock.calls[0][0].input.UpdateExpression).toBeUndefined();
    expect(summary.markedTenant).toBe(1);
  });

  it("writes nothing when --record-id does not match any planned entry", async () => {
    const registry = makeListedRegistry([
      {
        recordId: "rec-1",
        name: "fab-agent-1",
        orgId: ALL_ORGS,
        createdBy: "fabricator",
        sourceProjectId: "proj-1",
      },
    ]);
    const send = jest.fn();
    const docClient = {
      send,
    } as unknown as import("@aws-sdk/lib-dynamodb").DynamoDBDocumentClient;
    const summary = emptySummary();

    const plan = await runCorrectiveForRegistryType(
      "agent",
      registry,
      orgResolver,
      true,
      undefined,
      summary,
      "agent-table",
      docClient,
      "rec-does-not-exist",
    );

    expect(plan).toHaveLength(1);
    expect(applyMarkerEdit).not.toHaveBeenCalled();
    expect(send).not.toHaveBeenCalled();
    expect(summary.markedTenant).toBe(0);
  });

  it("with no --record-id, writes every planned entry (unscoped default)", async () => {
    const registry = makeListedRegistry([
      {
        recordId: "rec-1",
        name: "fab-agent-1",
        orgId: ALL_ORGS,
        createdBy: "fabricator",
        sourceProjectId: "proj-1",
      },
      {
        recordId: "rec-2",
        name: "fab-agent-2",
        orgId: ALL_ORGS,
        createdBy: "fabricator",
        sourceProjectId: "proj-1",
      },
    ]);
    const send = jest.fn().mockResolvedValue({
      Item: { agentId: "rec-1", orgId: "Default", registryStatus: undefined },
    });
    const docClient = {
      send,
    } as unknown as import("@aws-sdk/lib-dynamodb").DynamoDBDocumentClient;
    const summary = emptySummary();

    await runCorrectiveForRegistryType(
      "agent",
      registry,
      orgResolver,
      true,
      undefined,
      summary,
      "agent-table",
      docClient,
      undefined,
      1000,
      undefined,
      undefined,
      0,
      undefined,
      [],
      [],
      60000,
      1000,
      fastClock(),
    );

    expect(applyMarkerEdit).toHaveBeenCalledTimes(2);
    expect(send).toHaveBeenCalled();
    // No direct DDB write — every send() call is a convergence poll read.
    for (const [command] of send.mock.calls) {
      expect(command.input.UpdateExpression).toBeUndefined();
    }
  });
});

// ---------------------------------------------------------------------------
// 14. runCorrectiveForRegistryType — throttled list -> error, never a write
// ---------------------------------------------------------------------------

describe("runCorrectiveForRegistryType — throttled/partial list refuses to act", () => {
  const orgResolver: OrgResolver = {
    resolveAgentOrg: () => "Default",
    resolveToolOrg: () => undefined,
  };

  it("sets an error and plans nothing when a dropped record never resolves via targeted re-fetch", async () => {
    const listResourcesChecked = jest.fn().mockResolvedValue({
      items: [],
      partial: true,
      droppedCount: 1,
      throttled: true,
      droppedRecordIds: ["rec-missing"],
    });
    const getResource = jest
      .fn()
      .mockRejectedValue(new Error("ThrottlingException"));
    const registry = {
      listResourcesChecked,
      getResource,
    } as unknown as RegistryService;
    const send = jest.fn();
    const docClient = {
      send,
    } as unknown as import("@aws-sdk/lib-dynamodb").DynamoDBDocumentClient;
    const summary = emptySummary();

    const plan = await runCorrectiveForRegistryType(
      "tool",
      registry,
      orgResolver,
      false,
      undefined,
      summary,
      "tool-table",
      docClient,
      undefined,
      1, // tiny delay to keep the test fast
      5, // maxAttempts
    );

    expect(plan).toEqual([]);
    expect(summary.errors).toBe(1);
    expect(send).not.toHaveBeenCalled();
    // The list itself is called exactly once — the retry targets only the
    // dropped record via getResource, never re-listing the whole type.
    expect(listResourcesChecked).toHaveBeenCalledTimes(1);
    expect(getResource).toHaveBeenCalledTimes(5);
    expect(getResource).toHaveBeenCalledWith("tool", "rec-missing");
  });

  it("recovers and proceeds once a targeted re-fetch of the dropped record succeeds", async () => {
    const listResourcesChecked = jest.fn().mockResolvedValue({
      items: [],
      partial: true,
      droppedCount: 1,
      throttled: true,
      droppedRecordIds: ["rec-1"],
    });
    const getResource = jest
      .fn()
      .mockResolvedValueOnce(null)
      .mockResolvedValueOnce({
        recordId: "rec-1",
        name: "fab-tool-1",
        status: "APPROVED",
        customDescriptorContent: JSON.stringify({
          orgId: ALL_ORGS,
          createdBy: "fabricator",
        }),
      });
    // First attempt throws (still throttled), second attempt succeeds.
    getResource.mockReset();
    getResource
      .mockRejectedValueOnce(new Error("ThrottlingException"))
      .mockResolvedValueOnce({
        recordId: "rec-1",
        name: "fab-tool-1",
        status: "APPROVED",
        customDescriptorContent: JSON.stringify({
          orgId: ALL_ORGS,
          createdBy: "fabricator",
        }),
      });
    const registry = {
      listResourcesChecked,
      getResource,
    } as unknown as RegistryService;
    const docClient = {
      send: jest.fn(),
    } as unknown as import("@aws-sdk/lib-dynamodb").DynamoDBDocumentClient;
    const summary = emptySummary();

    const plan = await runCorrectiveForRegistryType(
      "tool",
      registry,
      { resolveAgentOrg: () => undefined, resolveToolOrg: () => "Default" },
      false,
      undefined,
      summary,
      "tool-table",
      docClient,
      undefined,
      1,
      5,
    );

    expect(summary.errors).toBe(0);
    expect(plan).toHaveLength(1);
    expect(plan[0].id).toBe("rec-1");
    expect(listResourcesChecked).toHaveBeenCalledTimes(1);
    expect(getResource).toHaveBeenCalledTimes(2);
  });
});

// ---------------------------------------------------------------------------
// 15. reconcileDroppedRecords — targeted per-record retry, concurrency 1
// ---------------------------------------------------------------------------

describe("reconcileDroppedRecords", () => {
  it("returns the initial result unchanged when nothing was dropped", async () => {
    const getResource = jest.fn();
    const registry = { getResource } as unknown as RegistryService;
    const initial = {
      items: [{ recordId: "r1", name: "a", status: "APPROVED" }],
      partial: false,
      droppedCount: 0,
      throttled: false,
    };

    const result = await reconcileDroppedRecords(registry, "agent", initial);

    expect(result).toBe(initial);
    expect(getResource).not.toHaveBeenCalled();
  });

  it("retries only the dropped recordIds, one at a time, with injected backoff", async () => {
    const callOrder: string[] = [];
    const getResource = jest.fn(async (_type: string, id: string) => {
      callOrder.push(id);
      if (id === "r-slow") {
        // Fails on first attempt, succeeds on second.
        if (callOrder.filter((c) => c === "r-slow").length === 1) {
          throw new Error("ThrottlingException");
        }
      }
      return { recordId: id, name: id, status: "APPROVED" };
    });
    const registry = { getResource } as unknown as RegistryService;
    const initial = {
      items: [{ recordId: "r-ok", name: "ok", status: "APPROVED" }],
      partial: true,
      droppedCount: 2,
      throttled: true,
      droppedRecordIds: ["r-fast", "r-slow"],
    };
    const delayFn = jest.fn().mockReturnValue(1);

    const result = await reconcileDroppedRecords(
      registry,
      "agent",
      initial,
      5,
      1000,
      delayFn,
    );

    expect(result.partial).toBe(false);
    expect(result.items.map((i) => i.recordId).sort()).toEqual([
      "r-fast",
      "r-ok",
      "r-slow",
    ]);
    expect(delayFn).toHaveBeenCalledWith(1, 1000);
  });

  it("gives up on a record still unfetched after maxAttempts and reports it as dropped", async () => {
    const getResource = jest
      .fn()
      .mockRejectedValue(new Error("ThrottlingException"));
    const registry = { getResource } as unknown as RegistryService;
    const initial = {
      items: [],
      partial: true,
      droppedCount: 1,
      throttled: true,
      droppedRecordIds: ["r-dead"],
    };

    const result = await reconcileDroppedRecords(
      registry,
      "tool",
      initial,
      5,
      1,
    );

    expect(result.partial).toBe(true);
    expect(result.droppedRecordIds).toEqual(["r-dead"]);
    expect(getResource).toHaveBeenCalledTimes(5);
  });

  it("drops a record that resolves to null (genuine 404) without retrying it further", async () => {
    const getResource = jest.fn().mockResolvedValue(null);
    const registry = { getResource } as unknown as RegistryService;
    const initial = {
      items: [],
      partial: true,
      droppedCount: 1,
      throttled: false,
      droppedRecordIds: ["r-gone"],
    };

    const result = await reconcileDroppedRecords(
      registry,
      "tool",
      initial,
      5,
      1,
    );

    expect(getResource).toHaveBeenCalledTimes(1);
    expect(result.partial).toBe(false);
    expect(result.items).toEqual([]);
  });

  it("treats a TypeMismatchError as filtered (other resource type), not an unresolved throttle", async () => {
    class TypeMismatchError extends Error {
      constructor(message: string) {
        super(message);
        this.name = "TypeMismatchError";
      }
    }
    const getResource = jest
      .fn()
      .mockRejectedValue(
        new TypeMismatchError(
          "Record r-agent exists but is not a tool (has manifest)",
        ),
      );
    const registry = { getResource } as unknown as RegistryService;
    const initial = {
      items: [],
      partial: true,
      droppedCount: 1,
      throttled: true,
      droppedRecordIds: ["r-agent"],
    };

    const result = await reconcileDroppedRecords(
      registry,
      "tool",
      initial,
      5,
      1,
    );

    // Only attempted once — a type mismatch is not retried.
    expect(getResource).toHaveBeenCalledTimes(1);
    expect(result.partial).toBe(false);
    expect(result.throttled).toBe(false);
    expect(result.droppedRecordIds).toBeUndefined();
    expect(result.items).toEqual([]);
  });
});

// ---------------------------------------------------------------------------
// 16. Convergence — a second dry run after a (mocked) apply plans zero changes
// ---------------------------------------------------------------------------

describe("convergence: after corrective apply, a second dry run plans zero changes", () => {
  const { applyMarkerEdit } = jest.requireMock(
    "../../src/utils/marker-registry-edit",
  ) as { applyMarkerEdit: jest.Mock };

  beforeEach(() => {
    applyMarkerEdit.mockReset();
    applyMarkerEdit.mockResolvedValue({ recordId: "unused" });
  });

  it("a record re-stamped to its resolved org no longer matches isCorrectiveTarget on the next pass", async () => {
    const orgResolver: OrgResolver = {
      resolveAgentOrg: (rec: RecordShape) =>
        rec.sourceProjectId === "proj-1" ? "Default" : undefined,
      resolveToolOrg: () => undefined,
    };

    // First pass: record is ALL_ORGS + fabricator -> in scope, plans + applies.
    const store = {
      recordId: "rec-1",
      name: "fab-agent-1",
      orgId: ALL_ORGS,
      createdBy: "fabricator",
      sourceProjectId: "proj-1",
    };

    function registryFor(current: typeof store): RegistryService {
      const listResourcesChecked = jest.fn().mockResolvedValue({
        items: [
          {
            recordId: current.recordId,
            name: current.name,
            status: "APPROVED",
            customDescriptorContent: JSON.stringify({
              orgId: current.orgId,
              createdBy: current.createdBy,
              sourceProjectId: current.sourceProjectId,
            }),
          },
        ],
        partial: false,
        droppedCount: 0,
        throttled: false,
      });
      return { listResourcesChecked } as unknown as RegistryService;
    }

    const send = jest.fn().mockResolvedValue({
      Item: {
        agentId: "a-converge-1",
        orgId: "Default",
        registryStatus: undefined,
      },
    });
    const docClient = {
      send,
    } as unknown as import("@aws-sdk/lib-dynamodb").DynamoDBDocumentClient;
    const summary1 = emptySummary();

    const firstPlan = await runCorrectiveForRegistryType(
      "agent",
      registryFor(store),
      orgResolver,
      true,
      undefined,
      summary1,
      "agent-table",
      docClient,
      undefined,
      1,
      5,
      undefined,
      0,
      undefined,
      [],
      [],
      60000,
      1000,
      fastClock(),
    );
    expect(firstPlan).toHaveLength(1);
    expect(summary1.markedTenant).toBe(1);

    // Simulate the write having applied: the record's orgId is now "Default".
    const converged = { ...store, orgId: "Default" };
    const summary2 = emptySummary();

    const secondPlan = await runCorrectiveForRegistryType(
      "agent",
      registryFor(converged),
      orgResolver,
      false,
      undefined,
      summary2,
      "agent-table",
      docClient,
      undefined,
    );

    expect(secondPlan).toHaveLength(0);
    expect(summary2.markedTenant).toBe(0);
  });
});

// ---------------------------------------------------------------------------
// 17. R1 — default (non-corrective) pass wires the OrgResolver too
// ---------------------------------------------------------------------------
//
// Regression for verify finding (loop iteration 3): a blank-orgId
// fabricator agent discovered by the DEFAULT scan (not corrective mode)
// must resolve to its tenant org via sourceProjectId, never fall through
// to orgUnknown, because classifyRecord was being called with no
// orgResolver on this path.

describe("R1: default pass resolves fabricator org instead of orgUnknown", () => {
  const { applyMarkerEdit } = jest.requireMock(
    "../../src/utils/marker-registry-edit",
  ) as { applyMarkerEdit: jest.Mock };

  beforeEach(() => {
    applyMarkerEdit.mockReset();
    applyMarkerEdit.mockResolvedValue({ recordId: "unused" });
  });

  const orgResolver: OrgResolver = {
    resolveAgentOrg: (rec: RecordShape) =>
      rec.sourceProjectId === "proj-1" ? "Default" : undefined,
    resolveToolOrg: () => undefined,
  };

  function makeRegistry(items: RecordShape[]): RegistryService {
    const listResources = jest.fn().mockResolvedValue(
      items.map((i) => ({
        recordId: i.id,
        name: i.name,
        status: "APPROVED",
        customDescriptorContent: JSON.stringify({
          orgId: i.orgId,
          createdBy: i.createdBy,
          sourceProjectId: i.sourceProjectId,
        }),
      })),
    );
    return { listResources } as unknown as RegistryService;
  }

  it("processRegistry marks a blank fabricator agent with sourceProjectId as mark-tenant, not mark-unknown, when given an orgResolver", async () => {
    const { processRegistry } = jest.requireActual(
      "../backfill-shared-org-marker",
    ) as typeof import("../backfill-shared-org-marker");

    const registry = makeRegistry([
      {
        id: "a-blank-1",
        name: "fabricated-worker",
        orgId: "",
        createdBy: "fabricator",
        sourceProjectId: "proj-1",
      },
    ]);

    const summary = await processRegistry(
      "agent",
      registry,
      /* apply */ true,
      orgResolver,
    );

    expect(summary.markedTenant).toBe(1);
    expect(summary.markedUnknown).toBe(0);
    expect(applyMarkerEdit).toHaveBeenCalledWith(
      expect.objectContaining({
        recordId: "a-blank-1",
        fieldsToSet: { orgId: "Default" },
      }),
      expect.anything(),
    );
  });

  it("processRegistry falls back to mark-unknown when no orgResolver is supplied (back-compat)", async () => {
    const { processRegistry } = jest.requireActual(
      "../backfill-shared-org-marker",
    ) as typeof import("../backfill-shared-org-marker");

    const registry = makeRegistry([
      {
        id: "a-blank-2",
        name: "fabricated-worker-2",
        orgId: "",
        createdBy: "fabricator",
        sourceProjectId: "proj-1",
      },
    ]);

    const summary = await processRegistry("agent", registry, true);

    expect(summary.markedUnknown).toBe(1);
    expect(summary.markedTenant).toBe(0);
  });

  it("processDdbTable marks a blank fabricator agent with sourceProjectId as mark-tenant when given an orgResolver", async () => {
    const { processDdbTable } = jest.requireActual(
      "../backfill-shared-org-marker",
    ) as typeof import("../backfill-shared-org-marker");

    const send = jest.fn().mockResolvedValue({
      Items: [
        {
          agentId: "ddb-a-1",
          name: "fabricated-ddb-worker",
          orgId: "",
          createdBy: "fabricator",
          sourceProjectId: "proj-1",
        },
      ],
    });
    const docClient = {
      send,
    } as unknown as import("@aws-sdk/lib-dynamodb").DynamoDBDocumentClient;

    const summary = await processDdbTable(
      "agent",
      "agent-table",
      docClient,
      true,
      orgResolver,
    );

    expect(summary.markedTenant).toBe(1);
    expect(summary.markedUnknown).toBe(0);
    // Second send call is the UpdateCommand for the mark-tenant write.
    const updateCall = send.mock.calls.find((c) =>
      c[0]?.input?.UpdateExpression?.includes("orgId"),
    );
    expect(updateCall).toBeDefined();
    expect(updateCall[0].input.ExpressionAttributeValues[":orgId"]).toBe(
      "Default",
    );
  });
});

// ---------------------------------------------------------------------------
// 18. R2 — corrective mode must catch DDB-only ALL_ORGS drift rows too
// ---------------------------------------------------------------------------
//
// Regression for verify finding (loop iteration 3): two records diverged
// because the registry write was throttled during the original --apply —
// the DDB projection row still holds ALL_ORGS+fabricator+non-seed-name,
// but the matching registry record's orgId is no longer ALL_ORGS (it was
// never written, or was already corrected). Corrective mode filtered on
// the registry listing ONLY, so these DDB-only drift rows were never
// planned and stayed ALL_ORGS forever. The fix must select DDB rows
// independently of what the registry currently holds.

describe("R2: corrective mode catches DDB-only ALL_ORGS drift (registry/DDB disagree)", () => {
  const { applyMarkerEdit } = jest.requireMock(
    "../../src/utils/marker-registry-edit",
  ) as { applyMarkerEdit: jest.Mock };

  beforeEach(() => {
    applyMarkerEdit.mockReset();
    applyMarkerEdit.mockResolvedValue({ recordId: "unused" });
  });

  const orgResolver: OrgResolver = {
    resolveAgentOrg: (rec: RecordShape) =>
      rec.sourceProjectId === "proj-1" ? "Default" : undefined,
    resolveToolOrg: () => undefined,
  };

  it("findDdbOnlyCorrectiveTargets plans a DDB row whose registry orgId is already divergent (not ALL_ORGS)", async () => {
    const { findDdbOnlyCorrectiveTargets } = jest.requireActual(
      "../backfill-shared-org-marker",
    ) as typeof import("../backfill-shared-org-marker");

    // The registry record for this id is NOT ALL_ORGS (e.g. orgId: "") —
    // so the registry-sourced scan in runCorrectiveForRegistryType would
    // never plan it. The DDB row is still ALL_ORGS+fabricator.
    const send = jest.fn().mockResolvedValue({
      Items: [
        {
          agentId: "agent-fixture-01",
          name: "divergent-agent",
          orgId: "All Organizations",
          createdBy: "fabricator",
          sourceProjectId: "proj-1",
        },
      ],
    });
    const docClient = {
      send,
    } as unknown as import("@aws-sdk/lib-dynamodb").DynamoDBDocumentClient;

    const alreadyPlannedIds = new Set<string>(); // registry scan found nothing for this id

    const entries = await findDdbOnlyCorrectiveTargets(
      "agent",
      "agent-table",
      docClient,
      orgResolver,
      alreadyPlannedIds,
    );

    expect(entries).toHaveLength(1);
    expect(entries[0]).toEqual(
      expect.objectContaining({
        id: "agent-fixture-01",
        resolvedOrgId: "Default",
        reason: "fabricator-agent-sourceProjectId",
      }),
    );
  });

  it("findDdbOnlyCorrectiveTargets skips a row already covered by the registry-sourced plan (no duplicate entry)", async () => {
    const { findDdbOnlyCorrectiveTargets } = jest.requireActual(
      "../backfill-shared-org-marker",
    ) as typeof import("../backfill-shared-org-marker");

    const send = jest.fn().mockResolvedValue({
      Items: [
        {
          agentId: "rec-already-planned",
          name: "covered-agent",
          orgId: "All Organizations",
          createdBy: "fabricator",
          sourceProjectId: "proj-1",
        },
      ],
    });
    const docClient = {
      send,
    } as unknown as import("@aws-sdk/lib-dynamodb").DynamoDBDocumentClient;

    const alreadyPlannedIds = new Set<string>(["rec-already-planned"]);

    const entries = await findDdbOnlyCorrectiveTargets(
      "agent",
      "agent-table",
      docClient,
      orgResolver,
      alreadyPlannedIds,
    );

    expect(entries).toHaveLength(0);
  });

  it("findDdbOnlyCorrectiveTargets excludes seed-name and non-fabricator rows", async () => {
    const { findDdbOnlyCorrectiveTargets } = jest.requireActual(
      "../backfill-shared-org-marker",
    ) as typeof import("../backfill-shared-org-marker");

    const send = jest.fn().mockResolvedValue({
      Items: [
        {
          agentId: "seed-1",
          name: "fabricator",
          orgId: "All Organizations",
          createdBy: "fabricator",
        },
        {
          agentId: "system-1",
          name: "system-agent",
          orgId: "All Organizations",
          createdBy: "system",
        },
      ],
    });
    const docClient = {
      send,
    } as unknown as import("@aws-sdk/lib-dynamodb").DynamoDBDocumentClient;

    const entries = await findDdbOnlyCorrectiveTargets(
      "agent",
      "agent-table",
      docClient,
      orgResolver,
      new Set(),
    );

    expect(entries).toHaveLength(0);
  });

  it("applyDdbOnlyCorrectiveEntry re-stamps both stores for a DDB-only divergent entry, converging the registry to match via a direct conditional DDB write", async () => {
    applyMarkerEdit.mockResolvedValue({ recordId: "agent-fixture-01" });
    const send = jest.fn().mockResolvedValue({});
    const entry = {
      id: "agent-fixture-01",
      name: "divergent-agent",
      kind: "agent" as const,
      previousOrgId: "All Organizations",
      resolvedOrgId: "Default",
      reason: "fabricator-agent-sourceProjectId",
    };
    const docClient = {
      send,
    } as unknown as import("@aws-sdk/lib-dynamodb").DynamoDBDocumentClient;

    const result = await applyDdbOnlyCorrectiveEntry(
      entry,
      "agent",
      {} as unknown as RegistryService,
      "agent-table",
      docClient,
    );

    expect(result.error).toBeUndefined();
    expect(applyMarkerEdit).toHaveBeenCalledWith(
      expect.objectContaining({
        recordId: "agent-fixture-01",
        fieldsToSet: { orgId: "Default" },
      }),
      expect.anything(),
    );
    expect(send).toHaveBeenCalledTimes(1);
    expect(send.mock.calls[0][0].input.Key).toEqual({
      agentId: "agent-fixture-01",
    });
    expect(send.mock.calls[0][0].input.ConditionExpression).toBe(
      "#orgId = :previousOrgId",
    );
  });

  it("applyDdbOnlyCorrectiveEntry treats a ConditionalCheckFailedException as success when the row is already in the desired state", async () => {
    applyMarkerEdit.mockResolvedValue({ recordId: "agent-fixture-01" });
    const conditionalError = new Error("The conditional request failed");
    conditionalError.name = "ConditionalCheckFailedException";
    const send = jest
      .fn()
      .mockRejectedValueOnce(conditionalError)
      .mockResolvedValueOnce({
        Item: { agentId: "agent-fixture-01", orgId: "Default" },
      });
    const entry = {
      id: "agent-fixture-01",
      name: "divergent-agent",
      kind: "agent" as const,
      previousOrgId: "All Organizations",
      resolvedOrgId: "Default",
      reason: "fabricator-agent-sourceProjectId",
    };
    const docClient = {
      send,
    } as unknown as import("@aws-sdk/lib-dynamodb").DynamoDBDocumentClient;

    const result = await applyDdbOnlyCorrectiveEntry(
      entry,
      "agent",
      {} as unknown as RegistryService,
      "agent-table",
      docClient,
    );

    expect(result.error).toBeUndefined();
    expect(send).toHaveBeenCalledTimes(2);
  });

  it("applyDdbOnlyCorrectiveEntry reports a genuine error when ConditionalCheckFailedException fires and the row is NOT in the desired state", async () => {
    applyMarkerEdit.mockResolvedValue({ recordId: "agent-fixture-01" });
    const conditionalError = new Error("The conditional request failed");
    conditionalError.name = "ConditionalCheckFailedException";
    const send = jest
      .fn()
      .mockRejectedValueOnce(conditionalError)
      .mockResolvedValueOnce({
        Item: { agentId: "agent-fixture-01", orgId: "SomeOtherOrg" },
      });
    const entry = {
      id: "agent-fixture-01",
      name: "divergent-agent",
      kind: "agent" as const,
      previousOrgId: "All Organizations",
      resolvedOrgId: "Default",
      reason: "fabricator-agent-sourceProjectId",
    };
    const docClient = {
      send,
    } as unknown as import("@aws-sdk/lib-dynamodb").DynamoDBDocumentClient;

    const result = await applyDdbOnlyCorrectiveEntry(
      entry,
      "agent",
      {} as unknown as RegistryService,
      "agent-table",
      docClient,
    );

    expect(result.error).toBe(
      "ConditionalCheckFailedException and row is not in the desired state",
    );
  });
});

// ---------------------------------------------------------------------------
// 19. buildToolNameOrgIndex — config as object/map (live rows are mostly maps)
// ---------------------------------------------------------------------------

describe("buildToolNameOrgIndex — config accepted as object/map OR JSON string", () => {
  const resolveAgentOrg = (rec: RecordShape): string | undefined => {
    if (
      rec.orgId !== undefined &&
      rec.orgId !== "" &&
      rec.orgId !== "All Organizations"
    )
      return rec.orgId;
    if (rec.sourceProjectId === "proj-1") return "Default";
    if (rec.sourceProjectId === "proj-2") return "Acme Corp";
    return undefined;
  };

  it("indexes a tool name from config.schema.tools[] when config is a plain object/map (live DDB shape)", () => {
    const agents: AgentConfigLike[] = [
      {
        name: "map-config-agent",
        createdBy: "fabricator",
        sourceProjectId: "proj-1",
        config: { schema: { tools: ["sync_widget_catalog"] } },
      },
    ];
    const index = buildToolNameOrgIndex(agents, resolveAgentOrg);
    expect(index.get("sync_widget_catalog")).toEqual(new Set(["Default"]));
  });

  it("indexes a tool name from config.schema.tools[] when config is a JSON string (legacy shape)", () => {
    const agents: AgentConfigLike[] = [
      {
        name: "string-config-agent",
        createdBy: "fabricator",
        sourceProjectId: "proj-1",
        config: JSON.stringify({ schema: { tools: ["sync_widget_catalog"] } }),
      },
    ];
    const index = buildToolNameOrgIndex(agents, resolveAgentOrg);
    expect(index.get("sync_widget_catalog")).toEqual(new Set(["Default"]));
  });

  it("an agent with an unparsable JSON-string config still contributes nothing without throwing", () => {
    const agents: AgentConfigLike[] = [
      {
        name: "broken-string-agent",
        createdBy: "fabricator",
        sourceProjectId: "proj-1",
        config: "{not valid json",
      },
    ];
    expect(() => buildToolNameOrgIndex(agents, resolveAgentOrg)).not.toThrow();
    expect(buildToolNameOrgIndex(agents, resolveAgentOrg).size).toBe(0);
  });

  it("a target agent (ALL_ORGS, createdBy fabricator, non-seed name) contributes its RESOLVED org, not ALL_ORGS", () => {
    const agents: AgentConfigLike[] = [
      {
        name: "target-agent",
        orgId: "All Organizations",
        createdBy: "fabricator",
        sourceProjectId: "proj-2",
        config: { schema: { tools: ["reconcile_ledger_entries"] } },
      },
    ];
    const index = buildToolNameOrgIndex(agents, resolveAgentOrg);
    expect(index.get("reconcile_ledger_entries")).toEqual(
      new Set(["Acme Corp"]),
    );
  });

  it("an ALL_ORGS agent that is NOT a fabricator corrective target (createdBy allowlisted) still contributes nothing", () => {
    const agents: AgentConfigLike[] = [
      {
        name: "platform-shared-agent",
        orgId: "All Organizations",
        createdBy: "seedConfig",
        sourceProjectId: "proj-1",
        config: { schema: { tools: ["platform_tool"] } },
      },
    ];
    const index = buildToolNameOrgIndex(agents, resolveAgentOrg);
    expect(index.has("platform_tool")).toBe(false);
  });

  it("a target agent whose sourceProjectId does not resolve contributes nothing", () => {
    const agents: AgentConfigLike[] = [
      {
        name: "unresolvable-target-agent",
        orgId: "All Organizations",
        createdBy: "fabricator",
        config: { schema: { tools: ["orphan_from_target"] } },
      },
    ];
    const index = buildToolNameOrgIndex(agents, resolveAgentOrg);
    expect(index.has("orphan_from_target")).toBe(false);
  });
});

// ---------------------------------------------------------------------------
// 20. --fallback-org — planCorrectiveEntry wiring
// ---------------------------------------------------------------------------

describe("planCorrectiveEntry — --fallback-org applies ONLY to unresolvable fabricator/non-seed records", () => {
  const orgResolver: OrgResolver = {
    resolveAgentOrg: (rec: RecordShape) =>
      rec.sourceProjectId === "proj-1" ? "Default" : undefined,
    resolveToolOrg: (rec: RecordShape) => {
      if (rec.name === "sync_widget_catalog") return "Default";
      if (rec.name === "multi_org_tool") return "AMBIGUOUS";
      return undefined;
    },
  };

  it("applies the fallback org to an unresolvable fabricator, non-seed-name tool", () => {
    const rec: RecordShape = {
      id: "t-orphan",
      name: "orphan_tool",
      orgId: "All Organizations",
      createdBy: "fabricator",
    };
    const entry = planCorrectiveEntry(rec, "tool", orgResolver, "Default");
    expect(entry).toEqual({
      id: "t-orphan",
      name: "orphan_tool",
      kind: "tool",
      previousOrgId: "All Organizations",
      resolvedOrgId: "Default",
      reason: "fallback-org",
    });
  });

  it("does NOT apply the fallback to an ambiguous (multi-org) tool", () => {
    const rec: RecordShape = {
      id: "t-multi",
      name: "multi_org_tool",
      orgId: "All Organizations",
      createdBy: "fabricator",
    };
    const entry = planCorrectiveEntry(rec, "tool", orgResolver, "Default");
    expect(entry?.reason).toBe("ambiguous-multi-org");
    expect(entry?.resolvedOrgId).toBeUndefined();
  });

  it("does NOT apply the fallback to a seed-name record (out of corrective scope entirely)", () => {
    const rec: RecordShape = {
      id: "a-seed",
      name: "fabricator",
      orgId: "All Organizations",
      createdBy: "fabricator",
    };
    const entry = planCorrectiveEntry(rec, "agent", orgResolver, "Default");
    expect(entry).toBeUndefined();
  });

  it("does NOT apply the fallback to a non-fabricator record (out of corrective scope entirely)", () => {
    const rec: RecordShape = {
      id: "a-system",
      name: "system-agent",
      orgId: "All Organizations",
      createdBy: "system",
    };
    const entry = planCorrectiveEntry(rec, "agent", orgResolver, "Default");
    expect(entry).toBeUndefined();
  });

  it("does NOT apply the fallback to a record resolvable via sourceProjectId (normal resolution wins)", () => {
    const rec: RecordShape = {
      id: "a-resolvable",
      name: "resolvable-agent",
      orgId: "All Organizations",
      createdBy: "fabricator",
      sourceProjectId: "proj-1",
    };
    const entry = planCorrectiveEntry(rec, "agent", orgResolver, "Default");
    expect(entry?.reason).toBe("fabricator-agent-sourceProjectId");
    expect(entry?.resolvedOrgId).toBe("Default");
  });

  it("without --fallback-org, an unresolvable record stays unresolvable-orgUnknown (behaviour unchanged)", () => {
    const rec: RecordShape = {
      id: "t-orphan-2",
      name: "orphan_tool_2",
      orgId: "All Organizations",
      createdBy: "fabricator",
    };
    const entry = planCorrectiveEntry(rec, "tool", orgResolver);
    expect(entry?.reason).toBe("unresolvable-orgUnknown");
    expect(entry?.resolvedOrgId).toBeUndefined();
  });
});

// ---------------------------------------------------------------------------
// 21. --fallback-org — runCorrectiveForRegistryType end-to-end wiring
// ---------------------------------------------------------------------------

describe("runCorrectiveForRegistryType — --fallback-org wiring and summary counting", () => {
  const { applyMarkerEdit } = jest.requireMock(
    "../../src/utils/marker-registry-edit",
  ) as { applyMarkerEdit: jest.Mock };

  beforeEach(() => {
    applyMarkerEdit.mockReset();
    applyMarkerEdit.mockResolvedValue({ recordId: "unused" });
  });

  const orgResolver: OrgResolver = {
    resolveAgentOrg: () => undefined,
    resolveToolOrg: () => undefined,
  };

  function makeListedRegistry(
    items: Array<{
      recordId: string;
      name: string;
      orgId: string;
      createdBy: string;
    }>,
  ): RegistryService {
    const listResourcesChecked = jest.fn().mockResolvedValue({
      items: items.map((i) => ({
        recordId: i.recordId,
        name: i.name,
        status: "APPROVED",
        customDescriptorContent: JSON.stringify({
          orgId: i.orgId,
          createdBy: i.createdBy,
        }),
      })),
      partial: false,
      droppedCount: 0,
      throttled: false,
    });
    return { listResourcesChecked } as unknown as RegistryService;
  }

  it("applies the fallback org and writes it, counting markedFallback (not markedTenant/markedUnknown)", async () => {
    const registry = makeListedRegistry([
      {
        recordId: "tool-orphan-1",
        name: "orphan_tool_3",
        orgId: "All Organizations",
        createdBy: "fabricator",
      },
    ]);
    const send = jest.fn().mockResolvedValue({
      Item: {
        toolId: "tool-orphan-1",
        orgId: "Default",
        registryStatus: undefined,
      },
    });
    const docClient = {
      send,
    } as unknown as import("@aws-sdk/lib-dynamodb").DynamoDBDocumentClient;
    const summary = emptySummary();

    const plan = await runCorrectiveForRegistryType(
      "tool",
      registry,
      orgResolver,
      true,
      undefined,
      summary,
      "tool-table",
      docClient,
      undefined,
      1,
      5,
      "Default",
      0,
      undefined,
      [],
      [],
      60000,
      1000,
      fastClock(),
    );

    expect(plan).toHaveLength(1);
    expect(plan[0].reason).toBe("fallback-org");
    expect(plan[0].resolvedOrgId).toBe("Default");
    expect(applyMarkerEdit).toHaveBeenCalledWith(
      expect.objectContaining({
        recordId: "tool-orphan-1",
        fieldsToSet: { orgId: "Default" },
      }),
      expect.anything(),
    );
    expect(summary.markedFallback).toBe(1);
    expect(summary.markedTenant).toBe(0);
    expect(summary.markedUnknown).toBe(0);
  });

  it("without --fallback-org, the same record is written as orgUnknown and counted under markedUnknown", async () => {
    const registry = makeListedRegistry([
      {
        recordId: "tool-orphan-2",
        name: "orphan_tool_4",
        orgId: "All Organizations",
        createdBy: "fabricator",
      },
    ]);
    const send = jest.fn().mockResolvedValue({
      Item: {
        toolId: "tool-orphan-2",
        orgUnknown: true,
        registryStatus: undefined,
      },
    });
    const docClient = {
      send,
    } as unknown as import("@aws-sdk/lib-dynamodb").DynamoDBDocumentClient;
    const summary = emptySummary();

    const plan = await runCorrectiveForRegistryType(
      "tool",
      registry,
      orgResolver,
      true,
      undefined,
      summary,
      "tool-table",
      docClient,
      undefined,
      1,
      5,
      undefined,
      0,
      undefined,
      [],
      [],
      60000,
      1000,
      fastClock(),
    );

    expect(plan).toHaveLength(1);
    expect(plan[0].reason).toBe("unresolvable-orgUnknown");
    expect(summary.markedUnknown).toBe(1);
    expect(summary.markedFallback).toBe(0);
  });
});

// ---------------------------------------------------------------------------
// 22. --fallback-org — org-existence validation (buildOrgResolverFromTablesWithKnownOrgs)
// ---------------------------------------------------------------------------

describe("buildOrgResolverFromTablesWithKnownOrgs — known-org validation support", () => {
  it("returns the distinct set of organization values found in the projects table", async () => {
    const send = jest.fn().mockImplementation((command) => {
      if (command.input.TableName === "projects-table") {
        return Promise.resolve({
          Items: [
            { projectId: "proj-1", organization: "Default" },
            { projectId: "proj-2", organization: "Acme Corp" },
            { projectId: "proj-3", organization: "Default" },
          ],
        });
      }
      return Promise.resolve({ Items: [] });
    });
    const docClient = {
      send,
    } as unknown as import("@aws-sdk/lib-dynamodb").DynamoDBDocumentClient;

    const { knownOrgs } = await buildOrgResolverFromTablesWithKnownOrgs(
      docClient,
      "projects-table",
      "agent-table",
    );

    expect(knownOrgs).toEqual(new Set(["Default", "Acme Corp"]));
  });

  it("the returned orgResolver still resolves agent org via sourceProjectId", async () => {
    const send = jest.fn().mockImplementation((command) => {
      if (command.input.TableName === "projects-table") {
        return Promise.resolve({
          Items: [{ projectId: "proj-1", organization: "Default" }],
        });
      }
      return Promise.resolve({ Items: [] });
    });
    const docClient = {
      send,
    } as unknown as import("@aws-sdk/lib-dynamodb").DynamoDBDocumentClient;

    const { orgResolver } = await buildOrgResolverFromTablesWithKnownOrgs(
      docClient,
      "projects-table",
      "agent-table",
    );

    expect(
      orgResolver.resolveAgentOrg({ id: "a1", sourceProjectId: "proj-1" }),
    ).toBe("Default");
  });
});

describe("main() --fallback-org CLI validation", () => {
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

  it("rejects --fallback-org when --correct-fabricator-shared is not set", async () => {
    process.env.REGISTRY_ID = "reg-1";
    process.env.AGENT_CONFIG_TABLE = "t-agents";
    process.env.TOOL_CONFIG_TABLE = "t-tools";
    process.argv = ["node", "script", "--fallback-org", "Default"];
    await expect(main()).rejects.toThrow(
      "--fallback-org is only valid together with --correct-fabricator-shared",
    );
  });

  it("rejects --fallback-org with no value", async () => {
    process.env.REGISTRY_ID = "reg-1";
    process.env.AGENT_CONFIG_TABLE = "t-agents";
    process.env.TOOL_CONFIG_TABLE = "t-tools";
    process.env.PROJECTS_TABLE = "t-projects";
    process.argv = [
      "node",
      "script",
      "--correct-fabricator-shared",
      "--fallback-org",
    ];
    await expect(main()).rejects.toThrow("--fallback-org requires a value");
  });
});

// ---------------------------------------------------------------------------
// 23. --fallback-org — findDdbOnlyCorrectiveTargets wiring
// ---------------------------------------------------------------------------

describe("findDdbOnlyCorrectiveTargets — --fallback-org applies to DDB-only unresolvable targets too", () => {
  const orgResolver: OrgResolver = {
    resolveAgentOrg: () => undefined,
    resolveToolOrg: () => undefined,
  };

  it("plans a DDB-only fabricator tool row with reason fallback-org when a fallback is supplied", async () => {
    const send = jest.fn().mockResolvedValue({
      Items: [
        {
          toolId: "ddb-tool-orphan",
          name: "ddb_orphan_tool",
          orgId: "All Organizations",
          createdBy: "fabricator",
        },
      ],
    });
    const docClient = {
      send,
    } as unknown as import("@aws-sdk/lib-dynamodb").DynamoDBDocumentClient;

    const entries = await findDdbOnlyCorrectiveTargets(
      "tool",
      "tool-table",
      docClient,
      orgResolver,
      new Set(),
      "Default",
    );

    expect(entries).toHaveLength(1);
    expect(entries[0].reason).toBe("fallback-org");
    expect(entries[0].resolvedOrgId).toBe("Default");
  });

  it("does not apply the fallback to a DDB-only seed-name row", async () => {
    const send = jest.fn().mockResolvedValue({
      Items: [
        {
          agentId: "ddb-seed",
          name: "fabricator",
          orgId: "All Organizations",
          createdBy: "fabricator",
        },
      ],
    });
    const docClient = {
      send,
    } as unknown as import("@aws-sdk/lib-dynamodb").DynamoDBDocumentClient;

    const entries = await findDdbOnlyCorrectiveTargets(
      "agent",
      "agent-table",
      docClient,
      orgResolver,
      new Set(),
      "Default",
    );

    expect(entries).toHaveLength(0);
  });
});

// ---------------------------------------------------------------------------
// 22. applyCorrectiveEntry — needsReapproval bucket (throttle-after-write)
// ---------------------------------------------------------------------------
//
// Incident reproduction (synthetic ids/names/orgs): UpdateRegistryRecord
// lands (the registry demotes an updated record to DRAFT), then the
// post-write approval-restoration steps inside applyMarkerEdit fail — it
// returns successfully (no `error`) with priorStatus APPROVED, postStatus
// DRAFT, reapproved false. That exact signature must be surfaced as a
// distinct `needsReapproval` outcome, never folded into a generic error and
// never treated as a clean success.

describe("applyCorrectiveEntry — needsReapproval bucket", () => {
  const { applyMarkerEdit } = jest.requireMock(
    "../../src/utils/marker-registry-edit",
  ) as { applyMarkerEdit: jest.Mock };

  beforeEach(() => {
    applyMarkerEdit.mockReset();
  });

  function fakeRegistry(): RegistryService {
    return {} as unknown as RegistryService;
  }

  function fakeDocClient(sendImpl: jest.Mock) {
    return {
      send: sendImpl,
    } as unknown as import("@aws-sdk/lib-dynamodb").DynamoDBDocumentClient;
  }

  it("flags needsReapproval=true when the registry write landed but approval restoration failed (priorStatus APPROVED, postStatus DRAFT, reapproved false, no error)", async () => {
    applyMarkerEdit.mockResolvedValue({
      recordId: "synthetic-agent-1",
      priorStatus: "APPROVED",
      postStatus: "DRAFT",
      fieldsChanged: ["orgId"],
      reapproved: false,
      error: undefined,
    });
    const send = jest.fn().mockResolvedValue({
      Item: {
        agentId: "synthetic-agent-1",
        orgId: "SyntheticOrg",
        registryStatus: "APPROVED",
      },
    });
    const entry = {
      id: "synthetic-agent-1",
      name: "synthetic-fabricated-agent",
      kind: "agent" as const,
      previousOrgId: ALL_ORGS,
      resolvedOrgId: "SyntheticOrg",
      reason: "fabricator-agent-sourceProjectId",
    };

    const result = await applyCorrectiveEntry(
      entry,
      "agent",
      fakeRegistry(),
      "agent-table",
      fakeDocClient(send),
      0,
      undefined,
      60000,
      1000,
      fastClock(),
    );

    expect(result.error).toBeUndefined();
    expect(result.needsReapproval).toBe(true);
    expect(result.projectionLag).toBeFalsy();
    // No direct DDB write — every send() call is a read poll, never an
    // UpdateCommand.
    for (const [command] of send.mock.calls) {
      expect(command.input.UpdateExpression).toBeUndefined();
    }
  });

  it("does not flag needsReapproval for a clean successful reapproval", async () => {
    applyMarkerEdit.mockResolvedValue({
      recordId: "synthetic-agent-2",
      priorStatus: "APPROVED",
      postStatus: "APPROVED",
      fieldsChanged: ["orgId"],
      reapproved: true,
      error: undefined,
    });
    const send = jest.fn().mockResolvedValue({
      Item: {
        agentId: "synthetic-agent-2",
        orgId: "SyntheticOrg",
        registryStatus: "APPROVED",
      },
    });
    const entry = {
      id: "synthetic-agent-2",
      name: "synthetic-fabricated-agent-2",
      kind: "agent" as const,
      previousOrgId: ALL_ORGS,
      resolvedOrgId: "SyntheticOrg",
      reason: "fabricator-agent-sourceProjectId",
    };

    const result = await applyCorrectiveEntry(
      entry,
      "agent",
      fakeRegistry(),
      "agent-table",
      fakeDocClient(send),
      0,
      undefined,
      60000,
      1000,
      fastClock(),
    );

    expect(result.error).toBeUndefined();
    expect(result.needsReapproval).toBeFalsy();
  });

  it("does not flag needsReapproval when the record was never APPROVED to begin with (priorStatus DRAFT)", async () => {
    applyMarkerEdit.mockResolvedValue({
      recordId: "synthetic-tool-1",
      priorStatus: "DRAFT",
      postStatus: "DRAFT",
      fieldsChanged: ["orgId"],
      reapproved: false,
      error: undefined,
    });
    const send = jest.fn().mockResolvedValue({
      Item: {
        toolId: "synthetic-tool-1",
        orgId: "SyntheticOrg",
        registryStatus: "DRAFT",
      },
    });
    const entry = {
      id: "synthetic-tool-1",
      name: "synthetic-fabricated-tool",
      kind: "tool" as const,
      previousOrgId: ALL_ORGS,
      resolvedOrgId: "SyntheticOrg",
      reason: "fabricator-tool-name",
    };

    const result = await applyCorrectiveEntry(
      entry,
      "tool",
      fakeRegistry(),
      "tool-table",
      fakeDocClient(send),
      0,
      undefined,
      60000,
      1000,
      fastClock(),
    );

    expect(result.error).toBeUndefined();
    expect(result.needsReapproval).toBeFalsy();
  });

  it("still surfaces a genuine pre-write updateResource failure (UpdateRegistryRecord itself never landed) as `error`, never as needsReapproval", async () => {
    // Post-incident-fix, `applyMarkerEdit` only returns `error:
    // "updateResource failed: ..."` when the UpdateRegistryRecordCommand
    // call itself threw — i.e. the write never landed, nothing to restore.
    // That is a DIFFERENT failure shape from the incident (write landed,
    // post-write settle poll throttled): this test's mocked postStatus
    // "APPROVED" with an `error` string models the pre-write case, which
    // must still bucket as a genuine `error`, never `needsReapproval`.
    applyMarkerEdit.mockResolvedValue({
      recordId: "synthetic-agent-3",
      priorStatus: "APPROVED",
      postStatus: "APPROVED",
      fieldsChanged: [],
      reapproved: false,
      error: "updateResource failed: ThrottlingException",
    });
    const send = jest.fn();
    const entry = {
      id: "synthetic-agent-3",
      name: "synthetic-fabricated-agent-3",
      kind: "agent" as const,
      previousOrgId: ALL_ORGS,
      resolvedOrgId: "SyntheticOrg",
      reason: "fabricator-agent-sourceProjectId",
    };

    const result = await applyCorrectiveEntry(
      entry,
      "agent",
      fakeRegistry(),
      "agent-table",
      fakeDocClient(send),
    );

    expect(result.error).toBe("updateResource failed: ThrottlingException");
    expect(result.needsReapproval).toBeFalsy();
    expect(send).not.toHaveBeenCalled();
  });
});

// ---------------------------------------------------------------------------
// 23. runCorrectiveForRegistryType — needsReapproval bucket, continue+retry,
//     and --limit counting ATTEMPTS (successes + failures), not just
//     successes
// ---------------------------------------------------------------------------

describe("runCorrectiveForRegistryType — needsReapproval bucket and --limit counts attempts", () => {
  const { applyMarkerEdit } = jest.requireMock(
    "../../src/utils/marker-registry-edit",
  ) as { applyMarkerEdit: jest.Mock };

  beforeEach(() => {
    applyMarkerEdit.mockReset();
  });

  const orgResolver: OrgResolver = {
    resolveAgentOrg: (rec: RecordShape) =>
      rec.sourceProjectId === "proj-synthetic" ? "SyntheticOrg" : undefined,
    resolveToolOrg: () => undefined,
  };

  function makeListedRegistry(
    items: Array<{
      recordId: string;
      name: string;
      orgId: string;
      createdBy: string;
      sourceProjectId?: string;
    }>,
  ): RegistryService {
    const listResourcesChecked = jest.fn().mockResolvedValue({
      items: items.map((i) => ({
        recordId: i.recordId,
        name: i.name,
        status: "APPROVED",
        customDescriptorContent: JSON.stringify({
          orgId: i.orgId,
          createdBy: i.createdBy,
          sourceProjectId: i.sourceProjectId,
        }),
      })),
      partial: false,
      droppedCount: 0,
      throttled: false,
    });
    return { listResourcesChecked } as unknown as RegistryService;
  }

  it("buckets a needsReapproval record into summary.needsReapproval and continues to the next record (never abandons the loop)", async () => {
    const registry = makeListedRegistry([
      {
        recordId: "synthetic-rec-1",
        name: "synthetic-agent-a",
        orgId: ALL_ORGS,
        createdBy: "fabricator",
        sourceProjectId: "proj-synthetic",
      },
      {
        recordId: "synthetic-rec-2",
        name: "synthetic-agent-b",
        orgId: ALL_ORGS,
        createdBy: "fabricator",
        sourceProjectId: "proj-synthetic",
      },
    ]);
    applyMarkerEdit
      .mockResolvedValueOnce({
        recordId: "synthetic-rec-1",
        priorStatus: "APPROVED",
        postStatus: "DRAFT",
        reapproved: false,
        error: undefined,
      })
      .mockResolvedValueOnce({
        recordId: "synthetic-rec-2",
        priorStatus: "APPROVED",
        postStatus: "APPROVED",
        reapproved: true,
        error: undefined,
      });
    const send = jest.fn().mockResolvedValue({
      Item: {
        agentId: "synthetic-rec-1",
        orgId: "SyntheticOrg",
        registryStatus: "APPROVED",
      },
    });
    const docClient = {
      send,
    } as unknown as import("@aws-sdk/lib-dynamodb").DynamoDBDocumentClient;
    const summary = emptySummary();

    const plan = await runCorrectiveForRegistryType(
      "agent",
      registry,
      orgResolver,
      /* apply */ true,
      /* limit */ undefined,
      summary,
      "agent-table",
      docClient,
      undefined,
      1,
      5,
      undefined,
      0,
      undefined,
      [],
      [],
      60000,
      1000,
      fastClock(),
    );

    expect(plan).toHaveLength(2);
    expect(summary.needsReapproval).toBe(1);
    expect(summary.errors).toBe(0);
    // Both records were still attempted (the loop continued past the
    // needsReapproval record instead of abandoning the run).
    expect(applyMarkerEdit).toHaveBeenCalledTimes(2);
  });

  // Reproduces the review finding: the end-of-run re-approval pass must
  // iterate ONLY the ids flagged needsReapproval, never the full planned
  // set — otherwise, with --limit scoping writes to a subset of the plan,
  // the pass would getResource/submit/approve every un-attempted
  // non-APPROVED record too, violating --limit's attempted-record
  // boundary. This asserts the shared `needsReapprovalEntries` array
  // (threaded through to the caller and iterated by main()'s end-of-run
  // pass) accumulates exactly the flagged record and not the clean one.
  it("tracks only the flagged record's {id, type} in the shared needsReapprovalEntries array, never the clean one", async () => {
    const registry = makeListedRegistry([
      {
        recordId: "synthetic-rec-1",
        name: "synthetic-agent-a",
        orgId: ALL_ORGS,
        createdBy: "fabricator",
        sourceProjectId: "proj-synthetic",
      },
      {
        recordId: "synthetic-rec-2",
        name: "synthetic-agent-b",
        orgId: ALL_ORGS,
        createdBy: "fabricator",
        sourceProjectId: "proj-synthetic",
      },
    ]);
    applyMarkerEdit
      .mockResolvedValueOnce({
        recordId: "synthetic-rec-1",
        priorStatus: "APPROVED",
        postStatus: "DRAFT",
        reapproved: false,
        error: undefined,
      })
      .mockResolvedValueOnce({
        recordId: "synthetic-rec-2",
        priorStatus: "APPROVED",
        postStatus: "APPROVED",
        reapproved: true,
        error: undefined,
      });
    const send = jest.fn().mockResolvedValue({
      Item: {
        agentId: "synthetic-rec-1",
        orgId: "SyntheticOrg",
        registryStatus: "APPROVED",
      },
    });
    const docClient = {
      send,
    } as unknown as import("@aws-sdk/lib-dynamodb").DynamoDBDocumentClient;
    const summary = emptySummary();
    const needsReapprovalEntries: { id: string; type: "agent" | "tool" }[] = [];

    await runCorrectiveForRegistryType(
      "agent",
      registry,
      orgResolver,
      /* apply */ true,
      /* limit */ undefined,
      summary,
      "agent-table",
      docClient,
      undefined,
      undefined,
      undefined,
      undefined,
      /* callDelayMs */ 0,
      undefined,
      needsReapprovalEntries,
      [],
      60000,
      1000,
      fastClock(),
    );

    expect(needsReapprovalEntries).toEqual([
      { id: "synthetic-rec-1", type: "agent", priorStatus: "APPROVED" },
    ]);
  });

  it("--limit bounds ATTEMPTS (successes + failures), matching the incident where a failed write never counted toward --limit", async () => {
    const registry = makeListedRegistry([
      {
        recordId: "synthetic-rec-1",
        name: "synthetic-agent-a",
        orgId: ALL_ORGS,
        createdBy: "fabricator",
        sourceProjectId: "proj-synthetic",
      },
      {
        recordId: "synthetic-rec-2",
        name: "synthetic-agent-b",
        orgId: ALL_ORGS,
        createdBy: "fabricator",
        sourceProjectId: "proj-synthetic",
      },
      {
        recordId: "synthetic-rec-3",
        name: "synthetic-agent-c",
        orgId: ALL_ORGS,
        createdBy: "fabricator",
        sourceProjectId: "proj-synthetic",
      },
    ]);
    // First attempt fails outright (a genuine error) — under the OLD
    // behaviour this would not count toward --limit and a 3rd record
    // would still be attempted even with --limit 2. Under the fix, it
    // DOES count, so only 2 records are ever attempted.
    applyMarkerEdit
      .mockResolvedValueOnce({
        recordId: "synthetic-rec-1",
        priorStatus: "APPROVED",
        postStatus: "APPROVED",
        reapproved: false,
        error: "updateResource failed: ThrottlingException",
      })
      .mockResolvedValueOnce({
        recordId: "synthetic-rec-2",
        priorStatus: "APPROVED",
        postStatus: "APPROVED",
        reapproved: true,
        error: undefined,
      });
    const send = jest.fn().mockResolvedValue({
      Item: {
        agentId: "synthetic-rec-2",
        orgId: "SyntheticOrg",
        registryStatus: "APPROVED",
      },
    });
    const docClient = {
      send,
    } as unknown as import("@aws-sdk/lib-dynamodb").DynamoDBDocumentClient;
    const summary = emptySummary();

    await runCorrectiveForRegistryType(
      "agent",
      registry,
      orgResolver,
      /* apply */ true,
      /* limit */ 2,
      summary,
      "agent-table",
      docClient,
      undefined,
      1,
      5,
      undefined,
      0,
      undefined,
      [],
      [],
      60000,
      1000,
      fastClock(),
    );

    // Exactly 2 attempts were made (1 failure + 1 success); the 3rd
    // record was never attempted because --limit counts the failed
    // attempt too.
    expect(applyMarkerEdit).toHaveBeenCalledTimes(2);
    expect(summary.errors).toBe(1);
  });

  it("forwards callDelayMs/callPacer through applyCorrectiveEntry into applyMarkerEdit, which paces between its own internal registry calls", async () => {
    const registry = makeListedRegistry([
      {
        recordId: "synthetic-rec-1",
        name: "synthetic-agent-a",
        orgId: ALL_ORGS,
        createdBy: "fabricator",
        sourceProjectId: "proj-synthetic",
      },
      {
        recordId: "synthetic-rec-2",
        name: "synthetic-agent-b",
        orgId: ALL_ORGS,
        createdBy: "fabricator",
        sourceProjectId: "proj-synthetic",
      },
    ]);
    applyMarkerEdit.mockResolvedValue({
      recordId: "unused",
      priorStatus: "APPROVED",
      postStatus: "APPROVED",
      reapproved: true,
      error: undefined,
    });
    const send = jest.fn().mockResolvedValue({
      Item: {
        agentId: "unused",
        orgId: "SyntheticOrg",
        registryStatus: "APPROVED",
      },
    });
    const docClient = {
      send,
    } as unknown as import("@aws-sdk/lib-dynamodb").DynamoDBDocumentClient;
    const summary = emptySummary();
    const pacer = jest.fn().mockResolvedValue(undefined);

    await runCorrectiveForRegistryType(
      "agent",
      registry,
      orgResolver,
      /* apply */ true,
      /* limit */ undefined,
      summary,
      "agent-table",
      docClient,
      undefined,
      undefined,
      undefined,
      undefined,
      /* callDelayMs */ 400,
      pacer,
      [],
      [],
      60000,
      1000,
      fastClock(),
    );

    // applyMarkerEdit is mocked in this file, so the pacing itself (now
    // internal to the real applyMarkerEdit — see
    // marker-registry-edit.test.ts for that coverage) never fires here.
    // What this test asserts is that the outer loop forwards callDelayMs
    // and callPacer into applyMarkerEdit's options for every attempted
    // write, for both records.
    expect(applyMarkerEdit).toHaveBeenCalledTimes(2);
    for (const call of applyMarkerEdit.mock.calls) {
      const options = call[1] as { callDelayMs?: number; callPacer?: unknown };
      expect(options.callDelayMs).toBe(400);
      expect(options.callPacer).toBe(pacer);
    }
  });
});

// ---------------------------------------------------------------------------
// 24. --restore-approval — restoreApprovalForRecord
// ---------------------------------------------------------------------------

describe("restoreApprovalForRecord", () => {
  const { applyMarkerEdit } = jest.requireMock(
    "../../src/utils/marker-registry-edit",
  ) as { applyMarkerEdit: jest.Mock };

  beforeEach(() => {
    applyMarkerEdit.mockReset();
  });

  it("dry-run (default) prints the plan and never calls applyMarkerEdit", async () => {
    const { restoreApprovalForRecord } = jest.requireActual(
      "../backfill-shared-org-marker",
    ) as typeof import("../backfill-shared-org-marker");

    const registry = {
      getResource: jest.fn().mockResolvedValue({
        recordId: "synthetic-rec-1",
        name: "synthetic-agent",
        status: "DRAFT",
        customDescriptorContent: JSON.stringify({ orgId: "SyntheticOrg" }),
      }),
    } as unknown as RegistryService;

    const result = await restoreApprovalForRecord(
      "synthetic-rec-1",
      "agent",
      registry,
      /* apply */ false,
    );

    expect(result.wouldRestore).toBe(true);
    expect(applyMarkerEdit).not.toHaveBeenCalled();
  });

  it("is a no-op when the record is already APPROVED", async () => {
    const { restoreApprovalForRecord } = jest.requireActual(
      "../backfill-shared-org-marker",
    ) as typeof import("../backfill-shared-org-marker");

    const registry = {
      getResource: jest.fn().mockResolvedValue({
        recordId: "synthetic-rec-2",
        name: "synthetic-agent-2",
        status: "APPROVED",
        customDescriptorContent: JSON.stringify({ orgId: "SyntheticOrg" }),
      }),
    } as unknown as RegistryService;

    const result = await restoreApprovalForRecord(
      "synthetic-rec-2",
      "agent",
      registry,
      /* apply */ true,
    );

    expect(result.alreadyApproved).toBe(true);
    expect(result.error).toBeUndefined();
    expect(applyMarkerEdit).not.toHaveBeenCalled();
  });

  it("in apply mode, runs submitForApproval -> decide on a DRAFT record and verifies APPROVED", async () => {
    const { restoreApprovalForRecord } = jest.requireActual(
      "../backfill-shared-org-marker",
    ) as typeof import("../backfill-shared-org-marker");

    let status = "DRAFT";
    const registry = {
      getResource: jest.fn().mockImplementation(() =>
        Promise.resolve({
          recordId: "synthetic-rec-3",
          name: "synthetic-agent-3",
          status,
          customDescriptorContent: JSON.stringify({ orgId: "SyntheticOrg" }),
        }),
      ),
      submitForApproval: jest.fn().mockImplementation(() => {
        status = "PENDING_APPROVAL";
        return Promise.resolve({ recordId: "synthetic-rec-3", status });
      }),
      updateResourceStatus: jest.fn().mockImplementation(() => {
        status = "APPROVED";
        return Promise.resolve({ recordId: "synthetic-rec-3", status });
      }),
    } as unknown as RegistryService;

    const result = await restoreApprovalForRecord(
      "synthetic-rec-3",
      "agent",
      registry,
      /* apply */ true,
    );

    expect(result.error).toBeUndefined();
    expect(result.restored).toBe(true);
    expect(registry.submitForApproval).toHaveBeenCalledWith("synthetic-rec-3");
    expect(registry.updateResourceStatus).toHaveBeenCalled();
  });

  it("exits with a non-zero-signaling error if restoration fails to reach APPROVED", async () => {
    const { restoreApprovalForRecord } = jest.requireActual(
      "../backfill-shared-org-marker",
    ) as typeof import("../backfill-shared-org-marker");

    const registry = {
      getResource: jest.fn().mockResolvedValue({
        recordId: "synthetic-rec-4",
        name: "synthetic-agent-4",
        status: "DRAFT",
        customDescriptorContent: JSON.stringify({ orgId: "SyntheticOrg" }),
      }),
      submitForApproval: jest
        .fn()
        .mockRejectedValue(new Error("ThrottlingException")),
    } as unknown as RegistryService;

    const result = await restoreApprovalForRecord(
      "synthetic-rec-4",
      "agent",
      registry,
      /* apply */ true,
    );

    expect(result.error).toBeDefined();
    expect(result.restored).toBeFalsy();
  });
});

// ---------------------------------------------------------------------------
// 25. runCorrectiveMode — exit code on residual needsReapproval, and the
//     end-of-run re-approval pass that runs before that exit decision.
// ---------------------------------------------------------------------------
//
// `applyMarkerEdit` stays mocked (module-level jest.mock above) so the
// corrective-write path returns a controlled needsReapproval result; the
// end-of-run re-approval pass itself calls `registry.getResource` /
// `registry.submitForApproval` / `registry.updateResourceStatus` directly
// (see `restoreApprovalForRecord`), so those are stubbed on the registry
// fixture independently of `applyMarkerEdit`.
describe("runCorrectiveMode — needsReapproval exit code and end-of-run re-approval pass", () => {
  const { applyMarkerEdit } = jest.requireMock(
    "../../src/utils/marker-registry-edit",
  ) as { applyMarkerEdit: jest.Mock };

  let exitSpy: jest.SpyInstance;
  let tmpDir: string;
  let evidencePath: string;

  beforeEach(() => {
    applyMarkerEdit.mockReset();
    exitSpy = jest.spyOn(process, "exit").mockImplementation(((
      code?: number,
    ) => {
      throw new Error(`process.exit(${code})`);
    }) as never);
    const os = jest.requireActual("os") as typeof import("os");
    const path = jest.requireActual("path") as typeof import("path");
    const fs = jest.requireActual("fs") as typeof import("fs");
    tmpDir = fs.mkdtempSync(
      path.join(os.tmpdir(), "evidence-reapproval-test-"),
    );
    evidencePath = path.join(tmpDir, "evidence.json");
  });

  afterEach(() => {
    exitSpy.mockRestore();
    const fs = jest.requireActual("fs") as typeof import("fs");
    fs.rmSync(tmpDir, { recursive: true, force: true });
  });

  function makeDocClient(): import("@aws-sdk/lib-dynamodb").DynamoDBDocumentClient {
    // Every ScanCommand used by buildOrgResolverFromTablesWithKnownOrgs and
    // findDdbOnlyCorrectiveTargets resolves to an empty page — the plan in
    // these tests comes entirely from the registry-sourced listing, so the
    // DDB-only scan path contributes nothing and the org-resolver build
    // needs no known orgs (no --fallback-org is used).
    const send = jest.fn().mockResolvedValue({ Items: [] });
    return {
      send,
    } as unknown as import("@aws-sdk/lib-dynamodb").DynamoDBDocumentClient;
  }

  /**
   * Same Scan-returns-empty-page behaviour as {@link makeDocClient}, but
   * GetCommand resolves to a converged projection row (matching
   * `expectedOrgId`/`expectedRegistryStatus`) so the bounded convergence
   * wait in `applyCorrectiveEntry` succeeds immediately instead of
   * exhausting the wait window and bucketing `projectionLag`.
   */
  function makeConvergingDocClient(
    convergedItem: Record<string, unknown>,
  ): import("@aws-sdk/lib-dynamodb").DynamoDBDocumentClient {
    const send = jest.fn().mockImplementation((command) => {
      const ctorName = command?.constructor?.name;
      if (ctorName === "GetCommand") {
        return Promise.resolve({ Item: convergedItem });
      }
      return Promise.resolve({ Items: [] });
    });
    return {
      send,
    } as unknown as import("@aws-sdk/lib-dynamodb").DynamoDBDocumentClient;
  }

  function makeRegistry(
    items: Array<{ recordId: string; name: string; orgId: string }>,
  ): RegistryService {
    // Scoped to "agent" only, mirroring a registry that holds just one
    // resource kind for these synthetic ids — avoids the same record
    // being double-planned under both "agent" and "tool" kinds, which
    // would otherwise double every count in these exit-code/pass tests.
    const listResourcesChecked = jest.fn().mockImplementation((type: string) =>
      Promise.resolve({
        items:
          type === "agent"
            ? items.map((i) => ({
                recordId: i.recordId,
                name: i.name,
                status: "APPROVED",
                customDescriptorContent: JSON.stringify({
                  orgId: i.orgId,
                  createdBy: "fabricator",
                  sourceProjectId: "proj-synthetic",
                }),
              }))
            : [],
        partial: false,
        droppedCount: 0,
        throttled: false,
      }),
    );
    return {
      listResourcesChecked,
      // Stubbed for findDdbOnlyCorrectiveTargets's type-check call sites
      // and any incidental getResource use outside applyMarkerEdit.
      getResource: jest.fn().mockResolvedValue(null),
    } as unknown as RegistryService;
  }

  it("exits 0 when every record resolves cleanly (no needsReapproval, no errors)", async () => {
    const registry = makeRegistry([
      {
        recordId: "synthetic-rec-10",
        name: "synthetic-agent-10",
        orgId: ALL_ORGS,
      },
    ]);
    applyMarkerEdit.mockResolvedValue({
      recordId: "synthetic-rec-10",
      priorStatus: "APPROVED",
      postStatus: "APPROVED",
      reapproved: true,
      error: undefined,
    });
    const docClient = makeConvergingDocClient({
      agentId: "synthetic-rec-10",
      orgUnknown: true,
      registryStatus: "APPROVED",
    });

    await runCorrectiveMode(
      registry,
      docClient,
      "agent-table",
      "tool-table",
      "projects-table",
      /* apply */ true,
      /* limit */ undefined,
      /* recordId */ undefined,
      1000,
      undefined,
      0,
      undefined,
      5000,
      1000,
      fastClock(),
      evidencePath,
    );

    expect(exitSpy).not.toHaveBeenCalled();
  });

  it("runs the end-of-run re-approval pass for a flagged record and exits 0 when the pass restores it", async () => {
    const registry = makeRegistry([
      {
        recordId: "synthetic-rec-11",
        name: "synthetic-agent-11",
        orgId: ALL_ORGS,
      },
    ]);
    // applyCorrectiveEntry's call into applyMarkerEdit reports the exact
    // incident shape: write landed, approval restoration failed.
    applyMarkerEdit.mockResolvedValue({
      recordId: "synthetic-rec-11",
      priorStatus: "APPROVED",
      postStatus: "DRAFT",
      reapproved: false,
      error: undefined,
    });
    (registry.getResource as jest.Mock)
      .mockResolvedValueOnce({
        recordId: "synthetic-rec-11",
        name: "synthetic-agent-11",
        status: "DRAFT",
        customDescriptorContent: JSON.stringify({ orgId: ALL_ORGS }),
      })
      .mockResolvedValueOnce({
        recordId: "synthetic-rec-11",
        name: "synthetic-agent-11",
        status: "APPROVED",
        customDescriptorContent: JSON.stringify({ orgId: ALL_ORGS }),
      });
    (
      registry as unknown as { submitForApproval: jest.Mock }
    ).submitForApproval = jest.fn().mockResolvedValue({
      recordId: "synthetic-rec-11",
      status: "PENDING_APPROVAL",
    });
    (
      registry as unknown as { updateResourceStatus: jest.Mock }
    ).updateResourceStatus = jest.fn().mockResolvedValue({
      recordId: "synthetic-rec-11",
      status: "APPROVED",
    });
    const docClient = makeConvergingDocClient({
      agentId: "synthetic-rec-11",
      orgUnknown: true,
      registryStatus: "APPROVED",
    });

    await runCorrectiveMode(
      registry,
      docClient,
      "agent-table",
      "tool-table",
      "projects-table",
      /* apply */ true,
      /* limit */ undefined,
      /* recordId */ undefined,
      1000,
      undefined,
      0,
      undefined,
      5000,
      1000,
      fastClock(),
      evidencePath,
    );
    expect(
      (registry as unknown as { submitForApproval: jest.Mock })
        .submitForApproval,
    ).toHaveBeenCalledWith("synthetic-rec-11");
    expect(
      (registry as unknown as { updateResourceStatus: jest.Mock })
        .updateResourceStatus,
    ).toHaveBeenCalled();
  });

  it("exits 1 when the end-of-run re-approval pass cannot restore a flagged record", async () => {
    const registry = makeRegistry([
      {
        recordId: "synthetic-rec-12",
        name: "synthetic-agent-12",
        orgId: ALL_ORGS,
      },
    ]);
    applyMarkerEdit.mockResolvedValue({
      recordId: "synthetic-rec-12",
      priorStatus: "APPROVED",
      postStatus: "DRAFT",
      reapproved: false,
      error: undefined,
    });
    (registry.getResource as jest.Mock).mockResolvedValue({
      recordId: "synthetic-rec-12",
      name: "synthetic-agent-12",
      status: "DRAFT",
      customDescriptorContent: JSON.stringify({ orgId: ALL_ORGS }),
    });
    (
      registry as unknown as { submitForApproval: jest.Mock }
    ).submitForApproval = jest.fn().mockRejectedValue(
      Object.assign(new Error("Request rate exceeded."), {
        name: "ThrottlingException",
      }),
    );
    const docClient = makeConvergingDocClient({
      agentId: "synthetic-rec-12",
      orgUnknown: true,
      registryStatus: "APPROVED",
    });

    await expect(
      runCorrectiveMode(
        registry,
        docClient,
        "agent-table",
        "tool-table",
        "projects-table",
        /* apply */ true,
        /* limit */ undefined,
        /* recordId */ undefined,
        1000,
        undefined,
        0,
        undefined,
        5000,
        1000,
        fastClock(),
        evidencePath,
      ),
    ).rejects.toThrow("process.exit(1)");

    expect(exitSpy).toHaveBeenCalledWith(1);
  });

  it("does not attempt the end-of-run re-approval pass in dry-run mode (nothing to restore)", async () => {
    const registry = makeRegistry([
      {
        recordId: "synthetic-rec-13",
        name: "synthetic-agent-13",
        orgId: ALL_ORGS,
      },
    ]);
    const submitForApproval = jest.fn();
    (
      registry as unknown as { submitForApproval: jest.Mock }
    ).submitForApproval = submitForApproval;
    const docClient = makeDocClient();

    await runCorrectiveMode(
      registry,
      docClient,
      "agent-table",
      "tool-table",
      "projects-table",
      /* apply */ false,
      /* limit */ undefined,
      /* recordId */ undefined,
    );

    expect(exitSpy).not.toHaveBeenCalled();
    expect(submitForApproval).not.toHaveBeenCalled();
    // Dry-run never writes, so applyMarkerEdit (via applyCorrectiveEntry)
    // is never reached either.
    expect(applyMarkerEdit).not.toHaveBeenCalled();
  });
});

// ---------------------------------------------------------------------------
// 26. resyncProjectionForId / resyncProjectionIds — rebuild a DDB projection
//     row from the registry through registry-sync's OWN mapper/writer
//     (Required change 2).
// ---------------------------------------------------------------------------

describe("resyncProjectionForId — rebuilds the projection row via registry-sync's own mapper/writer", () => {
  function fakeDocClient(sendImpl: jest.Mock) {
    return {
      send: sendImpl,
    } as unknown as import("@aws-sdk/lib-dynamodb").DynamoDBDocumentClient;
  }

  it("plans a rebuild when orgId differs (state/registryStatus/orgUnknown all matching otherwise)", async () => {
    const record = {
      recordId: "synthetic-resync-orgid-diff",
      name: "synthetic-agent-resync-orgid-diff",
      status: "APPROVED",
      customDescriptorContent: JSON.stringify({
        orgId: "SyntheticOrgNew",
        createdBy: "fabricator",
      }),
      createdAt: new Date("2026-01-01T00:00:00.000Z"),
      updatedAt: new Date("2026-01-02T00:00:00.000Z"),
    };
    const registry = {
      getResource: jest.fn().mockResolvedValue(record),
    } as unknown as RegistryService;
    const send = jest.fn().mockResolvedValue({
      Item: {
        agentId: "synthetic-resync-orgid-diff",
        orgId: "SyntheticOrgOld",
        orgUnknown: undefined,
        registryStatus: "APPROVED",
        state: "active",
      },
    });
    const docClient = fakeDocClient(send);

    const result = await resyncProjectionForId(
      "synthetic-resync-orgid-diff",
      "agent",
      registry,
      docClient,
      "agent-table",
      /* apply */ false,
    );

    expect(result.alreadyMatches).toBeUndefined();
    expect(result.wouldRebuild).toBe(true);
    expect(result.error).toBeUndefined();
    expect(send).toHaveBeenCalledTimes(1);
  });

  it("is a no-op (alreadyMatches) when the current row already matches the mapper's output", async () => {
    const record = {
      recordId: "synthetic-resync-1",
      name: "synthetic-agent-resync",
      status: "APPROVED",
      customDescriptorContent: JSON.stringify({
        orgId: "SyntheticOrg",
        createdBy: "fabricator",
      }),
      createdAt: new Date("2026-01-01T00:00:00.000Z"),
      updatedAt: new Date("2026-01-02T00:00:00.000Z"),
    };
    const registry = {
      getResource: jest.fn().mockResolvedValue(record),
    } as unknown as RegistryService;
    const send = jest.fn().mockResolvedValue({
      Item: {
        agentId: "synthetic-resync-1",
        orgId: "SyntheticOrg",
        orgUnknown: undefined,
        registryStatus: "APPROVED",
        state: "active",
      },
    });
    const docClient = fakeDocClient(send);

    const result = await resyncProjectionForId(
      "synthetic-resync-1",
      "agent",
      registry,
      docClient,
      "agent-table",
      /* apply */ false,
    );

    expect(result.alreadyMatches).toBe(true);
    expect(result.error).toBeUndefined();
    // Only the read happened — no write attempted for a no-op.
    expect(send).toHaveBeenCalledTimes(1);
  });

  it("plans a rebuild (never alreadyMatches) when orgId/orgUnknown/registryStatus all match but state diverges — the live incident shape (registryStatus APPROVED, state inactive, left by an earlier buggy rebuild)", async () => {
    const record = {
      recordId: "synthetic-resync-state-mismatch",
      name: "synthetic-agent-resync-state-mismatch",
      status: "APPROVED",
      customDescriptorContent: JSON.stringify({
        orgId: "SyntheticOrg",
        createdBy: "fabricator",
      }),
      createdAt: new Date("2026-01-01T00:00:00.000Z"),
      updatedAt: new Date("2026-01-02T00:00:00.000Z"),
    };
    const registry = {
      getResource: jest.fn().mockResolvedValue(record),
    } as unknown as RegistryService;
    const send = jest.fn().mockResolvedValue({
      Item: {
        agentId: "synthetic-resync-state-mismatch",
        orgId: "SyntheticOrg",
        orgUnknown: undefined,
        registryStatus: "APPROVED",
        // Left behind by the earlier buggy rebuild: status says APPROVED
        // but state was never flipped to active.
        state: "inactive",
      },
    });
    const docClient = fakeDocClient(send);

    const result = await resyncProjectionForId(
      "synthetic-resync-state-mismatch",
      "agent",
      registry,
      docClient,
      "agent-table",
      /* apply */ false,
    );

    expect(result.alreadyMatches).toBeUndefined();
    expect(result.wouldRebuild).toBe(true);
    expect(result.error).toBeUndefined();
    // No write on a dry run.
    expect(send).toHaveBeenCalledTimes(1);
  });

  it("prints the differing field names (including state) in the PLAN log line when state diverges", async () => {
    const record = {
      recordId: "synthetic-resync-state-diff-log",
      name: "synthetic-agent-resync-state-diff-log",
      status: "APPROVED",
      customDescriptorContent: JSON.stringify({
        orgId: "SyntheticOrg",
        createdBy: "fabricator",
      }),
      createdAt: new Date("2026-01-01T00:00:00.000Z"),
      updatedAt: new Date("2026-01-02T00:00:00.000Z"),
    };
    const registry = {
      getResource: jest.fn().mockResolvedValue(record),
    } as unknown as RegistryService;
    const send = jest.fn().mockResolvedValue({
      Item: {
        agentId: "synthetic-resync-state-diff-log",
        orgId: "SyntheticOrg",
        orgUnknown: undefined,
        registryStatus: "APPROVED",
        state: "inactive",
      },
    });
    const docClient = fakeDocClient(send);
    const logSpy = jest.spyOn(console, "log").mockImplementation(() => {});

    try {
      await resyncProjectionForId(
        "synthetic-resync-state-diff-log",
        "agent",
        registry,
        docClient,
        "agent-table",
        /* apply */ false,
      );

      const planLine = logSpy.mock.calls
        .map((args) => args.join(" "))
        .find((line) => line.includes("PLAN"));
      expect(planLine).toBeDefined();
      expect(planLine).toContain("state");
      // Should not falsely claim orgId/registryStatus differ when they match.
      expect(planLine).toMatch(/diff.*state/i);
    } finally {
      logSpy.mockRestore();
    }
  });

  it("still reports alreadyMatches (true no-op) when orgId, orgUnknown, registryStatus, AND state all match", async () => {
    const record = {
      recordId: "synthetic-resync-full-match",
      name: "synthetic-agent-resync-full-match",
      status: "APPROVED",
      customDescriptorContent: JSON.stringify({
        orgId: "SyntheticOrg",
        createdBy: "fabricator",
      }),
      createdAt: new Date("2026-01-01T00:00:00.000Z"),
      updatedAt: new Date("2026-01-02T00:00:00.000Z"),
    };
    const registry = {
      getResource: jest.fn().mockResolvedValue(record),
    } as unknown as RegistryService;
    const send = jest.fn().mockResolvedValue({
      Item: {
        agentId: "synthetic-resync-full-match",
        orgId: "SyntheticOrg",
        orgUnknown: undefined,
        registryStatus: "APPROVED",
        state: "active",
      },
    });
    const docClient = fakeDocClient(send);

    const result = await resyncProjectionForId(
      "synthetic-resync-full-match",
      "agent",
      registry,
      docClient,
      "agent-table",
      /* apply */ false,
    );

    expect(result.alreadyMatches).toBe(true);
    expect(result.wouldRebuild).toBeUndefined();
    expect(result.error).toBeUndefined();
    expect(send).toHaveBeenCalledTimes(1);
  });

  it("dry-run (apply=false) reports wouldRebuild and never writes when the row diverges", async () => {
    const record = {
      recordId: "synthetic-resync-2",
      name: "synthetic-agent-resync-2",
      status: "APPROVED",
      customDescriptorContent: JSON.stringify({
        orgId: "SyntheticOrg",
        createdBy: "fabricator",
      }),
      createdAt: new Date("2026-01-01T00:00:00.000Z"),
      updatedAt: new Date("2026-01-02T00:00:00.000Z"),
    };
    const registry = {
      getResource: jest.fn().mockResolvedValue(record),
    } as unknown as RegistryService;
    const send = jest.fn().mockResolvedValue({
      Item: {
        agentId: "synthetic-resync-2",
        registryStatus: "PENDING_APPROVAL",
        orgId: "SyntheticOrg",
      },
    });
    const docClient = fakeDocClient(send);

    const result = await resyncProjectionForId(
      "synthetic-resync-2",
      "agent",
      registry,
      docClient,
      "agent-table",
      /* apply */ false,
    );

    expect(result.wouldRebuild).toBe(true);
    expect(result.error).toBeUndefined();
    // Dry-run: only the read happened.
    expect(send).toHaveBeenCalledTimes(1);
  });

  it("apply=true rebuilds the row through writeProjectionRow (the shared registry-sync writer), setting registry-sync's own ordering/version fields", async () => {
    const record = {
      recordId: "synthetic-resync-3",
      name: "synthetic-agent-resync-3",
      status: "APPROVED",
      customDescriptorContent: JSON.stringify({
        orgId: "SyntheticOrg",
        createdBy: "fabricator",
      }),
      createdAt: new Date("2026-01-01T00:00:00.000Z"),
      updatedAt: new Date("2026-01-02T00:00:00.000Z"),
    };
    const registry = {
      getResource: jest.fn().mockResolvedValue(record),
    } as unknown as RegistryService;
    const send = jest.fn().mockImplementation((command) => {
      const ctorName = command?.constructor?.name;
      if (ctorName === "GetCommand") {
        return Promise.resolve({
          Item: {
            agentId: "synthetic-resync-3",
            registryStatus: "PENDING_APPROVAL",
            orgId: "SyntheticOrg",
          },
        });
      }
      return Promise.resolve({});
    });
    const docClient = fakeDocClient(send);

    const result = await resyncProjectionForId(
      "synthetic-resync-3",
      "agent",
      registry,
      docClient,
      "agent-table",
      /* apply */ true,
    );

    expect(result.rebuilt).toBe(true);
    expect(result.error).toBeUndefined();

    const updateCall = send.mock.calls.find(
      ([command]) => command?.constructor?.name === "UpdateCommand",
    );
    expect(updateCall).toBeDefined();
    const [updateCommand] = updateCall!;
    expect(updateCommand.input.TableName).toBe("agent-table");
    expect(updateCommand.input.Key).toEqual({ agentId: "synthetic-resync-3" });
    // The rebuilt row carries registry-sync's own ordering/version fields
    // (projectionVersion, projectedAt, registryStatus) — produced by
    // buildAgentProjectionRow, the SAME mapper the live lambda uses.
    const values = updateCommand.input.ExpressionAttributeValues as Record<
      string,
      unknown
    >;
    const names = updateCommand.input.ExpressionAttributeNames as Record<
      string,
      string
    >;
    const projectionVersionKey = Object.keys(names).find(
      (k) => names[k] === "projectionVersion",
    );
    expect(projectionVersionKey).toBeDefined();
    expect(values[`:${projectionVersionKey!.slice(1)}`]).toBe(1);
  });

  it("apply=true succeeds for a fabricated agent with no appId (writeProjectionRow must never bind an undefined ExpressionAttributeValue)", async () => {
    // Fabricated agents never carry an appId in their descriptor — this is
    // exactly the live shape that --resync-projection --apply hit.
    const record = {
      recordId: "synthetic-resync-no-appid",
      name: "synthetic-fabricated-agent",
      status: "APPROVED",
      customDescriptorContent: JSON.stringify({
        orgId: "SyntheticOrg",
        createdBy: "fabricator",
        // appId intentionally absent.
      }),
      createdAt: new Date("2026-01-01T00:00:00.000Z"),
      updatedAt: new Date("2026-01-02T00:00:00.000Z"),
    };
    const registry = {
      getResource: jest.fn().mockResolvedValue(record),
    } as unknown as RegistryService;
    // Mimics the real DynamoDBDocumentClient: it throws when any bound
    // ExpressionAttributeValue is `undefined`, which is the exact failure
    // mode `--resync-projection --apply` hit against live DynamoDB before
    // the fix.
    const send = jest.fn().mockImplementation((command) => {
      const ctorName = command?.constructor?.name;
      if (ctorName === "GetCommand") {
        return Promise.resolve({
          Item: {
            agentId: "synthetic-resync-no-appid",
            registryStatus: "PENDING_APPROVAL",
            orgId: "SyntheticOrg",
          },
        });
      }
      if (ctorName === "UpdateCommand") {
        const values = command.input.ExpressionAttributeValues as Record<
          string,
          unknown
        >;
        for (const [key, value] of Object.entries(values ?? {})) {
          if (value === undefined) {
            throw new Error(
              `ExpressionAttributeValues contains undefined for ${key}`,
            );
          }
        }
      }
      return Promise.resolve({});
    });
    const docClient = fakeDocClient(send);

    const result = await resyncProjectionForId(
      "synthetic-resync-no-appid",
      "agent",
      registry,
      docClient,
      "agent-table",
      /* apply */ true,
    );

    expect(result.error).toBeUndefined();
    expect(result.rebuilt).toBe(true);

    const updateCall = send.mock.calls.find(
      ([command]) => command?.constructor?.name === "UpdateCommand",
    );
    expect(updateCall).toBeDefined();
    const [updateCommand] = updateCall!;
    const names = updateCommand.input.ExpressionAttributeNames as Record<
      string,
      string
    >;
    expect(Object.values(names)).not.toContain("appId");
  });

  it("surfaces a getResource failure as error with recordNotFoundOrWrongType, letting the caller retry as the other kind", async () => {
    const registry = {
      getResource: jest.fn().mockRejectedValue(new Error("TypeMismatchError")),
    } as unknown as RegistryService;
    const docClient = fakeDocClient(jest.fn());

    const result = await resyncProjectionForId(
      "synthetic-resync-4",
      "agent",
      registry,
      docClient,
      "agent-table",
      false,
    );

    expect(result.error).toBeDefined();
    expect(result.recordNotFoundOrWrongType).toBe(true);
  });
});

describe("resyncProjectionIds — --resync-projection CLI, agent-then-tool retry", () => {
  it("retries as a tool when the agent attempt fails with recordNotFoundOrWrongType, and succeeds", async () => {
    const toolRecord = {
      recordId: "synthetic-resync-5",
      name: "synthetic-tool-resync",
      status: "APPROVED",
      customDescriptorContent: JSON.stringify({
        orgId: "SyntheticOrg",
        createdBy: "fabricator",
      }),
      createdAt: new Date("2026-01-01T00:00:00.000Z"),
      updatedAt: new Date("2026-01-02T00:00:00.000Z"),
    };
    const getResource = jest
      .fn()
      .mockRejectedValueOnce(new Error("TypeMismatchError"))
      .mockResolvedValueOnce(toolRecord);
    const registry = { getResource } as unknown as RegistryService;
    const send = jest.fn().mockResolvedValue({
      Item: {
        toolId: "synthetic-resync-5",
        registryStatus: "PENDING_APPROVAL",
      },
    });
    const docClient = {
      send,
    } as unknown as import("@aws-sdk/lib-dynamodb").DynamoDBDocumentClient;

    const results = await resyncProjectionIds(
      ["synthetic-resync-5"],
      registry,
      docClient,
      "agent-table",
      "tool-table",
      false,
    );

    expect(results).toHaveLength(1);
    expect(results[0].type).toBe("tool");
    expect(results[0].wouldRebuild).toBe(true);
    expect(getResource).toHaveBeenCalledTimes(2);
  });
});

// ---------------------------------------------------------------------------
// 27. End-of-run resync pass (Required change 1 + 2) and the exact incident 2
//     race: registry succeeds, script's OWN direct DDB write would have
//     ConditionalCheckFailedException'd — but under the fix there is no
//     direct DDB write on the registry-backed path at all, so the race
//     cannot occur there; the DDB-only drift path still treats
//     ConditionalCheckFailedException + desired-state as success.
// ---------------------------------------------------------------------------

describe("runCorrectiveMode — end-of-run resync pass for projectionLag (Required change 1 + 2)", () => {
  const { applyMarkerEdit } = jest.requireMock(
    "../../src/utils/marker-registry-edit",
  ) as { applyMarkerEdit: jest.Mock };

  let exitSpy: jest.SpyInstance;
  let tmpDir: string;
  let evidencePath: string;

  beforeEach(() => {
    applyMarkerEdit.mockReset();
    exitSpy = jest.spyOn(process, "exit").mockImplementation(((
      code?: number,
    ) => {
      throw new Error(`process.exit(${code})`);
    }) as never);
    const os = jest.requireActual("os") as typeof import("os");
    const path = jest.requireActual("path") as typeof import("path");
    const fs = jest.requireActual("fs") as typeof import("fs");
    tmpDir = fs.mkdtempSync(path.join(os.tmpdir(), "evidence-resync-test-"));
    evidencePath = path.join(tmpDir, "evidence.json");
  });

  afterEach(() => {
    exitSpy.mockRestore();
    const fs = jest.requireActual("fs") as typeof import("fs");
    fs.rmSync(tmpDir, { recursive: true, force: true });
  });

  function makeRegistry(
    items: Array<{ recordId: string; name: string; orgId: string }>,
    detailRecord?: Record<string, unknown>,
  ): RegistryService {
    const listResourcesChecked = jest.fn().mockImplementation((type: string) =>
      Promise.resolve({
        items:
          type === "agent"
            ? items.map((i) => ({
                recordId: i.recordId,
                name: i.name,
                status: "APPROVED",
                customDescriptorContent: JSON.stringify({
                  orgId: i.orgId,
                  createdBy: "fabricator",
                  sourceProjectId: "proj-synthetic",
                }),
              }))
            : [],
        partial: false,
        droppedCount: 0,
        throttled: false,
      }),
    );
    return {
      listResourcesChecked,
      getResource: jest.fn().mockResolvedValue(detailRecord ?? null),
    } as unknown as RegistryService;
  }

  it("resyncs a projectionLag record at end-of-run and exits 0 once it converges", async () => {
    const registry = makeRegistry(
      [
        {
          recordId: "synthetic-rec-20",
          name: "synthetic-agent-20",
          orgId: ALL_ORGS,
        },
      ],
      {
        recordId: "synthetic-rec-20",
        name: "synthetic-agent-20",
        status: "APPROVED",
        customDescriptorContent: JSON.stringify({
          orgUnknown: true,
          createdBy: "fabricator",
        }),
        createdAt: new Date("2026-01-01T00:00:00.000Z"),
        updatedAt: new Date("2026-01-02T00:00:00.000Z"),
      },
    );
    applyMarkerEdit.mockResolvedValue({
      recordId: "synthetic-rec-20",
      priorStatus: "APPROVED",
      postStatus: "APPROVED",
      reapproved: true,
      error: undefined,
    });

    // The projection poll NEVER converges during the bounded wait (always
    // reports the stale pre-edit row) — this forces projectionLag — but
    // the end-of-run resync pass's resyncProjectionForId then SUCCEEDS
    // (via registry.getResource + writeProjectionRow), converging it.
    const send = jest.fn().mockImplementation((command) => {
      const ctorName = command?.constructor?.name;
      if (ctorName === "GetCommand") {
        return Promise.resolve({
          Item: {
            agentId: "synthetic-rec-20",
            orgId: ALL_ORGS,
            registryStatus: "APPROVED",
          },
        });
      }
      return Promise.resolve({ Items: [] });
    });
    const docClient = {
      send,
    } as unknown as import("@aws-sdk/lib-dynamodb").DynamoDBDocumentClient;

    await runCorrectiveMode(
      registry,
      docClient,
      "agent-table",
      "tool-table",
      "projects-table",
      /* apply */ true,
      /* limit */ undefined,
      /* recordId */ undefined,
      1000,
      undefined,
      0,
      undefined,
      3000,
      1000,
      fastClock(),
      evidencePath,
    );

    expect(exitSpy).not.toHaveBeenCalled();
  });

  it("exits 1 when a projectionLag record is still unconverged after the end-of-run resync pass", async () => {
    const registry = makeRegistry(
      [
        {
          recordId: "synthetic-rec-21",
          name: "synthetic-agent-21",
          orgId: ALL_ORGS,
        },
      ],
      null as unknown as Record<string, unknown>,
    );
    // getResource returns null -> resyncProjectionForId reports an error,
    // so the end-of-run pass cannot converge the record either.
    (registry.getResource as jest.Mock).mockResolvedValue(null);
    applyMarkerEdit.mockResolvedValue({
      recordId: "synthetic-rec-21",
      priorStatus: "APPROVED",
      postStatus: "APPROVED",
      reapproved: true,
      error: undefined,
    });
    const send = jest.fn().mockResolvedValue({ Items: [] }); // GetCommand -> no Item -> never converges
    const docClient = {
      send,
    } as unknown as import("@aws-sdk/lib-dynamodb").DynamoDBDocumentClient;

    await expect(
      runCorrectiveMode(
        registry,
        docClient,
        "agent-table",
        "tool-table",
        "projects-table",
        /* apply */ true,
        /* limit */ undefined,
        /* recordId */ undefined,
        1000,
        undefined,
        0,
        undefined,
        3000,
        1000,
        fastClock(),
        evidencePath,
      ),
    ).rejects.toThrow("process.exit(1)");

    expect(exitSpy).toHaveBeenCalledWith(1);
  });
});

// ---------------------------------------------------------------------------
// 28. Incident 2 exact failure signature (see board-task spec, item 1):
//     registry write lands (orgId corrected, APPROVED), but under the OLD
//     behaviour the script's OWN direct DDB UpdateItem then raced
//     registry-sync's projection and threw ConditionalCheckFailedException
//     even though the end state was already correct. Under the fix, the
//     registry-backed corrective path performs NO direct DDB write at
//     all, so this exact race class cannot occur there — this test
//     documents that invariant directly against applyCorrectiveEntry.
// ---------------------------------------------------------------------------

describe("Incident 2 regression — registry-backed path never races registry-sync's own projection write", () => {
  const { applyMarkerEdit } = jest.requireMock(
    "../../src/utils/marker-registry-edit",
  ) as { applyMarkerEdit: jest.Mock };

  beforeEach(() => {
    applyMarkerEdit.mockReset();
  });

  it("never issues a docClient UpdateCommand for a registry-backed corrective entry, even when the registry write succeeds and the projection later converges via registry-sync", async () => {
    applyMarkerEdit.mockResolvedValue({
      recordId: "agent-fixture-02",
      priorStatus: "APPROVED",
    });
    // Simulates registry-sync's OWN concurrent projection write already
    // having landed the correct value by the time the script polls —
    // exactly the incident scenario, but now observed via a read-only
    // poll instead of raced against a competing write from this script.
    const send = jest.fn().mockResolvedValue({
      Item: {
        agentId: "agent-fixture-02",
        orgId: "SyntheticOrg",
        registryStatus: "APPROVED",
      },
    });
    const docClient = {
      send,
    } as unknown as import("@aws-sdk/lib-dynamodb").DynamoDBDocumentClient;
    const entry = {
      id: "agent-fixture-02",
      name: "synthetic-fabricated-agent",
      kind: "agent" as const,
      previousOrgId: ALL_ORGS,
      resolvedOrgId: "SyntheticOrg",
      reason: "fabricator-agent-sourceProjectId",
    };

    const result = await applyCorrectiveEntry(
      entry,
      "agent",
      {} as unknown as RegistryService,
      "agent-table",
      docClient,
      0,
      undefined,
      60000,
      1000,
      fastClock(),
    );

    expect(result.error).toBeUndefined();
    expect(result.projectionLag).toBeFalsy();
    // The defining assertion: NOT ONE send() call is an UpdateCommand —
    // every call is a read (GetCommand) poll. A ConditionalCheckFailed
    // race against registry-sync's own write is structurally impossible
    // here because this path never writes DDB.
    for (const [command] of send.mock.calls) {
      expect(command.input.UpdateExpression).toBeUndefined();
    }
  });
});

// ---------------------------------------------------------------------------
// 26. --restore-approval now requires --prior-status-evidence (finding
//     d202861e): the flag previously submitted+approved any id
//     unconditionally. It must now refuse unless the id is present in an
//     operator-supplied sidecar evidence file with priorStatus APPROVED —
//     and every APPLY run of corrective mode must WRITE that sidecar so
//     evidence exists to check against.
// ---------------------------------------------------------------------------

describe("writeRunEvidence — sidecar JSON written by corrective APPLY runs", () => {
  it("serialises runId, mode, and needsReapproval entries with id/kind/priorStatus", async () => {
    const { writeRunEvidence } = jest.requireActual(
      "../backfill-shared-org-marker",
    ) as typeof import("../backfill-shared-org-marker");
    const os = jest.requireActual("os") as typeof import("os");
    const path = jest.requireActual("path") as typeof import("path");
    const fs = jest.requireActual("fs") as typeof import("fs");

    const dir = fs.mkdtempSync(path.join(os.tmpdir(), "evidence-test-"));
    const outPath = path.join(dir, "evidence.json");

    writeRunEvidence(outPath, {
      runId: "run-synthetic-0001",
      mode: "APPLY",
      needsReapproval: [
        { id: "tool-0001", kind: "tool", priorStatus: "APPROVED" },
        { id: "agent-0002", kind: "agent", priorStatus: "APPROVED" },
      ],
    });

    const written = JSON.parse(fs.readFileSync(outPath, "utf8"));
    expect(written.runId).toBe("run-synthetic-0001");
    expect(written.mode).toBe("APPLY");
    expect(written.needsReapproval).toEqual([
      { id: "tool-0001", kind: "tool", priorStatus: "APPROVED" },
      { id: "agent-0002", kind: "agent", priorStatus: "APPROVED" },
    ]);

    fs.rmSync(dir, { recursive: true, force: true });
  });

  it("writes atomically — no partial file is left if the write target directory does not exist", () => {
    const { writeRunEvidence } = jest.requireActual(
      "../backfill-shared-org-marker",
    ) as typeof import("../backfill-shared-org-marker");

    expect(() =>
      writeRunEvidence("/nonexistent-dir-synthetic/evidence.json", {
        runId: "run-synthetic-0002",
        mode: "APPLY",
        needsReapproval: [],
      }),
    ).toThrow();
  });
});

describe("runCorrectiveMode — writes the evidence sidecar on an APPLY run", () => {
  const { applyMarkerEdit } = jest.requireMock(
    "../../src/utils/marker-registry-edit",
  ) as { applyMarkerEdit: jest.Mock };

  let exitSpy: jest.SpyInstance;
  let tmpDir: string;
  let evidencePath: string;

  beforeEach(() => {
    applyMarkerEdit.mockReset();
    exitSpy = jest.spyOn(process, "exit").mockImplementation(((
      code?: number,
    ) => {
      throw new Error(`process.exit(${code})`);
    }) as never);
    const os = jest.requireActual("os") as typeof import("os");
    const path = jest.requireActual("path") as typeof import("path");
    const fs = jest.requireActual("fs") as typeof import("fs");
    tmpDir = fs.mkdtempSync(path.join(os.tmpdir(), "evidence-apply-test-"));
    evidencePath = path.join(tmpDir, "evidence.json");
  });

  afterEach(() => {
    exitSpy.mockRestore();
    const fs = jest.requireActual("fs") as typeof import("fs");
    fs.rmSync(tmpDir, { recursive: true, force: true });
  });

  function makeDocClient(
    convergedItem: Record<string, unknown>,
  ): import("@aws-sdk/lib-dynamodb").DynamoDBDocumentClient {
    const send = jest.fn().mockImplementation((command) => {
      const ctorName = command?.constructor?.name;
      if (ctorName === "GetCommand") {
        return Promise.resolve({ Item: convergedItem });
      }
      return Promise.resolve({ Items: [] });
    });
    return {
      send,
    } as unknown as import("@aws-sdk/lib-dynamodb").DynamoDBDocumentClient;
  }

  function makeRegistry(
    items: Array<{ recordId: string; name: string; orgId: string }>,
  ): RegistryService {
    const listResourcesChecked = jest.fn().mockImplementation((type: string) =>
      Promise.resolve({
        items:
          type === "agent"
            ? items.map((i) => ({
                recordId: i.recordId,
                name: i.name,
                status: "APPROVED",
                customDescriptorContent: JSON.stringify({
                  orgId: i.orgId,
                  createdBy: "fabricator",
                  sourceProjectId: "proj-synthetic",
                }),
              }))
            : [],
        partial: false,
        droppedCount: 0,
        throttled: false,
      }),
    );
    return {
      listResourcesChecked,
      getResource: jest.fn().mockResolvedValue(null),
    } as unknown as RegistryService;
  }

  it("writes a sidecar containing the record left needsReapproval, after the end-of-run pass still fails to restore it", async () => {
    const registry = makeRegistry([
      {
        recordId: "tool-0001",
        name: "synthetic-tool-01",
        orgId: ALL_ORGS,
      },
    ]);
    // Write lands (DRAFT) but the end-of-run restoration also fails every
    // time, so the record stays in needsReapproval and must appear in the
    // sidecar for an operator to later use with --restore-approval.
    applyMarkerEdit.mockResolvedValue({
      recordId: "tool-0001",
      priorStatus: "APPROVED",
      postStatus: "DRAFT",
      reapproved: false,
      error: undefined,
    });
    (registry.getResource as jest.Mock).mockResolvedValue({
      recordId: "tool-0001",
      name: "synthetic-tool-01",
      status: "DRAFT",
      customDescriptorContent: JSON.stringify({ orgId: ALL_ORGS }),
    });
    const docClient = makeDocClient({
      toolId: "tool-0001",
      orgId: "SyntheticOrg",
      registryStatus: "APPROVED",
    });

    await expect(
      runCorrectiveMode(
        registry,
        docClient,
        "agent-table",
        "tool-table",
        "projects-table",
        /* apply */ true,
        undefined,
        undefined,
        1000,
        undefined,
        0,
        undefined,
        5000,
        1000,
        fastClock(),
        evidencePath,
      ),
    ).rejects.toThrow("process.exit(1)");

    const fs = jest.requireActual("fs") as typeof import("fs");
    const written = JSON.parse(fs.readFileSync(evidencePath, "utf8"));
    expect(written.mode).toBe("APPLY");
    expect(written.needsReapproval).toEqual(
      expect.arrayContaining([
        expect.objectContaining({
          id: "tool-0001",
          kind: "agent",
          priorStatus: "APPROVED",
        }),
      ]),
    );
  });

  it("DRY-RUN mode does not write the sidecar (no apply occurred, nothing to attest)", async () => {
    const registry = makeRegistry([
      {
        recordId: "tool-0002",
        name: "synthetic-tool-02",
        orgId: ALL_ORGS,
      },
    ]);

    await runCorrectiveMode(
      registry,
      makeDocClient({}),
      "agent-table",
      "tool-table",
      "projects-table",
      /* apply */ false,
      undefined,
      undefined,
      1000,
      undefined,
      0,
      undefined,
      5000,
      1000,
      fastClock(),
      evidencePath,
    );

    const fs = jest.requireActual("fs") as typeof import("fs");
    expect(fs.existsSync(evidencePath)).toBe(false);
  });
});

describe("--restore-approval requires --prior-status-evidence (finding d202861e)", () => {
  let tmpDir: string;
  let evidencePath: string;
  let fs: typeof import("fs");
  let path: typeof import("path");

  beforeEach(() => {
    const os = jest.requireActual("os") as typeof import("os");
    fs = jest.requireActual("fs") as typeof import("fs");
    path = jest.requireActual("path") as typeof import("path");
    tmpDir = fs.mkdtempSync(path.join(os.tmpdir(), "restore-evidence-test-"));
    evidencePath = path.join(tmpDir, "evidence.json");
  });

  afterEach(() => {
    fs.rmSync(tmpDir, { recursive: true, force: true });
  });

  it("refuses and makes no registry calls when no evidence file is supplied", async () => {
    const { restoreApprovalForRecord, loadPriorStatusEvidence } =
      jest.requireActual(
        "../backfill-shared-org-marker",
      ) as typeof import("../backfill-shared-org-marker");

    expect(() => loadPriorStatusEvidence(undefined, "tool-0001")).toThrow(
      /--prior-status-evidence/,
    );
    // restoreApprovalForRecord itself is unreachable without evidence —
    // asserting the guard throws before any registry call would occur is
    // covered by the loadPriorStatusEvidence check above; this keeps
    // restoreApprovalForRecord's own contract (operate once evidence says
    // APPROVED) unchanged and tested separately below.
    void restoreApprovalForRecord;
  });

  it("refuses when the id is absent from the evidence file, naming the id, file, and 'absent'", () => {
    const { loadPriorStatusEvidence } = jest.requireActual(
      "../backfill-shared-org-marker",
    ) as typeof import("../backfill-shared-org-marker");
    fs.writeFileSync(
      evidencePath,
      JSON.stringify({
        runId: "run-synthetic-0003",
        mode: "APPLY",
        needsReapproval: [
          { id: "tool-9999", kind: "tool", priorStatus: "APPROVED" },
        ],
      }),
    );

    expect(() => loadPriorStatusEvidence(evidencePath, "tool-0001")).toThrow(
      /tool-0001/,
    );
    try {
      loadPriorStatusEvidence(evidencePath, "tool-0001");
    } catch (err) {
      expect(String(err)).toContain(evidencePath);
      expect(String(err)).toContain("absent");
    }
  });

  it("refuses when the id is present but priorStatus is not APPROVED, naming the found priorStatus", () => {
    const { loadPriorStatusEvidence } = jest.requireActual(
      "../backfill-shared-org-marker",
    ) as typeof import("../backfill-shared-org-marker");
    fs.writeFileSync(
      evidencePath,
      JSON.stringify({
        runId: "run-synthetic-0004",
        mode: "APPLY",
        needsReapproval: [
          { id: "tool-0001", kind: "tool", priorStatus: "DRAFT" },
        ],
      }),
    );

    expect(() => loadPriorStatusEvidence(evidencePath, "tool-0001")).toThrow(
      /DRAFT/,
    );
  });

  it("proceeds when the id is present with priorStatus APPROVED", () => {
    const { loadPriorStatusEvidence } = jest.requireActual(
      "../backfill-shared-org-marker",
    ) as typeof import("../backfill-shared-org-marker");
    fs.writeFileSync(
      evidencePath,
      JSON.stringify({
        runId: "run-synthetic-0005",
        mode: "APPLY",
        needsReapproval: [
          { id: "tool-0001", kind: "tool", priorStatus: "APPROVED" },
        ],
      }),
    );

    expect(() =>
      loadPriorStatusEvidence(evidencePath, "tool-0001"),
    ).not.toThrow();
  });

  it("main(): exits non-zero and never calls getResource/submitForApproval when evidence is missing for the restore id", async () => {
    jest.resetModules();
    const originalArgv = process.argv;
    const originalEnv = { ...process.env };
    const exitSpy = jest.spyOn(process, "exit").mockImplementation(((
      code?: number,
    ) => {
      throw new Error(`process.exit(${code})`);
    }) as never);

    process.env.REGISTRY_ID = "registry-synthetic";
    process.env.AGENT_CONFIG_TABLE = "agent-table-synthetic";
    process.env.TOOL_CONFIG_TABLE = "tool-table-synthetic";
    process.env.PROJECTS_TABLE = "projects-table-synthetic";
    process.argv = [
      "node",
      "backfill-shared-org-marker.ts",
      "--correct-fabricator-shared",
      "--restore-approval",
      "tool-0001",
    ];

    const getResourceMock = jest.fn();
    jest.doMock("../../src/services/registry-service", () => {
      const actual = jest.requireActual("../../src/services/registry-service");
      return {
        ...actual,
        RegistryService: jest.fn().mockImplementation(() => ({
          getResource: getResourceMock,
          submitForApproval: jest.fn(),
          updateResourceStatus: jest.fn(),
        })),
      };
    });

    const { main } = jest.requireActual(
      "../backfill-shared-org-marker",
    ) as typeof import("../backfill-shared-org-marker");

    await expect(main()).rejects.toThrow("process.exit(1)");
    expect(getResourceMock).not.toHaveBeenCalled();

    process.argv = originalArgv;
    process.env = originalEnv;
    exitSpy.mockRestore();
    jest.dontMock("../../src/services/registry-service");
    jest.resetModules();
  });
});

describe("restoreApprovalForRecord — already-APPROVED id with valid evidence is a no-op (finding d202861e)", () => {
  it("logs no-op and reports alreadyApproved without calling submitForApproval", async () => {
    const { restoreApprovalForRecord } = jest.requireActual(
      "../backfill-shared-org-marker",
    ) as typeof import("../backfill-shared-org-marker");

    const registry = {
      getResource: jest.fn().mockResolvedValue({
        recordId: "tool-0001",
        name: "synthetic-tool",
        status: "APPROVED",
        customDescriptorContent: JSON.stringify({ orgId: "SyntheticOrg" }),
      }),
      submitForApproval: jest.fn(),
      updateResourceStatus: jest.fn(),
    } as unknown as RegistryService;

    const result = await restoreApprovalForRecord(
      "tool-0001",
      "tool",
      registry,
      /* apply */ true,
    );

    expect(result.alreadyApproved).toBe(true);
    expect(registry.submitForApproval).not.toHaveBeenCalled();
    expect(registry.updateResourceStatus).not.toHaveBeenCalled();
  });
});

// ---------------------------------------------------------------------------
// 29. Test-hygiene guard: no `runCorrectiveMode` apply-mode test in this file
//     may write the default evidence sidecar into the package directory.
//     Every apply-mode call above now threads a tmpdir `evidencePath`
//     through to `runCorrectiveMode` instead of relying on
//     `DEFAULT_EVIDENCE_PATH` (`<cwd>/backfill-shared-org-marker.evidence.json`),
//     which previously left a stray untracked artifact in `backend/` after
//     every jest run. This test asserts the writer itself honours an
//     injected output path (already covered above) AND that the default
//     path is left untouched by this suite.
// ---------------------------------------------------------------------------

describe("test hygiene — evidence sidecar never lands in the package directory", () => {
  it("DEFAULT_EVIDENCE_PATH is not created as a side effect of this test suite", () => {
    const { DEFAULT_EVIDENCE_PATH } = jest.requireActual(
      "../backfill-shared-org-marker",
    ) as typeof import("../backfill-shared-org-marker");
    const fs = jest.requireActual("fs") as typeof import("fs");

    expect(fs.existsSync(DEFAULT_EVIDENCE_PATH)).toBe(false);
  });
});
