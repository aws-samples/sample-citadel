/**
 * Canonical registry-safe name derivation.
 *
 * The AgentCore Registry (bedrock-agentcore CreateRegistryRecord /
 * UpdateRegistryRecord) constrains `name` to:
 *
 *   ^[a-zA-Z0-9][a-zA-Z0-9_\-./]*$
 *
 * (live-verified ValidationException: 'Test - Ingest' is rejected — spaces
 * are illegal). Human-facing names flow in from the AppBuilderWizard (which
 * validates length only), the intake agent (project names), and agent-import
 * manifests, so the derivation lives HERE in the shared service layer and is
 * applied by RegistryService for every create/update — never re-implemented
 * per caller.
 *
 * Rules (deterministic, idempotent):
 *  - input already legal → returned unchanged
 *  - every illegal char maps to '-'
 *  - consecutive '-' runs collapse to one
 *  - leading non-alphanumeric chars are stripped (first char must be alnum)
 *  - trailing '-' artifacts are stripped
 *  - never empty: falls back to the literal 'app'
 *
 * MIRROR: service/agent_intake_single/tools/registry_name.py implements the
 * identical algorithm in Python (the intake agent pre-sanitizes proposals so
 * the consent gate shows exactly what will be created). The two are pinned
 * to agree on shared vectors — see registry-name.test.ts /
 * test_registry_name.py. Update BOTH when changing either.
 */

/** The registry `name` constraint, verbatim. */
export const REGISTRY_NAME_PATTERN = /^[a-zA-Z0-9][a-zA-Z0-9_\-./]*$/;

/** Deterministic fallback when sanitization yields an empty string. */
const FALLBACK_NAME = 'app';

/**
 * Derives a registry-safe name from arbitrary human input. Pure, total, and
 * idempotent: the output always matches REGISTRY_NAME_PATTERN, and legal
 * inputs pass through unchanged.
 */
export function sanitizeRegistryName(input: string): string {
  if (REGISTRY_NAME_PATTERN.test(input)) {
    return input;
  }
  const mapped = input
    .replace(/[^a-zA-Z0-9_\-./]/g, '-') // illegal chars → '-'
    .replace(/-{2,}/g, '-') // collapse '-' runs
    .replace(/^[^a-zA-Z0-9]+/, '') // first char must be alphanumeric
    .replace(/-+$/, ''); // strip trailing '-' artifacts
  return mapped.length > 0 ? mapped : FALLBACK_NAME;
}
