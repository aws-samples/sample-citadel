import { Search, MapPin, Code, CheckCircle2 } from 'lucide-react';
import { Project } from '../services';

interface PipelineStatsCardsProps {
  projects: Project[];
}

export function PipelineStatsCards({ projects }: PipelineStatsCardsProps) {
  // Calculate counts based on project progress
  const stats = projects.reduce(
    (acc, project) => {
      const assessmentProgress = project.progress?.assessment || 0;
    //   const designProgress = project.progress?.design || 0;
      const planningProgress = project.progress?.planning || 0;
      const implementationProgress = project.progress?.implementation || 0;

      // Assess: assessment not complete
      if (assessmentProgress < 100) {
        acc.assess++;
      }
      // Plan: assessment complete but planning not complete
      else if (assessmentProgress === 100 && planningProgress < 100) {
        acc.plan++;
      }
      // Implement: design complete but implementation not complete
      else if (planningProgress === 100 && implementationProgress < 100) {
        acc.implement++;
      }
      // Completed: all stages complete
      else if (
        assessmentProgress === 100 &&
        planningProgress === 100 &&
        implementationProgress === 100
      ) {
        acc.completed++;
      }

      return acc;
    },
    { assess: 0, plan: 0, implement: 0, completed: 0 }
  );

  return (
    <div className="flex gap-4 mb-4">
      {/* Assess */}
      <div
        className="flex-1 rounded-lg p-4 border border-primary/30 bg-primary/10"
      >
        <div className="flex items-center justify-between mb-3">
          <p className="text-foreground text-sm">Assess</p>
          <div className="size-10 rounded-lg flex items-center justify-center shrink-0">
            <Search className="size-6 text-primary" />
          </div>
        </div>
        <p className="text-foreground text-3xl font-bold">{stats.assess}</p>
      </div>

      {/* Plan */}
      <div
        className="flex-1 rounded-lg p-4 border border-chart-5/30 bg-chart-5/10"
      >
        <div className="flex items-center justify-between mb-3">
          <p className="text-foreground text-sm">Plan</p>
          <div className="size-10 rounded-lg flex items-center justify-center shrink-0">
            <MapPin className="size-6 text-chart-5" />
          </div>
        </div>
        <p className="text-foreground text-3xl font-bold">{stats.plan}</p>
      </div>

      {/* Implement */}
      <div
        className="flex-1 rounded-lg p-4 border border-primary/30 bg-primary/10"
      >
        <div className="flex items-center justify-between mb-3">
          <p className="text-foreground text-sm">Implement</p>
          <div className="size-10 rounded-lg flex items-center justify-center shrink-0">
            <Code className="size-6 text-primary" />
          </div>
        </div>
        <p className="text-foreground text-3xl font-bold">{stats.implement}</p>
      </div>

      {/* Completed */}
      <div
        className="flex-1 rounded-lg p-4 border border-emerald-500/30 bg-emerald-500/10"
      >
        <div className="flex items-center justify-between mb-3">
          <p className="text-foreground text-sm">Completed</p>
          <div className="size-10 rounded-lg flex items-center justify-center shrink-0">
            <CheckCircle2 className="size-6 text-emerald-500" />
          </div>
        </div>
        <p className="text-foreground text-3xl font-bold">{stats.completed}</p>
      </div>
    </div>
  );
}
