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
 * Infers the kind from the *shape* of `customDescriptorContent`.
 *
 * Both agents AND apps carry a `manifest`, so manifest presence alone is
 * not sufficient to distinguish them. App descriptors are identified by
 * app-only fields:
 *   - Top-level `appId`
 *   - `manifest.agentBindings`
 *   - `manifest.access`
 *
 * Decision tree:
 *   1. `resourceType === 'tool'`                              → `'tool'`
 *   2. `manifest.agentBindings` OR `appId` OR `manifest.access` → `'app'`
 *   3. Otherwise                                               → `'agent'`
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
    const raw = record.customDescriptorContent;
    if (!raw) return "agent"; // null/undefined/empty → default agent
    const parsed = JSON.parse(raw);
    if (typeof parsed !== "object" || parsed === null) return "agent";
    return inferKindFromParsed(parsed);
  } catch {
    return "agent";
  }
}

/**
 * Infers kind from an already-parsed descriptor object. Useful for call
 * sites that have already parsed the JSON (e.g. registry-service list
 * methods, backfill hydration).
 *
 * Decision tree:
 *   1. `manifest.agentBindings` OR `appId` OR `manifest.access` → `'app'`
 *   2. `manifest` present (non-null object)                      → `'agent'`
 *   3. Otherwise                                                 → `'tool'`
 */
export function inferKindFromParsed(
  parsed: Record<string, unknown>,
): CitadelKind {
  const manifest =
    typeof parsed.manifest === "object" && parsed.manifest !== null
      ? (parsed.manifest as Record<string, unknown>)
      : undefined;

  if (
    manifest?.agentBindings !== undefined ||
    "appId" in parsed ||
    manifest?.access !== undefined
  ) {
    return "app";
  }

  if (manifest !== undefined) {
    return "agent";
  }

  return "tool";
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
