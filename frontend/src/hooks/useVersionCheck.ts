/**
 * useVersionCheck — lightweight bundle-skew detector.
 *
 * Compares the build id embedded in the running bundle (__BUILD_ID__) against
 * a remote /version.json served by the same host. When they differ the hook
 * returns stale=true so the UI can show a non-blocking reload banner.
 *
 * The check runs on mount and every `intervalMs` (default 5 min) thereafter.
 * `checkNow()` triggers an immediate re-check (call after a failed action).
 */
import { useState, useEffect, useCallback, useRef } from 'react';

declare const __BUILD_ID__: string;

const DEFAULT_INTERVAL_MS = 5 * 60 * 1000; // 5 minutes

export function useVersionCheck(intervalMs: number = DEFAULT_INTERVAL_MS) {
  const [stale, setStale] = useState(false);
  const timerRef = useRef<ReturnType<typeof setInterval> | null>(null);

  const check = useCallback(async () => {
    try {
      const currentBuildId =
        typeof __BUILD_ID__ !== 'undefined'
          ? __BUILD_ID__
          : (globalThis as Record<string, unknown>).__BUILD_ID__ as string | undefined;

      if (!currentBuildId) return;

      const res = await fetch('/version.json', { cache: 'no-store' });
      if (!res.ok) return;

      const data = await res.json();
      if (data.buildId && data.buildId !== currentBuildId) {
        setStale(true);
      } else {
        setStale(false);
      }
    } catch {
      // Fetch failed — don't flag as stale
    }
  }, []);

  useEffect(() => {
    // Initial check after a short delay to avoid blocking render
    const initialTimeout = setTimeout(check, 50);

    timerRef.current = setInterval(check, intervalMs);

    return () => {
      clearTimeout(initialTimeout);
      if (timerRef.current) clearInterval(timerRef.current);
    };
  }, [check, intervalMs]);

  return { stale, checkNow: check };
}
