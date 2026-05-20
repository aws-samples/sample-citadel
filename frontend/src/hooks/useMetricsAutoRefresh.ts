import { useEffect, useRef } from 'react';

interface UseMetricsAutoRefreshOptions {
  enabled: boolean;
  intervalMs?: number;
  onRefresh: () => void;
}

/**
 * Auto-refreshes metrics on a timer, pausing when the tab is hidden.
 * On visibility change from hidden→visible, fires one immediate refresh
 * and restarts the interval.
 */
export function useMetricsAutoRefresh({
  enabled,
  intervalMs = 60_000,
  onRefresh,
}: UseMetricsAutoRefreshOptions) {
  const intervalRef = useRef<ReturnType<typeof setInterval> | null>(null);
  const onRefreshRef = useRef(onRefresh);
  onRefreshRef.current = onRefresh;

  useEffect(() => {
    if (!enabled) return;

    const clearTimer = () => {
      if (intervalRef.current !== null) {
        clearInterval(intervalRef.current);
        intervalRef.current = null;
      }
    };

    const startTimer = () => {
      clearTimer();
      intervalRef.current = setInterval(() => onRefreshRef.current(), intervalMs);
    };

    const handleVisibility = () => {
      if (document.visibilityState === 'visible') {
        onRefreshRef.current();
        startTimer();
      } else {
        clearTimer();
      }
    };

    if (document.visibilityState === 'visible') {
      startTimer();
    }

    document.addEventListener('visibilitychange', handleVisibility);

    return () => {
      clearTimer();
      document.removeEventListener('visibilitychange', handleVisibility);
    };
  }, [enabled, intervalMs]);
}
