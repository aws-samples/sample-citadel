/**
 * Unit tests for the pure-logic helpers in backfill-shared-org-marker.ts
 * (PR-3, Continuum CRITICAL: blank orgId as cross-tenant wildcard).
 *
 * Only the classifier/decision helpers and summary accumulation are tested
 * here — the AWS-client call sites (Registry update, DDB UpdateCommand) are
 * integration-level and exercised separately in the orchestration test.
 *
 * The module-level mocks below (RegistryService + AWS DDB clients) back the
 * "main() default-pass exit code" describe block further down, which drives
 * a real `main()` invocation end to end with a fake registry/table so the
 * process-exit-code behavior is verified against the actual entry point,
 * not just a helper. No AWS calls are made — every client is a jest mock.
 */
jest.mock("@aws-sdk/client-dynamodb", () => ({
  DynamoDBClient: jest.fn().mockImplementation(() => ({})),
}));

const ddbSend = jest.fn();
class FakeScanCommand {
  input: Record<string, unknown>;
  constructor(input: Record<string, unknown>) {
    this.input = input;
  }
}
class FakeGetCommand {
  input: Record<string, unknown>;
  constructor(input: Record<string, unknown>) {
    this.input = input;
  }
}
class FakeUpdateCommand {
  input: Record<string, unknown>;
  constructor(input: Record<string, unknown>) {
    this.input = input;
  }
}
jest.mock("@aws-sdk/lib-dynamodb", () => ({
  DynamoDBDocumentClient: {
    from: jest
      .fn()
      .mockReturnValue({ send: (...args: unknown[]) => ddbSend(...args) }),
  },
  GetCommand: FakeGetCommand,
  ScanCommand: FakeScanCommand,
  UpdateCommand: FakeUpdateCommand,
}));

const registryListResources = jest.fn();
jest.mock("../../src/services/registry-service", () => ({
  RegistryService: jest.fn().mockImplementation(() => ({
    listResources: (...args: unknown[]) => registryListResources(...args),
  })),
  RegistryRecordStatusValues: { APPROVED: "APPROVED" },
}));

import {
  classifyRecord,
  emptySummary,
  addSummary,
  SEED_ALLOWLIST_NAMES,
  SEED_ALLOWLIST_CREATED_BY,
  main,
  parseProjectionWaitMs,
  DEFAULT_PROJECTION_WAIT_MS,
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
      attempted: 0,
      needsReapproval: 0,
      projectionLag: 0,
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
      attempted: 2,
      needsReapproval: 1,
      projectionLag: 1,
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
      attempted: 1,
      needsReapproval: 0,
      projectionLag: 0,
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
      attempted: 3,
      needsReapproval: 1,
      projectionLag: 1,
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

describe("parseProjectionWaitMs — pure CLI flag parser for --projection-wait-ms", () => {
  it("parses a valid value and returns it as a number", () => {
    expect(parseProjectionWaitMs("90000")).toBe(90000);
  });

  it("returns DEFAULT_PROJECTION_WAIT_MS when the raw value is undefined (flag absent)", () => {
    expect(parseProjectionWaitMs(undefined)).toBe(DEFAULT_PROJECTION_WAIT_MS);
  });

  it("accepts the minimum allowed value of 1000", () => {
    expect(parseProjectionWaitMs("1000")).toBe(1000);
  });

  it("rejects a value below the 1000ms floor", () => {
    expect(() => parseProjectionWaitMs("999")).toThrow(
      '--projection-wait-ms must be an integer >= 1000, got "999"',
    );
  });

  it("rejects a non-numeric value", () => {
    expect(() => parseProjectionWaitMs("abc")).toThrow(
      '--projection-wait-ms must be an integer >= 1000, got "abc"',
    );
  });

  it("rejects a negative value", () => {
    expect(() => parseProjectionWaitMs("-5")).toThrow(
      '--projection-wait-ms must be an integer >= 1000, got "-5"',
    );
  });

  it("rejects a decimal value", () => {
    expect(() => parseProjectionWaitMs("1500.5")).toThrow(
      '--projection-wait-ms must be an integer >= 1000, got "1500.5"',
    );
  });

  it("rejects an empty string", () => {
    expect(() => parseProjectionWaitMs("")).toThrow(
      '--projection-wait-ms must be an integer >= 1000, got ""',
    );
  });
});

describe("main() --projection-wait-ms CLI validation", () => {
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

  it("rejects --projection-wait-ms below the 1000ms floor before any env var is checked", async () => {
    delete process.env.REGISTRY_ID;
    process.argv = ["node", "script", "--projection-wait-ms", "500"];
    await expect(main()).rejects.toThrow(
      '--projection-wait-ms must be an integer >= 1000, got "500"',
    );
  });

  it("rejects a non-numeric --projection-wait-ms value", async () => {
    delete process.env.REGISTRY_ID;
    process.argv = ["node", "script", "--projection-wait-ms", "soon"];
    await expect(main()).rejects.toThrow(
      '--projection-wait-ms must be an integer >= 1000, got "soon"',
    );
  });

  it("falls through to the next validation (env guard) when --projection-wait-ms is a valid value", async () => {
    delete process.env.REGISTRY_ID;
    process.argv = ["node", "script", "--projection-wait-ms", "5000"];
    // A valid flag value must not itself throw — the next failure
    // encountered is the pre-existing, unrelated env var guard.
    await expect(main()).rejects.toThrow("REGISTRY_ID env var required");
  });

  it("does not throw when --projection-wait-ms is omitted (default applies silently)", async () => {
    delete process.env.REGISTRY_ID;
    process.argv = ["node", "script"];
    await expect(main()).rejects.toThrow("REGISTRY_ID env var required");
  });
});

describe("main() default-pass exit code — errors / ambiguous rows", () => {
  const originalEnv = process.env;
  const originalArgv = process.argv;
  let exitSpy: jest.SpyInstance;

  beforeEach(() => {
    process.env = {
      ...originalEnv,
      REGISTRY_ID: "reg-1",
      AGENT_CONFIG_TABLE: "agents-table",
      TOOL_CONFIG_TABLE: "tools-table",
    };
    delete process.env.PROJECTS_TABLE;
    process.argv = ["node", "script"];
    registryListResources.mockReset();
    ddbSend.mockReset();
    ddbSend.mockResolvedValue({ Items: [] });
    exitSpy = jest.spyOn(process, "exit").mockImplementation(((
      code?: number,
    ) => {
      throw new Error(`process.exit(${code})`);
    }) as never);
    jest.spyOn(console, "log").mockImplementation(() => {});
    jest.spyOn(console, "warn").mockImplementation(() => {});
    jest.spyOn(console, "error").mockImplementation(() => {});
  });

  afterEach(() => {
    jest.restoreAllMocks();
    process.env = originalEnv;
    process.argv = originalArgv;
  });

  it("exits with code 3 when the registry listing fails (summary.errors > 0)", async () => {
    registryListResources.mockRejectedValue(new Error("throttled"));

    await expect(main()).rejects.toThrow("process.exit(3)");
    expect(exitSpy).toHaveBeenCalledWith(3);
  });

  it("exits with code 3 when a DDB scan fails (summary.errors > 0)", async () => {
    registryListResources.mockResolvedValue([]);
    ddbSend.mockRejectedValueOnce(new Error("scan failed"));

    await expect(main()).rejects.toThrow("process.exit(3)");
    expect(exitSpy).toHaveBeenCalledWith(3);
  });

  it("exits with code 3 when a blank-orgId agent record resolves to AMBIGUOUS via createdBy (ambiguousReported > 0)", async () => {
    // PROJECTS_TABLE is set so the default pass builds a real orgResolver;
    // a fabricator-created agent whose sourceProjectId maps to a project
    // that itself has >1 distinct org in the (synthetic) index will not
    // occur via resolveAgentOrg (that path returns a single org or
    // undefined, never "AMBIGUOUS") — AMBIGUOUS is reachable for a TOOL
    // whose name is referenced by two agents resolving to different orgs.
    process.env.PROJECTS_TABLE = "projects-table";

    registryListResources.mockImplementation(async (type: string) => {
      if (type === "tool") {
        return [
          {
            recordId: "tool-rec-1",
            name: "shared-tool",
            customDescriptorContent: JSON.stringify({
              createdBy: "fabricator",
            }),
          },
        ];
      }
      return [];
    });

    // Agent DDB scan (used to build the toolName -> org index) returns two
    // agents referencing the same tool name but resolving to different
    // orgs via sourceProjectId -> projects table.
    ddbSend.mockImplementation(
      async (cmd: {
        constructor: { name: string };
        input: Record<string, unknown>;
      }) => {
        const isScan = cmd.constructor.name === "FakeScanCommand";
        if (isScan && cmd.input.TableName === "projects-table") {
          return {
            Items: [
              { projectId: "proj-a", organization: "org-a" },
              { projectId: "proj-b", organization: "org-b" },
            ],
          };
        }
        if (isScan && cmd.input.TableName === "agents-table") {
          return {
            Items: [
              {
                agentId: "agent-a",
                name: "agent-a",
                sourceProjectId: "proj-a",
                config: { schema: { tools: ["shared-tool"] } },
              },
              {
                agentId: "agent-b",
                name: "agent-b",
                sourceProjectId: "proj-b",
                config: { schema: { tools: ["shared-tool"] } },
              },
            ],
          };
        }
        return { Items: [] };
      },
    );

    await expect(main()).rejects.toThrow("process.exit(3)");
    expect(exitSpy).toHaveBeenCalledWith(3);
  });

  it("exits with code 0 (does not call process.exit) on a clean run with no errors or ambiguous rows", async () => {
    registryListResources.mockResolvedValue([]);
    ddbSend.mockResolvedValue({ Items: [] });

    await main();

    expect(exitSpy).not.toHaveBeenCalled();
  });
});
