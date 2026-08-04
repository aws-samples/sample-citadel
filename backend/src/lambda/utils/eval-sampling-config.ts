/**
 * eval-sampling-config.ts (Phase 2 §2.1/§2.2 — production sampling).
 *
 * Two responsibilities, deliberately split:
 *  - PURE (this module, no I/O): `hashToUnitFloat`, `shouldSample`,
 *    `resolveEffectiveRate` — the deterministic sampling decision math.
 *  - I/O (`getEvalSamplingConfig` below): a single GetItem against the
 *    new EvalSamplingConfig table (PK=orgId), admin-authored.
 *
 * shouldSample(runId, rate) = hashToUnitFloat(runId) < rate. Using the
 * server-minted `runId` (see ../../utils/run-id.ts — the sole TS producer)
 * as the hash input makes the decision:
 *  - DETERMINISTIC: the same runId always maps to the same [0,1) float.
 *  - IDEMPOTENT under EventBridge at-least-once redelivery: a duplicate
 *    workflow.completed/conversation-complete delivery for the same runId
 *    recomputes the identical sample/no-sample decision, so the selector
 *    Lambda's own IdempotencyGuard (keyed on runId) is defence-in-depth,
 *    not the only thing preventing a double-sample.
 *  - STATISTICALLY UNIFORM across distinct runIds: FNV-1a is not
 *    cryptographic, but its output bits are well-distributed enough that
 *    a 5% configured rate yields ~5% of distinct runIds sampled (property
 *    test: eval-sampling-config.test.ts).
 *
 * Hard gate (design §2.1): sampling occurs ONLY when the org has opted in
 * (`optIn === true`). `resolveEffectiveRate` returns 0 unconditionally
 * when optIn is false or the config is absent — org opt-in gates
 * everything, with no code path that can sample an org that never opted
 * in, even if a per-agent rate happens to be configured.
 */
import { DynamoDBClient } from "@aws-sdk/client-dynamodb";
import { DynamoDBDocumentClient, GetCommand } from "@aws-sdk/lib-dynamodb";

const dynamoClient = new DynamoDBClient({});
const docClient = DynamoDBDocumentClient.from(dynamoClient);

/**
 * FNV-1a 32-bit hash — a fast, well-distributed, non-cryptographic hash.
 * Deliberately NOT crypto.createHash: this value is never used for any
 * security purpose (it is a sampling coin-flip, not an integrity/auth
 * check), and FNV-1a avoids pulling the `crypto` module into a pure,
 * dependency-free module that fast-check property-tests exhaustively.
 */
function fnv1a32(input: string): number {
  let hash = 0x811c9dc5; // FNV offset basis
  for (let i = 0; i < input.length; i++) {
    hash ^= input.charCodeAt(i);
    // hash *= FNV prime (0x01000193), via shift-add to stay in 32-bit int math
    hash =
      (hash +
        ((hash << 1) +
          (hash << 4) +
          (hash << 7) +
          (hash << 8) +
          (hash << 24))) >>>
      0;
  }
  return hash >>> 0;
}

/**
 * Maps an arbitrary string deterministically to a float in [0, 1).
 * Pure — no Date.now/Math.random/IO. `>>> 0` keeps the hash an unsigned
 * 32-bit integer; dividing by 2^32 yields a value strictly < 1.
 */
export function hashToUnitFloat(input: string): number {
  return fnv1a32(input) / 4294967296; // 2^32
}

/**
 * Deterministic, idempotent sampling decision (design §2.2).
 * `rate` is clamped to [0,1] defensively — a caller-supplied rate outside
 * that range (e.g. a malformed config row) never produces undefined
 * behaviour: <=0 never samples, >=1 always samples.
 */
export function shouldSample(runId: string, rate: number): boolean {
  const clamped = Math.min(1, Math.max(0, rate));
  if (clamped <= 0) return false;
  if (clamped >= 1) return true;
  return hashToUnitFloat(runId) < clamped;
}

export interface EvalSamplingConfig {
  orgId: string;
  optIn: boolean;
  defaultSampleRate: number;
  perAgentSampleRate: Record<string, number>;
  updatedAt?: string;
  updatedBy?: string;
}

function clampRate(rate: number): number {
  if (typeof rate !== "number" || Number.isNaN(rate)) return 0;
  return Math.min(1, Math.max(0, rate));
}

/**
 * Resolves the effective per-agent sample rate from a loaded config row.
 * Hard gate: `optIn !== true` (including an absent config) always
 * resolves to 0 — no code path samples an org that has not explicitly
 * opted in, regardless of what rate values happen to be stored.
 */
export function resolveEffectiveRate(
  config:
    | Pick<
        EvalSamplingConfig,
        "optIn" | "defaultSampleRate" | "perAgentSampleRate"
      >
    | undefined,
  agentId: string,
): number {
  if (!config || config.optIn !== true) return 0;
  const perAgent = config.perAgentSampleRate?.[agentId];
  const rate =
    typeof perAgent === "number" ? perAgent : config.defaultSampleRate;
  return clampRate(rate);
}

/**
 * Loads the EvalSamplingConfig row for an org (GetItem, PK=orgId). Never
 * throws: any read failure is logged and treated as "not opted in" (fail
 * closed toward NOT sampling — a transient DynamoDB error must never
 * cause an unconfigured org to start being sampled, nor crash the
 * selector Lambda over a config-read blip).
 */
export async function getEvalSamplingConfig(
  tableName: string,
  orgId: string,
): Promise<EvalSamplingConfig | undefined> {
  try {
    const res = await docClient.send(
      new GetCommand({ TableName: tableName, Key: { orgId } }),
    );
    return res.Item as EvalSamplingConfig | undefined;
  } catch (err: unknown) {
    console.error(
      "eval-sampling-config: getEvalSamplingConfig failed — treating as not opted in",
      { orgId, error: err instanceof Error ? err.message : String(err) },
    );
    return undefined;
  }
}
