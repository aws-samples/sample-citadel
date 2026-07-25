/**
 * Pure helpers for loading and normalizing CDK-synthesized CloudFormation
 * templates. No AWS calls, no filesystem side effects beyond simple reads —
 * kept pure so every gate can be unit-tested with doctored in-memory
 * templates (see rail*.test.ts).
 */
import * as fs from "fs";
import * as crypto from "crypto";
import {
  CfnTemplate,
  CfnResource,
  NormalizedPolicyStatement,
  STATEFUL_TYPES,
} from "./types";

export function loadTemplate(templatePath: string): CfnTemplate {
  const raw = fs.readFileSync(templatePath, "utf-8");
  const parsed = JSON.parse(raw) as CfnTemplate;
  if (!parsed.Resources || typeof parsed.Resources !== "object") {
    throw new Error(
      `Template at ${templatePath} has no Resources section — not a valid CFN template.`,
    );
  }
  return parsed;
}

export function isStatefulType(type: string): boolean {
  return STATEFUL_TYPES.includes(type);
}

export function stableStringify(value: unknown): string {
  return JSON.stringify(sortKeysDeep(value));
}

function sortKeysDeep(value: unknown): unknown {
  if (Array.isArray(value)) {
    return value.map(sortKeysDeep);
  }
  if (value !== null && typeof value === "object") {
    const obj = value as Record<string, unknown>;
    const sorted: Record<string, unknown> = {};
    for (const key of Object.keys(obj).sort()) {
      sorted[key] = sortKeysDeep(obj[key]);
    }
    return sorted;
  }
  return value;
}

export function sha256Hex(input: string): string {
  return crypto.createHash("sha256").update(input, "utf-8").digest("hex");
}

/** Hash a VTL mapping template string (or return null if absent — some resolvers use no mapping template). */
export function hashMappingTemplate(template: unknown): {
  hash: string | null;
  bytes: number;
} {
  if (typeof template !== "string") {
    return { hash: null, bytes: 0 };
  }
  return {
    hash: sha256Hex(template),
    bytes: Buffer.byteLength(template, "utf-8"),
  };
}

/**
 * Extract typeName.fieldName resolvers from a template's Resources.
 * Returns a map keyed by "TypeName.fieldName" -> logical ID list (normally
 * length 1; length > 1 signals a same-stack duplicate, which rail 3 also
 * treats as a violation when merging across stacks).
 */
export function extractResolverKeys(
  template: CfnTemplate,
): Map<string, string[]> {
  const out = new Map<string, string[]>();
  for (const [logicalId, res] of Object.entries(template.Resources)) {
    if (res.Type !== "AWS::AppSync::Resolver") continue;
    const props = res.Properties ?? {};
    const typeName = String(props.TypeName ?? "");
    const fieldName = String(props.FieldName ?? "");
    if (!typeName || !fieldName) continue;
    const key = `${typeName}.${fieldName}`;
    const existing = out.get(key) ?? [];
    existing.push(logicalId);
    out.set(key, existing);
  }
  return out;
}

/**
 * Normalize an IAM policy document's statements into a flat, comparable
 * shape. Handles the common CFN forms: string|string[] for Action/Resource,
 * and Allow/Deny effect. `Resource: "*"` and `NotAction`/`NotResource` are
 * preserved as literal entries (no attempt to expand wildcards) — equality
 * comparison in rail 6 is deliberately conservative (exact-or-subset), not
 * semantic IAM evaluation.
 */
export function normalizePolicyStatements(
  policyDocument: unknown,
): NormalizedPolicyStatement[] {
  if (
    policyDocument === null ||
    typeof policyDocument !== "object" ||
    !("Statement" in (policyDocument as Record<string, unknown>))
  ) {
    return [];
  }
  const statements = (policyDocument as { Statement: unknown }).Statement;
  const list = Array.isArray(statements) ? statements : [statements];
  const out: NormalizedPolicyStatement[] = [];
  for (const stmt of list) {
    if (stmt === null || typeof stmt !== "object") continue;
    const s = stmt as Record<string, unknown>;
    const effect = typeof s.Effect === "string" ? s.Effect : "Allow";
    const actions = toStringArray(s.Action ?? s.NotAction);
    const resources = toStringArray(s.Resource ?? s.NotResource).map(
      resourceToComparableString,
    );
    const conditionKeys = s.Condition
      ? flattenConditionKeys(s.Condition as Record<string, unknown>)
      : [];
    out.push({
      effect,
      actions: actions.sort(),
      resources: resources.sort(),
      conditionKeys: conditionKeys.sort(),
    });
  }
  return out;
}

function toStringArray(value: unknown): string[] {
  if (value === undefined || value === null) return [];
  if (Array.isArray(value)) return value.map(resourceToComparableString);
  return [resourceToComparableString(value)];
}

/**
 * Convert a Resource/Action entry (which may be a literal string or an
 * intrinsic function object like Fn::GetAtt / Fn::Join) into a stable,
 * comparable string. Intrinsics are serialized via stableStringify rather
 * than resolved, since we compare synthesized templates to each other, not
 * to deployed ARNs.
 */
function resourceToComparableString(value: unknown): string {
  if (typeof value === "string") return value;
  return stableStringify(value);
}

function flattenConditionKeys(condition: Record<string, unknown>): string[] {
  const keys: string[] = [];
  for (const [operator, body] of Object.entries(condition)) {
    if (body !== null && typeof body === "object") {
      for (const conditionKey of Object.keys(body as Record<string, unknown>)) {
        keys.push(`${operator}:${conditionKey}`);
      }
    }
  }
  return keys;
}

/** Deep-equal check restricted to a whitelist of top-level property keys. */
export function keyPropsEqual(
  a: Record<string, unknown> | undefined,
  b: Record<string, unknown> | undefined,
  keys: readonly string[],
): { equal: boolean; diffs: string[] } {
  const diffs: string[] = [];
  for (const key of keys) {
    const av = a?.[key];
    const bv = b?.[key];
    if (stableStringify(av) !== stableStringify(bv)) {
      diffs.push(key);
    }
  }
  return { equal: diffs.length === 0, diffs };
}

export function resourcesOfType(
  template: CfnTemplate,
  type: string,
): Array<[string, CfnResource]> {
  return Object.entries(template.Resources).filter(
    ([, res]) => res.Type === type,
  );
}
