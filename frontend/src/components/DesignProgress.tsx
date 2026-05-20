import { useState, useEffect } from 'react';
import { Card, CardContent, CardHeader, CardTitle } from './ui/card';
import { Progress } from './ui/progress';
import { FileText } from 'lucide-react';
import { projectService } from '../services/projectService';

interface DesignProgressProps {
  projectId: string;
  isGenerating?: boolean;
}

export function DesignProgress({ projectId, isGenerating = false }: DesignProgressProps) {
  const [progress, setProgress] = useState(0);
  const [currentSection, setCurrentSection] = useState<string>('');
  const [hasStarted, setHasStarted] = useState(false);

  useEffect(() => {
    const unsubscribe = projectService.subscribeToDesignProgress(
      projectId,
      (data) => {
        setHasStarted(true);
        setProgress(data.completionPercentage);
        setCurrentSection(data.sectionId);
      }
    );
    return unsubscribe;
  }, [projectId]);

  if (!isGenerating && !hasStarted) return null;

  return (
    <div className="flex flex-col gap-2">
      <div className="flex justify-between text-sm">
        <span className="text-muted-foreground">
          {currentSection ? `Section ${currentSection}` : 'Initializing...'}
        </span>
        <span className="font-medium">{progress}%</span>
      </div>
      <Progress value={progress} className="h-2" />
    </div>
  );
}
