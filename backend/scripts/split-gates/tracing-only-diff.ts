/**
 * backend/scripts/split-gates/tracing-only-diff.ts
 *
 * Tracing foundation (architect task 5459301e-1e7b-4bfd-bccb-b106aba2748c,
 * design §3.1). Proves that every delta between the committed backend
 * baseline and a fresh synth is EXCLUSIVELY a tracing-substrate mutation —
 * this REPLACES rail 1 as the meaningful gate for the tracing commit (rail
 * 1 would trivially pass post-baseline-regeneration and prove nothing
 * about intent, since the baseline is rewritten in the same commit).
 *
 * Allowlisted change classes (everything else is a FAIL):
 *   1. ADDED `Properties.TracingConfig` on an `AWS::Lambda::Function`,
 *      value deep-equals `{ "Mode": "Active" }`.
 *   2. ADDED element in `Properties.ManagedPolicyArns` of an
 *      `AWS::IAM::Role` that resolves to the literal suffix
 *      `:iam::aws:policy/AWSXRayDaemonWriteAccess` (accepts the CFN
 *      `Fn::Join`/`Fn::Sub` intrinsic forms CDK emits for a managed-policy
 *      ARN, not just a bare string).
 *
 * Anything else — an added/removed logical ID, a removed property, any
 * modified value not in the allowlist above, ANY change at all to
 * `AWS::AppSync::GraphQLApi` (its `XrayEnabled` was already `true` before
 * this story — its diff MUST be empty), or any change to a stateful
 * resource — FAILs with the offending JSON path + logical ID.
 *
 * Usage:
 *   npx ts-node -P tsconfig.scripts.json scripts/split-gates/tracing-only-diff.ts \
 *     --old <path to a full CfnTemplate captured pre-tracing> [--env dev] [--cdk-out cdk.out]
 *
 * `--old` is REQUIRED and must point at a full `cdk synth` template JSON
 * (e.g. a copy of `cdk.out/citadel-backend-<env>.template.json` taken on the
 * pre-tracing commit) — NOT the committed `split-baseline/*.json`. That file
 * only stores full `Properties` for stateful resource types (DynamoDB
 * tables, Cognito, etc. — see `types.ts`'s `isStatefulType`), so Lambda
 * functions and IAM roles, the two resource types this gate diffs, come
 * through as `properties: undefined`. Comparing against that shape makes
 * every Lambda/Role property look freshly "ADDED", which is a false
 * positive unrelated to tracing. `main()` detects and rejects that shape
 * with an explanatory error rather than silently producing bogus violations.
 *
 * Exit code 0 = PASS (tracing-only diff, or no diff at all).
 * Exit code 1 = FAIL (a non-tracing mutation was found) or missing inputs.
 */
import * as fs from "fs";
import * as path from "path";
import {
  loadTemplate,
  isStatefulType,
  stableStringify,
} from "./template-utils";
import { CfnTemplate, CfnResource } from "./types";

export interface TracingDiffViolation {
  logicalId: string;
  path: string;
  message: string;
}

export interface TracingDiffResult {
  passed: boolean;
  violations: TracingDiffViolation[];
  tracingConfigAdditions: number;
  managedPolicyAdditions: number;
}

const XRAY_MANAGED_POLICY_SUFFIX = ":iam::aws:policy/AWSXRayDaemonWriteAccess";

/** True iff `value` is the CFN literal `{ Mode: "Active" }` (order-insensitive, no extra keys). */
function isActiveTracingConfig(value: unknown): boolean {
  if (value === null || typeof value !== "object" || Array.isArray(value)) {
    return false;
  }
  const keys = Object.keys(value as Record<string, unknown>);
  if (keys.length !== 1 || keys[0] !== "Mode") {
    return false;
  }
  return (value as Record<string, unknown>).Mode === "Active";
}

/** Serialize a managed-policy-ARN entry (string literal, or an Fn::Join/Fn::Sub CDK token) and check for the X-Ray suffix. */
function resolvesToXrayManagedPolicy(entry: unknown): boolean {
  if (typeof entry === "string") {
    return entry.endsWith(XRAY_MANAGED_POLICY_SUFFIX);
  }
  // CDK emits `iam.ManagedPolicy.fromAwsManagedPolicyName(...)` as an
  // Fn::Join over ["arn:", {Ref: AWS::Partition}, ":iam::aws:policy/<name>"]
  // (or occasionally Fn::Sub). Rather than fully resolving the intrinsic,
  // check that the literal suffix string appears somewhere in its
  // serialized form — sufficient to distinguish "this join produces the
  // X-Ray managed policy ARN" from any other managed policy addition,
  // without over-claiming full CFN intrinsic evaluation.
  const serialized = stableStringify(entry);
  return serialized.includes(XRAY_MANAGED_POLICY_SUFFIX);
}

/** Deep-diff two arbitrary JSON values, returning every leaf path that changed (added/removed/modified). */
type LeafChange =
  | { kind: "added"; path: string; newValue: unknown }
  | { kind: "removed"; path: string; oldValue: unknown }
  | { kind: "modified"; path: string; oldValue: unknown; newValue: unknown };

function diffValues(
  oldValue: unknown,
  newValue: unknown,
  pathPrefix: string,
): LeafChange[] {
  if (stableStringify(oldValue) === stableStringify(newValue)) {
    return [];
  }

  const oldIsObj =
    oldValue !== null &&
    typeof oldValue === "object" &&
    !Array.isArray(oldValue);
  const newIsObj =
    newValue !== null &&
    typeof newValue === "object" &&
    !Array.isArray(newValue);

  if (oldIsObj && newIsObj) {
    const changes: LeafChange[] = [];
    const oldObj = oldValue as Record<string, unknown>;
    const newObj = newValue as Record<string, unknown>;
    const allKeys = new Set([...Object.keys(oldObj), ...Object.keys(newObj)]);
    for (const key of allKeys) {
      const childPath = pathPrefix ? `${pathPrefix}.${key}` : key;
      if (!(key in oldObj)) {
        changes.push({ kind: "added", path: childPath, newValue: newObj[key] });
      } else if (!(key in newObj)) {
        changes.push({
          kind: "removed",
          path: childPath,
          oldValue: oldObj[key],
        });
      } else {
        changes.push(...diffValues(oldObj[key], newObj[key], childPath));
      }
    }
    return changes;
  }

  // Arrays, primitives, or a type-shape change (object <-> non-object):
  // treat as a single leaf modification/add/remove at this path — arrays
  // in CFN templates (e.g. ManagedPolicyArns) are compared as whole-list
  // adds/removes by the caller (isAllowedManagedPolicyArraysDiff), not
  // element-by-element here, to keep "one new array element" readable as
  // an ADD rather than a same-length "modified" on the whole array.
  if (oldValue === undefined) {
    return [{ kind: "added", path: pathPrefix, newValue }];
  }
  if (newValue === undefined) {
    return [{ kind: "removed", path: pathPrefix, oldValue }];
  }
  return [{ kind: "modified", path: pathPrefix, oldValue, newValue }];
}

function classifyResourceDiff(
  logicalId: string,
  oldRes: CfnResource | undefined,
  newRes: CfnResource | undefined,
): TracingDiffViolation[] {
  const violations: TracingDiffViolation[] = [];

  if (oldRes === undefined) {
    violations.push({
      logicalId,
      path: logicalId,
      message: `New logical ID "${logicalId}" was added — not an allowlisted tracing mutation.`,
    });
    return violations;
  }
  if (newRes === undefined) {
    violations.push({
      logicalId,
      path: logicalId,
      message: `Logical ID "${logicalId}" was removed — the tracing commit must not remove resources.`,
    });
    return violations;
  }
  if (oldRes.Type !== newRes.Type) {
    violations.push({
      logicalId,
      path: `${logicalId}.Type`,
      message: `Type changed: ${oldRes.Type} -> ${newRes.Type}.`,
    });
    return violations;
  }

  // Any change at all to AppSync::GraphQLApi must FAIL — XrayEnabled was
  // already true before this story; its diff must be empty.
  if (oldRes.Type === "AWS::AppSync::GraphQLApi") {
    const changes = diffValues(
      oldRes.Properties ?? {},
      newRes.Properties ?? {},
      `${logicalId}.Properties`,
    );
    for (const change of changes) {
      violations.push({
        logicalId,
        path: change.path,
        message: `AWS::AppSync::GraphQLApi property changed (XrayEnabled was already true before this story — no change permitted here).`,
      });
    }
    return violations;
  }

  // Any change to a stateful resource type is disallowed outright.
  if (isStatefulType(oldRes.Type)) {
    const changes = diffValues(
      oldRes.Properties ?? {},
      newRes.Properties ?? {},
      `${logicalId}.Properties`,
    );
    for (const change of changes) {
      violations.push({
        logicalId,
        path: change.path,
        message: `Stateful resource (${oldRes.Type}) property changed — the tracing commit must not touch stateful resources.`,
      });
    }
    if (oldRes.DeletionPolicy !== newRes.DeletionPolicy) {
      violations.push({
        logicalId,
        path: `${logicalId}.DeletionPolicy`,
        message: `DeletionPolicy changed on a stateful resource.`,
      });
    }
    return violations;
  }

  if (oldRes.Type === "AWS::Lambda::Function") {
    const oldProps = oldRes.Properties ?? {};
    const newProps = newRes.Properties ?? {};
    const changes = diffValues(oldProps, newProps, `${logicalId}.Properties`);
    for (const change of changes) {
      if (
        change.kind === "added" &&
        change.path === `${logicalId}.Properties.TracingConfig` &&
        isActiveTracingConfig(change.newValue)
      ) {
        continue; // allowlisted: rule 1
      }
      violations.push({
        logicalId,
        path: change.path,
        message: describeChange(change, "AWS::Lambda::Function"),
      });
    }
    return violations;
  }

  if (oldRes.Type === "AWS::IAM::Role") {
    const oldArns = (oldRes.Properties?.ManagedPolicyArns as unknown[]) ?? [];
    const newArns = (newRes.Properties?.ManagedPolicyArns as unknown[]) ?? [];

    const oldSerialized = oldArns.map((a) => stableStringify(a));
    const addedArns = newArns.filter(
      (a) => !oldSerialized.includes(stableStringify(a)),
    );
    const removedArns = oldArns.filter(
      (a) =>
        !newArns.map((n) => stableStringify(n)).includes(stableStringify(a)),
    );

    for (const removed of removedArns) {
      violations.push({
        logicalId,
        path: `${logicalId}.Properties.ManagedPolicyArns`,
        message: `A ManagedPolicyArns entry was removed: ${stableStringify(removed)}.`,
      });
    }
    for (const added of addedArns) {
      if (!resolvesToXrayManagedPolicy(added)) {
        violations.push({
          logicalId,
          path: `${logicalId}.Properties.ManagedPolicyArns`,
          message: `A non-X-Ray ManagedPolicyArns entry was added: ${stableStringify(added)}.`,
        });
      }
    }

    // Any OTHER property change on the role (not ManagedPolicyArns) is disallowed.
    const oldPropsWithoutArns = { ...(oldRes.Properties ?? {}) };
    const newPropsWithoutArns = { ...(newRes.Properties ?? {}) };
    delete (oldPropsWithoutArns as Record<string, unknown>).ManagedPolicyArns;
    delete (newPropsWithoutArns as Record<string, unknown>).ManagedPolicyArns;
    const otherChanges = diffValues(
      oldPropsWithoutArns,
      newPropsWithoutArns,
      `${logicalId}.Properties`,
    );
    for (const change of otherChanges) {
      violations.push({
        logicalId,
        path: change.path,
        message: describeChange(change, "AWS::IAM::Role"),
      });
    }
    return violations;
  }

  // Any other resource type: no change permitted at all.
  const changes = diffValues(
    oldRes.Properties ?? {},
    newRes.Properties ?? {},
    `${logicalId}.Properties`,
  );
  for (const change of changes) {
    violations.push({
      logicalId,
      path: change.path,
      message: describeChange(change, oldRes.Type),
    });
  }
  return violations;
}

function describeChange(change: LeafChange, resourceType: string): string {
  switch (change.kind) {
    case "added":
      return `Unexpected ADDED property on ${resourceType}: ${stableStringify(change.newValue)}.`;
    case "removed":
      return `Unexpected REMOVED property on ${resourceType}: ${stableStringify(change.oldValue)}.`;
    case "modified":
      return `Unexpected MODIFIED property on ${resourceType}: ${stableStringify(change.oldValue)} -> ${stableStringify(change.newValue)}.`;
  }
}

export function runTracingOnlyDiff(
  baseline: CfnTemplate,
  fresh: CfnTemplate,
): TracingDiffResult {
  const violations: TracingDiffViolation[] = [];
  let tracingConfigAdditions = 0;
  let managedPolicyAdditions = 0;

  const allIds = new Set([
    ...Object.keys(baseline.Resources),
    ...Object.keys(fresh.Resources),
  ]);

  for (const logicalId of allIds) {
    const oldRes = baseline.Resources[logicalId];
    const newRes = fresh.Resources[logicalId];
    const resourceViolations = classifyResourceDiff(logicalId, oldRes, newRes);
    violations.push(...resourceViolations);

    if (
      resourceViolations.length === 0 &&
      newRes?.Type === "AWS::Lambda::Function" &&
      oldRes?.Properties?.TracingConfig === undefined &&
      isActiveTracingConfig(newRes.Properties?.TracingConfig)
    ) {
      tracingConfigAdditions++;
    }
    if (resourceViolations.length === 0 && newRes?.Type === "AWS::IAM::Role") {
      const oldArns =
        (oldRes?.Properties?.ManagedPolicyArns as unknown[]) ?? [];
      const newArns = (newRes.Properties?.ManagedPolicyArns as unknown[]) ?? [];
      const oldSerialized = oldArns.map((a) => stableStringify(a));
      const added = newArns.filter(
        (a) => !oldSerialized.includes(stableStringify(a)),
      );
      managedPolicyAdditions += added.filter(
        resolvesToXrayManagedPolicy,
      ).length;
    }
  }

  // Outputs (Export.Name / Value) must be byte-identical — the tracing
  // commit touches Lambda/Role resources only, never Outputs.
  const outputChanges = diffValues(
    baseline.Outputs ?? {},
    fresh.Outputs ?? {},
    "Outputs",
  );
  for (const change of outputChanges) {
    violations.push({
      logicalId: "(Outputs)",
      path: change.path,
      message: describeChange(change, "Outputs"),
    });
  }

  return {
    passed: violations.length === 0,
    violations,
    tracingConfigAdditions,
    managedPolicyAdditions,
  };
}

function parseArgs(argv: string[]): {
  oldPath?: string;
  env: string;
  cdkOutDir: string;
} {
  let oldPath: string | undefined;
  let env = "dev";
  let cdkOutDir = "cdk.out";
  for (let i = 0; i < argv.length; i++) {
    if (argv[i] === "--old" && argv[i + 1]) {
      oldPath = argv[i + 1];
      i++;
    } else if (argv[i] === "--env" && argv[i + 1]) {
      env = argv[i + 1];
      i++;
    } else if (argv[i] === "--cdk-out" && argv[i + 1]) {
      cdkOutDir = argv[i + 1];
      i++;
    }
  }
  return { oldPath, env, cdkOutDir };
}

/** Build a CfnTemplate-shaped object from a committed StackBaseline (same shape run-rails.ts builds for rail 1).
 *
 * IMPORTANT LIMITATION discovered while implementing this gate: `StackBaseline`
 * (types.ts) only stores full `Properties` for STATEFUL resource types (see
 * `baseline-builder.ts`: `properties: isStatefulType(res.Type) ? (res.Properties ?? {}) : undefined`).
 * Lambda functions and IAM roles — exactly the resource types this gate needs
 * to diff — are NOT stateful types, so the committed
 * `split-baseline/citadel-backend-<env>.json` carries `properties: undefined`
 * for every Lambda/Role. Converting that through this function makes EVERY
 * property on those resources look "ADDED" relative to a fresh synth — a
 * false positive that has nothing to do with tracing.
 *
 * Consequently this function (and therefore comparing against the committed
 * baseline) is NOT suitable as the `--old` input for this gate. Always pass
 * `--old <path to a full CfnTemplate captured via 'cdk synth' BEFORE the
 * tracing change>` instead (see the CLI usage note above `main()`). This
 * helper is kept only for the case where a caller explicitly opts into it
 * (e.g. to confirm the Outputs-only comparison still degrades gracefully),
 * not as the default path.
 */
function baselineToTemplate(baseline: {
  resources: Record<
    string,
    {
      type: string;
      deletionPolicy?: string;
      updateReplacePolicy?: string;
      properties?: Record<string, unknown>;
    }
  >;
  exports: Record<string, { exportName: unknown; value: unknown }>;
}): CfnTemplate {
  return {
    Resources: Object.fromEntries(
      Object.entries(baseline.resources).map(([logicalId, r]) => [
        logicalId,
        {
          Type: r.type,
          DeletionPolicy: r.deletionPolicy,
          UpdateReplacePolicy: r.updateReplacePolicy,
          Properties: r.properties ?? {},
        },
      ]),
    ),
    Outputs: Object.fromEntries(
      Object.entries(baseline.exports).map(([name, e]) => [
        name,
        { Value: e.value, Export: { Name: e.exportName } },
      ]),
    ),
  };
}

function main(): void {
  const { oldPath, env, cdkOutDir } = parseArgs(process.argv.slice(2));
  const backendDir = path.resolve(__dirname, "..", "..");
  const stackName = `citadel-backend-${env}`;

  if (!oldPath) {
    process.stderr.write(
      `ERROR: --old <path to a full CfnTemplate captured pre-tracing> is required.\n` +
        `The committed split-baseline/${stackName}.json is NOT a valid input for this\n` +
        `gate — see the doc comment on baselineToTemplate() for why.\n`,
    );
    process.exit(1);
  }
  const baselinePath = oldPath;
  const freshTemplatePath = path.join(
    backendDir,
    cdkOutDir,
    `${stackName}.template.json`,
  );

  if (!fs.existsSync(baselinePath)) {
    process.stderr.write(`ERROR: baseline not found at ${baselinePath}.\n`);
    process.exit(1);
  }
  if (!fs.existsSync(freshTemplatePath)) {
    process.stderr.write(
      `ERROR: fresh template not found at ${freshTemplatePath}. Run 'npx cdk synth ${stackName}' first.\n`,
    );
    process.exit(1);
  }

  const rawBaseline = JSON.parse(fs.readFileSync(baselinePath, "utf-8"));
  // Accept a raw CfnTemplate (Resources/Outputs keys) directly. Reject the
  // StackBaseline shape (resources/exports keys, lowercase) outright rather
  // than silently degrading through the lossy properties-only-for-stateful-
  // types conversion (see baselineToTemplate's doc comment) — that
  // conversion produces false-positive violations for every Lambda/Role
  // property, which would make this gate useless for its actual purpose.
  if ("resources" in rawBaseline && !("Resources" in rawBaseline)) {
    process.stderr.write(
      `ERROR: ${baselinePath} is a StackBaseline (split-baseline/*.json), not a full CfnTemplate.\n` +
        `StackBaseline only stores full Properties for STATEFUL resource types — Lambda\n` +
        `functions and IAM roles (which this gate diffs) are not stateful, so comparing\n` +
        `against it produces false-positive violations on every Lambda/Role property.\n` +
        `Pass --old pointing at a full CfnTemplate captured via 'cdk synth' BEFORE the\n` +
        `tracing change instead (e.g. a copy of cdk.out/${stackName}.template.json taken\n` +
        `on the pre-tracing commit).\n`,
    );
    process.exit(1);
  }
  const baselineTemplate: CfnTemplate =
    "resources" in rawBaseline
      ? baselineToTemplate(rawBaseline)
      : (rawBaseline as CfnTemplate);

  const freshTemplate = loadTemplate(freshTemplatePath);

  const result = runTracingOnlyDiff(baselineTemplate, freshTemplate);

  process.stdout.write(
    `tracing-only-diff: ${result.passed ? "PASS" : "FAIL"}\n` +
      `  TracingConfig additions: ${result.tracingConfigAdditions}\n` +
      `  AWSXRayDaemonWriteAccess additions: ${result.managedPolicyAdditions}\n` +
      `  violations: ${result.violations.length}\n`,
  );
  for (const v of result.violations) {
    process.stdout.write(`  - [${v.logicalId}] ${v.path}: ${v.message}\n`);
  }

  process.exit(result.passed ? 0 : 1);
}

if (require.main === module) {
  main();
}
