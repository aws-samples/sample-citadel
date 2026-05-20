import { DataStore, DataStoreUsage } from '@/services/datastoreService';

export type UsageFilterTab = 'all' | 'knowledge' | 'operational';

/**
 * Filters data stores by usage tab selection.
 * - "all": returns all stores
 * - "knowledge": returns stores with usage KNOWLEDGE or BOTH
 * - "operational": returns stores with usage OPERATIONAL or BOTH
 *
 * Stores without a usage field are treated as BOTH (backward compatibility).
 */
export function filterDataStoresByUsage(
  stores: DataStore[],
  usageTab: UsageFilterTab,
): DataStore[] {
  if (usageTab === 'all') {
    return stores;
  }

  return stores.filter((store) => {
    const usage = store.usage ?? DataStoreUsage.BOTH;
    if (usageTab === 'knowledge') {
      return usage === DataStoreUsage.KNOWLEDGE || usage === DataStoreUsage.BOTH;
    }
    if (usageTab === 'operational') {
      return usage === DataStoreUsage.OPERATIONAL || usage === DataStoreUsage.BOTH;
    }
    return true;
  });
}
