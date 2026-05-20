import { Search, Code, MapPin, MoreVertical, Play } from 'lucide-react';
import { Card, CardContent, CardDescription, CardHeader, CardTitle } from './ui/card';
import { Badge } from './ui/badge';
import { Button } from './ui/button';
import { Progress } from './ui/progress';
import { StatusCard } from './ui/status-card';
import { cn } from '@/components/ui/utils';
import {
  DropdownMenu,
  DropdownMenuContent,
  DropdownMenuItem,
  DropdownMenuTrigger,
} from './ui/dropdown-menu';
import { Project } from '../services';

interface ProjectCardProps {
  project: Project;
  onSelectAssess: (project: Project) => void;
  onSelectPlan: (project: Project) => void;
  onSelectImplement: (project: Project) => void;
  onCreateAppFromProject?: (project: Project) => void;
}

export function ProjectCard({ project, onSelectAssess, onSelectPlan, onSelectImplement, onCreateAppFromProject }: ProjectCardProps) {
  const formatDate = (date: Date | string) => {
    const dateObj = typeof date === 'string' ? new Date(date) : date;
    return new Intl.DateTimeFormat('en-US', {
      month: 'short',
      day: 'numeric',
      year: 'numeric',
    }).format(dateObj);
  };

  const handleSelect = () => {
    if (project.progress && project.progress.assessment < 100) {
      onSelectAssess(project);
    } else if (project.progress && project.progress.planning < 100) {
      onSelectPlan(project);
    } else {
        onSelectImplement(project);
    }
  };

  const selectPin = () => {
    let pin: any;
    if(project.progress && project.progress.assessment < 100){
      pin = <Search className="size-3 text-primary" />;
    } else if (project.progress && project.progress.planning < 100){ 
      pin = <MapPin className="size-3 text-primary" />;
    } else {
      pin = <Code className="size-3 text-primary" />;
    }

    return pin;
    
  }

  return (
    <Card className="cursor-pointer hover:border-primary transition-colors bg-background">
      <CardHeader className="flex items-start justify-between mb-4">
        <div className="flex-1">
          <CardTitle className="text-foreground text-xl font-semibold">{project.name}</CardTitle>
          <CardDescription className="text-muted-foreground text-sm mb-3">
            {project.description}
          </CardDescription>
          <div className="flex items-center gap-4 text-xs text-muted-foreground">
            <span>Created {formatDate(project.createdAt)}</span>
          </div>
        </div>
        <DropdownMenu>
          <DropdownMenuTrigger asChild>
            <Button variant="ghost" size="icon">
              <MoreVertical className="size-5" />
            </Button>
          </DropdownMenuTrigger>
          <DropdownMenuContent>
            <DropdownMenuItem onClick={handleSelect}>View Details</DropdownMenuItem>
          </DropdownMenuContent>
        </DropdownMenu>
      </CardHeader>
      <CardContent className="flex flex-col gap-3">
        {project.progress && (
            <>
          <div className="flex flex-col gap-2">
            <div className="flex items-center justify-between gap-2 mb-4">
              <div className="flex items-center gap-2 px-3 py-1 bg-primary/10 rounded-full">
                {selectPin()} 
                <span className="text-primary text-sm">
                  <Badge
                    variant={project.status === 'COMPLETED' ? 'default' : 'secondary'}
                    className={project.status === 'COMPLETED' ? 'bg-primary' : ''}
                  >
                    {project.progress.currentPhase || 'In Progress'}
                  </Badge>
                </span>
              </div>
              <span className="text-muted-foreground text-sm">
                {Math.round(project.progress.overall)}% complete
              </span>
            </div>
            <Progress value={project.progress.overall} className="w-full rounded-full mb-6 bg-muted h-[6px]" />
          </div>
        
          <div className="flex gap-4 mb-6">
            <StatusCard status={project.progress.assessment == 100 ? "completed" : "in_progress"} className="bg-background rounded-lg p-4 w-1/3">
              <div className="flex items-center gap-2 mb-3">
                <div className="size-6 rounded bg-primary/10 flex items-center justify-center">
                  <Search className="size-3 text-primary" />
                </div>
                <h4 className="text-foreground text-sm font-semibold">Assess</h4>
              </div>
              <p className="text-primary text-xs font-medium mb-3">{project.progress.assessment}% complete</p>
                <button
                    onClick={() => onSelectAssess(project)} 
                    className="w-full px-3 py-2 bg-accent hover:bg-accent border border-border text-foreground text-xs font-medium rounded transition-colors">
                Status & Details
                </button>
            </StatusCard>

            <StatusCard status={project.progress.assessment == 100 ? (project.progress.planning == 100 ? "completed" : "in_progress") : "pending"} className={cn('bg-background rounded-lg p-4 w-1/3', project.progress.assessment < 100 && 'opacity-60')}>
              <div className="flex items-center gap-2 mb-3">
                <div className="size-6 rounded bg-accent flex items-center justify-center">
                  <MapPin className="size-3 text-accent-foreground" />
                </div>
                <h4 className="text-foreground text-sm font-semibold">Plan</h4>
              </div>
              <p className="text-muted-foreground text-xs font-medium mb-3">{project.progress.planning}% complete</p>
              <button 
                  disabled={project.progress.assessment < 100}
                  aria-disabled={project.progress.assessment < 100 ? "true" : undefined}
                  onClick={() => onSelectPlan(project)} 
                  className={cn('w-full px-3 py-2 bg-accent border border-border text-xs font-medium rounded', project.progress.assessment < 100 ? 'text-muted-foreground cursor-not-allowed' : 'text-foreground hover:bg-accent transition-colors')}>
                Status & Details
              </button>
            </StatusCard>

            <StatusCard status={project.progress.planning == 100 ? (project.progress.implementation == 100 ? "completed" : "in_progress") : "pending"} className={cn('bg-background border border-border rounded-lg p-4 w-1/3', project.progress.planning < 100 && 'opacity-60')}>
              <div className="flex items-center gap-2 mb-3">
                <div className="size-6 rounded bg-primary/10 flex items-center justify-center">
                  <Code className="size-3 text-primary" />
                </div>
                <h4 className="text-foreground text-sm font-semibold">Implement</h4>
              </div>
              <p className="text-muted-foreground text-xs font-medium mb-3">{project.progress.implementation}% complete</p>
              <button 
                  disabled={project.progress.planning < 100}
                  aria-disabled={project.progress.planning < 100 ? "true" : undefined}
                  onClick={() => onSelectImplement(project)} 
                  className={cn('w-full px-3 py-2 bg-accent border border-border text-xs font-medium rounded', project.progress.planning < 100 ? 'text-muted-foreground cursor-not-allowed' : 'text-foreground hover:bg-accent transition-colors')}>
                Status & Details
              </button>
            </StatusCard>
          
        </div>
        <div className="flex justify-end">
          <Button onClick={handleSelect}>
            <Play className="size-4" />
            Continue
          </Button>
        </div>
        {project.progress && project.progress.implementation === 100 && (
          <div className="flex justify-end mt-2">
            <Button variant="outline" onClick={() => onCreateAppFromProject?.(project)}>
              Create App from Project
            </Button>
          </div>
        )}
        </>
        )}
      </CardContent>
    </Card>
  );
}
