/**
 * App filtering utility functions for the Agent Apps page.
 * Pure functions for client-side search and status filtering.
 */

interface AppItem {
  name: string;
  description: string;
  status: string;
  [key: string]: unknown;
}

/**
 * Filter apps by search query — case-insensitive substring match on name and description.
 * Returns all apps when query is empty.
 */
export function filterAppsBySearch<T extends AppItem>(apps: T[], query: string): T[] {
  if (!query) return apps;
  const lowerQuery = query.toLowerCase();
  return apps.filter(
    (app) =>
      app.name.toLowerCase().includes(lowerQuery) ||
      app.description.toLowerCase().includes(lowerQuery),
  );
}

/**
 * Filter apps by status. Returns all apps when status is "All".
 */
export function filterAppsByStatus<T extends AppItem>(apps: T[], status: string): T[] {
  if (status === 'All') return apps;
  return apps.filter((app) => app.status === status);
}
