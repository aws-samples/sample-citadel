/**
 * useGovernanceMode — polls the governance enforce mode every 60s.
 *
 * Mirrors the structure of useDashboardData: mountedRef + fetchData callback +
 * useEffect with setInterval and cleanup on unmount.
 *
 * Errors are stored in state and never thrown — pages depending on this hook
 * (notably AppHeader/ModeBadge) must never break.
 */

import { useCallback, useEffect, useRef, useState } from 'react';
import { governanceService, GovernanceMode } from '../services/governanceService';

const POLL_INTERVAL_MS = 60_000;

export interface UseGovernanceModeResult {
  mode: GovernanceMode | null;
  loading: boolean;
  error: string | null;
  refresh: () => void;
}

export function useGovernanceMode(): UseGovernanceModeResult {
  const [mode, setMode] = useState<GovernanceMode | null>(null);
  const [loading, setLoading] = useState(true);
  const [error, setError] = useState<string | null>(null);
  const mountedRef = useRef(true);

  const fetchData = useCallback(async (isInitial = false) => {
    if (isInitial) setLoading(true);
    try {
      const result = await governanceService.getGovernanceMode();
      if (!mountedRef.current) return;
      setMode(result);
      setError(null);
    } catch (err: any) {
      // governanceService.getGovernanceMode swallows errors and returns the
      // permissive fallback, so this branch should normally be unreachable.
      // We still capture an error string for visibility but never throw.
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

  useEffect(() => {
    mountedRef.current = true;
    fetchData(true);
    const interval = setInterval(() => fetchData(false), POLL_INTERVAL_MS);
    return () => {
      mountedRef.current = false;
      clearInterval(interval);
    };
  }, [fetchData]);

  return { mode, loading, error, refresh };
}

export default useGovernanceMode;
