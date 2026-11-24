/**
 * Polls Query.getPlatformAlarms every 60s (alarm state is slow-moving;
 * DescribeAlarms is cheap but not free) and reduces the result to one of
 * five states for DlqAlarmsWidget to render:
 *
 *  - loading        no fetch has resolved yet
 *  - all-ok         configured, no ALARM-state entries
 *  - alarm          configured, at least one ALARM-state entry
 *  - unauthorised   the query threw (non-admin, or any other resolver
 *                    error) — the widget should not render at all
 *  - not-configured configured:false (ALARM_NAME_PREFIX unset or
 *                    DescribeAlarms denied — a platform configuration
 *                    state, distinct from "you're not an admin")
 */
import { useCallback, useEffect, useRef, useState } from 'react';
import {
  platformAlarmsService,
  type PlatformAlarm,
} from '../services/platformAlarmsService';

const POLL_INTERVAL_MS = 60_000;

export type PlatformAlarmsStatus =
  | 'loading'
  | 'all-ok'
  | 'alarm'
  | 'unauthorised'
  | 'not-configured';

export interface UseePlatformAlarmsOptions {
  /** Pass false to skip fetching/polling entirely — e.g. the caller already
   * knows the current user is not an admin and does not want to issue a
   * request that will only be refused server-side. Defaults to true. */
  enabled?: boolean;
  intervalMs?: number;
}

export interface UseePlatformAlarmsResult {
  status: PlatformAlarmsStatus;
  alarms: PlatformAlarm[];
  refresh: () => void;
}

export function usePlatformAlarms(
  options: UseePlatformAlarmsOptions = {},
): UseePlatformAlarmsResult {
  const { enabled = true, intervalMs = POLL_INTERVAL_MS } = options;

  const [status, setStatus] = useState<PlatformAlarmsStatus>('loading');
  const [alarms, setAlarms] = useState<PlatformAlarm[]>([]);
  const enabledRef = useRef(enabled);
  enabledRef.current = enabled;

  const fetchAlarms = useCallback(async () => {
    if (!enabledRef.current) return;
    try {
      const result = await platformAlarmsService.getPlatformAlarms();
      if (!enabledRef.current) return;
      if (!result.configured) {
        setStatus('not-configured');
        setAlarms([]);
        return;
      }
      const hasAlarm = result.alarms.some((a) => a.state === 'ALARM');
      setAlarms(result.alarms);
      setStatus(hasAlarm ? 'alarm' : 'all-ok');
    } catch {
      if (!enabledRef.current) return;
      // Any resolver-side rejection (non-admin PermissionError, or an
      // unexpected error) is treated as unauthorised — the widget hides
      // itself rather than surfacing the raw error.
      setStatus('unauthorised');
      setAlarms([]);
    }
  }, []);

  useEffect(() => {
    if (!enabled) return;

    fetchAlarms();
    const intervalId = setInterval(fetchAlarms, intervalMs);
    return () => clearInterval(intervalId);
  }, [enabled, intervalMs, fetchAlarms]);

  return { status, alarms, refresh: fetchAlarms };
}

export default usePlatformAlarms;
