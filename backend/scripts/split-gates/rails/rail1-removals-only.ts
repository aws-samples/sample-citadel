/**
 * Rail 1 — removals-only diff.
 *
 * Compares a fresh backend template against the committed baseline:
 *   - no NEW logical IDs are allowed unless explicitly allowlisted with a
 *     justification (a split stage never adds resources to the backend
 *     stack; satellites carry new resources, backend only loses them).
 *   - REMOVED logical IDs must all be in `allowlist` (the move manifest the
 *     later move stages maintain) and NEVER a stateful type.
 *   - RETAINED logical IDs (present in both) must be byte-identical on
 *     their key properties (rail 1 also carries the stateful byte-identity
 *     check that rail 2 independently re-asserts via a CDK Template test).
 */
import { CfnTemplate } from "../types";
import {
  isStatefulType,
  keyPropsEqual,
  stableStringify,
} from "../template-utils";
import { STATEFUL_KEY_PROPS } from "../types";
import { RailResult, RailViolation } from "../types";

export interface AllowlistEntry {
  logicalId: string;
  justification: string;
}

export function runRemovalsOnlyDiff(
  baseline: CfnTemplate,
  fresh: CfnTemplate,
  allowlist: AllowlistEntry[] = [],
): RailResult {
  const violations: RailViolation[] = [];
  const allowedIds = new Set(allowlist.map((e) => e.logicalId));
  const baselineIds = new Set(Object.keys(baseline.Resources));
  const freshIds = new Set(Object.keys(fresh.Resources));

  const added = [...freshIds].filter((id) => !baselineIds.has(id));
  const removed = [...baselineIds].filter((id) => !freshIds.has(id));
  const retained = [...baselineIds].filter((id) => freshIds.has(id));

  for (const id of added) {
    violations.push({
      rail: "rail1",
      logicalId: id,
      message: `New logical ID "${id}" was added to the backend template. This stage must be removals-only.`,
    });
  }

  for (const id of removed) {
    const baseType = baseline.Resources[id].Type;
    if (isStatefulType(baseType)) {
      violations.push({
        rail: "rail1",
        logicalId: id,
        message: `Stateful resource "${id}" (${baseType}) was removed from the backend template. Stateful resources must never move.`,
      });
      continue;
    }
    if (!allowedIds.has(id)) {
      violations.push({
        rail: "rail1",
        logicalId: id,
        message: `Logical ID "${id}" was removed but is not present in the move allowlist (no justification recorded).`,
      });
    }
  }

  for (const id of retained) {
    const baseRes = baseline.Resources[id];
    const freshRes = fresh.Resources[id];
    if (baseRes.Type !== freshRes.Type) {
      violations.push({
        rail: "rail1",
        logicalId: id,
        message: `Type changed for "${id}": ${baseRes.Type} -> ${freshRes.Type}.`,
      });
      continue;
    }
    if (isStatefulType(baseRes.Type)) {
      const keys = STATEFUL_KEY_PROPS[baseRes.Type] ?? [];
      const { equal, diffs } = keyPropsEqual(
        baseRes.Properties,
        freshRes.Properties,
        keys,
      );
      if (!equal) {
        violations.push({
          rail: "rail1",
          logicalId: id,
          message: `Stateful resource "${id}" (${baseRes.Type}) changed key properties: ${diffs.join(", ")}.`,
        });
      }
      if (baseRes.DeletionPolicy !== freshRes.DeletionPolicy) {
        violations.push({
          rail: "rail1",
          logicalId: id,
          message: `DeletionPolicy changed for "${id}": ${baseRes.DeletionPolicy} -> ${freshRes.DeletionPolicy}.`,
        });
      }
      if (baseRes.UpdateReplacePolicy !== freshRes.UpdateReplacePolicy) {
        violations.push({
          rail: "rail1",
          logicalId: id,
          message: `UpdateReplacePolicy changed for "${id}": ${baseRes.UpdateReplacePolicy} -> ${freshRes.UpdateReplacePolicy}.`,
        });
      }
    }
  }

  // Stateful export byte-identity (Outputs carrying Export.Name for a stateful resource).
  for (const [outName, baseOut] of Object.entries(baseline.Outputs ?? {})) {
    if (!baseOut.Export?.Name) continue;
    const freshOut = fresh.Outputs?.[outName];
    if (!freshOut) {
      violations.push({
        rail: "rail1",
        logicalId: outName,
        message: `Export "${outName}" (${stableStringify(baseOut.Export.Name)}) was removed. Exports consumed by other stacks must be pinned.`,
      });
      continue;
    }
    if (
      stableStringify(freshOut.Export?.Name) !==
      stableStringify(baseOut.Export.Name)
    ) {
      violations.push({
        rail: "rail1",
        logicalId: outName,
        message: `Export name changed for output "${outName}".`,
      });
    }
    if (stableStringify(freshOut.Value) !== stableStringify(baseOut.Value)) {
      violations.push({
        rail: "rail1",
        logicalId: outName,
        message: `Export value changed for output "${outName}".`,
      });
    }
  }

  return {
    rail: "rail1",
    name: "removals-only diff",
    passed: violations.length === 0,
    violations,
  };
}
