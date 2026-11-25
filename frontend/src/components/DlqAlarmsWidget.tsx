/**
 * DlqAlarmsWidget — admin-only dashboard widget surfacing dead-letter-queue
 * and SLO CloudWatch alarm state (Query.getPlatformAlarms, board task
 * 4cc234d1). Read-only: no redrive/purge action from the UI.
 *
 * Presentation only — the GraphQL query, hook (usePlatformAlarms), and data
 * flow are unchanged. See the hook for state semantics:
 *
 *  - hidden         non-admin caller, or the hook reports 'unauthorised'
 *                    (the query was refused server-side) — never shown to
 *                    a non-admin, and never surfaced as an in-widget error
 *                    so an unauthorised caller gets no signal either way.
 *  - loading        skeleton rows while the first fetch is pending.
 *  - not-configured empty-state copy — the platform signal itself is
 *                    unavailable, distinct from "all clear".
 *  - all-ok         compact one-line summary with a disclosure to expand
 *                    the full (healthy) list.
 *  - alarm          alarm rows sorted ALARM first, each with a status
 *                    icon, humanised name, state badge, relative time,
 *                    and a tooltip carrying the raw StateReason.
 */
import { useState } from 'react';
import {
  AlertTriangle,
  CheckCircle2,
  ChevronDown,
  CircleHelp,
} from 'lucide-react';
import { useOrganization } from '../contexts/OrganizationContext';
import { usePlatformAlarms } from '../hooks/usePlatformAlarms';
import type { AlarmState, PlatformAlarm } from '../services/platformAlarmsService';
import { Badge } from './ui/badge';
import { Button } from './ui/button';
import { Card, CardContent, CardDescription, CardHeader, CardTitle } from './ui/card';
import { Collapsible, CollapsibleContent, CollapsibleTrigger } from './ui/collapsible';
import { Skeleton } from './ui/skeleton';
import { Tooltip, TooltipContent, TooltipTrigger } from './ui/tooltip';
import { relativeDate } from '../utils/relativeDate';

/** Alarm-state sort weight — ALARM first, then INSUFFICIENT_DATA, then OK. */
const STATE_SORT_WEIGHT: Record<AlarmState, number> = {
  ALARM: 0,
  INSUFFICIENT_DATA: 1,
  OK: 2,
};

const STATE_ICON: Record<AlarmState, { Icon: typeof CheckCircle2; className: string }> = {
  OK: { Icon: CheckCircle2, className: 'text-chart-2' },
  ALARM: { Icon: AlertTriangle, className: 'text-destructive' },
  INSUFFICIENT_DATA: { Icon: CircleHelp, className: 'text-muted-foreground' },
};

const STATE_BADGE_VARIANT: Record<AlarmState, 'success' | 'destructive' | 'secondary'> = {
  OK: 'success',
  ALARM: 'destructive',
  INSUFFICIENT_DATA: 'secondary',
};

/**
 * Strips the citadel- prefix and a trailing -dev/-prod environment suffix
 * from an alarm name, replaces dashes with spaces, title-cases each word,
 * and keeps "dlq" upper-cased.
 */
function humaniseAlarmName(alarmName: string): string {
  const withoutPrefix = alarmName.replace(/^citadel-/, '');
  const withoutSuffix = withoutPrefix.replace(/-(dev|prod)$/, '');
  return withoutSuffix
    .split('-')
    .filter(Boolean)
    .map((word) => (word.toLowerCase() === 'dlq' ? 'DLQ' : word.charAt(0).toUpperCase() + word.slice(1)))
    .join(' ');
}

function sortAlarms(alarms: PlatformAlarm[]): PlatformAlarm[] {
  return [...alarms].sort((a, b) => STATE_SORT_WEIGHT[a.state] - STATE_SORT_WEIGHT[b.state]);
}

function AlarmRow({ alarm }: { alarm: PlatformAlarm }) {
  const { Icon, className } = STATE_ICON[alarm.state] ?? STATE_ICON.INSUFFICIENT_DATA;
  const name = humaniseAlarmName(alarm.alarmName);

  return (
    <div
      data-testid="dlq-alarm-row"
      className="flex items-center justify-between gap-3 rounded-md border border-border px-3 py-2"
    >
      <div className="flex items-center gap-2 min-w-0">
        <Icon className={`size-4 shrink-0 ${className}`} aria-hidden="true" />
        <span className="text-foreground text-sm truncate">{name}</span>
      </div>
      <div className="flex items-center gap-2 shrink-0">
        {typeof alarm.queueDepth === 'number' && (
          <span className="text-muted-foreground text-xs">
            {alarm.queueDepth} message{alarm.queueDepth === 1 ? '' : 's'}
          </span>
        )}
        <span className="text-muted-foreground text-xs">{relativeDate(alarm.stateUpdatedAt)}</span>
        <Badge variant={STATE_BADGE_VARIANT[alarm.state] ?? 'secondary'}>{alarm.state}</Badge>
        {alarm.reason && (
          <Tooltip>
            <TooltipTrigger asChild>
              <span
                data-testid="dlq-alarm-reason-trigger"
                title={alarm.reason}
                className="inline-flex cursor-help"
              >
                <CircleHelp className="size-3.5 text-muted-foreground" aria-hidden="true" />
              </span>
            </TooltipTrigger>
            <TooltipContent>{alarm.reason}</TooltipContent>
          </Tooltip>
        )}
      </div>
    </div>
  );
}

export function DlqAlarmsWidget() {
  const [expanded, setExpanded] = useState(false);
  const { isAdmin } = useOrganization();
  const { status, alarms } = usePlatformAlarms({ enabled: isAdmin });

  if (!isAdmin || status === 'unauthorised') {
    return null;
  }

  const sortedAlarms = sortAlarms(alarms);
  const firingCount = alarms.filter((a) => a.state === 'ALARM').length;
  const isAlarming = status === 'alarm' && firingCount > 0;

  const chipLabel =
    status === 'not-configured'
      ? 'Not configured'
      : isAlarming
        ? `${firingCount} alarm${firingCount === 1 ? '' : 's'}`
        : firingCount > 0
          ? 'Attention'
          : 'All clear';

  return (
    <Card data-testid="dlq-alarms-widget" className="gap-0">
      <CardHeader className="flex-row items-start justify-between gap-2 pb-4">
        <div>
          <CardTitle className="text-lg">Queue health</CardTitle>
          <CardDescription>Dead-letter-queue and SLO alarm state</CardDescription>
        </div>
        <Badge
          data-testid="dlq-alarms-status-chip"
          variant={isAlarming ? 'destructive' : status === 'not-configured' ? 'secondary' : 'success'}
          className="gap-1.5"
        >
          {isAlarming && (
            <span
              data-testid="dlq-alarms-pulse"
              className="size-1.5 rounded-full bg-current animate-pulse"
              aria-hidden="true"
            />
          )}
          {chipLabel}
        </Badge>
      </CardHeader>

      <CardContent>
        {status === 'loading' && (
          <div data-testid="dlq-alarms-loading" className="flex flex-col gap-2">
            <Skeleton className="h-8 w-full" />
            <Skeleton className="h-8 w-full" />
            <Skeleton className="h-8 w-2/3" />
          </div>
        )}

        {status === 'not-configured' && (
          <p className="text-muted-foreground text-sm">
            DLQ monitoring not configured for this environment.
          </p>
        )}

        {status === 'all-ok' && (
          <Collapsible open={expanded} onOpenChange={setExpanded}>
            <div className="flex items-center justify-between gap-2">
              <p data-testid="dlq-alarms-summary" aria-live="polite" className="text-sm text-foreground">
                {alarms.length} queue{alarms.length === 1 ? '' : 's'} healthy, checked{' '}
                {relativeDate(alarms[0]?.stateUpdatedAt)}.
              </p>
              {alarms.length > 0 && (
                <CollapsibleTrigger asChild>
                  <Button variant="ghost" size="sm" className="gap-1 text-xs" aria-expanded={expanded}>
                    {expanded ? 'Hide details' : 'Show details'}
                    <ChevronDown
                      className={`size-3.5 transition-transform ${expanded ? 'rotate-180' : ''}`}
                      aria-hidden="true"
                    />
                  </Button>
                </CollapsibleTrigger>
              )}
            </div>
            <CollapsibleContent className="mt-3 flex flex-col gap-2">
              {sortedAlarms.map((alarm) => (
                <AlarmRow key={alarm.alarmName} alarm={alarm} />
              ))}
            </CollapsibleContent>
          </Collapsible>
        )}

        {status === 'alarm' && (
          <div className="flex flex-col gap-2">
            <p aria-live="polite" className="sr-only">
              {firingCount} alarm{firingCount === 1 ? '' : 's'} firing out of {alarms.length} queues.
            </p>
            {sortedAlarms.map((alarm) => (
              <AlarmRow key={alarm.alarmName} alarm={alarm} />
            ))}
          </div>
        )}
      </CardContent>
    </Card>
  );
}

export default DlqAlarmsWidget;
