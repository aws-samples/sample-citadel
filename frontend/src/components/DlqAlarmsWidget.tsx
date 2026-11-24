/**
 * DlqAlarmsWidget — admin-only dashboard widget surfacing dead-letter-queue
 * and SLO CloudWatch alarm state (Query.getPlatformAlarms, board task
 * 4cc234d1). Read-only: no redrive/purge action from the UI.
 *
 * States:
 *  - hidden         non-admin caller (useOrganization().isAdmin === false),
 *                    or the hook reports 'unauthorised' (the query was
 *                    refused server-side) — never shown to a non-admin.
 *  - loading        skeleton while the first fetch is pending.
 *  - all-ok         muted "All queues healthy" message.
 *  - alarm          red banner per firing alarm: queue name, depth, redrive
 *                    guidance, and a CloudWatch deep link.
 *  - not-configured muted "DLQ monitoring not configured" message —
 *                    distinct from all-ok (the platform signal itself is
 *                    unavailable, not merely quiet).
 */
import { useOrganization } from '../contexts/OrganizationContext';
import { usePlatformAlarms } from '../hooks/usePlatformAlarms';
import serverService from '../services/server';
import { Card } from './ui/card';
import { Skeleton } from './ui/skeleton';

function cloudWatchAlarmUrl(alarmName: string, region: string): string {
  return `https://${region}.console.aws.amazon.com/cloudwatch/home?region=${region}#alarmsV2:alarm/${encodeURIComponent(alarmName)}`;
}

export function DlqAlarmsWidget() {
  const { isAdmin } = useOrganization();
  const { status, alarms } = usePlatformAlarms({ enabled: isAdmin });

  if (!isAdmin || status === 'unauthorised') {
    return null;
  }

  const region = serverService.getConfig()?.appsyncRegion ?? 'us-east-1';
  const dlqAlarms = alarms.filter((a) => (a.category ?? 'dlq') === 'dlq');
  const sloAlarms = alarms.filter((a) => a.category === 'slo');

  return (
    <Card className="rounded-lg p-[15px] gap-0 mb-6" data-testid="dlq-alarms-widget">
      <div className="mb-3">
        <h3 className="text-foreground text-lg font-semibold mb-1">Queue Health</h3>
        <p className="text-muted-foreground text-sm">Dead-letter-queue and SLO alarm state</p>
      </div>

      {status === 'loading' && (
        <div data-testid="dlq-alarms-loading">
          <Skeleton className="h-12 w-full" />
        </div>
      )}

      {status === 'not-configured' && (
        <p className="text-muted-foreground text-sm">DLQ monitoring not configured.</p>
      )}

      {status === 'all-ok' && (
        <p className="text-chart-2 text-sm">All queues healthy.</p>
      )}

      {status === 'alarm' && (
        <div className="flex flex-col gap-3">
          {dlqAlarms
            .filter((a) => a.state === 'ALARM')
            .map((alarm) => (
              <div
                key={alarm.alarmName}
                className="border border-destructive rounded-lg p-3 bg-destructive/10"
              >
                <div className="flex items-baseline justify-between gap-2">
                  <a
                    href={cloudWatchAlarmUrl(alarm.alarmName, region)}
                    target="_blank"
                    rel="noreferrer"
                    className="text-destructive text-sm font-medium underline"
                  >
                    {alarm.alarmName}
                  </a>
                  {alarm.queueName && (
                    <span className="text-foreground text-sm">{alarm.queueName}</span>
                  )}
                </div>
                {typeof alarm.queueDepth === 'number' && (
                  <p className="text-muted-foreground text-xs mt-1">
                    Depth: {alarm.queueDepth} message{alarm.queueDepth === 1 ? '' : 's'}
                  </p>
                )}
                {alarm.redriveHint && (
                  <p className="text-muted-foreground text-xs mt-1">{alarm.redriveHint}</p>
                )}
              </div>
            ))}

          {sloAlarms.length > 0 && (
            <div className="flex flex-col gap-1">
              {sloAlarms.map((alarm) => (
                <a
                  key={alarm.alarmName}
                  href={cloudWatchAlarmUrl(alarm.alarmName, region)}
                  target="_blank"
                  rel="noreferrer"
                  className={`text-xs underline ${alarm.state === 'ALARM' ? 'text-destructive' : 'text-muted-foreground'}`}
                >
                  {alarm.alarmName} — {alarm.state}
                </a>
              ))}
            </div>
          )}
        </div>
      )}
    </Card>
  );
}

export default DlqAlarmsWidget;
