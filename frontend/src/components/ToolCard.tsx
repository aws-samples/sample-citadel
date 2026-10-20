import { Pause, Play, Wrench, AlertTriangle, Send, ExternalLink } from 'lucide-react';
import { useState } from 'react';
import { Button } from './ui/button';
import { Badge } from './ui/badge';
import { Card, CardContent, CardDescription, CardHeader, CardTitle } from './ui/card';
import {
  Tooltip,
  TooltipContent,
  TooltipProvider,
  TooltipTrigger,
} from './ui/tooltip';
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
import { ToolConfig } from '../services/toolConfigService';
import { extractBindingBadges } from './tool-card-badge-helpers';
import { ToolTestingSandbox } from './ToolTestingSandbox';
import { ErrorBoundary } from './ErrorBoundary';
import { useOrganization } from '../contexts/OrganizationContext';
import { registryStatusLabel, TRANSIENT_STATUSES } from './registry-status-label';

interface ToolCardProps {
  tool: ToolConfig;
  onToggleState: (tool: ToolConfig) => void;
  onConfigure: (toolId: string) => void;
  onSubmitForReview?: (tool: ToolConfig) => void;
  userRole?: string;
  orgId?: string;
  /**
   * When true the Submit-for-review button shows a success confirmation
   * instead of the default label, after a successful API call. Controlled
   * by the parent page (AgentTools).
   */
  submitSuccess?: boolean;
  /**
   * When true, the Configure (Settings) button is rendered but disabled
   * with a "Coming soon" tooltip. Defaults to true while ToolDetails is
   * unspecified; pass false once a ToolDetails view exists.
   */
  configureDisabled?: boolean;
}

/**
 * A tool is registry-backed iff it carries the explicit `registryStatus`
 * discriminator (finding 414f8013) — the raw Registry record status, set
 * only by RegistryService.mapToToolConfig. Legacy DynamoDB rows never set
 * it, so it stays null/undefined there. Mirrors AgentCard's
 * isRegistryBacked, now sourced from the non-heuristic field rather than
 * inferring registry-backing from `name` presence.
 */
function isRegistryBacked(tool: ToolConfig): boolean {
  return tool.registryStatus !== undefined && tool.registryStatus !== null;
}

/** Minimal shape ToolCard reads off a tool's parsed config. */
interface RenderableToolConfig {
  name?: string;
  description?: string;
  version?: string;
  parameters?: Record<string, unknown>;
}

/**
 * Normalize a tool's `config` payload for render.
 *
 * Summary-fallback registry rows project a bare string (plain description
 * or '') through AWSJSON, so after the service's first decode the payload
 * may not be JSON at all — or may be a double-encoded scalar. Never throw
 * during render: parse guarded, and normalize any non-object result to {}.
 */
function toRenderableConfig(raw: unknown): RenderableToolConfig {
  let value: unknown = raw;
  if (typeof value === 'string') {
    try {
      value = value.trim() ? JSON.parse(value) : {};
    } catch {
      value = {};
    }
  }
  return typeof value === 'object' && value !== null
    ? (value as RenderableToolConfig)
    : {};
}

export function ToolCard({ tool, onToggleState, onConfigure: _onConfigure, onSubmitForReview, userRole: _userRole, orgId, submitSuccess, configureDisabled: _configureDisabled = true }: ToolCardProps) {
  const { selectedOrganization } = useOrganization();
  const resolvedOrgId = orgId || selectedOrganization || 'default';
  const [showSandbox, setShowSandbox] = useState(false);
  const [showDeprecateConfirm, setShowDeprecateConfirm] = useState(false);
  const config = toRenderableConfig(tool.config);

  const registryBacked = isRegistryBacked(tool);
  // Registry-backed DEPRECATED/REJECTED records surface as internal state
  // 'inactive' (toInternalState) but are terminal at the registry — no
  // action can move them anywhere. Legacy 'inactive' stays reversible
  // (Activate). Mirrors AgentCard's isTerminalDeprecated.
  const isTerminalDeprecated = registryBacked && tool.state === 'inactive';

  /**
   * Transient statuses (UPDATING, CREATING) indicate the backend is
   * performing an async operation. Controls must be disabled, and the
   * parent page should short-poll until settled.
   */
  const isTransient = registryBacked && TRANSIENT_STATUSES.has(tool.registryStatus ?? '');

  /**
   * A status is "known" if registryStatusLabel maps it to a recognised
   * human label that differs from the raw value (i.e. it is in the
   * REGISTRY_STATUS_LABELS table). Unknown statuses get a neutral badge
   * showing the raw value, with no lifecycle actions.
   */
  const KNOWN_STATUSES = new Set([
    'DRAFT', 'PENDING_APPROVAL', 'PENDING_REVIEW', 'APPROVED',
    'REJECTED', 'DEPRECATED', 'CREATING', 'UPDATING',
    'CREATE_FAILED', 'UPDATE_FAILED', 'PUBLISHED',
  ]);
  const isUnknownStatus = registryBacked && !KNOWN_STATUSES.has(tool.registryStatus ?? '');

  const handleDeprecateConfirm = () => {
    setShowDeprecateConfirm(false);
    onToggleState(tool);
  };

  const badgeLabel = registryStatusLabel(tool.registryStatus);

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
                tool.state === 'active'
                  ? 'bg-chart-2/20 text-chart-2 border-0'
                  : 'bg-muted/20 text-muted-foreground border-0'
              }
            >
              {isTerminalDeprecated ? 'Deprecated' : tool.state}
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
          {/* Lifecycle-aware action controls: render by registryStatus */}
          {isTransient ? (
            /* Transient (UPDATING / CREATING) → disabled indicator */
            <Button
              variant="outline"
              size="sm"
              className="flex-1 bg-transparent border-border text-muted-foreground"
              disabled
              data-testid="updating-button"
            >
              Updating…
            </Button>
          ) : isUnknownStatus ? (
            /* Unknown status → neutral badge with raw value, no actions */
            <Badge className="bg-muted/20 text-muted-foreground border-0" data-testid="unknown-status-badge">
              {tool.registryStatus}
            </Badge>
          ) : registryBacked && tool.registryStatus === 'DRAFT' ? (
            /* DRAFT → Submit for review */
            submitSuccess ? (
              <Badge className="flex-1 bg-chart-2/20 text-chart-2 border-0 justify-center py-1.5">
                Submitted for review
              </Badge>
            ) : (
              <Button
                variant="outline"
                size="sm"
                className="flex-1 bg-transparent border-border text-foreground hover:bg-accent"
                onClick={() => onSubmitForReview?.(tool)}
                data-testid="submit-for-review"
              >
                <Send className="size-4 mr-1" />
                Submit for review
              </Button>
            )
          ) : registryBacked && (tool.registryStatus === 'PENDING_APPROVAL' || tool.registryStatus === 'PENDING_REVIEW') ? (
            /* PENDING_APPROVAL / PENDING_REVIEW → badge + link to approvals */
            <div className="flex-1 flex items-center gap-2">
              <Badge className="bg-chart-4/20 text-chart-4 border-0">
                Awaiting approval
              </Badge>
              <a
                href="/approvals"
                className="text-xs text-primary hover:underline inline-flex items-center gap-1"
                data-testid="approvals-link"
              >
                <ExternalLink className="size-3" />
                View approvals
              </a>
            </div>
          ) : registryBacked && tool.registryStatus === 'REJECTED' ? (
            /* REJECTED → badge with statusReason; no resubmit (backend rejects it) */
            <div className="flex-1 flex flex-col gap-1">
              <TooltipProvider>
                <Tooltip>
                  <TooltipTrigger asChild>
                    <span className="inline-flex">
                      <Badge className="bg-destructive/20 text-destructive border-0" data-testid="rejected-badge">
                        Rejected
                      </Badge>
                    </span>
                  </TooltipTrigger>
                  {tool.statusReason && (
                    <TooltipContent>
                      {tool.statusReason}
                    </TooltipContent>
                  )}
                </Tooltip>
              </TooltipProvider>
              {tool.statusReason && (
                <p className="text-xs text-muted-foreground truncate" data-testid="rejection-reason">
                  {tool.statusReason}
                </p>
              )}
            </div>
          ) : isTerminalDeprecated ? null : tool.state === 'active' && registryBacked ? (
            /* APPROVED + active → Deprecate (existing behavior) */
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
                    <AlertDialogTitle>Deprecate {config?.name || tool.toolId}?</AlertDialogTitle>
                    <AlertDialogDescription>
                      This is irreversible. Once deprecated, this tool will no longer be
                      usable or bindable, and it cannot be reactivated.
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
          ) : tool.state === 'active' ? (
            /* Legacy active → Deactivate */
            <Button
              variant="outline"
              size="sm"
              className="flex-1 bg-transparent border-border text-foreground hover:bg-accent"
              onClick={() => onToggleState(tool)}
            >
              <Pause className="size-4 mr-1" />
              Deactivate
            </Button>
          ) : !registryBacked ? (
            /* Legacy inactive → Activate */
            <Button
              variant="outline"
              size="sm"
              className="flex-1 bg-transparent border-border text-foreground hover:bg-accent"
              onClick={() => onToggleState(tool)}
            >
              <Play className="size-4 mr-1" />
              Activate
            </Button>
          ) : null}
          {/* TODO: Configure button — hidden until ToolDetails view is implemented.
              The backend CRUD exists (updateToolConfig); the UI surface (sub-view
              shape, editable fields, permissions for bindings vs basic config,
              governance/audit trail) is not yet specified. */}
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
