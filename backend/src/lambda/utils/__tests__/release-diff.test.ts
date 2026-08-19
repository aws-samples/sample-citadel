import * as fc from "fast-check";
import {
  releaseDiff,
  releaseDiffWithScoreVectors,
  diffLines,
  diffScoreVectors,
  diffScoreVectorChange,
  assertConstituentKeyCoverage,
  MAX_CONSTITUENT_DIFF_BYTES,
  type ReleaseDiffChange,
} from "../release-diff";
import type {
  AgentReleaseConstituents,
  ContentSnapshot,
  ModelConfigSnapshot,
} from "../../../types";
import type { DimensionAggregate } from "../eval-score-aggregate";

// ---------------------------------------------------------------------
// Arbitraries
// ---------------------------------------------------------------------

function contentSnapshotArb(
  sourceIdArb = fc.stringMatching(/^src-[a-z0-9]{6}$/),
) {
  return fc
    .record({
      sourceId: sourceIdArb,
      content: fc.string({ minLength: 0, maxLength: 200 }),
    })
    .map(({ sourceId, content }) => ({
      sourceId,
      content,
      digest: `digest-${content.length}-${hashLike(content)}`,
    }));
}

// Cheap deterministic stand-in for a real digest — good enough for
// content-equality tests without importing crypto into the arbitrary.
function hashLike(s: string): string {
  let h = 0;
  for (let i = 0; i < s.length; i++) {
    h = (h * 31 + s.charCodeAt(i)) | 0;
  }
  return String(h);
}

const modelConfigSnapshotArb: fc.Arbitrary<ModelConfigSnapshot> = fc
  .record({
    slot: fc.constantFrom("supervisor", "fabricator", "extraction"),
    content: fc.string({ minLength: 0, maxLength: 100 }),
  })
  .map(({ slot, content }) => ({
    slot,
    content,
    digest: `digest-${hashLike(content)}`,
  }));

const policySnapshotArb = fc.record({
  enforcementMode: fc.constantFrom("permissive", "shadow", "strict"),
  ruleSetVersion: fc.stringMatching(/^v[0-9]{1,3}$/),
  authorityUnitGrantIds: fc.array(fc.stringMatching(/^au-[a-z0-9]{4}$/), {
    maxLength: 5,
  }),
});

const evalEvidenceArb = fc.record({
  evalRunId: fc.stringMatching(/^run-[a-z0-9]{6}$/),
  evalSuiteId: fc.stringMatching(/^suite-[a-z0-9]{6}$/),
  evalSuiteVersion: fc.integer({ min: 1, max: 50 }),
});

const promptVersionsArb = fc.dictionary(
  fc.stringMatching(/^prompt-[a-z]{3,8}$/),
  contentSnapshotArb(),
  { maxKeys: 4 },
);

const agentReleaseConstituentsArb: fc.Arbitrary<AgentReleaseConstituents> =
  fc.record({
    agentConfig: contentSnapshotArb(),
    promptVersions: promptVersionsArb,
    execSpecId: fc.stringMatching(/^spec-[a-z0-9]{6}$/),
    execSpecVersion: fc.integer({ min: 1, max: 20 }),
    modelConfigSnapshots: fc
      .array(modelConfigSnapshotArb, { maxLength: 3 })
      .map((arr) => {
        // dedupe by slot so the arbitrary always represents a valid bundle
        const seen = new Map<string, ModelConfigSnapshot>();
        for (const m of arr) seen.set(m.slot, m);
        return [...seen.values()];
      }),
    toolConfigs: fc.array(contentSnapshotArb(), { maxLength: 4 }).map((arr) => {
      const seen = new Map<string, ContentSnapshot>();
      for (const t of arr) seen.set(t.sourceId, t);
      return [...seen.values()];
    }),
    policySnapshot: policySnapshotArb,
    evalEvidence: evalEvidenceArb,
  });

function swap<T>(
  change: ReleaseDiffChange,
  field: "before" | "after",
): unknown {
  return change[field];
}

// ---------------------------------------------------------------------
// MANDATED property tests
// ---------------------------------------------------------------------

describe("releaseDiff — property: identity", () => {
  it("diff(a, a) is always empty for arbitrary bundles", () => {
    fc.assert(
      fc.property(agentReleaseConstituentsArb, (bundle) => {
        const result = releaseDiff(bundle, bundle);
        expect(result.changes).toEqual([]);
      }),
    );
  });
});

describe("releaseDiff — property: symmetric-inverse", () => {
  it("diff(a, b) and diff(b, a) enumerate identical constituents with before/after swapped", () => {
    fc.assert(
      fc.property(
        agentReleaseConstituentsArb,
        agentReleaseConstituentsArb,
        (a, b) => {
          const forward = releaseDiff(a, b);
          const backward = releaseDiff(b, a);

          const forwardKeys = forward.changes
            .map((c) => `${c.kind}:${c.key}`)
            .sort();
          const backwardKeys = backward.changes
            .map((c) => `${c.kind}:${c.key}`)
            .sort();
          expect(forwardKeys).toEqual(backwardKeys);

          const byKindKey = (changes: ReleaseDiffChange[]) => {
            const m = new Map<string, ReleaseDiffChange>();
            for (const c of changes) m.set(`${c.kind}:${c.key}`, c);
            return m;
          };
          const forwardMap = byKindKey(forward.changes);
          const backwardMap = byKindKey(backward.changes);

          for (const [key, fChange] of forwardMap) {
            const bChange = backwardMap.get(key)!;
            if (fChange.truncated || bChange.truncated) {
              // Truncated summaries are size-only; swap contract
              // still holds on the truncated flag itself.
              expect(bChange.truncated).toBe(fChange.truncated);
              continue;
            }
            expect(swap(bChange, "before")).toEqual(swap(fChange, "after"));
            expect(swap(bChange, "after")).toEqual(swap(fChange, "before"));
          }
        },
      ),
    );
  });
});

describe("releaseDiff — every-constituent-type coverage", () => {
  const base: AgentReleaseConstituents = {
    agentConfig: { sourceId: "reg-1", content: "v1", digest: "d1" },
    promptVersions: {
      system: { sourceId: "p-system", content: "line1\nline2", digest: "dp1" },
    },
    execSpecId: "spec-1",
    execSpecVersion: 1,
    modelConfigSnapshots: [
      { slot: "supervisor", content: "gpt", digest: "dm1" },
    ],
    toolConfigs: [{ sourceId: "tool-a", content: "toolA", digest: "dt1" }],
    policySnapshot: {
      enforcementMode: "shadow",
      ruleSetVersion: "v1",
      authorityUnitGrantIds: ["au-1"],
    },
    evalEvidence: {
      evalRunId: "run-1",
      evalSuiteId: "suite-1",
      evalSuiteVersion: 1,
    },
  };

  it("detects an agentConfig change", () => {
    const after: AgentReleaseConstituents = {
      ...base,
      agentConfig: { sourceId: "reg-1", content: "v2", digest: "d2" },
    };
    const { changes } = releaseDiff(base, after);
    expect(changes.some((c) => c.kind === "agentConfig")).toBe(true);
  });

  it("detects a prompt content change with a line-level diff", () => {
    const after: AgentReleaseConstituents = {
      ...base,
      promptVersions: {
        system: {
          sourceId: "p-system",
          content: "line1\nCHANGED",
          digest: "dp2",
        },
      },
    };
    const { changes } = releaseDiff(base, after);
    const promptChange = changes.find(
      (c) => c.kind === "prompt" && c.key === "system",
    );
    expect(promptChange).toBeDefined();
    expect(promptChange!.lineDiff).toBeDefined();
    expect(
      promptChange!.lineDiff!.some(
        (l) => l.type === "removed" && l.text === "line2",
      ),
    ).toBe(true);
    expect(
      promptChange!.lineDiff!.some(
        (l) => l.type === "added" && l.text === "CHANGED",
      ),
    ).toBe(true);
  });

  it("detects a prompt added wholesale (absent -> present)", () => {
    const after: AgentReleaseConstituents = {
      ...base,
      promptVersions: {
        ...base.promptVersions,
        greeting: { sourceId: "p-greeting", content: "hi", digest: "dp3" },
      },
    };
    const { changes } = releaseDiff(base, after);
    const change = changes.find(
      (c) => c.kind === "prompt" && c.key === "greeting",
    );
    expect(change).toBeDefined();
    expect(change!.before).toBeUndefined();
    expect(change!.after).toBeDefined();
    expect(change!.lineDiff).toBeUndefined();
  });

  it("detects execSpecVersion bump", () => {
    const after: AgentReleaseConstituents = { ...base, execSpecVersion: 2 };
    const { changes } = releaseDiff(base, after);
    const change = changes.find((c) => c.kind === "execSpec");
    expect(change).toBeDefined();
    expect(
      (change!.before as { execSpecVersion: number }).execSpecVersion,
    ).toBe(1);
    expect((change!.after as { execSpecVersion: number }).execSpecVersion).toBe(
      2,
    );
  });

  it("detects a model config slot change", () => {
    const after: AgentReleaseConstituents = {
      ...base,
      modelConfigSnapshots: [
        { slot: "supervisor", content: "claude", digest: "dm2" },
      ],
    };
    const { changes } = releaseDiff(base, after);
    const change = changes.find(
      (c) => c.kind === "model" && c.key === "supervisor",
    );
    expect(change).toBeDefined();
  });

  it("detects tool list additions and removals", () => {
    const after: AgentReleaseConstituents = {
      ...base,
      toolConfigs: [{ sourceId: "tool-b", content: "toolB", digest: "dt2" }],
    };
    const { changes } = releaseDiff(base, after);
    const change = changes.find((c) => c.kind === "tools");
    expect(change).toBeDefined();
    const before = change!.before as { onlyHere: ContentSnapshot[] };
    const afterSide = change!.after as { onlyHere: ContentSnapshot[] };
    expect(before.onlyHere.map((t) => t.sourceId)).toEqual(["tool-a"]);
    expect(afterSide.onlyHere.map((t) => t.sourceId)).toEqual(["tool-b"]);
  });

  it("detects a policy field-level delta", () => {
    const after: AgentReleaseConstituents = {
      ...base,
      policySnapshot: { ...base.policySnapshot, enforcementMode: "strict" },
    };
    const { changes } = releaseDiff(base, after);
    const change = changes.find((c) => c.kind === "policy");
    expect(change).toBeDefined();
    expect(
      (change as unknown as { fieldChanges: Record<string, unknown> })
        .fieldChanges,
    ).toHaveProperty("enforcementMode");
  });

  it("detects an evalEvidence pointer change", () => {
    const after: AgentReleaseConstituents = {
      ...base,
      evalEvidence: {
        evalRunId: "run-2",
        evalSuiteId: "suite-1",
        evalSuiteVersion: 1,
      },
    };
    const { changes } = releaseDiff(base, after);
    expect(changes.some((c) => c.kind === "evalEvidence")).toBe(true);
  });

  it("omits every unchanged constituent (identity fields only present when changed)", () => {
    const after: AgentReleaseConstituents = { ...base, execSpecVersion: 2 };
    const { changes } = releaseDiff(base, after);
    expect(changes).toHaveLength(1);
    expect(changes[0].kind).toBe("execSpec");
  });
});

describe("diffScoreVectors — score-vector movement", () => {
  it("reports per-dimension before->after movement, omitting identical dimensions", () => {
    const before: DimensionAggregate[] = [
      {
        dimension: "task_success" as DimensionAggregate["dimension"],
        scoredCount: 10,
        notApplicableCount: 0,
        unknownCount: 0,
        pendingCount: 0,
        passedCount: 8,
        passRate: 0.8,
      },
      {
        dimension: "latency" as DimensionAggregate["dimension"],
        scoredCount: 10,
        notApplicableCount: 0,
        unknownCount: 0,
        pendingCount: 0,
        p50: 100,
        p95: 200,
      },
    ];
    const after: DimensionAggregate[] = [
      {
        dimension: "task_success" as DimensionAggregate["dimension"],
        scoredCount: 10,
        notApplicableCount: 0,
        unknownCount: 0,
        pendingCount: 0,
        passedCount: 9,
        passRate: 0.9,
      },
      {
        dimension: "latency" as DimensionAggregate["dimension"],
        scoredCount: 10,
        notApplicableCount: 0,
        unknownCount: 0,
        pendingCount: 0,
        p50: 100,
        p95: 200,
      },
    ];
    const movements = diffScoreVectors(before, after);
    expect(movements).toHaveLength(1);
    expect(movements[0].dimension).toBe("task_success");
    expect(movements[0].before?.passRate).toBe(0.8);
    expect(movements[0].after?.passRate).toBe(0.9);
  });

  it("reports a dimension present only on one side with the other side null", () => {
    const before: DimensionAggregate[] = [];
    const after: DimensionAggregate[] = [
      {
        dimension: "cost" as DimensionAggregate["dimension"],
        scoredCount: 5,
        notApplicableCount: 0,
        unknownCount: 0,
        pendingCount: 0,
        sumUsd: 1.5,
        meanUsd: 0.3,
      },
    ];
    const movements = diffScoreVectors(before, after);
    expect(movements).toHaveLength(1);
    expect(movements[0].before).toBeNull();
    expect(movements[0].after?.sumUsd).toBe(1.5);
  });

  it("returns no movement for identical vectors regardless of order", () => {
    const a: DimensionAggregate[] = [
      {
        dimension: "cost" as DimensionAggregate["dimension"],
        scoredCount: 5,
        notApplicableCount: 0,
        unknownCount: 0,
        pendingCount: 0,
        sumUsd: 1,
        meanUsd: 0.2,
      },
      {
        dimension: "latency" as DimensionAggregate["dimension"],
        scoredCount: 5,
        notApplicableCount: 0,
        unknownCount: 0,
        pendingCount: 0,
        p50: 1,
        p95: 2,
      },
    ];
    const b = [a[1], a[0]];
    expect(diffScoreVectors(a, b)).toEqual([]);
  });

  it("diffScoreVectorChange returns null when there is no movement", () => {
    const v: DimensionAggregate[] = [
      {
        dimension: "cost" as DimensionAggregate["dimension"],
        scoredCount: 5,
        notApplicableCount: 0,
        unknownCount: 0,
        pendingCount: 0,
        sumUsd: 1,
        meanUsd: 0.2,
      },
    ];
    expect(diffScoreVectorChange(v, v)).toBeNull();
  });
});

describe("releaseDiffWithScoreVectors", () => {
  const base: AgentReleaseConstituents = {
    agentConfig: { sourceId: "reg-1", content: "v1", digest: "d1" },
    promptVersions: {},
    execSpecId: "spec-1",
    execSpecVersion: 1,
    modelConfigSnapshots: [],
    toolConfigs: [],
    policySnapshot: {
      enforcementMode: "shadow",
      ruleSetVersion: "v1",
      authorityUnitGrantIds: [],
    },
    evalEvidence: {
      evalRunId: "run-1",
      evalSuiteId: "suite-1",
      evalSuiteVersion: 1,
    },
  };

  it("folds score-vector movement into the same ReleaseDiffChange[] shape", () => {
    const scoreA: DimensionAggregate[] = [
      {
        dimension: "cost" as DimensionAggregate["dimension"],
        scoredCount: 5,
        notApplicableCount: 0,
        unknownCount: 0,
        pendingCount: 0,
        sumUsd: 1,
        meanUsd: 0.2,
      },
    ];
    const scoreB: DimensionAggregate[] = [
      {
        dimension: "cost" as DimensionAggregate["dimension"],
        scoredCount: 5,
        notApplicableCount: 0,
        unknownCount: 0,
        pendingCount: 0,
        sumUsd: 2,
        meanUsd: 0.4,
      },
    ];
    const result = releaseDiffWithScoreVectors(base, base, scoreA, scoreB);
    expect(result.changes).toHaveLength(1);
    expect(result.changes[0].kind).toBe("scoreVector");
  });

  it("produces no scoreVector entry when constituents AND score vectors are identical", () => {
    const scoreA: DimensionAggregate[] = [
      {
        dimension: "cost" as DimensionAggregate["dimension"],
        scoredCount: 5,
        notApplicableCount: 0,
        unknownCount: 0,
        pendingCount: 0,
        sumUsd: 1,
        meanUsd: 0.2,
      },
    ];
    const result = releaseDiffWithScoreVectors(base, base, scoreA, scoreA);
    expect(result.changes).toEqual([]);
  });
});

describe("releaseDiff — constituent-key exhaustiveness guard", () => {
  it("accepts every arbitrary AgentReleaseConstituents bundle (full key coverage)", () => {
    fc.assert(
      fc.property(agentReleaseConstituentsArb, (bundle) => {
        // Mirrors the feedback-round-1 concern: verify every key
        // AgentReleaseConstituents is expected to carry is
        // actually present, using a real generated bundle
        // rather than a hand-maintained list. If a field is
        // ever added to AgentReleaseConstituents without a
        // corresponding CONSTITUENT_KEY_COVERAGE entry, the
        // compile-time `satisfies` guard fails to build first;
        // this runtime check additionally catches a bundle
        // that is missing a key at the object-shape level
        // (e.g. constructed via an unsafe cast).
        expect(() => assertConstituentKeyCoverage(bundle)).not.toThrow();
        // Also confirms the guard is wired into releaseDiff
        // itself, not just exposed as a standalone helper.
        expect(() => releaseDiff(bundle, bundle)).not.toThrow();
      }),
    );
  });

  it("accepts a full AgentRelease row (superset of AgentReleaseConstituents) — real callers pass this shape", () => {
    // release-diff-resolver.ts and environment-release-pointer-
    // resolver.ts both call releaseDiff with full AgentRelease rows
    // (releaseId, orgId, semver, createdAt, ... on top of the pure
    // constituents). The guard must not reject legitimate extra
    // fields — only a MISSING constituent key is a real gap.
    const bundle = {
      agentConfig: { sourceId: "reg-1", content: "x", digest: "d1" },
      promptVersions: {},
      execSpecId: "spec-1",
      execSpecVersion: 1,
      modelConfigSnapshots: [],
      toolConfigs: [],
      policySnapshot: {
        enforcementMode: "shadow",
        ruleSetVersion: "v1",
        authorityUnitGrantIds: [],
      },
      evalEvidence: {
        evalRunId: "run-1",
        evalSuiteId: "suite-1",
        evalSuiteVersion: 1,
      },
      releaseId: "release-1",
      orgId: "org-1",
      agentTargetId: "agent-1",
      semver: "1.0.0",
      createdAt: "2026-01-01T00:00:00.000Z",
      createdBy: "architect-1",
      gitSha: "abc123",
      region: "us-east-1",
      runId: "runid-1",
    };
    expect(() => assertConstituentKeyCoverage(bundle)).not.toThrow();
  });

  it("rejects a bundle missing a required constituent key", () => {
    const bundle: AgentReleaseConstituents = {
      agentConfig: { sourceId: "reg-1", content: "x", digest: "d1" },
      promptVersions: {},
      execSpecId: "spec-1",
      execSpecVersion: 1,
      modelConfigSnapshots: [],
      toolConfigs: [],
      policySnapshot: {
        enforcementMode: "shadow",
        ruleSetVersion: "v1",
        authorityUnitGrantIds: [],
      },
      evalEvidence: {
        evalRunId: "run-1",
        evalSuiteId: "suite-1",
        evalSuiteVersion: 1,
      },
    };
    // Simulates a bundle constructed via an unsafe cast that drops
    // a required constituent — must be caught at runtime rather
    // than silently producing a diff that omits it.
    const { policySnapshot: _dropped, ...missingPolicy } = bundle;
    const withMissingKey = missingPolicy as unknown as AgentReleaseConstituents;
    expect(() => assertConstituentKeyCoverage(withMissingKey)).toThrow(
      /policySnapshot/,
    );
    expect(() => releaseDiff(withMissingKey, bundle)).toThrow(/policySnapshot/);
  });
});

describe("truncation path", () => {
  it("truncates an oversized constituent and never throws", () => {
    const hugeContent = "x".repeat(MAX_CONSTITUENT_DIFF_BYTES + 1000);
    const before: AgentReleaseConstituents = {
      agentConfig: { sourceId: "reg-1", content: "small", digest: "d1" },
      promptVersions: {},
      execSpecId: "spec-1",
      execSpecVersion: 1,
      modelConfigSnapshots: [],
      toolConfigs: [],
      policySnapshot: {
        enforcementMode: "shadow",
        ruleSetVersion: "v1",
        authorityUnitGrantIds: [],
      },
      evalEvidence: {
        evalRunId: "run-1",
        evalSuiteId: "suite-1",
        evalSuiteVersion: 1,
      },
    };
    const after: AgentReleaseConstituents = {
      ...before,
      agentConfig: { sourceId: "reg-1", content: hugeContent, digest: "d2" },
    };
    expect(() => releaseDiff(before, after)).not.toThrow();
    const { changes } = releaseDiff(before, after);
    const change = changes.find((c) => c.kind === "agentConfig")!;
    expect(change.truncated).toBe(true);
    expect(change.lineDiff).toBeUndefined();
  });

  it("does NOT truncate a constituent under the size cap", () => {
    const before: AgentReleaseConstituents = {
      agentConfig: { sourceId: "reg-1", content: "small-before", digest: "d1" },
      promptVersions: {},
      execSpecId: "spec-1",
      execSpecVersion: 1,
      modelConfigSnapshots: [],
      toolConfigs: [],
      policySnapshot: {
        enforcementMode: "shadow",
        ruleSetVersion: "v1",
        authorityUnitGrantIds: [],
      },
      evalEvidence: {
        evalRunId: "run-1",
        evalSuiteId: "suite-1",
        evalSuiteVersion: 1,
      },
    };
    const after: AgentReleaseConstituents = {
      ...before,
      agentConfig: { sourceId: "reg-1", content: "small-after", digest: "d2" },
    };
    const { changes } = releaseDiff(before, after);
    const change = changes.find((c) => c.kind === "agentConfig")!;
    expect(change.truncated).toBeFalsy();
  });
});

describe("diffLines", () => {
  it("returns pure context entries for identical text", () => {
    const entries = diffLines("a\nb\nc", "a\nb\nc");
    expect(entries.every((e) => e.type === "context")).toBe(true);
  });

  it("detects an added line", () => {
    const entries = diffLines("a\nb", "a\nb\nc");
    expect(entries.some((e) => e.type === "added" && e.text === "c")).toBe(
      true,
    );
  });

  it("detects a removed line", () => {
    const entries = diffLines("a\nb\nc", "a\nc");
    expect(entries.some((e) => e.type === "removed" && e.text === "b")).toBe(
      true,
    );
  });
});
