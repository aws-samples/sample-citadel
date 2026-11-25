/**
 * App routing — canvas stays mounted across createWorkflow's URL-sync
 * navigate (CIT-291 bug B).
 *
 * Before the fix, /agentic-studio and /agentic-studio/workflows/:workflowId
 * were two separate <Route> elements. AgentBlueprints' URL-sync effect calls
 * navigate(`/agentic-studio/workflows/${id}`, { replace: true }) once the
 * first createWorkflow resolves; because the matched Route element changed,
 * React remounted AgenticStudio -> AgentBlueprints from scratch. The new
 * instance then hydrated via load-by-id (a SECOND getWorkflow call) and
 * replaced local canvas state, discarding any node dropped in the gap.
 *
 * After the fix, both URLs resolve to the SAME /agentic-studio/* route, so
 * the navigate never remounts the tree: getWorkflow via load-by-id is never
 * called (there was no initial workflowId to hydrate), and a node added
 * before the create/navigate completes survives untouched.
 */

import { render, screen, act, fireEvent, waitFor } from '@testing-library/react';
import userEvent from '@testing-library/user-event';
import '@testing-library/jest-dom';
import { MemoryRouter } from 'react-router-dom';
import type { WorkflowNode } from '../types/workflow';

jest.mock('@/components/AuthScreen', () => ({ AuthScreen: () => <div data-testid="auth-screen" /> }));
jest.mock('@/components/AppLayout', () => ({
  AppLayout: ({ children }: { children: React.ReactNode }) => <div data-testid="layout">{children}</div>,
}));
jest.mock('@/components/ui/sonner', () => ({ Toaster: () => null }));
jest.mock('@/components/ui/tooltip', () => ({
  TooltipProvider: ({ children }: { children: React.ReactNode }) => <>{children}</>,
}));
jest.mock('@/contexts/OrganizationContext', () => ({
  OrganizationProvider: ({ children }: { children: React.ReactNode }) => <>{children}</>,
  useOrganization: () => ({
    selectedOrganization: 'org-1',
    currentUser: { organization: 'org-1', userId: 'user-1' },
    canApproveExecutions: false,
  }),
}));
jest.mock('@/services', () => ({
  serverService: {
    getCurrentUser: jest.fn().mockResolvedValue({ name: 'Test User' }),
    signOut: jest.fn().mockResolvedValue(undefined),
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
jest.mock('@/pages/AppDetailView', () => ({ AppDetailView: stubPage('page-app-detail') }));
jest.mock('@/pages/ImplementationPage', () => ({ ImplementationPage: stubPage('page-impl') }));
jest.mock('@/pages/PublishConfirmationScreen', () => ({ PublishConfirmationScreen: stubPage('page-publish-confirm') }));
jest.mock('@/pages/AppApiDashboard', () => ({ AppApiDashboard: stubPage('page-api-dashboard') }));
jest.mock('@/pages/AppBuilderWizard', () => ({ AppBuilderWizard: stubPage('page-app-builder') }));
jest.mock('@/pages/governance/Overview', () => ({ GovernanceOverview: stubPage('page-gov') }));
jest.mock('@/pages/governance/Ledger', () => ({ GovernanceLedger: stubPage('page-gov-ledger') }));
jest.mock('@/pages/governance/ReconcilerDrift', () => ({ GovernanceReconcilerDrift: stubPage('page-gov-reconciler') }));
jest.mock('@/pages/governance/Rollout', () => ({ GovernanceRollout: stubPage('page-gov-rollout') }));
jest.mock('@/pages/governance/Mismatches', () => ({ GovernanceMismatches: stubPage('page-gov-mismatches') }));
jest.mock('@/pages/governance/Escalations', () => ({ GovernanceEscalations: stubPage('page-gov-escalations') }));
jest.mock('@/pages/governance/Tracer', () => ({ GovernanceTracer: stubPage('page-gov-tracer') }));
jest.mock('@/pages/governance/Graph', () => ({ GovernanceGraph: stubPage('page-gov-graph') }));
jest.mock('@/pages/governance/Constitution', () => ({ GovernanceConstitution: stubPage('page-gov-constitution') }));
jest.mock('@/pages/governance/CaseLaw', () => ({ GovernanceCaseLaw: stubPage('page-gov-caselaw') }));
jest.mock('@/pages/governance/D4Retrospective', () => ({ GovernanceD4Retrospective: stubPage('page-gov-d4') }));
jest.mock('@/pages/governance/IamTrustPath', () => ({ GovernanceIamTrustPath: stubPage('page-gov-iam') }));

jest.mock('uuid', () => ({ v4: () => 'test-uuid' }));
jest.mock('@xyflow/react', () => ({
  __esModule: true,
  ReactFlowProvider: ({ children }: { children: React.ReactNode }) => <>{children}</>,
}));

// Stub WorkflowCanvas with an "add node" affordance (same pattern as
// AgentBlueprints.urlSync.test.tsx) and a mount counter so a remount of the
// AgentBlueprints tree is observable directly.
let canvasMountCount = 0;
jest.mock('../components/WorkflowCanvas', () => ({
  WorkflowCanvas: ({ nodes, setNodes }: { nodes: { id: string }[]; setNodes: (fn: (prev: WorkflowNode[]) => WorkflowNode[]) => void }) => {
    const React = jest.requireActual('react');
    React.useEffect(() => {
      canvasMountCount += 1;
    }, []);
    return (
      <div>
        <div data-testid="canvas-nodes">{nodes.map((n) => n.id).join(',')}</div>
        <button
          data-testid="add-node"
          onClick={() =>
            setNodes((prev) => [
              ...prev,
              {
                id: 'node-dropped',
                type: 'agentNode',
                position: { x: 0, y: 0 },
                data: {
                  agentId: 'agent-known',
                  agentConfig: { agentId: 'agent-known', name: 'Known Agent', config: { name: 'Known Agent' }, state: 'active' },
                  label: 'Dropped',
                  inputCount: 1,
                  outputCount: 1,
                  configuration: {},
                },
              },
            ])
          }
        >
          add node
        </button>
      </div>
    );
  },
}));
jest.mock('../components/AgentTray', () => ({ AgentTray: () => <div data-testid="agent-tray" /> }));
jest.mock('../components/WorkflowToolbar', () => ({ WorkflowToolbar: () => <div data-testid="toolbar" /> }));
jest.mock('../components/NodeConfigurationPanel', () => ({ NodeConfigurationPanel: () => null }));
jest.mock('../components/EdgeConditionSheet', () => ({ EdgeConditionSheet: () => null }));
jest.mock('../components/ExecutionOverlay', () => ({ ExecutionOverlay: () => null }));
jest.mock('../components/ExecutionHistoryPanel', () => ({ ExecutionHistoryPanel: () => null }));
jest.mock('../components/RunWorkflowDialog', () => ({ RunWorkflowDialog: () => null }));
jest.mock('../components/BlueprintCatalog', () => ({ BlueprintCatalog: () => <div data-testid="blueprint-catalog" /> }));

jest.mock('../services/workflowApiService', () => ({
  workflowApiService: {
    createWorkflow: jest.fn(),
    updateWorkflow: jest.fn(),
    getWorkflow: jest.fn(),
    publishWorkflow: jest.fn(),
  },
}));
jest.mock('../services/executionApiService', () => ({
  executionApiService: { startExecution: jest.fn(), cancelExecution: jest.fn() },
}));
jest.mock('../services/agentConfigService', () => ({
  agentConfigService: {
    listAgentConfigs: jest.fn().mockResolvedValue([
      { agentId: 'agent-known', name: 'Known Agent', config: { name: 'Known Agent' }, state: 'active' },
    ]),
  },
}));
jest.mock('../services/server', () => ({ __esModule: true, default: { subscribe: jest.fn() } }));

import App from '../App';
import { workflowApiService } from '../services/workflowApiService';

const flush = async () => {
  await act(async () => {
    await Promise.resolve();
    await Promise.resolve();
    await Promise.resolve();
  });
};

describe('App — canvas stays mounted across the create->URL-sync navigate (CIT-291 bug B)', () => {
  let user: ReturnType<typeof userEvent.setup>;

  beforeEach(() => {
    jest.clearAllMocks();
    jest.useFakeTimers();
    user = userEvent.setup({ advanceTimers: jest.advanceTimersByTime.bind(jest) });
    canvasMountCount = 0;
  });

  afterEach(() => {
    jest.useRealTimers();
  });

  it('navigates to the workflow URL after createWorkflow without remounting the canvas (getWorkflow called once)', async () => {
    (workflowApiService.createWorkflow as jest.Mock).mockResolvedValue({
      workflowId: 'wf-new-1',
      status: 'DRAFT',
      version: 1,
    });
    (workflowApiService.updateWorkflow as jest.Mock).mockResolvedValue({
      workflowId: 'wf-new-1',
      status: 'DRAFT',
      version: 2,
    });

    render(
      <MemoryRouter initialEntries={['/agentic-studio']}>
        <App />
      </MemoryRouter>
    );
    await flush();
    await user.click(screen.getByRole('tab', { name: /create agent blueprints/i }));
    await flush();
    expect(canvasMountCount).toBe(1);

    // Drop the first node — this starts the debounced createWorkflow path.
    fireEvent.click(screen.getByTestId('add-node'));
    await act(async () => {
      jest.advanceTimersByTime(2500); // AUTOSAVE_DELAY for createWorkflow
      await Promise.resolve();
    });
    await flush();

    expect(workflowApiService.createWorkflow).toHaveBeenCalledTimes(1);

    // The URL-sync effect now navigates to /agentic-studio/workflows/wf-new-1.
    await waitFor(() => {
      expect(canvasMountCount).toBe(1); // still the same mounted instance
    });

    // load-by-id hydration fetches a workflow by its INITIAL id prop and
    // wholesale-replaces canvas nodes/edges. This canvas created its own
    // workflow rather than opening an existing one; the non-destructive
    // re-entry guard (workflowIdRef.current === initialWorkflowId) must skip
    // that destructive replace once the URL sync feeds the new id back in as
    // a prop on this same mounted instance. The decisive proof is behavioral:
    // the node dropped before the navigate is still on the canvas afterward.
    expect(screen.getByTestId('canvas-nodes')).toHaveTextContent('node-dropped');

    // getWorkflow is called exactly once overall: the persistence hook's own
    // post-create refresh (load() re-running when workflowId state changes).
    // A second, hydration-driven call for the same id would indicate the
    // non-destructive guard failed to skip the destructive replace.
    expect(workflowApiService.getWorkflow).toHaveBeenCalledTimes(1);
  });

  it('a node dropped before the create response/hydration race resolves survives on the canvas', async () => {
    // Simulate the race: createWorkflow resolves slowly, during which the
    // user keeps the node on the canvas. With the single-route fix, no
    // competing load-by-id hydration ever fires to overwrite it.
    let resolveCreate: (value: unknown) => void = () => {};
    (workflowApiService.createWorkflow as jest.Mock).mockImplementation(
      () => new Promise((resolve) => { resolveCreate = resolve; })
    );
    (workflowApiService.updateWorkflow as jest.Mock).mockResolvedValue({
      workflowId: 'wf-new-2',
      status: 'DRAFT',
      version: 2,
    });

    render(
      <MemoryRouter initialEntries={['/agentic-studio']}>
        <App />
      </MemoryRouter>
    );
    await flush();
    await user.click(screen.getByRole('tab', { name: /create agent blueprints/i }));
    await flush();

    fireEvent.click(screen.getByTestId('add-node'));
    expect(screen.getByTestId('canvas-nodes')).toHaveTextContent('node-dropped');

    await act(async () => {
      jest.advanceTimersByTime(2500);
      await Promise.resolve();
    });
    await flush();

    // createWorkflow is in flight; the node must still be on the canvas.
    expect(screen.getByTestId('canvas-nodes')).toHaveTextContent('node-dropped');

    await act(async () => {
      resolveCreate({ workflowId: 'wf-new-2', status: 'DRAFT', version: 1 });
      await Promise.resolve();
      await Promise.resolve();
    });
    await flush();

    // After create resolves and the URL syncs, the node is still there —
    // no remount ever cleared it, and the non-destructive hydration guard
    // prevented a wholesale node/edge replace for a workflow this instance
    // already owns.
    expect(screen.getByTestId('canvas-nodes')).toHaveTextContent('node-dropped');
  });
});
