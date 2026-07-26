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
  knownLogicalIds?: ReadonlySet<string>,
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
    const actions = toStringArray(s.Action ?? s.NotAction, knownLogicalIds);
    const resources = toStringArray(
      s.Resource ?? s.NotResource,
      knownLogicalIds,
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

function toStringArray(
  value: unknown,
  knownLogicalIds?: ReadonlySet<string>,
): string[] {
  if (value === undefined || value === null) return [];
  if (Array.isArray(value)) {
    return value.map((v) => resourceToComparableString(v, knownLogicalIds));
  }
  return [resourceToComparableString(value, knownLogicalIds)];
}

/**
 * Convert a Resource/Action entry (which may be a literal string or an
 * intrinsic function object like Fn::GetAtt / Fn::Join) into a stable,
 * comparable string. Intrinsics are serialized via stableStringify rather
 * than resolved, since we compare synthesized templates to each other, not
 * to deployed ARNs — EXCEPT for `Fn::GetAtt` and the CDK-auto-generated
 * `Fn::ImportValue` form of the same reference, which are normalized to an
 * identical canonical string. This matters for rail 6 (IAM equivalence):
 * a satellite stack's cross-stack grant on a BackendStack table renders as
 * `Fn::ImportValue "citadel-backend-dev:ExportsOutputFnGetAtt<LogicalId><Attr><hash>"`,
 * while the pre-split baseline (same-stack) grant on the identical table
 * renders as `Fn::GetAtt [LogicalId, Attr]`. Without normalization these
 * look like different resources and every recreate-in-satellite Lambda
 * fails rail 6 on every table/bus/bucket grant it legitimately still needs
 * — a false positive, not a real privilege broadening. CDK's auto-export
 * naming (`ExportsOutputFnGetAtt<LogicalId><Attr><hash8>` /
 * `ExportsOutputRef<LogicalId><hash8>`) is stable across CDK versions used
 * in this repo; the regex below parses it back into the same
 * `GETATT:<LogicalId>:<Attr>` / `REF:<LogicalId>` canonical form
 * `Fn::GetAtt`/`Fn::Ref` produce directly.
 */
function resourceToComparableString(
  value: unknown,
  knownLogicalIds?: ReadonlySet<string>,
): string {
  if (typeof value === "string") return value;
  if (
    value !== null &&
    typeof value === "object" &&
    "Fn::GetAtt" in (value as Record<string, unknown>)
  ) {
    const getAtt = (value as Record<string, unknown>)["Fn::GetAtt"];
    if (Array.isArray(getAtt) && typeof getAtt[0] === "string") {
      const attr = typeof getAtt[1] === "string" ? getAtt[1] : "Ref";
      return `GETATT:${getAtt[0]}:${attr}`;
    }
  }
  if (
    value !== null &&
    typeof value === "object" &&
    "Ref" in (value as Record<string, unknown>) &&
    Object.keys(value as Record<string, unknown>).length === 1
  ) {
    const ref = (value as Record<string, unknown>)["Ref"];
    if (typeof ref === "string") {
      return `GETATT:${ref}:Ref`;
    }
  }
  if (
    value !== null &&
    typeof value === "object" &&
    "Fn::ImportValue" in (value as Record<string, unknown>)
  ) {
    const importName = (value as Record<string, unknown>)["Fn::ImportValue"];
    if (typeof importName === "string") {
      const canonical = canonicalizeImportValue(importName, knownLogicalIds);
      if (canonical) return canonical;
    }
  }
  if (
    value !== null &&
    typeof value === "object" &&
    "Fn::Join" in (value as Record<string, unknown>)
  ) {
    const join = (value as Record<string, unknown>)["Fn::Join"];
    if (
      Array.isArray(join) &&
      typeof join[0] === "string" &&
      Array.isArray(join[1])
    ) {
      const parts = (join[1] as unknown[]).map((p) =>
        resourceToComparableString(p, knownLogicalIds),
      );
      return `JOIN:${join[0]}:${parts.join(join[0])}`;
    }
  }
  return stableStringify(value);
}

/**
 * Parse a CDK-auto-generated cross-stack export name back into the same
 * canonical form `Fn::GetAtt`/`Ref` produce, e.g.
 * `citadel-backend-dev:ExportsOutputFnGetAttAgentStatusTable5F3D8429ArnB509A2EC`
 * -> `GETATT:AgentStatusTable5F3D8429:Arn`, or
 * `citadel-backend-dev:ExportsOutputRefAgentStatusTable5F3D842936E7D685`
 * -> `GETATT:AgentStatusTable5F3D8429:Ref`.
 *
 * A bare regex split is ambiguous: CDK logical IDs themselves end in an
 * 8-hex-char hash (e.g. `AgentEventBusB8B466DF`), which looks identical in
 * shape to the export name's own trailing hash suffix, so a naive
 * "logicalId + attr + hash8" pattern can split at the wrong boundary (e.g.
 * mis-parsing `AgentEventBusB8B466DFArn03EB6E49` as logicalId=
 * `AgentEventBusB8B466`, attr=`DFArn` instead of logicalId=
 * `AgentEventBusB8B466DF`, attr=`Arn`). Disambiguate by matching against
 * the KNOWN logical ID set from the source stack's own baseline (passed by
 * the caller) and picking the longest logical ID that is a valid prefix —
 * this is unambiguous because logical IDs are unique per stack.
 */
function canonicalizeImportValue(
  importName: string,
  knownLogicalIds?: ReadonlySet<string>,
): string | null {
  const colonIdx = importName.indexOf(":");
  const localName = colonIdx >= 0 ? importName.slice(colonIdx + 1) : importName;

  if (knownLogicalIds && knownLogicalIds.size > 0) {
    const getAttPrefix = "ExportsOutputFnGetAtt";
    const refPrefix = "ExportsOutputRef";
    if (localName.startsWith(getAttPrefix)) {
      const rest = localName.slice(getAttPrefix.length);
      const match = findLongestLogicalIdPrefix(rest, knownLogicalIds);
      if (match) {
        const remainder = rest.slice(match.length);
        const attr = remainder.replace(/[0-9A-F]{8}$/, "");
        if (attr) return `GETATT:${match}:${attr}`;
      }
    } else if (localName.startsWith(refPrefix)) {
      const rest = localName.slice(refPrefix.length);
      const match = findLongestLogicalIdPrefix(rest, knownLogicalIds);
      if (match) return `GETATT:${match}:Ref`;
    }
  }

  // Fallback (no known-logical-ID set supplied): best-effort regex parse.
  // May mis-split when the logical ID's own hash collides with the export
  // hash shape, but is still better than treating the whole string opaque.
  const getAttMatch = /^ExportsOutputFnGetAtt(.+?)([A-Za-z]+)[0-9A-F]{8}$/.exec(
    localName,
  );
  if (getAttMatch) {
    return `GETATT:${getAttMatch[1]}:${getAttMatch[2]}`;
  }
  const refMatch = /^ExportsOutputRef(.+?)[0-9A-F]{8}$/.exec(localName);
  if (refMatch) {
    return `GETATT:${refMatch[1]}:Ref`;
  }
  return null;
}

function findLongestLogicalIdPrefix(
  rest: string,
  knownLogicalIds: ReadonlySet<string>,
): string | null {
  let best: string | null = null;
  for (const id of knownLogicalIds) {
    if (rest.startsWith(id) && (best === null || id.length > best.length)) {
      best = id;
    }
  }
  return best;
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
