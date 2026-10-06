/**
 * GovernanceModeContext — single-instance governance mode poller.
 *
 * Mounted once in App.tsx so every consumer (ModeBadge, ModeCard,
 * GovernanceOverview/RolloutCTA) shares one 60 s polling interval instead of
 * each running its own setInterval against Query.getGovernanceMode.
 *
 * Visibility-aware: pauses the interval when the tab is hidden and refetches
 * immediately when the tab becomes visible again.
 */

import React, { createContext, useCallback, useEffect, useRef, useState } from 'react';
import { governanceService, GovernanceMode } from '../services/governanceService';

const POLL_INTERVAL_MS = 60_000;

export interface GovernanceModeState {
  mode: GovernanceMode | null;
  loading: boolean;
  error: string | null;
  refresh: () => void;
}

const DEFAULT_STATE: GovernanceModeState = {
  mode: null,
  loading: true,
  error: null,
  refresh: () => {},
};

export const GovernanceModeContext = createContext<GovernanceModeState>(DEFAULT_STATE);

export function GovernanceModeProvider({ children }: { children: React.ReactNode }) {
  const [mode, setMode] = useState<GovernanceMode | null>(null);
  const [loading, setLoading] = useState(true);
  const [error, setError] = useState<string | null>(null);
  const mountedRef = useRef(true);
  const intervalRef = useRef<ReturnType<typeof setInterval> | null>(null);

  const fetchData = useCallback(async (isInitial = false) => {
    if (isInitial) setLoading(true);
    try {
      const result = await governanceService.getGovernanceMode();
      if (!mountedRef.current) return;
      setMode(result);
      setError(null);
    } catch (err: any) {
      if (mountedRef.current) {
        setError(err?.message || 'Failed to load governance mode');
      }
    } finally {
      if (mountedRef.current) setLoading(false);
    }
  }, []);

  const refresh = useCallback(() => {
    fetchData(false);
  }, [fetchData]);

  // Start/stop the polling interval.
  const startPolling = useCallback(() => {
    if (intervalRef.current != null) return; // already running
    intervalRef.current = setInterval(() => fetchData(false), POLL_INTERVAL_MS);
  }, [fetchData]);

  const stopPolling = useCallback(() => {
    if (intervalRef.current != null) {
      clearInterval(intervalRef.current);
      intervalRef.current = null;
    }
  }, []);

  useEffect(() => {
    mountedRef.current = true;
    fetchData(true);
    startPolling();

    const handleVisibilityChange = () => {
      if (document.hidden) {
        stopPolling();
      } else {
        fetchData(false);
        startPolling();
      }
    };

    document.addEventListener('visibilitychange', handleVisibilityChange);

    return () => {
      mountedRef.current = false;
      stopPolling();
      document.removeEventListener('visibilitychange', handleVisibilityChange);
    };
  }, [fetchData, startPolling, stopPolling]);

  return (
    <GovernanceModeContext.Provider value={{ mode, loading, error, refresh }}>
      {children}
    </GovernanceModeContext.Provider>
  );
}
