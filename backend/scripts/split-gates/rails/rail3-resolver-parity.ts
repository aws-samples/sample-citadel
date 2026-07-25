/**
 * Rail 3 — resolver parity.
 *
 * Merges the AWS::AppSync::Resolver set across ALL stack templates
 * (backend + every satellite, though in this no-move stage the satellite
 * list is empty) and asserts:
 *   - the merged typeName.fieldName set equals the baseline's set exactly
 *     (no field lost, no field gained).
 *   - no typeName.fieldName is attached in more than one stack (CFN forbids
 *     double-attaching a resolver to the same field).
 */
import { CfnTemplate, StackBaseline } from "../types";
import { extractResolverKeys } from "../template-utils";
import { RailResult, RailViolation } from "../types";

export interface NamedTemplate {
  stackName: string;
  template: CfnTemplate;
}

export function runResolverParity(
  baseline: StackBaseline,
  stacks: NamedTemplate[],
): RailResult {
  const violations: RailViolation[] = [];
  const baselineKeys = new Set(Object.keys(baseline.resolvers));

  // key -> list of stack names that define it (any list of length > 1 = double-attach)
  const mergedOwners = new Map<string, string[]>();

  for (const { stackName, template } of stacks) {
    const keys = extractResolverKeys(template);
    for (const [key, logicalIds] of keys) {
      const owners = mergedOwners.get(key) ?? [];
      // A single stack defining the same field twice is also a double-attach.
      for (let i = 0; i < logicalIds.length; i++) {
        owners.push(stackName);
      }
      mergedOwners.set(key, owners);
    }
  }

  const mergedKeys = new Set(mergedOwners.keys());

  const missing = [...baselineKeys].filter((k) => !mergedKeys.has(k));
  const extra = [...mergedKeys].filter((k) => !baselineKeys.has(k));

  for (const key of missing) {
    violations.push({
      rail: "rail3",
      logicalId: key,
      message: `Resolver field "${key}" is present in the baseline but missing from the merged stack set. It must exist in exactly one stack.`,
    });
  }
  for (const key of extra) {
    violations.push({
      rail: "rail3",
      logicalId: key,
      message: `Resolver field "${key}" appears in the merged stack set but was not in the baseline. Unexpected new field.`,
    });
  }
  for (const [key, owners] of mergedOwners) {
    if (owners.length > 1) {
      violations.push({
        rail: "rail3",
        logicalId: key,
        message: `Resolver field "${key}" is attached in more than one place (${owners.join(", ")}). CloudFormation forbids double-attaching a resolver to the same field.`,
      });
    }
  }

  return {
    rail: "rail3",
    name: "resolver parity",
    passed: violations.length === 0,
    violations,
  };
}
