/**
 * ModeBadge — pill component shown in AppHeader.
 *
 * Reflects the current governance enforcement mode. Click → /governance.
 * Error / unknown enforce values render a neutral "mode unknown" pill.
 *
 * Colours come exclusively from Tailwind tokens; no hex literals.
 */

import { useNavigate } from 'react-router-dom';
import { Tooltip, TooltipContent, TooltipTrigger } from './ui/tooltip';
import { Button } from './ui/button';
import { Skeleton } from './ui/skeleton';
import { useGovernanceMode } from '../hooks/useGovernanceMode';
import { cn } from './ui/utils';

const PILL_BASE =
  'inline-flex items-center justify-center rounded-full px-2.5 py-0.5 text-xs font-medium uppercase tracking-wide transition-colors cursor-pointer select-none';

const STYLES: Record<string, string> = {
  permissive: 'bg-muted text-muted-foreground border border-border',
  shadow: 'bg-chart-4/20 text-chart-4 border border-chart-4/40 animate-pulse',
  strict: 'bg-chart-2/20 text-chart-2 border border-chart-2/40 ring-1 ring-chart-2/40',
  unknown: 'bg-muted text-muted-foreground border border-border',
};

function isKnownMode(value: string | undefined | null): value is 'permissive' | 'shadow' | 'strict' {
  return value === 'permissive' || value === 'shadow' || value === 'strict';
}

export function ModeBadge() {
  const navigate = useNavigate();
  const { mode, loading, error } = useGovernanceMode();

  if (loading) {
    return (
      <Skeleton
        data-testid="mode-badge-skeleton"
        className="h-6 w-20 rounded-full"
        aria-label="Governance mode loading"
      />
    );
  }

  // Treat both transport errors and unknown enforce values as "unknown" — the
  // contract requires the badge never break a page.
  const enforce = mode?.enforce;
  const showUnknown = !!error || !isKnownMode(enforce);
  const key = showUnknown ? 'unknown' : (enforce as 'permissive' | 'shadow' | 'strict');
  const label = showUnknown ? 'mode unknown' : key;

  const effectiveAtLabel = mode?.effectiveAt ? mode.effectiveAt : 'not yet';
  const envLabel = mode?.env ?? 'unknown';
  const tooltipContent = `Mode: ${showUnknown ? 'unknown' : enforce} • effective ${effectiveAtLabel} • env: ${envLabel}`;

  const handleClick = () => navigate('/governance');
  const handleKeyDown = (e: React.KeyboardEvent<HTMLButtonElement>) => {
    if (e.key === 'Enter' || e.key === ' ') {
      e.preventDefault();
      handleClick();
    }
  };

  return (
    <Tooltip>
      <TooltipTrigger asChild>
        <Button
          variant="ghost"
          size="sm"
          type="button"
          aria-label={`Governance mode: ${label}`}
          onClick={handleClick}
          onKeyDown={handleKeyDown}
          className={cn(PILL_BASE, STYLES[key], 'h-auto')}
          data-mode={key}
        >
          {label}
        </Button>
      </TooltipTrigger>
      <TooltipContent>{tooltipContent}</TooltipContent>
    </Tooltip>
  );
}

export default ModeBadge;
