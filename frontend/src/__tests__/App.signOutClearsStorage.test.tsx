/**
 * App — sign-out clears user-scoped localStorage.
 *
 * RunWorkflowDialog remembers the last run input under
 * `citadel:run-input:<workflowId>` and AgentBlueprints autosaves canvas
 * drafts under `workflow-autosave`, neither scoped to the signed-in user
 * nor cleared on sign-out — so a second user signing in on the same browser
 * could see the first user's remembered input/draft. App.tsx's logout
 * handler (handleLogout) must clear every key under either prefix.
 *
 * AppLayout is stubbed with a button that invokes the onLogout prop it
 * receives from App, so this test exercises the REAL handleLogout in App.tsx.
 */

import { render, screen, fireEvent, waitFor } from '@testing-library/react';
import '@testing-library/jest-dom';
import { MemoryRouter } from 'react-router-dom';
import {
  runInputStorageKey,
  workflowAutosaveStorageKey,
} from '../utils/userScopedStorage';

jest.mock('@/components/AuthScreen', () => ({
  AuthScreen: () => <div data-testid="auth-screen" />,
}));

// Exposes the onLogout prop passed down from App so the test can trigger it.
jest.mock('@/components/AppLayout', () => ({
  AppLayout: ({
    children,
    onLogout,
  }: React.PropsWithChildren<{ onLogout?: () => void }>) => (
    <div data-testid="layout">
      <button data-testid="sign-out-button" onClick={onLogout}>
        Sign out
      </button>
      {children}
    </div>
  ),
}));

jest.mock('@/components/ui/sonner', () => ({ Toaster: () => null }));
jest.mock('@/components/ui/tooltip', () => ({
  TooltipProvider: ({ children }: React.PropsWithChildren<unknown>) => <>{children}</>,
}));
jest.mock('@/contexts/OrganizationContext', () => ({
  OrganizationProvider: ({ children }: React.PropsWithChildren<unknown>) => <>{children}</>,
  useOrganization: () => ({ selectedOrganization: 'org-1', currentUser: { userId: 'user-a' } }),
}));
jest.mock('@/contexts/GovernanceModeContext', () => ({
  GovernanceModeProvider: ({ children }: React.PropsWithChildren<unknown>) => <>{children}</>,
}));

const mockSignOut = jest.fn().mockResolvedValue(undefined);
jest.mock('@/services', () => ({
  serverService: {
    getCurrentUser: jest.fn().mockResolvedValue({ userId: 'user-a', username: 'user-a' }),
    signOut: mockSignOut,
  },
}));

const stubPage = (testId: string) => () => <div data-testid={testId} />;
jest.mock('@/pages/Dashboard', () => ({ Dashboard: stubPage('page-dashboard') }));
jest.mock('@/pages/Team', () => ({ Team: stubPage('page-team') }));
jest.mock('@/pages/IntakeRequests', () => ({ IntakeRequests: stubPage('page-intake') }));
jest.mock('@/pages/AgentCatalog', () => ({ AgentCatalog: stubPage('page-catalog') }));
jest.mock('@/pages/AgentTools', () => ({ Tools: stubPage('page-tools') }));
jest.mock('@/pages/ModelConfiguration', () => ({ ModelConfiguration: stubPage('page-models') }));
jest.mock('@/pages/Integrations', () => ({ Integrations: stubPage('page-integrations') }));
jest.mock('@/pages/DataStores', () => ({ DataStores: stubPage('page-datastores') }));
jest.mock('@/pages/AgentApps', () => ({ AgentApps: stubPage('page-agent-apps') }));
jest.mock('@/pages/ImplementationPage', () => ({ ImplementationPage: stubPage('page-impl') }));
jest.mock('@/pages/PublishConfirmationScreen', () => ({
  PublishConfirmationScreen: stubPage('page-publish-confirm'),
}));
jest.mock('@/pages/AppApiDashboard', () => ({ AppApiDashboard: stubPage('page-api-dashboard') }));
jest.mock('@/pages/AppBuilderWizard', () => ({ AppBuilderWizard: stubPage('page-app-builder') }));
jest.mock('@/pages/governance/Overview', () => ({ GovernanceOverview: stubPage('page-gov') }));
jest.mock('@/pages/governance/Ledger', () => ({ GovernanceLedger: stubPage('page-gov-ledger') }));
jest.mock('@/pages/governance/ReconcilerDrift', () => ({
  GovernanceReconcilerDrift: stubPage('page-gov-reconciler'),
}));
jest.mock('@/pages/governance/Rollout', () => ({ GovernanceRollout: stubPage('page-gov-rollout') }));
jest.mock('@/pages/governance/Mismatches', () => ({
  GovernanceMismatches: stubPage('page-gov-mismatches'),
}));
jest.mock('@/pages/governance/Escalations', () => ({
  GovernanceEscalations: stubPage('page-gov-escalations'),
}));
jest.mock('@/pages/governance/Tracer', () => ({ GovernanceTracer: stubPage('page-gov-tracer') }));
jest.mock('@/pages/governance/Graph', () => ({ GovernanceGraph: stubPage('page-gov-graph') }));
jest.mock('@/pages/governance/Constitution', () => ({
  GovernanceConstitution: stubPage('page-gov-constitution'),
}));
jest.mock('@/pages/governance/CaseLaw', () => ({ GovernanceCaseLaw: stubPage('page-gov-caselaw') }));
jest.mock('@/pages/governance/D4Retrospective', () => ({
  GovernanceD4Retrospective: stubPage('page-gov-d4'),
}));
jest.mock('@/pages/governance/IamTrustPath', () => ({
  GovernanceIamTrustPath: stubPage('page-gov-iam'),
}));
jest.mock('@/pages/governance/EvalComparison', () => ({
  GovernanceEvalComparison: stubPage('page-gov-eval-comparison'),
}));
jest.mock('@/pages/Observability', () => ({ Observability: stubPage('page-observability') }));
jest.mock('@/pages/AppDetailView', () => ({ AppDetailView: stubPage('page-app-detail') }));
jest.mock('@/pages/AgenticStudio', () => ({ AgenticStudio: stubPage('page-agentic-studio') }));
jest.mock('@/pages/ApprovalsPage', () => ({ ApprovalsPage: stubPage('page-approvals') }));
jest.mock('@/components/NotFound', () => ({ NotFound: stubPage('page-not-found') }));
jest.mock('@/components/RequireAdmin', () => ({
  RequireAdmin: ({ children }: React.PropsWithChildren<unknown>) => <>{children}</>,
}));

import App from '../App';

function renderApp() {
  return render(
    <MemoryRouter initialEntries={['/dashboard']}>
      <App />
    </MemoryRouter>
  );
}

describe('App — sign-out clears user-scoped localStorage', () => {
  beforeEach(() => {
    localStorage.clear();
    jest.clearAllMocks();
    mockSignOut.mockResolvedValue(undefined);
  });

  it('clicking sign-out removes every citadel:run-input:* and workflow-autosave:* key', async () => {
    localStorage.setItem(runInputStorageKey('user-a', 'wf-1'), '{"remembered":true}');
    localStorage.setItem(runInputStorageKey('user-a', 'wf-2'), '{"remembered":true}');
    localStorage.setItem(workflowAutosaveStorageKey('user-a'), '{"nodes":[]}');
    localStorage.setItem('unrelated-key', 'keep-me');

    renderApp();

    const signOutButton = await screen.findByTestId('sign-out-button');
    fireEvent.click(signOutButton);

    await waitFor(() => {
      expect(mockSignOut).toHaveBeenCalled();
    });

    await waitFor(() => {
      expect(localStorage.getItem(runInputStorageKey('user-a', 'wf-1'))).toBeNull();
    });
    expect(localStorage.getItem(runInputStorageKey('user-a', 'wf-2'))).toBeNull();
    expect(localStorage.getItem(workflowAutosaveStorageKey('user-a'))).toBeNull();
    expect(localStorage.getItem('unrelated-key')).toBe('keep-me');
  });
});
