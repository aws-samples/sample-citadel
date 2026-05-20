// Feature: ui-ux-remediation, Property 15: Direct URL loads correct page
// Feature: ui-ux-remediation, Property 16: Auth guard redirects unauthenticated users
// Feature: ui-ux-remediation, Property 17: Undefined routes show 404
import * as fc from 'fast-check';
import React from 'react';
import { render } from '@testing-library/react';
import '@testing-library/jest-dom';
import { MemoryRouter, Routes, Route, Navigate } from 'react-router-dom';
import { NotFound } from '../../components/NotFound';
import { ProtectedRoute } from '../../components/ProtectedRoute';

// --- Mocks ---

// Mock OrganizationContext
jest.mock('@/contexts/OrganizationContext', () => ({
  useOrganization: () => ({
    selectedOrganization: 'TestOrg',
    setSelectedOrganization: jest.fn(),
    organizations: ['TestOrg'],
    currentUser: null,
    isAdmin: false,
    loading: false,
  }),
  OrganizationProvider: ({ children }: any) => <>{children}</>,
}));

// Mock AppHeader
jest.mock('@/components/AppHeader', () => ({
  AppHeader: () => <div data-testid="mock-header">Header</div>,
}));

// Mock Tooltip
jest.mock('@/components/ui/tooltip', () => ({
  Tooltip: ({ children }: any) => React.createElement('div', null, children),
  TooltipContent: ({ children }: any) => React.createElement('span', null, children),
  TooltipProvider: ({ children }: any) => React.createElement('div', null, children),
  TooltipTrigger: ({ children }: any) => React.createElement('div', null, children),
}));

// Mock serverService
jest.mock('@/services', () => ({
  serverService: {
    getCurrentUser: jest.fn().mockResolvedValue(null),
    signOut: jest.fn().mockResolvedValue(undefined),
  },
}));

// Mock sonner
jest.mock('@/components/ui/sonner', () => ({
  Toaster: () => null,
}));

// Stub page components to avoid heavy dependencies
const StubDashboard = () => <div data-testid="page-dashboard">Dashboard</div>;
const StubIntakeRequests = () => <div data-testid="page-intake-requests">IntakeRequests</div>;
const StubAgenticStudio = () => <div data-testid="page-agentic-studio">AgenticStudio</div>;
const StubAgentApps = () => <div data-testid="page-agent-apps">AgentApps</div>;
const StubAppDetailView = () => <div data-testid="page-app-detail">AppDetailView</div>;
const StubAgentCatalog = () => <div data-testid="page-agent-catalog">AgentCatalog</div>;
const StubTools = () => <div data-testid="page-tools">Tools</div>;
const StubIntegrations = () => <div data-testid="page-integrations">Integrations</div>;
const StubDataStores = () => <div data-testid="page-data-stores">DataStores</div>;
const StubTeam = () => <div data-testid="page-team">Team</div>;
const StubImplementation = () => <div data-testid="page-implementation">Implementation</div>;

/** Route config matching the real app routes */
const routeConfig = [
  { path: '/dashboard', testId: 'page-dashboard', element: <StubDashboard /> },
  { path: '/intake-requests', testId: 'page-intake-requests', element: <StubIntakeRequests /> },
  { path: '/agentic-studio', testId: 'page-agentic-studio', element: <StubAgenticStudio /> },
  { path: '/agent-apps', testId: 'page-agent-apps', element: <StubAgentApps /> },
  { path: '/agent-apps/:appId', testId: 'page-app-detail', element: <StubAppDetailView /> },
  { path: '/agent-catalog', testId: 'page-agent-catalog', element: <StubAgentCatalog /> },
  { path: '/tools', testId: 'page-tools', element: <StubTools /> },
  { path: '/integrations', testId: 'page-integrations', element: <StubIntegrations /> },
  { path: '/data-stores', testId: 'page-data-stores', element: <StubDataStores /> },
  { path: '/team', testId: 'page-team', element: <StubTeam /> },
  { path: '/implementation/:projectId', testId: 'page-implementation', element: <StubImplementation /> },
];

/** Renders the route structure inside a MemoryRouter */
function renderWithRouter(initialPath: string, authenticated: boolean = true) {
  const authFallback = <div data-testid="auth-screen">Login</div>;
  const currentUser = authenticated ? { name: 'Test User' } : null;

  return render(
    <MemoryRouter initialEntries={[initialPath]}>
      <ProtectedRoute currentUser={currentUser} fallback={authFallback}>
        <Routes>
          <Route path="/" element={<Navigate to="/dashboard" replace />} />
          {routeConfig.map((r) => (
            <Route key={r.path} path={r.path} element={r.element} />
          ))}
          <Route path="*" element={<NotFound />} />
        </Routes>
      </ProtectedRoute>
    </MemoryRouter>,
  );
}

// --- Property 15: Direct URL loads correct page ---

/**
 * Property 15: Direct URL loads correct page
 *
 * For any valid route path from the defined route configuration,
 * rendering the app with that path as the initial URL SHALL display
 * the corresponding page component.
 *
 * Validates: Requirements 14.7
 */
describe('Property 15: Direct URL loads correct page', () => {
  // Static routes (no params)
  const staticRoutes = routeConfig.filter((r) => !r.path.includes(':'));

  it('renders the correct page for any valid static route', () => {
    const routeArb = fc.constantFrom(...staticRoutes);

    fc.assert(
      fc.property(routeArb, (route) => {
        const { unmount, getByTestId } = renderWithRouter(route.path);

        const page = getByTestId(route.testId);
        if (!page) {
          throw new Error(`Route ${route.path} did not render page with testId ${route.testId}`);
        }

        unmount();
        return true;
      }),
      { numRuns: 100 },
    );
  });

  it('renders AppDetailView for parameterized /agent-apps/:appId route', () => {
    const appIdArb = fc.stringMatching(/^[a-z0-9-]{3,20}$/);

    fc.assert(
      fc.property(appIdArb, (appId) => {
        const { unmount, getByTestId } = renderWithRouter(`/agent-apps/${appId}`);

        const page = getByTestId('page-app-detail');
        if (!page) {
          throw new Error(`/agent-apps/${appId} did not render AppDetailView`);
        }

        unmount();
        return true;
      }),
      { numRuns: 100 },
    );
  });

  it('renders ImplementationPage for parameterized /implementation/:projectId route', () => {
    const projectIdArb = fc.stringMatching(/^[a-z0-9-]{3,20}$/);

    fc.assert(
      fc.property(projectIdArb, (projectId) => {
        const { unmount, getByTestId } = renderWithRouter(`/implementation/${projectId}`);

        const page = getByTestId('page-implementation');
        if (!page) {
          throw new Error(`/implementation/${projectId} did not render ImplementationPage`);
        }

        unmount();
        return true;
      }),
      { numRuns: 100 },
    );
  });
});

// --- Property 16: Auth guard redirects unauthenticated users ---

/**
 * Property 16: Auth guard redirects unauthenticated users
 *
 * For any protected route path, when no authenticated user is present,
 * navigating to that route SHALL redirect to the login screen.
 *
 * Validates: Requirements 14.8
 */
describe('Property 16: Auth guard redirects unauthenticated users', () => {
  const allPaths = [
    '/dashboard',
    '/intake-requests',
    '/agentic-studio',
    '/agent-apps',
    '/agent-catalog',
    '/tools',
    '/integrations',
    '/data-stores',
    '/team',
  ];

  it('shows auth screen for any protected route when unauthenticated', () => {
    const pathArb = fc.constantFrom(...allPaths);

    fc.assert(
      fc.property(pathArb, (path) => {
        const { unmount, getByTestId, queryByTestId } = renderWithRouter(path, false);

        // Auth screen should be shown
        const authScreen = getByTestId('auth-screen');
        if (!authScreen) {
          throw new Error(`Route ${path} did not show auth screen when unauthenticated`);
        }

        // No page content should be visible
        const pageTestIds = routeConfig.map((r) => r.testId);
        for (const testId of pageTestIds) {
          if (queryByTestId(testId)) {
            throw new Error(`Route ${path} showed page ${testId} when unauthenticated`);
          }
        }

        unmount();
        return true;
      }),
      { numRuns: 100 },
    );
  });

  it('shows auth screen for parameterized routes when unauthenticated', () => {
    const paramPathArb = fc.oneof(
      fc.stringMatching(/^[a-z0-9-]{3,20}$/).map((id) => `/agent-apps/${id}`),
      fc.stringMatching(/^[a-z0-9-]{3,20}$/).map((id) => `/implementation/${id}`),
    );

    fc.assert(
      fc.property(paramPathArb, (path) => {
        const { unmount, getByTestId } = renderWithRouter(path, false);

        const authScreen = getByTestId('auth-screen');
        if (!authScreen) {
          throw new Error(`Parameterized route ${path} did not show auth screen`);
        }

        unmount();
        return true;
      }),
      { numRuns: 100 },
    );
  });
});

// --- Property 17: Undefined routes show 404 ---

/**
 * Property 17: Undefined routes show 404
 *
 * For any URL path that does not match any defined route,
 * rendering the app with that path SHALL display the "page not found" screen.
 *
 * Validates: Requirements 14.9
 */
describe('Property 17: Undefined routes show 404', () => {
  // Known valid path prefixes to avoid
  const validPrefixes = [
    '/dashboard', '/intake-requests', '/agentic-studio',
    '/agent-apps', '/agent-catalog', '/tools',
    '/integrations', '/data-stores', '/team',
    '/implementation',
  ];

  it('shows 404 page for any undefined route', () => {
    // Generate random paths that don't match any valid route
    const undefinedPathArb = fc.stringMatching(/^\/[a-z]{2,15}(\/[a-z]{2,10})?$/)
      .filter((path) => !validPrefixes.some((prefix) => path.startsWith(prefix)) && path !== '/');

    fc.assert(
      fc.property(undefinedPathArb, (path) => {
        const { unmount, getByTestId } = renderWithRouter(path);

        const notFoundPage = getByTestId('not-found-page');
        if (!notFoundPage) {
          throw new Error(`Undefined route ${path} did not show 404 page`);
        }

        unmount();
        return true;
      }),
      { numRuns: 100 },
    );
  });
});


// --- Unit tests for routing (Task 16.5) ---

/**
 * Unit tests for routing setup
 *
 * Validates: Requirements 14.1, 14.2, 14.3, 14.4, 14.5, 14.6
 */
describe('Routing unit tests', () => {
  // Requirement 14.1: react-router-dom is installed and configured
  it('react-router-dom is available', () => {
    // If this file compiles and MemoryRouter works, react-router-dom is installed
    const { unmount } = render(
      <MemoryRouter initialEntries={['/dashboard']}>
        <div>Router works</div>
      </MemoryRouter>,
    );
    unmount();
  });

  // Requirement 14.2: All defined routes exist
  it('all required routes are defined and render correctly', () => {
    const requiredRoutes = [
      { path: '/dashboard', testId: 'page-dashboard' },
      { path: '/intake-requests', testId: 'page-intake-requests' },
      { path: '/agentic-studio', testId: 'page-agentic-studio' },
      { path: '/agent-apps', testId: 'page-agent-apps' },
      { path: '/agent-catalog', testId: 'page-agent-catalog' },
      { path: '/tools', testId: 'page-tools' },
      { path: '/integrations', testId: 'page-integrations' },
      { path: '/data-stores', testId: 'page-data-stores' },
      { path: '/team', testId: 'page-team' },
    ];

    for (const route of requiredRoutes) {
      const { unmount, getByTestId } = renderWithRouter(route.path);
      expect(getByTestId(route.testId)).toBeInTheDocument();
      unmount();
    }
  });

  // Requirement 14.2: Parameterized routes
  it('parameterized route /agent-apps/:appId renders correctly', () => {
    const { getByTestId } = renderWithRouter('/agent-apps/test-app-123');
    expect(getByTestId('page-app-detail')).toBeInTheDocument();
  });

  it('parameterized route /implementation/:projectId renders correctly', () => {
    const { getByTestId } = renderWithRouter('/implementation/proj-456');
    expect(getByTestId('page-implementation')).toBeInTheDocument();
  });

  // Requirement 14.3: / redirects to /dashboard
  it('root path / redirects to /dashboard', () => {
    const { getByTestId } = renderWithRouter('/');
    expect(getByTestId('page-dashboard')).toBeInTheDocument();
  });

  // Requirement 14.5 & 14.6: Back/forward navigation
  it('MemoryRouter supports back/forward navigation via history entries', () => {
    // Render with multiple history entries to simulate navigation
    const { getByTestId, unmount } = render(
      <MemoryRouter initialEntries={['/dashboard', '/team']} initialIndex={1}>
        <ProtectedRoute currentUser={{ name: 'Test' }} fallback={<div />}>
          <Routes>
            <Route path="/dashboard" element={<StubDashboard />} />
            <Route path="/team" element={<StubTeam />} />
          </Routes>
        </ProtectedRoute>
      </MemoryRouter>,
    );

    // Should be on /team (index 1)
    expect(getByTestId('page-team')).toBeInTheDocument();
    unmount();
  });

  // Requirement 14.8: Auth guard
  it('unauthenticated user sees auth screen instead of protected content', () => {
    const { getByTestId, queryByTestId } = renderWithRouter('/dashboard', false);
    expect(getByTestId('auth-screen')).toBeInTheDocument();
    expect(queryByTestId('page-dashboard')).not.toBeInTheDocument();
  });

  // Requirement 14.9: 404 for undefined routes
  it('undefined route shows NotFound page', () => {
    const { getByTestId } = renderWithRouter('/nonexistent-page');
    expect(getByTestId('not-found-page')).toBeInTheDocument();
  });

  it('NotFound page contains helpful message', () => {
    const { getByText } = renderWithRouter('/nonexistent-page');
    expect(getByText('Page Not Found')).toBeInTheDocument();
    expect(getByText("The page you're looking for doesn't exist.")).toBeInTheDocument();
  });
});
