/**
 * eval-external-evaluator.ts (CIT-107) — validates untrusted responses
 * from org-registered EXTERNAL evaluators (Lambda/HTTP targets invoked
 * via the existing agent-source adapter machinery) before any value from
 * them is allowed to reach a persisted ScoreVector.
 *
 * Every external evaluator response is untrusted input (module doc
 * mirrors sanitize-untrusted-json.ts's own framing). This module applies
 * two layers of defense, in order:
 *
 *  1. STRUCTURAL sanitization via {@link sanitizeUntrustedJson} — bounds
 *     nesting depth/node count/string length and neutralizes any
 *     injection-marker content in string values before field-level
 *     validation ever runs. A response that trips the sanitizer's
 *     truncation is treated as malformed (oversized payload) and
 *     rejected outright, never partially accepted from a truncated shape.
 *  2. FIELD-LEVEL validation ({@link validateExternalDimensionScore}) —
 *     a total function: every dimension name, status, basis, verdict,
 *     measurement, and detail is checked against the same closed shape
 *     eval-scoring.ts's DimensionScore uses (widened only to allow a
 *     custom dimension NAME, never a custom STATUS/BASIS/VERDICT shape).
 *     Unknown/invalid dimension names, out-of-range or non-finite scores,
 *     missing required fields, and unrecognized extra fields are all
 *     rejected. Rejection is total: a single malformed entry is dropped
 *     without ever touching the accepted set, and (via
 *     {@link validateExternalScoreVector}) a malformed or oversized
 *     top-level response rejects everything in it.
 *
 * Reserved dimension names (DIMENSION_ORDER, eval-scoring.ts) are refused
 * for EXTERNAL evaluators — a custom evaluator can only contribute a
 * dimension name that does not collide with a built-in canonical name,
 * so external results can never spoof/overwrite a core dimension.
 */
import { DIMENSION_ORDER } from "./eval-scoring";
import {
  sanitizeUntrustedJson,
  type JsonValue,
} from "../../utils/sanitize-untrusted-json";

/** Max external-facing dimension name length (mirrors DEFAULT_MAX_KEY_LENGTH
 * discipline in sanitize-untrusted-json.ts but tighter — dimension names are
 * short identifiers, not arbitrary keys). */
export const MAX_EXTERNAL_DIMENSION_NAME_LENGTH = 128;
/** Mirrors eval-scoring.ts's own MAX_DETAIL_LENGTH (1KiB detail cap). */
export const MAX_EXTERNAL_DETAIL_LENGTH = 1024;
/** Max number of dimension-score entries accepted in a single external
 * evaluator response — bounds the work done per invocation and caps how
 * much an org-registered evaluator can inject per run. */
export const MAX_EXTERNAL_SCORES_PER_RESPONSE = 50;

const RESERVED_DIMENSION_NAMES = new Set<string>(DIMENSION_ORDER);

/** Custom dimension names: namespaced lower-case identifier, dots/hyphens/
 * underscores allowed as separators — no shell/SQL/HTML metacharacters. */
const DIMENSION_NAME_PATTERN = /^[a-z0-9][a-z0-9._-]*$/;

const VALID_STATUSES = new Set([
  "SCORED",
  "UNKNOWN",
  "NOT_APPLICABLE",
  "PENDING",
]);
const VALID_BASES = new Set(["DETERMINISTIC", "JUDGE"]);

export interface ExternalDimensionScore {
  dimension: string;
  status: "SCORED" | "UNKNOWN" | "NOT_APPLICABLE" | "PENDING";
  basis: "DETERMINISTIC" | "JUDGE";
  verdict?:
    { kind: "boolean"; pass: boolean } | { kind: "score"; score: number };
  measurement?: number | null;
  judgeModelId?: string;
  judgeModelVersion?: string;
  judgePromptHash?: string;
  detail: string;
}

export type ValidationResult =
  { ok: true; value: ExternalDimensionScore } | { ok: false; reason: string };

const ALLOWED_KEYS = new Set([
  "dimension",
  "status",
  "basis",
  "verdict",
  "measurement",
  "judgeModelId",
  "judgeModelVersion",
  "judgePromptHash",
  "detail",
]);

function isObject(v: unknown): v is Record<string, unknown> {
  return typeof v === "object" && v !== null && !Array.isArray(v);
}

function isFiniteNumber(v: unknown): v is number {
  return typeof v === "number" && Number.isFinite(v);
}

function validateVerdict(
  verdict: unknown,
):
  | { ok: true; value: ExternalDimensionScore["verdict"] }
  | { ok: false; reason: string } {
  if (!isObject(verdict)) {
    return { ok: false, reason: "verdict must be an object" };
  }
  if (verdict.kind === "boolean") {
    if (typeof verdict.pass !== "boolean") {
      return {
        ok: false,
        reason: "boolean verdict requires a boolean 'pass' field",
      };
    }
    return { ok: true, value: { kind: "boolean", pass: verdict.pass } };
  }
  if (verdict.kind === "score") {
    if (!isFiniteNumber(verdict.score)) {
      return {
        ok: false,
        reason: "score verdict requires a finite numeric 'score' field",
      };
    }
    if (verdict.score < 0 || verdict.score > 1) {
      return { ok: false, reason: "score verdict must be within [0,1]" };
    }
    return { ok: true, value: { kind: "score", score: verdict.score } };
  }
  return {
    ok: false,
    reason: `unknown verdict kind: ${String((verdict as { kind?: unknown }).kind)}`,
  };
}

/**
 * Validates a single dimension-score entry from an external evaluator
 * response. Total function: never throws, always returns a discriminated
 * ok/reason result. See module doc for the full rejection surface.
 */
export function validateExternalDimensionScore(
  input: unknown,
): ValidationResult {
  if (!isObject(input)) {
    return { ok: false, reason: "entry is not an object" };
  }

  const extraKeys = Object.keys(input).filter((k) => !ALLOWED_KEYS.has(k));
  if (extraKeys.length > 0) {
    return { ok: false, reason: `unexpected field(s): ${extraKeys.join(",")}` };
  }

  const { dimension, status, basis, verdict, measurement, detail } = input;

  if (typeof dimension !== "string" || dimension.length === 0) {
    return { ok: false, reason: "dimension must be a non-empty string" };
  }
  if (dimension.length > MAX_EXTERNAL_DIMENSION_NAME_LENGTH) {
    return { ok: false, reason: "dimension name exceeds max length" };
  }
  if (!DIMENSION_NAME_PATTERN.test(dimension)) {
    return { ok: false, reason: "dimension name contains invalid characters" };
  }
  if (RESERVED_DIMENSION_NAMES.has(dimension)) {
    return {
      ok: false,
      reason: `dimension name '${dimension}' is reserved for built-in scoring`,
    };
  }

  if (typeof status !== "string" || !VALID_STATUSES.has(status)) {
    return {
      ok: false,
      reason: "status must be one of SCORED/UNKNOWN/NOT_APPLICABLE/PENDING",
    };
  }
  if (typeof basis !== "string" || !VALID_BASES.has(basis)) {
    return { ok: false, reason: "basis must be one of DETERMINISTIC/JUDGE" };
  }

  if (typeof detail !== "string") {
    return { ok: false, reason: "detail must be a string" };
  }
  if (detail.length > MAX_EXTERNAL_DETAIL_LENGTH) {
    return { ok: false, reason: "detail exceeds max length" };
  }

  let validatedVerdict: ExternalDimensionScore["verdict"];
  if (status === "SCORED") {
    if (verdict === undefined) {
      return { ok: false, reason: "SCORED status requires a verdict" };
    }
    const verdictResult = validateVerdict(verdict);
    if (!verdictResult.ok) return verdictResult;
    validatedVerdict = verdictResult.value;
  } else if (verdict !== undefined) {
    // Non-SCORED statuses carry no verdict (mirrors eval-scoring.ts's own
    // "Present iff status === 'SCORED'" contract) — presence is malformed.
    return { ok: false, reason: `${status} status must not carry a verdict` };
  }

  let validatedMeasurement: number | null | undefined;
  if (measurement !== undefined) {
    if (measurement === null) {
      validatedMeasurement = null;
    } else if (isFiniteNumber(measurement)) {
      validatedMeasurement = measurement;
    } else {
      return {
        ok: false,
        reason: "measurement must be a finite number or null",
      };
    }
  }

  const stampFields = [
    "judgeModelId",
    "judgeModelVersion",
    "judgePromptHash",
  ] as const;
  const stamps: Partial<Record<(typeof stampFields)[number], string>> = {};
  for (const field of stampFields) {
    const value = input[field];
    if (value === undefined) continue;
    if (typeof value !== "string" || value.length === 0) {
      return {
        ok: false,
        reason: `${field} must be a non-empty string when present`,
      };
    }
    stamps[field] = value;
  }

  if (basis === "JUDGE" && status !== "PENDING") {
    // A landed (non-PENDING) JUDGE-basis result must carry the full
    // reproducibility stamp — mirrors eval-case-scorer.ts's
    // REQUIRED_STAMP_FIELDS discipline for governance.eval.case.judged.
    const missing = stampFields.filter((f) => !stamps[f]);
    if (missing.length > 0) {
      return {
        ok: false,
        reason: `JUDGE basis requires stamp field(s): ${missing.join(",")}`,
      };
    }
  }

  const value: ExternalDimensionScore = {
    dimension,
    status: status as ExternalDimensionScore["status"],
    basis: basis as ExternalDimensionScore["basis"],
    detail,
    ...(validatedVerdict !== undefined ? { verdict: validatedVerdict } : {}),
    ...(validatedMeasurement !== undefined
      ? { measurement: validatedMeasurement }
      : {}),
    ...stamps,
  };

  return { ok: true, value };
}

export interface ScoreVectorValidationResult {
  accepted: ExternalDimensionScore[];
  rejected: Array<{ index: number; reason: string }>;
}

/**
 * Validates an entire external-evaluator response payload (an array of
 * dimension-score entries). Rejection is TOTAL at two levels:
 *  - the whole payload is rejected (accepted=[]) when it is not an array,
 *    exceeds the max entry count, or contains duplicate dimension names;
 *  - otherwise each entry is validated independently and only the valid
 *    ones are returned in `accepted` — one malformed entry never blocks
 *    or poisons the others.
 * The raw `rawResponse` is first run through {@link sanitizeUntrustedJson}
 * so injection-marker content and adversarial structure never reach
 * field-level validation.
 */
export function validateExternalScoreVector(
  rawResponse: unknown,
): ScoreVectorValidationResult {
  const sanitized = sanitizeUntrustedJson(rawResponse);
  if (sanitized.truncated) {
    return {
      accepted: [],
      rejected: [
        {
          index: -1,
          reason: "response payload exceeded structural sanitizer limits",
        },
      ],
    };
  }

  const value: JsonValue = sanitized.value;
  if (!Array.isArray(value)) {
    return {
      accepted: [],
      rejected: [{ index: -1, reason: "response is not an array" }],
    };
  }

  if (value.length > MAX_EXTERNAL_SCORES_PER_RESPONSE) {
    return {
      accepted: [],
      rejected: [
        {
          index: -1,
          reason: `response contains ${value.length} entries, exceeding max ${MAX_EXTERNAL_SCORES_PER_RESPONSE}`,
        },
      ],
    };
  }

  const rejected: Array<{ index: number; reason: string }> = [];
  const accepted: ExternalDimensionScore[] = [];
  const seenDimensions = new Set<string>();
  const duplicateDimensions = new Set<string>();

  for (let i = 0; i < value.length; i += 1) {
    const result = validateExternalDimensionScore(value[i]);
    if (!result.ok) {
      rejected.push({ index: i, reason: result.reason });
      continue;
    }
    if (seenDimensions.has(result.value.dimension)) {
      duplicateDimensions.add(result.value.dimension);
    }
    seenDimensions.add(result.value.dimension);
    accepted.push(result.value);
  }

  if (duplicateDimensions.size > 0) {
    // A response naming the same dimension twice is ambiguous — which
    // value would win is undefined, so the whole vector is rejected
    // rather than silently picking one (total rejection, never a guess).
    return {
      accepted: [],
      rejected: [
        ...rejected,
        {
          index: -1,
          reason: `duplicate dimension name(s) in response: ${[...duplicateDimensions].join(",")}`,
        },
      ],
    };
  }

  return { accepted, rejected };
}
