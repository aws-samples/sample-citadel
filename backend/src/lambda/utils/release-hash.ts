/**
 * release-hash.ts — pure content-addressing for AgentRelease.
 *
 * releaseId = sha256(canonicalize(constituents)). Canonicalization is
 * order-independent over:
 *   - object keys (sorted lexicographically before serialization), and
 *   - set-like collections — arrays of {sourceId|slot, ...} snapshot
 *     objects (toolConfigs, modelConfigSnapshots) and plain string arrays
 *     (authorityUnitGrantIds) are sorted by their own canonical
 *     serialization before being joined into the parent structure.
 *
 * This module has no side effects and no I/O — pure function of its
 * input, matching the "pure release-hash module" requirement.
 */
import { createHash } from "crypto";
import type { AgentReleaseConstituents } from "../../types";

/**
 * Recursively canonicalize a JSON-serializable value: object keys are
 * sorted; arrays are treated as SETS and sorted by the canonical string
 * of each element (never by original position), so any permutation of a
 * set-like collection serializes identically. Primitives pass through.
 */
function canonicalize(value: unknown): unknown {
  if (Array.isArray(value)) {
    const canonicalItems = value.map((item) => canonicalize(item));
    // Sort by the JSON-stable string form of each canonicalized item so
    // element order never affects the result — arrays are set-like here.
    return canonicalItems
      .map((item) => JSON.stringify(item))
      .sort()
      .map((s) => JSON.parse(s));
  }

  if (value !== null && typeof value === "object") {
    const obj = value as Record<string, unknown>;
    const sortedKeys = Object.keys(obj).sort();
    const result: Record<string, unknown> = {};
    for (const key of sortedKeys) {
      result[key] = canonicalize(obj[key]);
    }
    return result;
  }

  return value;
}

/** Deterministic JSON serialization of a canonicalized value. Because
 * canonicalize() has already sorted every object's keys and every
 * array's elements, JSON.stringify's own (order-preserving) traversal
 * yields a byte-identical string for structurally-identical input
 * regardless of original key/collection order. */
function canonicalStringify(value: unknown): string {
  return JSON.stringify(canonicalize(value));
}

/**
 * Compute the content-addressed hash of a release's constituents. Pure:
 * given structurally-identical constituents (any key ordering, any
 * ordering of set-like collections), returns the same 64-character
 * lowercase hex sha256 digest every time.
 */
export function computeReleaseHash(
  constituents: AgentReleaseConstituents,
): string {
  const canonical = canonicalStringify(constituents);
  return createHash("sha256").update(canonical, "utf8").digest("hex");
}
