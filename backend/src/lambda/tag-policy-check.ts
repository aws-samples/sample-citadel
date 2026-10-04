/**
 * Tag-policy enforcement adapter for TS Lambda call sites.
 *
 * CIT-042 PR2: loads the organisation's tag policy from DynamoDB,
 * validates the supplied tags, and either warns (permissive/shadow) or
 * throws (strict) depending on the governance enforcement mode.
 *
 * Mirrors the pattern in record-approval-check.ts:
 *   - Mode collapse: permissive & shadow both = warn + proceed.
 *   - Only strict throws.
 *   - Structured console.warn for CloudWatch Logs Insights.
 *   - EMF metric for violations (never throws).
 *   - Named error class for callers to catch.
 *
 * Policy lookup failure:
 *   - strict  → TagPolicyLookupError (fail-closed)
 *   - shadow/permissive → console.warn + return { ok: true } (proceed)
 */

import { DynamoDBClient } from "@aws-sdk/client-dynamodb";
import { DynamoDBDocumentClient, GetCommand } from "@aws-sdk/lib-dynamodb";
import { emitMetrics } from "../utils/emf";
import {
  getGovernanceEnforce,
  type GovernanceEnforce,
} from "../utils/governance-flag";
import {
  validateTagsAgainstPolicy,
  type TagPolicy,
  type TagViolation,
} from "../utils/tag-policy";

// ─── DynamoDB client (singleton per Lambda container) ───────────────────

const client = new DynamoDBClient({});
const docClient = DynamoDBDocumentClient.from(client, {
  marshallOptions: { removeUndefinedValues: true },
});

const ORGANIZATIONS_TABLE = process.env.ORGANIZATIONS_TABLE || "";

// ─── Per-invocation policy cache ────────────────────────────────────────

/**
 * Simple per-invocation memo (not cross-invocation). Each Lambda invocation
 * is single-threaded, so a plain Map suffices. Cleared automatically when
 * the handler returns and the module scope is garbage collected on cold
 * starts. Across warm invocations, the cache persists — which is acceptable
 * because tag policies are org-level settings that change infrequently.
 */
const policyCache = new Map<string, TagPolicy | null>();

async function loadTagPolicy(orgId: string): Promise<TagPolicy | null> {
  if (policyCache.has(orgId)) {
    return policyCache.get(orgId)!;
  }

  const result = await docClient.send(
    new GetCommand({
      TableName: ORGANIZATIONS_TABLE,
      Key: { orgId: `TAG_POLICY#${orgId}` },
    }),
  );

  const policy =
    result.Item?.policy !== undefined
      ? (result.Item.policy as TagPolicy)
      : null;

  policyCache.set(orgId, policy);
  return policy;
}

// ─── Error classes ──────────────────────────────────────────────────────

export type TagPolicyAction =
  | "createAgent"
  | "updateAgent"
  | "createTool"
  | "updateTool"
  | "importAgent"
  | "publish"
  | "createDatastore"
  | "createIntegration"
  | "fabricateAgent"
  | "fabricateTool";

/**
 * Thrown in strict mode when tags do not satisfy the org's tag policy.
 * Extends Error directly (not ConnectorError) — this is a governance error,
 * not a connector error, matching RecordNotApprovedError's precedent.
 */
export class TagPolicyViolationError extends Error {
  readonly code = "TAG_POLICY_VIOLATION" as const;

  constructor(
    public readonly violations: TagViolation[],
    public readonly action: TagPolicyAction,
    public readonly orgId: string,
  ) {
    const missingKeys = violations
      .filter((v) => v.type === "MISSING_KEY")
      .map((v) => v.key);
    const invalidValues = violations
      .filter((v) => v.type === "INVALID_VALUE")
      .map((v) => v.key);

    const parts: string[] = [];
    if (missingKeys.length > 0) {
      parts.push(`missing required keys: ${missingKeys.join(", ")}`);
    }
    if (invalidValues.length > 0) {
      parts.push(`invalid values for keys: ${invalidValues.join(", ")}`);
    }

    super(`tag_policy_violation: ${parts.join("; ")}`);
    this.name = "TagPolicyViolationError";
  }
}

/**
 * Thrown in strict mode when the tag policy itself cannot be loaded
 * (DynamoDB failure, missing table, etc.). Fail-closed: a lookup failure
 * in strict mode must not silently pass tags through.
 */
export class TagPolicyLookupError extends Error {
  readonly code = "TAG_POLICY_LOOKUP_FAILURE" as const;

  constructor(
    public readonly orgId: string,
    public readonly cause: unknown,
  ) {
    super(
      `tag_policy_lookup_failure: unable to load tag policy for org ${orgId}`,
    );
    this.name = "TagPolicyLookupError";
  }
}

// ─── Enforcement result ─────────────────────────────────────────────────

export interface EnforceTagPolicyResult {
  ok: boolean;
  violations: TagViolation[];
}

// ─── Main enforcement function ──────────────────────────────────────────

export interface EnforceTagPolicyInput {
  orgId: string;
  tags: Record<string, string> | undefined | null;
  action: TagPolicyAction;
  /** Informational only — included in logs and error messages. */
  subjectId?: string;
  /** AppSync event — used only for deriving the environment string. */
  event?: { env?: string };
}

/**
 * Loads the org's tag policy, validates the supplied tags, and enforces
 * the governance mode.
 *
 * - permissive/shadow: console.warn(would_block) + EMF metric + return result
 * - strict: throw TagPolicyViolationError
 * - policy lookup failure + strict: throw TagPolicyLookupError (fail closed)
 * - policy lookup failure + shadow/permissive: warn and return { ok: true }
 */
export async function enforceTagPolicy(
  input: EnforceTagPolicyInput,
): Promise<EnforceTagPolicyResult> {
  const { orgId, tags, action, subjectId } = input;
  const env = input.event?.env ?? process.env.ENVIRONMENT ?? "dev";

  const mode: GovernanceEnforce = await getGovernanceEnforce(env);

  // If mode is permissive, skip enforcement entirely (no DynamoDB read)
  if (mode === "permissive") {
    return { ok: true, violations: [] };
  }

  // Load policy — handle lookup failure per mode
  let policy: TagPolicy | null;
  try {
    policy = await loadTagPolicy(orgId);
  } catch (err) {
    if (mode === "strict") {
      throw new TagPolicyLookupError(orgId, err);
    }
    // shadow: warn and proceed
    console.warn(
      JSON.stringify({
        level: "warn",
        message: "tag-policy-check: lookup_failure",
        orgId,
        action,
        subjectId: subjectId ?? null,
        mode,
        error: err instanceof Error ? err.message : String(err),
      }),
    );
    return { ok: true, violations: [] };
  }

  // No policy → nothing to enforce
  if (policy === null) {
    return { ok: true, violations: [] };
  }

  // Validate
  const result = validateTagsAgainstPolicy(policy, tags);
  if (result.ok) {
    return { ok: true, violations: [] };
  }

  // Violation detected — act per mode
  const logPayload = {
    level: "warn",
    message: "tag-policy-check: would_block",
    orgId,
    action,
    subjectId: subjectId ?? null,
    mode,
    violations: result.violations,
  };

  if (mode === "strict") {
    throw new TagPolicyViolationError(result.violations, action, orgId);
  }

  // shadow: warn + metric + return violations
  console.warn(JSON.stringify(logPayload));

  emitMetrics({
    namespace: "Citadel/Governance",
    metrics: [{ name: `TagPolicyWouldBlock`, value: 1, unit: "Count" }],
    dimensions: { Action: action, OrgId: orgId, Mode: mode },
    properties: { subjectId: subjectId ?? null },
  });

  return { ok: false, violations: result.violations };
}

/** Test-only: clear the per-invocation policy cache. */
export function __resetPolicyCacheForTest(): void {
  policyCache.clear();
}
