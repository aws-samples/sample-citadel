/**
 * Explicit record-kind discriminator for the AgentCore Registry.
 *
 * The Registry stores apps, agents, and tools as records whose only type
 * distinction lives in the *shape* of `customDescriptorContent`. This module
 * adds an explicit `citadelKind` discriminator so read paths can filter
 * correctly instead of guessing from shape heuristics.
 *
 * Write-time: every creation path stamps `citadelKind` into the descriptor.
 * Read-time: `resolveKind()` reads the explicit field; falls back to shape
 * inference for pre-backfill records and emits a structured WARN + metric.
 */

// ---------------------------------------------------------------------------
// Type
// ---------------------------------------------------------------------------

export type CitadelKind = "agent" | "app" | "tool";

const VALID_KINDS: ReadonlySet<string> = new Set<string>([
  "agent",
  "app",
  "tool",
]);

// ---------------------------------------------------------------------------
// Extraction: read the explicit discriminator
// ---------------------------------------------------------------------------

/**
 * Returns the explicit `citadelKind` from a registry record's custom
 * descriptor, or `undefined` when absent / malformed.
 *
 * Accepts the two common shapes:
 *   - A `RegistryRecord` with `customDescriptorContent?: string`
 *   - An `AgentConfig`-like object with `config: string` (the serialised
 *     descriptor that `mapToAgentConfig` stores)
 */
export function extractCitadelKind(
  record:
    | { customDescriptorContent?: string | null }
    | { config?: string | null }
    | null
    | undefined,
): CitadelKind | undefined {
  if (!record) return undefined;
  try {
    const raw =
      "customDescriptorContent" in record
        ? record.customDescriptorContent
        : (record as { config?: string | null }).config;
    if (!raw) return undefined;
    const parsed: unknown = JSON.parse(raw);
    if (typeof parsed !== "object" || parsed === null) return undefined;
    const kind = (parsed as Record<string, unknown>).citadelKind;
    if (typeof kind === "string" && VALID_KINDS.has(kind)) {
      return kind as CitadelKind;
    }
    return undefined;
  } catch {
    return undefined;
  }
}

// ---------------------------------------------------------------------------
// Inference: shape heuristic for pre-backfill records
// ---------------------------------------------------------------------------

/**
 * Infers the kind from the *shape* of `customDescriptorContent`:
 *   - Has a `manifest` key  → `'app'`
 *   - Otherwise             → `'agent'` (default for agent-type records)
 *
 * Tool records are never ambiguous because their registry resource type is
 * `'tool'`; pass `resourceType` to disambiguate when available.
 */
export function inferKindFromShape(
  record: { customDescriptorContent?: string | null },
  resourceType?: "agent" | "tool",
): CitadelKind {
  if (resourceType === "tool") return "tool";
  try {
    const parsed = JSON.parse(record.customDescriptorContent ?? "{}");
    if (
      typeof parsed === "object" &&
      parsed !== null &&
      "manifest" in parsed &&
      parsed.manifest !== undefined
    ) {
      return "app";
    }
    return "agent";
  } catch {
    return "agent";
  }
}

// ---------------------------------------------------------------------------
// Resolved kind: explicit ?? inferred (with WARN)
// ---------------------------------------------------------------------------

const METRIC_NAME = "CitadelKindInferred";

/**
 * Returns the authoritative kind for a registry record:
 *   1. Explicit `citadelKind` from the descriptor (preferred).
 *   2. Shape-inferred fallback with a structured WARN log + metric name.
 *
 * The structured log is consumed by CloudWatch Logs metric filters to track
 * remaining un-backfilled records.
 */
export function resolveKind(
  record:
    | { customDescriptorContent?: string | null; recordId?: string }
    | null
    | undefined,
  resourceType?: "agent" | "tool",
): CitadelKind {
  if (!record) return resourceType === "tool" ? "tool" : "agent";

  const explicit = extractCitadelKind(record);
  if (explicit) return explicit;

  const inferred = inferKindFromShape(
    record as { customDescriptorContent?: string | null },
    resourceType,
  );

  // Structured WARN — consumable by CloudWatch Logs metric filter.
  console.warn(
    JSON.stringify({
      level: "WARN",
      metric: METRIC_NAME,
      message: "citadelKind missing from record; fell back to shape inference",
      recordId: (record as { recordId?: string }).recordId ?? "unknown",
      inferredKind: inferred,
    }),
  );

  return inferred;
}
