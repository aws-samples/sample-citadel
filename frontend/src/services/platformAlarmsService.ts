/**
 * Platform Alarms Service
 *
 * Thin wrapper around Query.getPlatformAlarms — admin-only, read-only
 * surface over the backend's CloudWatch DLQ/SLO alarm state
 * (backend/src/lambda/platform-health-resolver.ts). A non-admin caller's
 * request is refused server-side; this service does not catch that error,
 * so callers (usePlatformAlarms) see the rejection and can render the
 * unauthorised state.
 */
import serverService from './server';

export type AlarmState = 'OK' | 'ALARM' | 'INSUFFICIENT_DATA';

export interface PlatformAlarm {
  alarmName: string;
  state: AlarmState;
  reason?: string | null;
  stateUpdatedAt?: string | null;
  category?: string | null;
  queueName?: string | null;
  queueDepth?: number | null;
  redriveHint?: string | null;
}

export interface PlatformAlarmsResult {
  configured: boolean;
  alarms: PlatformAlarm[];
}

const GET_PLATFORM_ALARMS = `
  query GetPlatformAlarms {
    getPlatformAlarms {
      configured
      alarms {
        alarmName
        state
        reason
        stateUpdatedAt
        category
        queueName
        queueDepth
        redriveHint
      }
    }
  }
`;

export const platformAlarmsService = {
  async getPlatformAlarms(): Promise<PlatformAlarmsResult> {
    const response = await serverService.query<{
      getPlatformAlarms: PlatformAlarmsResult;
    }>(GET_PLATFORM_ALARMS);
    return response.getPlatformAlarms;
  },
};

export default platformAlarmsService;
