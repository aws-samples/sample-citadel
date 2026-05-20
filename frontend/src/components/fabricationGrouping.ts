import { FabricationQueueItem } from '../services/fabricatorQueueService';

export interface FabricationGroup {
  appId: string | null;
  appName: string;
  items: FabricationQueueItem[];
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
