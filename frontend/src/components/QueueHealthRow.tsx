/**
 * QueueHealthRow — one row inside the dashboard's System Health card that
 * surfaces dead-letter-queue / SLO alarm state (Query.getPlatformAlarms,
 * admin-only) and shows ONLY non-OK states.
 *
 * Presentation only: the GraphQL query and the usePlatformAlarms hook are
 * unchanged.
 *
 *  - non-admin       renders nothing (no signal either way).
 *  - loading         short skeleton line.
 *  - all-ok /
 *    not-configured  muted "All clear" with a check icon, nothing else.
 *  - alarm           red (ALARM) or amber (INSUFFICIENT_DATA only) icon plus
 *                    "N queues need attention: A (depth), B (depth), +N more".
 *                    A tooltip on the row lists raw alarm names and reasons.
 *  - unauthorised    an admin whose query was rejected: "Unavailable" with a
 *                    ghost Retry button.
 */
import { AlertTriangle, CheckCircle2, CircleHelp, Inbox } from 'lucide-react';
import { useOrganization } from '../contexts/OrganizationContext';
import { usePlatformAlarms } from '../hooks/usePlatformAlarms';
import { selectAttentionAlarms, summariseAttentionAlarms } from '../utils/queueHealth';
import { Button } from './ui/button';
import { Skeleton } from './ui/skeleton';
import { Tooltip, TooltipContent, TooltipTrigger } from './ui/tooltip';

export function QueueHealthRow() {
  const { isAdmin } = useOrganization();
  const { status, alarms, refresh } = usePlatformAlarms({ enabled: isAdmin });

  if (!isAdmin) {
    return null;
  }

  // The hook reports 'all-ok' when no alarm is in ALARM, even if some are
  // INSUFFICIENT_DATA, so both statuses can carry non-OK entries.
  const hasAlarmData = status === 'alarm' || status === 'all-ok';
  const attention = hasAlarmData ? selectAttentionAlarms(alarms) : [];
  const hasAlarm = attention.some((alarm) => alarm.state === 'ALARM');
  const hasAttention = attention.length > 0;
  const isUnavailable = status === 'unauthorised';

  let summary;
  if (status === 'loading') {
    summary = <Skeleton data-testid="queue-health-loading" className="h-4 w-32" />;
  } else if (isUnavailable) {
    summary = <span className="text-muted-foreground text-sm">Unavailable</span>;
  } else if (hasAttention) {
    const Icon = hasAlarm ? AlertTriangle : CircleHelp;
    summary = (
      <>
        <Icon
          data-testid="queue-health-icon"
          data-severity={hasAlarm ? 'alarm' : 'insufficient-data'}
          className={`size-4 shrink-0 ${hasAlarm ? 'text-destructive' : 'text-chart-3'}`}
          aria-hidden="true"
        />
        <span className="text-foreground text-sm">{summariseAttentionAlarms(attention)}</span>
      </>
    );
  } else {
    summary = (
      <>
        <CheckCircle2
          data-testid="queue-health-icon"
          data-severity="ok"
          className="size-4 shrink-0 text-muted-foreground"
          aria-hidden="true"
        />
        <span className="text-muted-foreground text-sm">All clear</span>
      </>
    );
  }

  return (
    <Tooltip>
      <TooltipTrigger asChild>
        <div
          data-testid="queue-health-row"
          tabIndex={hasAttention ? 0 : undefined}
          className="flex items-center justify-between gap-3"
        >
          <div className="flex items-center gap-2 shrink-0">
            <Inbox className="size-4 text-muted-foreground" aria-hidden="true" />
            <span className="text-foreground text-sm">Queues</span>
          </div>
          <div className="flex items-center gap-2 min-w-0">
            <div
              data-testid="queue-health-summary"
              aria-live="polite"
              className="flex items-center justify-end gap-2 min-w-0"
            >
              {summary}
            </div>
            {isUnavailable && (
              <Button
                type="button"
                variant="ghost"
                size="sm"
                className="h-6 px-2 text-xs"
                aria-label="Retry loading queue health"
                onClick={refresh}
              >
                Retry
              </Button>
            )}
          </div>
        </div>
      </TooltipTrigger>
      {hasAttention && (
        <TooltipContent className="max-w-sm">
          <ul data-testid="queue-health-tooltip" className="flex flex-col gap-1">
            {attention.map((alarm) => (
              <li key={alarm.alarmName}>
                <span className="font-medium">{alarm.alarmName}</span> ({alarm.state})
                {alarm.reason ? `: ${alarm.reason}` : ''}
              </li>
            ))}
          </ul>
        </TooltipContent>
      )}
    </Tooltip>
  );
}

export default QueueHealthRow;
