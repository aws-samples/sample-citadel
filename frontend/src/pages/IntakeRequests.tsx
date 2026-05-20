import { useState, useEffect, useMemo, useRef } from 'react';
import { Plus, FolderOpen } from 'lucide-react';
import { Button } from '../components/ui/button';
import { Card, CardContent } from '../components/ui/card';
import { CreateProject } from '../components/CreateProject';
import { ProjectWorkspace } from '../components/ProjectWorkspace';
import { ProjectCard } from '../components/ProjectCard';
import { PipelineStatsCards } from '../components/PipelineStatsCards';
import { AppBuilderWizard } from './AppBuilderWizard';
import { projectService, type Project } from '../services';
import { subscribeToProjectUpdates } from '../services/projectService';
import { PageContainer } from '../components/PageContainer';
import { cn } from '../components/ui/utils';
import { filterProjects, getFilterCounts, FILTER_TABS, type FilterTab } from './intakeFilters';
import { getLatestUpdatedAt } from './intakePollingUtils';

export { filterProjects, getFilterCounts, type FilterTab } from './intakeFilters';
export { getLatestUpdatedAt } from './intakePollingUtils';

type SubView = 'list' | 'create' | 'workspace' | 'create-app-from-project';

export function IntakeRequests() {
  const [subView, setSubView] = useState<SubView>('list');
  const [projects, setProjects] = useState<Project[]>([]);
  const [selectedProject, setSelectedProject] = useState<Project | null>(null);
  const [loading, setLoading] = useState(true);
  const [error, setError] = useState<string | null>(null);
  const [appPrefill, setAppPrefill] = useState<{ name: string; description: string; agentIds: string[]; integrationIds: string[] } | null>(null);
  const [activeFilter, setActiveFilter] = useState<FilterTab>('All');

  const filteredProjects = useMemo(
    () => filterProjects(projects, activeFilter),
    [projects, activeFilter],
  );

  const filterCounts = useMemo(
    () => getFilterCounts(projects),
    [projects],
  );

  // Track the latest updatedAt timestamp to detect changes efficiently.
  // TODO: Replace polling with GraphQL subscriptions (onCreateProject/onUpdateProject/onDeleteProject)
  // when AppSync subscription support is available on the backend.
  const lastUpdatedAtRef = useRef<string>('');
  const lastCountRef = useRef<number>(-1);

  useEffect(() => {
    loadProjects();

    // Real-time updates via AppSync subscriptions
    const unsubscribe = subscribeToProjectUpdates((project: any) => {
      setProjects(prev => {
        const idx = prev.findIndex(p => p.id === project.id);
        if (idx >= 0) {
          const updated = [...prev];
          updated[idx] = { ...updated[idx], ...project };
          return updated;
        }
        return [project, ...prev];
      });
    });

    // Fallback: 30-second polling if subscription fails
    const interval = setInterval(() => {
      if (subView === 'list') {
        loadProjects(true);
      }
    }, 30000);

    return () => {
      unsubscribe();
      clearInterval(interval);
    };
  }, [subView]);

  const loadProjects = async (silent = false) => {
    if (!silent) {
      setLoading(true);
    }
    setError(null);

    try {
      const projectsList = await projectService.listProjects();

      // Detect changes using updatedAt timestamps and list length instead of JSON.stringify.
      // This is more efficient: O(n) timestamp scan vs O(n) serialization + string comparison.
      const latestUpdatedAt = getLatestUpdatedAt(projectsList);
      const countChanged = projectsList.length !== lastCountRef.current;
      const timestampChanged = latestUpdatedAt !== lastUpdatedAtRef.current;

      if (countChanged || timestampChanged) {
        lastUpdatedAtRef.current = latestUpdatedAt;
        lastCountRef.current = projectsList.length;
        setProjects(projectsList);
      }
    } catch (err: any) {
      console.error('Failed to load projects:', err);
      setError(err.message || 'Failed to load projects');
    } finally {
      if (!silent) {
        setLoading(false);
      }
    }
  };

  const handleCreateProject = () => {
    setSubView('create');
  };

  const handleCreateProjectSubmit = async (name: string, description: string) => {
    setError(null);
    
    try {
      const newProject = await projectService.createProject({
        name,
        description,
      });
      
      setProjects([newProject, ...projects]);
      setSelectedProject(newProject);
      setSubView('workspace');
    } catch (err: any) {
      console.error('Failed to create request:', err);
      setError(err.message || 'Failed to create project');
    }
  };

  const handleSelectAssess = (project: Project) => {
    setSelectedProject(project);
    setSubView('workspace');
  };

  const handleSelectPlan = (project: Project) => {
    setSelectedProject(project);
    setSubView('workspace');
  };

  const handleSelectImplement = (project: Project) => {
    setSelectedProject(project);
    setSubView('workspace');
  };

  const handleCreateAppFromProject = (project: Project) => {
    setAppPrefill({
      name: project.name,
      description: project.description,
      agentIds: [],
      integrationIds: [],
    });
    setSubView('create-app-from-project');
  };

  const handleBackToList = () => {
    setSelectedProject(null);
    setSubView('list');
    loadProjects();
  };

  // Render sub-pages
  if (subView === 'create') {
    return (
      <CreateProject
        onBack={handleBackToList}
        onCreate={handleCreateProjectSubmit}
      />
    );
  }

  if (subView === 'workspace' && selectedProject) {
    return (
      <ProjectWorkspace
        project={selectedProject}
        onBack={handleBackToList}
      />
    );
  }

  if (subView === 'create-app-from-project' && appPrefill) {
    return (
      <AppBuilderWizard
        onComplete={handleBackToList}
        prefill={appPrefill}
      />
    );
  }

  return (
    <PageContainer className="flex-1 flex flex-col bg-background">
      {/* Hero Banner */}

      {/* Main Content */}
      <div className="flex-1">
        <div className="mb-8">
          <div className="flex items-center justify-between mb-2">
            <div className="mb-6">
              <h2 className="text-foreground text-2xl font-semibold">Request Pipeline</h2>
              <p className="text-muted-foreground text-sm">
                Track requests through Assess → Plan → Implement → Iterate stages
              </p>
            </div>
            <Button 
              variant="outline" className="gap-1 text-xs py-1 px-2 h-7"
              onClick={handleCreateProject} 
              disabled={loading}
            >
              <Plus className="size-4" />
              New Intake Request
            </Button>
          </div>
        </div>

        {error && (
          <Card className="mb-6 border-destructive bg-destructive/10">
            <CardContent className="pt-6">
              <p className="text-destructive">{error}</p>
            </CardContent>
          </Card>
        )}

        {/* Pipeline Stats Cards */}
        <PipelineStatsCards projects={projects} />

        {/* Filter Tabs */}
        <div className="flex items-center gap-1 mb-2 rounded-lg p-[5px] bg-accent w-fit">
          {FILTER_TABS.map((tab) => (
            <button
              key={tab}
              onClick={() => setActiveFilter(tab)}
              className={cn(
                'px-3 py-3 text-[10px] font-medium rounded-lg transition-colors',
                activeFilter === tab
                  ? 'text-foreground font-semibold bg-card'
                  : 'text-muted-foreground hover:text-foreground',
              )}
            >
              {tab} ({filterCounts[tab]})
            </button>
          ))}
        </div>

        {loading ? (
          <div className="flex items-center justify-center py-12">
            <div className="text-center">
              <div className="animate-spin rounded-full size-12 border-b-2 border-primary mx-auto mb-4"></div>
              <p className="text-muted-foreground">Loading requests...</p>
            </div>
          </div>
        ) : projects.length === 0 ? (
          <Card className="text-center py-12">
            <CardContent className="flex flex-col gap-4">
              <div className="flex justify-center">
                <div className="size-16 bg-muted rounded-full flex items-center justify-center">
                  <FolderOpen className="size-8 text-muted-foreground" />
                </div>
              </div>
              <div>
                <h3 className="text-foreground mb-2">No intake requests yet</h3>
                <p className="text-muted-foreground mb-4">
                  Create your first request to begin an agentic AI assessment
                </p>
                <Button onClick={handleCreateProject} className="gap-2">
                  <Plus className="size-4" />
                  Create Request
                </Button>
              </div>
            </CardContent>
          </Card>
        ) : filteredProjects.length === 0 ? (
          <div className="text-center py-12">
            <FolderOpen className="size-12 text-muted-foreground mx-auto mb-4" />
            <p className="text-muted-foreground mb-4">
              No {activeFilter.toLowerCase()} requests match this filter.
            </p>
          </div>
        ) : (
          <div className="grid gap-4">
            {filteredProjects.map((project) => (
              <ProjectCard 
                key={project.id}
                project={project} 
                onSelectAssess={handleSelectAssess} 
                onSelectPlan={handleSelectPlan}
                onSelectImplement={handleSelectImplement}
                onCreateAppFromProject={handleCreateAppFromProject}
              />
            ))}
          </div>
        )}

      </div>
    </PageContainer>
  );
}
