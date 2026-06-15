/**
 * Route configuration for the Citadel application.
 * Maps sidebar navigation item IDs to URL paths.
 */

/** All defined route paths in the application */
export const ROUTE_PATHS = {
  dashboard: '/dashboard',
  'intake-requests': '/intake-requests',
  'agentic-studio': '/agentic-studio',
  'agent-apps': '/agent-apps',
  'agent-catalog': '/agent-catalog',
  tools: '/tools',
  governance: '/governance',
  integrations: '/integrations',
  'data-stores': '/data-stores',
  team: '/team',
} as const;

/** Map from sidebar nav item ID to route path */
export function navIdToPath(navId: string): string {
  return (ROUTE_PATHS as Record<string, string>)[navId] ?? '/dashboard';
}

/** Map from route path to sidebar nav item ID */
export function pathToNavId(pathname: string): string {
  // Handle parameterized routes
  if (pathname.startsWith('/governance')) return 'governance';
  if (pathname.startsWith('/agent-apps/')) return 'agent-apps';
  if (pathname.startsWith('/implementation/')) return 'agentic-studio';

  const entry = Object.entries(ROUTE_PATHS).find(([, path]) => path === pathname);
  return entry ? entry[0] : 'dashboard';
}
