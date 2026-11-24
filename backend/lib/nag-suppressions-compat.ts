/**
 * nag-suppressions-compat.ts — v2-API-compatible shim over cdk-nag v3.
 *
 * cdk-nag 3.x removed the `NagSuppressions` class entirely (see
 * node_modules/cdk-nag/MIGRATION.md, "Acknowledging (Suppressing) Rules").
 * This module reproduces the exact v2 `NagSuppressions` static method
 * signatures (`addResourceSuppressions`, `addResourceSuppressionsByPath`,
 * `addStackSuppressions`) so every existing call site in this repo
 * continues to compile and behave identically.
 *
 * Implementation note: this is a direct, faithful reproduction of v2's
 * OWN mechanism (cdk-nag 2.38.2's `lib/nag-suppressions.js`), not a
 * reimplementation on top of v3's `Validations.acknowledge()`. v2 wrote
 * the `cdk_nag: { rules_to_suppress: [...] }` CloudFormation Metadata
 * block directly onto each matching `CfnResource` (via `addMetadata`) or
 * onto the stack's `templateOptions.metadata` (for stack-level
 * suppressions) at CALL TIME — it did not defer to any separate aspect or
 * rely on an ancestor-walk performed later by a registered NagPack.
 *
 * An earlier version of this shim routed through v3's
 * `Validations.of(construct).acknowledge()` plus
 * `AwsSolutionsChecks({ writeSuppressionsToCloudFormation: true })`.
 * That combination has two divergences from v2, both confirmed against
 * the before/after suppression-metadata diff in /tmp/kiro-nag:
 *   1. `WriteNagSuppressionsToCloudFormationAspect` (cdk-nag's own v3
 *      aspect for CFN-metadata compat) runs on EVERY CfnResource in the
 *      tree and walks UP collecting every acknowledgment from every
 *      ancestor, writing the full accumulated set onto each descendant's
 *      own metadata — not just the resources v2 would have targeted for
 *      a given `applyToChildren`/`addResourceSuppressionsByPath` call.
 *      This inflated resources-with-suppression-metadata from 352 to
 *      1232 across the 9 stacks in this repo (880 newly-stamped
 *      resources, all additive — no suppression was ever lost; see the
 *      before.json/after.json diff script run for this migration).
 *   2. It requires a NagPack to be registered with
 *      `writeSuppressionsToCloudFormation: true` for the metadata to
 *      appear at all. Call sites/tests that only apply a *custom*
 *      `cdk.IAspect` (e.g. `SuppressNodejsL1Nag` in
 *      nag-l1-suppression-aspect.ts) and never register `AwsSolutionsChecks`
 *      got ZERO `cdk_nag` metadata, because nothing ever ran the aspect
 *      that flushes it (lib/__tests__/nag-l1-suppression.test.ts: 0/2
 *      expected L1 suppressions found).
 *
 * Writing the metadata directly, exactly as v2 did, avoids both: the
 * written set is scoped to precisely the resources requested (no
 * ancestor-walk fan-out) and it doesn't depend on any pack/aspect being
 * registered.
 *
 * `Validations.of(...).acknowledge()` is ALSO called (best-effort) so
 * that v3's OWN policy-validation framework — which throws on an
 * unsuppressed finding during `app.synth()`, unlike v2's non-blocking
 * Annotations — treats the same rule as acknowledged when
 * `AwsSolutionsChecks` IS registered via `Validations.of(app).addPlugins(...)`
 * (the production path, bin/app.ts). This acknowledgment is scoped to the
 * exact construct(s) targeted, mirroring v2's own scope; it does not
 * additionally rely on the CFN-metadata-writing aspect.
 *
 * `appliesTo` (v2's per-finding regex/string narrowing) has no v3
 * `acknowledge()` equivalent (no regex primitive); the `Validations`
 * acknowledgment call always uses the bare rule id, which is a strict
 * widening (acknowledges every finding for that rule on that construct,
 * not just ones matching the original regex). The written CFN metadata,
 * however, still records the `appliesTo` value verbatim via
 * `NagSuppressionHelper`-equivalent logic below, preserving the v2 audit
 * trail shape byte-for-byte.
 */
import { CfnResource, IAspect, Stack, Validations } from "aws-cdk-lib";
import { IConstruct } from "constructs";

export interface NagPackSuppressionAppliesToRegex {
  readonly regex: string;
}

export type NagPackSuppressionAppliesTo =
  string | NagPackSuppressionAppliesToRegex;

export interface NagPackSuppression {
  readonly id: string;
  readonly reason: string;
  readonly appliesTo?: NagPackSuppressionAppliesTo[];
}

interface CdkNagMetadata {
  rules_to_suppress: NagPackSuppression[];
}

/** Merge new suppressions into an existing cdk_nag metadata block, matching
 * v2's NagSuppressionHelper.addRulesToMetadata exactly: serialize each rule
 * (existing + new) to JSON and dedup via Set. This dedup is load-bearing,
 * not cosmetic — `findAll()` on an L2 construct yields both the L2 wrapper
 * (which resolves via `defaultChild` to its underlying CfnResource) and
 * that same CfnResource again directly, so a single `addResourceSuppressions(
 * role, [...], true)` call visits one physical resource twice in the same
 * loop. v2 relies on this dedup to collapse that back to one entry; without
 * it, every `applyToChildren: true` suppression call doubles up on affected
 * resources (confirmed via the before/after suppression-metadata diff for
 * this migration — 451 duplicate rule-id entries appeared before this dedup
 * was added).
 *
 * Also matches v2's `toCfnFormat`: a reason containing any character whose
 * code point exceeds 255 is base64-encoded with `is_reason_encoded: true`
 * set alongside it (v2's own workaround for characters CloudFormation
 * Metadata does not always round-trip cleanly, e.g. em dashes/smart quotes
 * used throughout this repo's suppression reasons). Skipping this step
 * produced a plain-UTF-8 vs. base64 byte-level diff against the v2
 * baseline on every reason using such characters (confirmed via the
 * before/after suppression-metadata diff for this migration). */
function toCfnFormat(s: NagPackSuppression): Record<string, unknown> {
  const { appliesTo, reason, ...rest } = s;
  const result: Record<string, unknown> = { ...rest };
  if (appliesTo) {
    result.applies_to = appliesTo;
  }
  const needsEncoding = [...reason].some((ch) => {
    const cp = ch.codePointAt(0);
    return cp !== undefined && cp > 255;
  });
  if (needsEncoding) {
    result.is_reason_encoded = true;
    return { reason: Buffer.from(reason).toString("base64"), ...result };
  }
  return { reason, ...result };
}

function addRulesToMetadata(
  existing: CdkNagMetadata | undefined,
  suppressions: NagPackSuppression[],
): CdkNagMetadata {
  const existingRules = existing?.rules_to_suppress ?? [];
  const serialized = [
    ...existingRules.map((r) => JSON.stringify(r)),
    ...suppressions.map((s) => JSON.stringify(toCfnFormat(s))),
  ];
  const deduplicated = Array.from(new Set(serialized));
  return { rules_to_suppress: deduplicated.map((r) => JSON.parse(r)) };
}

/** Best-effort v3 acknowledgment so AwsSolutionsChecks (when registered via
 * Validations.of(app).addPlugins(...)) does not throw on this rule for this
 * construct. See appliesTo caveat in the module doc comment above. */
function acknowledgeForV3Validation(
  construct: IConstruct,
  suppressions: NagPackSuppression[],
): void {
  const validations = Validations.of(construct);
  for (const s of suppressions) {
    validations.acknowledge({ id: s.id, reason: s.reason });
  }
}

export class NagSuppressions {
  /**
   * Apply cdk-nag suppressions to a Stack and optionally nested stacks.
   * Matches v2: writes to `stack.templateOptions.metadata.cdk_nag`
   * (template-root Metadata, not a per-resource block).
   */
  static addStackSuppressions(
    stack: Stack,
    suppressions: NagPackSuppression[],
    applyToNestedStacks = false,
  ): void {
    const stacks = applyToNestedStacks
      ? stack.node.findAll().filter((x): x is Stack => x instanceof Stack)
      : [stack];
    for (const s of stacks) {
      const existing = s.templateOptions.metadata?.cdk_nag as
        CdkNagMetadata | undefined;
      const metadata = addRulesToMetadata(existing, suppressions);
      if (!s.templateOptions.metadata) {
        s.templateOptions.metadata = {};
      }
      s.templateOptions.metadata.cdk_nag = metadata;
      acknowledgeForV3Validation(s, suppressions);
    }
  }

  /**
   * Add cdk-nag suppressions to a CfnResource (or IConstruct) and
   * optionally its children. Matches v2: for each target construct, if
   * `applyToChildren` walks `node.findAll()`, else just the construct
   * itself; writes metadata only on nodes that resolve (directly or via
   * `node.defaultChild`) to a `CfnResource`.
   */
  static addResourceSuppressions(
    construct: IConstruct | IConstruct[],
    suppressions: NagPackSuppression[],
    applyToChildren = false,
  ): void {
    const constructs = Array.isArray(construct) ? construct : [construct];
    if (constructs.length === 0) {
      throw new Error("Construct cannot be an empty array.");
    }
    for (const c of constructs) {
      const targets = applyToChildren ? c.node.findAll() : [c];
      for (const child of targets) {
        const possibleL1 = child.node.defaultChild
          ? child.node.defaultChild
          : child;
        if (CfnResource.isCfnResource(possibleL1)) {
          const resource = possibleL1 as CfnResource;
          const existing = resource.getMetadata("cdk_nag") as
            CdkNagMetadata | undefined;
          const metadata = addRulesToMetadata(existing, suppressions);
          resource.addMetadata("cdk_nag", metadata);
          acknowledgeForV3Validation(resource, suppressions);
        }
      }
    }
  }

  /**
   * Add cdk-nag suppressions to a CfnResource(s) resolved by construct
   * path under a Stack. Matches v2's path-matching (`node.path` equal to
   * the given path, or `node.path + '/Resource'` equal to it).
   */
  static addResourceSuppressionsByPath(
    stack: Stack,
    path: string | string[],
    suppressions: NagPackSuppression[],
    applyToChildren = false,
  ): void {
    const paths = Array.isArray(path) ? path : [path];
    if (paths.length === 0) {
      throw new Error("Path cannot be an empty array.");
    }
    for (const p of paths) {
      let added = false;
      const fixedPath = p.replace(/^\//, "");
      for (const child of stack.node.findAll()) {
        if (
          child.node.path === fixedPath ||
          `${child.node.path}/Resource` === fixedPath
        ) {
          NagSuppressions.addResourceSuppressions(
            child,
            suppressions,
            applyToChildren,
          );
          added = true;
        }
      }
      if (!added) {
        throw new Error(
          `Suppression path "${p}" did not match any resource. This can occur ` +
            `when a resource does not exist or if a suppression is applied ` +
            `before a resource is created.`,
        );
      }
    }
  }
}

// Re-export so callers that imported construct-level types from "cdk-nag"
// directly (none currently do, but keep parity) can switch their import
// source without a second type definition.
export type { CfnResource, IAspect };
