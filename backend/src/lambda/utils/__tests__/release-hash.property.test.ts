/**
 * release-hash.property.test.ts — property test for the pure,
 * order-independent content hash that gives an AgentRelease its identity
 * (releaseId = sha256(canonicalize(constituents))).
 *
 * Binding invariants (design §1/§5):
 *   1. A release reconstructed from the same constituents hashes
 *      identically — the hash is a pure function of content, not identity
 *      or call order.
 *   2. Object key ordering never changes the hash (canonicalization sorts
 *      keys before hashing).
 *   3. Ordering of any set-like collection (promptVersions map iteration
 *      order, toolConfigs array, modelConfigSnapshots array,
 *      authorityUnitGrantIds array) never changes the hash — these are
 *      treated as sets, not sequences.
 *   4. Differing content produces a different hash (sanity check that the
 *      function is not trivially constant).
 */
import fc from "fast-check";
import { computeReleaseHash } from "../release-hash";
import type { AgentReleaseConstituents } from "../../../types";

function baseConstituents(): AgentReleaseConstituents {
  return {
    agentConfig: {
      sourceId: "agent-1",
      content: '{"name":"intake-agent"}',
      digest: "digest-a",
    },
    promptVersions: {
      supervisor: { sourceId: "p1", content: "you are...", digest: "d1" },
      fabricator: { sourceId: "p2", content: "you build...", digest: "d2" },
    },
    execSpecId: "spec-123",
    execSpecVersion: 3,
    modelConfigSnapshots: [
      { slot: "supervisor", content: "claude-x", digest: "m1" },
      { slot: "fabricator", content: "claude-y", digest: "m2" },
    ],
    toolConfigs: [
      { sourceId: "tool-a", content: "{}", digest: "t1" },
      { sourceId: "tool-b", content: "{}", digest: "t2" },
    ],
    policySnapshot: {
      enforcementMode: "strict",
      ruleSetVersion: "v3",
      authorityUnitGrantIds: ["grant-1", "grant-2"],
    },
    evalEvidence: {
      evalRunId: "run-1",
      evalSuiteId: "suite-1",
      evalSuiteVersion: 2,
    },
  };
}

describe("computeReleaseHash — reconstruct-from-hash property", () => {
  it("hashing the same constituents object twice yields an identical hash", () => {
    const constituents = baseConstituents();
    const h1 = computeReleaseHash(constituents);
    const h2 = computeReleaseHash(constituents);
    expect(h1).toBe(h2);
  });

  it("hashing a deep-cloned (structurally identical) copy yields an identical hash", () => {
    const a = baseConstituents();
    const b = JSON.parse(JSON.stringify(baseConstituents()));
    expect(computeReleaseHash(a)).toBe(computeReleaseHash(b));
  });

  it("reordering top-level object keys does not change the hash", () => {
    const a = baseConstituents();
    // Re-key in reverse order — same values, different property order.
    const entries = Object.entries(a).reverse();
    const reordered = Object.fromEntries(
      entries,
    ) as unknown as AgentReleaseConstituents;
    expect(computeReleaseHash(reordered)).toBe(computeReleaseHash(a));
  });

  it("reordering nested object keys (policySnapshot) does not change the hash", () => {
    const a = baseConstituents();
    const b = baseConstituents();
    b.policySnapshot = {
      authorityUnitGrantIds: [...a.policySnapshot.authorityUnitGrantIds],
      ruleSetVersion: a.policySnapshot.ruleSetVersion,
      enforcementMode: a.policySnapshot.enforcementMode,
    };
    expect(computeReleaseHash(b)).toBe(computeReleaseHash(a));
  });

  it("reordering the set-like toolConfigs array does not change the hash", () => {
    const a = baseConstituents();
    const b = baseConstituents();
    b.toolConfigs = [...a.toolConfigs].reverse();
    expect(computeReleaseHash(b)).toBe(computeReleaseHash(a));
  });

  it("reordering the set-like modelConfigSnapshots array does not change the hash", () => {
    const a = baseConstituents();
    const b = baseConstituents();
    b.modelConfigSnapshots = [...a.modelConfigSnapshots].reverse();
    expect(computeReleaseHash(b)).toBe(computeReleaseHash(a));
  });

  it("reordering the set-like authorityUnitGrantIds array does not change the hash", () => {
    const a = baseConstituents();
    const b = baseConstituents();
    b.policySnapshot = {
      ...a.policySnapshot,
      authorityUnitGrantIds: [
        ...a.policySnapshot.authorityUnitGrantIds,
      ].reverse(),
    };
    expect(computeReleaseHash(b)).toBe(computeReleaseHash(a));
  });

  it("reordering promptVersions map insertion order does not change the hash", () => {
    const a = baseConstituents();
    const b = baseConstituents();
    b.promptVersions = {
      fabricator: a.promptVersions.fabricator,
      supervisor: a.promptVersions.supervisor,
    };
    expect(computeReleaseHash(b)).toBe(computeReleaseHash(a));
  });

  it("differing content (one changed digest) produces a distinct hash", () => {
    const a = baseConstituents();
    const b = baseConstituents();
    b.agentConfig = { ...a.agentConfig, digest: "digest-b-different" };
    expect(computeReleaseHash(b)).not.toBe(computeReleaseHash(a));
  });

  it("property: for arbitrary constituents, shuffling any set-like collection never changes the hash", () => {
    fc.assert(
      fc.property(
        fc.array(
          fc.record({
            sourceId: fc.string({ minLength: 1, maxLength: 10 }),
            content: fc.string({ minLength: 0, maxLength: 20 }),
            digest: fc.string({ minLength: 1, maxLength: 10 }),
          }),
          { minLength: 0, maxLength: 6 },
        ),
        (toolConfigs) => {
          const constituents = baseConstituents();
          constituents.toolConfigs = toolConfigs;
          const shuffled = [...toolConfigs].reverse();
          const constituentsShuffled = {
            ...constituents,
            toolConfigs: shuffled,
          };
          expect(computeReleaseHash(constituentsShuffled)).toBe(
            computeReleaseHash(constituents),
          );
        },
      ),
      { numRuns: 50 },
    );
  });

  it("property: for arbitrary distinct constituents pairs, differing content yields differing hashes", () => {
    fc.assert(
      fc.property(
        fc.string({ minLength: 1, maxLength: 20 }),
        fc.string({ minLength: 1, maxLength: 20 }),
        (digestA, digestB) => {
          fc.pre(digestA !== digestB);
          const a = baseConstituents();
          const b = baseConstituents();
          a.agentConfig = { ...a.agentConfig, digest: digestA };
          b.agentConfig = { ...b.agentConfig, digest: digestB };
          expect(computeReleaseHash(a)).not.toBe(computeReleaseHash(b));
        },
      ),
      { numRuns: 50 },
    );
  });

  it("returns a 64-character lowercase hex sha256 digest", () => {
    const hash = computeReleaseHash(baseConstituents());
    expect(hash).toMatch(/^[0-9a-f]{64}$/);
  });
});
