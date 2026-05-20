import { Pause, Play, Settings, Wrench } from 'lucide-react';
import { useState } from 'react';
import { Button } from './ui/button';
import { Badge } from './ui/badge';
import { Card, CardContent, CardDescription, CardHeader, CardTitle } from './ui/card';
import { ToolConfig } from '../services/toolConfigService';
import { extractBindingBadges } from './tool-card-badge-helpers';
import { ToolTestingSandbox } from './ToolTestingSandbox';
import { ErrorBoundary } from './ErrorBoundary';
import { useOrganization } from '../contexts/OrganizationContext';

interface ToolCardProps {
  tool: ToolConfig;
  onToggleState: (tool: ToolConfig) => void;
  onConfigure: (toolId: string) => void;
  userRole?: string;
  orgId?: string;
}

export function ToolCard({ tool, onToggleState, onConfigure, userRole, orgId }: ToolCardProps) {
  const { selectedOrganization } = useOrganization();
  const resolvedOrgId = orgId || selectedOrganization || 'default';
  const [showSandbox, setShowSandbox] = useState(false);
  // Parse config if it's a string
  const config = typeof tool.config === 'string' 
    ? JSON.parse(tool.config) 
    : tool.config;

  // Only show config button for admin and developer roles
  const canConfigure = userRole === 'admin' || userRole === 'developer';

  return (
    <Card 
      className="hover:shadow-lg transition-shadow border-input bg-accent"
    >
      <CardHeader className="pb-4">
        <div className="flex items-start justify-between">
          <div className="flex items-center gap-3">
            <div className="p-2 rounded-lg bg-white/5">
              <Wrench className="size-6 text-muted-foreground" />
            </div>
            <div>
              <div className="flex items-center gap-2">
                <CardTitle className="text-lg text-foreground">
                  {config?.name || tool.toolId}
                </CardTitle>
                {tool.categories?.includes('built-in') && (
                  <Badge className="bg-chart-4/20 text-chart-4 border-0">
                    Built-in
                  </Badge>
                )}
              </div>
              <p className="text-xs text-muted-foreground">
                Tool
              </p>
            </div>
          </div>
          <div className="flex items-center gap-1">
            <Badge 
              className={
                tool.state === 'active'
                  ? 'bg-chart-2/20 text-chart-2 border-0'
                  : 'bg-muted/20 text-muted-foreground border-0'
              }
            >
              {tool.state}
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
            <span className="text-muted-foreground">Tool ID</span>
            <p className="font-semibold text-foreground text-xs truncate">{tool.toolId}</p>
          </div>
        </div>
        
        {/* Categories */}
        {tool.categories && tool.categories.length > 0 && (
          <div className="flex flex-col gap-2">
            <span className="text-sm font-medium text-muted-foreground">Categories</span>
            <div className="flex flex-wrap gap-1">
              {tool.categories.slice(0, 3).map((cat, index) => (
                <Badge
                  key={index}
                  className="bg-accent text-muted-foreground border-0"
                >
                  {cat}
                </Badge>
              ))}
              {tool.categories.length > 3 && (
                <Badge className="bg-accent text-muted-foreground border-0">
                  +{tool.categories.length - 3} more
                </Badge>
              )}
            </div>
          </div>
        )}

        {/* Binding Badges */}
        {(() => {
          const badges = extractBindingBadges(tool);
          if (badges.length === 0) return null;
          return (
            <div className="flex flex-col gap-2">
              <span className="text-sm font-medium text-muted-foreground">Bindings</span>
              <div className="flex flex-wrap gap-1">
                {badges.map((badge, index) => (
                  <Badge
                    key={`${badge.type}-${index}`}
                    className={
                      badge.type === 'integration'
                        ? 'bg-primary/20 text-primary border-0'
                        : 'bg-chart-2/20 text-chart-2 border-0'
                    }
                  >
                    {badge.label}
                  </Badge>
                ))}
              </div>
            </div>
          );
        })()}

        {/* Parameters Info */}
        {config?.parameters && Object.keys(config.parameters).length > 0 && (
          <div className="flex flex-col gap-2">
            <span className="text-sm font-medium text-muted-foreground">Parameters</span>
            <div className="flex flex-wrap gap-1">
              {Object.keys(config.parameters).slice(0, 3).map((param, index) => (
                <Badge
                  key={index}
                  className="bg-accent text-muted-foreground border-0"
                >
                  {param}
                </Badge>
              ))}
              {Object.keys(config.parameters).length > 3 && (
                <Badge className="bg-accent text-muted-foreground border-0">
                  +{Object.keys(config.parameters).length - 3} more
                </Badge>
              )}
            </div>
          </div>
        )}
        
        <div className="flex gap-2 pt-2">
          {tool.state === 'active' ? (
            <Button
              variant="outline"
              size="sm"
              className="flex-1 bg-transparent border-border text-foreground hover:bg-accent"
              onClick={() => onToggleState(tool)}
            >
              <Pause className="size-4 mr-1" />
              Deactivate
            </Button>
          ) : (
            <Button
              variant="outline"
              size="sm"
              className="flex-1 bg-transparent border-border text-foreground hover:bg-accent"
              onClick={() => onToggleState(tool)}
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
              onClick={() => onConfigure(tool.toolId)}
            >
              <Settings className="size-4" />
            </Button>
          )}
          <Button
            variant="outline"
            size="sm"
            className="bg-transparent border-border text-foreground hover:bg-accent"
            onClick={() => setShowSandbox(!showSandbox)}
          >
            <Play className="size-4" />
          </Button>
        </div>

        {/* Tool Testing Sandbox (Req 7.1, 11.5) */}
        {showSandbox && (
          <ErrorBoundary
            fallback={
              <div className="p-2 bg-destructive/10 border border-destructive/30 rounded text-xs text-destructive">
                An error occurred in the testing sandbox. Please try again.
              </div>
            }
          >
            <ToolTestingSandbox
              tool={tool}
              orgId={resolvedOrgId}
              onClose={() => setShowSandbox(false)}
            />
          </ErrorBoundary>
        )}
      </CardContent>
    </Card>
  );
}
