import { useState, useEffect } from 'react';
import { Routes, Route, Navigate, useNavigate, useParams, useSearchParams } from 'react-router-dom';
import { AuthScreen } from './components/AuthScreen';
import { AppLayout } from './components/AppLayout';
import { Dashboard } from './pages/Dashboard';
import { Team } from './pages/Team';
import { IntakeRequests } from './pages/IntakeRequests';
import { AgentCatalog } from './pages/AgentCatalog';
import { Tools } from './pages/AgentTools';
import { ModelConfiguration } from './pages/ModelConfiguration';
import { Integrations } from './pages/Integrations';
import { DataStores } from './pages/DataStores';
import { AgenticStudio } from './pages/AgenticStudio';
import { AgentApps } from './pages/AgentApps';
import { AppDetailView } from './pages/AppDetailView';
import { ImplementationPage } from './pages/ImplementationPage';
import { PublishConfirmationScreen } from './pages/PublishConfirmationScreen';
import { AppApiDashboard } from './pages/AppApiDashboard';
import { AppBuilderWizard } from './pages/AppBuilderWizard';
import { GovernanceOverview } from './pages/governance/Overview';
import { GovernanceLedger } from './pages/governance/Ledger';
import { GovernanceReconcilerDrift } from './pages/governance/ReconcilerDrift';
import { GovernanceRollout } from './pages/governance/Rollout';
import { GovernanceMismatches } from './pages/governance/Mismatches';
import { GovernanceEscalations } from './pages/governance/Escalations';
import { GovernanceTracer } from './pages/governance/Tracer';
import { GovernanceGraph } from './pages/governance/Graph';
import { GovernanceConstitution } from './pages/governance/Constitution';
import { GovernanceCaseLaw } from './pages/governance/CaseLaw';
import { GovernanceD4Retrospective } from './pages/governance/D4Retrospective';
import { GovernanceIamTrustPath } from './pages/governance/IamTrustPath';
import { NotFound } from './components/NotFound';
import { ProtectedRoute } from './components/ProtectedRoute';
import { ErrorBoundary } from './components/ErrorBoundary';
import { serverService } from './services';
import { OrganizationProvider } from './contexts/OrganizationContext';
import { Toaster } from './components/ui/sonner';
import { TooltipProvider } from '@/components/ui/tooltip';

function AppDetailViewRoute() {
  const navigate = useNavigate();
  const { appId } = useParams<{ appId: string }>();
  const [searchParams] = useSearchParams();
  const initialTab = searchParams.get('tab') ?? undefined;
  if (!appId) return <Navigate to="/agent-apps" replace />;
  return (
    <AppDetailView
      appId={appId}
      initialTab={initialTab}
      onBack={() => navigate('/agent-apps')}
      onNavigate={(view: string) => {
        if (view.startsWith('app-detail:')) {
          const [, id, tab] = view.split(':');
          navigate(tab ? `/agent-apps/${id}?tab=${tab}` : `/agent-apps/${id}`);
        } else if (view.startsWith('app-api-dashboard:')) {
          navigate(`/agent-apps/${view.split(':')[1]}/api-dashboard`);
        } else if (view.startsWith('workflow-editor:')) {
          navigate(`/agentic-studio/workflows/${view.slice('workflow-editor:'.length)}`);
        }
      }}
      onPublishSuccess={(data) => {
        navigate(`/agent-apps/${data.appId}/publish-confirmation`, {
          state: data,
        });
      }}
    />
  );
}

function PublishConfirmationRoute() {
  const navigate = useNavigate();
  const { appId } = useParams<{ appId: string }>();
  // Read state passed via navigate
  const state = (window.history.state?.usr) as { appName?: string; endpointUrl?: string; apiKey?: string } | undefined;
  if (!appId || !state?.endpointUrl) return <Navigate to={`/agent-apps/${appId || ''}`} replace />;
  return (
    <PublishConfirmationScreen
      appId={appId}
      appName={state.appName || ''}
      endpointUrl={state.endpointUrl}
      apiKey={state.apiKey || ''}
      onBack={() => navigate(`/agent-apps/${appId}`)}
      onNavigate={(view: string) => {
        if (view.startsWith('app-api-dashboard:')) {
          navigate(`/agent-apps/${view.split(':')[1]}/api-dashboard`);
        }
      }}
    />
  );
}

function AppApiDashboardRoute() {
  const navigate = useNavigate();
  const { appId } = useParams<{ appId: string }>();
  if (!appId) return <Navigate to="/agent-apps" replace />;
  return (
    <AppApiDashboard
      appId={appId}
      onBack={() => navigate(`/agent-apps/${appId}`)}
      onNavigate={(view: string) => {
        if (view.startsWith('app-detail:')) {
          navigate(`/agent-apps/${view.split(':')[1]}`);
        }
      }}
    />
  );
}

function AgenticStudioWorkflowRoute() {
  const { workflowId } = useParams<{ workflowId: string }>();
  if (!workflowId) return <Navigate to="/agentic-studio" replace />;
  return <AgenticStudio workflowId={workflowId} />;
}

function ImplementationRoute() {
  const navigate = useNavigate();
  const { projectId } = useParams<{ projectId: string }>();
  if (!projectId) return <Navigate to="/agentic-studio" replace />;
  return (
    <ImplementationPage
      projectId={projectId}
      projectName={projectId}
      onBack={() => navigate('/agentic-studio')}
    />
  );
}

function AgentAppsRoute() {
  const navigate = useNavigate();
  return (
    <AgentApps
      onNavigate={(view: string) => {
        if (view.startsWith('app-detail:')) {
          const [, id, tab] = view.split(':');
          navigate(tab ? `/agent-apps/${id}?tab=${tab}` : `/agent-apps/${id}`);
        } else if (view === 'app-builder') {
          navigate('/agent-apps/new');
        }
      }}
    />
  );
}

function AppBuilderRoute() {
  const navigate = useNavigate();
  return (
    <AppBuilderWizard
      onComplete={() => navigate('/agent-apps')}
    />
  );
}

function App() {
  const [currentUser, setCurrentUser] = useState<any>(null);
  const [loading, setLoading] = useState(true);
  const navigate = useNavigate();

  useEffect(() => {
    checkAuthStatus();
  }, []);

  const checkAuthStatus = async () => {
    try {
      const user = await serverService.getCurrentUser();
      if (user) {
        setCurrentUser(user);
      }
    } catch (error) {
      console.log('User not authenticated');
    } finally {
      setLoading(false);
    }
  };

  const handleLogin = (user: any) => {
    setCurrentUser(user);
    navigate('/dashboard');
  };

  const handleLogout = async () => {
    try {
      await serverService.signOut();
      setCurrentUser(null);
      navigate('/');
    } catch (error) {
      console.error('Logout failed:', error);
    }
  };

  if (loading) {
    return (
      <div className="min-h-screen flex items-center justify-center bg-background">
        <div className="text-center">
          <div className="animate-spin rounded-full h-12 w-12 border-b-2 border-primary mx-auto mb-4"></div>
          <p className="text-muted-foreground">Loading...</p>
        </div>
      </div>
    );
  }

  const authFallback = <AuthScreen onLogin={handleLogin} />;

  return (
    <ErrorBoundary>
    <TooltipProvider delayDuration={300}>
      <OrganizationProvider>
        <ProtectedRoute currentUser={currentUser} fallback={authFallback}>
          <AppLayout currentUser={currentUser} onLogout={handleLogout}>
            <Routes>
              <Route path="/" element={<Navigate to="/dashboard" replace />} />
              <Route path="/dashboard" element={<Dashboard />} />
              <Route path="/intake-requests" element={<IntakeRequests />} />
              <Route path="/agentic-studio" element={<AgenticStudio />} />
              <Route path="/agentic-studio/workflows/:workflowId" element={<AgenticStudioWorkflowRoute />} />
              <Route path="/agent-apps" element={<AgentAppsRoute />} />
              <Route path="/agent-apps/new" element={<AppBuilderRoute />} />
              <Route path="/agent-apps/:appId" element={<AppDetailViewRoute />} />
              <Route path="/agent-apps/:appId/publish-confirmation" element={<PublishConfirmationRoute />} />
              <Route path="/agent-apps/:appId/api-dashboard" element={<AppApiDashboardRoute />} />
              <Route path="/agent-catalog" element={<AgentCatalog />} />
              <Route path="/tools" element={<Tools />} />
              <Route path="/model-config" element={<ModelConfiguration />} />
              <Route path="/integrations" element={<Integrations />} />
              <Route path="/data-stores" element={<DataStores />} />
              <Route path="/governance" element={<GovernanceOverview />} />
              <Route path="/governance/ledger" element={<GovernanceLedger />} />
              <Route path="/governance/reconciler" element={<GovernanceReconcilerDrift />} />
              <Route path="/governance/rollout" element={<GovernanceRollout />} />
              <Route path="/governance/mismatches" element={<GovernanceMismatches />} />
              <Route path="/governance/escalations" element={<GovernanceEscalations />} />
              <Route path="/governance/tracer" element={<GovernanceTracer />} />
              <Route path="/governance/graph" element={<GovernanceGraph />} />
              <Route path="/governance/constitution" element={<GovernanceConstitution />} />
              <Route path="/governance/case-law" element={<GovernanceCaseLaw />} />
              <Route path="/governance/d4" element={<GovernanceD4Retrospective />} />
              <Route path="/governance/iam" element={<GovernanceIamTrustPath />} />
              <Route path="/team" element={<Team />} />
              <Route path="/implementation/:projectId" element={<ImplementationRoute />} />
              <Route path="*" element={<NotFound />} />
            </Routes>
          </AppLayout>
        </ProtectedRoute>
        <Toaster />
      </OrganizationProvider>
    </TooltipProvider>
    </ErrorBoundary>
  );
}

export default App;
