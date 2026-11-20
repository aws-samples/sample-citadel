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
  buildToolNameOrgIndex,
  applyCorrectiveEntry,
  runCorrectiveForRegistryType,
  reconcileDroppedRecords,
  type RecordShape,
  type OrgResolver,
  type AgentConfigLike,
} from "../backfill-shared-org-marker";
import type { RegistryService } from "../../src/services/registry-service";
import { ALL_ORGS } from "../../src/utils/org-constants";

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
      if (rec.name === "fetch_inbox_invoices") return "Default";
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
      name: "fetch_inbox_invoices",
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
      if (rec.name === "fetch_inbox_invoices") return "Default";
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
      name: "fetch_inbox_invoices",
      orgId: ALL_ORGS,
      createdBy: "fabricator",
    };
    const entry = planCorrectiveEntry(rec, "tool", orgResolver);
    expect(entry).toEqual({
      id: "t1",
      name: "fetch_inbox_invoices",
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
        config: JSON.stringify({ schema: { tools: ["fetch_inbox_invoices"] } }),
      },
    ];
    const index = buildToolNameOrgIndex(agents, resolveAgentOrg);
    expect(index.get("fetch_inbox_invoices")).toEqual(new Set(["Default"]));
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
      new Map([["fetch_inbox_invoices", new Set(["Default"])]]),
    );
    expect(
      resolver.resolveToolOrg({ id: "t1", name: "fetch_inbox_invoices" }),
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

describe("applyCorrectiveEntry — both-store write", () => {
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

  it("writes the resolved org to both the registry (via applyMarkerEdit) and the DDB row with a ConditionExpression on the previous value", async () => {
    applyMarkerEdit.mockResolvedValue({ recordId: "a1" });
    const send = jest.fn().mockResolvedValue({});
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

    expect(result.error).toBeUndefined();
    expect(applyMarkerEdit).toHaveBeenCalledWith(
      expect.objectContaining({
        recordId: "a1",
        type: "agent",
        fieldsToSet: { orgId: "Default" },
      }),
      expect.objectContaining({ dryRun: false }),
    );
    expect(send).toHaveBeenCalledTimes(1);
    const [command] = send.mock.calls[0];
    expect(command.input.TableName).toBe("agent-table");
    expect(command.input.Key).toEqual({ agentId: "a1" });
    expect(command.input.ConditionExpression).toBe("#orgId = :previousOrgId");
    expect(command.input.ExpressionAttributeValues[":previousOrgId"]).toBe(
      ALL_ORGS,
    );
    expect(command.input.ExpressionAttributeValues[":orgId"]).toBe("Default");
  });

  it("writes orgUnknown=true and removes orgId for an unresolvable entry, conditioned on the previous value", async () => {
    applyMarkerEdit.mockResolvedValue({ recordId: "t2" });
    const send = jest.fn().mockResolvedValue({});
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
    );

    expect(result.error).toBeUndefined();
    expect(applyMarkerEdit).toHaveBeenCalledWith(
      expect.objectContaining({
        recordId: "t2",
        type: "tool",
        fieldsToSet: { orgUnknown: true },
        fieldsToRemove: ["orgId"],
      }),
      expect.anything(),
    );
    const [command] = send.mock.calls[0];
    expect(command.input.TableName).toBe("tool-table");
    expect(command.input.Key).toEqual({ toolId: "t2" });
    expect(command.input.ConditionExpression).toBe("#orgId = :previousOrgId");
  });

  it("never writes to DDB for an ambiguous entry", async () => {
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

  it("propagates a registry marker-edit failure as an error and skips the DDB write", async () => {
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
    const send = jest.fn().mockResolvedValue({});
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
    );

    // Both records are planned (printed) ...
    expect(plan.map((e) => e.id).sort()).toEqual(["rec-1", "rec-2"]);
    // ... but only rec-1 was actually written to either store.
    expect(applyMarkerEdit).toHaveBeenCalledTimes(1);
    expect(applyMarkerEdit).toHaveBeenCalledWith(
      expect.objectContaining({ recordId: "rec-1" }),
      expect.anything(),
    );
    expect(send).toHaveBeenCalledTimes(1);
    expect(send.mock.calls[0][0].input.Key).toEqual({ agentId: "rec-1" });
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
    const send = jest.fn().mockResolvedValue({});
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
    );

    expect(applyMarkerEdit).toHaveBeenCalledTimes(2);
    expect(send).toHaveBeenCalledTimes(2);
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

    const send = jest.fn().mockResolvedValue({});
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
          agentId: "d3RXDPrgL9t5",
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
        id: "d3RXDPrgL9t5",
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

  it("applyCorrectiveEntry re-stamps both stores for a DDB-only divergent entry, converging the registry to match", async () => {
    applyMarkerEdit.mockResolvedValue({ recordId: "d3RXDPrgL9t5" });
    const send = jest.fn().mockResolvedValue({});
    const entry = {
      id: "d3RXDPrgL9t5",
      name: "divergent-agent",
      kind: "agent" as const,
      previousOrgId: "All Organizations",
      resolvedOrgId: "Default",
      reason: "fabricator-agent-sourceProjectId",
    };
    const docClient = {
      send,
    } as unknown as import("@aws-sdk/lib-dynamodb").DynamoDBDocumentClient;

    const result = await applyCorrectiveEntry(
      entry,
      "agent",
      {} as unknown as RegistryService,
      "agent-table",
      docClient,
    );

    expect(result.error).toBeUndefined();
    expect(applyMarkerEdit).toHaveBeenCalledWith(
      expect.objectContaining({
        recordId: "d3RXDPrgL9t5",
        fieldsToSet: { orgId: "Default" },
      }),
      expect.anything(),
    );
    expect(send).toHaveBeenCalledTimes(1);
    expect(send.mock.calls[0][0].input.Key).toEqual({
      agentId: "d3RXDPrgL9t5",
    });
  });
});
