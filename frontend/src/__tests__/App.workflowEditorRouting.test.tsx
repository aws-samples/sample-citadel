/**
 * App routing — 'workflow-editor:<id>' navigation prefix.
 *
 * AppDetailView emits onNavigate('workflow-editor:<workflowId>') for each
 * workflow card's Open action. The real App wiring must translate that into
 * navigation to the Agentic Studio with the workflowId, and a direct URL to
 * the studio workflow route must render the studio with that id.
 *
 * All pages are stubbed; the real App component (routes + onNavigate
 * handlers) is under test.
 */

import { render, screen, fireEvent, waitFor } from '@testing-library/react';
import '@testing-library/jest-dom';
import { MemoryRouter } from 'react-router-dom';

// --- Chrome / infrastructure stubs ---
jest.mock('@/components/AuthScreen', () => ({
  AuthScreen: () => <div data-testid="auth-screen" />,
}));
jest.mock('@/components/AppLayout', () => ({
  AppLayout: ({ children }: any) => <div data-testid="layout">{children}</div>,
}));
jest.mock('@/components/ui/sonner', () => ({ Toaster: () => null }));
jest.mock('@/components/ui/tooltip', () => ({
  TooltipProvider: ({ children }: any) => <>{children}</>,
}));
jest.mock('@/contexts/OrganizationContext', () => ({
  OrganizationProvider: ({ children }: any) => <>{children}</>,
  useOrganization: () => ({ selectedOrganization: 'org-1' }),
}));
jest.mock('@/services', () => ({
  serverService: {
    getCurrentUser: jest.fn().mockResolvedValue({ name: 'Test User' }),
    signOut: jest.fn().mockResolvedValue(undefined),
  },
}));

// --- Page stubs ---
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

// The studio stub echoes the workflowId it was mounted with.
jest.mock('@/pages/AgenticStudio', () => ({
  AgenticStudio: ({ workflowId }: { workflowId?: string }) => (
    <div data-testid="page-agentic-studio">{workflowId ?? 'no-workflow-id'}</div>
  ),
}));

// AppDetailView stub emits the real navigation prefix its workflow cards use.
jest.mock('@/pages/AppDetailView', () => ({
  AppDetailView: ({ onNavigate }: any) => (
    <button
      data-testid="open-workflow-editor"
      onClick={() => onNavigate('workflow-editor:wf-123')}
    >
      Open in editor
    </button>
  ),
}));

import App from '../App';

function renderAppAt(path: string) {
  return render(
    <MemoryRouter initialEntries={[path]}>
      <App />
    </MemoryRouter>
  );
}

describe("App routing for 'workflow-editor:' navigation", () => {
  it('AppDetailView onNavigate(workflow-editor:<id>) opens the studio with that workflowId', async () => {
    renderAppAt('/agent-apps/app-1');

    const openButton = await screen.findByTestId('open-workflow-editor');
    fireEvent.click(openButton);

    await waitFor(() => {
      expect(screen.getByTestId('page-agentic-studio')).toHaveTextContent('wf-123');
    });
  });

  it('a direct studio workflow URL renders the studio with the workflowId', async () => {
    renderAppAt('/agentic-studio/workflows/wf-9');

    const studio = await screen.findByTestId('page-agentic-studio');
    expect(studio).toHaveTextContent('wf-9');
  });

  it('the bare studio URL renders the studio without a workflowId', async () => {
    renderAppAt('/agentic-studio');

    const studio = await screen.findByTestId('page-agentic-studio');
    expect(studio).toHaveTextContent('no-workflow-id');
  });
});
