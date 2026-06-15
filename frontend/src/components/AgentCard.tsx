import { Pause, Play, Settings, Bot } from 'lucide-react';
import { Button } from './ui/button';
import { Badge } from './ui/badge';
import { Card, CardContent, CardDescription, CardHeader, CardTitle } from './ui/card';
import { AgentConfig } from '../services/agentConfigService';

interface AgentCardProps {
  agent: AgentConfig;
  onToggleState: (agent: AgentConfig) => void;
  onConfigure: (agentId: string) => void;
  userRole?: string;
}

export function AgentCard({ agent, onToggleState, onConfigure, userRole }: AgentCardProps) {
  // Parse config if it's a string
  const config = typeof agent.config === 'string' ? (() => { try { return JSON.parse(agent.config); } catch { return {}; } })() : (agent.config ?? {});

  // Display name: prefer agent.name (from registry), then config.name, then agentId
  const displayName = (agent as any).name || config?.name || agent.agentId;

  // Only show config button for admin and developer roles
  const canConfigure = userRole === 'admin' || userRole === 'developer';

  return (
    <Card 
      className="hover:shadow-lg transition-shadow border-input bg-accent"
    >
      <CardHeader className="pb-1">
        <div className="flex items-start justify-between">
          <div className="flex items-center gap-3">
            <div className="p-2 rounded-lg bg-white/5">
              <Bot className="size-6 text-muted-foreground" />
            </div>
            <div>

              <div className="flex items-center gap-2 flex-wrap text-xs text-muted-foreground">
                <CardTitle className="text-lg text-foreground">
                  {displayName}
                </CardTitle>
                {agent.categories?.includes('built-in') && (
                  <Badge className="bg-chart-4/20 text-chart-4 border-0">
                    Built-in
                  </Badge>
                )}
                {agent.categories?.includes('worker') && (
                  <Badge className="bg-chart-5/20 text-chart-5 border-0">
                    Worker
                  </Badge>
                )}
              </div>
            </div>
          </div>
          <div className="flex items-center gap-1">
            <Badge 
              className={
                agent.state === 'active'
                  ? 'bg-chart-2/20 text-chart-2 border-0'
                  : 'bg-muted/20 text-muted-foreground border-0'
              }
            >
              {agent.state}
            </Badge>
          </div>
        </div>
      </CardHeader>
      
      <CardContent className="flex flex-col gap-4">
        <CardDescription className="text-muted-foreground">
          {config?.description || 'No description available'}
        </CardDescription>

        <div className="grid grid-cols-2 gap-4 text-sm">
          <div>
            <span className="text-muted-foreground">Version</span>
            <p className="font-semibold text-foreground">{config?.version || 'v0.0.0'}</p>
          </div>
          <div>
            <span className="text-muted-foreground">Agent ID</span>
            <p className="font-semibold text-foreground text-xs truncate">{agent.agentId}</p>
          </div>
        </div>
        
        {/* Schema Info */}
        {config?.schema && Object.keys(config.schema.properties || {}).length > 0 && (
          <div className="flex flex-col gap-2">
            <span className="text-sm font-medium text-muted-foreground">Schema Properties</span>
            <div className="flex flex-wrap gap-1">
              {Object.keys(config.schema.properties || {}).slice(0, 3).map((prop, index) => (
                <Badge
                  key={index}
                  className="bg-accent text-muted-foreground border-0"
                >
                  {prop}
                </Badge>
              ))}
              {Object.keys(config.schema.properties || {}).length > 3 && (
                <Badge className="bg-accent text-muted-foreground border-0">
                  +{Object.keys(config.schema.properties || {}).length - 3} more
                </Badge>
              )}
            </div>
          </div>
        )}

        {/* Action Type */}
        {config?.action && (
          <div className="text-xs text-muted-foreground pt-2 border-t border-border">
            Action Type: {config.action.type}
          </div>
        )}
        
        <div className="flex gap-2 pt-2">
          {agent.state === 'active' ? (
            <Button
              variant="outline"
              size="sm"
              className="flex-1 bg-transparent border-border text-foreground hover:bg-accent"
              onClick={() => onToggleState(agent)}
            >
              <Pause className="size-4 mr-1" />
              Deactivate
            </Button>
          ) : (
            <Button
              variant="outline"
              size="sm"
              className="flex-1 bg-transparent border-border text-foreground hover:bg-accent"
              onClick={() => onToggleState(agent)}
            >
              <Play className="size-4 mr-1" />
              Activate
            </Button>
          )}
          {canConfigure && (
            <Button
              variant="outline"
              size="sm"
              className="bg-transparent border-border text-foreground hover:bg-accent"
              onClick={() => onConfigure(agent.agentId)}
            >
              <Settings className="size-4" />
            </Button>
          )}
        </div>
      </CardContent>
    </Card>
  );
}
