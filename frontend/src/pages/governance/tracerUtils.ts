/**
 * Tracer utility helpers
 *
 * Pure helpers extracted from Tracer.tsx so they can be unit-tested
 * directly without dragging in the page's React + ReactFlow render path.
 */

import type { GovernanceFinding } from '../../services/governanceService';

export interface ConcurrencyGroup {
  /** The single finding that owns the foreground (interactive) pipeline. */
  foreground: GovernanceFinding;
  /**
   * Up to `maxGhosts` other findings that arrived within `windowSeconds` of
   * the foreground. Sorted descending by timestamp (most recent ghost first)
   * so the rendering layer can map them straight onto the
   * GHOST_OPACITIES array (most recent ghost is the most opaque).
   */
  ghosts: GovernanceFinding[];
}

/**
 * Detect concurrent findings around a foreground decision.
 *
 * The foreground is determined as follows:
 *   1. If `pinnedFindingId` is provided AND the buffer contains a finding
 *      with that ID, that finding is the foreground.
 *   2. Otherwise the most-recent buffer entry (`buffer[0]`) is the foreground.
 *      If `pinnedFindingId` is provided but missing from the buffer (e.g.
 *      evicted by capacity), the helper falls back to most-recent rather
 *      than returning null — the caller still needs a foreground to render.
 *
 * Ghosts are other findings whose timestamp is within ±`windowSeconds` of
 * the foreground's timestamp. They are capped at `maxGhosts` (default 4)
 * and sorted descending by timestamp — the most recent ghost first so the
 * rendering layer's opacity ladder (0.5 → 0.15) fades the older ghosts more.
 *
 * `windowSeconds` defaults to 0.1 (=100ms) per the roadmap §3.4
 * "tight window" requirement; tests can pass other values.
 *
 * Returns `null` only when the buffer is empty.
 */
export function detectConcurrencyGroup(
  buffer: GovernanceFinding[],
  pinnedFindingId: string | null,
  windowSeconds: number = 0.1,
  maxGhosts: number = 4,
): ConcurrencyGroup | null {
  if (buffer.length === 0) return null;

  // Foreground: pinned if present in buffer, else most-recent.
  const foreground = pinnedFindingId
    ? (buffer.find((f) => f.findingId === pinnedFindingId) ?? buffer[0])
    : buffer[0];

  // Ghosts: other buffer entries within the time window, sorted descending.
  const ghosts = buffer
    .filter(
      (f) =>
        f.findingId !== foreground.findingId &&
        Math.abs(f.timestamp - foreground.timestamp) <= windowSeconds,
    )
    .sort((a, b) => b.timestamp - a.timestamp)
    .slice(0, maxGhosts);

  return { foreground, ghosts };
}
