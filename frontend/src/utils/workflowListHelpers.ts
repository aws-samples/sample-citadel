/**
 * Shared helpers for workflow list disambiguation (CIT-289).
 * Parsing, placeholder detection, and sorting utilities used by
 * AppDetailView workflow cards, the Bind Workflow picker, and
 * BlueprintCatalog / BlueprintCard.
 */
import { isPlaceholderAgentId } from './blueprintPlaceholders';

/** Parse a JSON definition string and return the nodes array. */
export function parseDefinitionNodes(definition: string | undefined | null): Array<{ id: string; agentId?: string; [k: string]: unknown }> {
  if (!definition) return [];
  try {
    const parsed = JSON.parse(definition);
    return Array.isArray(parsed.nodes) ? parsed.nodes : [];
  } catch {
    return [];
  }
}

/** True when any node in the definition uses a placeholder agentId. */
export function hasPlaceholderNodes(definition: string | undefined | null): boolean {
  const nodes = parseDefinitionNodes(definition);
  return nodes.some((n) => n.agentId && isPlaceholderAgentId(n.agentId));
}

/** Last 6 characters of an ID string — used as a short visual identifier. */
export function shortId(id: string): string {
  return id.length > 6 ? id.slice(-6) : id;
}

/**
 * Sort comparator: name ascending (case-insensitive), then createdAt descending
 * so same-name copies appear adjacent with newest first.
 */
export function sortByNameThenDate<T extends { name: string; createdAt?: string }>(a: T, b: T): number {
  const nameCompare = a.name.localeCompare(b.name, undefined, { sensitivity: 'base' });
  if (nameCompare !== 0) return nameCompare;
  // Descending by date — newest first
  const aDate = a.createdAt ?? '';
  const bDate = b.createdAt ?? '';
  return bDate.localeCompare(aDate);
}
