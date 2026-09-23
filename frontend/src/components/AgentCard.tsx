import { useState } from 'react';
import { Pause, Play, Settings, Bot, AlertTriangle } from 'lucide-react';
import { Button } from './ui/button';
import { Badge } from './ui/badge';
import { Card, CardContent, CardDescription, CardHeader, CardTitle } from './ui/card';
import {
  AlertDialog,
  AlertDialogAction,
  AlertDialogCancel,
  AlertDialogContent,
  AlertDialogDescription,
  AlertDialogFooter,
  AlertDialogHeader,
  AlertDialogTitle,
} from './ui/alert-dialog';
import { AgentConfig } from '../services/agentConfigService';
import { registryStatusLabel } from './registry-status-label';

interface AgentCardProps {
  agent: AgentConfig;
  onToggleState: (agent: AgentConfig) => void;
  onConfigure: (agentId: string) => void;
  userRole?: string;
}

/**
 * A record is registry-backed iff it carries the explicit `registryStatus`
 * discriminator (finding 414f8013) — the raw Registry record status, set
 * only by RegistryService.mapToAgentConfig. Legacy DynamoDB
 * `getAgentConfig` never sets it, so it stays null/undefined there (see
 * backend/src/lambda/agent-config-resolver.ts). Decision 3d5843e9: the
 * registry rejects APPROVED -> DRAFT (the old Deactivate target), so
 * registry-backed APPROVED agents no longer offer Deactivate at all — only
 * the irreversible Deprecate (-> DEPRECATED, wire value state:"maintenance",
 * see registry-service.ts's toRegistryStatus).
 */
function isRegistryBacked(agent: AgentConfig): boolean {
  return agent.registryStatus !== undefined && agent.registryStatus !== null;
}

export function AgentCard({ agent, onToggleState, onConfigure, userRole }: AgentCardProps) {
  const [showDeprecateConfirm, setShowDeprecateConfirm] = useState(false);

  // Parse config if it's a string
  const config = typeof agent.config === 'string' ? (() => { try { return JSON.parse(agent.config); } catch { return {}; } })() : (agent.config ?? {});

  // Display name: prefer agent.name (from registry), then config.name, then agentId
  const displayName = (agent as any).name || config?.name || agent.agentId;

  // Only show config button for admin and developer roles
  const canConfigure = userRole === 'admin' || userRole === 'developer';

  const registryBacked = isRegistryBacked(agent);
  // Registry-backed DEPRECATED/REJECTED records surface as internal state
  // 'inactive' (toInternalState) but are terminal at the registry — no
  // action can move them anywhere. Legacy 'inactive' stays reversible
  // (Activate). Decision 3d5843e9 (supersedes a3fb5542): 'maintenance' is
  // no longer produced by Deactivate, so it is displayed as-is ("Draft" /
  // "Maintenance" per the existing mapping used on the workflow canvas,
  // e.g. AgentNode/AgentTrayItem) rather than relabeled to "inactive".
  const isTerminalDeprecated = registryBacked && agent.state === 'inactive';

  const handleDeprecateConfirm = () => {
    setShowDeprecateConfirm(false);
    onToggleState(agent);
  };

  const badgeLabel = registryStatusLabel(agent.registryStatus);

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
            {/* Registry status badge (finding c5df5322): distinct from the
                legacy state toggle below, shown only when registryStatus is
                present. */}
            {badgeLabel && (
              <Badge className="bg-primary/10 text-primary border-0">
                {badgeLabel}
              </Badge>
            )}
            <Badge 
              className={
                agent.state === 'active'
                  ? 'bg-chart-2/20 text-chart-2 border-0'
                  : 'bg-muted/20 text-muted-foreground border-0'
              }
            >
              {isTerminalDeprecated ? 'Deprecated' : agent.state}
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
          {isTerminalDeprecated ? null : agent.state === 'active' && registryBacked ? (
            <>
              <Button
                variant="outline"
                size="sm"
                className="flex-1 bg-transparent border-border text-foreground hover:bg-accent"
                onClick={() => setShowDeprecateConfirm(true)}
              >
                <AlertTriangle className="size-4 mr-1" />
                Deprecate
              </Button>
              <AlertDialog open={showDeprecateConfirm} onOpenChange={setShowDeprecateConfirm}>
                <AlertDialogContent>
                  <AlertDialogHeader>
                    <AlertDialogTitle>Deprecate {displayName}?</AlertDialogTitle>
                    <AlertDialogDescription>
                      This is irreversible. Once deprecated, this agent will no longer be
                      dispatchable or releasable, and it cannot be reactivated.
                    </AlertDialogDescription>
                  </AlertDialogHeader>
                  <AlertDialogFooter>
                    <AlertDialogCancel>Cancel</AlertDialogCancel>
                    <AlertDialogAction onClick={handleDeprecateConfirm}>
                      Deprecate
                    </AlertDialogAction>
                  </AlertDialogFooter>
                </AlertDialogContent>
              </AlertDialog>
            </>
          ) : agent.state === 'active' ? (
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
          {!isTerminalDeprecated && canConfigure && (
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
