/**
 * Pure helpers for the System Health "Queues" row (QueueHealthRow): alarm
 * name humanising, non-OK selection/ordering, and the compact summary text.
 */
import type { AlarmState, PlatformAlarm } from '../services/platformAlarmsService';

/** Alarms named in the summary before the rest collapse into "+N more". */
const MAX_LISTED_ALARMS = 3;

/** Alarm-state sort weight: ALARM first, then INSUFFICIENT_DATA. */
const STATE_SORT_WEIGHT: Record<AlarmState, number> = {
  ALARM: 0,
  INSUFFICIENT_DATA: 1,
  OK: 2,
};

/**
 * Strips the citadel- prefix and a trailing -dev/-prod environment suffix
 * from an alarm name, replaces dashes with spaces, title-cases each word,
 * and keeps "dlq" upper-cased.
 */
export function humaniseAlarmName(alarmName: string): string {
  const withoutPrefix = alarmName.replace(/^citadel-/, '');
  const withoutSuffix = withoutPrefix.replace(/-(dev|prod)$/, '');
  return withoutSuffix
    .split('-')
    .filter(Boolean)
    .map((word) => (word.toLowerCase() === 'dlq' ? 'DLQ' : word.charAt(0).toUpperCase() + word.slice(1)))
    .join(' ');
}

/** Non-OK alarms, ALARM before INSUFFICIENT_DATA, original order otherwise. */
export function selectAttentionAlarms(alarms: PlatformAlarm[]): PlatformAlarm[] {
  return alarms
    .filter((alarm) => alarm.state !== 'OK')
    .sort(
      (a, b) =>
        (STATE_SORT_WEIGHT[a.state] ?? STATE_SORT_WEIGHT.INSUFFICIENT_DATA) -
        (STATE_SORT_WEIGHT[b.state] ?? STATE_SORT_WEIGHT.INSUFFICIENT_DATA),
    );
}

function describeAlarm(alarm: PlatformAlarm): string {
  const name = humaniseAlarmName(alarm.alarmName);
  return typeof alarm.queueDepth === 'number' ? `${name} (${alarm.queueDepth})` : name;
}

/** e.g. "2 queues need attention: Registry Sync DLQ (109), Worker DLQ (3)". */
export function summariseAttentionAlarms(attention: PlatformAlarm[]): string {
  const count = attention.length;
  const listed = attention.slice(0, MAX_LISTED_ALARMS).map(describeAlarm);
  const hidden = count - listed.length;
  const names = hidden > 0 ? [...listed, `+${hidden} more`] : listed;
  return `${count} queue${count === 1 ? ' needs' : 's need'} attention: ${names.join(', ')}`;
}
