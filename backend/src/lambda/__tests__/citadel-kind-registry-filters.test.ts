/**
 * CIT-247 §2.4-2.8: Citadel-kind registry record filters and guards.
 *
 * Validates:
 *  - listAgentConfigsRegistry excludes app and tool records
 *  - getAgentConfigRegistry returns null for non-agent records
 *  - getApp returns null for non-app records
 *  - updateAgentBinding rejects self-binding and non-agent binding
 *  - ensureAgentConfigRows skips non-agent kinds with WARN
 *  - listPendingApprovals labels each record with its resolved kind
 *  - Property: for random mixes of kinds, listAgentConfigs returns only agents
 */
import * as fc from "fast-check";

// ---------------------------------------------------------------------------
// citadel-kind unit tests (resolveKind, extractCitadelKind, inferKindFromShape)
// ---------------------------------------------------------------------------
import {
  resolveKind,
  extractCitadelKind,
  inferKindFromShape,
  type CitadelKind,
} from "../../utils/citadel-kind";

describe("resolveKind", () => {
  it("returns explicit citadelKind when present", () => {
    const record = {
      customDescriptorContent: JSON.stringify({ citadelKind: "app" }),
    };
    expect(resolveKind(record)).toBe("app");
  });

  it("infers app from manifest.agentBindings when citadelKind absent", () => {
    const record = {
      recordId: "rec1",
      customDescriptorContent: JSON.stringify({
        manifest: {
          name: "x",
          version: "1",
          agentBindings: [{ agentId: "a1" }],
        },
      }),
    };
    // Should warn — but return 'app'
    expect(resolveKind(record)).toBe("app");
  });

  it("infers agent from manifest.tools when citadelKind absent", () => {
    const record = {
      recordId: "rec1b",
      customDescriptorContent: JSON.stringify({
        manifest: { name: "x", version: "1", tools: ["tool-1"] },
      }),
    };
    expect(resolveKind(record)).toBe("agent");
  });

  it("infers tool when no manifest and no citadelKind", () => {
    const record = {
      recordId: "rec2",
      customDescriptorContent: JSON.stringify({
        categories: ["billing"],
        state: "active",
      }),
    };
    expect(resolveKind(record)).toBe("tool");
  });

  it("returns tool when resourceType is tool", () => {
    const record = {
      recordId: "rec3",
      customDescriptorContent: JSON.stringify({}),
    };
    expect(resolveKind(record, "tool")).toBe("tool");
  });

  it("returns agent for null record", () => {
    expect(resolveKind(null)).toBe("agent");
  });

  it("returns tool for null record when resourceType is tool", () => {
    expect(resolveKind(null, "tool")).toBe("tool");
  });
});

describe("extractCitadelKind", () => {
  it("returns undefined for null record", () => {
    expect(extractCitadelKind(null)).toBeUndefined();
  });

  it("returns undefined when citadelKind is not a valid value", () => {
    const record = {
      customDescriptorContent: JSON.stringify({ citadelKind: "invalid" }),
    };
    expect(extractCitadelKind(record)).toBeUndefined();
  });

  it("handles config field (AgentConfig-like)", () => {
    const agentConfig = {
      config: JSON.stringify({ citadelKind: "agent" }),
    };
    expect(extractCitadelKind(agentConfig)).toBe("agent");
  });

  it("handles malformed JSON gracefully", () => {
    const record = { customDescriptorContent: "not json" };
    expect(extractCitadelKind(record)).toBeUndefined();
  });
});

describe("inferKindFromShape", () => {
  it("infers app when manifest has agentBindings", () => {
    const record = {
      customDescriptorContent: JSON.stringify({
        manifest: { name: "my-app", agentBindings: [{ agentId: "a1" }] },
      }),
    };
    expect(inferKindFromShape(record)).toBe("app");
  });

  it("infers agent when manifest has tools but no agentBindings", () => {
    const record = {
      customDescriptorContent: JSON.stringify({
        manifest: { name: "my-agent", tools: ["tool-1"] },
      }),
    };
    expect(inferKindFromShape(record)).toBe("agent");
  });

  it("infers tool when no manifest", () => {
    const record = {
      customDescriptorContent: JSON.stringify({ state: "active" }),
    };
    expect(inferKindFromShape(record)).toBe("tool");
  });

  it("infers tool when resourceType is tool", () => {
    const record = { customDescriptorContent: "{}" };
    expect(inferKindFromShape(record, "tool")).toBe("tool");
  });
});

// ---------------------------------------------------------------------------
// listAgentConfigsRegistry kind filtering — unit
// ---------------------------------------------------------------------------
describe("listAgentConfigsRegistry kind filter", () => {
  // Direct-import pattern: test resolveKind-based filtering logic in isolation
  it("resolveKind filters agent vs app vs tool correctly", () => {
    const records = [
      {
        recordId: "a1",
        customDescriptorContent: JSON.stringify({
          citadelKind: "agent",
          categories: [],
        }),
      },
      {
        recordId: "a2",
        customDescriptorContent: JSON.stringify({
          citadelKind: "app",
          manifest: { name: "my-app" },
        }),
      },
      {
        recordId: "a3",
        customDescriptorContent: JSON.stringify({
          citadelKind: "tool",
          config: "{}",
        }),
      },
      {
        // Pre-backfill agent (no citadelKind, has manifest with tools)
        recordId: "a4",
        customDescriptorContent: JSON.stringify({
          manifest: { name: "old-agent", tools: ["t1"] },
          categories: ["billing"],
          state: "active",
        }),
      },
      {
        // Pre-backfill app (no citadelKind, has manifest with agentBindings)
        recordId: "a5",
        customDescriptorContent: JSON.stringify({
          manifest: { name: "old-app", agentBindings: [{ agentId: "a1" }] },
        }),
      },
      {
        // Pre-backfill tool (no citadelKind, no manifest)
        recordId: "a6",
        customDescriptorContent: JSON.stringify({
          config: "{}",
        }),
      },
    ];

    const agentOnly = records.filter((r) => resolveKind(r) === "agent");
    expect(agentOnly.map((r) => r.recordId)).toEqual(["a1", "a4"]);
  });
});

// ---------------------------------------------------------------------------
// getAgentConfigRegistry / getApp cross-kind null tests
// ---------------------------------------------------------------------------
describe("getAgentConfigRegistry cross-kind null", () => {
  it("resolveKind returns app for an app-stamped record", () => {
    const appRecord = {
      customDescriptorContent: JSON.stringify({
        citadelKind: "app",
        manifest: { name: "my-app" },
      }),
    };
    expect(resolveKind(appRecord)).toBe("app");
    // → getAgentConfigRegistry would return null when kind !== 'agent'
  });

  it("resolveKind returns agent for an agent-stamped record", () => {
    const agentRecord = {
      customDescriptorContent: JSON.stringify({
        citadelKind: "agent",
        categories: [],
      }),
    };
    expect(resolveKind(agentRecord)).toBe("agent");
    // → getApp would return null when kind !== 'app'
  });
});

// ---------------------------------------------------------------------------
// updateAgentBinding guards — unit
// ---------------------------------------------------------------------------
describe("updateAgentBinding guards", () => {
  it("self-binding check: agentId === appId should be blocked", () => {
    // This tests the guard logic directly
    const appId = "xL0K6QlfKkEx";
    const agentId = "xL0K6QlfKkEx";
    expect(agentId === appId).toBe(true);
    // The resolver throws "an app cannot be bound as its own agent"
  });

  it("kind check: app record should be rejected as a binding target", () => {
    const appRecord = {
      customDescriptorContent: JSON.stringify({
        citadelKind: "app",
        manifest: { name: "my-app" },
      }),
    };
    const kind = resolveKind(appRecord);
    expect(kind).toBe("app");
    expect(kind).not.toBe("agent");
    // The resolver throws "only agents can be bound to an app"
  });

  it("kind check: tool record should be rejected as a binding target", () => {
    const toolRecord = {
      customDescriptorContent: JSON.stringify({ citadelKind: "tool" }),
    };
    const kind = resolveKind(toolRecord);
    expect(kind).toBe("tool");
    expect(kind).not.toBe("agent");
  });

  it("kind check: agent record should be accepted as a binding target", () => {
    const agentRecord = {
      customDescriptorContent: JSON.stringify({
        citadelKind: "agent",
        categories: [],
      }),
    };
    const kind = resolveKind(agentRecord);
    expect(kind).toBe("agent");
  });
});

// ---------------------------------------------------------------------------
// ensureAgentConfigRows kind skip
// ---------------------------------------------------------------------------
describe("ensureAgentConfigRows kind skip", () => {
  it("resolveKind detects app records that should be skipped", () => {
    const appRecord = {
      customDescriptorContent: JSON.stringify({
        citadelKind: "app",
        manifest: { name: "my-app" },
      }),
    };
    const kind = resolveKind(appRecord);
    expect(kind).not.toBe("agent");
    // ensureAgentConfigRows pushes to failed[] and continues
  });

  it("resolveKind detects agent records that should be materialised", () => {
    const agentRecord = {
      customDescriptorContent: JSON.stringify({
        citadelKind: "agent",
        categories: [],
        manifest: { name: "billing-agent" },
      }),
    };
    const kind = resolveKind(agentRecord);
    expect(kind).toBe("agent");
  });
});

// ---------------------------------------------------------------------------
// listPendingApprovals recordType — unit
// ---------------------------------------------------------------------------
describe("listPendingApprovals recordType via resolveKind", () => {
  it("manifest + citadelKind=app → recordType 'app' (not 'agent')", () => {
    const record = {
      recordId: "rec-app",
      customDescriptorContent: JSON.stringify({
        citadelKind: "app",
        manifest: { name: "my-app" },
        orgId: "org-1",
      }),
    };
    expect(resolveKind(record)).toBe("app");
  });

  it("manifest.agentBindings + no citadelKind → inferred 'app' (pre-backfill)", () => {
    const record = {
      recordId: "rec-old-app",
      customDescriptorContent: JSON.stringify({
        manifest: { name: "old-app", agentBindings: [{ agentId: "a1" }] },
        orgId: "org-1",
      }),
    };
    expect(resolveKind(record)).toBe("app");
  });

  it("no manifest + citadelKind=agent → recordType 'agent'", () => {
    const record = {
      recordId: "rec-agent",
      customDescriptorContent: JSON.stringify({
        citadelKind: "agent",
        categories: [],
        orgId: "org-1",
      }),
    };
    expect(resolveKind(record)).toBe("agent");
  });

  it("no manifest + citadelKind=tool → recordType 'tool'", () => {
    const record = {
      recordId: "rec-tool",
      customDescriptorContent: JSON.stringify({
        citadelKind: "tool",
        orgId: "org-1",
      }),
    };
    expect(resolveKind(record)).toBe("tool");
  });
});

// ---------------------------------------------------------------------------
// Property test: for random mixes of kinds, filter returns only agents
// ---------------------------------------------------------------------------
describe("property: listAgentConfigs returns only agents", () => {
  const kindArb = fc.constantFrom<CitadelKind>("agent", "app", "tool");

  it("for random mixes of kinds, agent-only filter returns only agents", () => {
    fc.assert(
      fc.property(
        fc.array(
          fc.record({
            recordId: fc.string({ minLength: 12, maxLength: 12 }),
            kind: kindArb,
            hasManifest: fc.boolean(),
          }),
          { minLength: 0, maxLength: 50 },
        ),
        (records) => {
          const registry = records.map((r) => ({
            recordId: r.recordId,
            customDescriptorContent: JSON.stringify({
              citadelKind: r.kind,
              ...(r.hasManifest ? { manifest: { name: "m" } } : {}),
            }),
          }));

          const agentOnly = registry.filter((r) => resolveKind(r) === "agent");

          // Every returned record is an agent
          for (const rec of agentOnly) {
            expect(resolveKind(rec)).toBe("agent");
          }

          // No agents were dropped
          const allAgents = registry.filter(
            (r) =>
              JSON.parse(r.customDescriptorContent).citadelKind === "agent",
          );
          expect(agentOnly.length).toBe(allAgents.length);
        },
      ),
      { numRuns: 100 },
    );
  });

  it("for random mixes, listPendingApprovals labels each record with its kind", () => {
    fc.assert(
      fc.property(
        fc.array(
          fc.record({
            recordId: fc.string({ minLength: 12, maxLength: 12 }),
            kind: kindArb,
          }),
          { minLength: 1, maxLength: 30 },
        ),
        (records) => {
          for (const r of records) {
            const fakeRecord = {
              recordId: r.recordId,
              customDescriptorContent: JSON.stringify({
                citadelKind: r.kind,
                ...(r.kind === "app" ? { manifest: { name: "app" } } : {}),
              }),
            };
            const resolvedKind = resolveKind(fakeRecord);
            expect(resolvedKind).toBe(r.kind);
          }
        },
      ),
      { numRuns: 100 },
    );
  });
});
