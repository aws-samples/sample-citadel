/**
 * Shared placeholder-agent conventions for template blueprints.
 *
 * Seeded template blueprints reference agent slots via a `placeholder-`
 * agentId prefix. These slots do not exist in the agent catalog and must be
 * re-mapped to real agents at import time (ImportBlueprintDialog). The canvas
 * Load-from-Catalog picker (WorkflowToolbar) uses the same detection to keep
 * such templates from being loaded directly, which would otherwise fail with
 * a MISSING_AGENTS error.
 *
 * Single source of truth — do not duplicate the prefix literal elsewhere.
 */
export const PLACEHOLDER_AGENT_PREFIX = 'placeholder-';

/** True when an agentId (blueprint agent slot) is an unmapped placeholder. */
export function isPlaceholderAgentId(agentId: string): boolean {
  return agentId.startsWith(PLACEHOLDER_AGENT_PREFIX);
}
