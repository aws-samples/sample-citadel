/**
 * useGovernanceFindingStream — live tail buffer.
 *
 * Subscribes to `onGovernanceFinding` via `governanceService.subscribeGovernanceFindings`
 * and maintains a most-recent-first ring buffer of received findings.
 * Pause/resume gates buffer additions without tearing down the underlying
 * subscription so the operator can examine a paused snapshot while the
 * server continues to publish (resume re-attaches at the current head;
 * gaps in the paused window are the user's explicit choice).
 *
 * Errors land in state and never throw — the page-level component renders
 * the banner and the operator decides whether to disable + re-enable the
 * stream. The hook does not retry implicitly.
 */

import { useCallback, useEffect, useRef, useState } from 'react';
import {
  governanceService,
  type GovernanceFinding,
  type GovernanceFindingSubscriptionFilter,
} from '../services/governanceService';

/**
 * Default cap on buffered findings. ~1000 keeps memory bounded even under
 * a sustained 100/s deny-storm. The Tracer page overrides this to 200 to
 * scope the time-machine scrubber to the most recent ~60s of activity.
 */
const DEFAULT_BUFFER_SIZE = 1000;

export interface UseGovernanceFindingStreamOptions {
  enabled: boolean;
  bufferSize?: number;
  filter?: GovernanceFindingSubscriptionFilter;
}

export interface UseGovernanceFindingStreamResult {
  /** Most-recent-first buffer of findings. Capped at `bufferSize`. */
  buffer: GovernanceFinding[];
  /** True when buffer additions are gated. The subscription stays open. */
  paused: boolean;
  /** Stop adding incoming findings to the buffer. */
  pause: () => void;
  /** Resume buffer additions. New findings land at the head. */
  resume: () => void;
  /** Empty the buffer. Does not affect the subscription. */
  clear: () => void;
  /** Last subscription error, or null. Stored, never thrown. */
  error: string | null;
}

export function useGovernanceFindingStream(
  options: UseGovernanceFindingStreamOptions,
): UseGovernanceFindingStreamResult {
  const { enabled, bufferSize = DEFAULT_BUFFER_SIZE, filter } = options;

  const [buffer, setBuffer] = useState<GovernanceFinding[]>([]);
  const [paused, setPaused] = useState<boolean>(false);
  const [error, setError] = useState<string | null>(null);

  // Refs keep the latest pause + bufferSize values addressable from the
  // subscription callback without re-binding the subscription on every
  // change. Without these refs the subscription would tear down + re-
  // establish on each pause/resume cycle, dropping in-flight findings.
  const pausedRef = useRef<boolean>(paused);
  const bufferSizeRef = useRef<number>(bufferSize);

  useEffect(() => {
    pausedRef.current = paused;
  }, [paused]);

  useEffect(() => {
    bufferSizeRef.current = bufferSize;
  }, [bufferSize]);

  // Stringify filter so the effect deps remain stable when callers
  // construct a new object each render (the JSON form is shallow but
  // sufficient for a single optional `decision` field).
  const filterKey = JSON.stringify(filter ?? {});

  useEffect(() => {
    if (!enabled) {
      return;
    }

    let active = true;
    let unsubscribe: (() => void) | null = null;

    try {
      unsubscribe = governanceService.subscribeGovernanceFindings(
        (finding) => {
          if (!active) return;
          if (pausedRef.current) return;
          setBuffer((prev) => {
            const cap = bufferSizeRef.current;
            const next = [finding, ...prev];
            return next.length > cap ? next.slice(0, cap) : next;
          });
        },
        filter,
        (err) => {
          if (!active) return;
          setError(err instanceof Error ? err.message : String(err));
        },
      );
    } catch (err) {
      // Synchronous failure setting up the subscription (e.g. missing
      // Amplify config). Stored, not thrown.
      setError(err instanceof Error ? err.message : String(err));
    }

    return () => {
      active = false;
      if (unsubscribe) {
        try {
          unsubscribe();
        } catch {
          // Ignore unsubscribe failures — the subscription may already be
          // closed by the server. The buffer state is reset by the
          // enabled-flag dependency on next mount.
        }
      }
    };
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [enabled, filterKey]);

  const pause = useCallback(() => setPaused(true), []);
  const resume = useCallback(() => setPaused(false), []);
  const clear = useCallback(() => setBuffer([]), []);

  return { buffer, paused, pause, resume, clear, error };
}
