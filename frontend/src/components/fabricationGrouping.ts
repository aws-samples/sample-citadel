import { FabricationQueueItem } from '../services/fabricatorQueueService';

export interface FabricationGroup {
  appId: string | null;
  appName: string;
  items: FabricationQueueItem[];
}

export interface FabricationQueueSummary {
  /** PENDING + PROCESSING — the work actually in flight. */
  active: number;
  completed: number;
  failed: number;
}

/**
 * Summarizes queue items by lifecycle state. The queue endpoint returns
 * ALL-TIME rows, so a single cumulative count reads as a stalled backlog
 * once history accumulates (live: 37 rows, all COMPLETED). The UI shows the
 * active count prominently and completed/failed separately.
 */
export function summarizeFabricationQueue(
  items: FabricationQueueItem[],
): FabricationQueueSummary {
  const summary: FabricationQueueSummary = { active: 0, completed: 0, failed: 0 };
  for (const item of items) {
    if (item.status === 'PENDING' || item.status === 'PROCESSING') {
      summary.active += 1;
    } else if (item.status === 'COMPLETED') {
      summary.completed += 1;
    } else if (item.status === 'FAILED') {
      summary.failed += 1;
    }
  }
  return summary;
}

/**
 * Renders a queue summary as the human breakdown line, e.g.
 * '0 in progress · 37 completed' (+ ' · 2 failed' only when present).
 */
export function formatFabricationQueueSummary(summary: FabricationQueueSummary): string {
  const parts = [`${summary.active} in progress`, `${summary.completed} completed`];
  if (summary.failed > 0) {
    parts.push(`${summary.failed} failed`);
  }
  return parts.join(' · ');
}

/**
 * Groups fabrication queue items by appId.
 * Items without appId go to an "Unassigned" group.
 * Named groups are sorted alphabetically, Unassigned comes last.
 */
export function groupFabricationItems(items: FabricationQueueItem[]): FabricationGroup[] {
  const groupMap = new Map<string, FabricationGroup>();

  for (const item of items) {
    const key = item.appId || '__unassigned__';
    if (!groupMap.has(key)) {
      groupMap.set(key, {
        appId: item.appId || null,
        appName: item.appId ? (item.appName || item.appId) : 'Unassigned',
        items: [],
      });
    }
    groupMap.get(key)!.items.push(item);
  }

  const groups = Array.from(groupMap.values());
  groups.sort((a, b) => {
    if (a.appId === null) return 1;
    if (b.appId === null) return -1;
    return a.appName.localeCompare(b.appName);
  });

  return groups;
}
