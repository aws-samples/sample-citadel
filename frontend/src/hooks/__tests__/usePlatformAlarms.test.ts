/**
 * usePlatformAlarms hook tests.
 *
 * Polls Query.getPlatformAlarms every 60s. States covered:
 *  - loading (no data yet)
 *  - all-OK (configured, no ALARM-state entries)
 *  - ALARM (configured, at least one ALARM-state entry)
 *  - unauthorised (the query threw — non-admin or any other resolver error)
 *  - not-configured (configured:false)
 */
import { renderHook, act, waitFor } from '@testing-library/react';

jest.mock('../../services/platformAlarmsService', () => ({
  platformAlarmsService: {
    getPlatformAlarms: jest.fn(),
  },
}));

import { platformAlarmsService } from '../../services/platformAlarmsService';
import { usePlatformAlarms } from '../usePlatformAlarms';

const getPlatformAlarmsMock =
  platformAlarmsService.getPlatformAlarms as jest.Mock;

describe('usePlatformAlarms', () => {
  beforeEach(() => {
    jest.clearAllMocks();
    jest.useFakeTimers();
  });

  afterEach(() => {
    jest.useRealTimers();
  });

  test('starts in the loading state before the first fetch resolves', async () => {
    getPlatformAlarmsMock.mockReturnValue(
      new Promise(() => {
        /* never resolves within this test */
      }),
    );

    const { result } = renderHook(() => usePlatformAlarms());

    expect(result.current.status).toBe('loading');
  });

  test('resolves to all-ok when configured with no ALARM-state entries', async () => {
    getPlatformAlarmsMock.mockResolvedValue({
      configured: true,
      alarms: [{ alarmName: 'citadel-dlq-not-empty-shared-dev', state: 'OK' }],
    });

    const { result } = renderHook(() => usePlatformAlarms());

    await waitFor(() => expect(result.current.status).toBe('all-ok'));
  });

  test('resolves to alarm when configured with at least one ALARM-state entry', async () => {
    getPlatformAlarmsMock.mockResolvedValue({
      configured: true,
      alarms: [
        {
          alarmName: 'citadel-dlq-not-empty-dev',
          state: 'ALARM',
          queueName: 'citadel-dlq-dev',
          queueDepth: 4,
          redriveHint: 'Redrive the DLQ.',
        },
      ],
    });

    const { result } = renderHook(() => usePlatformAlarms());

    await waitFor(() => expect(result.current.status).toBe('alarm'));
    expect(result.current.alarms).toHaveLength(1);
  });

  test('resolves to not-configured when configured is false', async () => {
    getPlatformAlarmsMock.mockResolvedValue({ configured: false, alarms: [] });

    const { result } = renderHook(() => usePlatformAlarms());

    await waitFor(() => expect(result.current.status).toBe('not-configured'));
  });

  test('resolves to unauthorised when the query throws', async () => {
    getPlatformAlarmsMock.mockRejectedValue(new Error('Admin access required'));

    const { result } = renderHook(() => usePlatformAlarms());

    await waitFor(() => expect(result.current.status).toBe('unauthorised'));
  });

  test('polls again after 60 seconds', async () => {
    getPlatformAlarmsMock.mockResolvedValue({ configured: true, alarms: [] });

    renderHook(() => usePlatformAlarms());

    await waitFor(() => expect(getPlatformAlarmsMock).toHaveBeenCalledTimes(1));

    await act(async () => {
      jest.advanceTimersByTime(60_000);
    });

    await waitFor(() => expect(getPlatformAlarmsMock).toHaveBeenCalledTimes(2));
  });

  test('does not poll when disabled (e.g. non-admin — caller skips mounting the fetch)', async () => {
    getPlatformAlarmsMock.mockResolvedValue({ configured: true, alarms: [] });

    renderHook(() => usePlatformAlarms({ enabled: false }));

    await act(async () => {
      jest.advanceTimersByTime(60_000);
    });

    expect(getPlatformAlarmsMock).not.toHaveBeenCalled();
  });
});
