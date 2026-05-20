import { useState } from 'react';
import { GitBranch, List } from 'lucide-react';
import { AgentBlueprints } from '../components/AgentBlueprints';
import { BlueprintCatalog } from '../components/BlueprintCatalog';
import { Tabs, TabsList, TabsTrigger, TabsContent } from '../components/ui/tabs';
import { ErrorBoundary } from '../components/ErrorBoundary';

type SubSection = 'agent-blueprints' | 'blueprints-list';

export function AgenticStudio() {
  const [activeSection, setActiveSection] = useState<SubSection>('blueprints-list');

  const sections = [
    { id: 'blueprints-list' as SubSection, label: 'Agent Blueprints', icon: List },
    { id: 'agent-blueprints' as SubSection, label: 'Create Agent Blueprints', icon: GitBranch },
  ];

  return (
    <Tabs value={activeSection} onValueChange={(v) => setActiveSection(v as SubSection)} className="h-full flex flex-col">
      <div className="border-b border-border/50 bg-card">
        <div className="max-w-7xl mx-auto px-4 sm:px-6 lg:px-8">
          <TabsList>
            {sections.map((section) => (
              <TabsTrigger key={section.id} value={section.id}>
                <section.icon className="size-4" />
                {section.label}
              </TabsTrigger>
            ))}
          </TabsList>
        </div>
      </div>

      <TabsContent value="blueprints-list" className="flex-1 overflow-y-auto">
        <ErrorBoundary>
          <BlueprintCatalog />
        </ErrorBoundary>
      </TabsContent>
      <TabsContent value="agent-blueprints" className="flex-1 overflow-y-auto">
        <ErrorBoundary>
          <AgentBlueprints />
        </ErrorBoundary>
      </TabsContent>
    </Tabs>
  );
}
